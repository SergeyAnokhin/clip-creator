# Architecture

How Versecraft works. **Which file does what** is [code-map.md](code-map.md);
**JSON shapes and routes** are [data-model.md](data-model.md); **cost tracking**
is [usage-tracking.md](usage-tracking.md).

Two local processes, no database, no auth, single-user:

```text
┌───────────────┐   fetch /api/*   ┌─────────────────┐   read/write JSON   ┌───────────────┐
│ frontend/src  │ ───────────────► │ backend/app     │ ──────────────────► │ app_data/     │
│ (Vite, :5174) │ ◄─────────────── │ (FastAPI, :8020)│ ◄────────────────── │ (git-ignored) │
└───────────────┘      JSON        └─────────────────┘                     └───────────────┘
```

"Suno" in identifiers, routes and settings keys is a legacy name — the feature
targets any lyrics-to-music service; the UI calls it "Музыка/Music".

## Running

`npm run dev` starts both servers via `concurrently`. Vite defaults to port
**5174** (falls back to `$PORT`); the backend's CORS middleware allows any
`http://localhost:<port>` origin by regex, so a port change needs no edit.

`ffmpeg` must be a **system** binary on `PATH` (not a pip package) for the
Mureka reference-audio trimmer and the Editor stage's render. Both invoke it as
a blocking `subprocess.run` inside `asyncio.to_thread` — **not**
`asyncio.create_subprocess_exec`, which needs a Proactor loop that isn't
guaranteed under `uvicorn --reload` on Windows. Nothing checks for `ffmpeg` at
startup; the two features just fail with a clear error.

## The workflow

Nine stages inside one workflow screen:

```text
Lyrics → Music → Music gen → Scenes → Images → Title Card → Video → Export → Editor
blocks   style +  real audio  story-   images    poster text  animate  zip the   assemble
         lyrics   (Mureka)    board    per       over 4 refs  picked   deliver-  clips +
                              (text)   scene                  image    ables     audio
```

1. **Lyrics** — a poem (pasted or URL-parsed) split into blocks on blank lines,
   all typed `verse`, then retyped/reordered/split/cloned. Every operation is a
   pure function in `lib/lyrics.js`, so the stage needs nothing from the backend
   beyond the generic project `PATCH`.
2. **Music** (`stage: 'suno'`) — edit "Дополнения к промпту", optionally toggle
   reusable AI-wish cards, generate a `style` + `lyrics` pair. See "The music
   prompt".
