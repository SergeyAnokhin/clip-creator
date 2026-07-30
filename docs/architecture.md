# Architecture

Versecraft is a two-process local app: a React (Vite) frontend talks over HTTP
to a FastAPI backend, which persists everything as JSON files on disk. There is
no database and no auth — it's single-user. AI generation is **stubbed** behind
provider seams (see below).

```text
┌───────────────┐   fetch /api/*   ┌─────────────────┐   read/write JSON   ┌───────────────┐
│ frontend/src  │ ───────────────► │ backend/app     │ ──────────────────► │ app_data/     │
│ (Vite, :5174) │ ◄─────────────── │ (FastAPI, :8000)│ ◄────────────────── │ (git-ignored) │
└───────────────┘      JSON        └─────────────────┘                     └───────────────┘
```

Companion docs: [code-map.md](code-map.md) (which file does what),
[data-model.md](data-model.md) (JSON shapes and API routes).

## Running

`npm run dev` from the repo root starts both servers via `concurrently` (see
[`package.json`](../package.json)). The Vite port is pinned to **5174** (not the
default 5173) to avoid clashing with other local projects — it must match the
CORS origin in [`main.py`](../backend/app/main.py).

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
[`scenes.py`](../backend/app/providers/scenes.py) and
[`images.py`](../backend/app/providers/images.py) return deterministic canned
data and make **no network calls**. Routers call them and don't know the
difference, so wiring in real OpenAI/Anthropic/Suno/FLUX calls (keys come from
`app_data/settings.json`) means editing only these three files.

- `suno.generate` recomputes `lyrics` from the project's *current* blocks every
  time, so Lyrics-stage edits always show up; `style` is a canned string.
- `scenes.generate` chunks the non-`interlude` lines into `scene_count` even,
  ordered pieces and derives canned prompts from each chunk's first line.
- `images.generate` is a stub that still writes **real files** — one
  placeholder SVG per variant — so the media-serving path is genuinely
  exercised.

Not implemented at all: real speech-to-text (the mic buttons are a timed fake
transcript, matching the design mock) and any real image model.

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
