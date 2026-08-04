"""Provider seam for scene-storyboard (text) generation - splits a project's
lyrics into `scene_count` scenes, each `{lyric_segment, static_prompt,
motion_prompt}`. Mirrors `suno.py`'s shape closely on purpose (same
provider dispatch, timeout/usage/console-log wiring, debug+usage summary in
the response) so the two screens behave identically to the user even though
this one asks the model for N structured scenes instead of two fixed blocks.

`model` is a composite "{provider}:{model_id}" string (see settings.text_models
/ ScenesStage.jsx's ModelPicker). When the provider is one of
google/openrouter/deepseek and a matching settings.api_keys entry is set,
generate() calls that provider's chat/generateContent API. Otherwise it falls
back to the deterministic stub below (no network call, nothing billed) -
same fallback contract as suno.generate.
"""

import asyncio
import json
import re
import time

import httpx

from .. import console_log, pricing, usage

_GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent'
_OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
_DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions'
_SUPPORTED_PROVIDERS = ('google', 'openrouter', 'deepseek')

DEFAULT_SCENE_COUNT = 10
DEFAULT_STYLE = 'Cinematic, atmospheric lighting, highly detailed, 8k'
SCENE_MODES = ('narrative', 'abstract')

_DEFAULT_TIMEOUT_SECONDS = 60
_JSON_BLOCK_RE = re.compile(r'```(?:json)?\s*(\[.*?\])\s*```', re.DOTALL)


def _timeout_seconds(settings: dict) -> int:
    return int(settings.get('request_timeout_seconds') or _DEFAULT_TIMEOUT_SECONDS)


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


def _stub_scenes(lines: list[str], scene_count: int, style: str, reference_images: list[str]) -> list[dict]:
    ref_note = f', visually guided by {len(reference_images)} uploaded reference image(s)' if reference_images else ''
    chunks = _chunk(lines, scene_count)
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
            'lyric_segment': segment, 'scene_description': '', 'static_prompt': static_prompt,
            'motion_prompt': motion_prompt, 'images': [],
        })
    return scenes


def _build_prompt(
    raw_lyrics: str, base_prompt: str, style_description: str, scene_count: int,
    reference_count: int, active_wishes: list[str] | None,
) -> str:
    wishes_block = ''
    if active_wishes:
        items = '\n'.join(f'{i}. {w}' for i, w in enumerate(active_wishes, start=1))
        wishes_block = 'ВАЖНЫЕ ТРЕБОВАНИЯ ПОЛЬЗОВАТЕЛЯ — обязательно учесть:\n' + items

    style_block = f'Общий визуальный стиль/настроение: {style_description}' if style_description.strip() else ''
    ref_block = (
        f'К проекту приложено {reference_count} референсных изображений стиля — ориентируйся на их эстетику.'
        if reference_count else ''
    )

    instructions = '\n\n'.join(part for part in [base_prompt, wishes_block, style_block, ref_block] if part.strip())

    return (
        f'{instructions}\n\n'
        '---\n'
        f'Исходный текст песни (по строкам, в порядке следования):\n{raw_lyrics}\n\n'
        f'Разбей его ровно на {scene_count} кадров и ответь СТРОГО JSON-массивом из {scene_count} объектов, '
        'без какого-либо текста до или после, внутри блока кода:\n'
        '```json\n'
        '[{"lyric_segment": "<фрагмент текста, к которому относится кадр>", '
        '"scene_description": "<короткое описание на русском (5-8 слов) того, что показано в кадре, '
        'например: \'женщина стоит в пол-оборота на фоне огней\'>", '
        '"static_prompt": "<промпт кадра на английском>", '
        '"motion_prompt": "<описание движения камеры на английском>"}, ...]\n'
        '```'
    )


def _parse_model_response(text: str, lines: list[str], scene_count: int, style: str, reference_images: list[str]) -> tuple[list[dict], bool]:
    """Returns (scenes, missing_markers) - `missing_markers` mirrors
    suno.py's naming for "the model didn't follow the requested format", used
    the same way in the debug panel. Falls back to the deterministic stub
    scenes (still usable, just not personalized) rather than failing the
    request outright, same tolerance suno.py has for a missing marker."""
    match = _JSON_BLOCK_RE.search(text) or re.search(r'(\[.*\])', text, re.DOTALL)
    if match:
        try:
            parsed = json.loads(match.group(1))
            if isinstance(parsed, list) and parsed:
                scenes = []
                for i in range(scene_count):
                    item = parsed[i] if i < len(parsed) else {}
                    scenes.append({
                        'lyric_segment': str(item.get('lyric_segment', '') or ''),
                        'scene_description': str(item.get('scene_description', '') or ''),
                        'static_prompt': str(item.get('static_prompt', '') or '') or f'{style}. Scene {i + 1} of {scene_count}.',
                        'motion_prompt': str(item.get('motion_prompt', '') or '') or 'Slow, deliberate camera movement.',
                        'images': [],
                    })
                return scenes, len(parsed) != scene_count
        except (json.JSONDecodeError, TypeError):
            pass
    return _stub_scenes(lines, scene_count, style, reference_images), True


