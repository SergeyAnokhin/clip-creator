import re
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Body, HTTPException

from .. import storage
from ..models import ProjectCreate
from ..slug import make_slug

router = APIRouter(prefix='/api/projects', tags=['projects'])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def _split_into_blocks(raw_text: str) -> list[dict]:
    """Splits pasted poem text into blocks. Per docs/specs/spec2.md 2.2: each
    blank line separates the text into a new block; the user classifies and
    reorders the resulting blocks afterwards via the lyrics builder UI."""
    paragraphs = [p.strip() for p in re.split(r'\n\s*\n', raw_text.strip())]
    paragraphs = [p for p in paragraphs if p]
    return [
        {'id': f'blk_{uuid4().hex[:8]}', 'type': 'verse', 'importance': 3, 'content': p}
        for p in paragraphs
    ]


def _to_summary(p: dict) -> dict:
    scenes = p.get('scenes', [])
    return {
        'id': p['id'],
        'author': p['author'],
        'title': p['title'],
        'date': p.get('updated_at', p.get('created_at')),
        'tags': p.get('tags', []),
        'suno_done': bool(p.get('style')),
        'scenes_ready': sum(1 for s in scenes if s.get('images')),
        'scenes_total': len(scenes),
    }


@router.get('')
def list_projects():
    return [_to_summary(p) for p in storage.list_projects()]


@router.post('', status_code=201)
def create_project(body: ProjectCreate):
    # Real link parsing (title/author/text extraction from a URL) is still a
    # stub - see docs/architecture.md. Pasted raw text, however, is split
    # into blocks for real (see _split_into_blocks below).
    now = _now()
    author, title = 'Неизвестный автор', 'Новое стихотворение'
    base_slug = make_slug(author, title)
    slug, i = base_slug, 2
    while storage.load_project(slug) is not None:
        slug = f'{base_slug}-{i}'
        i += 1

    blocks = _split_into_blocks(body.raw_text) if body.raw_text.strip() else [
        {'id': f'blk_{uuid4().hex[:8]}', 'type': 'intro', 'importance': 3, 'content': 'Новый импортированный текст появится здесь.'},
    ]

    project = {
        'id': slug,
        'author': author,
        'title': title,
        'created_at': now,
        'updated_at': now,
        'tags': ['Intro'],
        'blocks': blocks,
        'skill_prompt': 'Transform the following structured lyrics into a Suno-ready format using strict bracket tags.',
        'style': '',
        'lyrics': '',
        'track_url': '',
        'scenes': [{'static_prompt': '', 'motion_prompt': '', 'images': []} for _ in range(5)],
        'source_url': body.url,
    }
    storage.save_project(slug, project)
    return project


@router.get('/{project_id}')
def get_project(project_id: str):
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')
    return project


@router.patch('/{project_id}')
def patch_project(project_id: str, patch: dict = Body(...)):
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')
    project.update(patch)
    project['updated_at'] = _now()
    storage.save_project(project_id, project)
    return project


@router.delete('/{project_id}', status_code=204)
def delete_project(project_id: str):
    if storage.load_project(project_id) is None:
        raise HTTPException(404, 'Project not found')
    storage.delete_project(project_id)
