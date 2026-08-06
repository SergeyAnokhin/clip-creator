"""Provider seam for generic text-model catalog lookups and short completions
(distinct from suno.py, which owns the Suno style/lyrics prompt shape).

Google, OpenRouter and DeepSeek expose a real "list models" API, so
refreshing the catalog for those is a live call (DeepSeek's API is
OpenAI-compatible: GET/POST against https://api.deepseek.com/v1). Replicate
and FAL don't have a filterable list-of-chat-models endpoint worth calling
here (Replicate's catalog spans every modality; FAL has no equivalent public
listing), so those two fall back to a small curated constant - the user can
still add any model id manually in the UI.

Google's and OpenRouter's listings both include image-generation models
alongside real text models (Gemini's "Nano Banana" family answers through
the same `generateContent` method as text; OpenRouter's `/models` is one
combined catalog for every modality) - both are filtered out here via
`image_models.is_gemini_image_model` / `is_openrouter_image_model` so they
only show up in image_models.py's catalog, not this one.
"""

import time

import httpx

from .. import console_log, usage
from . import image_models

_DEFAULT_TIMEOUT_SECONDS = 60

_GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models'
_GEMINI_GENERATE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent'
_OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
_OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'
_DEEPSEEK_MODELS_URL = 'https://api.deepseek.com/v1/models'
_DEEPSEEK_CHAT_URL = 'https://api.deepseek.com/v1/chat/completions'

CURATED_MODELS = {
    'replicate': [
        {'id': 'meta/meta-llama-3-70b-instruct', 'name': 'Llama 3 70B Instruct'},
        {'id': 'meta/meta-llama-3-8b-instruct', 'name': 'Llama 3 8B Instruct'},
        {'id': 'mistralai/mixtral-8x7b-instruct-v0.1', 'name': 'Mixtral 8x7B Instruct'},
        {'id': 'deepseek-ai/deepseek-v3', 'name': 'DeepSeek V3'},
    ],
    'fal': [
        {'id': 'fal-ai/any-llm', 'name': 'Any-LLM (router)'},
        {'id': 'fal-ai/whisper', 'name': 'Whisper (speech-to-text)'},
    ],
}

_TITLE_PROMPT = (
    'Придумай короткий заголовок (3-6 слов, без точки в конце) для следующего '
    'пожелания к песне. Ответь только заголовком, без кавычек и пояснений.\n\n{text}'
)

_WISH_MARKER = '===WISH==='
_TITLE_MARKER = '===TITLE==='

_WISH_CLEAN_AND_TITLE_PROMPT = (
    'Ниже — свободный текст пожелания к песне, возможно надиктованный голосом: в нём могут быть '
    'слова-паразиты, повторы или несвязные фрагменты.\n'
    '1) Перепиши его одним связным предложением на том же языке, сохранив авторский смысл и все '
    'конкретные детали, ничего не добавляя от себя.\n'
    '2) Придумай короткий заголовок для него (3-6 слов, без точки в конце) и поставь перед ним ровно один '
    'эмодзи, который лучше всего передаёт суть пожелания (например: 🎸 инструменты, 🎤 вокал, 💃 темп/энергия, '
    '💔 грустное настроение) — заголовок должен выглядеть как "<эмодзи> <текст>".\n'
    'Ответь СТРОГО в этом формате, без какого-либо текста до или после:\n'
    + _WISH_MARKER + '\n<переписанный текст здесь>\n' + _TITLE_MARKER + '\n<эмодзи и заголовок здесь>'
    + '\n\nИсходный текст:\n{text}'
)


def _parse_wish_response(raw: str, fallback_text: str) -> dict:
    if _TITLE_MARKER in raw:
        before, title = raw.split(_TITLE_MARKER, 1)
        clean_text = before.split(_WISH_MARKER, 1)[-1].strip()
        return {'clean_text': clean_text or fallback_text, 'title': title.strip() or truncate_title(fallback_text)}
    # Model didn't follow the marker format - fall back rather than sending a
    # malformed clean_text/title downstream.
    return {'clean_text': fallback_text, 'title': truncate_title(fallback_text)}


