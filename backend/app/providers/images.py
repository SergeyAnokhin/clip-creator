import asyncio

# TODO: this is a stub. Replace with a real call to the configured image
# provider (FLUX/DALL-E/Midjourney/SDXL - see settings.api_keys), using the
# scene's static/motion prompts. Keep this module as the seam: routers and
# the frontend should not need to change when the real call is wired in.


async def generate(scene: dict) -> list[dict]:
    await asyncio.sleep(0.05)
    existing = scene.get('images', [])
    start = len(existing)
    return [
        {'label': f'Вариант {start + n}', 'rating': 0, 'main': start == 0 and n == 1}
        for n in (1, 2, 3)
    ]
