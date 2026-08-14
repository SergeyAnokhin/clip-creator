"""Magic-layer routes: decompose one project image into movable RGBA layers,
poll the job, delete a finished group.

Provider: `providers/magic_layers.py`. Decomposition takes 15-30s, so this
uses the async job + poll shape (`title-card/generate`), not the synchronous
one `images/{id}/crop` and `remove-background` use.

The result is project-level (`project.magic_layer_groups[]`) rather than
attached to the scene image or title-card variant it came from - one group is
reusable by every poster, and all three entry points (Images stage, Title Card
gallery, Poster constructor) address it by the same `source_path`.
"""

from fastapi import APIRouter, Body, HTTPException

from .. import storage, usage
from ..providers import magic_layers
from .generation_common import _now, _resolve_reference_path
from .settings import DEFAULT_SETTINGS

router = APIRouter(prefix='/api/projects', tags=['generation'])

_SOURCE_KINDS = ('scene_image', 'title_card_variant', 'reference')


@router.post('/{project_id}/magic-layers')
async def start_magic_layers(project_id: str, body: dict = Body(default={})):
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')

    source_path = (body.get('source_path') or '').strip()
    if not source_path:
        raise HTTPException(422, 'source_path is required')
    _resolve_reference_path(project_id, source_path)

    source_kind = body.get('source_kind')
    source_kind = source_kind if source_kind in _SOURCE_KINDS else 'scene_image'
    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    usage_ctx = usage.context('magic_layers', project_id, settings)
    try:
        job_id = magic_layers.start_job(
            project_id, source_path, source_kind, settings,
            num_layers=body.get('num_layers'), method=body.get('method'), usage_ctx=usage_ctx,
        )
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {'job_id': job_id}


@router.get('/{project_id}/magic-layers/jobs/{job_id}')
async def get_magic_layers_job(project_id: str, job_id: str):
    job = magic_layers.get_job(job_id)
    if job is None:
        raise HTTPException(404, 'Job not found')
    return job


@router.delete('/{project_id}/magic-layers/{group_id}')
async def delete_magic_layer_group(project_id: str, group_id: str):
    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')

        groups = project.get('magic_layer_groups', [])
        target = next((g for g in groups if g.get('group_id') == group_id), None)
        if target is None:
            raise HTTPException(404, 'Group not found')

        remaining = [g for g in groups if g.get('group_id') != group_id]
        project['magic_layer_groups'] = remaining
        project['updated_at'] = _now()
        storage.save_project(project_id, project)

    project_root = storage.project_dir(project_id)
    for layer in target.get('layers', []):
        file_path = project_root / layer['file_path']
        if file_path.is_file():
            file_path.unlink()
    group_dir = project_root / 'magic' / group_id
    if group_dir.is_dir() and not any(group_dir.iterdir()):
        group_dir.rmdir()

    return {'magic_layer_groups': remaining}