async def list_models(provider: str, api_key: str) -> dict:
    try:
        if provider in ('google', 'google_free'):
            return await _list_google(provider, api_key)
        if provider == 'openrouter':
            return await _list_openrouter(api_key)
        if provider == 'deepseek':
            return await _list_deepseek(api_key)
        if provider in CURATED_MODELS:
            return {'provider': provider, 'source': 'curated', 'models': CURATED_MODELS[provider]}
        return {'provider': provider, 'source': 'error', 'models': [], 'error': f'Unknown provider: {provider}'}
    except Exception as exc:
        return {'provider': provider, 'source': 'error', 'models': [], 'error': str(exc)}


async def _list_google(provider: str, api_key: str) -> dict:
    if not api_key:
        return {'provider': provider, 'source': 'error', 'models': [], 'error': 'Нет API-ключа Google'}
    async with httpx.AsyncClient(timeout=20) as http_client:
        resp = await http_client.get(_GEMINI_MODELS_URL, params={'key': api_key})
    if resp.status_code != 200:
        return {'provider': provider, 'source': 'error', 'models': [], 'error': f'{resp.status_code}: {resp.text[:200]}'}
    data = resp.json()
    models = []
    for m in data.get('models', []):
        if 'generateContent' not in m.get('supportedGenerationMethods', []):
            continue
        model_id = (m.get('name') or '').removeprefix('models/')
        if not model_id:
            continue
        # Gemini's "Nano Banana" image-generation family also answers through
        # generateContent - it belongs in image_models.py's catalog instead
        # (see is_gemini_image_model there for why this can't be told apart
        # via supportedGenerationMethods alone).
        if image_models.is_gemini_image_model(model_id):
            continue
        models.append({'id': model_id, 'name': m.get('displayName') or model_id})
    return {'provider': provider, 'source': 'live', 'models': models}


async def _list_openrouter(api_key: str) -> dict:
    headers = {'Authorization': f'Bearer {api_key}'} if api_key else {}
    async with httpx.AsyncClient(timeout=20) as http_client:
        resp = await http_client.get(_OPENROUTER_MODELS_URL, headers=headers)
    if resp.status_code != 200:
        return {'provider': 'openrouter', 'source': 'error', 'models': [], 'error': f'{resp.status_code}: {resp.text[:200]}'}
    data = resp.json()
    models = [
        {'id': m.get('id', ''), 'name': m.get('name') or m.get('id', '')}
        for m in data.get('data', [])
        # Models that generate images (Nano Banana included) belong in
        # image_models.py's OpenRouter catalog instead - see
        # is_openrouter_image_model there.
        if m.get('id') and not image_models.is_openrouter_image_model(m)
    ]
    return {'provider': 'openrouter', 'source': 'live', 'models': models}


async def _list_deepseek(api_key: str) -> dict:
    if not api_key:
        return {'provider': 'deepseek', 'source': 'error', 'models': [], 'error': 'Нет API-ключа DeepSeek'}
    headers = {'Authorization': f'Bearer {api_key}'}
    async with httpx.AsyncClient(timeout=20) as http_client:
        resp = await http_client.get(_DEEPSEEK_MODELS_URL, headers=headers)
    if resp.status_code != 200:
        return {'provider': 'deepseek', 'source': 'error', 'models': [], 'error': f'{resp.status_code}: {resp.text[:200]}'}
    data = resp.json()
    models = [
        {'id': m.get('id', ''), 'name': m.get('id', '')}
        for m in data.get('data', []) if m.get('id')
    ]
    return {'provider': 'deepseek', 'source': 'live', 'models': models}


def truncate_title(text: str) -> str:
    words = text.strip().split()
    short = ' '.join(words[:6])
    if len(short) > 40:
        short = short[:40].rstrip()
    if len(words) > 6 or len(text.strip()) > len(short):
        short += '…'
    return short or text.strip()


