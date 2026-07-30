import asyncio

import httpx

# Real seam: `model` is a composite "{provider}:{model_id}" string (see
# settings.text_models). When provider == 'google' and settings.api_keys.google
# is set, generate() calls the Gemini API with that model_id. Otherwise it
# falls back to the deterministic stub below (no network calls), which keeps
# existing tests and no-key setups working - only Google is really wired.

_TYPE_LABELS = {
    'intro': 'Intro', 'verse': 'Verse', 'chorus': 'Chorus',
    'bridge': 'Bridge', 'outro': 'Outro',
}

_GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent'
_STYLE_MARKER = '===STYLE==='
_LYRICS_MARKER = '===LYRICS==='


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


def _build_gemini_prompt(raw_lyrics: str, skill_prompt: str, settings: dict) -> str:
    base_prompt = settings.get('suno_base_prompt', '')
    examples = settings.get('suno_reference_examples', [])
    examples_block = ''
    if examples:
        labeled = [f'Пример {i}:\n{ex}' for i, ex in enumerate(examples, start=1)]
        examples_block = 'Эталонные примеры адаптации (ориентир по тону и формату, не копировать дословно):\n\n' + '\n\n---\n\n'.join(labeled)

    instructions = '\n\n'.join(part for part in [base_prompt, examples_block, skill_prompt] if part.strip())

    return (
        f'{instructions}\n\n'
        '---\n'
        f'Исходная структурированная лирика для адаптации:\n{raw_lyrics}\n\n'
        'Ответь СТРОГО в этом формате, без какого-либо текста до или после:\n'
        f'{_STYLE_MARKER}\n<style-block здесь>\n{_LYRICS_MARKER}\n<lyrics-markup здесь>'
    )


def _parse_gemini_response(text: str, fallback_lyrics: str) -> dict:
    if _LYRICS_MARKER in text:
        before, lyrics = text.split(_LYRICS_MARKER, 1)
        style = before.split(_STYLE_MARKER, 1)[-1].strip()
        return {'style': style, 'lyrics': lyrics.strip()}
    # Model didn't follow the marker format - use the whole reply as lyrics
    # rather than failing the request outright.
    return {'style': '', 'lyrics': text.strip() or fallback_lyrics}


async def _generate_via_gemini(raw_lyrics: str, skill_prompt: str, settings: dict, api_key: str, model_id: str) -> dict:
    prompt = _build_gemini_prompt(raw_lyrics, skill_prompt, settings)
    url = _GEMINI_URL.format(model=model_id)

    async with httpx.AsyncClient(timeout=60) as http_client:
        resp = await http_client.post(
            url,
            params={'key': api_key},
            json={'contents': [{'parts': [{'text': prompt}]}]},
        )
    if resp.status_code != 200:
        raise RuntimeError(f'Gemini API вернул {resp.status_code}: {resp.text[:300]}')

    data = resp.json()
    try:
        text = data['candidates'][0]['content']['parts'][0]['text']
    except (KeyError, IndexError) as exc:
        raise RuntimeError(f'Неожиданный ответ Gemini: {data}') from exc

    return _parse_gemini_response(text, raw_lyrics)


async def generate(project: dict, skill_prompt: str = '', model: str = '', settings: dict | None = None) -> dict:
    settings = settings or {}
    raw_lyrics = _format_lyrics(project.get('blocks', []))

    provider, _, model_id = model.partition(':')
    api_key = (settings.get('api_keys') or {}).get('google', '')
    if provider == 'google' and model_id and api_key:
        return await _generate_via_gemini(raw_lyrics, skill_prompt, settings, api_key, model_id)

    await asyncio.sleep(0.05)
    style = project.get('style') or 'Cinematic Orchestral Folk, Warm Vocal, 90 BPM, Nostalgic'
    return {'style': style, 'lyrics': raw_lyrics}


async def refine(project: dict, comment: str) -> str:
    """Folds the user's free-text wish into the existing skill prompt as a
    plain instruction sentence; the full prompt (base + examples + this) is
    what actually gets sent to the model on the next generate() call."""
    await asyncio.sleep(0.05)
    base = (project.get('skill_prompt') or '').rstrip()
    if not base:
        return comment.strip()
    if base.endswith(('.', '!', '?')):
        return f'{base} Additionally, {comment.strip()}.'
    return f'{base}. Additionally, {comment.strip()}.'
