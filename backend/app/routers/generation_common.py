"""Helpers shared by the four `generation_*.py` route modules.

Nothing here owns a route - each domain module registers its own
`APIRouter` under the same `/api/projects` prefix (see `main.py`).
"""

from datetime import datetime, timezone

from fastapi import HTTPException

from .. import storage


_ALLOWED_VIDEO_EXTENSIONS = {'.mp4', '.mov', '.webm', '.mkv'}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def _resolve_reference_path(project_id: str, path: str) -> None:
    """Rejects a `title-card/generate` reference path that doesn't stay
    inside the project's own folder or doesn't exist - `path` is one of the
    strings the client already got back from us (a scene image or a
    project reference image), never user-typed, but this stays defense in
    depth against a tampered request."""
    project_root = storage.project_dir(project_id).resolve()
    candidate = (project_root / path).resolve()
    if project_root not in candidate.parents or not candidate.is_file():
        raise HTTPException(422, f'Некорректный путь к референсному изображению: {path}')
