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
| [`routers/generation.py`](../backend/app/routers/generation.py) | Suno generate/refine, storyboard, scene images (`POST .../images` starts jobs, `GET .../images/jobs/{job_id}` polls one), reference-image upload/delete — all thin: load → call provider → persist |
| [`providers/suno.py`](../backend/app/providers/suno.py) | **Real seam.** `generate` parses the `"{provider}:{model_id}"` composite `model`; calls Gemini when `provider=='google'` and a key is set, else falls back to the old stub; `refine` stays local/no-network; `_format_lyrics` mirrors `formatLyrics` in `lyrics.js` |
| [`providers/text_models.py`](../backend/app/providers/text_models.py) | **Real seam (Google/OpenRouter/DeepSeek), curated fallback (Replicate/FAL).** `list_models` for the Settings "refresh models" catalog; `generate_wish_title` for wish-library auto-titling (truncate fallback when no simple model/key configured) |
| [`providers/image_models.py`](../backend/app/providers/image_models.py) | **Real seam (Google, filtered to `predict`/Imagen models), curated fallback (Replicate/FAL/OpenRouter/DeepSeek/Krea).** `list_models` for the Settings image-model catalog, mirrors `text_models.py`'s shape; the catalog ids it returns are what `providers/images.py` actually dispatches on |
| [`providers/suno_prompt_defaults.py`](../backend/app/providers/suno_prompt_defaults.py) | Seed text for `settings.suno_base_prompt` / `suno_reference_examples` — edited from Settings afterward, not from here |
| [`providers/scenes.py`](../backend/app/providers/scenes.py) | **Stub seam.** Splits blocks into N ordered scene chunks with canned prompts |
| [`providers/images.py`](../backend/app/providers/images.py) | **Real seam.** `start_jobs`/`get_job`: one background `asyncio` task + in-memory job per requested image variant, dispatched by provider (Krea/Replicate/FAL job-polling, Google Imagen single call) to a real API call, writing the result under `app_data/projects/<slug>/images/` and persisting it onto the project on completion |
| [`providers/url_parser.py`](../backend/app/providers/url_parser.py) | `httpx` + `BeautifulSoup` heuristic → `{author, title, raw_text}` |
| [`usage.py`](../backend/app/usage.py) | AI usage ledger — `record`/`query`/`summarize`/`today_total`, append-only `app_data/usage/YYYY-MM.jsonl`. See [usage-tracking.md](usage-tracking.md) |
| [`pricing.py`](../backend/app/pricing.py) | Price catalog + cost math (`BUILTIN_PRICING`, `get_price`, `compute_cost`, `estimate`, `catalog`) — pure, no I/O. `BUILTIN_PRICING` holds only a small set of cited, verified rows; everything else comes from a user override (manual or imported), see [usage-tracking.md](usage-tracking.md) |
| [`routers/usage.py`](../backend/app/routers/usage.py) | `GET /api/usage/records\|summary\|today`, `GET/PUT /api/usage/pricing` |

Tests: [`backend/tests/`](../backend/tests/) — `test_projects.py`, `test_generation.py`,
`test_suno_provider.py` (Gemini prompt assembly/call/parsing, with `httpx` mocked),
`test_text_models.py` (model listing + wish title generation, `httpx` mocked),
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
| [`lib/pricing.js`](../frontend/src/lib/pricing.js) | Pure cost formatting/estimation helpers (`formatCost`, `estimateCost`, `priceLabel`, `modelPriceMap`) — see [usage-tracking.md](usage-tracking.md) |
| [`styles/theme.css`](../frontend/src/styles/theme.css) | The whole visual system — palette vars + per-component classes. Grep the class name from the JSX |
| `components/home/` | `HomeScreen` + `Header`, `FilterChips`, `ProjectGrid`, `ProjectCard`, `EmptyState`, `NewProjectModal` |
| `components/workflow/` | `WorkflowScreen` → `WorkflowHeader`, `Sidebar`, and the three stages |
| [`components/UsagePill.jsx`](../frontend/src/components/UsagePill.jsx) | Shared "spend today" header pill, used in `home/Header.jsx`, `workflow/WorkflowHeader.jsx`, `settings/SettingsScreen.jsx` |
| `components/usage/` | `UsageScreen` + `UsageFilters`, `UsageSummary`, `UsageTable` — the AI cost ledger screen, see [usage-tracking.md](usage-tracking.md) |
| [`components/workflow/LyricsStage.jsx`](../frontend/src/components/workflow/LyricsStage.jsx) | Block list; per-block UI is in `BlockCard.jsx` (+ `TypeMenu`, `TagMenu` popovers) |
| [`components/workflow/SunoStage.jsx`](../frontend/src/components/workflow/SunoStage.jsx) | Skill picker, prompt editor, refinement, style/lyrics output, and a `ModelPicker` over `simple_models.favorites` next to "Save to library". **`SKILLS` (the skill templates) is defined here** |
| [`components/workflow/ScenesStage.jsx`](../frontend/src/components/workflow/ScenesStage.jsx) | Style description, references, scene list, `ModelPicker`s for the scene-text model (`text_models.favorites`) and the scene-image model (`image_models.favorites`); per-scene UI in `SceneCard.jsx`, images in `ImageThumb.jsx` |
| [`components/workflow/ModelPicker.jsx`](../frontend/src/components/workflow/ModelPicker.jsx) | Plain `<select>` over a favorites list (`{provider, id, label}[]`) → `"{provider}:{id}"` composite; shared by `SunoStage` and `ScenesStage` so each generation call can override the settings default, not just silently use it |
| [`components/settings/SettingsScreen.jsx`](../frontend/src/components/settings/SettingsScreen.jsx) | Tabbed (General/Providers/Models/Suno prompts/Wishes): language, backup export/import (API keys separately from everything else), API keys (Replicate/Google/FAL/OpenRouter/DeepSeek/Krea), text/simple model favorites (5 providers) + image model favorites (same 5 + Krea, image/video-only), special tags, Suno base prompt, reference examples, wish library (add/edit title+text inline, each field dictatable via `useFieldVoice`, delete) |
| [`components/settings/ModelFavorites.jsx`](../frontend/src/components/settings/ModelFavorites.jsx) | Favorites list + default picker + provider-catalog search/add, shared by the text-model, simple-model and image-model panels (each with its own catalog fetch); optional `prices` prop adds a price hint per model |
| [`components/settings/PricingPanel.jsx`](../frontend/src/components/settings/PricingPanel.jsx) | Settings → Prices tab: editable price catalog + overrides, see [usage-tracking.md](usage-tracking.md) |

Tests: `lib/lyrics.test.js`, `lib/scenes.test.js`, `lib/pricing.test.js` (Vitest).
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
| [`useSunoStage`](../frontend/src/hooks/useSunoStage.js) | Skill, prompt, refinement, generation, and `wishModel` (which `simple_models` favorite the next "Save to library" click uses) |
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