async def generate_wish_title(text: str, settings: dict, usage_ctx: dict | None = None) -> str:
    text = (text or '').strip()
    if not text:
        return text

    default = ((settings.get('simple_models') or {}).get('default') or '').strip()
    provider, _, model_id = default.partition(':')
    api_key = (settings.get('api_keys') or {}).get(provider, '')
    timeout = int(settings.get('request_timeout_seconds') or _DEFAULT_TIMEOUT_SECONDS)

    try:
        if provider in ('google', 'google_free') and model_id and api_key:
            title = await _complete_google(provider, model_id, api_key, text, usage_ctx, timeout=timeout)
        elif provider == 'openrouter' and model_id and api_key:
            title = await _complete_openrouter(model_id, api_key, text, usage_ctx, timeout=timeout)
        elif provider == 'deepseek' and model_id and api_key:
            title = await _complete_deepseek(model_id, api_key, text, usage_ctx, timeout=timeout)
        else:
            return truncate_title(text)
        return title.strip().strip('"').strip() or truncate_title(text)
    except Exception:
        # generate_wish_title() always degrades to a truncated title rather
        # than failing the request - but the _complete_* functions below
        # still record the failed call themselves before raising, so the
        # ledger reflects it even though the caller never sees the error.
        return truncate_title(text)


async def clean_wish_and_title(text: str, settings: dict, usage_ctx: dict | None = None) -> dict:
    """Runs the user's free-text wish (often voice-dictated, so possibly
    rambling/repetitive) through the configured `simple_models` model,
    tidying it into one clean sentence and, in the same call, producing a
    short emoji-prefixed title - used when saving a wish to the library
    (see providers/wish_library.py). Falls back to the original text
    verbatim + a truncated title whenever no simple model/key is configured
    or the call fails."""
    text = (text or '').strip()
    if not text:
        return {'clean_text': text, 'title': text}

    default = ((settings.get('simple_models') or {}).get('default') or '').strip()
    provider, _, model_id = default.partition(':')
    api_key = (settings.get('api_keys') or {}).get(provider, '')
    timeout = int(settings.get('request_timeout_seconds') or _DEFAULT_TIMEOUT_SECONDS)

    try:
        if provider in ('google', 'google_free') and model_id and api_key:
            raw = await _complete_google(provider, model_id, api_key, text, usage_ctx, prompt_template=_WISH_CLEAN_AND_TITLE_PROMPT, timeout=timeout)
        elif provider == 'openrouter' and model_id and api_key:
            raw = await _complete_openrouter(model_id, api_key, text, usage_ctx, prompt_template=_WISH_CLEAN_AND_TITLE_PROMPT, timeout=timeout)
        elif provider == 'deepseek' and model_id and api_key:
            raw = await _complete_deepseek(model_id, api_key, text, usage_ctx, prompt_template=_WISH_CLEAN_AND_TITLE_PROMPT, timeout=timeout)
        else:
            return {'clean_text': text, 'title': truncate_title(text)}
        return _parse_wish_response(raw, text)
    except Exception:
        return {'clean_text': text, 'title': truncate_title(text)}


async def _complete_google(
    provider: str, model_id: str, api_key: str, text: str, usage_ctx: dict | None = None, *,
    prompt_template: str = _TITLE_PROMPT, timeout: int = _DEFAULT_TIMEOUT_SECONDS,
) -> str:
    model = f'{provider}:{model_id}'
    prompt = prompt_template.format(text=text)
    started = time.monotonic()
    console_log.log_request_start(model, 'text', usage_ctx.get('task') if usage_ctx else None)
    url = _GEMINI_GENERATE_URL.format(model=model_id)
    async with httpx.AsyncClient(timeout=timeout) as http_client:
        resp = await http_client.post(
            url,
            params={'key': api_key},
            json={'contents': [{'parts': [{'text': prompt}]}]},
        )
    duration_ms = int((time.monotonic() - started) * 1000)
    debug_request = {'url': url, 'model': model_id, 'prompt': prompt}
    if resp.status_code != 200:
        usage.record(usage_ctx, model=model, kind='text', status='error', duration_ms=duration_ms,
                     prompt=text, error=f'{resp.status_code}: {resp.text[:200]}',
                     debug={'request': debug_request, 'response': {'status': resp.status_code, 'text': resp.text[:500]}})
        raise RuntimeError(f'Gemini API вернул {resp.status_code}: {resp.text[:200]}')
    data = resp.json()
    result = data['candidates'][0]['content']['parts'][0]['text']
    um = data.get('usageMetadata') or {}
    units = {
        'input_tokens': um.get('promptTokenCount'),
        'output_tokens': um.get('candidatesTokenCount'),
        'total_tokens': um.get('totalTokenCount'),
        'cached_input_tokens': um.get('cachedContentTokenCount'),
        'reasoning_tokens': um.get('thoughtsTokenCount'),
    }
    usage.record(usage_ctx, model=model, kind='text', status='ok', duration_ms=duration_ms,
                 units=units, prompt=text, response=result, debug={'request': debug_request, 'response': data})
    return result


