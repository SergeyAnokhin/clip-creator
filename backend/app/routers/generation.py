from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException

from .. import storage
from ..providers import images, suno

router = APIRouter(prefix='/api/projects', tags=['generation'])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


@router.post('/{project_id}/suno/generate')
async def generate_suno(project_id: str):
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')
    result = await suno.generate(project)
    project['style'] = result['style']
    project['lyrics'] = result['lyrics']
    project['updated_at'] = _now()
    storage.save_project(project_id, project)
    return result


@router.post('/{project_id}/scenes/{scene_index}/images')
async def generate_scene_images(project_id: str, scene_index: int):
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')
    scenes = project.get('scenes', [])
    if scene_index < 0 or scene_index >= len(scenes):
        raise HTTPException(404, 'Scene not found')

    scene = scenes[scene_index]
    new_images = await images.generate(scene)
    scene['images'] = [*scene.get('images', []), *new_images]
    project['updated_at'] = _now()
    storage.save_project(project_id, project)
    return {'images': scene['images']}
