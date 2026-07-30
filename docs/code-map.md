# Code map

Where to look when you need to change something. One line per file; behavior
details live in [architecture.md](architecture.md), data shapes in
[data-model.md](data-model.md).

## Backend — [`backend/app/`](../backend/app/)

| File | Responsibility |
| --- | --- |
| [`main.py`](../backend/app/main.py) | FastAPI app, CORS (`:5174`), `/media` static mount over `app_data/`, seeds demo data on startup |
| [`storage.py`](../backend/app/storage.py) | All disk I/O: `app_data/settings.json`, `app_data/projects/<slug>/config.json`. `APP_DATA_DIR` env var overrides the root (tests use it) |
| [`slug.py`](../backend/app/slug.py) | `(author, title)` → filesystem-safe folder name = project `id` |
| [`seed.py`](../backend/app/seed.py) | 3 demo projects, written only when `app_data/projects/` is empty |
| [`models.py`](../backend/app/models.py) | Only `ProjectCreate`. Every other payload is an untyped `dict` body |
| [`routers/projects.py`](../backend/app/routers/projects.py) | Project CRUD + `_split_into_blocks` (blank line → new block) + `_to_summary` (list-view projection) |
| [`routers/settings.py`](../backend/app/routers/settings.py) | `GET/PUT /api/settings`; `DEFAULT_SETTINGS` lives here |
| [`routers/generation.py`](../backend/app/routers/generation.py) | Suno generate/refine, storyboard, scene images, reference-image upload/delete — all thin: load → call provider → persist |
| [`providers/suno.py`](../backend/app/providers/suno.py) | **Stub seam.** `generate`/`refine`; `_format_lyrics` mirrors `formatLyrics` in `lyrics.js` |
| [`providers/scenes.py`](../backend/app/providers/scenes.py) | **Stub seam.** Splits blocks into N ordered scene chunks with canned prompts |
| [`providers/images.py`](../backend/app/providers/images.py) | **Stub seam,** but writes real placeholder SVG files under `app_data/projects/<slug>/images/` |
| [`providers/url_parser.py`](../backend/app/providers/url_parser.py) | `httpx` + `BeautifulSoup` heuristic → `{author, title, raw_text}` |

Tests: [`backend/tests/`](../backend/tests/) — `test_projects.py`, `test_generation.py`,
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
| [`styles/theme.css`](../frontend/src/styles/theme.css) | The whole visual system — palette vars + per-component classes. Grep the class name from the JSX |
| `components/home/` | `HomeScreen` + `Header`, `FilterChips`, `ProjectGrid`, `ProjectCard`, `EmptyState`, `NewProjectModal` |
| `components/workflow/` | `WorkflowScreen` → `WorkflowHeader`, `Sidebar`, and the three stages |
| [`components/workflow/LyricsStage.jsx`](../frontend/src/components/workflow/LyricsStage.jsx) | Block list; per-block UI is in `BlockCard.jsx` (+ `TypeMenu`, `TagMenu` popovers) |
| [`components/workflow/SunoStage.jsx`](../frontend/src/components/workflow/SunoStage.jsx) | Skill picker, prompt editor, refinement, style/lyrics output. **`SKILLS` (the skill templates) is defined here** |
| [`components/workflow/ScenesStage.jsx`](../frontend/src/components/workflow/ScenesStage.jsx) | Style description, references, scene list; per-scene UI in `SceneCard.jsx`, images in `ImageThumb.jsx` |
| [`components/settings/SettingsScreen.jsx`](../frontend/src/components/settings/SettingsScreen.jsx) | Language, API keys, default models, special tags |

Tests: `lib/lyrics.test.js`, `lib/scenes.test.js` (Vitest). Only the pure `lib/`
code is covered — components and hooks have no tests.

### `hooks/` — where the state lives

Created in this order in `App.jsx`; each takes its dependencies as arguments,
so the wiring is explicit and there is no context/provider indirection.

| Hook | Owns |
| --- | --- |
| [`useToast`](../frontend/src/hooks/useToast.js) | The single transient message. Every other hook depends on `showToast` |
| [`useViewport`](../frontend/src/hooks/useViewport.js) | Breakpoint + workflow sidebar |
| [`useSettings`](../frontend/src/hooks/useSettings.js) | Language (and therefore `L`), API keys, default models, special tags |
| [`useProjects`](../frontend/src/hooks/useProjects.js) | Project list, New-Workflow modal, open project, **and persistence** (`updateProject`, `flushPendingSave`) |
| [`useLyricsStage`](../frontend/src/hooks/useLyricsStage.js) | Block/line editing state and every block mutation |
| [`useSunoStage`](../frontend/src/hooks/useSunoStage.js) | Skill, prompt, refinement, generation |
| [`useScenesStage`](../frontend/src/hooks/useScenesStage.js) | Storyboard, references, image variants, ratings |
| [`useVoice`](../frontend/src/hooks/useVoice.js) | The mic simulation. Created **last** — it writes into the Suno refinement box |

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