async def _complete_openrouter(
    model_id: str, api_key: str, text: str, usage_ctx: dict | None = None, *,
    prompt_template: str = _TITLE_PROMPT, timeout: int = _DEFAULT_TIMEOUT_SECONDS,
) -> str:
    model = f'openrouter:{model_id}'
    prompt = prompt_template.format(text=text)
    debug_request = {'url': _OPENROUTER_CHAT_URL, 'model': model_id, 'prompt': prompt}
    started = time.monotonic()
    console_log.log_request_start(model, 'text', usage_ctx.get('task') if usage_ctx else None)
    async with httpx.AsyncClient(timeout=timeout) as http_client:
        resp = await http_client.post(
            _OPENROUTER_CHAT_URL,
            headers={'Authorization': f'Bearer {api_key}'},
            json={
                'model': model_id,
                'messages': [{'role': 'user', 'content': prompt}],
                'usage': {'include': True},
            },
        )
    duration_ms = int((time.monotonic() - started) * 1000)
    if resp.status_code != 200:
        usage.record(usage_ctx, model=model, kind='text', status='error', duration_ms=duration_ms,
                     prompt=text, error=f'{resp.status_code}: {resp.text[:200]}',
                     debug={'request': debug_request, 'response': {'status': resp.status_code, 'text': resp.text[:500]}})
        raise RuntimeError(f'OpenRouter API вернул {resp.status_code}: {resp.text[:200]}')
    data = resp.json()
    result = data['choices'][0]['message']['content']
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
                 units=units, prompt=text, response=result, provider_cost=u.get('cost'),
                 debug={'request': debug_request, 'response': data})
    return result


async def _complete_deepseek(
    model_id: str, api_key: str, text: str, usage_ctx: dict | None = None, *,
    prompt_template: str = _TITLE_PROMPT, timeout: int = _DEFAULT_TIMEOUT_SECONDS,
) -> str:
    model = f'deepseek:{model_id}'
    prompt = prompt_template.format(text=text)
    debug_request = {'url': _DEEPSEEK_CHAT_URL, 'model': model_id, 'prompt': prompt}
    started = time.monotonic()
    console_log.log_request_start(model, 'text', usage_ctx.get('task') if usage_ctx else None)
    async with httpx.AsyncClient(timeout=timeout) as http_client:
        resp = await http_client.post(
            _DEEPSEEK_CHAT_URL,
            headers={'Authorization': f'Bearer {api_key}'},
            json={'model': model_id, 'messages': [{'role': 'user', 'content': prompt}]},
        )
    duration_ms = int((time.monotonic() - started) * 1000)
    if resp.status_code != 200:
        usage.record(usage_ctx, model=model, kind='text', status='error', duration_ms=duration_ms,
                     prompt=text, error=f'{resp.status_code}: {resp.text[:200]}',
                     debug={'request': debug_request, 'response': {'status': resp.status_code, 'text': resp.text[:500]}})
        raise RuntimeError(f'DeepSeek API вернул {resp.status_code}: {resp.text[:200]}')
    data = resp.json()
    result = data['choices'][0]['message']['content']
    u = data.get('usage') or {}
    units = {
        'input_tokens': u.get('prompt_tokens'),
        'output_tokens': u.get('completion_tokens'),
        'total_tokens': u.get('total_tokens'),
        'cached_input_tokens': u.get('prompt_cache_hit_tokens'),
    }
    usage.record(usage_ctx, model=model, kind='text', status='ok', duration_ms=duration_ms,
                 units=units, prompt=text, response=result, debug={'request': debug_request, 'response': data})
    return result
