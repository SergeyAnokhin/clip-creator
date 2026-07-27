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
| Lyrics logic | [`src/lib/lyrics.js`](../frontend/src/lib/lyrics.js) - pure, unit-tested: block reordering, line-level and N-line-group block splitting, one-shot chorus repetition, type-clone with intro/outro edge-jump, adjacent tag-block insertion, line bracket toggling, single-line duplication/editing/deletion |
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
line (`\n\s*\n`) starts a new block, all typed `verse` by default - the user
then re-tags each block (Intro/Chorus/Bridge/...) and reorders/duplicates them
by tapping. Text edits happen inline: clicking a line edits just that line
(`setLine`/`duplicateLine` in `lyrics.js`), while a dedicated "edit whole
block" button in `BlockCard.jsx`'s toolbar switches the block to a full
textarea for multi-line rewrites. Each stored block still has an
`importance` field (1-5) for backward compatibility, but it's no longer read
or edited anywhere in the UI - it's dead weight kept only so old project files
keep loading unchanged.

In the lyrics stage, blocks can be split further several ways, all backed by
pure functions in [`lyrics.js`](../frontend/src/lib/lyrics.js) so the stage
never needs a backend round-trip beyond the generic project `PATCH`:
- Per-line "split here"/"duplicate line"/"wrap in brackets" icon buttons to
  the left of each line, and a red "delete line" icon at the end of it, in
  [`BlockCard.jsx`](../frontend/src/components/workflow/BlockCard.jsx),
  backed by `splitBlockAtLine` (both halves keep the original block's
  type/importance), `duplicateLine`, `toggleLineBrackets`, and `deleteLine`.
  The "split here" icon is hidden (via `visibility`, not unmounted) on a
  block's last line so every line's text stays left-aligned regardless of
  button count. The whole-block textarea (opened via the toolbar's "edit
  whole block" button) sets its `rows` from the current line count so it
  always shows the full text instead of a fixed, possibly-clipped height.
- A one-time "split into groups of N lines" control, shown only while a
  project has exactly one block (i.e. right after a raw paste), backed by
  `splitBlockEveryN`.
- A second, icon-only type-chip next to the normal type selector clones the
  block into a new type instead of retyping it in place, backed by
  `cloneBlockWithType`.
- Setting a block's type to `intro`/`outro` (via either type-chip) jumps it to
  the start/end of the block list, via `moveToEdgeForType`. A block can also
  be jumped to the start/end manually at any time via two extra buttons next
  to the up/down movers, backed by the more general `moveBlockToEdge` (which
  `moveToEdgeForType` is built on top of). These four move buttons live in
  their own vertical rail along the full left edge of the block card
  (`.block-move` in `BlockCard.jsx`/`theme.css`), separate from the toolbar
  row above the lyric text.
- "Repeat Chorus" is a one-shot button (not a persistent toggle) that
  physically inserts a chorus-block clone after every verse block, via
  `repeatChorusAfterVerses` - `project.auto_repeat_chorus` no longer exists,
  and `compileLyrics` is now a plain `{type, content}` mapper with no
  auto-repeat branch.
- A configurable list of Suno meta-tags (e.g. `[Vocal Interlude]`), edited in
  Settings (`special_tags` in `app_data/settings.json`, default seeded in
  `DEFAULT_SETTINGS` in
  [`app/routers/settings.py`](../backend/app/routers/settings.py)), can be
  inserted before/after a block via a popover or a `1`-`9` keyboard shortcut
  while the block is focused, via `insertBlockAdjacent`. These inserted blocks
  always get type `interlude`, which `BlockCard.jsx` renders as a compact,
  single-line "tag" card instead of a normal block: the type-chip shows the
  tag text itself (content with its outer brackets stripped) rather than the
  "Interlude" type label, the per-line editor/clone-as-type/voice/edit-whole
  buttons are hidden (there's no real text to edit), and the move rail is
  reduced to just the up/down buttons. `formatLyrics` in `lyrics.js` mirrors
  this in the compiled output: `interlude` segments are emitted as their raw
  content with no `[TypeLabel]` wrapper, since the content is already the
  full tag (e.g. `[Vocal Interlude]`).

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
