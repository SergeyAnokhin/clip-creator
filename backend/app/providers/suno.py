import asyncio
import time

import httpx

from .. import console_log, pricing, usage

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
_SUPPORTED_PROVIDERS = ('google', 'google_free', 'openrouter', 'deepseek')
_STYLE_MARKER = '===STYLE==='
_LYRICS_MARKER = '===LYRICS==='
# How long we'll wait on a single provider call before giving up. Falls back
# to this when settings.request_timeout_seconds (Settings -> General, see
# routers/settings.py's DEFAULT_SETTINGS) isn't set - an unbounded wait would
# leave the UI's "waiting" spinner stuck forever on a hung connection.
_DEFAULT_TIMEOUT_SECONDS = 60


def _timeout_seconds(settings: dict) -> int:
    return int(settings.get('request_timeout_seconds') or _DEFAULT_TIMEOUT_SECONDS)


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


def _usage_summary(model: str, units: dict, provider_cost: float | None,
                    overrides: dict | None, duration_ms: int) -> dict:
    """Token counts + cost + wall-clock time for the debug panel. Mirrors
    usage._write's cost-source priority exactly - a provider-reported cost
    (currently only OpenRouter's `usage.cost`) always wins over the catalog
    estimate, so this never disagrees with what actually lands in the
    ledger. `source: 'provider'` means exact; `'catalog'` means estimated
    from `pricing.BUILTIN_PRICING`/overrides; `'unknown'` means no price is
    known for the model."""
    if provider_cost is not None:
        amount, source = float(provider_cost), 'provider'
    else:
        amount, source = pricing.compute_cost(model, units, overrides)
    return {
        'duration_ms': duration_ms,
        'input_tokens': units.get('input_tokens'),
        'output_tokens': units.get('output_tokens'),
        'total_tokens': units.get('total_tokens'),
        'reasoning_tokens': units.get('reasoning_tokens'),
        'cached_input_tokens': units.get('cached_input_tokens'),
        'cost': {'amount': amount, 'currency': pricing.CURRENCY, 'source': source},
    }


