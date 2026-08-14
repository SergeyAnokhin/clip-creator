"""Scene-storyboard routes: scene text, scene images, scene videos, and
the project-level reference images those stages upload.

Providers: `providers/scenes.py` (text), `providers/images.py`,
`providers/video.py`.
"""

from uuid import uuid4

from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile

from .. import storage, usage
from ..providers import images, scenes, video, wish_library
from .generation_common import _ALLOWED_VIDEO_EXTENSIONS, _now
from .settings import DEFAULT_SETTINGS

router = APIRouter(prefix='/api/projects', tags=['generation'])


_ALLOWED_REFERENCE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp', '.gif'}


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


# ---------- Video stage (image-to-video animation, see providers/video.py) ----------
# Mirrors the scene-images job/poll shape above, but each generated video is
# an animation of one already-generated scene image (its `is_selected` one,
# unless `image_id` overrides it) driven by the scene's own motion_prompt
# plus any active video wishes - see video.build_prompt.

@router.post('/{project_id}/scenes/videos/wishes')
async def add_video_wish(project_id: str, body: dict = Body(...)):
    """Video/animation-prompt equivalent of /scenes/wishes - see
    wish_library.add_or_get_wish's docstring for why this is a separate
    library from scene_wish_library. Project-level (not per-scene), same as
    active_scene_wish_ids."""
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')

    text = (body.get('text') or '').strip()
    if not text:
        raise HTTPException(422, 'text is required')

    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    usage_ctx = usage.context('wish_title', project_id, settings)
    result = await wish_library.add_or_get_wish(text, settings, usage_ctx=usage_ctx, library_key='video_wish_library')
    wish = result['wish']

    active_video_wish_ids = project.get('active_video_wish_ids', [])
    if wish['id'] not in active_video_wish_ids:
        active_video_wish_ids = [*active_video_wish_ids, wish['id']]
    project['active_video_wish_ids'] = active_video_wish_ids
    project['updated_at'] = _now()
    storage.save_project(project_id, project)
    return {'wish': wish, 'video_wish_library': result['wish_library'], 'active_video_wish_ids': active_video_wish_ids}


@router.post('/{project_id}/scenes/{scene_index}/videos')
async def generate_scene_videos(project_id: str, scene_index: int, body: dict = Body(default={})):
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')
    scene_list = project.get('scenes', [])
    if scene_index < 0 or scene_index >= len(scene_list):
        raise HTTPException(404, 'Scene not found')
    scene = scene_list[scene_index]

    scene_images = scene.get('images', [])
    image_id = body.get('image_id')
    source_image = (
        next((img for img in scene_images if img.get('image_id') == image_id), None) if image_id
        else next((img for img in scene_images if img.get('is_selected')), None)
    )
    if source_image is None:
        raise HTTPException(422, 'У сцены нет выбранного изображения для анимации')

    motion_prompt = body.get('motion_prompt', scene.get('motion_prompt', ''))
    count = body.get('count', 1)
    model = body.get('model', '')
    aspect_ratio = body.get('aspect_ratio')
    resolution = body.get('resolution')
    duration_seconds = body.get('duration_seconds', 5)
    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}

    active_video_wish_ids = body.get('active_video_wish_ids', project.get('active_video_wish_ids', []))
    video_wish_lookup = {w['id']: w['text'] for w in wish_library.normalize_wish_library(settings.get('video_wish_library', []))}
    active_wishes = [video_wish_lookup[wid] for wid in active_video_wish_ids if wid in video_wish_lookup]
    prompt = video.build_prompt(motion_prompt, active_wishes)

    usage_ctx = usage.context('scene_video', project_id, settings, scene_index=scene_index, count=count)
    job_ids = video.start_jobs(
        project_id, scene_index, prompt, source_image['file_path'], source_image['image_id'], count, model, settings,
        usage_ctx=usage_ctx, aspect_ratio=aspect_ratio, resolution=resolution, duration_seconds=duration_seconds,
    )
    return {'job_ids': job_ids}


@router.get('/{project_id}/scenes/{scene_index}/videos/jobs/{job_id}')
async def get_scene_video_job(project_id: str, scene_index: int, job_id: str):
    job = video.get_job(job_id)
    if job is None:
        raise HTTPException(404, 'Job not found')
    return job


@router.delete('/{project_id}/scenes/{scene_index}/videos/{video_id}')
async def delete_scene_video(project_id: str, scene_index: int, video_id: str):
    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')
        scene_list = project.get('scenes', [])
        if scene_index < 0 or scene_index >= len(scene_list):
            raise HTTPException(404, 'Scene not found')

        scene_videos = scene_list[scene_index].get('videos', [])
        target = next((v for v in scene_videos if v.get('video_id') == video_id), None)
        if target is None:
            raise HTTPException(404, 'Video not found')

        remaining = [v for v in scene_videos if v.get('video_id') != video_id]
        scene_list[scene_index]['videos'] = remaining
        project['updated_at'] = _now()
        storage.save_project(project_id, project)

    file_path = storage.project_dir(project_id) / target['file_path']
    if file_path.is_file():
        file_path.unlink()

    return {'videos': remaining}


@router.post('/{project_id}/scenes/{scene_index}/videos/upload')
async def upload_scene_video(project_id: str, scene_index: int, file: UploadFile = File(...)):
    """Adds a user's own finished clip to a scene's `videos[]` - e.g. one
    animated in an outside tool from the scene's image+motion_prompt and
    brought back in by hand, instead of only ever generating one through this
    app. File-only (unlike the image upload endpoint): a pasted-URL path
    would need the same SSRF-guarded downloader as `images.download_user_image_url`
    for a feature nobody asked for here, so it's skipped for now - see
    video.save_uploaded_video for the storage shape."""
    suffix = ('.' + file.filename.rsplit('.', 1)[-1].lower()) if file.filename and '.' in file.filename else ''
    if suffix not in _ALLOWED_VIDEO_EXTENSIONS:
        raise HTTPException(415, 'Unsupported video type')
    content = await file.read()

    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')
        scene_list = project.get('scenes', [])
        if scene_index < 0 or scene_index >= len(scene_list):
            raise HTTPException(404, 'Scene not found')

        new_video = video.save_uploaded_video(project_id, scene_index, content, suffix.removeprefix('.'))
        scene_list[scene_index]['videos'] = [*scene_list[scene_index].get('videos', []), new_video]
        project['updated_at'] = _now()
        storage.save_project(project_id, project)

    return {'video': new_video}


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
