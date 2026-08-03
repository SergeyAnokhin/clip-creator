# Code map

Where to look when you need to change something. One line per file; behavior
details live in [architecture.md](architecture.md), data shapes in
[data-model.md](data-model.md).

## Backend — [`backend/app/`](../backend/app/)

| File | Responsibility |
| --- | --- |
| [`main.py`](../backend/app/main.py) | FastAPI app, CORS (any `localhost:<port>`, regex), `/media` static mount over `app_data/`, seeds demo data on startup |
| [`storage.py`](../backend/app/storage.py) | All disk I/O: `app_data/settings.json`, `app_data/projects/<slug>/config.json`. `APP_DATA_DIR` env var overrides the root (tests use it) |
| [`slug.py`](../backend/app/slug.py) | `(author, title)` → filesystem-safe folder name = project `id` |
| [`seed.py`](../backend/app/seed.py) | 3 demo projects, written only when `app_data/projects/` is empty |
| [`models.py`](../backend/app/models.py) | Only `ProjectCreate`. Every other payload is an untyped `dict` body |
| [`routers/projects.py`](../backend/app/routers/projects.py) | Project CRUD + `_split_into_blocks` (blank line → new block) + `_to_summary` (list-view projection) |
| [`routers/settings.py`](../backend/app/routers/settings.py) | `GET/PUT /api/settings`; `GET /api/settings/models/{provider}`; `GET /api/settings/image-models/{provider}`; `POST /api/settings/wish-library` (add, auto-titled); `PATCH /api/settings/wish-library/{id}` (manual title/text edit); `DEFAULT_SETTINGS` lives here |
| [`routers/generation.py`](../backend/app/routers/generation.py) | Suno generate + wishes (add/reuse a wish card and activate it for the project), storyboard, scene images (`POST .../images` starts jobs, `GET .../images/jobs/{job_id}` polls one), reference-image upload/delete — all thin: load → call provider → persist |
| [`providers/suno.py`](../backend/app/providers/suno.py) | **Real seam (Google/OpenRouter/DeepSeek).** `generate` parses the `"{provider}:{model_id}"` composite `model`; calls that provider's chat API when the matching key is set, else falls back to the old stub with a `debug.reason` (`no_model_selected`/`unsupported_provider`/`no_api_key`); `_build_prompt` assembles base prompt + active-wishes block + examples + `skill_prompt`; `_format_lyrics` mirrors `formatLyrics` in `lyrics.js` (and `buildSunoPromptPreview` in `lib/sunoPrompt.js` mirrors `_build_prompt` — see below) |
| [`providers/wish_library.py`](../backend/app/providers/wish_library.py) | `add_or_get_wish` — clean+title a wish via `text_models.clean_wish_and_title` and append it to `settings.suno_wish_library` (or reuse an existing entry with identical text), persisting settings. Shared by `routers/settings.py::add_wish` (library-only) and `routers/generation.py::add_suno_wish` (also activates it for a project) |
| [`providers/text_models.py`](../backend/app/providers/text_models.py) | **Real seam (Google/OpenRouter/DeepSeek), curated fallback (Replicate/FAL).** `list_models` for the Settings "refresh models" catalog; `clean_wish_and_title` (tidy up a free-text wish and generate an emoji-prefixed title, in one call) shares the `_complete_google`/`_complete_openrouter`/`_complete_deepseek` helpers via a `prompt_template` param; `generate_wish_title` still exists as the single-purpose title-only variant those helpers default to; all degrade to a local fallback (text unchanged / truncate) when no simple model/key is configured |
| [`providers/image_models.py`](../backend/app/providers/image_models.py) | **Real seam (Google, filtered to `predict`/Imagen models), curated fallback (Replicate/FAL/OpenRouter/DeepSeek/Krea).** `list_models` for the Settings image-model catalog, mirrors `text_models.py`'s shape; the catalog ids it returns are what `providers/images.py` actually dispatches on |
| [`providers/suno_prompt_defaults.py`](../backend/app/providers/suno_prompt_defaults.py) | Seed text for `settings.suno_base_prompt` / `suno_reference_examples`, plus the two Suno base-prompt presets (`SUNO_BASE_PROMPT_PRESETS`) — edited from Settings afterward, not from here |
| [`providers/mureka_prompt_defaults.py`](../backend/app/providers/mureka_prompt_defaults.py) | The two Mureka base-prompt presets (`MUREKA_BASE_PROMPT_PRESETS`), same `{id, service, name, description, prompt}` shape as the Suno ones — merged with them by `routers/settings.py::get_suno_prompt_presets` |
| [`providers/scenes.py`](../backend/app/providers/scenes.py) | **Stub seam.** Splits blocks into N ordered scene chunks with canned prompts |
| [`providers/images.py`](../backend/app/providers/images.py) | **Real seam.** `start_jobs`/`get_job`: one background `asyncio` task + in-memory job per requested image variant, dispatched by provider (Krea/Replicate/FAL job-polling, Google Imagen single call) to a real API call, writing the result under `app_data/projects/<slug>/images/` and persisting it onto the project on completion |
| [`providers/url_parser.py`](../backend/app/providers/url_parser.py) | `httpx` + `BeautifulSoup` heuristic → `{author, title, raw_text}` |
| [`usage.py`](../backend/app/usage.py) | AI usage ledger — `record`/`query`/`summarize`/`today_total`, append-only `app_data/usage/YYYY-MM.jsonl`. See [usage-tracking.md](usage-tracking.md) |
| [`pricing.py`](../backend/app/pricing.py) | Price catalog + cost math (`BUILTIN_PRICING`, `get_price`, `compute_cost`, `estimate`, `catalog`) — pure, no I/O. `BUILTIN_PRICING` holds only a small set of cited, verified rows; everything else comes from a user override (manual or imported), see [usage-tracking.md](usage-tracking.md) |
| [`routers/usage.py`](../backend/app/routers/usage.py) | `GET /api/usage/records\|summary\|today`, `GET/PUT /api/usage/pricing` |

