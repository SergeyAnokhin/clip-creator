# clip-creator (Versecraft)

A workflow tool that turns a poem into song lyrics/style for Suno and an AI-generated
scene/image storyboard. See [`docs/specs/`](docs/specs/) for the original product
specification (reference only, not kept in sync with the code — see
[CLAUDE.md](CLAUDE.md)).

- **Frontend**: React (Vite) — [`frontend/`](frontend/)
- **Backend**: FastAPI (Python) — [`backend/`](backend/)
- **Storage**: local JSON files under `app_data/` (git-ignored), one folder per
  project — see [docs/architecture.md](docs/architecture.md)

## Running locally

Install dependencies once:

```bash
npm install
npm install --prefix frontend
python -m venv backend/.venv
backend/.venv/Scripts/pip install -r backend/requirements.txt
```

Then, from the repo root:

```bash
npm run dev
```

This starts both dev servers together (labeled `FRONTEND`/`BACKEND` in one
console): the frontend on http://localhost:5174 and the backend on
http://localhost:8000.

Run tests for both sides:

```bash
npm test
```

## Local test data

[`docs/examples/poem-to-lyrics/`](docs/examples/poem-to-lyrics/) holds 7
hand-written `INPUT:` / `OUTPUT:` pairs — a raw Russian poem and the
Suno-formatted lyrics it should turn into. Use them as the reference set when
working on the lyrics builder or on the (currently stubbed) Suno provider,
instead of inventing sample poems.

## Documentation

| Doc | Covers |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | How it fits together, the 3-stage workflow, provider seams, gotchas |
| [docs/code-map.md](docs/code-map.md) | Which file does what — start here to find where to change something |
| [docs/data-model.md](docs/data-model.md) | JSON shapes on disk + the full API route table |
| [CLAUDE.md](CLAUDE.md) | Working conventions for AI-assisted changes in this repo |
| [docs/specs/](docs/specs/) | Frozen V1 product specification (reference only) |
