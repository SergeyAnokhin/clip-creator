import asyncio

# TODO: this is a stub. Replace with a real call to the configured text-model
# provider (OpenAI/Anthropic/DeepSeek - see settings.api_keys) that runs the
# selected AI skill prompt against the compiled lyrics, and a real Suno/Udio
# integration for the final track. Keep this module as the seam: routers and
# the frontend should not need to change when the real call is wired in.


async def generate(project: dict) -> dict:
    await asyncio.sleep(0.05)
    style = project.get('style') or 'Cinematic Orchestral Folk, Warm Vocal, 90 BPM, Nostalgic'
    lyrics = project.get('lyrics') or '\n\n'.join(
        f"[{b['type']}]\n{b['content']}" for b in project.get('blocks', [])
    )
    return {'style': style, 'lyrics': lyrics}
