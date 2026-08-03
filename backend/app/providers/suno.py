import asyncio
import time

import httpx

from .. import usage

# Real seam: `model` is a composite "{provider}:{model_id}" string (see
# settings.text_models). When the provider is one of google/openrouter/deepseek
# and a matching settings.api_keys entry is set, generate() calls that
# provider's API with the given model_id. Otherwise it falls back to the
# deterministic stub below (no network calls), which keeps existing tests and
# no-key setups working - replicate/fal/krea (and any unknown provider) have
# no chat-completion call wired here, same as text_models.generate_wish_title.

_TYPE_LABELS = {
    'intro': 'Intro', 'verse': 'Verse', 'chorus': 'Chorus',
    'bridge': 'Bridge', 'outro': 'Outro',
}

_GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent'
_OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
_DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions'
_SUPPORTED_PROVIDERS = ('google', 'openrouter', 'deepseek')
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


def _build_prompt(raw_lyrics: str, skill_prompt: str, settings: dict, active_wishes: list[str] | None = None) -> str:
    base_prompt = settings.get('suno_base_prompt', '')
    examples = settings.get('suno_reference_examples', [])
    examples_block = ''
    if examples:
        labeled = [f'Пример {i}:\n{ex}' for i, ex in enumerate(examples, start=1)]
        examples_block = 'Эталонные примеры адаптации (ориентир по тону и формату, не копировать дословно):\n\n' + '\n\n---\n\n'.join(labeled)

    wishes_block = ''
    if active_wishes:
        items = '\n'.join(f'{i}. {w}' for i, w in enumerate(active_wishes, start=1))
        wishes_block = 'ВАЖНЫЕ ТРЕБОВАНИЯ ПОЛЬЗОВАТЕЛЯ — обязательно учесть:\n' + items

    instructions = '\n\n'.join(part for part in [base_prompt, wishes_block, examples_block, skill_prompt] if part.strip())

    return (
        f'{instructions}\n\n'
        '---\n'
        f'Исходная структурированная лирика для адаптации:\n{raw_lyrics}\n\n'
        'Ответь СТРОГО в этом формате, без какого-либо текста до или после:\n'
        f'{_STYLE_MARKER}\n<style-block здесь>\n{_LYRICS_MARKER}\n<lyrics-markup здесь>'
    )


def _parse_model_response(text: str, fallback_lyrics: str) -> dict:
    if _LYRICS_MARKER in text:
        before, lyrics = text.split(_LYRICS_MARKER, 1)
        style = before.split(_STYLE_MARKER, 1)[-1].strip()
        return {'style': style, 'lyrics': lyrics.strip()}
    # Model didn't follow the marker format - use the whole reply as lyrics
    # rather than failing the request outright.
    return {'style': '', 'lyrics': text.strip() or fallback_lyrics}