def _usage_summary(model: str, units: dict, provider_cost: float | None, overrides: dict | None, duration_ms: int) -> dict:
    """Mirrors suno._usage_summary exactly - see that module's docstring."""
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
    prompt: str, lines: list[str], scene_count: int, style: str, reference_images: list[str],
    settings: dict, api_key: str, model_id: str, usage_ctx: dict | None,
) -> dict:
    url = _GEMINI_URL.format(model=model_id)
    model = f'google:{model_id}'
    request_body = {'contents': [{'parts': [{'text': prompt}]}]}
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
        usage.record(usage_ctx, model=model, kind='text', status='error', duration_ms=duration_ms, prompt=prompt, error=error)
        raise RuntimeError(error) from None
    duration_ms = int((time.monotonic() - started) * 1000)

    if resp.status_code != 200:
        usage.record(usage_ctx, model=model, kind='text', status='error', duration_ms=duration_ms,
                      prompt=prompt, error=f'{resp.status_code}: {resp.text[:300]}')
        raise RuntimeError(f'Gemini API вернул {resp.status_code}: {resp.text[:300]}')

    data = resp.json()
    try:
        text = data['candidates'][0]['content']['parts'][0]['text']
    except (KeyError, IndexError) as exc:
        usage.record(usage_ctx, model=model, kind='text', status='error', duration_ms=duration_ms,
                      prompt=prompt, error=f'Неожиданный ответ Gemini: {data}')
        raise RuntimeError(f'Неожиданный ответ Gemini: {data}') from exc

    scenes, missing_markers = _parse_model_response(text, lines, scene_count, style, reference_images)
    usage_metadata = data.get('usageMetadata') or {}
    units = {
        'input_tokens': usage_metadata.get('promptTokenCount'),
        'output_tokens': usage_metadata.get('candidatesTokenCount'),
        'total_tokens': usage_metadata.get('totalTokenCount'),
        'cached_input_tokens': usage_metadata.get('cachedContentTokenCount'),
        'reasoning_tokens': usage_metadata.get('thoughtsTokenCount'),
    }
    debug = {
        'stub': False, 'request': debug_request, 'response': data, 'missing_markers': missing_markers,
        'usage': _usage_summary(model, units, None, settings.get('pricing_overrides'), duration_ms),
    }
    usage.record(usage_ctx, model=model, kind='text', status='ok', duration_ms=duration_ms,
                 units=units, prompt=prompt, response=text)
    return {'scenes': scenes, 'debug': debug}


async def _generate_via_openrouter(
    prompt: str, lines: list[str], scene_count: int, style: str, reference_images: list[str],
    settings: dict, api_key: str, model_id: str, usage_ctx: dict | None,
) -> dict:
    model = f'openrouter:{model_id}'
    request_body = {'model': model_id, 'messages': [{'role': 'user', 'content': prompt}], 'usage': {'include': True}}
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
        usage.record(usage_ctx, model=model, kind='text', status='error', duration_ms=duration_ms, prompt=prompt, error=error)
        raise RuntimeError(error) from None
    duration_ms = int((time.monotonic() - started) * 1000)

    if resp.status_code != 200:
        usage.record(usage_ctx, model=model, kind='text', status='error', duration_ms=duration_ms,
                      prompt=prompt, error=f'{resp.status_code}: {resp.text[:300]}')
        raise RuntimeError(f'OpenRouter API вернул {resp.status_code}: {resp.text[:300]}')

    data = resp.json()
    try:
        text = data['choices'][0]['message']['content']
    except (KeyError, IndexError) as exc:
        usage.record(usage_ctx, model=model, kind='text', status='error', duration_ms=duration_ms,
                      prompt=prompt, error=f'Неожиданный ответ OpenRouter: {data}')
        raise RuntimeError(f'Неожиданный ответ OpenRouter: {data}') from exc

    scenes, missing_markers = _parse_model_response(text, lines, scene_count, style, reference_images)
    u = data.get('usage') or {}
    units = {
        'input_tokens': u.get('prompt_tokens'),
        'output_tokens': u.get('completion_tokens'),
        'total_tokens': u.get('total_tokens'),
        'cached_input_tokens': (u.get('prompt_tokens_details') or {}).get('cached_tokens'),
        'reasoning_tokens': (u.get('completion_tokens_details') or {}).get('reasoning_tokens'),
    }
    debug = {
        'stub': False, 'request': debug_request, 'response': data, 'missing_markers': missing_markers,
        'usage': _usage_summary(model, units, u.get('cost'), settings.get('pricing_overrides'), duration_ms),
    }
    usage.record(usage_ctx, model=model, kind='text', status='ok', duration_ms=duration_ms,
                 units=units, prompt=prompt, response=text, provider_cost=u.get('cost'))
    return {'scenes': scenes, 'debug': debug}


