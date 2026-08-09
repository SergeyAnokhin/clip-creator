# Architecture

Versecraft is a two-process local app: a React (Vite) frontend talks over HTTP
to a FastAPI backend, which persists everything as JSON files on disk. There is
no database and no auth — it's single-user. The music-prompt generation
(`suno.generate`), scene-text/storyboard generation (`scenes.generate`) and
scene *image* generation (`images.py`) all make **real** provider calls when a
model + API key are configured, falling back to a deterministic stub
otherwise (see below). "Suno" in identifiers, routes, and settings keys is a
legacy name kept for backward compatibility — the feature itself targets any
lyrics-to-music service (Suno, Mureka, ...); the UI calls it "Музыка/Music".

```text
┌───────────────┐   fetch /api/*   ┌─────────────────┐   read/write JSON   ┌───────────────┐
│ frontend/src  │ ───────────────► │ backend/app     │ ──────────────────► │ app_data/     │
│ (Vite, :5174) │ ◄─────────────── │ (FastAPI, :8020)│ ◄────────────────── │ (git-ignored) │
└───────────────┘      JSON        └─────────────────┘                     └───────────────┘
```

Companion docs: [code-map.md](code-map.md) (which file does what),
[data-model.md](data-model.md) (JSON shapes and API routes),
[usage-tracking.md](usage-tracking.md) (AI usage ledger and pricing).

## Running

`npm run dev` from the repo root starts both servers via `concurrently` (see
[`package.json`](../package.json)). The Vite port defaults to **5174** (not
the default 5173, to avoid clashing with other local projects) but falls back
to `$PORT` if set ([`vite.config.js`](../frontend/vite.config.js)), so
multiple local dev sessions can each run on their own port. `main.py`'s CORS
middleware allows any `http://localhost:<port>` origin (regex, not a fixed
value) so it doesn't need editing when the frontend's port changes.

`ffmpeg` must be on `PATH` (a **system** binary, not a pip package — nothing
else in this repo shells out to an external tool) for the Mureka reference-
audio trimmer (`providers/mureka.py::trim_audio`, invoked via
`asyncio.create_subprocess_exec`) — without it, trimming fails with a clear
error rather than silently, but the backend doesn't check for it at startup.

## The workflow

A project moves through seven stages, all inside one workflow screen:

```text
Lyrics  →  Music  →  Music gen  →  Scenes        →  Images            →  Title Card        →  Video
blocks     style +   real audio     storyboard        images per scene,    poster text in the   animate each
           lyrics    tracks via     (text only)       rated, top pick =    style of 4 picked     scene's picked
                      Mureka                           main                 reference images      image + motion
                                                                                                    prompt
```

1. **Lyrics** — a poem (pasted text or a parsed URL) is split into blocks on
   blank lines, all typed `verse`. The user retypes, reorders, splits, and
   clones blocks until the structure is right. Every operation is a pure
   function in [`lib/lyrics.js`](../frontend/src/lib/lyrics.js), so the stage
   never needs anything from the backend beyond the generic project `PATCH`.
2. **Music** (labeled "Музыка (AI)"/"Music (AI)" in the UI, `stage: 'suno'`
   internally) — edit the "Дополнения к промпту" text, optionally toggle on
   reusable "AI-wish" cards (or dictate a new one), then generate a `style` +
   `lyrics` pair to paste into whichever music service (Suno, Mureka, ...)
   the user is targeting.
3. **Music generation** (labeled "Генерация музыки"/"Music generation",
   `stage: 'mureka'` internally) — the real counterpart to the previous
   stage: sends style + lyrics (seeded from the Music stage's output, then
   freely editable — this *is* the "what goes to the model" preview) to the
   Mureka API and gets back playable tracks. Optionally conditions the
   generation on an uploaded reference track (30s mp3/m4a). Every generated
   track is downloaded to disk immediately (Mureka's own URLs expire after 30
   days), rateable (0-5 stars) and taggable with user-defined quality-review
   labels (`settings.music_tags`, e.g. "плохое произношение"), with one
   manually-flagged `is_selected` primary pick per project — deliberately
   **not** auto-promoted from the rating the way scene images are, since
   quality rating and "the one I'll use" are treated as independent
   judgments here. See `providers/mureka.py` below.
4. **Scenes** (`stage: 'scenes'`) — turn the lyrics into `scene_count` scenes
   (default 10), each `{lyric_segment, scene_description, static_prompt,
   motion_prompt}` (`scene_description`: a short Russian caption of what the
   shot shows, e.g. "женщина стоит в пол-оборота" — shown in the scene card's
   header so scenes can be scanned without reading the full English prompt),
   in one of two `scene_mode`s (`narrative`: scenes follow the lyrics in order and
   read as one continuous story; `abstract`: scenes vary one mood/atmosphere
   with no forced plot) — see "The scene prompt" below. Purely text; no image
   is generated here.
5. **Images** (`stage: 'images'`) — for each scene from the Scenes stage,
   generate one or more image variants (with a cheap/quality model-tier
   toggle) and rate them; the top-rated variant becomes the scene's main
   frame. Also owns the style-reference image upload. The Scenes stage
   (previous step) also has a lightweight version of this: one global cheap
   model + a "generate"/"regenerate" button per scene for a quick single-image
   preview next to the prompts, sharing the same `scenes[n].images` array and
   backend endpoint - the full multi-variant/rating workflow still only lives
   here.
