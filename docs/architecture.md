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
| [`app/routers/generation.py`](../backend/app/routers/generation.py) | `POST /api/projects/{id}/suno/generate`, `POST /api/projects/{id}/suno/refine`, `POST /api/projects/{id}/scenes/generate`, `POST /api/projects/{id}/scenes/{n}/images`, `POST`/`DELETE /api/projects/{id}/reference-images[/{filename}]` |

A project is one JSON file: `app_data/projects/<slug>/config.json`. There's no
schema migration system - the file is whatever shape `storage.save_project`
last wrote, since a single-user local app doesn't need one yet.

### AI provider seams

[`app/providers/suno.py`](../backend/app/providers/suno.py),
[`app/providers/scenes.py`](../backend/app/providers/scenes.py) and
[`app/providers/images.py`](../backend/app/providers/images.py) are **stubs**:
they return deterministic canned/derived data (no network calls). They exist
as a deliberate seam - routers call `providers.suno.generate(project, ...)` /
`providers.suno.refine(project, comment)` /
`providers.scenes.generate(project, style_description, reference_images, scene_count)` /
`providers.images.generate(slug, scene_index, existing_images, count, model)`
and don't know or care whether that's a stub or a real
OpenAI/Anthropic/Suno/FLUX/DALL-E call. Wiring in the real APIs (using the
keys from `app_data/settings.json`) means editing only these three files.
Tests (`backend/tests/test_generation.py`) mock the suno/scenes seams the same
way, so those calls never hit the network - `images.generate` is exercised
unmocked instead, since it's already a real (if placeholder) file-write, not a
network call; see "Scenes stage" below.

### Suno stage: skills, refinement, and generation

Per [`docs/specs/spec3.md`](specs/spec3.md), the Suno stage
([`SunoStage.jsx`](../frontend/src/components/workflow/SunoStage.jsx)) picks
an AI "skill" (a base instruction template), lets the user tweak it by hand or
via a free-text "wish", then generates a `style`/`lyrics` pair for Suno:

- **Skills** are defined once, in `SKILLS` in `SunoStage.jsx` (`skill_a`
  "Suno Structure & Style Pro", `skill_b` "Suno Lyrics Adapter"), each with a
  `template` string. Clicking a skill chip sets both `project.skill_id` and
  replaces `project.skill_prompt` with that skill's template
  (`selectSkill` in [`App.jsx`](../frontend/src/App.jsx)) - selection is no
  longer cosmetic. The prompt textarea remains freely editable afterwards
  (manual edit, spec 3.2.1).
- **Refinement** ("AI-wish", spec 3.2.2) goes through
  `POST /api/projects/{id}/suno/refine` (`refine_suno` in
  [`app/routers/generation.py`](../backend/app/routers/generation.py)), which
  calls the `providers.suno.refine` seam - a deterministic stub that folds the
  comment into the current `skill_prompt` as a plain instruction sentence -
  and appends the raw comment to `project.refinement_comments` (shown as a
  small history list under the refinement panel). This replaces the earlier
  behavior of appending a `// Refined: ...` code-comment to the prompt purely
  client-side.
- **Generation** (`POST /api/projects/{id}/suno/generate`) takes
  `{skill_id, skill_prompt, model}` from the frontend (the active skill, its
  current - possibly hand-edited - prompt, and the globally configured
  default text model from Settings) and persists all three onto the project
  alongside the result, plus `model_used`. The stub's `lyrics` output is
  always recomputed from the project's *current* `blocks` via
  `_format_lyrics` in `suno.py` (mirroring `formatLyrics`/`compileLyrics` in
  [`lyrics.js`](../frontend/src/lib/lyrics.js): English type labels, raw
  passthrough for `interlude` blocks) rather than ever reusing a previously
  cached value - so edits made in the Lyrics stage (reordering, Repeat
  Chorus, inserted tags) are reflected the next time "Generate for Suno" is
  clicked. `style` still falls back to a single canned string (no real
  model call), consistent with the rest of this seam.

