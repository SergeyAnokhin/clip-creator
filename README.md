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

## Documentation

| Doc | Covers |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | How frontend, backend, and storage fit together |
| [CLAUDE.md](CLAUDE.md) | Working conventions for AI-assisted changes in this repo |
| [docs/specs/](docs/specs/) | Frozen V1 product specification (reference only) |
