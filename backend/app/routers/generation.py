from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Body, File, HTTPException, UploadFile

from .. import storage, usage
from ..providers import images, scenes, suno, wish_library
from .projects import migrate_legacy_project
from .settings import DEFAULT_SETTINGS

router = APIRouter(prefix='/api/projects', tags=['generation'])

_ALLOWED_REFERENCE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp', '.gif'}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


@router.post('/{project_id}/suno/generate')
async def generate_suno(project_id: str, body: dict = Body(default={})):
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')
    project = migrate_legacy_project(project)

    skill_id = body.get('skill_id', project.get('skill_id', 'skill_a'))
    skill_prompt = body.get('skill_prompt', project.get('skill_prompt', ''))
    model = body.get('model', '')
    active_wish_ids = body.get('active_wish_ids', project.get('active_wish_ids', []))
    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    wish_lookup = {w['id']: w['text'] for w in wish_library.normalize_wish_library(settings.get('suno_wish_library', []))}
    active_wishes = [wish_lookup[wid] for wid in active_wish_ids if wid in wish_lookup]
    usage_ctx = usage.context('suno_generate', project_id, settings, skill_id=skill_id)

    try:
        result = await suno.generate(
            project, skill_prompt=skill_prompt, model=model, settings=settings,
            usage_ctx=usage_ctx, active_wishes=active_wishes,
        )
    except Exception as exc:
        raise HTTPException(502, f'Не удалось сгенерировать через {model or "провайдер"}: {exc}') from exc
    project['style'] = result['style']
    project['lyrics'] = result['lyrics']
    project['skill_id'] = skill_id
    project['skill_prompt'] = skill_prompt
    project['model_used'] = model
    project['updated_at'] = _now()
    storage.save_project(project_id, project)
    return {**result, 'skill_id': skill_id, 'model_used': model}


@router.post('/{project_id}/suno/wishes')
async def add_suno_wish(project_id: str, body: dict = Body(...)):
    """Cleans+titles the user's free-text wish (dictated or typed), saves it
    to the global, cross-project settings.suno_wish_library (or reuses an
    existing entry with the same text - see wish_library.add_or_get_wish),
    and immediately activates it for this project. Replaces the old
    suno/refine flow, which destructively folded the wish into skill_prompt
    instead of keeping it as a reusable, toggleable card."""
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')
    project = migrate_legacy_project(project)

    text = (body.get('text') or '').strip()
    if not text:
        raise HTTPException(422, 'text is required')

    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    usage_ctx = usage.context('wish_title', project_id, settings)
    result = await wish_library.add_or_get_wish(text, settings, usage_ctx=usage_ctx)
    wish = result['wish']

    active_wish_ids = project.get('active_wish_ids', [])
    if wish['id'] not in active_wish_ids:
        active_wish_ids = [*active_wish_ids, wish['id']]
    project['active_wish_ids'] = active_wish_ids
    project['updated_at'] = _now()
    storage.save_project(project_id, project)
    return {'wish': wish, 'suno_wish_library': result['wish_library'], 'active_wish_ids': active_wish_ids}


@router.post('/{project_id}/scenes/generate')
async def generate_scenes(project_id: str, body: dict = Body(default={})):
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')

    style_description = body.get('style_description', project.get('style_description', ''))
    scene_count = body.get('scene_count', scenes.DEFAULT_SCENE_COUNT)
    model = body.get('model', '')
    scene_mode = body.get('scene_mode', project.get('scene_mode', 'narrative'))
    active_scene_wish_ids = body.get('active_scene_wish_ids', project.get('active_scene_wish_ids', []))
    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    scene_wish_lookup = {w['id']: w['text'] for w in wish_library.normalize_wish_library(settings.get('scene_wish_library', []))}
    active_wishes = [scene_wish_lookup[wid] for wid in active_scene_wish_ids if wid in scene_wish_lookup]
    usage_ctx = usage.context('scene_storyboard', project_id, settings, scene_mode=scene_mode)

    try:
        result = await scenes.generate(
            project,
            style_description=style_description,
            reference_images=project.get('reference_images', []),
            scene_count=scene_count,
            model=model,
            scene_mode=scene_mode,
            settings=settings,
            usage_ctx=usage_ctx,
            active_wishes=active_wishes,
        )
    except Exception as exc:
        raise HTTPException(502, f'Не удалось сгенерировать через {model or "провайдер"}: {exc}') from exc
    project['scenes'] = result['scenes']
    project['style_description'] = style_description
    project['scene_mode'] = scene_mode
    project['active_scene_wish_ids'] = active_scene_wish_ids
    project['updated_at'] = _now()
    storage.save_project(project_id, project)
    return {'scenes': result['scenes'], 'style_description': style_description, 'scene_mode': scene_mode, 'debug': result.get('debug')}