### Scenes stage: storyboard, images, references

Per [`docs/specs/spec4.md`](specs/spec4.md), the Scenes stage
([`ScenesStage.jsx`](../frontend/src/components/workflow/ScenesStage.jsx))
turns the lyrics into a 5-scene storyboard, then generates and rates images
per scene:

- **Storyboard generation** ("Generate storyboard", spec 4.1/4.2) goes
  through `POST /api/projects/{id}/scenes/generate`
  (`generate_scenes` in [`generation.py`](../backend/app/routers/generation.py)),
  which calls the `providers.scenes.generate` seam with the project's current
  `blocks`, a free-text `style_description` (a plain field on the project,
  edited in a textarea above the scene list), and any uploaded
  `reference_images`. The stub (`providers/scenes.py`) flattens all
  non-`interlude` block lines (same skip rule as `suno._format_lyrics`),
  splits them into `scene_count` (default 5) ~even ordered chunks, and
  derives a canned `static_prompt`/`motion_prompt` per scene from the
  chunk's first line (`lyric_segment`) and the style description. This
  **replaces** `project.scenes` wholesale (including resetting every scene's
  `images` to `[]`) - re-running it is the spec's "regenerate the whole
  pack", not an images-only refresh. New projects start with `scenes: []`
  (no storyboard) until this is run at least once, rather than pre-filled
  blank stubs.
- **Reference images** (spec 4.1's "uploaded picture references" alternative
  to a text style description) upload via `POST /api/projects/{id}/reference-images`
  (multipart `file`) and delete via
  `DELETE /api/projects/{id}/reference-images/{filename}`. Files are written
  under `app_data/projects/<slug>/references/` with a random
  `ref_{uuid}.<ext>` name (the client's filename is never trusted, so there's
  no path-traversal surface), and the relative path is appended to
  `project.reference_images`. The stub only uses the *count* of reference
  images (folded into the generated prompt text as a mention) - no real
  vision analysis.
- **Per-scene prompt edits** (`static_prompt`/`motion_prompt` textareas) are
  plain debounced `PATCH`es like the Suno skill prompt, and voice edit is the
  same UI-only simulation as elsewhere in the app.
- **Image generation** (`POST /api/projects/{id}/scenes/{n}/images`, body
  `{count, model}`) calls `providers.images.generate`, which is a stub but
  writes **real files**: a deterministic placeholder SVG (colored rect +
  "Scene N Var M" text) per requested variant, saved to
  `app_data/projects/<slug>/images/scene_{n}_var_{m}.svg` and returned as
  `{image_id, file_path, rating: 0, is_selected: false, generated_at}`.
  `count` is user-controlled (a stepper next to the model chips, 0-4,
  default 1) - spec 4.3's "0, 1, or several variants" - and previous variants
  are never deleted, only appended to (`var_num` continues from
  `len(existing_images)`), so re-generating builds a history rather than
  replacing it.
- **Serving images**: [`main.py`](../backend/app/main.py) mounts
  `StaticFiles` at `/media` over the whole `app_data/` root, so a scene image
  is reachable at `/media/projects/<slug>/images/scene_1_var_1.svg` and a
  reference image at `/media/projects/<slug>/references/ref_xxxxxxxx.png`.
  `mediaUrl(path)` in [`api/client.js`](../frontend/src/api/client.js) builds
  that URL; [`ImageThumb.jsx`](../frontend/src/components/workflow/ImageThumb.jsx)
  renders a real `<img>` and falls back to a text placeholder (via
  `onError`) if the file is missing or fails to load - this also covers the
  three seeded demo projects, whose sample `images` entries reference
  `file_path`s that were never actually generated on disk.
