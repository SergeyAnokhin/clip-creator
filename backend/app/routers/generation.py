from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Body, File, HTTPException, UploadFile

from .. import storage
from ..providers import images, scenes, suno

router = APIRouter(prefix='/api/projects', tags=['generation'])

_ALLOWED_REFERENCE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp', '.gif'}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


@router.post('/{project_id}/suno/generate')
async def generate_suno(project_id: str, body: dict = Body(default={})):
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')

    skill_id = body.get('skill_id', project.get('skill_id', 'skill_a'))
    skill_prompt = body.get('skill_prompt', project.get('skill_prompt', ''))
    model = body.get('model', '')

    result = await suno.generate(project, skill_prompt=skill_prompt, model=model)
    project['style'] = result['style']
    project['lyrics'] = result['lyrics']
    project['skill_id'] = skill_id
    project['skill_prompt'] = skill_prompt
    project['model_used'] = model
    project['updated_at'] = _now()
    storage.save_project(project_id, project)
    return {**result, 'skill_id': skill_id, 'model_used': model}


@router.post('/{project_id}/suno/refine')
async def refine_suno(project_id: str, body: dict = Body(...)):
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')

    comment = (body.get('comment') or '').strip()
    if not comment:
        raise HTTPException(422, 'comment is required')

    skill_prompt = await suno.refine(project, comment)
    refinement_comments = [*project.get('refinement_comments', []), comment]

    project['skill_prompt'] = skill_prompt
    project['refinement_comments'] = refinement_comments
    project['updated_at'] = _now()
    storage.save_project(project_id, project)
    return {'skill_prompt': skill_prompt, 'refinement_comments': refinement_comments}


@router.post('/{project_id}/scenes/generate')
async def generate_scenes(project_id: str, body: dict = Body(default={})):
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')

    style_description = body.get('style_description', project.get('style_description', ''))
    scene_count = body.get('scene_count', scenes.DEFAULT_SCENE_COUNT)

    result = await scenes.generate(
        project,
        style_description=style_description,
        reference_images=project.get('reference_images', []),
        scene_count=scene_count,
    )
    project['scenes'] = result
    project['style_description'] = style_description
    project['updated_at'] = _now()
    storage.save_project(project_id, project)
    return {'scenes': result, 'style_description': style_description}


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
    new_images = await images.generate(project_id, scene_index, scene.get('images', []), count=count, model=model)
    scene['images'] = [*scene.get('images', []), *new_images]
    project['updated_at'] = _now()
    storage.save_project(project_id, project)
    return {'images': scene['images']}


@router.post('/{project_id}/reference-images')
async def upload_reference_image(project_id: str, file: UploadFile = File(...)):
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')

    suffix = ('.' + file.filename.rsplit('.', 1)[-1].lower()) if file.filename and '.' in file.filename else ''
    if suffix not in _ALLOWED_REFERENCE_EXTENSIONS:
        raise HTTPException(415, 'Unsupported image type')

    references_dir = storage.project_dir(project_id) / 'references'
    references_dir.mkdir(parents=True, exist_ok=True)
    filename = f'ref_{uuid4().hex[:8]}{suffix}'
    contents = await file.read()
    (references_dir / filename).write_bytes(contents)

    reference_images = [*project.get('reference_images', []), f'references/{filename}']
    project['reference_images'] = reference_images
    project['updated_at'] = _now()
    storage.save_project(project_id, project)
    return {'reference_images': reference_images}


@router.delete('/{project_id}/reference-images/{filename}')
async def delete_reference_image(project_id: str, filename: str):
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
