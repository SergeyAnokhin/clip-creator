import asyncio

# TODO: this is a stub. Replace with a real call to the configured text-model
# provider (OpenAI/Anthropic/DeepSeek - see settings.api_keys) that runs the
# selected AI skill prompt against the compiled lyrics, and a real Suno/Udio
# integration for the final track. Keep this module as the seam: routers and
# the frontend should not need to change when the real call is wired in.

_TYPE_LABELS = {
    'intro': 'Intro', 'verse': 'Verse', 'chorus': 'Chorus',
    'bridge': 'Bridge', 'outro': 'Outro',
}


def _format_lyrics(blocks: list[dict]) -> str:
    """Mirrors frontend/src/lib/lyrics.js formatLyrics(compileLyrics(blocks), ...):
    `interlude` blocks are already-bracketed tags emitted as-is, everything
    else gets wrapped in `[TypeLabel]` above its content."""
    segments = []
    for b in blocks:
        if b.get('type') == 'interlude':
            segments.append(b['content'])
        else:
            label = _TYPE_LABELS.get(b.get('type'), b.get('type', '').title())
            segments.append(f"[{label}]\n{b['content']}")
    return '\n\n'.join(segments)


async def generate(project: dict, skill_prompt: str = '', model: str = '') -> dict:
    await asyncio.sleep(0.05)
    lyrics = _format_lyrics(project.get('blocks', []))
    style = project.get('style') or 'Cinematic Orchestral Folk, Warm Vocal, 90 BPM, Nostalgic'
    return {'style': style, 'lyrics': lyrics}


async def refine(project: dict, comment: str) -> str:
    """Stub for 'AI-corrected skill prompt via a user wish' (spec 3.2): folds
    the user's free-text wish into the existing skill prompt as a plain
    instruction sentence, in place of a real LLM rewrite call."""
    await asyncio.sleep(0.05)
    base = (project.get('skill_prompt') or '').rstrip()
    if not base:
        return comment.strip()
    if base.endswith(('.', '!', '?')):
        return f'{base} Additionally, {comment.strip()}.'
    return f'{base}. Additionally, {comment.strip()}.'
