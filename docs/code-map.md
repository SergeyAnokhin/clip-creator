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
| [`routers/settings.py`](../backend/app/routers/settings.py) | `GET/PUT /api/settings`; `GET /api/settings/models/{provider}`; `GET /api/settings/image-models/{provider}`; `POST /api/settings/wish-library` + `PATCH .../{id}` (music/lyrics wishes); `POST /api/settings/scene-wish-library` + `PATCH .../{id}` (scene/imagery wishes, separate library); `DEFAULT_SETTINGS` lives here |
| [`routers/generation.py`](../backend/app/routers/generation.py) | Suno generate + wishes, scene storyboard generate + scene wishes (`POST .../scenes/wishes`), scene images (`POST .../images` starts jobs, `GET .../images/jobs/{job_id}` polls one), reference-image upload/delete — all thin: load → call provider → persist |
| [`routers/translate.py`](../backend/app/routers/translate.py) | `POST /api/translate` — project-independent prompt translation for the Scenes/Images stage's "translate" button, thin wrapper over `providers/translate.py` |
| [`providers/suno.py`](../backend/app/providers/suno.py) | **Real seam (Google/OpenRouter/DeepSeek).** `generate` parses the `"{provider}:{model_id}"` composite `model`; calls that provider's chat API when the matching key is set, else falls back to the old stub with a `debug.reason` (`no_model_selected`/`unsupported_provider`/`no_api_key`); `_build_prompt` assembles base prompt + active-wishes block + examples + `skill_prompt`; `_format_lyrics` mirrors `formatLyrics` in `lyrics.js` (and `buildSunoPromptPreview` in `lib/sunoPrompt.js` mirrors `_build_prompt` — see below) |
| [`providers/wish_library.py`](../backend/app/providers/wish_library.py) | `add_or_get_wish` — clean+title a wish via `text_models.clean_wish_and_title` and append it to `settings[library_key]` (`suno_wish_library` or `scene_wish_library`, or reuse an existing entry with identical text), persisting settings. Shared by `routers/settings.py::add_wish`/`add_scene_wish` (library-only) and `routers/generation.py::add_suno_wish`/`add_scene_wish` (also activates it for a project) |
| [`providers/text_models.py`](../backend/app/providers/text_models.py) | **Real seam (Google/OpenRouter/DeepSeek), curated fallback (Replicate/FAL).** `list_models` for the Settings "refresh models" catalog; `clean_wish_and_title` (tidy up a free-text wish and generate an emoji-prefixed title, in one call) shares the `_complete_google`/`_complete_openrouter`/`_complete_deepseek` helpers via a `prompt_template` param; `generate_wish_title` still exists as the single-purpose title-only variant those helpers default to; all degrade to a local fallback (text unchanged / truncate) when no simple model/key is configured; each `_complete_*` call also takes `timeout` (from `settings.request_timeout_seconds`) and logs a console start line |
| [`providers/image_models.py`](../backend/app/providers/image_models.py) | **Real seam (Google, filtered to `predict`/Imagen models), curated fallback (Replicate/FAL/OpenRouter/Krea; DeepSeek stays empty).** `list_models` for the Settings image-model catalog, mirrors `text_models.py`'s shape; the catalog ids it returns are what `providers/images.py` actually dispatches on |
| [`providers/suno_prompt_defaults.py`](../backend/app/providers/suno_prompt_defaults.py) | Seed text for `settings.suno_base_prompt` / `suno_reference_examples`, plus the two Suno base-prompt presets (`SUNO_BASE_PROMPT_PRESETS`) — edited from Settings afterward, not from here |
| [`providers/mureka_prompt_defaults.py`](../backend/app/providers/mureka_prompt_defaults.py) | The two Mureka base-prompt presets (`MUREKA_BASE_PROMPT_PRESETS`), same `{id, service, name, description, prompt}` shape as the Suno ones — merged with them by `routers/settings.py::get_suno_prompt_presets` |
| [`providers/scenes_prompt_defaults.py`](../backend/app/providers/scenes_prompt_defaults.py) | Seed text for `settings.scene_base_prompt_narrative`/`scene_base_prompt_abstract` — see "The scene prompt" in [architecture.md](architecture.md) |
| [`providers/scenes.py`](../backend/app/providers/scenes.py) | **Real seam (Google/OpenRouter/DeepSeek), mirrors `suno.py`.** `generate` builds a prompt from `scene_base_prompt_{scene_mode}` + active scene wishes + style/reference notes + raw lyric lines, asks for a `` ```json `` array of `scene_count` `{lyric_segment, static_prompt, motion_prompt}` objects (`_parse_model_response`, tolerant — falls back to the deterministic chunked-lyrics stub on a malformed/wrong-length reply); same stub fallback contract as `suno.generate` when no model/key |
| [`providers/images.py`](../backend/app/providers/images.py) | **Real seam.** `start_jobs`/`get_job`: one background `asyncio` task + in-memory job per requested image variant, dispatched by provider (Krea/Replicate/FAL job-polling, Google Imagen and OpenRouter single-call) to a real API call, writing the result under `app_data/projects/<slug>/images/` and persisting it onto the project on completion. OpenRouter's call reports its own exact cost (`usage.cost`), threaded through as `provider_cost` the same way `text_models.py`'s `_complete_openrouter` already does for text |
| [`providers/translate.py`](../backend/app/providers/translate.py) | **Real seam.** `translate_text` — one-off prompt translation via the Google Cloud Translation API v2 (Basic, key-based), backing the Scenes/Images stage's "translate" button (`settings.api_keys.google_translate`, a separate GCP product/key from the Gemini one) |
| [`providers/url_parser.py`](../backend/app/providers/url_parser.py) | `httpx` + `BeautifulSoup` heuristic → `{author, title, raw_text}` |
| [`console_log.py`](../backend/app/console_log.py) | Colored, emoji-tagged dev-console lines for every real provider call (`log_request_start`, `log_result` — called from `usage._write` so it can never disagree with the ledger); purely cosmetic, never raises |
| [`usage.py`](../backend/app/usage.py) | AI usage ledger — `record`/`query`/`summarize`/`today_total`, append-only `app_data/usage/YYYY-MM.jsonl`. See [usage-tracking.md](usage-tracking.md) |
| [`pricing.py`](../backend/app/pricing.py) | Price catalog + cost math (`BUILTIN_PRICING`, `get_price`, `compute_cost`, `estimate`, `catalog`) — pure, no I/O. `BUILTIN_PRICING` holds only a small set of cited, verified rows; everything else comes from a user override (manual or imported), see [usage-tracking.md](usage-tracking.md) |
| [`routers/usage.py`](../backend/app/routers/usage.py) | `GET /api/usage/records\|summary\|today`, `GET/PUT /api/usage/pricing` |

Tests: [`backend/tests/`](../backend/tests/) — `test_projects.py` (incl. the
legacy-project reset migration), `test_generation.py`,
`test_suno_provider.py` (Gemini prompt assembly/call/parsing, incl. the
active-wishes block, with `httpx` mocked),
`test_scenes_provider.py` (JSON-scene prompt assembly/call/parsing, stub
fallback, timeout, usage recording — mirrors `test_suno_provider.py`),
`test_text_models.py` (model listing + wish clean+title generation, `httpx` mocked),
`test_image_models.py` (image-model catalog listing, `httpx` mocked),
`test_images_provider.py` (per-provider request/response shapes for Krea/Replicate/FAL/Google/OpenRouter
image generation and the `start_jobs`/`get_job` job store, all with `httpx` mocked and
`asyncio.sleep` faked to skip real poll delays),
`test_translate.py` (translation provider + `/api/translate` route, `httpx` mocked),
`test_settings.py` (settings routes, wish-library add/edit endpoints),
`test_pricing.py`, `test_usage_ledger.py`, `test_usage_routes.py` (usage ledger and pricing,
see [usage-tracking.md](usage-tracking.md)),
`test_url_parser.py`, `test_slug.py`. `conftest.py` points `APP_DATA_DIR` at a tmp dir.

## Frontend — [`frontend/src/`](../frontend/src/)

| File | Responsibility |
| --- | --- |
| [`App.jsx`](../frontend/src/App.jsx) | Composition root only: navigation (`screen`/`activeStage`), hook wiring, and the `lyricsState`/`sunoState`/`scenesState`/`imagesState` prop bundles |
| `hooks/` | All state and actions — one hook per domain (table below) |
| [`api/client.js`](../frontend/src/api/client.js) | One function per route + `mediaUrl(path)`, incl. `translateText(text, targetLang)` (`POST /api/translate`). `VITE_API_URL` overrides the base |
| [`i18n/dict.js`](../frontend/src/i18n/dict.js) | `DICT.ru` / `DICT.en` — add keys to **both** |
| [`lib/lyrics.js`](../frontend/src/lib/lyrics.js) | Pure block/line transforms (see table below) |
| [`lib/scenes.js`](../frontend/src/lib/scenes.js) | `pickMainByRating` — top-rated image becomes the scene's main frame |
| [`lib/debounce.js`](../frontend/src/lib/debounce.js) | `debounce(fn, ms)` with `.cancel()` |
| [`lib/format.js`](../frontend/src/lib/format.js) | Date/label formatting helpers |
| [`lib/pricing.js`](../frontend/src/lib/pricing.js) | Pure cost formatting/estimation helpers (`formatCost`, `estimateCost`, `estimateTokensFromChars`, `priceLabel`, `modelPriceMap`) — see [usage-tracking.md](usage-tracking.md) |
| [`lib/sunoPrompt.js`](../frontend/src/lib/sunoPrompt.js) | `buildSunoPromptPreview` — client-side mirror of `suno.py`'s `_build_gemini_prompt`/`_format_lyrics`, used only to show what the next "Generate prompt" call will send (the "What will be sent" panel in `SunoStage.jsx`); keep both in sync when either changes. Also `groupPresetsByService` — groups the `/suno-prompt-presets` list by `service` for display, shared by `SunoStage.jsx` and `SettingsScreen.jsx` |
| [`styles/theme.css`](../frontend/src/styles/theme.css) | The whole visual system — palette vars + per-component classes. Grep the class name from the JSX |
| `components/home/` | `HomeScreen` + `Header`, `FilterChips`, `ProjectGrid`, `ProjectCard`, `EmptyState`, `NewProjectModal` |
| `components/workflow/` | `WorkflowScreen` → `WorkflowHeader`, `Sidebar`, and the four stages |
| [`components/UsagePill.jsx`](../frontend/src/components/UsagePill.jsx) | Shared header cost pill (today's spend), used in `home/Header.jsx`, `workflow/WorkflowHeader.jsx`, `settings/SettingsScreen.jsx`. Click expands an in-place today/week/month/all-time breakdown (lazy-fetched via `GET /api/usage/period-totals`); the Usage screen is only reachable from the link inside that expanded view |
| `components/usage/` | `UsageScreen` + `UsageFilters`, `UsageSummary`, `UsageTable` — the AI cost ledger screen, see [usage-tracking.md](usage-tracking.md) |
| [`components/workflow/LyricsStage.jsx`](../frontend/src/components/workflow/LyricsStage.jsx) | Block list; per-block UI is in `BlockCard.jsx` (+ `TypeMenu`, `TagMenu` popovers) |
| [`components/workflow/SunoStage.jsx`](../frontend/src/components/workflow/SunoStage.jsx) | Collapsible base-prompt panel (presets grouped by service via `groupPresetsByService`, edits `settings.suno_base_prompt` directly, autosaves — see `useSettings.updateSunoBasePrompt`), "Дополнения к промпту" editor (`project.skill_prompt`), the AI-wish input ("Применить" cleans+titles+saves it to the library and activates it for this project — the model that cleans it is a read-only label pointing at Settings, no per-call picker) plus the wish-library cards as toggleable chips (`project.active_wish_ids`), a collapsible "What will be sent" prompt preview with token/cost estimate (`lib/sunoPrompt.js` + `lib/pricing.js`), and a `ModelPicker` over `text_models.favorites` next to "Сгенерировать промпт" |
| [`components/workflow/ScenesStage.jsx`](../frontend/src/components/workflow/ScenesStage.jsx) | Mostly text: collapsible base-prompt panel (edits whichever of `scene_base_prompt_narrative`/`_abstract` matches the current `scene_mode`), scene wishes (chips + mic-dictated input, mirrors `SunoStage.jsx`'s wish UI including voice), style description, `scene_mode`/`scene_count` pickers, a `hideMotionPrompt` toggle chip (shared with `ImagesStage.jsx`, see `useSettings.js`), a global `ModelPicker` over `image_models_simple` favorites for `sceneImageModel` (one cheap model for every scene's quick preview), debug panel with usage summary, `ModelPicker` for the scene-text model (`text_models.favorites`); per-scene UI in `SceneTextCard.jsx` (lyric segment + editable static/motion prompt + a right-side quick-preview image slot, "translate" buttons next to each prompt label) |
| [`components/workflow/ImagesStage.jsx`](../frontend/src/components/workflow/ImagesStage.jsx) | Reference-image upload/list, cheap/quality `imageModelTier` toggle feeding a `ModelPicker` over `image_models`/`image_models_simple` favorites, variant count, the same `hideMotionPrompt` toggle chip as `ScenesStage.jsx`; per-scene UI in `SceneCard.jsx` (prompt + "translate" buttons + "Сгенерировать" + image grid via `ImageThumb.jsx`, now laid out to the right of the prompts instead of below) |
| [`components/workflow/ModelPicker.jsx`](../frontend/src/components/workflow/ModelPicker.jsx) | Plain `<select>` over a favorites list (`{provider, id, label}[]`) → `"{provider}:{id}"` composite; shared by `SunoStage`, `ScenesStage` and `ImagesStage` so each generation call can override the settings default, not just silently use it |
| [`components/workflow/TranslateButton.jsx`](../frontend/src/components/workflow/TranslateButton.jsx) | Small icon button + its own modal, dropped next to a static/motion prompt label; calls `POST /api/translate` on click and shows the Russian translation (or the error, e.g. missing `google_translate` key) — owns its own open/loading/result state, nothing lifted into a hook since the translation is never persisted |
| [`components/workflow/ImageLightbox.jsx`](../frontend/src/components/workflow/ImageLightbox.jsx) | Click-to-enlarge modal for one generated scene image (`.modal-card-lg` + `.lightbox-image`); a dumb, controlled component (`image: null` closes it) reused by `SceneTextCard.jsx` and `SceneCard.jsx`/`ImageThumb.jsx` |
| [`components/settings/SettingsScreen.jsx`](../frontend/src/components/settings/SettingsScreen.jsx) | Tabbed (General/Providers/Models/"Музыкальные промпты"/Wishes): language, request timeout, backup export/import (API keys separately from everything else), API keys (Replicate/Google/FAL/OpenRouter/DeepSeek/Krea), text/simple model favorites (5 providers) + image model favorites × 2 tiers (quality/cheap, same 5 + Krea, image/video-only), special tags, base-prompt presets grouped by service (`groupPresetsByService` from `lib/sunoPrompt.js`), music base prompt text + reference examples, scene base prompts (narrative/abstract), music wish library + scene wish library (each: add/edit title+text inline, each field dictatable via `useFieldVoice`, delete) |
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
| [`useSettings`](../frontend/src/hooks/useSettings.js) | Language (and therefore `L`), API keys (incl. `google_translate`), text/simple/image model favorites+default (× 2 tiers for image), request timeout, special tags, music + scene wish libraries (add with auto-title, edit title/text, delete), scene base prompts (narrative/abstract), `hideMotionPrompt` (autosaves immediately, shared by Scenes/Images stages), backup import (API keys / everything else, from an uploaded JSON file) |
| [`useProjects`](../frontend/src/hooks/useProjects.js) | Project list, New-Workflow modal, open project, **and persistence** (`updateProject`, `flushPendingSave`) |
| [`useLyricsStage`](../frontend/src/hooks/useLyricsStage.js) | Block/line editing state and every block mutation |
| [`useSunoStage`](../frontend/src/hooks/useSunoStage.js) | Skill, `skill_prompt` ("Дополнения к промпту"), the AI-wish input + `addWish`/`toggleWish` (create/activate and toggle a project's `active_wish_ids`), generation, and `genModel` (which `text_models` favorite the next "Generate for Suno" call uses — seeded from `text_models.default`, session-only). The wish-cleanup model is **not** hook state; it's always `settings.simple_models.default`, read server-side |
| [`useScenesStage`](../frontend/src/hooks/useScenesStage.js) | Scene text: `sceneMode`/`sceneCount`, style description, the scene-wish input (`sceneWishText`, incl. mic dictation) + `addSceneWish`/`toggleSceneWish` (mirrors `useSunoStage`'s wish flow but against `active_scene_wish_ids`), storyboard generation + debug/usage state, per-scene static/motion prompt edits; `sceneTextModel` seeded from `text_models.default`. Also a quick single-cheap-image preview per scene: `sceneImageModel` (seeded from `image_models_simple.default`, one picker for every scene) + `generateSceneImage(idx)`, reusing the same `POST .../scenes/{n}/images` job-poll flow `useImagesStage.js` uses, fixed at `count: 1` |
| [`useImagesStage`](../frontend/src/hooks/useImagesStage.js) | Reference-image upload/remove, image variants, ratings, `imageModelTier` (`'simple'`\|`'main'`, picks which favorites list feeds `imageModel`) seeded from `image_models_simple.default`/`image_models.default` |
| [`useVoice`](../frontend/src/hooks/useVoice.js) | Speech-to-text via the native Web Speech API (real recognition, no backend call — see [architecture.md](architecture.md#voice-input-speech-to-text)). Created **last** — it writes into the Suno refinement box and the Scenes wish box. Also exports `useFieldVoice`, a project-independent variant `SettingsScreen.jsx` instantiates itself for wish-library dictation |

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