- **Rating & main-frame selection** (spec 4.4): each image gets a 1-5 star
  `rating`. Rating an image runs the scene's `images` through
  `pickMainByRating` (pure, unit-tested in
  [`lib/scenes.js`](../frontend/src/lib/scenes.js)/`scenes.test.js`), which
  sets `is_selected` on the single highest-rated image (ties keep whichever
  was already selected if it's among the tied max, otherwise the first tied
  image) - "the highest-rated variant automatically becomes the scene's main
  frame". Clicking an image's frame directly still sets `is_selected`
  manually, overriding the automatic pick (e.g. useful when every image in a
  scene is still rated 0).
- **Autosave race**: `style_description`/prompt edits autosave via a 400ms
  debounce that `PATCH`es the *entire* project object
  (`updateProject(..., {immediate:false})` in [`App.jsx`](../frontend/src/App.jsx)).
  Because storyboard/image generation replace `project.scenes` server-side
  from a fresh disk read, a debounced save scheduled *before* one of those
  calls could otherwise land *after* it and silently revert the fresh
  `scenes` to a stale snapshot. `flushPendingSave()` (cancels the pending
  debounce and synchronously `PATCH`es the current state first) is called at
  the start of `generateStoryboard()` and `generateSceneImages()` to close
  this window.

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

### URL parsing for "New Workflow"

When "New Workflow" is submitted with a `url` and no pasted `raw_text`,
[`app/providers/url_parser.py`](../backend/app/providers/url_parser.py)
fetches the page (`httpx`) and extracts `{author, title, raw_text}` with a
generic, non-site-specific heuristic (`BeautifulSoup`, stdlib `html.parser`):
title from `<h1>` (falling back to `<title>`, with a common
` | Site Name`-style suffix stripped), author from a `<meta name="author">` /
`<meta property="article:author">` tag or a `rel="author"` element, and body
text from the first of `<pre>`, `<article>`, `<main>`, or (as a last resort)
the element with the most text on the page - `<script>`/`<nav>`/`<header>`/
`<footer>`/etc. are stripped first. `<br>` tags and block-level tag
boundaries (`<p>`, `<div>`, ...) become line breaks, so an empty `<p></p>`
spacer or a double `<br><br>` between stanzas is preserved as a blank line
for `_split_into_blocks` to split on downstream.

This is a best-effort heuristic, not a scraper tuned to any particular poetry
site - it extracts cleanly from pages with `<article>`/`<main>`/`<pre>`
semantic markup and an author meta tag, but on pages without that structure
(e.g. a Wikisource article, which wraps the poem in generic `<div>`s among
nav/category chrome) it can pull in surrounding page text along with the
poem. There's no user-facing preview step before the project is created -
the same "fix it in the Lyrics stage" expectation already applies to the
pasted-text path (blocks are freely editable/deletable there). If the fetch
fails (network error, non-2xx, timeout) or `url` is empty, `create_project`
falls back to the placeholder-project behavior unchanged.

### Not implemented yet

- Real speech-to-text for the voice-input buttons.
- Real AI provider calls (see above) - including the scene splitter and
  image generation, both still deterministic stubs (the image stub does
  write real placeholder SVG files, per "Scenes stage" above, but the
  pixels themselves aren't AI-generated).

## Testing

- Frontend: `npm run test --prefix frontend` (Vitest) - covers the lyrics
  compilation/reordering logic in [`src/lib/lyrics.test.js`](../frontend/src/lib/lyrics.test.js)
  and the scenes-stage rating/main-frame logic in
  [`src/lib/scenes.test.js`](../frontend/src/lib/scenes.test.js).
- Backend: `pytest backend/tests` - covers slug sanitization, the project
  CRUD round-trip against a temp storage root, the generation routes against
  mocked provider seams (suno, scene-splitter), the URL parser (`extract()`
  unit tests against raw HTML, no network; the `url` project-creation path
  with `url_parser.parse` mocked so it never hits the network either), and
  the scenes stage's real file-writing behavior unmocked - image generation
  writing an actual SVG under the temp `APP_DATA_DIR`, and reference-image
  upload/delete round-tripping a real file.
- `npm test` from the repo root runs both.