async def _generate_via_gemini(
    raw_lyrics: str, skill_prompt: str, settings: dict, api_key: str, model_id: str,
    usage_ctx: dict | None = None, active_wishes: list[str] | None = None,
) -> dict:
    prompt = _build_prompt(raw_lyrics, skill_prompt, settings, active_wishes)
    url = _GEMINI_URL.format(model=model_id)
    model = f'google:{model_id}'
    request_body = {'contents': [{'parts': [{'text': prompt}]}]}
    # `url` never carries the API key (that's passed via `params=` below), so
    # it's safe to hand back verbatim for the debug panel.
    debug_request = {'url': url, 'model': model_id, 'body': request_body}

    started = time.monotonic()
    async with httpx.AsyncClient(timeout=60) as http_client:
        resp = await http_client.post(url, params={'key': api_key}, json=request_body)
    duration_ms = int((time.monotonic() - started) * 1000)

    if resp.status_code != 200:
        usage.record(usage_ctx, model=model, kind='text', status='error', duration_ms=duration_ms,
                      prompt=raw_lyrics, error=f'{resp.status_code}: {resp.text[:300]}')
        raise RuntimeError(f'Gemini API вернул {resp.status_code}: {resp.text[:300]}')

    data = resp.json()
    try:
        text = data['candidates'][0]['content']['parts'][0]['text']
    except (KeyError, IndexError) as exc:
        usage.record(usage_ctx, model=model, kind='text', status='error', duration_ms=duration_ms,
                      prompt=raw_lyrics, error=f'Неожиданный ответ Gemini: {data}')
        raise RuntimeError(f'Неожиданный ответ Gemini: {data}') from exc

    result = _parse_model_response(text, raw_lyrics)
    result['debug'] = {
        'stub': False, 'request': debug_request, 'response': data, 'missing_markers': _LYRICS_MARKER not in text,
    }
    usage_metadata = data.get('usageMetadata') or {}
    units = {
        'input_tokens': usage_metadata.get('promptTokenCount'),
        'output_tokens': usage_metadata.get('candidatesTokenCount'),
        'total_tokens': usage_metadata.get('totalTokenCount'),
        'cached_input_tokens': usage_metadata.get('cachedContentTokenCount'),
        'reasoning_tokens': usage_metadata.get('thoughtsTokenCount'),
    }
    usage.record(usage_ctx, model=model, kind='text', status='ok', duration_ms=duration_ms,
                 units=units, prompt=raw_lyrics, response=text)
    return result


async def _generate_via_openrouter(
    raw_lyrics: str, skill_prompt: str, settings: dict, api_key: str, model_id: str,
    usage_ctx: dict | None = None, active_wishes: list[str] | None = None,
) -> dict:
    prompt = _build_prompt(raw_lyrics, skill_prompt, settings, active_wishes)
    model = f'openrouter:{model_id}'
    request_body = {
        'model': model_id, 'messages': [{'role': 'user', 'content': prompt}], 'usage': {'include': True},
    }
    debug_request = {'url': _OPENROUTER_URL, 'model': model_id, 'body': request_body}

    started = time.monotonic()
    async with httpx.AsyncClient(timeout=60) as http_client:
        resp = await http_client.post(_OPENROUTER_URL, headers={'Authorization': f'Bearer {api_key}'}, json=request_body)
    duration_ms = int((time.monotonic() - started) * 1000)

    if resp.status_code != 200:
        usage.record(usage_ctx, model=model, kind='text', status='error', duration_ms=duration_ms,
                      prompt=raw_lyrics, error=f'{resp.status_code}: {resp.text[:300]}')
        raise RuntimeError(f'OpenRouter API вернул {resp.status_code}: {resp.text[:300]}')

    data = resp.json()
    try:
        text = data['choices'][0]['message']['content']
    except (KeyError, IndexError) as exc:
        usage.record(usage_ctx, model=model, kind='text', status='error', duration_ms=duration_ms,
                      prompt=raw_lyrics, error=f'Неожиданный ответ OpenRouter: {data}')
        raise RuntimeError(f'Неожиданный ответ OpenRouter: {data}') from exc

    result = _parse_model_response(text, raw_lyrics)
    result['debug'] = {
        'stub': False, 'request': debug_request, 'response': data, 'missing_markers': _LYRICS_MARKER not in text,
    }
    u = data.get('usage') or {}
    units = {
        'input_tokens': u.get('prompt_tokens'),
        'output_tokens': u.get('completion_tokens'),
        'total_tokens': u.get('total_tokens'),
        'cached_input_tokens': (u.get('prompt_tokens_details') or {}).get('cached_tokens'),
        'reasoning_tokens': (u.get('completion_tokens_details') or {}).get('reasoning_tokens'),
    }
    # OpenRouter reports the exact USD cost when `usage: {include: true}` is
    # set on the request - it wins over the catalog estimate (see
    # usage.record's provider_cost handling).
    usage.record(usage_ctx, model=model, kind='text', status='ok', duration_ms=duration_ms,
                 units=units, prompt=raw_lyrics, response=text, provider_cost=u.get('cost'))
    return result


