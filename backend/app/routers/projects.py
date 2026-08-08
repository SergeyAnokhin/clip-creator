import re
import shutil
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Body, HTTPException

from .. import storage
from ..models import ProjectCreate
from ..providers import url_parser
from ..slug import make_slug

router = APIRouter(prefix='/api/projects', tags=['projects'])

DEFAULT_SKILL_PROMPT = 'Transform the following structured lyrics into a music-service-ready format using strict bracket tags.'


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def migrate_legacy_project(project: dict) -> dict:
    """One-time reset for projects created before the AI-wish library
    rework: `active_wish_ids` (see suno "Доработка через AI-пожелание")
    didn't exist yet, and `skill_prompt` may hold text folded in by the old
    `suno.refine()` flow (now removed) along with `refinement_comments`
    history that's no longer shown anywhere. Detected by the *absence* of
    `active_wish_ids`, so this only ever fires once per project - the reset
    fields are saved back immediately."""
    if 'active_wish_ids' in project:
        return project
    project['skill_prompt'] = DEFAULT_SKILL_PROMPT
    project['refinement_comments'] = []
    project['active_wish_ids'] = []
    storage.save_project(project['id'], project)
    return project


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
async def create_project(body: ProjectCreate):
    now = _now()
    author, title, raw_text = 'Неизвестный автор', 'Новое стихотворение', body.raw_text

    if not raw_text.strip() and body.url.strip():
        parsed = await url_parser.parse(body.url)
        if parsed:
            author = parsed['author'] or author
            title = parsed['title'] or title
            raw_text = parsed['raw_text']

    base_slug = make_slug(author, title)
    slug, i = base_slug, 2
    while storage.load_project(slug) is not None:
        slug = f'{base_slug}-{i}'
        i += 1

    blocks = _split_into_blocks(raw_text) if raw_text.strip() else [
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
        'skill_id': 'skill_a',
        'skill_prompt': DEFAULT_SKILL_PROMPT,
        'refinement_comments': [],
        'active_wish_ids': [],
        'style': '',
        'lyrics': '',
        'model_used': '',
        'track_url': '',
        'scenes': [],
        'style_description': '',
        'scene_mode': 'narrative',
        'active_scene_wish_ids': [],
        'reference_images': [],
        'source_url': body.url,
    }
    storage.save_project(slug, project)
    return project


@router.get('/{project_id}')
def get_project(project_id: str):
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')
    return migrate_legacy_project(project)


@router.patch('/{project_id}')
def patch_project(project_id: str, patch: dict = Body(...)):
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')
    project = migrate_legacy_project(project)
    project.update(patch)
    project['updated_at'] = _now()

    # `title`/`author` are already live everywhere they're displayed
    # (WorkflowHeader.jsx, ProjectCard.jsx read the fields directly) - only
    # the folder name/`id` (fixed at creation from spec 1.1's "[Author] -
    # [Title]" slug) used to lag behind. Rename the folder to match,
    # uniquified the same way create_project above picks a free slug, and
    # leave a redirect (storage.save_redirect) so any background job that
    # captured the *old* slug before this rename - e.g. a Mureka generation
    # still running - still finds the right folder when it saves its result
    # later (storage.project_dir/project_lock resolve the redirect first).
    #
    # `'title' in patch` isn't a "did the user just edit the title field"
    # check - useProjects.js's `updateProject`/`flushPendingSave` always
    # PATCH the *whole* project object, so both keys are present on
    # virtually every save. That's fine: the real gate is `new_slug !=
    # current_slug` below, so this also self-heals any project whose folder
    # name was already stale (e.g. from before this rename logic existed)
    # the next time it's saved for any reason, not only on an explicit
    # title/author edit.
    current_slug = storage.resolve_slug(project_id)
    if 'title' in patch or 'author' in patch:
        new_slug = make_slug(project.get('author', ''), project.get('title', ''))
        if new_slug != current_slug:
            slug, i = new_slug, 2
            while slug != current_slug and storage.load_project(slug) is not None:
                slug = f'{new_slug}-{i}'
                i += 1
            if slug != current_slug:
                shutil.move(str(storage.project_dir(current_slug)), str(storage.project_dir(slug)))
                storage.save_redirect(current_slug, slug)
                project['id'] = slug
                current_slug = slug

    storage.save_project(current_slug, project)
    return project


@router.delete('/{project_id}', status_code=204)
def delete_project(project_id: str):
    if storage.load_project(project_id) is None:
        raise HTTPException(404, 'Project not found')
    storage.delete_project(project_id)