@router.post('/{project_id}/scenes/wishes')
async def add_scene_wish(project_id: str, body: dict = Body(...)):
    """Scene-imagery equivalent of /suno/wishes - see wish_library.add_or_get_wish's
    docstring for why this is a separate library from suno_wish_library."""
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')

    text = (body.get('text') or '').strip()
    if not text:
        raise HTTPException(422, 'text is required')

    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    usage_ctx = usage.context('wish_title', project_id, settings)
    result = await wish_library.add_or_get_wish(text, settings, usage_ctx=usage_ctx, library_key='scene_wish_library')
    wish = result['wish']

    active_scene_wish_ids = project.get('active_scene_wish_ids', [])
    if wish['id'] not in active_scene_wish_ids:
        active_scene_wish_ids = [*active_scene_wish_ids, wish['id']]
    project['active_scene_wish_ids'] = active_scene_wish_ids
    project['updated_at'] = _now()
    storage.save_project(project_id, project)
    return {'wish': wish, 'scene_wish_library': result['wish_library'], 'active_scene_wish_ids': active_scene_wish_ids}


@router.post('/{project_id}/scenes/{scene_index}/images')
async def generate_scene_images(project_id: str, scene_index: int, body: dict = Body(default={})):
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')
    scene_list = project.get('scenes', [])
    if scene_index < 0 or scene_index >= len(scene_list):
        raise HTTPException(404, 'Scene not found')

    scene = scene_list[scene_index]
    count = body.get('count', 1)
    model = body.get('model', '')
    aspect_ratio = body.get('aspect_ratio')
    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    usage_ctx = usage.context('scene_image', project_id, settings, scene_index=scene_index, count=count)
    job_ids = images.start_jobs(
        project_id, scene_index, scene.get('static_prompt', ''), count, model, settings,
        usage_ctx=usage_ctx, aspect_ratio=aspect_ratio,
    )
    return {'job_ids': job_ids}


@router.get('/{project_id}/scenes/{scene_index}/images/jobs/{job_id}')
async def get_scene_image_job(project_id: str, scene_index: int, job_id: str):
    job = images.get_job(job_id)
    if job is None:
        raise HTTPException(404, 'Job not found')
    return job


@router.delete('/{project_id}/scenes/{scene_index}/images/{image_id}')
async def delete_scene_image(project_id: str, scene_index: int, image_id: str):
    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')
        scene_list = project.get('scenes', [])
        if scene_index < 0 or scene_index >= len(scene_list):
            raise HTTPException(404, 'Scene not found')

        scene_images = scene_list[scene_index].get('images', [])
        target = next((img for img in scene_images if img.get('image_id') == image_id), None)
        if target is None:
            raise HTTPException(404, 'Image not found')

        remaining = [img for img in scene_images if img.get('image_id') != image_id]
        scene_list[scene_index]['images'] = remaining
        project['updated_at'] = _now()
        storage.save_project(project_id, project)

    file_path = storage.project_dir(project_id) / target['file_path']
    if file_path.is_file():
        file_path.unlink()

    return {'images': remaining}


@router.post('/{project_id}/reference-images')
async def upload_reference_image(project_id: str, file: UploadFile = File(...)):
    suffix = ('.' + file.filename.rsplit('.', 1)[-1].lower()) if file.filename and '.' in file.filename else ''
    if suffix not in _ALLOWED_REFERENCE_EXTENSIONS:
        raise HTTPException(415, 'Unsupported image type')
    contents = await file.read()

    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')

        references_dir = storage.project_dir(project_id) / 'references'
        references_dir.mkdir(parents=True, exist_ok=True)
        filename = f'ref_{uuid4().hex[:8]}{suffix}'
        (references_dir / filename).write_bytes(contents)

        reference_images = [*project.get('reference_images', []), f'references/{filename}']
        project['reference_images'] = reference_images
        project['updated_at'] = _now()
        storage.save_project(project_id, project)
    return {'reference_images': reference_images}


@router.delete('/{project_id}/reference-images/{filename}')
async def delete_reference_image(project_id: str, filename: str):
    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')

        path = f'references/{filename}'
        reference_images = [p for p in project.get('reference_images', []) if p != path]
        project['reference_images'] = reference_images
        project['updated_at'] = _now()
        storage.save_project(project_id, project)

    file_path = storage.project_dir(project_id) / 'references' / filename
    if file_path.is_file():
        file_path.unlink()

    return {'reference_images': reference_images}
