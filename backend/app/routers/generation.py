import json
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile

from .. import storage, usage
from ..providers import images, mureka, scenes, suno, title_card, wish_library
from .projects import migrate_legacy_project
from .settings import DEFAULT_SETTINGS

router = APIRouter(prefix='/api/projects', tags=['generation'])

_ALLOWED_REFERENCE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp', '.gif'}
_ALLOWED_AUDIO_EXTENSIONS = {'.mp3', '.m4a'}
# Reference-audio *sources* (ReferenceAudioTrimmer.jsx) are a staging area,
# not what actually gets sent to Mureka - the trimmed clip that comes out
# the other end is what upload_mureka_reference_audio validates/sends, so
# this is a looser allowlist of whatever ffmpeg (and the browser's
# decodeAudioData for the waveform) can realistically decode.
_ALLOWED_REFERENCE_SOURCE_EXTENSIONS = {'.mp3', '.m4a', '.wav', '.ogg', '.flac', '.aac', '.webm'}


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


@router.post('/{project_id}/scenes/{scene_index}/images/{image_id}/crop')
async def crop_scene_image(project_id: str, scene_index: int, image_id: str, body: dict = Body(default={})):
    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    usage_ctx = usage.context('scene_image_crop', project_id, settings, scene_index=scene_index)
    crop_box = body.get('crop') or {}
    if not all(k in crop_box for k in ('x', 'y', 'width', 'height')):
        raise HTTPException(400, 'Missing crop box')
    try:
        result = await images.crop_image(
            project_id, scene_index, image_id, crop_box, settings,
            usage_ctx=usage_ctx, quality=body.get('quality'),
        )
    except images.OutpaintTooLargeError as exc:
        raise HTTPException(400, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc
    return result


@router.post('/{project_id}/scenes/{scene_index}/images/upload')
async def upload_scene_image(
    project_id: str, scene_index: int,
    file: UploadFile | None = File(None), url: str | None = Form(None),
):
    """Adds a user's own image to a scene (drag-drop/file-picker upload, or
    a pasted/dropped image URL) alongside AI-generated ones - see
    images.save_uploaded_image / images.download_user_image_url for the
    storage shape and the SSRF guards on the URL path respectively."""
    has_url = bool(url and url.strip())
    if not file and not has_url:
        raise HTTPException(422, 'file or url is required')
    if file and has_url:
        raise HTTPException(422, 'provide either file or url, not both')

    if file:
        suffix = ('.' + file.filename.rsplit('.', 1)[-1].lower()) if file.filename and '.' in file.filename else ''
        if suffix not in _ALLOWED_REFERENCE_EXTENSIONS:
            raise HTTPException(415, 'Unsupported image type')
        content = await file.read()
        ext = suffix.removeprefix('.')
    else:
        try:
            content, ext = await images.download_user_image_url(url.strip())
        except RuntimeError as exc:
            raise HTTPException(422, str(exc)) from exc

    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')
        scene_list = project.get('scenes', [])
        if scene_index < 0 or scene_index >= len(scene_list):
            raise HTTPException(404, 'Scene not found')

        image = images.save_uploaded_image(project_id, scene_index, content, ext)
        scene_list[scene_index]['images'] = [*scene_list[scene_index].get('images', []), image]
        project['updated_at'] = _now()
        storage.save_project(project_id, project)

    return {'image': image}


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


@router.post('/{project_id}/title-card/generate')
async def generate_title_card(project_id: str, body: dict = Body(default={})):
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')

    text_block = (body.get('text_block') or '').strip()
    base_prompt = body.get('base_prompt', '')
    reference_image_paths = body.get('reference_image_paths') or []
    if not reference_image_paths:
        raise HTTPException(422, 'reference_image_paths is required')
    if len(reference_image_paths) > 4:
        raise HTTPException(422, 'reference_image_paths accepts at most 4 images')
    for path in reference_image_paths:
        _resolve_reference_path(project_id, path)

    count = body.get('count', 1)
    model = body.get('model', '')
    aspect_ratio = body.get('aspect_ratio')
    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    active_title_card_wish_ids = body.get('active_title_card_wish_ids', project.get('active_title_card_wish_ids', []))
    title_card_wish_lookup = {
        w['id']: w['text'] for w in wish_library.normalize_wish_library(settings.get('title_card_wish_library', []))
    }
    active_wishes = [title_card_wish_lookup[wid] for wid in active_title_card_wish_ids if wid in title_card_wish_lookup]
    usage_ctx = usage.context('title_card', project_id, settings, count=count)
    job_ids = title_card.start_jobs(
        project_id, reference_image_paths, text_block, base_prompt, count, model, settings,
        usage_ctx=usage_ctx, aspect_ratio=aspect_ratio, active_wishes=active_wishes,
    )
    return {'job_ids': job_ids}


@router.post('/{project_id}/title-card/wishes')
async def add_title_card_wish(project_id: str, body: dict = Body(...)):
    """Title Card equivalent of /scenes/wishes - see wish_library.add_or_get_wish's
    docstring for why this is a separate library from scene_wish_library."""
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')

    text = (body.get('text') or '').strip()
    if not text:
        raise HTTPException(422, 'text is required')

    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    usage_ctx = usage.context('wish_title', project_id, settings)
    result = await wish_library.add_or_get_wish(text, settings, usage_ctx=usage_ctx, library_key='title_card_wish_library')
    wish = result['wish']

    active_title_card_wish_ids = project.get('active_title_card_wish_ids', [])
    if wish['id'] not in active_title_card_wish_ids:
        active_title_card_wish_ids = [*active_title_card_wish_ids, wish['id']]
    project['active_title_card_wish_ids'] = active_title_card_wish_ids
    project['updated_at'] = _now()
    storage.save_project(project_id, project)
    return {
        'wish': wish, 'title_card_wish_library': result['wish_library'],
        'active_title_card_wish_ids': active_title_card_wish_ids,
    }


@router.get('/{project_id}/title-card/jobs/{job_id}')
async def get_title_card_job(project_id: str, job_id: str):
    job = title_card.get_job(job_id)
    if job is None:
        raise HTTPException(404, 'Job not found')
    return job


@router.delete('/{project_id}/title-card/variants/{variant_id}')
async def delete_title_card_variant(project_id: str, variant_id: str):
    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')

        variants = (project.get('title_card') or {}).get('variants', [])
        target = next((v for v in variants if v.get('variant_id') == variant_id), None)
        if target is None:
            raise HTTPException(404, 'Variant not found')

        remaining = [v for v in variants if v.get('variant_id') != variant_id]
        title_card_field = project.get('title_card') or {}
        title_card_field['variants'] = remaining
        project['title_card'] = title_card_field
        project['updated_at'] = _now()
        storage.save_project(project_id, project)

    file_path = storage.project_dir(project_id) / target['file_path']
    if file_path.is_file():
        file_path.unlink()

    return {'variants': remaining}


@router.post('/{project_id}/title-card/variants/{variant_id}/remove-background')
async def remove_title_card_variant_background(project_id: str, variant_id: str, body: dict = Body(default={})):
    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    usage_ctx = usage.context('title_card_bg_remove', project_id, settings)
    try:
        result = await title_card.remove_background(
            project_id, variant_id, settings, usage_ctx=usage_ctx, method=body.get('method'),
        )
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc
    return result


@router.post('/{project_id}/title-card/poster')
async def save_title_card_poster(
    project_id: str,
    file: UploadFile = File(...),
    background_path: str = Form(...),
    title_card_variant_id: str = Form(...),
    logo_id: str = Form(''),
    layers: str = Form(...),
    canvas_size: str = Form(...),
    poster_id: str = Form(''),
):
    """Saves the flattened PNG a `PosterConstructor.jsx` Konva stage rendered
    (background scene image + the title-card overlay + an optional logo,
    dragged/scaled by the user) as a new poster, or re-renders an existing
    one in place when `poster_id` is given - the constructor is re-openable
    because `layers`/`background_path`/`title_card_variant_id`/`logo_id` are
    stored alongside the flattened image, not just the flattened PNG itself."""
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')
    _resolve_reference_path(project_id, background_path)
    variants = (project.get('title_card') or {}).get('variants', [])
    if not any(v.get('variant_id') == title_card_variant_id for v in variants):
        raise HTTPException(422, f'Unknown title_card_variant_id: {title_card_variant_id}')

    try:
        layers_data = json.loads(layers)
        canvas_size_data = json.loads(canvas_size)
    except json.JSONDecodeError as exc:
        raise HTTPException(422, f'layers/canvas_size must be valid JSON: {exc}') from exc

    contents = await file.read()

    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')
        title_card_field = project.get('title_card') or {}
        posters = title_card_field.get('posters', [])
        existing = next((p for p in posters if p.get('poster_id') == poster_id), None) if poster_id else None

        new_poster_id = existing['poster_id'] if existing else f'poster_{uuid4().hex[:8]}'
        posters_dir = storage.project_dir(project_id) / 'titlecard' / 'posters'
        posters_dir.mkdir(parents=True, exist_ok=True)
        filename = f'{new_poster_id.removeprefix("poster_")}.png'
        (posters_dir / filename).write_bytes(contents)

        poster = {
            'poster_id': new_poster_id, 'file_path': f'titlecard/posters/{filename}',
            'background_path': background_path, 'title_card_variant_id': title_card_variant_id,
            'logo_id': logo_id or None, 'canvas_size': canvas_size_data, 'layers': layers_data,
            'rating': existing.get('rating', 0) if existing else 0,
            'is_selected': existing.get('is_selected', False) if existing else False,
            'generated_at': _now(),
        }
        posters = (
            [poster if p.get('poster_id') == new_poster_id else p for p in posters]
            if existing else [*posters, poster]
        )
        title_card_field['posters'] = posters
        project['title_card'] = title_card_field
        project['updated_at'] = _now()
        storage.save_project(project_id, project)

    return {'poster': poster, 'posters': posters}


@router.delete('/{project_id}/title-card/poster/{poster_id}')
async def delete_title_card_poster(project_id: str, poster_id: str):
    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')
        title_card_field = project.get('title_card') or {}
        posters = title_card_field.get('posters', [])
        target = next((p for p in posters if p.get('poster_id') == poster_id), None)
        if target is None:
            raise HTTPException(404, 'Poster not found')

        remaining = [p for p in posters if p.get('poster_id') != poster_id]
        title_card_field['posters'] = remaining
        project['title_card'] = title_card_field
        project['updated_at'] = _now()
        storage.save_project(project_id, project)

    file_path = storage.project_dir(project_id) / target['file_path']
    if file_path.is_file():
        file_path.unlink()

    return {'posters': remaining}


# ---------- Mureka stage (real audio generation, see providers/mureka.py) ----------
# Rating/tag/primary-flag edits on a track go through the generic
# `PATCH /api/projects/{id}` route (client sends the whole recomputed
# `mureka.tracks` array) - same convention as scene-image rating/selection in
# useImagesStage.js, no dedicated endpoint needed for those. Only actions that
# also touch disk (starting a job, deleting a track/reference file) get their
# own route here.

@router.post('/{project_id}/mureka/generate')
async def generate_mureka(project_id: str, body: dict = Body(default={})):
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')

    style = body.get('style', '')
    lyrics = (body.get('lyrics') or '').strip()
    if not lyrics:
        raise HTTPException(422, 'lyrics is required')
    model = body.get('model', 'auto')
    n = body.get('n', 2)
    gender = body.get('gender')
    reference_id = body.get('reference_id')
    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    usage_ctx = usage.context('mureka_generate', project_id, settings, model=model, n=n)
    job_id = mureka.start_job(project_id, style, lyrics, model, n, gender, reference_id, settings, usage_ctx=usage_ctx)
    return {'job_id': job_id}


@router.get('/{project_id}/mureka/jobs/{job_id}')
async def get_mureka_job(project_id: str, job_id: str):
    job = mureka.get_job(job_id)
    if job is None:
        raise HTTPException(404, 'Job not found')
    return job


@router.delete('/{project_id}/mureka/tracks/{track_id}')
async def delete_mureka_track(project_id: str, track_id: str):
    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')
        mureka_field = project.get('mureka') or {}
        tracks = mureka_field.get('tracks', [])
        target = next((t for t in tracks if t.get('track_id') == track_id), None)
        if target is None:
            raise HTTPException(404, 'Track not found')

        remaining = [t for t in tracks if t.get('track_id') != track_id]
        mureka_field['tracks'] = remaining
        project['mureka'] = mureka_field
        project['updated_at'] = _now()
        storage.save_project(project_id, project)

    file_path = storage.project_dir(project_id) / target['file_path']
    if file_path.is_file():
        file_path.unlink()

    return {'tracks': remaining}


@router.post('/{project_id}/mureka/reference-audio')
async def upload_mureka_reference_audio(project_id: str, file: UploadFile = File(...)):
    suffix = ('.' + file.filename.rsplit('.', 1)[-1].lower()) if file.filename and '.' in file.filename else ''
    if suffix not in _ALLOWED_AUDIO_EXTENSIONS:
        raise HTTPException(415, 'Unsupported audio type')
    contents = await file.read()

    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    api_key = (settings.get('api_keys') or {}).get('mureka', '')
    try:
        uploaded = await mureka.upload_reference_audio(contents, file.filename or f'reference{suffix}', api_key)
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc

    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')

        references_dir = storage.project_dir(project_id) / 'music' / 'references'
        references_dir.mkdir(parents=True, exist_ok=True)
        filename = f'ref_{uuid4().hex[:8]}{suffix}'
        (references_dir / filename).write_bytes(contents)

        mureka_field = project.get('mureka') or {}
        reference_audio = [
            *mureka_field.get('reference_audio', []),
            {
                'id': f'mref_{uuid4().hex[:8]}', 'mureka_file_id': uploaded.get('id'),
                'file_path': f'music/references/{filename}', 'filename': file.filename,
                'uploaded_at': _now(),
            },
        ]
        mureka_field['reference_audio'] = reference_audio
        project['mureka'] = mureka_field
        project['updated_at'] = _now()
        storage.save_project(project_id, project)
    return {'reference_audio': reference_audio}


@router.delete('/{project_id}/mureka/reference-audio/{ref_id}')
async def delete_mureka_reference_audio(project_id: str, ref_id: str):
    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')
        mureka_field = project.get('mureka') or {}
        reference_audio = mureka_field.get('reference_audio', [])
        target = next((r for r in reference_audio if r.get('id') == ref_id), None)
        if target is None:
            raise HTTPException(404, 'Reference audio not found')

        remaining = [r for r in reference_audio if r.get('id') != ref_id]
        mureka_field['reference_audio'] = remaining
        project['mureka'] = mureka_field
        project['updated_at'] = _now()
        storage.save_project(project_id, project)

    file_path = storage.project_dir(project_id) / target['file_path']
    if file_path.is_file():
        file_path.unlink()

    return {'reference_audio': remaining}


# ---------- Reference-audio trimmer (ReferenceAudioTrimmer.jsx) ----------
# Mureka's reference upload hard-requires >=30s of audio - rather than
# uploading whatever the user picked straight to Mureka and risking a 400,
# an uploaded source file is kept locally first ("reference source") so the
# frontend can let the user audition it and pick a >=30s window; only the
# trimmed clip that comes out of /trim below ever reaches Mureka, via the
# same upload_mureka_reference_audio flow above.

@router.post('/{project_id}/mureka/reference-sources')
async def upload_mureka_reference_source(project_id: str, file: UploadFile = File(...)):
    suffix = ('.' + file.filename.rsplit('.', 1)[-1].lower()) if file.filename and '.' in file.filename else ''
    if suffix not in _ALLOWED_REFERENCE_SOURCE_EXTENSIONS:
        raise HTTPException(415, 'Unsupported audio type')
    contents = await file.read()

    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')

        sources_dir = storage.project_dir(project_id) / 'music' / 'reference-sources'
        sources_dir.mkdir(parents=True, exist_ok=True)
        source_id = f'msrc_{uuid4().hex[:8]}'
        filename = f'{source_id}{suffix}'
        (sources_dir / filename).write_bytes(contents)

        mureka_field = project.get('mureka') or {}
        reference_sources = [
            *mureka_field.get('reference_sources', []),
            {
                'id': source_id, 'file_path': f'music/reference-sources/{filename}',
                'filename': file.filename, 'uploaded_at': _now(),
            },
        ]
        mureka_field['reference_sources'] = reference_sources
        project['mureka'] = mureka_field
        project['updated_at'] = _now()
        storage.save_project(project_id, project)
    return {'reference_sources': reference_sources}


@router.delete('/{project_id}/mureka/reference-sources/{source_id}')
async def delete_mureka_reference_source(project_id: str, source_id: str):
    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')
        mureka_field = project.get('mureka') or {}
        reference_sources = mureka_field.get('reference_sources', [])
        target = next((s for s in reference_sources if s.get('id') == source_id), None)
        if target is None:
            raise HTTPException(404, 'Reference source not found')

        remaining = [s for s in reference_sources if s.get('id') != source_id]
        mureka_field['reference_sources'] = remaining
        project['mureka'] = mureka_field
        project['updated_at'] = _now()
        storage.save_project(project_id, project)

    file_path = storage.project_dir(project_id) / target['file_path']
    if file_path.is_file():
        file_path.unlink()

    return {'reference_sources': remaining}


@router.post('/{project_id}/mureka/reference-sources/{source_id}/trim')
async def trim_mureka_reference_source(project_id: str, source_id: str, body: dict = Body(...)):
    start_ms, end_ms = body.get('start_ms'), body.get('end_ms')
    if start_ms is None or end_ms is None or end_ms <= start_ms:
        raise HTTPException(422, 'start_ms/end_ms required, end_ms must be greater than start_ms')

    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')
    mureka_field = project.get('mureka') or {}
    source = next((s for s in mureka_field.get('reference_sources', []) if s.get('id') == source_id), None)
    if source is None:
        raise HTTPException(404, 'Reference source not found')

    src_path = storage.project_dir(project_id) / source['file_path']
    trimmed_id = f'trim_{uuid4().hex[:8]}'
    trimmed_path = storage.project_dir(project_id) / 'music' / 'reference-sources' / f'{trimmed_id}.mp3'
    try:
        await mureka.trim_audio(src_path, start_ms, end_ms, trimmed_path)
        trimmed_bytes = trimmed_path.read_bytes()

        settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
        api_key = (settings.get('api_keys') or {}).get('mureka', '')
        uploaded = await mureka.upload_reference_audio(trimmed_bytes, f'{trimmed_id}.mp3', api_key)
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc
    finally:
        trimmed_path.unlink(missing_ok=True)  # only the persisted reference_audio[] copy below is kept

    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')
        mureka_field = project.get('mureka') or {}
        references_dir = storage.project_dir(project_id) / 'music' / 'references'
        references_dir.mkdir(parents=True, exist_ok=True)
        filename = f'ref_{uuid4().hex[:8]}.mp3'
        (references_dir / filename).write_bytes(trimmed_bytes)
        reference_audio = [
            *mureka_field.get('reference_audio', []),
            {
                'id': f'mref_{uuid4().hex[:8]}', 'mureka_file_id': uploaded.get('id'),
                'file_path': f'music/references/{filename}', 'filename': source.get('filename') or f'{trimmed_id}.mp3',
                'uploaded_at': _now(),
            },
        ]
        mureka_field['reference_audio'] = reference_audio
        project['mureka'] = mureka_field
        project['updated_at'] = _now()
        storage.save_project(project_id, project)
    return {'reference_audio': reference_audio}


# ---------- Post-generation track operations (extend / stem) ----------
# Both are real Mureka API calls (see providers/mureka.py's module docstring
# for the confirmed request/response shapes) - extend is async (job/poll,
# reuses the existing GET .../mureka/jobs/{job_id} route), stem is
# synchronous. Neither has a pricing.py catalog row, same "cost: unknown"
# convention as ordinary generation.

@router.post('/{project_id}/mureka/tracks/{track_id}/extend')
async def extend_mureka_track(project_id: str, track_id: str, body: dict = Body(default={})):
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')
    tracks = (project.get('mureka') or {}).get('tracks', [])
    track = next((t for t in tracks if t.get('track_id') == track_id), None)
    if track is None:
        raise HTTPException(404, 'Track not found')
    song_id = (track.get('raw') or {}).get('id')
    if not song_id:
        raise HTTPException(422, 'У этого трека нет song_id Mureka - продление недоступно')

    lyrics = (body.get('lyrics') or '').strip()
    if not lyrics:
        raise HTTPException(422, 'lyrics is required')
    extend_at = body.get('extend_at')
    if extend_at is None:
        extend_at = track.get('duration_ms') or 0
    model = body.get('model') or None
    extend_type = body.get('extend_type') or None

    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    usage_ctx = usage.context('mureka_extend', project_id, settings, model=model)
    job_id = mureka.start_extend_job(
        project_id, track_id, song_id, lyrics, extend_at, model, extend_type, settings, usage_ctx=usage_ctx,
    )
    return {'job_id': job_id}


@router.post('/{project_id}/mureka/tracks/{track_id}/stem')
async def stem_mureka_track(project_id: str, track_id: str, body: dict = Body(default={})):
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')
    tracks = (project.get('mureka') or {}).get('tracks', [])
    track = next((t for t in tracks if t.get('track_id') == track_id), None)
    if track is None:
        raise HTTPException(404, 'Track not found')

    file_path = storage.project_dir(project_id) / track['file_path']
    if not file_path.is_file():
        raise HTTPException(404, 'Audio file not found on disk')
    content = file_path.read_bytes()

    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    api_key = (settings.get('api_keys') or {}).get('mureka', '')
    model = body.get('model') or None
    stem_id = f'stem_{uuid4().hex[:8]}'
    dest_zip_path = storage.project_dir(project_id) / 'music' / f'{stem_id}.zip'
    usage_ctx = usage.context('mureka_stem', project_id, settings, model=model)
    try:
        result = await mureka.stem_track(content, model, api_key, dest_zip_path, usage_ctx=usage_ctx)
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc

    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')
        mureka_field = project.get('mureka') or {}
        tracks = mureka_field.get('tracks', [])
        for t in tracks:
            if t.get('track_id') == track_id:
                t['stems'] = [*t.get('stems', []), {
                    'id': stem_id, 'file_path': f'music/{stem_id}.zip', 'model': model,
                    'expires_at': result.get('expires_at'), 'created_at': _now(),
                }]
                break
        mureka_field['tracks'] = tracks
        project['mureka'] = mureka_field
        project['updated_at'] = _now()
        storage.save_project(project_id, project)
    return {'tracks': tracks}
