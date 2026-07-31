import json
import os
import shutil
from pathlib import Path
from typing import Optional


def get_data_root() -> Path:
    return Path(os.environ.get('APP_DATA_DIR') or Path(__file__).resolve().parent.parent / 'app_data')


def projects_dir() -> Path:
    d = get_data_root() / 'projects'
    d.mkdir(parents=True, exist_ok=True)
    return d


def project_dir(slug: str) -> Path:
    return projects_dir() / slug


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