async def _generate_via_gemini(
    raw_lyrics: str, skill_prompt: str, settings: dict, api_key: str, model_id: str,
    usage_ctx: dict | None = None, active_wishes: list[str] | None = None, provider: str = 'google',
) -> dict:
    prompt = _build_prompt(raw_lyrics, skill_prompt, settings, active_wishes)
    url = _GEMINI_URL.format(model=model_id)
    model = f'{provider}:{model_id}'
    request_body = {'contents': [{'parts': [{'text': prompt}]}]}
    # `url` never carries the API key (that's passed via `params=` below), so
    # it's safe to hand back verbatim for the debug panel.
    debug_request = {'url': url, 'model': model_id, 'body': request_body}
    timeout_seconds = _timeout_seconds(settings)

    started = time.monotonic()
    console_log.log_request_start(model, 'text', usage_ctx.get('task') if usage_ctx else None)
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as http_client:
            resp = await http_client.post(url, params={'key': api_key}, json=request_body)
    except httpx.TimeoutException:
        duration_ms = int((time.monotonic() - started) * 1000)
        error = f'Таймаут: модель {model} не ответила за {timeout_seconds} секунд.'
        usage.record(usage_ctx, model=model, kind='text', status='error', duration_ms=duration_ms,
                      prompt=raw_lyrics, error=error, debug={'request': debug_request})
        raise RuntimeError(error) from None
    duration_ms = int((time.monotonic() - started) * 1000)

    if resp.status_code != 200:
        usage.record(usage_ctx, model=model, kind='text', status='error', duration_ms=duration_ms,
                      prompt=raw_lyrics, error=f'{resp.status_code}: {resp.text[:300]}',
                      debug={'request': debug_request, 'response': {'status': resp.status_code, 'text': resp.text[:500]}})
        raise RuntimeError(f'Gemini API вернул {resp.status_code}: {resp.text[:300]}')

    data = resp.json()
    try:
        text = data['candidates'][0]['content']['parts'][0]['text']
    except (KeyError, IndexError) as exc:
        usage.record(usage_ctx, model=model, kind='text', status='error', duration_ms=duration_ms,
                      prompt=raw_lyrics, error=f'Неожиданный ответ Gemini: {data}',
                      debug={'request': debug_request, 'response': data})
        raise RuntimeError(f'Неожиданный ответ Gemini: {data}') from exc

    result = _parse_model_response(text, raw_lyrics)
    usage_metadata = data.get('usageMetadata') or {}
    units = {
        'input_tokens': usage_metadata.get('promptTokenCount'),
        'output_tokens': usage_metadata.get('candidatesTokenCount'),
        'total_tokens': usage_metadata.get('totalTokenCount'),
        'cached_input_tokens': usage_metadata.get('cachedContentTokenCount'),
        'reasoning_tokens': usage_metadata.get('thoughtsTokenCount'),
    }
    result['debug'] = {
        'stub': False, 'request': debug_request, 'response': data, 'missing_markers': _LYRICS_MARKER not in text,
        'usage': _usage_summary(model, units, None, settings.get('pricing_overrides'), duration_ms),
    }
    usage.record(usage_ctx, model=model, kind='text', status='ok', duration_ms=duration_ms,
                 units=units, prompt=raw_lyrics, response=text, debug=result['debug'])
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
    timeout_seconds = _timeout_seconds(settings)

    started = time.monotonic()
    console_log.log_request_start(model, 'text', usage_ctx.get('task') if usage_ctx else None)
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as http_client:
            resp = await http_client.post(_OPENROUTER_URL, headers={'Authorization': f'Bearer {api_key}'}, json=request_body)
    except httpx.TimeoutException:
        duration_ms = int((time.monotonic() - started) * 1000)
        error = f'Таймаут: модель {model} не ответила за {timeout_seconds} секунд.'
        usage.record(usage_ctx, model=model, kind='text', status='error', duration_ms=duration_ms,
                      prompt=raw_lyrics, error=error, debug={'request': debug_request})
        raise RuntimeError(error) from None
    duration_ms = int((time.monotonic() - started) * 1000)

    if resp.status_code != 200:
        usage.record(usage_ctx, model=model, kind='text', status='error', duration_ms=duration_ms,
                      prompt=raw_lyrics, error=f'{resp.status_code}: {resp.text[:300]}',
                      debug={'request': debug_request, 'response': {'status': resp.status_code, 'text': resp.text[:500]}})
        raise RuntimeError(f'OpenRouter API вернул {resp.status_code}: {resp.text[:300]}')

    data = resp.json()
    try:
        text = data['choices'][0]['message']['content']
    except (KeyError, IndexError) as exc:
        usage.record(usage_ctx, model=model, kind='text', status='error', duration_ms=duration_ms,
                      prompt=raw_lyrics, error=f'Неожиданный ответ OpenRouter: {data}',
                      debug={'request': debug_request, 'response': data})
        raise RuntimeError(f'Неожиданный ответ OpenRouter: {data}') from exc

    result = _parse_model_response(text, raw_lyrics)
    u = data.get('usage') or {}
    units = {
        'input_tokens': u.get('prompt_tokens'),
        'output_tokens': u.get('completion_tokens'),
        'total_tokens': u.get('total_tokens'),
        'cached_input_tokens': (u.get('prompt_tokens_details') or {}).get('cached_tokens'),
        'reasoning_tokens': (u.get('completion_tokens_details') or {}).get('reasoning_tokens'),
    }
    result['debug'] = {
        'stub': False, 'request': debug_request, 'response': data, 'missing_markers': _LYRICS_MARKER not in text,
        # OpenRouter reports the exact USD cost when `usage: {include: true}`
        # is set on the request - it wins over the catalog estimate, same
        # priority as usage.record's provider_cost handling below.
        'usage': _usage_summary(model, units, u.get('cost'), settings.get('pricing_overrides'), duration_ms),
    }
    usage.record(usage_ctx, model=model, kind='text', status='ok', duration_ms=duration_ms,
                 units=units, prompt=raw_lyrics, response=text, provider_cost=u.get('cost'), debug=result['debug'])
    return result


