# Architecture

Versecraft is a two-process local app: a React (Vite) frontend talks over HTTP to
a FastAPI backend, which persists everything as JSON files on disk under
`app_data/` (git-ignored). There is no database. AI generation (Suno lyrics/style,
scene images) is currently **stubbed** on the backend — see
[AI provider seams](#ai-provider-seams) below.

```text
┌───────────────┐   fetch /api/*   ┌────────────────┐   read/write JSON   ┌───────────────┐
│ frontend/src  │ ───────────────► │ backend/app     │ ──────────────────► │ app_data/     │
│ (Vite, :5174) │ ◄─────────────── │ (FastAPI, :8000)│ ◄────────────────── │ (git-ignored) │
└───────────────┘      JSON        └────────────────┘                     └───────────────┘
```

## Running it

`npm run dev` from the repo root runs both dev servers together via
`concurrently` (see [`package.json`](../package.json)) - frontend on
http://localhost:5174, backend on http://localhost:8000. The Vite dev port is
pinned to 5174 (not Vite's default 5173) to avoid clashing with other local
projects; see [`frontend/vite.config.js`](../frontend/vite.config.js) and the
matching CORS origin in [`backend/app/main.py`](../backend/app/main.py).

## Frontend

All app state lives in [`frontend/src/App.jsx`](../frontend/src/App.jsx) - one
top-level component owns `screen` (`home`/`workflow`/`settings`), the loaded
project list, the currently open project, and every stage's UI state. This
mirrors the single-controller shape of the original design mock
(`Component extends DCLogic`) rather than introducing a state-management
library that wasn't needed.

| Area | Files |
| --- | --- |
| API client | [`src/api/client.js`](../frontend/src/api/client.js) - one function per backend route |
| i18n | [`src/i18n/dict.js`](../frontend/src/i18n/dict.js) - RU/EN copy, kept in parity per [CLAUDE.md](../CLAUDE.md) |
| Lyrics logic | [`src/lib/lyrics.js`](../frontend/src/lib/lyrics.js) - pure, unit-tested: chorus auto-repeat compilation, block reordering, line-level block splitting |
| Home screen | [`src/components/home/`](../frontend/src/components/home/) |
| Workflow screen | [`src/components/workflow/`](../frontend/src/components/workflow/) - sidebar + Lyrics/Suno/Scenes stages |
| Settings screen | [`src/components/settings/SettingsScreen.jsx`](../frontend/src/components/settings/SettingsScreen.jsx) |
| Visual style | [`src/styles/theme.css`](../frontend/src/styles/theme.css) - palette/utility classes ported from the design mock |

Project edits (add/reorder/edit block, scene prompts, ratings, etc.) update
local state immediately, then `PATCH /api/projects/{id}` with the full updated
project - text-field edits (scene prompts, skill prompt) are debounced 400ms so
each keystroke doesn't fire a request.

Voice-input ("mic") buttons are a UI-only simulation (timed fake transcript),
matching the design mock - there is no real speech-to-text integration.

## Backend

| File | Responsibility |
| --- | --- |
| [`app/main.py`](../backend/app/main.py) | FastAPI app, CORS, seeds demo data on startup |
| [`app/storage.py`](../backend/app/storage.py) | Reads/writes `app_data/settings.json` and `app_data/projects/<slug>/config.json` |
| [`app/slug.py`](../backend/app/slug.py) | `"[Author] - [Title]"` → filesystem-safe project folder name |
| [`app/seed.py`](../backend/app/seed.py) | Seeds the 3 demo poems (from the design mock) on first run |
| [`app/routers/projects.py`](../backend/app/routers/projects.py) | `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/{id}` |
| [`app/routers/settings.py`](../backend/app/routers/settings.py) | `GET/PUT /api/settings` |
| [`app/routers/generation.py`](../backend/app/routers/generation.py) | `POST /api/projects/{id}/suno/generate`, `POST /api/projects/{id}/scenes/{n}/images` |

A project is one JSON file: `app_data/projects/<slug>/config.json`. There's no
schema migration system - the file is whatever shape `storage.save_project`
last wrote, since a single-user local app doesn't need one yet.

### AI provider seams

[`app/providers/suno.py`](../backend/app/providers/suno.py) and
[`app/providers/images.py`](../backend/app/providers/images.py) are **stubs**:
they return deterministic canned data (no network calls). They exist as a
deliberate seam - routers call `providers.suno.generate(project)` /
`providers.images.generate(scene)` and don't know or care whether that's a
stub or a real OpenAI/Anthropic/Suno/Replicate call. Wiring in the real APIs
(using the keys from `app_data/settings.json`) means editing only these two
files. Tests (`backend/tests/test_generation.py`) mock exactly this seam, so
they never hit the network.

### Lyrics builder: paste-and-split

"New Workflow" accepts either a URL or pasted raw poem text (mutually
exclusive - raw text wins if both are filled in). Pasted text is split into
blocks by `_split_into_blocks` in
[`app/routers/projects.py`](../backend/app/routers/projects.py): every blank
line (`\n\s*\n`) starts a new block, all typed `verse` with importance 3 by
default - the user then re-tags each block (Intro/Chorus/Bridge/...) and
reorders/duplicates them entirely by tapping, no text editor required. In the
lyrics stage, an existing block can also be split further: each line of a
block's content is rendered separately in
[`BlockCard.jsx`](../frontend/src/components/workflow/BlockCard.jsx) with a
"split here" button in the gap between two lines, backed by the pure
`splitBlockAtLine` in [`lyrics.js`](../frontend/src/lib/lyrics.js) - both
halves keep the original block's type/importance.

### Not implemented yet

- Real link parsing for "New Workflow" (`POST /api/projects` with a `url`
  still creates a placeholder project, ignoring the URL's actual page
  content - see "Lyrics builder: paste-and-split" above for the raw-text
  path, which does work).
- Real speech-to-text for the voice-input buttons.
- Real AI provider calls (see above).

## Testing

- Frontend: `npm run test --prefix frontend` (Vitest) - covers the lyrics
  compilation/reordering logic in [`src/lib/lyrics.test.js`](../frontend/src/lib/lyrics.test.js).
- Backend: `pytest backend/tests` - covers slug sanitization, the project
  CRUD round-trip against a temp storage root, and the generation routes
  against mocked provider seams.
- `npm test` from the repo root runs both.
