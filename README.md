# clip-creator (Versecraft)

A workflow tool that turns a poem into song lyrics/style for a music-generation
service (Suno, Mureka, ...), real audio tracks via the Mureka API, and an
AI-generated scene/image storyboard. See
[`docs/specs/`](docs/specs/) for the original product specification (reference
only, not kept in sync with the code — see [CLAUDE.md](CLAUDE.md)).

- **Frontend**: React (Vite) — [`frontend/`](frontend/)
- **Backend**: FastAPI (Python) — [`backend/`](backend/)
- **Storage**: local JSON files under `app_data/` (git-ignored), one folder per
  project — see [docs/architecture.md](docs/architecture.md)
- **AI usage & cost tracking**: every paid AI call is logged with tokens/cost,
  visible in the app's "Расходы"/Usage screen and a spend-today pill in every
  header — see [docs/usage-tracking.md](docs/usage-tracking.md). Built-in
  model prices are placeholders; verify them before trusting a total.

## Running locally

Install dependencies once:

```bash
npm install
npm install --prefix frontend
python -m venv backend/.venv
backend/.venv/Scripts/pip install -r backend/requirements.txt
```

Also install [`ffmpeg`](https://ffmpeg.org/) and make sure it's on your
`PATH` — the Mureka reference-audio trimmer shells out to it to cut a
selected window before uploading, and the Editor stage shells out to it to
render the final video (see [docs/architecture.md](docs/architecture.md)).
The app still runs without it, but those two features fail with a clear
error instead.

Then, from the repo root:

```bash
npm run dev
```

This starts both dev servers together (labeled `FRONTEND`/`BACKEND` in one
console): the frontend on http://localhost:5174 by default (falls back to the
next free port — see [docs/architecture.md](docs/architecture.md)) and the
backend on http://localhost:8020.

Run tests for both sides:

```bash
npm test
```

## Local test data

[`docs/examples/poem-to-lyrics/`](docs/examples/poem-to-lyrics/) holds 7
hand-written `INPUT:` / `OUTPUT:` pairs — a raw Russian poem and the
Suno-formatted lyrics it should turn into. Use them as the reference set when
working on the lyrics builder or on the music-prompt provider
([`backend/app/providers/suno.py`](backend/app/providers/suno.py) — makes a
real call to Google, OpenRouter or DeepSeek when the matching API key is
configured), instead of inventing sample poems.

**`app_data/projects/QA Fixture - Editor Timeline/`** (local-only,
git-ignored like the rest of `app_data/` — created once per machine, not
shipped in the repo) is a dedicated project for manually testing the Editor
stage ([`frontend/src/components/workflow/EditorStage.jsx`](frontend/src/components/workflow/EditorStage.jsx)
/ [`frontend/src/components/workflow/EditorTimeline.jsx`](frontend/src/components/workflow/EditorTimeline.jsx)
/ [`backend/app/providers/editor.py`](backend/app/providers/editor.py)):
dragging/trimming/splitting clips on the timeline, the duration-mismatch
warning, and rendering. **Use this project for that testing instead of a real
one** — the Editor stage autosaves `video_edit.clips` on every timeline edit,
so poking at a real project mutates its data immediately (this happened once
already and had to be repaired by hand). It has a real Mureka track and 6
scenes with real (reused, cropped) video files, covering edge cases that are
easy to regress and tedious to set up by hand through the UI (scene numbers
are 1-based, as shown in the app):

- Scene 3 has `aspect_ratio: "9:16"` while every other scene is `"16:9"` —
  the mixed-aspect-ratio letterboxing case, where the render canvas must
  stay the default `1920×1080` (it only switches to `1080×1920` when *every*
  clip is `9:16`).
- Scene 4's clip has `trim_end_ms: null` on a video with **known**
  `duration_seconds` — the "trim to end of source" case, which should fall
  back to that duration.
- Scene 5's video is `model: "upload"` with `duration_seconds` /
  `aspect_ratio` / `resolution` all `null` (an imported-by-hand clip, per
  `docs/data-model.md`'s `Video` note that an uploaded clip is never probed),
  also with `trim_end_ms: null` — unlike scene 4, the render must leave this
  clip's end genuinely unbounded (ffmpeg runs to EOF) instead of collapsing
  it to zero length.

If it's ever missing, regenerate it the same way it was built: pick a few
real `.mp4`s from any existing project, crop the horizontal ones to 16:9 with
ffmpeg (the source footage is portrait), reuse one vertical clip and one
upload-scenario clip as-is, copy one track's `.mp3`, and hand-write
`config.json` following `docs/data-model.md`'s `Scene` / `Video` /
`MurekaTrack` / `VideoEdit` shapes — do not recreate it by pointing the app
at a real project and copying its data.

## Documentation

| Doc | Covers |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | How it fits together, the 3-stage workflow, provider seams, gotchas |
| [docs/code-map.md](docs/code-map.md) | Which file does what — start here to find where to change something |
| [docs/data-model.md](docs/data-model.md) | JSON shapes on disk + the full API route table |
| [docs/usage-tracking.md](docs/usage-tracking.md) | AI usage ledger and cost tracking — record schema, pricing catalog (built-in prices are **unverified placeholders**, see the doc), how to instrument a new call site |
| [CLAUDE.md](CLAUDE.md) | Working conventions for AI-assisted changes in this repo |
| [docs/specs/](docs/specs/) | Frozen V1 product specification (reference only) |