async def _generate_via_deepseek(
    raw_lyrics: str, skill_prompt: str, settings: dict, api_key: str, model_id: str,
    usage_ctx: dict | None = None, active_wishes: list[str] | None = None,
) -> dict:
    prompt = _build_prompt(raw_lyrics, skill_prompt, settings, active_wishes)
    model = f'deepseek:{model_id}'
    request_body = {'model': model_id, 'messages': [{'role': 'user', 'content': prompt}]}
    debug_request = {'url': _DEEPSEEK_URL, 'model': model_id, 'body': request_body}
    timeout_seconds = _timeout_seconds(settings)

    started = time.monotonic()
    console_log.log_request_start(model, 'text', usage_ctx.get('task') if usage_ctx else None)
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as http_client:
            resp = await http_client.post(_DEEPSEEK_URL, headers={'Authorization': f'Bearer {api_key}'}, json=request_body)
    except httpx.TimeoutException:
        duration_ms = int((time.monotonic() - started) * 1000)
        error = f'Таймаут: модель {model} не ответила за {timeout_seconds} секунд.'
        usage.record(usage_ctx, model=model, kind='text', status='error', duration_ms=duration_ms,
                      prompt=raw_lyrics, error=error, debug={'request': debug_request})
        raise RuntimeError(error) from None
    duration_ms = int((time.monotonic() - started) * 1000)

    if resp.status_code != 200:
        usage.record(usage_ctx, model=model, kind='text', status='error', duration_ms=duration_ms,
                      prompt=raw_lyrics, error=f'{resp.status_code}: {resp.text[:300]}',
                      debug={'request': debug_request, 'response': {'status': resp.status_code, 'text': resp.text[:500]}})
        raise RuntimeError(f'DeepSeek API вернул {resp.status_code}: {resp.text[:300]}')

    data = resp.json()
    try:
        text = data['choices'][0]['message']['content']
    except (KeyError, IndexError) as exc:
        usage.record(usage_ctx, model=model, kind='text', status='error', duration_ms=duration_ms,
                      prompt=raw_lyrics, error=f'Неожиданный ответ DeepSeek: {data}',
                      debug={'request': debug_request, 'response': data})
        raise RuntimeError(f'Неожиданный ответ DeepSeek: {data}') from exc

    result = _parse_model_response(text, raw_lyrics)
    u = data.get('usage') or {}
    units = {
        'input_tokens': u.get('prompt_tokens'),
        'output_tokens': u.get('completion_tokens'),
        'total_tokens': u.get('total_tokens'),
        'cached_input_tokens': u.get('prompt_cache_hit_tokens'),
    }
    result['debug'] = {
        'stub': False, 'request': debug_request, 'response': data, 'missing_markers': _LYRICS_MARKER not in text,
        # DeepSeek's own API never reports a USD cost, unlike OpenRouter -
        # this is always a catalog estimate (or unknown if the model has no
        # price row), which _usage_summary/pricing.compute_cost reflect via
        # cost.source.
        'usage': _usage_summary(model, units, None, settings.get('pricing_overrides'), duration_ms),
    }
    usage.record(usage_ctx, model=model, kind='text', status='ok', duration_ms=duration_ms,
                 units=units, prompt=raw_lyrics, response=text, debug=result['debug'])
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
        if provider in ('google', 'google_free'):
            return await _generate_via_gemini(raw_lyrics, skill_prompt, settings, api_key, model_id, usage_ctx, active_wishes, provider)
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
