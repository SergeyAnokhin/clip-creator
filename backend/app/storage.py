import asyncio
import json
import os
import shutil
from pathlib import Path
from typing import Optional

_project_locks: dict[str, asyncio.Lock] = {}


def get_data_root() -> Path:
    return Path(os.environ.get('APP_DATA_DIR') or Path(__file__).resolve().parent.parent / 'app_data')


def projects_dir() -> Path:
    d = get_data_root() / 'projects'
    d.mkdir(parents=True, exist_ok=True)
    return d


def _redirects_file() -> Path:
    return get_data_root() / 'projects' / '_redirects.json'


def load_redirects() -> dict[str, str]:
    f = _redirects_file()
    if not f.is_file():
        return {}
    return json.loads(f.read_text(encoding='utf-8'))


def save_redirect(old_slug: str, new_slug: str) -> None:
    """Records that `old_slug`'s folder was renamed to `new_slug` (see
    routers/projects.py::patch_project). `resolve_slug` below follows this
    chain so every existing caller - including a background generation job
    that captured `old_slug` before the rename and only saves its result
    30-90s later - transparently lands in the renamed folder instead of
    recreating an orphaned old one."""
    redirects = load_redirects()
    redirects[old_slug] = new_slug
    projects_dir()  # ensure the parent dir exists
    _redirects_file().write_text(json.dumps(redirects, ensure_ascii=False, indent=2), encoding='utf-8')


def resolve_slug(slug: str) -> str:
    """Follows the rename-redirect chain to a project's current folder name -
    but only when `slug` isn't itself a real, currently-existing project.
    Slugs are content-derived (author+title) and not permanently unique: a
    project's *old* slug, once redirected away from, is just a string, and an
    entirely unrelated project can legitimately hold that exact string as its
    own real, current `id` (confirmed live, 2026-08 - a still-default
    "Неизвестный автор - Новое стихотворение" project got silently redirected
    into a *different*, already-renamed project's folder because that exact
    string happened to be the other project's old address). Checking for a
    real folder first makes a redirect apply only to genuinely vacated
    addresses, which is the only case it's meant for. Loop-guarded in case of
    a redirect cycle (shouldn't happen, but a broken chain must never hang)."""
    if (projects_dir() / slug / 'config.json').is_file():
        return slug
    redirects = load_redirects()
    seen = set()
    while slug in redirects and slug not in seen:
        seen.add(slug)
        slug = redirects[slug]
    return slug


def project_dir(slug: str) -> Path:
    return projects_dir() / resolve_slug(slug)


def project_file(slug: str) -> Path:
    return project_dir(slug) / 'config.json'


def settings_file() -> Path:
    root = get_data_root()
    root.mkdir(parents=True, exist_ok=True)
    return root / 'settings.json'


def usage_dir() -> Path:
    d = get_data_root() / 'usage'
    d.mkdir(parents=True, exist_ok=True)
    return d


def model_catalog_file() -> Path:
    root = get_data_root()
    root.mkdir(parents=True, exist_ok=True)
    return root / 'model_catalog.json'


def list_projects() -> list[dict]:
    out = []
    for d in sorted(projects_dir().iterdir()):
        f = d / 'config.json'
        if f.is_file():
            out.append(json.loads(f.read_text(encoding='utf-8')))
    return out


def load_project(slug: str) -> Optional[dict]:
    f = project_file(slug)
    if not f.is_file():
        return None
    return json.loads(f.read_text(encoding='utf-8'))


def save_project(slug: str, data: dict) -> None:
    project_dir(slug).mkdir(parents=True, exist_ok=True)
    project_file(slug).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')


def project_lock(slug: str) -> asyncio.Lock:
    """Per-project lock for the load-mutate-save sequence every project
    mutation follows (`load_project` -> change a field -> `save_project`).
    Without it, two of these sequences overlapping - e.g. two background
    scene-image generation jobs finishing around the same moment, each for a
    different scene of the same project - can silently lose an update: job B
    loads its snapshot before job A's save lands, so B's later save
    overwrites A's change with B's own stale copy of the project (confirmed
    against a real project on disk, 2026-08, where 8 of 9 just-generated
    scene images vanished from `config.json` this way despite their files
    surviving untouched in `images/`). `async with project_lock(slug):`
    around the whole load-mutate-save block serializes those sequences per
    project - unrelated projects still save fully concurrently since each
    slug gets its own lock. One lock per slug is enough because
    `load_project`/`save_project` are synchronous (no `await` inside), so
    once a coroutine acquires the lock nothing else can interleave with its
    critical section until it releases. Resolves the rename-redirect chain
    first, so a job started under the old slug and a request already using
    the renamed one share the same lock instead of two independent ones."""
    slug = resolve_slug(slug)
    lock = _project_locks.get(slug)
    if lock is None:
        lock = _project_locks[slug] = asyncio.Lock()
    return lock


def delete_project(slug: str) -> None:
    d = project_dir(slug)
    if d.is_dir():
        shutil.rmtree(d)


def load_settings() -> dict:
    f = settings_file()
    if not f.is_file():
        return {}
    return json.loads(f.read_text(encoding='utf-8'))


def save_settings(data: dict) -> None:
    settings_file().write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')


def load_model_catalog() -> dict:
    """Last-known-good model list per provider, kept across restarts so the
    Settings "Models"/"Prices" tabs have something to show before anyone
    presses "Refresh models". Shape: {'text': {provider: {source, models,
    error}}, 'image': {provider: {...}}} - same entry shape `list_models`
    already returns."""
    f = model_catalog_file()
    if not f.is_file():
        return {'text': {}, 'image': {}}
    data = json.loads(f.read_text(encoding='utf-8'))
    return {'text': data.get('text') or {}, 'image': data.get('image') or {}}


def save_model_catalog(data: dict) -> None:
    model_catalog_file().write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