3. **Music generation** (`stage: 'mureka'`) — the real counterpart: style +
   lyrics (seeded from stage 2, then freely editable — this *is* the "what goes
   to the model" preview) → the Mureka API. Tracks are rateable (0-5) and
   taggable with `settings.music_tags`; the one `is_selected` pick is set
   manually and deliberately **not** auto-promoted from the rating the way scene
   images are — quality and "the one I'll use" are independent judgments.
4. **Scenes** (`stage: 'scenes'`) — lyrics → `scene_count` scenes (default 10),
   each `{lyric_segment, scene_description, static_prompt, motion_prompt}`.
   `scene_description` is a short Russian caption shown in the card header so
   scenes can be scanned without reading the English prompt. `scene_mode` is
   `narrative` (scenes follow the lyrics' order, one continuous story) or
   `abstract` (variations on one mood, no plot). Text only.
5. **Images** (`stage: 'images'`) — per scene, generate variants (cheap/quality
   model-tier toggle) and rate them; the top-rated becomes the scene's main
   frame. Also owns the style-reference upload. The Scenes stage has a
   lightweight version (one cheap model, one button per scene) writing to the
   same `scenes[n].images` array and endpoint.
6. **Title Card** (`stage: 'title_card'`) — up to 4 scene images (or uploads) as
   style references plus a title/author text block, asked of a reference-capable
   image model: the text baked into the references' visual style, a typographic
   overlay rather than a full poster. First open auto-picks the 4 highest-rated
   images. The **Poster constructor** below the gallery turns one overlay into an
   actual poster.
7. **Video** (`stage: 'video'`) — each scene's picked image + `motion_prompt` →
   short clips. Unlike every other stage this shows **one scene at a time**
   (prev/next + jump strip). `scenes[n].videos[]` accumulates like `images[]`.
8. **Export** (`stage: 'export'`) — no generation, just bundling: every video
   candidate, the `is_selected` track, and every title-card variant marked
   `marked_for_export` (falling back to the `is_selected` one) into one zip
   (`GET .../final-export`). Separately, `GET .../video-export` hands off just
   source pictures + prompts for animating elsewhere, and
   `POST .../video-import-batch` brings the finished clips back in.
9. **Editor** (`stage: 'editor'`) — picked clips + picked track → one file via
   local `ffmpeg` (no external API). Laid out like a normal NLE: program monitor
   on top, a timeline underneath with a time ruler, clip blocks drawn to scale,
   the track's waveform on its own row and a playhead across both. Editing is
   direct manipulation — drag a block to reorder, drag its edges to trim, drag
   the ruler to scrub, the razor button (or `S`) to split the clip under the
   playhead, ctrl+wheel / the toolbar to zoom — with a properties strip for
   exact values. Still reorder/trim/split/speed only; no filters or transitions,
   though `project.video_edit` is shaped to grow them. **The timeline has no
   gaps**: clips are always concatenated back to back, so a horizontal drag
   means "reorder", not "move to this exact time". The in-browser preview never
   touches ffmpeg (a `<video>`+`<audio>` pair synced off a
   `requestAnimationFrame` playhead approximates the cut); only the server-side
   render is pixel-accurate. This stage is desktop-oriented by design: the
   layout itself adapts down to mobile/tablet widths, but the direct-manipulation
   gestures (drag, edge-trim) are mouse-only and intentionally not adapted for
   touch — a keyboard alternative (Tab to a clip, arrow keys between clips,
   Enter/Space to select) covers non-mouse desktop use instead.

Scenes and Images are two stages because they are two independent AI calls with
independent model choices — you can reroll a scene's images without re-running
the LLM call that wrote its prompt. Both share a `hideMotionPrompt` toggle (a
`settings.json` preference, not per-project) and a per-prompt translate button.

## Frontend state

One hook per domain in `src/hooks/`; `App.jsx` is only the composition root —
navigation, hooks called in dependency order, per-stage `{...state, actions}`
prop bundles. No state library, no context: every dependency is an explicit
argument, so the whole data flow reads off `App.jsx`.

Edits update local state immediately, then `PATCH` the **whole** project.
Text-field edits go through a 400 ms debounce.

One exception to "state belongs to the mounted stage": `useMiniPlayer.js` owns
the "now playing" track and renders its `<audio>` at the `App.jsx` top level,
outside every screen/stage conditional, so navigating away doesn't unmount it or
interrupt playback.

## Provider seams

Provider modules are the seam routers call without knowing whether the result is
real or canned. Keys come from `app_data/settings.json`.

```text
router  ──►  usage.context(task, project_id, settings)
             provider.generate / start_jobs(..., usage_ctx)
                  │  model = "{provider}:{model_id}" composite from settings
                  ├─ provider supported + key present ─► real HTTP call ─► usage.record(...)
                  └─ otherwise ────────────────────────► deterministic stub, debug.reason set
```

Two cross-cutting rules:

- **`settings.*_base_prompt` is a one-time seed, not a live default.**
  `get_settings` merges `DEFAULT_SETTINGS` *under* what's already in
  `settings.json`, and any `PUT /api/settings` writes the whole merged object
  back. Once a key has been written once, editing the
  `providers/*_prompt_defaults.py` constant has **no effect** on that install —
  the stored value must be edited (or re-saved from the UI) too.
- **`google_free`** is a second Google provider id wired everywhere `google` is
  (same models, same calls) but resolved against
  `settings.api_keys.google_free`. Read every "`provider` is `google`" below as
  "`google` or `google_free`". `pricing.py` aliases its price lookups to the
  `google:` row, but `usage._resolved_cost` forces `$0`/`source: 'free'` — a
  free-tier key really is free; the aliased price is kept as
  `cost.saved_amount`, informational only.

### Text — `suno.py`, `scenes.py`, `text_models.py`

`suno.generate` recomputes the raw structured lyrics from the project's
*current* blocks every time, then asks for a `===STYLE===`/`===LYRICS===`
-delimited reply. `scenes.generate` mirrors its shape deliberately (same
dispatch, timeout/usage/console wiring, same `debug` + usage summary) but asks
for a ```` ```json ```` array of exactly `scene_count` scene objects.

- Real call when `provider ∈ google|openrouter|deepseek` **and** the key is set;
  otherwise a deterministic stub with `debug.reason` = `no_model_selected` /
  `unsupported_provider` / `no_api_key`, shown verbatim in the debug panel.
- A **failure** (bad key, non-200, unparsable) is `HTTPException(502)`, never a
  silent stub fallback. A *successful* reply in the wrong format is tolerated
  instead: `suno` sets `debug.missing_markers` and returns an empty style;
  `scenes` falls back to stub scenes with the same flag (the stub leaves
  `scene_description` empty — no LLM call, nothing to summarize).
- `text_models.clean_wish_and_title` backs every wish save via
  `wish_library.add_or_get_wish`: one call both tidies the text and produces an
  emoji-prefixed title from a `===WISH===`/`===TITLE===` reply, using the global
  `settings.simple_models.default` (deliberately no per-screen picker). Dedups
  by exact text, and **never raises** — any failure degrades to the text
  unchanged plus a local truncate, since titling must not block saving a wish.

### Model catalogs — `text_models.py`, `image_models.py`, `video_models.py`

Back the Settings "refresh models" buttons; each provider is either a live
listing or a hardcoded curated list (a model id can always be typed by hand).

| Catalog | Live | Curated |
| --- | --- | --- |
| text | Google, OpenRouter, DeepSeek | Replicate, FAL — neither has a usable "list text models" endpoint |
| image | Google (`predict`-capable Imagen **plus** `generateContent` models whose id matches the Gemini "Nano Banana" shape `gemini-*-image` — id shape is the only signal, so `text_models` excludes the same ids); OpenRouter (`/models` filtered to `architecture.output_modalities` containing `'image'`, so new image models appear automatically) | Replicate, FAL, Krea (empty for DeepSeek). Krea has no discovery endpoint at all — each model is a fixed REST path, so its curated ids are real endpoint paths (`krea/krea-2/medium`) |
| video | Google (`predictLongRunning`-capable — the real Veo signal); OpenRouter (its dedicated `GET /api/v1/videos/models`) | none — only these two are wired; a failed call reports `source: 'error'` |

Krea is image/video-only: valid for image models, not text
(`_IMAGE_MODEL_PROVIDERS` vs `_MODEL_PROVIDERS` in `routers/settings.py`).

### Scene images — `images.py`

`start_jobs` fires one `asyncio.create_task` per variant and returns
`{job_ids}` **immediately**; `get_job` is polled every 1.5s. Job state is an
**in-memory dict** — an in-flight job is lost on backend restart. Google and
OpenRouter are single synchronous calls but still run through the job wrapper so
the frontend has one uniform poll contract.

| Provider | Submit | Result |
| --- | --- | --- |
| Krea | `POST api.krea.ai/generate/image/{model_id}` | poll `GET /jobs/{id}` → `result.urls[0]` |
| Replicate | `POST /v1/models/{owner}/{name}/predictions` (curated ids are bare `owner/name`; official models need no version hash) | poll `urls.get` → `output` |
| FAL | `POST queue.fal.run/{model_id}` | poll `status_url`, then `GET response_url` → `images[].url` |
| Google Imagen | `POST .../v1beta/models/{id}:predict` | synchronous, `predictions[].bytesBase64Encoded` |
| OpenRouter | `POST /api/v1/images` | synchronous, `data[].b64_json`; `usage.cost` is an exact price threaded through as `provider_cost` |

- **FAL's poll can reply HTTP `202`** while still queued, so only `>=400` is a
  transport error — the JSON `status` drives the loop. FAL moderation doesn't
  fail the request either (2xx with a blank image), so the sibling
  `has_nsfw_concepts` array is checked explicitly and turned into a `failed` job.
- **`_generate_google` only speaks Imagen's `:predict`.** Nano Banana answers
  through `:generateContent`, unwired here — picking one as the *direct* Google
  provider fails at generation time despite appearing in the picker; the same
  models via OpenRouter work.
- **`aspect_ratio`** (`1:1`/`16:9`/`9:16`; anything else means "don't send it")
  goes out in each provider's own shape: verbatim for Krea/Replicate/OpenRouter,
  `aspectRatio` for Google, an `image_size` enum for FAL. `stability-ai/sdxl`
  has no aspect field at all and is special-cased to explicit `width`/`height`.
- **A finished job persists itself** — the background task writes the file and
  does its own `load_project`/`save_project`, so the image is on disk and in
  `scenes[n].images` by the time a poll first says `completed`, whether or not
  anyone is polling. A failed job sets `status: 'failed'` with a Russian message,
  never a placeholder image. This widens the **autosave race** below: a job runs
  from ~1s (Google) to tens of seconds (Krea/Replicate/FAL).
- The prompt is the scene's `static_prompt` as-is; scene images send **no**
  reference images. `title_card.py` is the only image-to-image seam.
- **Upload** (`.../images/upload`, exactly one of `file` or `url`) appends with
  `model: 'upload'`, `cost: 0` so the rest of the UI treats it identically. The
  `url` is arbitrary user input, so `download_user_image_url` allows only
  `http(s)` to a resolvable **public** host (SSRF guard against
  private/loopback/link-local), doesn't follow redirects, requires `image/*`, and
  caps the stream at 15MB.
- **Crop / outpaint** (`crop_image`, scene images only): a selection fully inside
  the image is a free local PIL crop (`model: 'local:crop'`, cost 0); any
  overflowing side calls FAL's `fal-ai/flux-2-pro/outpaint` for exactly that
  expansion, then crops down to the requested box. Like remove-background it
  **appends** a new image with `source_image_id`, leaving the original untouched.
  Blocked past FAL's 2560px-per-side limit (`OutpaintTooLargeError` → `400`;
  missing project/scene/image → `404`). `quality` (default
  `settings.outpaint_quality_mode`) only matters on a **left**-side overflow:
  `'fast'` is one combined call; `'quality'` also mirrors the source, outpaints
  the mirrored copy's right edge (FLUX's reliably strong side) and mirrors back —
  so quality-mode left + top/bottom overflow can leave a faint corner seam.
  Priced per output megapixel directly onto `usage_out['cost']`, since
  `pricing.py` only models a flat per-image price.

### Scene videos — `video.py`

Genuinely image-to-video: one already-generated scene image (the `is_selected`
one, or an explicit `image_id`) plus `motion_prompt` and any active video wishes
(`video.build_prompt`). Same job/poll shape as `images.py` with its own `_jobs`
dict, but 6s poll and 600s timeout — generation runs for minutes. `count`
defaults to 1; `422` if the scene has no image to animate.

- **Google Veo**: `POST .../models/{id}:predictLongRunning` with the frame as
  `instances[0].image.inlineData`. Unlike Imagen this returns a long-running
  **operation resource name** polled at `GET .../v1beta/{operation_name}` until
  `done`; the resulting URI is Google-hosted and needs the same `key` query param
  to download. Veo 3.1 accepts `durationSeconds` only as the strings
  `"4"`/`"6"`/`"8"`, so `_nearest_google_duration` rounds to the closest. No cost
  in the response — priced off the catalog's `per_second` rate.
- **OpenRouter**: `POST /api/v1/videos` with `frame_images: [{..., frame_type:
  'first_frame'}]` (a `data:` URI works directly). Returns `202 {id, polling_url,
  status}`; poll until terminal, video at `unsigned_urls[0]` — which despite the
  name still 401s without the `Authorization: Bearer` header, so it's downloaded
  with those headers. The poll response's `usage.cost` becomes `provider_cost`.

`settings.video_models` is a single favorites list (no cheap/quality split), and
`settings.video_wish_library` is separate from `scene_wish_library`.

### Title card — `title_card.py`

Same job/poll shape as `images.py` (its own `_jobs` dict), but genuinely
**image-to-image**: the up-to-4 chosen references go out alongside the prompt,
after being validated to resolve inside the project folder and exist. Four
providers accept multiple references, each with its own `_GENERATORS` entry:

| Provider | References sent as |
| --- | --- |
| Google Gemini `generateContent` (Nano Banana, `gemini-*-image`) | one `inline_data` part each, ahead of the text part; `responseModalities: ['IMAGE']` + `imageConfig.aspectRatio`. This is where Nano Banana's multi-image capability is actually used — `images.py` can't reach it |
| Krea `google/nano-banana-pro` | `style_images: [{url, strength}]`, `url` a base64 data URI (no public hosting needed) |
| FAL `fal-ai/nano-banana/edit` | `image_urls` of base64 data URIs, ~14 max. **Only this one FAL id** supports references; any other curated FAL model fails the job with an explicit error |
| OpenRouter `/api/v1/images` | `input_references: [{type: 'image_url', image_url: {url}}]` |

Replicate is deliberately unwired here — its curated catalog has no
*multi*-reference model (`flux-kontext-pro` takes exactly one `input_image`), and
silently dropping references would be worse. It *is* used for background removal.

**Remove background** appends a transparent copy as a new variant
(`source_variant_id` back-pointer, original untouched) and is awaited directly by
the route — one call, so no job/poll round-trip. `method` is picked per click,
falling back to `settings.background_remover_method`; all three share the ledger
task `title_card_bg_remove`:

| `method` | Notes |
| --- | --- |
| `local` | Free pixel-threshold cutout, **flat solid black/white backgrounds only** (a pixel whose 3 RGB channels are all below `threshold`, or all above `255-threshold`, becomes transparent). Synthetic id `local:pixel-threshold`, hardcoded cost 0 |
| `fal` | `fal-ai/bria/background/remove` (cleaner, commercial license) or `fal-ai/imageutils/rembg` (softer). Same queue/poll as `_generate_fal` except the result is a single `image` object, not a list. Only bria is priced — rembg bills per-second, which the catalog can't express |
| `replicate` (default) | `851-labs/background-remover`, via the **versioned** `POST /v1/predictions` endpoint — unlike every other Replicate call here, because the shorthand `/v1/models/{owner}/{name}/predictions` route 404s for community (non-"official") models. `_resolve_bg_remover_version` caches `latest_version.id` once per process |

**Debug snapshots.** Every generator writes a redacted `{request, response}` into
`usage_out['debug']` — reference bytes and inline base64 results replaced with
`<... bytes>`, plain URLs kept — threaded onto the job record for the stage's
debug panel. `usage.record` takes this same `debug` dict app-wide and always
prints it via `console_log.log_debug` (strings over 100 chars truncated), not
only on failure.

### Music — `mureka.py`

**One job per generate click**, not one per variant: Mureka's `song/generate`
takes an `n` (1-3) and returns that many songs from one task, so `_run_job`
submits once, polls `GET /v1/song/query/{task_id}` every 3s (Mureka cites 30-90s
typical) until terminal, then materializes one `MurekaTrack` per `choices[]`
entry — all appended in a single load-mutate-save.

- Each `choices[].url` is downloaded to `music/{track_id}.mp3` **immediately** —
  Mureka's URLs expire after 30 days, unlike every other provider here. The full
  `choices[]` entry (incl. `flac_url`/`wav_url`/`lyrics_sections`, never fetched)
  is kept as `raw`.
- **Reference audio**: the upload route saves a local copy under
  `music/references/` **and** calls `files/upload` (`purpose=reference`; Mureka
  trims to exactly 30s) for a `mureka_file_id` usable as `reference_id`. Mureka
  hard-rejects reference audio under 30s, which is why raw uploads stage under
  `music/reference-sources/` and are cut with `ReferenceAudioTrimmer.jsx` first.
  Deleting removes the local file and library entry only — Mureka has no
  delete-file endpoint.
- Rating, tagging and `is_selected` have **no dedicated route**: the frontend
  recomputes the whole `project.mureka.tracks` array and sends it through the
  generic `PATCH /api/projects/{id}`, same convention as scene-image rating.
- **No `pricing.py` row exists for `mureka:*`** — Mureka reports no per-call
  cost, so these resolve to `cost.amount: null`/`'unknown'` rather than a guess.

## Poster constructor

"Assemble poster" (below the Title Card gallery) opens a `react-konva` editor
compositing a background (any scene/reference image), one title-card variant
(typically background-removed) and an optional logo into a draggable/resizable
layout, flattened to PNG **client-side** (`stage.toBlob()`, no server-side image
library) and saved as a `project.title_card.posters[]` entry. Behavior spans
`PosterConstructor.jsx` (modal, layer state, undo/redo, zoom, templates, save),
`PosterCanvasLayers.jsx` (overlay node types), `PosterPanels.jsx` (side panels)
and `lib/posterLayers.js` (pure factories and math). Full data shape in
[data-model.md](data-model.md).

- **Re-editable saves.** The layer transforms are stored alongside the flattened
  PNG, so "Edit" reopens the exact arrangement; re-saving with the same
  `poster_id` re-renders in place (same `file_path`, so `<img>` tags append
  `?v=generated_at` to defeat the browser cache).
- **`title_card` and `logo` are arrays.** "Дублировать" clones a layer so one
  source image can appear several times with different crops — how a single
  render (headline + author in one PNG) gets split into independently placed
  pieces. `normalizeLayers` wraps the older single-object shape on load.
- **Crop mode** swaps `OverlayImage`'s whole-layer Transformer for a resize-only
  one with all 8 anchors, drawn over a dimmed full-resolution copy so parts
  outside the crop stay visible to crop back in. The ghost and the crop rect
  share the Konva name `crop-editor` so `handleSave` can hide them in one call —
  nothing from crop mode may leak into a saved PNG even if the user saves without
  clicking "Готово".
- **Effects** per layer: **opacity**, **glow** (a Konva shadow on the overlay
  itself, so it follows the image's own alpha shape), and **clone** — a second
  copy behind the real one for cheap fake depth, rendered with the same glow plus
  its own opacity and optional blur (`useCloneBlur` `.cache()`s only once
  `clone.blur > 0`, keeping the common no-blur case crisp). A single Konva shadow
  pass caps out at 100% (`shadowOpacity` composites into the shadow color's
  alpha, which the canvas clamps to 1), so `glowPasses()` turns any
  `glow.opacity > 1` (stored 0-5) into up to 5 stacked passes — at the cost of
  redrawing the layer's fill each pass, so a very transparent layer with a maxed
  glow reads slightly more solid than its opacity implies.
- **Glass panel** — one standalone rounded rect, max one instance. Its live
  preview is a cheap simulation (white-tinted `Rect` + edge-highlight stroke);
  redrawing a real blurred backdrop every drag frame would be too slow. At save
  time `handleSave` hides the glass node, rasterizes the rest of the stage,
  samples and blurs the region under its (possibly rotated) bounds with plain
  Canvas2D (`buildHqGlassCanvas`), re-tints/clips/borders it, swaps it in as a
  temporary `Konva.Image`, flattens, then reverts the stage to its live state.
- **Text layers** (`OverlayText`, same drag/select skeleton as `OverlayImage`
  minus crop): `badge` (black pill behind white text, Forum) and `halo` (bare
  text with a drop-shadow halo, Montserrat), reusing `effects.glow` since Konva
  `Text` exposes the same `shadow*` props as `Image`. Defaults come from the
  stage's `text_block` (`parseTextBlock`: `halo` → title, `badge` → author).
  `FONT_OPTIONS` is limited to families verified against the raw Google Fonts
  `css2` response to ship **cyrillic** glyphs, since poster text is typically
  Russian — Lato does not, and is kept only for latin content, never as a
  default. The badge pill auto-sizes to the rendered text, re-measured once on
  `document.fonts.ready` in case the first paint raced the font `<link>`. Konva
  honors `align` only with an explicit `width`, so the node gets the measured
  natural width plus `wrap="none"`.
- **Undo/redo** goes through one choke point, `commit(mutate)`: it pushes the
  pre-mutation snapshot onto `past` (clearing `future`), **unless the previous
  commit landed under 400ms ago**, in which case it coalesces — this is what
  stops one slider or text drag (which calls `commit` per tick) from flooding
  history. Every mutating action routes through it. The `Ctrl/Cmd+Z`/`+Y`
  listener ignores events while focus is in an `INPUT`/`TEXTAREA`/
  `contentEditable`, so native undo in a text field isn't hijacked.
- **Center-snap guides.** `snapGroupToCenter` (from each overlay's `onDragMove`)
  mutates the node's position **directly in Konva**, not through React state, so
  there's no re-render per drag frame; only the two guide-line visibility flags
  are state. Dragging only, not resize or rotate.
- **Zoom / export fidelity.** The Stage is padded with an overflow margin beyond
  the poster bounds so an overlay dragged past the edge stays visible;
  `handleSave` crops it back out so the export is exactly `canvas_size`.
  Interactive zoom (button row + cursor-anchored wheel) is a `zoom` multiplier
  and `stagePos` offset over the auto-fit scale, both reset whenever the
  background or fullscreen state changes. `handleSave` briefly restores the
  neutral fit-scale/origin before capturing — the crop/margin math assumes
  exactly that — so the export never depends on the current view. The Stage is
  deliberately **not** draggable and the background layer is
  `listening={false}`: the background can't be moved at all, by design.
- **Templates.** `settings.poster_templates` stores a reusable
  `{logo_id, logo[], glass, text[]}` — deliberately **not** the background,
  title-card variant or `title_card` layers, which are specific to the poem this
  poster is for. No files involved, so it's plain array CRUD through the ordinary
  partial-merge `PUT /api/settings`. `applyTemplate` regenerates a fresh `id` on
  every applied logo/text layer, so copies stay independently editable from the
  template and from each other.
- **Logos** are a **global**, cross-project library (`settings.logos`, files
  under `app_data/logos/`, served through the same `/media` mount as project
  files), managed from Settings → Logos, PNG/WebP only.

## Magic layers

The inverse of the poster constructor: instead of composing layers into one flat
PNG, one flat image is decomposed back into N independent RGBA layers, each
already carrying painted content behind whatever used to cover it — so moving a
layer never leaves a hole. Backend seam is
[`providers/magic_layers.py`](../backend/app/providers/magic_layers.py) +
[`routers/magic_layers.py`](../backend/app/routers/magic_layers.py); frontend is
`hooks/useMagicLayers.js`, the shared `MagicLayersButton.jsx` (the ✨ button and
its method popup), `MagicLayersPreviewModal.jsx` (the test sandbox, see below)
and the poster constructor's `magic` layer kind. Data shape in
[data-model.md](data-model.md).

```
scene image / title-card variant
        │  ✨  (method + layer count picked per click)
        ▼
POST /magic-layers ──► job ──► Qwen-Image-Layered (fal | replicate)
        │                            │  N RGBA layers, smaller than the source
        │                            ▼
        │                      _postprocess: upscale → re-take foreground RGB
        │                      from the full-res original through the upscaled
        │                      alpha → detect background → drop empty layers
        ▼
project.magic_layer_groups[] + magic/{group_id}/L{n}.png
        │
        ├─ ✨N badge (Images stage / Title Card gallery)
        │      ▼
        │  MagicLayersPreviewModal — drag-to-test sandbox, nothing persisted
        │
        ▼  "Применить" in the poster constructor
N draggable magic layers (bottom-to-top), the flat original hidden underneath
```

- **One model, two hosts.** `fal-ai/qwen-image-layered` ($0.05/call) and
  `qwen/qwen-image-layered` on Replicate (~$0.03) run the same Apache-2.0 model
  (arxiv 2512.15603). The method is passed **per click** (like background
  removal), with `settings.magic_layers_method` only as the fallback.
- **Async job + poll**, not a synchronous route: a decomposition takes 15-30s.
  Same in-memory `_jobs` dict / `start_job` / `get_job` shape as `title_card.py`;
  the group is written to disk and persisted before the job flips to `completed`.
  The poll deadline differs per host: **300s for Replicate**, **600s for FAL**
  (`_JOB_TIMEOUT` / `_FAL_JOB_TIMEOUT` in `magic_layers.py`) — FAL's queue was
  observed to run past 300s under load (2026-08-15: a real decomposition timed
  out at 304.8s while the Replicate retry of the same image finished in 20s),
  so only its ceiling was raised rather than both.
- **The model guarantees neither ordering nor resolution**, and `_postprocess`
  (a pure, separately tested function) compensates for both: the background is
  detected as the layer with the largest opaque area rather than trusting index
  0, and every layer is upscaled to the source's exact size — RGB with LANCZOS,
  **alpha with BILINEAR**, because LANCZOS ringing on an alpha channel reads as
  holes inside an object and a halo outside it. Foreground layers then take their
  RGB from the full-resolution original through that alpha, so objects stay
  pixel-sharp; only the inpainted background plate is limited by the model's
  ~640/1024px working resolution, and it is only ever visible where an object
  moved away.
- **Groups are project-level**, not attached to the image they came from
  (`project.magic_layer_groups[]`, files under `magic/{group_id}/`), so one
  decomposition is reusable by every poster. All three entry points — the Images
  stage carousel, the Title Card gallery, and the constructor's own panel —
  address a group by its `source_path`.
- **Testing a split before committing to a poster**: once a group exists, the
  Images stage carousel and the Title Card gallery show a clickable `✨N`
  badge (`.magic-layer-badge`, previously just a static counter) over the
  source image. Clicking it opens `MagicLayersPreviewModal.jsx` — a Konva
  `Stage` sandbox where every layer can be dragged, hidden/shown, and reset,
  with a live `x, y` offset readout per layer. It deliberately shares nothing
  with `OverlayImage`/`MagicLayerNode` (no crop, effects, or Transformer) and
  never writes anywhere — closing it discards every offset, so it is purely a
  "did this separate cleanly, with no holes or bleed" check before spending a
  poster slot on the group. `posterLayers.js`'s `bestMagicLayerGroup` picks
  which group the badge/modal shows when one source has been decomposed more
  than once (most layers, ties broken by recency).
- **In the constructor**, magic layers are their own layer kind rendered as one
  ordered block right after the background (bg → **magic** → glass → title card →
  logo → text), reordered within the block by ↑/↓. Everything else — drag,
  transform, crop, effects — is the existing `OverlayImage`; only image loading
  is new (`MagicLayerNode` exists so each layer can call `useHtmlImage` for its
  own file, which a loop can't do).
- **Applying a group hides the flat original** it was made from
  (`hide_background` / `hide_title_card`, both part of the poster document and of
  undo/redo) — otherwise the untouched picture shows through the moment a layer
  is moved, which is the exact hole this feature removes. The background image
  stays *loaded* either way: `canvas_size` and the export `pixelRatio` come from
  its natural size. Switching background or title-card variant drops the magic
  layers, since they are slices of the previous source.
- **Not managed:** `num_layers` asks for a count, not for specific objects.
  Heavily overlapping objects can fuse into one layer and shadows tend to stay on
  the background. Prompt-driven extraction of one named object would need a
  different pipeline (SAM 3 + an eraser model) and is deliberately not built.

## AI usage & cost tracking

Every provider call is recorded to an append-only ledger at
`app_data/usage/YYYY-MM.jsonl` with unit counts and a computed cost (from a
price catalog, or the provider's own reported cost when it has one). A Usage
screen and a spend pill in every header read it back through `GET /api/usage/*`;
model pickers show a price hint from `GET /api/usage/pricing`. Full detail in
[usage-tracking.md](usage-tracking.md). Two rules shape the seams above:
**errors are recorded too** (a failed call may still have been billed), and a
**catalog-priced record's cost is recomputed on every read**, so correcting a
placeholder price retroactively fixes history.

## Voice input (speech-to-text)

Dictation uses the browser's native **Web Speech API** — no backend call, no
library. All of it is in `useVoice.js`, wired last in `App.jsx` (it writes into
the Suno refinement box and the Scenes wish box, so it depends on both).

- **Feature detection, not a polyfill**: a module-level check on
  `window.SpeechRecognition || window.webkitSpeechRecognition`, threaded down as
  `voiceSupported`; mic buttons simply don't render when false — no error, no
  fallback UI.
- **One global recorder** (`recordingKind`/`recordingTarget`); a mic click starts
  recognition or `.stop()`s the running one. `recordingSeconds` only drives the
  banner — `continuous` is left `false`, so the browser ends recognition when the
  user stops talking. Cleanup `.stop()`s on unmount, so navigating away never
  leaves a live mic.
- **Language** comes from `settings.lang`, mapped to BCP-47 (`ru-RU`/`en-US`,
  default `en-US`) — no BCP-47 value is stored anywhere in settings.
- **Results** are spliced into the target through the caller's own callback and
  never stored in the hook, so fields stay ordinary controlled components.
  **Errors** split three ways in `onerror` — `'not-allowed'`, `'no-speech'`,
  everything else — each with its own toast.
- **`useFieldVoice`** (same file) is the `project`-independent sibling for
  standalone fields (Settings → Wishes), keyed by a caller-chosen `fieldId` and
  handing the transcript back via `onTranscript` so the caller decides whether to
  replace or append.

**Adding voice to a new field**: gate the mic button on `voiceSupported`, wire
`onClick` to `startVoice(kind, target)` (a new `kind` needs a branch in
`applyTranscript`), and render the `isRecording`/`recordingSeconds` state the
stage already receives. Reach for this only on free-form text a user would
plausibly *say out loud* — never URLs, API keys or titles.

## The music prompt

Four layers concatenated in this order by `suno._build_gemini_prompt`:

1. **`settings.suno_base_prompt`** — "how to adapt lyrics/style for this
   service", seeded from `suno_prompt_defaults.py` and written for Suno v5.5
   conventions. `GET /api/settings/suno-prompt-presets` serves read-only
   built-ins (`SUNO_BASE_PROMPT_PRESETS` + `MUREKA_BASE_PROMPT_PRESETS`) merged
   with the user's own `*_base_prompt_user_presets`; each is `{id, service, name,
   description, prompt}`, `service` being the group label the UI renders
   (`lib/sunoPrompt.js`'s `groupPresetsByService`). **Any new preset must still
   emit the `STYLE-BLOCK`/`LYRICS-MARKUP` headers** the response footer expects.
   Loading a preset overwrites the single shared field — it's an A/B flow, not
   two coexisting prompts.
2. **Active wishes** — the text of every `settings.suno_wish_library` entry whose
   id is in `project.active_wish_ids`, as one numbered block headed "ВАЖНЫЕ
   ТРЕБОВАНИЯ ПОЛЬЗОВАТЕЛЯ — обязательно учесть:" right after the base prompt.
   There's no attention-weight knob on the API, so a clearly marked, prominently
   placed block *is* the emphasis mechanism. Omitted entirely when nothing is
   active.
3. **`settings.suno_reference_examples`** — curated finished style+lyrics
   examples sent as "reference, don't copy verbatim". Click-to-edit in Settings
   like `settings.special_tags` (clicking a row loads it into the add field);
   both lists persist only via the Settings screen's own save button, unlike the
   wish library.
4. **`project.skill_prompt`** — the per-song "Дополнения к промпту", seeded from
   a fixed template at project creation. Nothing is folded into it automatically.

`settings.suno_wish_library` is a global list of reusable wish cards, not tied to
a project. Typing text and clicking "Применить" calls
`POST /api/projects/{id}/suno/wishes`, which cleans+titles it (or reuses an
identical card) *and* activates it here; clicking an existing card just toggles
it for this project via a plain `PATCH`, no LLM call. The same card can be active
for one song and inactive for another — that's the point of separating cards
from activation. Cards are also editable from Settings → Wishes.

All four layers, the raw lyrics and the appended response-format footer are
visible **on the Suno stage before generating**: a "Базовый промпт" panel edits
layer 1 directly (autosaving via its own debounced `PUT /api/settings`, separate
from the Settings screen's field, which persists only on its save button), and a
"Что уйдёт в модель" panel shows the assembled text plus a rough input-token/cost
estimate. `lib/sunoPrompt.js`'s `buildSunoPromptPreview` mirrors
`_build_gemini_prompt` client-side (**keep both in sync**), and
`lib/pricing.js`'s `estimateTokensFromChars` mirrors the backend's chars/4
heuristic — both are ex-ante UI estimates, never the truth about what a call
cost. The model the preview prices against, and that "Generate" uses, is a
session-only `ModelPicker` seeded from `text_models.default`.

`project.refinement_comments` still exists for backward compatibility but is
unused — it was the wish history under the removed `suno/refine` flow. Projects
predating the rework get it and `skill_prompt` reset once on first load
(`projects.py::migrate_legacy_project`, keyed off the *absence* of
`active_wish_ids`).

## The scene prompt

Mirrors the music prompt, adapted for Scenes (`scenes._build_prompt`):

1. **`settings.scene_base_prompt_narrative` / `_abstract`** — one per
   `scene_mode`, picked by the stage's toggle, seeded from
   `scenes_prompt_defaults.py` (weighted `((main objects))`/`(secondary
   objects)` English phrasing, chorus-first focus, ~700-1000+ chars).
   `narrative` adds a constraint `abstract` doesn't have: scenes must follow the
   lyrics' order and carry a visible thread — character, setting, light — from
   first scene to last. Editable in Settings or in the stage's own panel, each
   autosaving.
2. **Active scene wishes** — `settings.scene_wish_library` entries in
   `project.active_scene_wish_ids`, in the same "ВАЖНЫЕ ТРЕБОВАНИЯ" block. A
   **separate** library from `suno_wish_library` on purpose, sharing the same
   `wish_library` helpers parameterized by `library_key`.
3. **`style_description`** plus a reference-image count note — the field lives on
   the Scenes stage since it feeds this call, though the reference images are
   uploaded from the Images stage.
4. **The raw lyric lines** (non-`interlude` blocks only) and a strict,
   **code-appended** instruction asking for exactly `scene_count` scenes as a
   ```` ```json ```` array. Never user-editable, so a creative base prompt can't
   break parsing — same separation as `suno.py`'s appended footer.

`scene_count` defaults to 10 and is a per-call picker, not a setting.

## Prompt translation

Every static/motion prompt has a translate button opening a modal that calls
`POST /api/translate` → the **Google Cloud Translation API v2 (Basic)**, a plain
`key`-authenticated REST endpoint. Chosen over the configured chat models because
it's free-to-cheap at this volume (500k chars/month free) and needs no prompt
engineering. It needs its **own** `settings.api_keys.google_translate` — a plain
Gemini key usually isn't enabled for Cloud Translation, a separate GCP product.
The result is a one-off preview: never written back into the project, never fed
into a generation prompt, so the route is project-independent and the result
lives in the button's own component state.

## Conventions and gotchas

- **Two implementations of lyrics formatting must stay in sync.**
  `_format_lyrics` in `suno.py` mirrors `formatLyrics` in `lib/lyrics.js`
  (English type labels, `interlude` passed through raw). One level up,
  `_build_gemini_prompt` mirrors `buildSunoPromptPreview` in `lib/sunoPrompt.js`
  — change how layers are joined, or the `===STYLE===`/`===LYRICS===` footer, and
  both sides need updating or the preview silently stops matching what's sent.
- **`MUSIC_TAG_COLORS` must stay in sync** — the palette in
  `routers/settings.py` is mirrored in `frontend/src/lib/musicTagColors.js`.
- **Autosave race.** Storyboard and image generation replace `scenes`
  server-side from a fresh disk read, so a debounced `PATCH` scheduled earlier
  can land afterwards and revert them. `flushPendingSave()` in `useProjects`
  cancels the debounce and saves synchronously — call it before any action that
  rewrites project state on the server.
- **Concurrent-save lock.** Every mutation is `load_project` → change →
  `save_project`; two overlapping sequences (several background image jobs
  finishing at once) used to lose whichever update was built from the older
  snapshot. `storage.project_lock(slug)` is an `asyncio.Lock` per slug, held for
  the whole sequence by every site that can run concurrently (`images._run_job`,
  scene-image delete, reference-image upload/delete). Unrelated projects still
  save fully in parallel.
- **Project rename uses a redirect map.** Editing `title`/`author` renames the
  folder and `id`, so a background job holding the *old* slug would otherwise
  resurrect an orphaned folder or crash. `app_data/projects/_redirects.json` +
  `storage.resolve_slug` (used by `project_dir`/`project_lock`) make old and new
  slugs land on the same folder and share one lock. **`resolve_slug` checks for a
  real `config.json` at the given slug before consulting the map** — slugs are
  content-derived and not permanently unique, so a vacated old slug can later be
  a different project's own real address; an existing project's address always
  wins.
- **Uploaded filenames are never trusted** — reference images are stored as
  `ref_{uuid}.{ext}`, so there's no path-traversal surface.
- **i18n parity.** Every user-facing string goes in both `DICT.ru` and `DICT.en`
  in `i18n/dict.js`.
- **URL import is best-effort.** `url_parser` uses generic heuristics
  (`<h1>`/`<title>`, author meta tags, first `<pre>`/`<article>`/`<main>` or the
  densest element); on pages without semantic markup it drags in page chrome.
  There's no preview step — the expectation is "fix it in the Lyrics stage". A
  failed fetch falls back to an empty placeholder project.
- **`importance` on blocks is dead weight** — written for backward
  compatibility, never read.
- **Usage-ledger previews are just previews** — truncated to 300 chars and, for
  `suno_generate`, deliberately the raw lyrics rather than the mostly-boilerplate
  assembled prompt. Don't treat the ledger as an audit log of exact request
  bodies.
- **Every real provider call is timeout-bounded and console-logged.**
  `settings.request_timeout_seconds` (default 60) caps every outbound call in
  `suno.py`/`scenes.py`/`text_models.py`; a timeout is caught explicitly and
  surfaces as "Таймаут: модель ... не ответила за N секунд". `console_log.py`
  prints a colored start/result line per real call — cosmetic only, never affects
  request behavior.
- **Most AI prices are not set by default.** `pricing.BUILTIN_PRICING` holds only
  source-cited rows actually looked up (Google and OpenRouter are well covered;
  other providers have a handful); everything else reads "unknown" until priced
  in Settings → Prices. Translation is unpriceable by design — `pricing.py` row
  shapes cover per-token and per-image billing, not per-character.
- **A Konva `Stage` filling a dynamic container needs its first size read
  synchronously.** `ResizeObserver`'s first callback isn't guaranteed to land in
  the mount frame (it has failed to fire at all in an automated browser, leaving
  the Stage permanently 0×0). `ImageCropEditor.jsx` reads
  `getBoundingClientRect()` in a `useLayoutEffect` on mount and keeps the
  observer only for later resizes. Any future container-filling Konva editor
  should do the same — `PosterConstructor.jsx` is exempt, its size is
  background-driven.

## Testing

```bash
npm test
```

Runs both suites. Individually: `npm run test --prefix frontend` (Vitest, the
pure `lib/` logic) and `pytest backend/tests` (slug, project CRUD against a tmp
`APP_DATA_DIR`, generation routes with the provider seams mocked, the URL parser
against raw HTML with no network). The image and reference-image paths run
**unmocked** on purpose — they write real files, and that's the behavior worth
testing.
