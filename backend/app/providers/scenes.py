import asyncio

# TODO: this is a stub. Replace with a real call to the configured text-model
# provider that runs an AI "scene splitter" skill against the compiled lyrics,
# the style description, and any uploaded reference images. Keep this module
# as the seam: routers and the frontend should not need to change when the
# real call is wired in.

DEFAULT_SCENE_COUNT = 5
DEFAULT_STYLE = 'Cinematic, atmospheric lighting, highly detailed, 8k'


def _lyric_lines(blocks: list[dict]) -> list[str]:
    """All non-`interlude` block content, one line per list item, in order -
    `interlude` blocks are meta-tags (e.g. `[Vocal Interlude]`), not lyric
    text, so they're skipped (mirrors suno._format_lyrics's own interlude
    handling)."""
    lines = []
    for b in blocks:
        if b.get('type') == 'interlude':
            continue
        lines.extend(line for line in b.get('content', '').splitlines() if line.strip())
    return lines


def _chunk(lines: list[str], count: int) -> list[list[str]]:
    """Splits `lines` into `count` ordered, ~even chunks. If there are fewer
    lines than chunks, later chunks are empty."""
    if not lines:
        return [[] for _ in range(count)]
    base, extra = divmod(len(lines), count)
    chunks, i = [], 0
    for n in range(count):
        size = base + (1 if n < extra else 0)
        chunks.append(lines[i:i + size])
        i += size
    return chunks


async def generate(
    project: dict,
    style_description: str = '',
    reference_images: list[str] | None = None,
    scene_count: int = DEFAULT_SCENE_COUNT,
) -> list[dict]:
    await asyncio.sleep(0.05)
    reference_images = reference_images or []
    style = style_description.strip() or DEFAULT_STYLE
    ref_note = f', visually guided by {len(reference_images)} uploaded reference image(s)' if reference_images else ''

    chunks = _chunk(_lyric_lines(project.get('blocks', [])), scene_count)
    scenes = []
    for i, chunk in enumerate(chunks):
        segment = chunk[0] if chunk else ''
        static_prompt = (
            f'Cinematic frame inspired by: "{segment}". {style}{ref_note}. '
            f'Scene {i + 1} of {scene_count}.'
        ) if segment else f'{style}{ref_note}. Scene {i + 1} of {scene_count} (no lyric line available).'
        motion_prompt = (
            f'Slow, deliberate camera movement bringing the scene to life: gentle drift, '
            f'subtle particle and light motion, matching the mood of "{segment}".'
        ) if segment else 'Slow, deliberate camera movement bringing the scene to life: gentle drift, subtle particle and light motion.'
        scenes.append({
            'lyric_segment': segment,
            'static_prompt': static_prompt,
            'motion_prompt': motion_prompt,
            'images': [],
        })
    return scenes