Tests: [`backend/tests/`](../backend/tests/) — `test_projects.py` (incl. the
legacy-project reset migration), `test_generation.py`,
`test_suno_provider.py` (Gemini prompt assembly/call/parsing, incl. the
active-wishes block, with `httpx` mocked),
`test_text_models.py` (model listing + wish clean+title generation, `httpx` mocked),
`test_image_models.py` (image-model catalog listing, `httpx` mocked),
`test_images_provider.py` (per-provider request/response shapes for Krea/Replicate/FAL/Google
image generation and the `start_jobs`/`get_job` job store, all with `httpx` mocked and
`asyncio.sleep` faked to skip real poll delays),
`test_settings.py` (settings routes, wish-library add/edit endpoints),
`test_pricing.py`, `test_usage_ledger.py`, `test_usage_routes.py` (usage ledger and pricing,
see [usage-tracking.md](usage-tracking.md)),
`test_url_parser.py`, `test_slug.py`. `conftest.py` points `APP_DATA_DIR` at a tmp dir.

## Frontend — [`frontend/src/`](../frontend/src/)

| File | Responsibility |
| --- | --- |
| [`App.jsx`](../frontend/src/App.jsx) | Composition root only: navigation (`screen`/`activeStage`), hook wiring, and the `lyricsState`/`sunoState`/`scenesState` prop bundles |
| `hooks/` | All state and actions — one hook per domain (table below) |
| [`api/client.js`](../frontend/src/api/client.js) | One function per route + `mediaUrl(path)`. `VITE_API_URL` overrides the base |
| [`i18n/dict.js`](../frontend/src/i18n/dict.js) | `DICT.ru` / `DICT.en` — add keys to **both** |
| [`lib/lyrics.js`](../frontend/src/lib/lyrics.js) | Pure block/line transforms (see table below) |
| [`lib/scenes.js`](../frontend/src/lib/scenes.js) | `pickMainByRating` — top-rated image becomes the scene's main frame |
| [`lib/debounce.js`](../frontend/src/lib/debounce.js) | `debounce(fn, ms)` with `.cancel()` |
| [`lib/format.js`](../frontend/src/lib/format.js) | Date/label formatting helpers |
| [`lib/pricing.js`](../frontend/src/lib/pricing.js) | Pure cost formatting/estimation helpers (`formatCost`, `estimateCost`, `estimateTokensFromChars`, `priceLabel`, `modelPriceMap`) — see [usage-tracking.md](usage-tracking.md) |
| [`lib/sunoPrompt.js`](../frontend/src/lib/sunoPrompt.js) | `buildSunoPromptPreview` — client-side mirror of `suno.py`'s `_build_gemini_prompt`/`_format_lyrics`, used only to show what the next "Generate prompt" call will send (the "What will be sent" panel in `SunoStage.jsx`); keep both in sync when either changes. Also `groupPresetsByService` — groups the `/suno-prompt-presets` list by `service` for display, shared by `SunoStage.jsx` and `SettingsScreen.jsx` |
| [`styles/theme.css`](../frontend/src/styles/theme.css) | The whole visual system — palette vars + per-component classes. Grep the class name from the JSX |
| `components/home/` | `HomeScreen` + `Header`, `FilterChips`, `ProjectGrid`, `ProjectCard`, `EmptyState`, `NewProjectModal` |
| `components/workflow/` | `WorkflowScreen` → `WorkflowHeader`, `Sidebar`, and the three stages |
| [`components/UsagePill.jsx`](../frontend/src/components/UsagePill.jsx) | Shared header cost pill (today's spend), used in `home/Header.jsx`, `workflow/WorkflowHeader.jsx`, `settings/SettingsScreen.jsx`. Click expands an in-place today/week/month/all-time breakdown (lazy-fetched via `GET /api/usage/period-totals`); the Usage screen is only reachable from the link inside that expanded view |
| `components/usage/` | `UsageScreen` + `UsageFilters`, `UsageSummary`, `UsageTable` — the AI cost ledger screen, see [usage-tracking.md](usage-tracking.md) |
| [`components/workflow/LyricsStage.jsx`](../frontend/src/components/workflow/LyricsStage.jsx) | Block list; per-block UI is in `BlockCard.jsx` (+ `TypeMenu`, `TagMenu` popovers) |
| [`components/workflow/SunoStage.jsx`](../frontend/src/components/workflow/SunoStage.jsx) | Collapsible base-prompt panel (presets grouped by service via `groupPresetsByService`, edits `settings.suno_base_prompt` directly, autosaves — see `useSettings.updateSunoBasePrompt`), "Дополнения к промпту" editor (`project.skill_prompt`), the AI-wish input ("Применить" cleans+titles+saves it to the library and activates it for this project — the model that cleans it is a read-only label pointing at Settings, no per-call picker) plus the wish-library cards as toggleable chips (`project.active_wish_ids`), a collapsible "What will be sent" prompt preview with token/cost estimate (`lib/sunoPrompt.js` + `lib/pricing.js`), and a `ModelPicker` over `text_models.favorites` next to "Сгенерировать промпт" |
| [`components/workflow/ScenesStage.jsx`](../frontend/src/components/workflow/ScenesStage.jsx) | Style description, references, scene list, `ModelPicker`s for the scene-text model (`text_models.favorites`) and the scene-image model (`image_models.favorites`); per-scene UI in `SceneCard.jsx`, images in `ImageThumb.jsx` |
| [`components/workflow/ModelPicker.jsx`](../frontend/src/components/workflow/ModelPicker.jsx) | Plain `<select>` over a favorites list (`{provider, id, label}[]`) → `"{provider}:{id}"` composite; shared by `SunoStage` and `ScenesStage` so each generation call can override the settings default, not just silently use it |
| [`components/settings/SettingsScreen.jsx`](../frontend/src/components/settings/SettingsScreen.jsx) | Tabbed (General/Providers/Models/"Музыкальные промпты"/Wishes): language, backup export/import (API keys separately from everything else), API keys (Replicate/Google/FAL/OpenRouter/DeepSeek/Krea), text/simple model favorites (5 providers) + image model favorites (same 5 + Krea, image/video-only), special tags, base-prompt presets grouped by service (`groupPresetsByService` from `lib/sunoPrompt.js`), base prompt text, reference examples, wish library (add/edit title+text inline, each field dictatable via `useFieldVoice`, delete) |
| [`components/settings/ModelFavorites.jsx`](../frontend/src/components/settings/ModelFavorites.jsx) | Favorites list + default picker + provider-catalog search/add, shared by the text-model, simple-model and image-model panels (each with its own catalog fetch); optional `prices` prop adds a price hint per model |
| [`components/settings/PricingPanel.jsx`](../frontend/src/components/settings/PricingPanel.jsx) | Settings → Prices tab: editable price catalog + overrides, see [usage-tracking.md](usage-tracking.md) |

Tests: `lib/lyrics.test.js`, `lib/scenes.test.js`, `lib/pricing.test.js`, `lib/sunoPrompt.test.js` (Vitest).
Only the pure `lib/` code is covered — components and hooks have no tests.

### `hooks/` — where the state lives

Created in this order in `App.jsx`; each takes its dependencies as arguments,
so the wiring is explicit and there is no context/provider indirection.

| Hook | Owns |
| --- | --- |
| [`useToast`](../frontend/src/hooks/useToast.js) | The single transient message. Every other hook depends on `showToast` |
| [`useViewport`](../frontend/src/hooks/useViewport.js) | Breakpoint + workflow sidebar |
| [`useUsage`](../frontend/src/hooks/useUsage.js) | AI usage ledger and price catalog — created **before** `useSettings` (doesn't depend on it); see [usage-tracking.md](usage-tracking.md) |
| [`useSettings`](../frontend/src/hooks/useSettings.js) | Language (and therefore `L`), API keys, text/simple/image model favorites+default, special tags, wish library (add with auto-title, edit title/text, delete), backup import (API keys / everything else, from an uploaded JSON file) |
| [`useProjects`](../frontend/src/hooks/useProjects.js) | Project list, New-Workflow modal, open project, **and persistence** (`updateProject`, `flushPendingSave`) |
| [`useLyricsStage`](../frontend/src/hooks/useLyricsStage.js) | Block/line editing state and every block mutation |
| [`useSunoStage`](../frontend/src/hooks/useSunoStage.js) | Skill, `skill_prompt` ("Дополнения к промпту"), the AI-wish input + `addWish`/`toggleWish` (create/activate and toggle a project's `active_wish_ids`), generation, and `genModel` (which `text_models` favorite the next "Generate for Suno" call uses — seeded from `text_models.default`, session-only). The wish-cleanup model is **not** hook state; it's always `settings.simple_models.default`, read server-side |
| [`useScenesStage`](../frontend/src/hooks/useScenesStage.js) | Storyboard, references, image variants, ratings; `imageModel`/`sceneTextModel` (which favorite each generation call uses) are seeded from `settings.image_models.default`/`text_models.default` in `resetForProject`, then overridable per-screen via `ModelPicker` |
| [`useVoice`](../frontend/src/hooks/useVoice.js) | Speech-to-text via the native Web Speech API (real recognition, no backend call — see [architecture.md](architecture.md#voice-input-speech-to-text)). Created **last** — it writes into the Suno refinement box. Also exports `useFieldVoice`, a project-independent variant `SettingsScreen.jsx` instantiates itself for wish-library dictation |

Stage hooks return `{ state, actions }`; `App.jsx` merges in the cross-cutting
bits (`specialTags` from settings, `startVoice` and the recording flags from
voice) when building each stage's prop bundle.

### `lib/lyrics.js` functions

| Function | Does |
| --- | --- |
| `compileLyrics(blocks)` | `blocks` → `{type, content}` segments |
| `formatLyrics(segments, typeLabel)` | Segments → Suno text. `interlude` emits raw content (no `[Label]` wrapper) |
| `moveBlock` / `moveBlockToEdge` | Reorder by one step / jump to start-end |
| `moveToEdgeForType` | `intro`→start, `outro`→end (built on `moveBlockToEdge`) |
| `splitBlockAtLine` / `splitBlockEveryN` | Split a block at one line / into groups of N |
| `cloneBlockWithType` | Copy a block under a new type instead of retyping it |
| `repeatChorusAfterVerses` | One-shot: insert a chorus clone after every verse |
| `insertBlockAdjacent` | Insert a tag block before/after a block |
| `setLine` / `duplicateLine` / `deleteLine` / `toggleLineBrackets` | Single-line edits inside a block's `content` |