async def _generate_via_deepseek(
    prompt: str, lines: list[str], scene_count: int, style: str, reference_images: list[str],
    settings: dict, api_key: str, model_id: str, usage_ctx: dict | None,
) -> dict:
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
        usage.record(usage_ctx, model=model, kind='text', status='error', duration_ms=duration_ms, prompt=prompt, error=error)
        raise RuntimeError(error) from None
    duration_ms = int((time.monotonic() - started) * 1000)

    if resp.status_code != 200:
        usage.record(usage_ctx, model=model, kind='text', status='error', duration_ms=duration_ms,
                      prompt=prompt, error=f'{resp.status_code}: {resp.text[:300]}')
        raise RuntimeError(f'DeepSeek API вернул {resp.status_code}: {resp.text[:300]}')

    data = resp.json()
    try:
        text = data['choices'][0]['message']['content']
    except (KeyError, IndexError) as exc:
        usage.record(usage_ctx, model=model, kind='text', status='error', duration_ms=duration_ms,
                      prompt=prompt, error=f'Неожиданный ответ DeepSeek: {data}')
        raise RuntimeError(f'Неожиданный ответ DeepSeek: {data}') from exc

    scenes, missing_markers = _parse_model_response(text, lines, scene_count, style, reference_images)
    u = data.get('usage') or {}
    units = {
        'input_tokens': u.get('prompt_tokens'),
        'output_tokens': u.get('completion_tokens'),
        'total_tokens': u.get('total_tokens'),
        'cached_input_tokens': u.get('prompt_cache_hit_tokens'),
    }
    debug = {
        'stub': False, 'request': debug_request, 'response': data, 'missing_markers': missing_markers,
        'usage': _usage_summary(model, units, None, settings.get('pricing_overrides'), duration_ms),
    }
    usage.record(usage_ctx, model=model, kind='text', status='ok', duration_ms=duration_ms,
                 units=units, prompt=prompt, response=text)
    return {'scenes': scenes, 'debug': debug}


async def generate(
    project: dict,
    style_description: str = '',
    reference_images: list[str] | None = None,
    scene_count: int = DEFAULT_SCENE_COUNT,
    model: str = '',
    scene_mode: str = 'narrative',
    settings: dict | None = None,
    usage_ctx: dict | None = None,
    active_wishes: list[str] | None = None,
) -> dict:
    settings = settings or {}
    reference_images = reference_images or []
    scene_count = max(1, int(scene_count or DEFAULT_SCENE_COUNT))
    scene_mode = scene_mode if scene_mode in SCENE_MODES else 'narrative'
    style = style_description.strip() or DEFAULT_STYLE
    lines = _lyric_lines(project.get('blocks', []))
    raw_lyrics = '\n'.join(lines)

    provider, _, model_id = model.partition(':')
    api_key = (settings.get('api_keys') or {}).get(provider, '')

    if model_id and api_key and provider in _SUPPORTED_PROVIDERS:
        base_prompt = settings.get(f'scene_base_prompt_{scene_mode}', '')
        prompt = _build_prompt(raw_lyrics, base_prompt, style_description, scene_count, len(reference_images), active_wishes)
        if provider == 'google':
            return await _generate_via_gemini(prompt, lines, scene_count, style, reference_images, settings, api_key, model_id, usage_ctx)
        if provider == 'openrouter':
            return await _generate_via_openrouter(prompt, lines, scene_count, style, reference_images, settings, api_key, model_id, usage_ctx)
        return await _generate_via_deepseek(prompt, lines, scene_count, style, reference_images, settings, api_key, model_id, usage_ctx)

    # No network call here (deterministic stub), so nothing to bill - the
    # ledger must not record a call that never happened.
    await asyncio.sleep(0.05)
    if not model_id:
        reason = 'no_model_selected'
    elif provider not in _SUPPORTED_PROVIDERS:
        reason = 'unsupported_provider'
    else:
        reason = 'no_api_key'
    scenes = _stub_scenes(lines, scene_count, style, reference_images)
    return {'scenes': scenes, 'debug': {'stub': True, 'reason': reason, 'requested_model': model}}
