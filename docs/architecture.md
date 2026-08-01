# Architecture

Versecraft is a two-process local app: a React (Vite) frontend talks over HTTP
to a FastAPI backend, which persists everything as JSON files on disk. There is
no database and no auth — it's single-user. Scene-text generation (the
storyboard split into scenes) is still **stubbed**; Suno text generation and
scene *image* generation both make **real** provider calls (see below).

```text
┌───────────────┐   fetch /api/*   ┌─────────────────┐   read/write JSON   ┌───────────────┐
│ frontend/src  │ ───────────────► │ backend/app     │ ──────────────────► │ app_data/     │
│ (Vite, :5174) │ ◄─────────────── │ (FastAPI, :8000)│ ◄────────────────── │ (git-ignored) │
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

## The workflow

A project moves through three stages, all inside one workflow screen:

```text
Lyrics  →  Suno  →  Scenes
blocks     style +   storyboard +
           lyrics    images per scene
```

1. **Lyrics** — a poem (pasted text or a parsed URL) is split into blocks on
   blank lines, all typed `verse`. The user retypes, reorders, splits, and
   clones blocks until the structure is right. Every operation is a pure
   function in [`lib/lyrics.js`](../frontend/src/lib/lyrics.js), so the stage
   never needs anything from the backend beyond the generic project `PATCH`.
2. **Suno** — pick a *skill* (an instruction template, defined in `SKILLS` in
   `SunoStage.jsx`), optionally refine it with a free-text wish, then generate
   a `style` + `lyrics` pair to paste into Suno.
3. **Scenes** — turn the lyrics into a storyboard (default 5 scenes), generate
   image variants per scene, and rate them; the top-rated variant becomes the
   scene's main frame.

## Frontend state

State lives in [`src/hooks/`](../frontend/src/hooks/), one hook per domain
(toast, viewport, settings, projects, the three stages, voice).
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
[`scenes.py`](../backend/app/providers/scenes.py) and
[`images.py`](../backend/app/providers/images.py) are the seams routers call
without knowing whether the result is canned or real. Keys come from
`app_data/settings.json`.

- `suno.generate` recomputes the raw structured lyrics from the project's
  *current* blocks every time (so Lyrics-stage edits always show up), then:
  - `model` is the composite `"{provider}:{model_id}"` string from
    `settings.text_models.default` (see `data-model.md`). If `provider ==
    'google'` **and** `settings.api_keys.google` is set, it calls the real
    Gemini API (`generativelanguage.googleapis.com`, using `model_id` from
    the composite) with a prompt assembled from `settings.suno_base_prompt` +
    `settings.suno_reference_examples` + the project's `skill_prompt` (skill
    template + folded-in refinement wishes), asking for a `===STYLE===` /
    `===LYRICS===`-delimited reply that `_parse_gemini_response` splits into
    `{style, lyrics}`.
  - otherwise (no key, or any other provider) it falls back to the old
    deterministic stub: `lyrics` = the formatted blocks, `style` = a canned
    string. This keeps tests and no-key setups working unchanged, and is also
    the current (documented) limitation for Replicate/FAL/OpenRouter as Suno
    text-generation providers — only Google is really wired.
  - `refine` stays a **local, no-network** string concatenation — the user's
    "wish" is folded into `skill_prompt` there, and only actually reaches an
    LLM the next time `generate` runs.
  - a generation failure (bad key, non-200, unparsable Gemini reply) is
    surfaced by the router as `HTTPException(502, ...)`, not a silent stub
    fallback — see [`routers/generation.py`](../backend/app/routers/generation.py).
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
- `text_models.generate_wish_title(text, settings)` backs the wish-library
  auto-title (`POST /api/settings/wish-library`): if `settings.simple_models
  .default` (or the request's own `model`, if the "Save to library" model
  picker in `SunoStage.jsx` was used to override it for that one save - see
  `routers/settings.py::add_wish`, which applies the override to a throwaway
  settings copy so it never overwrites the real default) points at Google,
  OpenRouter or DeepSeek with a key configured, it asks that model for a
  short title (DeepSeek and OpenRouter both use the same OpenAI-compatible
  `/chat/completions` shape); otherwise (no default set, unsupported
  provider, missing key, or any API failure) it falls back to a local
  truncate of the wish text. Never raises — title generation must not block
  saving a wish.
- `image_models.list_models(provider, api_key)` backs the Settings image-model
  "refresh models" button (`GET /api/settings/image-models/{provider}`),
  mirroring `text_models.list_models`'s shape and split:
  - Google is a **live** call to the same "list models" endpoint as
    `text_models`, filtered to `predict`-capable (Imagen) models instead of
    `generateContent`-capable ones.
  - Replicate, FAL, OpenRouter, DeepSeek and Krea return a curated
    `CURATED_IMAGE_MODELS` list (empty for OpenRouter and DeepSeek, neither
    of which route image models). Krea
    (krea.ai) has no model-discovery endpoint at all — each model is its own
    fixed REST path (`POST /generate/image/{id}` against `api.krea.ai`,
    async job + `GET /jobs/{id}` polling), confirmed against
    `docs.krea.ai` — so its curated list uses those real endpoint-path IDs
    (e.g. `krea/krea-2/medium`, `bfl/flux-1-dev`). Krea is image/video-only,
    so it's a valid `provider` for `/settings/image-models/{provider}` but
    not for `/settings/models/{provider}` (text models) — see
    `_IMAGE_MODEL_PROVIDERS` in `routers/settings.py`.
  - `settings.image_models.favorites` back a real per-generation `ModelPicker`
    in `ScenesStage.jsx` (seeded from `.default`, overridable per screen -
    see `code-map.md`'s `ModelPicker.jsx` row), and the chosen composite is
    what actually reaches `images.start_jobs` as `model` today.
- `scenes.generate` chunks the non-`interlude` lines into `scene_count` even,
  ordered pieces and derives canned prompts from each chunk's first line. It
  also accepts a `model` composite (from `settings.text_models`, via another
  `ModelPicker` next to "Generate storyboard" in `ScenesStage.jsx`) - but
  unlike the image one, it does nothing with it yet, since there's no real
  LLM call here to route it to. It's threaded through router → provider
  anyway (same seam pattern as `images.py`) so the frontend already has a
  working picker once a real scene-text LLM call is wired in.
- `images.start_jobs`/`get_job` is the **real seam** for scene images —
  Krea, Replicate, FAL and Google Imagen, dispatched from the `provider` half
  of the `model` composite. It's structured as background jobs rather than a
  single blocking call because Krea/Replicate/FAL are all async-job APIs
  (submit → poll until done), unlike `suno.py`'s single request/response
  Gemini call:
  - `POST /api/projects/{id}/scenes/{n}/images` (`{count, model}`) calls
    `images.start_jobs`, which fires one `asyncio.create_task` per requested
    variant and returns their `job_id`s **immediately** (`{job_ids: [...]}`)
    instead of blocking the request for the whole generation.
  - `GET /api/projects/{id}/scenes/{n}/images/jobs/{job_id}` (backed by
    `images.get_job`) is polled by the frontend (`pollImageJob` in
    `useScenesStage.js`, every 1.5s) until `status` is `completed` or
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
    `GET response_url` for `images[].url`. **Google Imagen**
    `POST .../v1beta/models/{model_id}:predict` (same host as `suno.py`'s
    Gemini call) → `{predictions: [{bytesBase64Encoded, mimeType}]}` — no
    job/polling, it's a single synchronous call, but it still runs through
    the same background-job wrapper as the other three so the frontend has
    one uniform poll contract regardless of provider.
  - A job's background task, on success, downloads/decodes the image bytes,
    writes them to `images/scene_{n}_{shorthex}.{png|jpg|webp}` (extension
    from the URL or the response's content-type/mimeType), and **persists
    directly onto the project** (fresh `load_project`/`save_project`, same as
    every other generation route) — the image is on disk and in
    `project.scenes[n].images` by the time a poll first reports `completed`,
    independent of whether the frontend is still polling.
  - A job's background task, on failure (missing API key, non-2xx response,
    unexpected shape, provider-reported failure/timeout), sets `status:
    'failed'` with a Russian `error` string — no silent fallback, matching
    `suno.py`'s philosophy that a real-provider failure must be visible
    rather than quietly serving a placeholder.
  - The prompt sent to every provider is the scene's `static_prompt` as-is;
    `reference_images` are **not** sent to any provider yet (no image-to-image
    conditioning) — adding that would need per-provider research into their
    image-input parameters, which wasn't done here.
  - Widens the existing "autosave race" gotcha below: a job can take anywhere
    from ~1s (Google) to tens of seconds (Krea/Replicate/FAL polling), so the
    window in which an unrelated debounced `PATCH` could revert the job's
    just-written `scenes[n].images` is longer than it was for the old
    synchronous stub.

Not implemented at all: image-to-image conditioning from `reference_images`.

## AI usage & cost tracking

Every provider call above (Suno generation, wish-title completion, scene
image generation) is recorded to an append-only ledger at
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
last (it writes into the Suno refinement box, so it depends on `suno`).

- **Feature detection, not a polyfill.** `isVoiceInputSupported` is a
  module-level `!!(window.SpeechRecognition || window.webkitSpeechRecognition)`
  check. `useVoice` exposes it as `isSupported`; `App.jsx` forwards it to each
  stage as `voiceSupported`, and the three mic buttons
  ([`BlockCard.jsx`](../frontend/src/components/workflow/BlockCard.jsx),
  [`SunoStage.jsx`](../frontend/src/components/workflow/SunoStage.jsx)'s
  refinement box,
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
  the Suno wish box) — never stored inside the hook itself, so the field
  stays a normal controlled `value`/`onChange` component.
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

## The Suno prompt: base instructions, examples, per-song wish

Three layers get concatenated into what's actually sent to Gemini, from most
to least reusable:

1. `settings.suno_base_prompt` — the general "how to adapt lyrics/style for
   Suno" instructions, editable in Settings. Seeded from
   [`providers/suno_prompt_defaults.py`](../backend/app/providers/suno_prompt_defaults.py)
   (`DEFAULT_SUNO_BASE_PROMPT`), adapted from a prompt the user already used
   manually with an LLM before this feature existed.
2. `settings.suno_reference_examples` — a handful of curated finished
   style+lyrics examples (also seeded from `suno_prompt_defaults.py`,
   `DEFAULT_REFERENCE_EXAMPLES`), sent as "use as a reference, don't copy
   verbatim" material. Kept as plain text in settings rather than uploaded
   files: the source files were inconsistent sizes (1.5 KB to 84 KB) and raw
   file upload isn't worth the cost/latency for text this small — curated text
   embedded in the prompt does the same job for a fraction of the tokens.
3. `project.skill_prompt` — the per-song skill template (`SunoStage.jsx`
   `SKILLS`) plus any refinement "wishes" folded in via `suno.refine`.

`settings.suno_wish_library` is a separate, flat list of saved wish snippets
(free text) the user can re-apply to *any* project's refinement box — distinct
from `project.refinement_comments`, which is just the per-project history of
wishes already applied. Saving to the library persists immediately (its own
`POST /api/settings/wish-library`, not a `PUT /api/settings`); it does not
require visiting the Settings screen. Each entry also has an auto-generated
`title` (see `generate_wish_title` below) so the Settings → Wishes tab can
show a scannable list instead of raw text; both `title` and `text` can be
corrected later from that tab (`PATCH /api/settings/wish-library/{id}`,
`SettingsScreen.jsx`'s inline edit mode), by typing or by voice
(`useFieldVoice`, see "Voice input" above).

## Conventions and gotchas

- **Two implementations of lyrics formatting must stay in sync.**
  `_format_lyrics` in `suno.py` mirrors `formatLyrics` in `lyrics.js` (English
  type labels, `interlude` passed through raw). Change one, change the other.
- **Autosave race.** Storyboard and image generation replace `scenes`
  server-side from a fresh disk read, so a debounced `PATCH` scheduled earlier
  could land afterwards and revert them. `flushPendingSave()` in `useProjects`
  cancels the debounce and saves synchronously first — call it before any
  action that rewrites project state on the server.
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
- **Most AI prices are not set by default.** `pricing.BUILTIN_PRICING`
  (`pricing.py`) only holds source-cited rows that were actually looked up
  (Google and OpenRouter are well covered since their full pricing/model
  pages were pasted in for verification; other providers only have a handful)
  — anything else has a cost total of `null`/"unknown" until a price is
  entered in Settings → Prices (by hand, or via the Prices tab's
  Export/Import round trip through an external pricing lookup); see
  [usage-tracking.md](usage-tracking.md).

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