async def _generate_via_deepseek(
    raw_lyrics: str, skill_prompt: str, settings: dict, api_key: str, model_id: str,
    usage_ctx: dict | None = None, active_wishes: list[str] | None = None,
) -> dict:
    prompt = _build_prompt(raw_lyrics, skill_prompt, settings, active_wishes)
    model = f'deepseek:{model_id}'
    request_body = {'model': model_id, 'messages': [{'role': 'user', 'content': prompt}]}
    debug_request = {'url': _DEEPSEEK_URL, 'model': model_id, 'body': request_body}

    started = time.monotonic()
    async with httpx.AsyncClient(timeout=60) as http_client:
        resp = await http_client.post(_DEEPSEEK_URL, headers={'Authorization': f'Bearer {api_key}'}, json=request_body)
    duration_ms = int((time.monotonic() - started) * 1000)

    if resp.status_code != 200:
        usage.record(usage_ctx, model=model, kind='text', status='error', duration_ms=duration_ms,
                      prompt=raw_lyrics, error=f'{resp.status_code}: {resp.text[:300]}')
        raise RuntimeError(f'DeepSeek API вернул {resp.status_code}: {resp.text[:300]}')

    data = resp.json()
    try:
        text = data['choices'][0]['message']['content']
    except (KeyError, IndexError) as exc:
        usage.record(usage_ctx, model=model, kind='text', status='error', duration_ms=duration_ms,
                      prompt=raw_lyrics, error=f'Неожиданный ответ DeepSeek: {data}')
        raise RuntimeError(f'Неожиданный ответ DeepSeek: {data}') from exc

    result = _parse_model_response(text, raw_lyrics)
    result['debug'] = {
        'stub': False, 'request': debug_request, 'response': data, 'missing_markers': _LYRICS_MARKER not in text,
    }
    u = data.get('usage') or {}
    units = {
        'input_tokens': u.get('prompt_tokens'),
        'output_tokens': u.get('completion_tokens'),
        'total_tokens': u.get('total_tokens'),
        'cached_input_tokens': u.get('prompt_cache_hit_tokens'),
    }
    usage.record(usage_ctx, model=model, kind='text', status='ok', duration_ms=duration_ms,
                 units=units, prompt=raw_lyrics, response=text)
    return result


async def generate(
    project: dict, skill_prompt: str = '', model: str = '', settings: dict | None = None,
    usage_ctx: dict | None = None, active_wishes: list[str] | None = None,
) -> dict:
    settings = settings or {}
    raw_lyrics = _format_lyrics(project.get('blocks', []))

    provider, _, model_id = model.partition(':')
    api_key = (settings.get('api_keys') or {}).get(provider, '')

    if model_id and api_key and provider in _SUPPORTED_PROVIDERS:
        if provider == 'google':
            return await _generate_via_gemini(raw_lyrics, skill_prompt, settings, api_key, model_id, usage_ctx, active_wishes)
        if provider == 'openrouter':
            return await _generate_via_openrouter(raw_lyrics, skill_prompt, settings, api_key, model_id, usage_ctx, active_wishes)
        return await _generate_via_deepseek(raw_lyrics, skill_prompt, settings, api_key, model_id, usage_ctx, active_wishes)

    # No network call here (deterministic stub), so nothing to bill - the
    # ledger must not record a call that never happened.
    await asyncio.sleep(0.05)
    style = project.get('style') or 'Cinematic Orchestral Folk, Warm Vocal, 90 BPM, Nostalgic'
    if not model_id:
        reason = 'no_model_selected'
    elif provider not in _SUPPORTED_PROVIDERS:
        reason = 'unsupported_provider'
    else:
        reason = 'no_api_key'
    return {
        'style': style,
        'lyrics': raw_lyrics,
        'debug': {'stub': True, 'reason': reason, 'requested_model': model},
    }
