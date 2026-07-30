import asyncio
from datetime import datetime, timezone
from uuid import uuid4

from .. import storage

# TODO: this is a stub. Replace with a real call to the configured image
# provider (FLUX/DALL-E/Midjourney/SDXL - see settings.api_keys), using the
# scene's static/motion prompts. Keep this module as the seam: routers and
# the frontend should not need to change when the real call is wired in.
# For now it writes a deterministic placeholder SVG to disk so the rest of
# the app (local storage, static serving, thumbnails) can be built and
# tested against real files.

_COLORS = ['#3b3f6b', '#5c3b6b', '#3b6b5c', '#6b4d3b', '#3b556b']


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def _placeholder_svg(scene_number: int, var_num: int, model: str) -> str:
    color = _COLORS[(scene_number + var_num) % len(_COLORS)]
    label = f'Scene {scene_number} - Var {var_num}'
    sublabel = model or 'default model'
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">'
        f'<rect width="512" height="512" fill="{color}"/>'
        f'<text x="50%" y="48%" fill="#ffffff" font-size="28" font-family="sans-serif" '
        f'text-anchor="middle">{label}</text>'
        f'<text x="50%" y="56%" fill="#ffffffaa" font-size="16" font-family="sans-serif" '
        f'text-anchor="middle">{sublabel}</text>'
        '</svg>'
    )


async def generate(
    slug: str, scene_index: int, existing_images: list[dict], count: int = 1, model: str = '',
) -> list[dict]:
    await asyncio.sleep(0.05)
    if count <= 0:
        return []

    scene_number = scene_index + 1
    images_dir = storage.project_dir(slug) / 'images'
    images_dir.mkdir(parents=True, exist_ok=True)

    start = len(existing_images)
    results = []
    for n in range(1, count + 1):
        var_num = start + n
        filename = f'scene_{scene_number}_var_{var_num}.svg'
        (images_dir / filename).write_text(
            _placeholder_svg(scene_number, var_num, model), encoding='utf-8',
        )
        results.append({
            'image_id': f'img_{uuid4().hex[:8]}',
            'file_path': f'images/{filename}',
            'rating': 0,
            'is_selected': False,
            'generated_at': _now(),
        })
    return results