6. **Title Card** (`stage: 'title_card'`) — picks up to 4 already-generated
   scene images (or uploads) as style references, takes a title/author text
   block, and asks a reference-capable image model to render that text baked
   into the references' visual style — a typographic overlay, not a full
   poster. Auto-picks the 4 highest-rated images across every scene on first
   open (`lib/titleCard.js`'s `pickTopReferenceImages`), any slot swappable or
   replaceable with an upload. See `providers/title_card.py` below for why
   this needs its own provider seam instead of reusing `images.py`. The
   **Poster constructor** (same stage, below the variants gallery) is the
   step that turns one of these overlays into an actual poster — see
   "Poster constructor" below.
7. **Video** (`stage: 'video'`) — the last stage: turns each scene's already-
   picked image (from Images) plus its `motion_prompt` (from Scenes, still
   editable here) into one or more short animated clips via an
   image-to-video model. Unlike every other stage (a scrollable list of every
   scene), this one shows **one scene at a time** with prev/next + a jump
   strip, since reviewing/tuning an animation is a slower, more deliberate
   task than picking a picture. `scenes[n].videos[]` accumulates results the
   same way `images[]` does (rateable, deletable, one `is_selected` pick) -
   see `providers/video.py` below for the real seam and "Video generation"
   for the full request/response shapes.

Both stages also share a `hideMotionPrompt` toggle (a `settings.json`
preference, not per-project) that hides every `motion_prompt` field when a
project only needs the static image prompt right now, and a "translate"
button next to every static/motion prompt that shows a one-off Russian
translation in a modal (`POST /api/translate`, never written back into the
project) - see "Prompt translation" below.

Splitting Scenes and Images into two stages (rather than one combined
"raskadrovka" screen, which is what this used to be) mirrors the fact that
they're now two independent AI calls with independent model choices — text
generation for the scene list, image generation per scene — and lets you
regenerate one without touching the other (e.g. reroll a scene's images
without re-running the LLM call that wrote its prompt).

## Frontend state

State lives in [`src/hooks/`](../frontend/src/hooks/), one hook per domain
(toast, viewport, settings, projects, the seven stages, voice).
[`App.jsx`](../frontend/src/App.jsx) is just the composition root: it owns
navigation, calls the hooks in dependency order, and assembles each stage's
`{...state, actions}` prop bundle. No state library and no context — every
dependency is an explicit argument, so you can read the whole data flow off
App.jsx. See [code-map.md](code-map.md) for what each hook owns.

Edits update local state immediately, then `PATCH` the **whole** project.
Text-field edits (prompts, style description) go through a 400 ms debounce so
each keystroke isn't a request.

## Provider seams — where the real AI would go

[`providers/suno.py`](../backend/app/providers/suno.py),
[`text_models.py`](../backend/app/providers/text_models.py),
[`image_models.py`](../backend/app/providers/image_models.py),
[`scenes.py`](../backend/app/providers/scenes.py),
[`images.py`](../backend/app/providers/images.py),
[`video_models.py`](../backend/app/providers/video_models.py),
[`video.py`](../backend/app/providers/video.py) and
[`mureka.py`](../backend/app/providers/mureka.py) are the seams routers call
without knowing whether the result is canned or real. Keys come from
`app_data/settings.json`.

Every `settings.*_base_prompt` (Suno, Scenes narrative/abstract, Title Card —
seeded from the matching `providers/*_prompt_defaults.py` constant, see
`routers/settings.py`'s `DEFAULT_SETTINGS`) is a **one-time seed**, not a
live default: `get_settings` merges `DEFAULT_SETTINGS` under whatever's
already in `app_data/settings.json`, so once a key has been written once
(any `PUT /api/settings`, even one editing an unrelated field, writes the
whole merged object back — see `put_settings`), it's persisted from then on
and a later edit to the `*_prompt_defaults.py` source constant has **no
effect** on that installation until someone edits the prompt in the UI (or
the stored key) directly. Keep this in mind when changing a base-prompt
default — an already-running install's `app_data/settings.json` needs its
own edit (or the user needs to re-save the prompt) to pick up the change.

`google_free` is a second Google Gemini provider id, wired everywhere
`google` is (same Gemini/Imagen calls, same models) but resolved against its
own `settings.api_keys.google_free` — lets a free-tier Gemini token and a
paid one be tracked separately without touching call logic. Wherever
this doc says "`provider` is `google`", read that as "`google` or
`google_free`"; `pricing.py` aliases `google_free:<model_id>` price lookups
to the `google:<model_id>` row so both share one price catalog entry — but
`usage._resolved_cost` special-cases `provider == 'google_free'` to always
report `$0`/`source: 'free'` rather than that aliased paid-tier price (a
free-tier key means the call is actually free, not merely tracked apart);
the aliased price is kept alongside as `cost.saved_amount` purely as an
informational "money saved" figure — see [usage-tracking.md](usage-tracking.md).

- `suno.generate` recomputes the raw structured lyrics from the project's
  *current* blocks every time (so Lyrics-stage edits always show up), then:
  - `model` is the composite `"{provider}:{model_id}"` string from
    `settings.text_models.default` (see `data-model.md`). If `provider` is one
    of `google` / `openrouter` / `deepseek` **and** the matching
    `settings.api_keys.<provider>` is set, it calls that provider's chat API
    (Gemini's `generateContent`, OpenRouter's `/chat/completions`, or
    DeepSeek's OpenAI-compatible `/chat/completions`) with a prompt assembled
    from `settings.suno_base_prompt` + the project's active wishes (resolved
    from `settings.suno_wish_library` via `active_wish_ids`, sent as an
    emphasized numbered block right after the base prompt) +
    `settings.suno_reference_examples` + the project's `skill_prompt`
    ("Дополнения к промпту" on the Suno stage), asking for a `===STYLE===` /
    `===LYRICS===`-delimited reply that `_parse_model_response` splits into
    `{style, lyrics}`. See "The Suno prompt" below for the full layer order.
  - otherwise (no model picked, an unsupported provider like
    Replicate/FAL/Krea, or a supported provider missing its key) it falls
    back to the old deterministic stub: `lyrics` = the formatted blocks,
    `style` = a canned string, and `debug.reason` is one of
    `no_model_selected` / `unsupported_provider` / `no_api_key` — the Suno
    stage's debug panel (see below) surfaces that reason directly instead of
    a generic "check your settings" message.
  - a generation failure (bad key, non-200, unparsable reply) is surfaced by
    the router as `HTTPException(502, ...)`, not a silent stub fallback —
    see [`routers/generation.py`](../backend/app/routers/generation.py). A
    real call that succeeds but doesn't follow the `===STYLE===`/`===LYRICS===`
    format sets `debug.missing_markers = true` instead (style then comes back
    empty) rather than failing the request.
- `text_models.list_models(provider, api_key)` backs the Settings "refresh
  models" button (`GET /api/settings/models/{provider}`):
  - Google, OpenRouter and DeepSeek all expose a real, filterable models
    list, so those three are **live** calls (Google's Generative Language
    API, filtered to `generateContent`-capable models; OpenRouter's public
    `/models`; DeepSeek's OpenAI-compatible `/models` at
    `api.deepseek.com/v1`).
  - Replicate and FAL don't have an equivalent "list chat/text models"
    endpoint worth calling here (Replicate's catalog spans every modality;
    FAL has no public model-listing API), so those two always return a small
    hardcoded `CURATED_MODELS` list — the user can still add any model id
    manually via the same UI.
- `text_models.clean_wish_and_title` backs every wish save, via
  `providers/wish_library.py::add_or_get_wish` — called both from
  `POST /api/settings/wish-library` (Settings → Wishes tab, library-only,
  doesn't touch any project) and from `POST /api/projects/{id}/suno/wishes`
  (the Suno stage's "Применить" button, which additionally activates the new
  wish for the current project — see "The Suno prompt" below). Both read
  `settings.simple_models.default` (the library route also accepts a
  request-level `model` override for that one save, applied to a throwaway
  settings copy so it never overwrites the real default); if it points at
  Google, OpenRouter or DeepSeek with a key configured, one call both tidies
  the wish text and produces a short, emoji-prefixed title, parsed from a
  `===WISH===`/`===TITLE===`-delimited reply the same way `suno.generate`
  parses `===STYLE===`/`===LYRICS===`. Otherwise (no default set, unsupported
  provider, missing key, malformed reply, or any API failure) it falls back
  to the wish text unchanged plus a local truncate for the title. There is
  deliberately no per-screen model picker for this on `SunoStage.jsx` — it's
  a single global setting, unlike `text_models.default`/`genModel` which the
  Suno stage lets you override per call. `add_or_get_wish` also dedups by
  exact text: applying the same wish twice reuses the existing card instead
  of creating a duplicate. `clean_wish_and_title`, and the older
  single-purpose `generate_wish_title`, share the same
  `_complete_google`/`_complete_openrouter`/`_complete_deepseek` request
  plumbing via a `prompt_template` parameter. Never raises — titling must not
  block applying or saving a wish.
- `image_models.list_models(provider, api_key)` backs the Settings image-model
  "refresh models" button (`GET /api/settings/image-models/{provider}`),
  mirroring `text_models.list_models`'s shape and split:
  - Google is a **live** call to the same "list models" endpoint as
    `text_models`, filtered to `predict`-capable (Imagen) models **plus**
    `generateContent`-capable models whose id matches Gemini's "Nano Banana"
    image family shape (`gemini-*-image`, e.g. `gemini-3.1-flash-lite-image`
    — see `image_models.is_gemini_image_model`). Nano Banana answers through
    the same method as text models and has no `predict` capability to
    distinguish it, so id shape is the only signal; `text_models.py`'s own
    Google listing excludes the same ids for the opposite reason (so they
    don't also show up as text models).
  - OpenRouter is also a **live** call to its combined `/models` catalog
    (the same endpoint `text_models.py` uses), filtered to entries whose
    `architecture.output_modalities` includes `'image'`
    (`image_models.is_openrouter_image_model`) — that field is what lets a
    generic model listing double as an image-model catalog with no dedicated
    endpoint or manual curation; new image models on OpenRouter (further
    Nano Banana releases included) show up automatically. `text_models.py`
    excludes the same entries from its own OpenRouter listing.
  - Replicate, FAL and Krea return a curated `CURATED_IMAGE_MODELS` list
    (empty for DeepSeek, which doesn't route image models at all). Krea
    (krea.ai) has no model-discovery endpoint at all — each model is its own
    fixed REST path (`POST /generate/image/{id}` against `api.krea.ai`,
    async job + `GET /jobs/{id}` polling), confirmed against
    `docs.krea.ai` — so its curated list uses those real endpoint-path IDs
    (e.g. `krea/krea-2/medium`, `bfl/flux-1-dev`). Krea is image/video-only,
    so it's a valid `provider` for `/settings/image-models/{provider}` but
    not for `/settings/models/{provider}` (text models) — see
    `_IMAGE_MODEL_PROVIDERS` in `routers/settings.py`.
  - `settings.image_models`/`.image_models_simple` favorites back a real
    per-generation `ModelPicker` in `ImagesStage.jsx` (a cheap/quality tier
    toggle picks which of the two favorites lists feeds the picker - see
    `useImagesStage.js`'s `imageModelTier`), and the chosen composite is what
    actually reaches `images.start_jobs` as `model`.
- `scenes.generate` mirrors `suno.generate`'s shape closely on purpose (same
  provider dispatch, timeout/usage/console-log wiring, debug+usage summary in
  the response) — see "The scene prompt" below for the full prompt layering:
  - `model` is the composite `"{provider}:{model_id}"` from `settings.text_models`
    (`ModelPicker` next to "Сгенерировать сцены" in `ScenesStage.jsx`). If
    `provider` is one of `google`/`openrouter`/`deepseek` **and** the matching
    `settings.api_keys.<provider>` is set, it calls that provider's chat API
    with a prompt built from `settings.scene_base_prompt_{scene_mode}` + the
    project's active scene wishes + `style_description` + a reference-image
    count note + the raw lyric lines, asking for a ```` ```json ```` array of
    exactly `scene_count` `{lyric_segment, scene_description, static_prompt,
    motion_prompt}` objects (`scenes._parse_model_response`); the stub
    fallback below leaves `scene_description` `''` (no LLM call, nothing to
    summarize).
  - Parsing is tolerant, same philosophy as `suno.py`'s missing-marker
    handling: a response with the wrong item count or that isn't valid JSON
    at all falls back to the deterministic stub scenes (chunked lyric lines,
    canned prompts) rather than failing the request, with `debug.missing_markers
    = true` so the UI can flag it.
  - Otherwise (no model, unsupported provider, or missing key) it falls back
    to the same deterministic stub, `debug.reason` set the same way
    `suno.generate` sets it.
- `images.start_jobs`/`get_job` is the **real seam** for scene images —
  Krea, Replicate, FAL, Google Imagen and OpenRouter, dispatched from the
  `provider` half of the `model` composite. It's structured as background
  jobs rather than a single blocking call because Krea/Replicate/FAL are all
  async-job APIs (submit → poll until done), unlike `suno.py`'s single
  request/response Gemini call - Google Imagen and OpenRouter are both single
  synchronous calls too, but still run through the same background-job
  wrapper so the frontend has one uniform poll contract regardless of
  provider:
  - `POST /api/projects/{id}/scenes/{n}/images` (`{count, model}`) calls
    `images.start_jobs`, which fires one `asyncio.create_task` per requested
    variant and returns their `job_id`s **immediately** (`{job_ids: [...]}`)
    instead of blocking the request for the whole generation.
  - `GET /api/projects/{id}/scenes/{n}/images/jobs/{job_id}` (backed by
    `images.get_job`) is polled by the frontend (`pollImageJob` in
    `useImagesStage.js`, every 1.5s) until `status` is `completed` or
    `failed`. Job state lives in an **in-memory dict** (`images._jobs`) — not
    persisted, so an in-flight job is lost if the backend restarts; acceptable
    for this single-user local tool.
  - Per provider (endpoints/shapes confirmed against each one's docs,
    2026-07): **Krea** `POST https://api.krea.ai/generate/image/{model_id}` →
    `{job_id, status}`, poll `GET /jobs/{job_id}` until `status ==
    'completed'`, image at `result.urls[0]`. **Replicate**
    `POST https://api.replicate.com/v1/models/{owner}/{name}/predictions`
    (works because `CURATED_IMAGE_MODELS` ids are already bare `owner/name` —
    no version hash needed for official models) → `{id, status, urls: {get}}`,
    poll `urls.get` until `status == 'succeeded'`, image(s) in `output`.
    **FAL** `POST https://queue.fal.run/{model_id}` → `{status_url,
    response_url}`, poll `status_url` until `status == 'COMPLETED'`, then
    `GET response_url` for `images[].url` — FAL's `status_url` poll can reply
    HTTP `202 Accepted` (not 200) while the job is still `IN_QUEUE`/
    `IN_PROGRESS`, so only HTTP `>=400` is treated as a transport error there;
    the JSON `status` field (not the HTTP status code) drives the poll loop.
    FAL's moderation also doesn't fail the request on flagged content (still
    a 2xx with a blank/blurred image URL), it only surfaces via the sibling
    `has_nsfw_concepts: [bool, ...]` array, so that's checked explicitly and
    turned into a `failed` job rather than silently saving the placeholder.
    **Google Imagen**
    `POST .../v1beta/models/{model_id}:predict` (same host as `suno.py`'s
    Gemini call) → `{predictions: [{bytesBase64Encoded, mimeType}]}` — no
    job/polling, it's a single synchronous call. `_generate_google` only
    implements this `:predict` path — Gemini's "Nano Banana" image family
    (now listed under `google`'s image-model catalog, see above) answers
    through `:generateContent` instead, which isn't wired up here yet, so
    picking a Nano Banana model as the **direct Google** provider for scene
    images currently fails at generation time even though it now shows up
    correctly in the picker. Nano Banana models routed via **OpenRouter**
    already work end-to-end (see next). **OpenRouter**
    `POST https://openrouter.ai/api/v1/images` (its Unified Image API,
    launched 2026-06) → `{data: [{b64_json, media_type}], usage: {..., cost}}`
    — also a single synchronous call; `usage.cost` is OpenRouter's own exact
    USD price for the generation (all-or-nothing billing, matching
    `text_models.py`'s `_complete_openrouter` for text) and is threaded
    through as the usage ledger's `provider_cost`, winning over the price
    catalog the same way.
  - `POST .../images` also accepts an optional `aspect_ratio` (one of `1:1`,
    `16:9`, `9:16` — `ImagesStage.jsx`'s picker; anything else, including
    omitted/`auto`, means "don't send it, use the provider/model's own
    default"). Threaded to each provider in the shape it actually accepts
    (confirmed against each one's docs, 2026-08): Krea, Replicate
    (FLUX/SD3.5 models) and OpenRouter take it verbatim as `aspect_ratio`;
    Google Imagen takes it as `aspectRatio`; FAL takes an `image_size` enum
    instead (`1:1`→`square_hd`, `16:9`→`landscape_16_9`,
    `9:16`→`portrait_16_9`) since its models don't have an aspect-ratio
    field. One exception: `stability-ai/sdxl` on Replicate has no
    `aspect_ratio` input at all (unlike the FLUX/SD3.5 models on the same
    platform), so it's special-cased to explicit `width`/`height` at one of
    SDXL's documented "optimal" resolutions instead.
  - A job's background task, on success, downloads/decodes the image bytes,
    writes them to `images/scene_{n}_{shorthex}.{png|jpg|webp}` (extension
    from the URL or the response's content-type/mimeType), and **persists
    directly onto the project** (fresh `load_project`/`save_project`, same as
    every other generation route) — the image is on disk and in
    `project.scenes[n].images` by the time a poll first reports `completed`,
    independent of whether the frontend is still polling. Each saved image
    record also carries `model` (the composite `provider:model_id` used),
    `aspect_ratio` (what was requested, or `null`) and `cost` (same
    provider-reported-or-catalog number as the usage ledger row for that
    call) — `ImageLightbox.jsx` shows these plus the actual pixel resolution
    (read client-side off the loaded `<img>`, not stored server-side — no
    Pillow dependency here) when a thumbnail is expanded.
  - `DELETE /api/projects/{id}/scenes/{n}/images/{image_id}` removes one
    generated image: drops it from `project.scenes[n].images` and deletes its
    file from disk (same load/mutate/save-then-unlink shape as
    `POST`/`DELETE .../reference-images` in `routers/generation.py`, which
    upload/remove `project.reference_images` the same way).
  - `POST /api/projects/{id}/scenes/{n}/images/upload` (`multipart/form-data`,
    exactly one of a `file` or a `url` field) lets a user add their own image
    to a scene alongside AI-generated ones — the Images stage's `SceneCard.jsx`
    exposes it as an "upload" button (file picker or a pasted URL) and as
    drag-and-drop directly onto the image preview (a dropped file, or a
    dragged image URL). The `file` path validates the extension the same way
    `upload_reference_image` does; the `url` path goes through
    `images.download_user_image_url`, which — unlike the provider-URL
    `_download` helper above, since this URL is arbitrary user input — only
    allows `http(s)` with a resolvable **public** host (rejects
    private/loopback/link-local addresses, an SSRF guard), does not follow
    redirects, requires an `image/*` content-type, and caps the response at
    15MB while streaming. Either path is written and appended to
    `scene.images` via `images.save_uploaded_image` (same dict shape as a
    generated image, with `model: 'upload'`, `aspect_ratio: null`, `cost: 0`
    so the rest of the UI — carousel, rating, delete, lightbox — treats it
    identically).
  - **Crop/outpaint editor** (`ImageCropEditor.jsx`, opened from
    `ImageCarousel.jsx`'s crop button — scene images only, not Title Card
    variants or reference images): a fullscreen `react-konva` editor with a
    draggable/resizable rectangle over the image, in the image's own
    natural-pixel coordinates (same `Rect`+`Transformer`, resize-only-anchors
    mechanic `PosterConstructor.jsx`'s crop mode uses, but — unlike that one —
    the rectangle is allowed to go negative or past the far edge). A
    view-only zoom (scales the Konva `Stage`, never the rectangle's own
    coordinates) lets the rectangle be dragged far beyond a shrunk-down image
    for a large outpaint on every side. `POST
    /api/projects/{id}/scenes/{n}/images/{image_id}/crop {crop: {x, y,
    width, height}, quality?}` (`images.crop_image`) computes each side's
    overflow past the source image's bounds; a selection fully inside the
    image is a free, instant local PIL crop (`model: 'local:crop'`, cost
    `0`, no network call) — any overflowing side instead calls FAL's
    `fal-ai/flux-2-pro/outpaint` (`_call_outpaint_fal`) for just that much
    expansion, then crops the expanded canvas down to the exact requested
    box. Like "remove background", this **appends** a new image
    (`source_image_id` pointing back at the original, which is left
    untouched) rather than replacing anything; the editor shows a live
    "will outpaint WxH" indicator once any side overflows, and disables Save
    once the outpainted canvas would exceed FAL's 2560px-per-side limit
    (`OutpaintTooLargeError`, mapped to `400`; a missing project/scene/image
    is a plain `ValueError`, mapped to `404`).
    `quality` (`'fast'|'quality'`, defaults to `settings.outpaint_quality_mode`,
    overridable per-save in the editor) only changes behavior when there's a
    **left**-side overflow: `'fast'` sends one combined call for all four
    sides; `'quality'` (`_outpaint_with_quality`) additionally mirrors the
    source horizontally, outpaints the mirrored copy's right edge (FLUX's
    reliably-strong side) to generate the left strip, mirrors it back, and
    composites it onto the primary call's result — the FAL outpainting
    recipe this was implemented from only documents the left/right
    asymmetry, so top/bottom overflow doesn't get the same treatment; a
    quality-mode left overflow combined with top/bottom overflow can leave a
    faint seam at the top-left/bottom-left corners, an accepted limitation
    of generalizing that recipe rather than a bug. Priced per output
    megapixel (`_OUTPAINT_PRICE_PER_MEGAPIXEL`, computed directly and
    threaded through `usage_out['cost']` — the same provider-reported-cost
    bypass `_generate_openrouter` uses — since `pricing.py`'s catalog schema
    only models a flat per-image price, not per-megapixel, so there's no
    `pricing.py` catalog row for this model).
  - A job's background task, on failure (missing API key, non-2xx response,
    unexpected shape, provider-reported failure/timeout), sets `status:
    'failed'` with a Russian `error` string — no silent fallback, matching
    `suno.py`'s philosophy that a real-provider failure must be visible
    rather than quietly serving a placeholder.
  - The prompt sent to every provider is the scene's `static_prompt` as-is;
    scene image generation does **not** send any reference images to the
    provider (no image-to-image conditioning) — see `title_card.py` just
    below for the one place in this app that does.
  - Widens the existing "autosave race" gotcha below: a job can take anywhere
    from ~1s (Google) to tens of seconds (Krea/Replicate/FAL polling), so the
    window in which an unrelated debounced `PATCH` could revert the job's
    just-written `scenes[n].images` is longer than it was for the old
    synchronous stub.
- `video.start_jobs`/`get_job` is the Video stage's provider seam —
  genuinely **image-to-video**: it sends one already-generated scene image
  (the scene's `is_selected` one, or an explicit `image_id` override)
  alongside the scene's `motion_prompt` (plus any active video wishes, see
  `video.build_prompt`). Same background-job/poll shape as `images.py` (its
  own `_jobs` dict), but a longer poll interval (6s) and timeout (600s) —
  video generation runs for minutes, not seconds. Only two providers are
  confirmed to do image-to-video for this app (endpoints confirmed against
  each provider's own docs, 2026-08):
  - **Google Veo** (reachable via either the `google` or `google_free`
    provider id, same as elsewhere): `POST .../v1beta/models/{model_id}
    :predictLongRunning` with the source frame as `instances[0].image
    .inlineData{mimeType, data}` (base64) + `prompt`, and
    `parameters{aspectRatio, resolution, durationSeconds}`
    (ai.google.dev/gemini-api/docs/veo). Unlike Imagen's `:predict` (a single
    synchronous call), this returns a long-running operation resource name
    (`{name: "models/.../operations/..."}`) that must be polled — `GET
    .../v1beta/{operation_name}` (same host, `key` query param) until `done:
    true`; the finished video's URI is at `response.generateVideoResponse
    .generatedSamples[0].video.uri`, itself a Google-hosted resource that
    needs the same `key` query param to download (not a plain public URL).
    Veo 3.1 only accepts `durationSeconds` of `"4"`, `"6"` or `"8"` (as
    strings) — `video._nearest_google_duration` rounds the requested
    duration to the closest of those. No per-call cost in the response — cost
    is computed from the catalog's `per_second` rate (see
    [usage-tracking.md](usage-tracking.md)).
  - **OpenRouter's Unified Video API**: `POST
    https://openrouter.ai/api/v1/videos` (confirmed against openrouter.ai
    /docs/guides/overview/multimodal/video-generation, 2026-08) with
    `frame_images: [{type: 'image_url', image_url: {url}, frame_type:
    'first_frame'}]` (a `data:` URI works directly, no upload step) for
    image-to-video, plus `duration`/`resolution`/`aspect_ratio`. Returns `202
    {id, polling_url, status}` immediately; poll `GET
    /api/v1/videos/{id}` until `status` is `completed`/`failed`, video at
    `unsigned_urls[0]` (a pre-signed download link, no auth needed).
    `usage.cost` in the poll response is OpenRouter's own exact price for the
    call — threaded through as `provider_cost`, same bypass `images.py`'s
    `_generate_openrouter` uses for images.
  - `POST /api/projects/{id}/scenes/{n}/videos` (`{count?, model,
    motion_prompt?, image_id?, aspect_ratio?, resolution?,
    duration_seconds?, active_video_wish_ids?}`) resolves which image to
    animate (`422` if the scene has no `is_selected` image and none is
    given), builds the prompt, and starts one job per requested variant
    (`count` defaults to 1 in the UI — video is expensive/slow enough that a
    variant-count picker wasn't asked for). `GET
    .../videos/jobs/{job_id}` polls one job (`{status, video, error, debug}`
    — `debug` a redacted `{request, response}` snapshot, same convention as
    every other provider seam's debug panel). `DELETE
    .../videos/{video_id}` removes one result (drops it from
    `scene.videos`, deletes its file).
  - A completed job writes to `videos/scene_{n}_{shorthex}.mp4` and appends a
    `Video` record (`rating`/`is_selected`/`model`/`cost` mirror `Image`'s
    shape, plus `motion_prompt`/`aspect_ratio`/`resolution`
    /`duration_seconds`/`generation_ms`/`source_image_id` — see
    `data-model.md`) — append-only like `images[]`.
  - `video_models.py` mirrors `image_models.py`'s catalog shape for the
    Settings "refresh models" button (`GET
    /api/settings/video-models/{provider}`): Google's listing is filtered to
    `predictLongRunning`-capable models (the real signal Veo answers
    through, unlike Imagen's `predict` or Nano Banana's `generateContent`);
    OpenRouter uses its own dedicated `GET /api/v1/videos/models` discovery
    endpoint (unlike its image API, which piggybacks on the general
    `/models` listing) — confirmed against openrouter.ai's video-generation
    docs, 2026-08. No curated fallback for either — only these two providers
    are wired, and a failed live call just surfaces `source: 'error'`.
  - `settings.video_models` is a single favorites list (no cheap/quality
    tier split like `image_models`/`image_models_simple` — not asked for);
    `settings.video_wish_library` is a separate wish library from
    `scene_wish_library` (same `add_or_get_wish`/`use_count` mechanics),
    resolved and folded into the scene's `motion_prompt` as an emphasized
    numbered block (`video.build_prompt`, same "ВАЖНЫЕ ТРЕБОВАНИЯ
    ПОЛЬЗОВАТЕЛЯ" convention `scenes.py` uses for its own wishes) right
    before a generation call — see `data-model.md`.
- `title_card.start_jobs`/`get_job` is the Title Card stage's provider seam —
  same background-job/poll shape as `images.py` above (its own `_jobs` dict,
  never shared with it), but genuinely **image-to-image**: it sends the
  stage's up-to-4 chosen reference images alongside the text prompt. Four
  providers are confirmed (2026-08) to accept multiple reference images the
  way this feature needs, each with its own generator in
  `title_card._GENERATORS`:
  - **Google Gemini `generateContent`** ("Nano Banana" family, `gemini-*-image`
    ids), reachable via either the `google` or `google_free` provider id (see
    below — same call, different API key): each reference image becomes its
    own `inline_data` part ahead of the text part in `contents[0].parts`;
    `generationConfig.responseModalities: ['IMAGE']` asks for an image back,
    `generationConfig.imageConfig.aspectRatio` frames it. This is the same
    Nano Banana model family `images.py`'s `_generate_google` can't reach
    (that one only speaks Imagen's `:predict`, text-only) — `title_card.py`
    is where Nano Banana's real multi-image capability is actually used.
  - **Krea's `google/nano-banana-pro` proxy** (`POST
    https://api.krea.ai/generate/image/google/nano-banana-pro`): references go
    in as `style_images: [{url, strength}]`, `url` a base64 data URI (no need
    to host the references publicly first) — same job+poll shape as Krea's
    other models.
  - **FAL's `fal-ai/nano-banana/edit`** (a fal-hosted proxy of the same
    Gemini image model, up to ~14 references per fal's own docs): `POST
    https://queue.fal.run/fal-ai/nano-banana/edit` with `{prompt,
    image_urls}`, each entry a `data:image/...;base64,...` URI — same
    queue/poll shape as `images.py`'s `_generate_fal`. Only this one FAL model
    id supports references; the rest of the curated FAL catalog is
    text-to-image only, and picking one of those for this stage fails the job
    with an explicit "doesn't support reference images" error.
  - **OpenRouter's Unified Image API**: `POST
    https://openrouter.ai/api/v1/images` with `input_references:
    [{type: 'image_url', image_url: {url}}]`, `url` a base64 data URL —
    same single-call shape as `images.py`'s `_generate_openrouter`, plus the
    extra field.
  - Replicate has no *multi*-reference model in the current curated catalog —
    `black-forest-labs/flux-kontext-pro` takes exactly one `input_image`,
    which doesn't fit this stage's "up to 4 references" shape, so it's
    deliberately left unwired here rather than silently dropping references.
    Replicate *is* used for one single-image, non-generation call this stage
    makes: `851-labs/background-remover` (see the "remove background" bullet
    below) — that's a plain image edit, not a multi-reference generation, so
    the constraint above doesn't apply to it.
  - `POST /api/projects/{id}/title-card/generate` (`{text_block, base_prompt,
    reference_image_paths, model, aspect_ratio?, count?,
    active_title_card_wish_ids?}`) validates every reference path resolves
    inside the project folder and exists, then starts one job per requested
    variant, same `{job_ids}` immediate-return shape as scene images. `GET
    .../title-card/jobs/{job_id}` polls one job (its response includes a
    `debug: {request, response} | null` field — see below). `DELETE
    .../title-card/variants/{variant_id}` removes one result (drops it from
    `project.title_card.variants`, deletes its file).
  - "Remove background" (`POST
    .../title-card/variants/{variant_id}/remove-background {method?}`,
    `title_card.remove_background`) sends one existing variant's image bytes
    through one of **3 interchangeable methods** and **appends** the
    transparent-background result as a new variant — `source_variant_id`
    points back at the original, which is left untouched. `method` is
    `'local' | 'fal' | 'replicate'`, chosen by the user right when the
    button is clicked (`TitleCardGallery.jsx`'s per-cell method menu); if
    omitted it falls back to `settings.background_remover_method` (default
    `'replicate'`, for back-compat with this feature's original
    single-method behaviour). Awaited directly by the route (no job/poll
    round-trip on the frontend, since it's one call, not `count` of them).
    The 3 methods:
    - **`local`** (free, no API key, no network call) —
      `_generate_background_remover_local`: a pixel-threshold cutout for a
      flat solid black/white background only (any pixel whose 3 RGB
      channels are all below `threshold`, or all above `255-threshold` for
      white, becomes fully transparent). Params from
      `settings.background_remover_local_params` (`bg`, `threshold`,
      editable in Settings → Providers). Priced at a hardcoded `0.0` (no
      catalog row — the id is synthetic, `local:pixel-threshold`).
    - **`fal`** — `_generate_background_remover_fal`: FAL's
      `fal-ai/bria/background/remove` (cleaner cut, commercial license) or
      `fal-ai/imageutils/rembg` (softer), picked via
      `settings.background_remover_fal_params.model`. Same queue/poll shape
      as this module's `_generate_fal` (base64 data URI works directly as
      `image_url`, no upload step), but the result is a single `image`
      object, not an `images` list. Priced off
      `pricing.BUILTIN_PRICING`'s `fal:fal-ai/bria/background/remove` row
      (the rembg model is billed per-second by FAL, doesn't fit this app's
      per-image pricing shape, and is left unpriced).
    - **`replicate`** (the original, still the settings default) —
      `_generate_background_remover`: Replicate's
      `851-labs/background-remover` (base64 data URI in, params from
      `settings.background_remover_params` — `background_type`, `format`,
      `threshold`, `reverse`, editable in Settings → Providers), priced off
      `pricing.BUILTIN_PRICING`'s `replicate:851-labs/background-remover`
      row. Unlike every other Replicate call in this app, this goes through
      the **versioned** `POST /v1/predictions` endpoint (`{version, input}`),
      not the shorthand `/v1/models/{owner}/{name}/predictions` route
      `images.py`'s `_generate_replicate` uses — `851-labs/background-remover`
      is a community (non-"official") model, and the shorthand route 404s
      for it (confirmed live, 2026-08). `_resolve_bg_remover_version`
      fetches and caches the model's `latest_version.id` once per process
      via `GET /v1/models/851-labs/background-remover`.

    All 3 share the same result plumbing: ledger task `title_card_bg_remove`,
    `new_variant.model` set to the composite id used (`local:pixel-threshold`
    / `fal:{model_id}` / `replicate:851-labs/background-remover`).
  - A completed job writes to `titlecard/{shorthex}.{png|jpg|webp}` (parallel
    to `images/`/`references/`) and appends a variant — same
    `rating`/`is_selected`/`model`/`aspect_ratio`/`cost` fields as a scene
    `Image` (`pickMainByRating` reused unmodified), plus `text_block`/
    `base_prompt`/`reference_image_paths`, a snapshot of what produced it
    (and `source_variant_id` for a "remove background" result — see below).
    The frontend shows every variant at once in `TitleCardGallery.jsx`'s grid
    rather than paging through them like `ImageCarousel.jsx` does elsewhere.
  - Uploading a custom reference image reuses the existing
    `POST/DELETE /api/projects/{id}/reference-images` endpoints unchanged
    (lands in `project.reference_images`, selectable into any of the 4 slots)
    — no dedicated upload endpoint for this stage.
  - The final prompt is `settings.title_card_base_prompt` (editable in the
    stage's own collapsible panel, same autosave pattern as
    `updateSunoBasePrompt`; seeded from
    [`providers/title_card_prompt_defaults.py`](../backend/app/providers/title_card_prompt_defaults.py)),
    plus an active-wishes block (same `active_scene_wish_ids` pattern as
    Scenes, backed by its own `settings.title_card_wish_library` and
    `project.active_title_card_wish_ids` — see `wish_library.py`), plus the
    stage's free-text block appended verbatim (`title_card._build_prompt`) —
    a single multi-line field the user edits directly (default value
    `"Заголовок"\n"Автор"`), not two separate title/author inputs the server
    wraps in quotes: the quote marks are a delimiter the user types
    themselves to mark off one styleable group of text (title vs. author,
    say), and the app's own default base prompt (`DEFAULT_TITLE_CARD_BASE_PROMPT`
    in `title_card_prompt_defaults.py`) instructs the model accordingly — the
    quote characters themselves are not meant to be rendered on the poster,
    and a group's opening/closing quote may be on different lines while
    still counting as one group in one style. `settings.title_card_base_prompt_presets` is a
    **user-managed** array of named variants (`{id, name, prompt}`, seeded
    with 3 built-ins from `title_card_prompt_defaults.py`) the stage can
    save/load/delete — plain client-side CRUD against the regular
    partial-merge `PUT /api/settings`, no dedicated endpoints.
  - Each generator writes a redacted `{request, response}` debug snapshot into
    `usage_out['debug']` (reference-image bytes and any inline base64 result
    data replaced with a short `<... bytes>` placeholder; plain URLs are kept
    as-is) — `_run_job`/`remove_background` thread it onto the job record (and
    `remove_background`'s HTTP response) so the stage's collapsible debug
    panel (same pattern as Scenes'/Suno's) can show exactly what was
    sent/received without dumping raw image bytes into the UI. `usage.record`
    now also takes this same `debug` dict app-wide (every provider seam —
    `title_card.py`, `suno.py`, `scenes.py`, `images.py`, `text_models.py`,
    `translate.py` — passes it) and always prints it to the backend console
    via `console_log.log_debug` (any string value over 100 chars truncated,
    see `console_log._truncate`) — not just on failure, so a paid call's
    actual request/response JSON is visible in the dev console without
    reproducing it through the UI's debug panel.
- `mureka.start_job`/`get_job` is the Music generation stage's provider seam —
  same in-memory `_jobs`-dict/poll shape as `images.py`/`title_card.py`
  above, but **one job per generate click**, not one per variant: Mureka's
  own `song/generate` takes an `n` (1-3) and returns that many songs from a
  single async task, so `_run_job` submits once, polls
  `GET /v1/song/query/{task_id}` (confirmed against platform.mureka.ai/docs,
  2026-08) every 3s (longer than image jobs' 1.5s — Mureka cites 30-90s
  typical generation time) until a terminal status, then materializes one
  `MurekaTrack` per `choices[]` entry.
  - `POST /api/projects/{id}/mureka/generate` (`{style, lyrics, model, n,
    gender?, reference_id?}`) → `{job_id}` (singular, unlike the scene-image/
    title-card routes' `{job_ids}`). `GET
    .../mureka/jobs/{job_id}` polls it, same `{status, ..., error}` shape as
    the other job endpoints.
  - On `succeeded`, each `choices[].url` is downloaded and written to
    `music/{track_id}.mp3` **immediately** — Mureka's own URLs are only valid
    30 days, unlike this app's other providers whose bytes are fetched once
    and kept forever anyway. The full `choices[]` entry (incl. `flac_url`/
    `wav_url`/`lyrics_sections`, never fetched) is kept as `raw` on the track
    record for reference. All new tracks for one job are appended to
    `project.mureka.tracks` in a single load-mutate-save, not one write per
    track.
  - `POST /api/projects/{id}/mureka/reference-audio` (multipart `file`,
    mp3/m4a only) does two things: saves a local copy under
    `music/references/` **and** calls `mureka.upload_reference_audio`
    (`POST /v1/files/upload`, `purpose=reference` — Mureka trims to exactly
    30s) to get a Mureka file id, stored as `mureka_file_id` and usable as
    `reference_id` on a later `generate` call. `DELETE
    .../mureka/reference-audio/{ref_id}` removes both the local file and the
    library entry (the Mureka-side upload itself isn't deleted — Mureka has
    no delete-file endpoint in its current API).
  - `DELETE /api/projects/{id}/mureka/tracks/{track_id}` removes one track's
    record and unlinks its `.mp3`, same lock→load→filter→save-then-unlink
    ordering as every other delete route in this file. Rating/tagging/the
    `is_selected` primary flag have **no dedicated route** — the frontend
    recomputes the whole `project.mureka.tracks` array client-side and sends
    it through the generic `PATCH /api/projects/{id}`, the same convention
    scene-image rating already uses.
  - No `pricing.py` catalog row exists for `mureka:*` models — Mureka's API
    doesn't report a per-call cost, so `usage.record(kind='audio', ...)`
    resolves to `cost.amount: null`/`'unknown'` by the existing "unknown cost
    is null, never 0" convention, rather than a guessed number.

### Poster constructor

Below the Title Card variants gallery, "Assemble poster" opens a
`react-konva`-based editor (`PosterConstructor.jsx`) that composites a
background (any already-generated scene/reference image), one Title Card
variant (typically a background-removed one) and an optional logo into a
draggable/resizable layout, flattened to PNG client-side
(`stage.toBlob()` — no server-side image library needed) and saved as a new
`project.title_card.posters[]` entry:

```
{ poster_id, file_path,                 # flattened PNG
  background_path, title_card_variant_id, logo_id,
  canvas_size: {width, height},         # background's natural size
  layers: { title_card: [{id,x,y,scaleX,scaleY,rotation,crop,effects}],
            logo: [{...}]|null,
            glass: {x,y,width,height,scaleX,scaleY,rotation,cornerRadius,opacity,thickness}|null,
            text: [{id,x,y,scaleX,scaleY,rotation,textType,text,fontFamily,fontSize,color,bgColor,effects}] },
  rating, is_selected, generated_at }
```

Saving stores the layer transforms alongside the flattened image (not just
the PNG), so `PosterGallery.jsx`'s "Edit" reopens the exact same arrangement
in `PosterConstructor` for further adjustment — re-saving with the same
`poster_id` re-renders in place rather than creating a new entry (same
`file_path`; the gallery/lightbox `<img>` tags append a `?v=generated_at`
cache-busting query param so the browser doesn't keep showing the previous
PNG it already cached at that same URL).

`title_card` and `logo` are **arrays** of layers, not single objects — the
layer toolbar's "Дублировать" (duplicate) button clones the selected layer
(offset slightly, independently movable from then on) so the same source
image can appear multiple times with different positions/crops, e.g.
splitting one title-card render (headline + author baked into a single PNG)
into an independently-placed headline layer and author layer. "Обрезать"
(crop) toggles a second interaction mode on `OverlayImage`: the normal
whole-layer Transformer (corner handles only, plus rotate) is swapped for a
resize-only crop-rect Transformer with all 8 anchors enabled — 4 corners
plus the 4 edge midpoints (`top-center`/`bottom-center`/`middle-left`/
`middle-right`) — so a single edge can be pulled in independently instead of
always dragging a corner and affecting two sides at once; each anchor
renders Konva's default small square handle, doubling as the "this edge is
draggable" indicator. It's drawn over a dimmed full-resolution copy of the
image, so parts outside the current crop are visible again to crop back in,
editing `layer.crop`
(`{x,y,width,height}` in the source image's natural pixel space, or `null`
for no crop) live as it's dragged. Both the ghost image and the crop editor
share the Konva name `crop-editor` purely so `handleSave`'s export pass can
find-and-hide them in one call — nothing from crop-editing mode should ever
leak into a saved PNG, even if the user saves without clicking "Готово"
first. Older saved posters stored a single transform object here instead of
an array; `PosterConstructor.jsx`'s `normalizeLayers` wraps it into a
one-item array on load, so both shapes still open correctly.

Each layer also carries an `effects` bag, edited via `EffectsPanel` in
`PosterConstructor.jsx` when that layer is selected: the layer's own
**opacity** (a plain 5–100% slider), an optional **glow**
(`{enabled,color,blur,distance,opacity}`, rendered as a Konva shadow on the
overlay image itself — the shadow follows the image's own alpha shape), and
an optional **clone** (`{enabled,offsetX,offsetY,opacity,blur}`) - a second
copy of the same layer rendered behind the real one, offset a few px, for a
cheap fake-depth "double object" look. The clone renders with the *same*
glow as the real layer (so both copies get the halo, doubling the sense of
volume), plus its own opacity and an optional blur (`useCloneBlur` -
`.cache()` + `Konva.Filters.Blur`, only engaged once `clone.blur > 0`, so
the common no-blur case stays a plain, un-cached, pixel-crisp render) that
only ever applies to this back copy.

The glow **intensity** slider shows 0–100%, but a single Konva shadow pass
physically caps out around there - `shadowOpacity` composites into the
shadow color's alpha, which the canvas clamps to 1, so pushing the
underlying value further has no visible effect in one pass. `glow.opacity`
is still stored 0–5 internally (old data, and the slider's real range,
unchanged) - `glowPasses()` in `PosterConstructor.jsx` turns any value past
that single-pass ceiling (`glow.opacity > 1`) into several identical
stacked shadow passes instead, so dialing past the old ceiling keeps
visibly deepening the halo (up to 5 stacked passes at 100%) rather than
silently doing nothing above the old slider's 100% mark. Trade-off: every
pass also redraws the layer's own fill at its own opacity, so a
heavily-transparent layer with a maxed-out glow will read a little more
solid than the opacity slider alone implies - accepted for a simple,
low-risk render path, since the common case (opacity at/near 100%) is
unaffected.

Both bake into the flattened PNG at save time; the backend stores `effects`
opaquely inside `layers` (no schema validation), see `docs/data-model.md`'s
**Poster** entry. (Earlier versions of this panel had a **backdrop** effect
— a feathered filled `Rect` behind the image — instead of `opacity`; it was
dropped as not useful enough to justify the extra control. Old saved posters
with a `backdrop` key just lose that effect on next load.)

A third, optional overlay is a **glass** panel - a plain rounded rect (not
tied to any source image), added via the "Объекты" row's button and limited
to one instance. Its live-preview render (`OverlayGlass` in
`PosterConstructor.jsx`) is a cheap simulation - a white-tinted `Rect` plus a
soft edge-highlight `Rect` stroke, both driven by the `opacity`/`thickness`
sliders in `GlassPanel` - since redrawing a real blurred backdrop on every
drag frame would be too slow. At save time `handleSave` swaps in the real
thing: it hides the glass node, rasterizes the rest of the stage to a canvas,
samples and blurs the region under the glass's (possibly rotated) bounds with
plain Canvas2D ops (`buildHqGlassCanvas`), re-tints/clips/borders that
sample, and inserts it as a temporary `Konva.Image` in the glass's place
before flattening - then reverts the stage back to its live editable state.

The picture area itself can be expanded via the header's fullscreen toggle
(`Maximize2`/`Minimize2`). In fullscreen the modal's own title bar is
dropped entirely (not just shrunk) — `.modal-backdrop`'s padding and the
`.modal-card`'s own padding/border-radius are both zeroed so the card is a
true edge-to-edge `100vw`/`100vh` overlay, and the collapse/close buttons
float over the picture's top-right corner instead of taking their own
layout row — so the picture cell can grow to fill essentially the entire
viewport height (only `FULLSCREEN_V_RESERVE`, a small bottom-padding
buffer, is reserved). Since the collapse/close buttons float over the same
top-right corner the tools panel docks to, the panel gets a `paddingTop`
(fullscreen only) sized to clear them, so the zoom/undo row that used to be
the panel's first child doesn't render underneath those buttons. The tools
column stays a fixed `SIDE_PANEL_WIDTH`
(300px) docked flush to the right edge in both modes — `flex: 1` on the
picture cell plus a fixed-width (non-growing) panel, rather than the
reverse, is what keeps the extra space from piling up as a dead zone next
to a narrower/portrait poster. In both modes the Stage canvas is padded
with an `OVERFLOW_MARGIN`/`OVERFLOW_MARGIN_FULLSCREEN` border (screen px)
beyond the poster's own bounds, so an overlay being dragged or resized past
the poster edge stays visible instead of getting clipped mid-edit;
`handleSave` crops that margin back out (`toBlob({x,y,width,height,...})`)
so the exported poster is always exactly `canvas_size`.

Independent of that fit-to-container scale, the picture area also supports
interactive zoom — a `−`/percentage/`+` row docked at the top of the tools
panel (not floating over the picture, so it never sits on top of the poster
content), plus mouse-wheel zoom anchored at the cursor (the standard Konva
"zoom to pointer" recipe: read the pointer's position in stage space at the
old scale, then solve for the stage offset that keeps that same point under
the cursor at the new scale). This is layered on top of the auto-fit
`scale` as a separate `zoom` multiplier plus a `stagePos` offset, both reset
whenever the background image or fullscreen state changes (an offset
computed under a since-resized view doesn't mean anything any more).
`handleSave` briefly resets the Stage's actual `scale`/`position` to the
neutral fit-scale/origin before capturing (matching the crop/margin math,
which assumes exactly that state) and restores the interactive zoom
afterward, so the exported poster is never affected by whatever the user
happened to be zoomed to while editing. The `Stage` itself is **not**
draggable (removed - it used to double as a pan gesture, but a plain drag
anywhere off an overlay reads as "grabbing the poster" and had no undo,
which was confusing since every other mutation goes through `commit`); the
background layer was already `listening={false}` and non-interactive, so
with Stage panning gone there's no way to move the background at all, by
design - only the wheel/button zoom (which still adjusts `stagePos` to
zoom on the cursor) repositions the view.

The five picker rows (background/title card/logo/objects/templates) are
individually collapsible (`PickerRow`'s `collapsible` prop, chevron toggle,
open/closed state kept local to each row) so the fixed-width panel stays
manageable once several sections have content — logo, objects and templates
default closed since they're touched less often than background/title card.

**Text layers.** The "Объекты" row also offers two freely-editable text
layer types, rendered by `OverlayText` (the same drag/Transformer/select
skeleton as `OverlayImage`, minus crop — text has no crop concept):
`badge` (a black rounded-pill background behind white text, default font
Forum) and `halo` (bare text with a drop-shadow "halo", default font
Montserrat) — reusing the exact same `effects.glow` shadow mechanism
`OverlayImage` already has for images, rather than a second duplicated text
node, since Konva `Text` exposes the same `shadow*` props as `Image`. A new
layer's default content comes from the Title Card stage's `text_block`
(`parseTextBlock` splits its two quoted lines into title/author — `halo`
defaults to the title, `badge` to the author), falling back to plain
placeholder strings when `text_block` is empty. Font choice
(`FONT_OPTIONS` in `PosterConstructor.jsx`) is deliberately limited to
families verified (via the raw Google Fonts `css2` response, not just the
specimen page) to ship cyrillic glyphs, since poster text is typically
Russian — Forum, Montserrat, PT Sans, Oswald, Roboto Condensed, Rubik,
Playfair Display all do; Lato does not and is kept in the list only for
latin content, never as a default. The badge's pill `Rect` auto-sizes to
the rendered text (read back from the Konva `Text` node's `getTextWidth()`/
`height()` after paint, re-measured once more on `document.fonts.ready` in
case the paint raced the Google Fonts `<link>` in `index.html`). Each text
layer also has `align` (`'left'\|'center'\|'right'`, defaults `'left'`) -
Konva only honors `Text`'s `align` prop once it's given an explicit `width`
(otherwise the node auto-sizes to its content and alignment has no visible
effect), so the node is fed `width={box.w}` (the same measured natural
width used for the badge pill) plus `wrap="none"` (so a manual `\n` line
break still only breaks where typed, not re-wrapped to that width).

**Undo/redo.** A single document snapshot —
`{backgroundPath, titleCardVariantId, logoId, titleLayers, logoLayers,
glassLayer, textLayers}` — flows through one choke point, `commit(mutate)`:
it pushes the pre-mutation snapshot onto a `past` stack (clearing `future`)
before running `mutate`, unless the previous commit landed under 400ms ago,
in which case it's coalesced into that same snapshot instead of pushing a
new one — the mechanism that keeps a single slider/color/text-field drag
(which calls `commit` on every tick) from flooding the history with one
entry per pixel/keystroke. Every mutating action in the file (pick
background/title/logo, add/remove glass, add/duplicate/delete/update any
layer including text) routes through `commit`. Undo/redo buttons sit next
to the zoom row (`Undo2`/`Redo2`, disabled when their stack is empty);
`Ctrl/Cmd+Z` and `Ctrl/Cmd+Y`/`Ctrl/Cmd+Shift+Z` do the same, via a
`window`-level `keydown` listener that ignores the event while focus is in
an `INPUT`/`TEXTAREA`/`contentEditable` element (so native undo inside a
text field isn't hijacked).

**Center-snap guides.** Dragging any overlay (image, glass, or text) toward
the poster's own center shows a dashed guide line and gently snaps to it —
`snapGroupToCenter` (called from each overlay's `onDragMove`) compares the
dragged Konva node's own bounding-box center against the poster's center
and, within a `CENTER_SNAP_PX`-screen-pixel threshold (converted to local/
zoom-independent units via `effectiveScale`), mutates the node's position
directly — a cheap Konva-only operation, not a React state update, so it
doesn't trigger a re-render on every drag frame. Only the guide-visibility
flags (`guides.v`/`guides.h`, driving two `Line` nodes) are React state.
Snapping only applies to dragging, not resizing/rotating.

- `POST /api/projects/{id}/title-card/poster` (multipart: `file` PNG +
  `background_path`, `title_card_variant_id`, `logo_id`, `layers` (JSON),
  `canvas_size` (JSON), optional `poster_id` to update in place) validates
  `background_path` the same way reference paths are validated elsewhere and
  that `title_card_variant_id` exists on the project, writes the PNG under
  `titlecard/posters/`, and upserts the poster into `project.title_card.posters`.
- `DELETE /api/projects/{id}/title-card/poster/{poster_id}` removes one.
- Logos are a **global** (cross-project) library — `settings.logos: [{id,
  name, file_path}]`, files under `app_data/logos/` (served at
  `/media/logos/...` — the `/media` mount is `storage.get_data_root()`, the
  same mount every project's `images/`/`references/`/`titlecard/` files go
  through, see `main.py`), managed from Settings → Logos
  (`POST/DELETE /api/settings/logos[/{id}]`, PNG/WebP only).

**Templates.** The "Шаблоны"/"Templates" picker row lets a poster's
logo/glass/text layout be saved and reapplied across any poem or project -
`settings.poster_templates: [{id, name, layers{logo_id, logo[], glass,
text[]}, created_at}]`, no file involved (unlike `logos`) so it's plain
array CRUD through the ordinary partial-merge `PUT /api/settings`, same
pattern as `title_card_base_prompt_presets` (`savePosterTemplate`/
`deletePosterTemplate` in `useSettings.js`). "Сохранить как шаблон"/"Save as
template" snapshots exactly `{logoId, logoLayers, glassLayer, textLayers}` -
deliberately **not** `backgroundPath`/`titleCardVariantId`/`titleLayers`,
since those are specific to the poem this poster happens to be for, while
the logo/glass/text arrangement is the reusable, poem-independent part of
the layout. `applyTemplate` restores that saved `layers` object onto
whatever background/title-card is currently picked, regenerating a fresh
`id` on every logo/text layer (`genId()`) so the applied copies are
independently editable from the template itself (and from any earlier
application of it) rather than aliasing the same ids.

## AI usage & cost tracking

Every provider call above (Suno generation, wish-title completion, scene
image generation, prompt translation) is recorded to an append-only ledger at
`app_data/usage/YYYY-MM.jsonl`, with token/image counts and a computed cost
(from a price catalog, or the provider's own reported cost when it has one).
A "Расходы"/Usage screen and a spend-today pill in every header read it back
through `GET /api/usage/*`; model pickers show a price hint per model from
`GET /api/usage/pricing`. Full detail — record schema, the cost-resolution
rules (**unknown cost is `null`, never `0`**), how to instrument a new call
site, and per-provider field locations — is in
[usage-tracking.md](usage-tracking.md). Two rules worth knowing up front
since they shape the provider seams above: **errors are recorded too** (a
failed call may still have been billed), and a **catalog-priced record's cost
is recomputed on every read**, so correcting a placeholder price retroactively
fixes history.

## Voice input (speech-to-text)

Dictation into text fields uses the browser's native **Web Speech API**
(`window.SpeechRecognition` / `window.webkitSpeechRecognition`) — no backend
call, no third-party library. All of it lives in
[`useVoice.js`](../frontend/src/hooks/useVoice.js), which `App.jsx` wires up
last (it writes into the Suno refinement box and the Scenes wish box, so it
depends on both `suno` and `scenes`).

- **Feature detection, not a polyfill.** `isVoiceInputSupported` is a
  module-level `!!(window.SpeechRecognition || window.webkitSpeechRecognition)`
  check. `useVoice` exposes it as `isSupported`; `App.jsx` forwards it to each
  stage as `voiceSupported`, and the four mic buttons
  ([`BlockCard.jsx`](../frontend/src/components/workflow/BlockCard.jsx),
  [`SunoStage.jsx`](../frontend/src/components/workflow/SunoStage.jsx)'s
  refinement box,
  [`ScenesStage.jsx`](../frontend/src/components/workflow/ScenesStage.jsx)'s
  scene-wish box,
  [`SceneTextCard.jsx`](../frontend/src/components/workflow/SceneTextCard.jsx)/
  [`SceneCard.jsx`](../frontend/src/components/workflow/SceneCard.jsx)'s
  static-prompt edit) only render when it's `true`. No error message, no
  fallback UI — the button simply isn't there in unsupported browsers.
- **One global recorder.** `recordingKind`/`recordingTarget` track which field
  is currently listening; clicking a mic button toggles — starts a new
  `SpeechRecognition` if none is running, calls `.stop()` on the stored
  instance if one is. `recordingSeconds` ticks a `setInterval` purely for the
  `L.recording · Ns` banner; it has no effect on when recognition actually
  stops (the browser ends it once the user stops talking, since
  `continuous` is left at its `false` default).
- **Language** comes from `settings.lang` (`'ru'`/`'en'`), mapped to BCP-47
  (`ru-RU`/`en-US`, defaulting to `en-US`) — there's no BCP-47 value stored
  anywhere else in settings.
- **Result handling:** `interimResults: false`, `maxAlternatives: 1`; the
  final transcript (`event.results[0][0].transcript`) is spliced into the
  target field via the same callback the mock used to use
  (`updateProject` for a lyrics block/scene prompt, `setRefinementText` for
  the Suno wish box, `setSceneWishText` for the Scenes wish box) — never
  stored inside the hook itself, so the field stays a normal controlled
  `value`/`onChange` component.
- **Errors** are split three ways in `onerror`: `'not-allowed'` (mic
  permission denied), `'no-speech'` (nothing heard), and everything else —
  each shows its own short toast (`L.toast_voice_denied` /
  `L.toast_voice_no_speech` / `L.toast_voice_error`).
- **Cleanup:** the hook's `useEffect` calls `.stop()` on unmount so a
  navigation away never leaves a live mic connection behind.
- **`useFieldVoice`** (same file) is a `project`-independent sibling for
  standalone fields that aren't part of the lyrics/Suno/scenes state -
  currently the Settings → Wishes tab's new-wish input and the title/text
  fields of an in-place wish edit. Same recognition setup and error toasts,
  but keyed by a caller-chosen `fieldId` string (`recordingField`) instead of
  `kind`/`target`, and the transcript is handed back to the caller via an
  `onTranscript(transcript)` callback rather than a fixed set of built-in
  targets - `SettingsScreen.jsx` decides itself whether to replace (title) or
  append (text/draft) the field's current value.

**Adding voice input to a new field** follows the same shape every time:
gate the mic button on a `voiceSupported` prop threaded down from
`voice.isSupported`, wire its `onClick` to `startVoice(kind, target)` (a new
`kind` needs a branch in `useVoice`'s `applyTranscript`), and show the
`isRecording`/`recordingSeconds` state your stage already receives from
`App.jsx`. Reach for this only on free-form natural-language fields the user
would plausibly *say out loud* — prompt/instruction text for an AI step,
lyrics, style descriptions — not on precise/copy-pasted input like URLs, API
keys, or titles.

## The music prompt: base instructions, active wishes, examples, per-song add-ons

Four layers get concatenated into what's actually sent to Gemini, in this
order (`suno._build_gemini_prompt`):

1. `settings.suno_base_prompt` — the general "how to adapt lyrics/style for
   this music service" instructions, editable in Settings. Seeded from
   [`providers/suno_prompt_defaults.py`](../backend/app/providers/suno_prompt_defaults.py)
   (`DEFAULT_SUNO_BASE_PROMPT`), adapted from a prompt the user already used
   manually with an LLM before this feature existed, and rewritten for Suno
   v5.5 prompting conventions (Style-field ordering/limits, bracket
   semantics, vocal-tag reliability, Russian stress-mark techniques). The
   Settings → "Музыкальные промпты" tab also offers built-in alternate
   variants, grouped by target service and served read-only (not part of
   `settings.json`) via `GET /api/settings/suno-prompt-presets`
   (`SUNO_BASE_PROMPT_PRESETS` in `suno_prompt_defaults.py` plus
   `MUREKA_BASE_PROMPT_PRESETS` in
   [`providers/mureka_prompt_defaults.py`](../backend/app/providers/mureka_prompt_defaults.py),
   concatenated by the route). Each preset object carries `{id, service, name,
   description, prompt}` — `service` (`'Suno'` / `'Mureka'`) is the group
   label the frontend renders above its chips/rows
   (`lib/sunoPrompt.js`'s `groupPresetsByService`, used by both
   `SunoStage.jsx`'s compact panel and `SettingsScreen.jsx`'s full tab). The
   two Suno presets only differ in Style-block field order; the two Mureka
   presets differ in whether vocal-delivery cues go only in the Style-block
   (`mureka-strict`) or can also be written as in-text parenthetical
   directives like `(whispering)` (`mureka-directed`) — both output shapes
   still respect the same `STYLE-BLOCK`/`LYRICS-MARKUP` contract the
   `===STYLE===`/`===LYRICS===` response-format footer below expects, so any
   new preset must keep emitting those two block headers. "Load preset, edit,
   save" is an A/B-testing flow — loading a preset just overwrites the shared
   `settings.suno_base_prompt` text field, so switching between a Suno and a
   Mureka preset replaces the previous one rather than keeping both.
2. The project's **active wishes** — the text of every
   `settings.suno_wish_library` entry whose id is in
   `project.active_wish_ids`, rendered as a single numbered block headed
   "ВАЖНЫЕ ТРЕБОВАНИЯ ПОЛЬЗОВАТЕЛЯ — обязательно учесть:" right after the
   base prompt, so the model can't miss them (there's no literal
   attention-weight knob on the API, so a clearly marked, prominently placed
   block is the emphasis mechanism). Omitted entirely when no wish is active.
3. `settings.suno_reference_examples` — a handful of curated finished
   style+lyrics examples (also seeded from `suno_prompt_defaults.py`,
   `DEFAULT_REFERENCE_EXAMPLES`), sent as "use as a reference, don't copy
   verbatim" material. Kept as plain text in settings rather than uploaded
   files: the source files were inconsistent sizes (1.5 KB to 84 KB) and raw
   file upload isn't worth the cost/latency for text this small — curated text
   embedded in the prompt does the same job for a fraction of the tokens. Like
   `settings.special_tags` (the Vocal-Interlude-style bracket tags editable on
   the same tab), this list is click-to-edit in `SettingsScreen.jsx`: clicking
   a row loads its full text into the add field below and turns "Добавить"
   into "Сохранить" (with a "Отмена" to bail out), so editing reuses the same
   input instead of a separate inline form. Both lists only persist on the
   Settings screen's own "Сохранить" button, unlike the wish library below.
4. `project.skill_prompt` — the per-song, freely-editable "Дополнения к
   промпту" text on the Suno stage (`SunoStage.jsx`), seeded from a fixed
   skill template on project creation. Unlike the old `suno/refine` flow,
   nothing gets folded into this text automatically anymore — it's purely
   whatever the user typed there.

`settings.suno_wish_library` is a separate, global list of reusable wish
"cards" (`{id, title, text, created_at}`) — not tied to any one project. The
Suno stage's "Доработка через AI-пожелание" section drives it two ways:
typing or dictating new text and clicking "Применить" calls
`POST /api/projects/{id}/suno/wishes`, which cleans+titles the text (or reuses
an existing card with identical text — see `wish_library.add_or_get_wish`)
*and* immediately activates it for the current project; clicking an existing
card toggles it active/inactive for the current project only (a plain
`PATCH /api/projects/{id}` with the updated `active_wish_ids`, no LLM call).
The same card can be active for one song and inactive for another — that's
the whole point of keeping wishes and their per-project activation separate.
Cards are also listable/editable from Settings → Wishes
(`PATCH /api/settings/wish-library/{id}`, `SettingsScreen.jsx`'s inline edit
mode, by typing or by voice — `useFieldVoice`, see "Voice input" above),
independent of any project.

`project.refinement_comments` still exists in `config.json` for backward
compatibility but is unused — it was the per-project history of wishes folded
in by the old `suno/refine` flow, replaced entirely by the card model above.
Projects predating this rework get it (and `skill_prompt`) reset once on
first load (`routers/projects.py::migrate_legacy_project`, keyed off the
*absence* of `active_wish_ids` — see `data-model.md`).

All four layers, plus the raw lyrics and the response-format footer
`suno.generate` appends, are visible **on the Suno stage itself** before you
generate anything: a collapsed-by-default "Базовый промпт" panel edits layer 1
directly (autosaves via its own debounced `PUT /api/settings`, separate from
the Settings screen's field, which only persists via its own "Сохранить"
button — see `useSettings.updateSunoBasePrompt`), and a collapsed-by-default
"Что уйдёт в модель" panel shows the full assembled text plus a rough
input-token/cost estimate (`lib/sunoPrompt.js`'s `buildSunoPromptPreview`
mirrors `_build_gemini_prompt` client-side, including the active-wishes block
— keep both in sync; `lib/pricing.js`'s `estimateTokensFromChars` mirrors the
backend's chars/4 heuristic — both are ex-ante UI estimates only, never the
source of truth for what a call actually cost). The model that preview prices
against, and that "Generate for Suno" actually uses, is a `ModelPicker` over
`text_models.favorites` next to the button — session-only, seeded from
`text_models.default`, same pattern the wish-model picker used before it was
replaced by the always-global `simple_models.default` (see above).

## The scene prompt: base instructions per mode, active wishes, style, scene count

Mirrors "The music prompt" above closely, adapted for the Scenes stage
(`scenes._build_prompt`):

1. `settings.scene_base_prompt_narrative` / `scene_base_prompt_abstract` — one
   editable base prompt per `scene_mode`, picked by the toggle on the Scenes
   stage. Both seeded from
   [`providers/scenes_prompt_defaults.py`](../backend/app/providers/scenes_prompt_defaults.py),
   adapted from a cover-art image-prompt instruction set the user already used
   manually (weighted `((main objects))`/`(secondary objects)` English
   phrasing, chorus-first focus, ~700-1000+ char density) - `narrative` adds a
   constraint the source didn't have: scenes must follow the lyrics' own order
   and carry a visible thread (character/setting/light) from first scene to
   last, instead of just re-varying one mood (`abstract`, which keeps the
   source's own "same mood, new composition" logic close to verbatim). Editable
   in Settings → "Музыкальные промпты" (each with its own autosave, same
   pattern as `updateSunoBasePrompt`) or in the compact panel on the Scenes
   stage itself.
2. The project's **active scene wishes** — `settings.scene_wish_library`
   entries whose id is in `project.active_scene_wish_ids`, rendered the same
   "ВАЖНЫЕ ТРЕБОВАНИЯ ПОЛЬЗОВАТЕЛЯ" block as the music prompt's wishes. A
   **separate** library from `suno_wish_library` on purpose - scene/imagery
   wishes ("больше драмы", "зимняя атмосфера") are a different domain from
   music/lyrics wishes, and are toggled per-project independently. Both share
   the same underlying `wish_library.add_or_get_wish`/`normalize_wish_library`
   helpers, parameterized by which settings key to read/write
   (`library_key='scene_wish_library'`).
3. `style_description` and a reference-image count note - the same
   `styleDescriptionLabel` field from the old combined stage, now living on
   the Scenes (text) stage since it feeds the LLM call; the reference images
   themselves are uploaded from the Images stage but still read from
   `project.reference_images` regardless of which stage's UI manages them.
4. The raw lyric lines (one per line, non-`interlude` blocks only - same
   `_lyric_lines` helper the old stub used) and a strict, code-appended
   instruction asking for exactly `scene_count` scenes as a ```` ```json ````
   array - this part is never user-editable, so a creative base prompt can
   never break parsing (mirrors `suno.py`'s appended `===STYLE===`/`===LYRICS===`
   footer being separate from the editable `suno_base_prompt`).

`scene_count` defaults to 10 (`scenes.DEFAULT_SCENE_COUNT`) and is a per-call
number picker on the Scenes stage, not a setting.

## Prompt translation

Every static/motion prompt (Scenes and Images stage) has a small "translate"
button (`TranslateButton.jsx`) next to its label. Clicking it opens a modal
and calls `POST /api/translate` (`routers/translate.py` → `providers/
translate.py`), which translates the prompt to Russian via the **Google
Cloud Translation API v2 (Basic)** - a plain `key`-authenticated REST
endpoint (same auth shape as the Gemini calls elsewhere in this app), picked
over reusing the already-configured Gemini/OpenRouter/DeepSeek chat models
because it's cheap-to-free at this app's volume (permanently free 500k
characters/month, then a well-known $20/1M) and dedicated - no prompt
engineering needed to get a clean translation back. It needs its own
`settings.api_keys.google_translate` (Settings → Providers): a plain Gemini
key usually isn't enabled for Cloud Translation, a separate GCP product/API.
The translation is a one-off preview only - never written back into the
project or fed into any generation prompt - so `POST /api/translate` is
project-independent and the result lives in the button's own component
state, not in any hook.

## Conventions and gotchas

- **Two implementations of lyrics formatting must stay in sync.**
  `_format_lyrics` in `suno.py` mirrors `formatLyrics` in `lyrics.js` (English
  type labels, `interlude` passed through raw). Change one, change the other.
  The same applies one level up: `_build_gemini_prompt` in `suno.py` mirrors
  `buildSunoPromptPreview` in `lib/sunoPrompt.js` (the Suno stage's "What will
  be sent" preview) — a change to how the base prompt/examples/skill prompt
  get joined, or to the `===STYLE===`/`===LYRICS===` footer, needs both sides
  updated or the preview silently stops matching what's actually sent.
- **Autosave race.** Storyboard and image generation replace `scenes`
  server-side from a fresh disk read, so a debounced `PATCH` scheduled earlier
  could land afterwards and revert them. `flushPendingSave()` in `useProjects`
  cancels the debounce and saves synchronously first — call it before any
  action that rewrites project state on the server.
- **Concurrent-save race (fixed).** Every project mutation follows
  `load_project` → change a field → `save_project`; two of those sequences
  overlapping — e.g. several background scene-image jobs (`images.py`'s
  `_run_job`) finishing around the same moment for different scenes of the
  same project — used to silently lose an update: whichever save landed
  second was built from a snapshot taken before the first save, so it
  overwrote the first job's change instead of merging with it (confirmed on a
  real project, 2026-08: 8 of 9 just-generated scene images vanished from
  `config.json` despite their files surviving untouched in `images/`).
  `storage.project_lock(slug)` is an `asyncio.Lock` per project slug — every
  load-mutate-save site that can run concurrently (`_run_job`, and
  `routers/generation.py`'s scene-image delete and reference-image
  upload/delete) now holds it for the whole sequence, so a second job's
  `load_project` can't start until the first one's `save_project` has landed.
  Unrelated projects still save fully concurrently, one lock per slug.
- **Project rename (redirect mechanism).** A project's folder name/`id` used
  to be permanently fixed at creation (`make_slug(author, title)`), even
  after editing `title`/`author` later — `routers/projects.py::patch_project`
  now renames the folder to match. The obvious risk: a background job
  (Mureka generation, scene images, …) that captured the *old* slug before a
  rename finishes and only saves its result 30-90s later would otherwise
  either write into a resurrected, orphaned old-name folder or crash — the
  same class of failure as the concurrent-save race above, just triggered by
  a rename instead of two overlapping jobs. Fixed with a redirect map
  (`app_data/projects/_redirects.json`, `storage.resolve_slug`) that
  `project_dir`/`project_lock` resolve first, so every caller — old slug or
  new — transparently lands on the current folder and shares the same lock.
  A second, sharper failure mode surfaced in live testing: slugs are
  content-derived (author+title), not permanently unique, so a project's
  *vacated* old slug can later coincide with a completely different,
  currently-real project's own address (e.g. two projects both left at
  default "Неизвестный автор"/"Новое стихотворение" values) — resolving
  that slug blindly would silently load/overwrite the unrelated project
  instead of leaving it alone. `resolve_slug` checks for a real
  `config.json` at the given slug *before* ever consulting the redirect
  map, so an existing project's own address always wins.
  See `data-model.md`'s "Project rename" for the on-disk shape.
- **Uploaded filenames are never trusted.** Reference images are stored as
  `ref_{uuid}.{ext}`, so there's no path-traversal surface.
- **i18n parity.** Every user-facing string goes in both `DICT.ru` and
  `DICT.en` in [`i18n/dict.js`](../frontend/src/i18n/dict.js).
- **URL import is best-effort.** `url_parser` uses generic heuristics
  (`<h1>`/`<title>`, author meta tags, first `<pre>`/`<article>`/`<main>` or
  the densest element). On pages without semantic markup it can drag in page
  chrome; there's no preview step, the expectation is "fix it in the Lyrics
  stage". A failed fetch falls back to an empty placeholder project.
- **`importance` on blocks is dead weight** — written for backward
  compatibility, never read.
- **Usage-ledger previews are just previews.** `prompt_preview`/
  `response_preview` in `app_data/usage/*.jsonl` are truncated to 300 chars
  and, for `suno_generate`, deliberately show the raw lyrics rather than the
  full assembled prompt (which is mostly boilerplate) — see
  [usage-tracking.md](usage-tracking.md). Don't treat the ledger as a full
  audit log of exact request/response bodies.
- **Every real provider call is timeout-bounded and console-logged.**
  `settings.request_timeout_seconds` (default 60, Settings → General) caps
  every outbound call in `suno.py`/`text_models.py` (a timeout is caught
  explicitly and surfaces as a clear "Таймаут: модель ... не ответила за N
  секунд" error, not a generic exception). Separately,
  [`console_log.py`](../backend/app/console_log.py) prints a colored,
  emoji-tagged start/result line for every real call to the backend's dev
  console (provider/model/kind on start; tokens/cost/duration on result,
  mirroring the usage-ledger row exactly) - purely cosmetic, never affects
  request behaviour or what gets billed. See
  [usage-tracking.md](usage-tracking.md) for both.
- **Most AI prices are not set by default.** `pricing.BUILTIN_PRICING`
  (`pricing.py`) only holds source-cited rows that were actually looked up
  (Google and OpenRouter are well covered since their full pricing/model
  pages were pasted in for verification; other providers only have a handful)
  — anything else has a cost total of `null`/"unknown" until a price is
  entered in Settings → Prices (by hand, or via the Prices tab's
  Export/Import round trip through an external pricing lookup); see
  [usage-tracking.md](usage-tracking.md). Translation calls are one instance
  of this by design: `pricing.py`'s row shapes only cover per-token (`text`)
  and per-image (`image`) billing, not Google Translate's per-character
  pricing, so a translate record's cost always reads "unknown" unless a
  manual override is entered for `google_translate:v2` in Settings → Prices.
- **A Konva `Stage` sized to fill a dynamic container needs its first size
  read synchronously, not just from `ResizeObserver`.** `ImageCropEditor.jsx`
  originally sized its `Stage` purely from a `ResizeObserver` callback on the
  container `div`; the observer's first callback isn't guaranteed to land in
  the same frame the component mounts (confirmed 2026-08: it never fired at
  all in one automated-browser environment, leaving `Stage` permanently
  `width=0 height=0` and nothing rendered, even though the container had a
  real on-screen size the whole time). Fixed by reading
  `containerRef.current.getBoundingClientRect()` synchronously in a
  `useLayoutEffect` on mount and keeping the `ResizeObserver` only for actual
  later resizes. Any future Konva editor that fills a container (not a fixed
  size, unlike `PosterConstructor.jsx`'s background-driven `stageW`/`stageH`)
  should follow the same pattern.

## Testing

```bash
npm test
```

Runs both suites. Individually: `npm run test --prefix frontend` (Vitest, covers
the pure `lib/` logic) and `pytest backend/tests` (slug, project CRUD against a
tmp `APP_DATA_DIR`, generation routes with the suno/scene seams mocked, the URL
parser against raw HTML with no network). The image and reference-image paths
run **unmocked** on purpose — they write real files, and that's the behavior
worth testing.
