"""Provider seam for generic text-model catalog lookups and short completions
(distinct from suno.py, which owns the Suno style/lyrics prompt shape).

Google and OpenRouter expose a real "list models" API, so refreshing the
catalog for those two is a live call. Replicate and FAL don't have a
filterable list-of-chat-models endpoint worth calling here (Replicate's
catalog spans every modality; FAL has no equivalent public listing), so
those two fall back to a small curated constant - the user can still add any
model id manually in the UI.
"""

import httpx

_GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models'
_GEMINI_GENERATE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent'
_OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
_OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'

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


async def list_models(provider: str, api_key: str) -> dict:
    try:
        if provider == 'google':
            return await _list_google(api_key)
        if provider == 'openrouter':
            return await _list_openrouter(api_key)
        if provider in CURATED_MODELS:
            return {'provider': provider, 'source': 'curated', 'models': CURATED_MODELS[provider]}
        return {'provider': provider, 'source': 'error', 'models': [], 'error': f'Unknown provider: {provider}'}
    except Exception as exc:
        return {'provider': provider, 'source': 'error', 'models': [], 'error': str(exc)}


async def _list_google(api_key: str) -> dict:
    if not api_key:
        return {'provider': 'google', 'source': 'error', 'models': [], 'error': 'Нет API-ключа Google'}
    async with httpx.AsyncClient(timeout=20) as http_client:
        resp = await http_client.get(_GEMINI_MODELS_URL, params={'key': api_key})
    if resp.status_code != 200:
        return {'provider': 'google', 'source': 'error', 'models': [], 'error': f'{resp.status_code}: {resp.text[:200]}'}
    data = resp.json()
    models = []
    for m in data.get('models', []):
        if 'generateContent' not in m.get('supportedGenerationMethods', []):
            continue
        model_id = (m.get('name') or '').removeprefix('models/')
        if not model_id:
            continue
        models.append({'id': model_id, 'name': m.get('displayName') or model_id})
    return {'provider': 'google', 'source': 'live', 'models': models}


async def _list_openrouter(api_key: str) -> dict:
    headers = {'Authorization': f'Bearer {api_key}'} if api_key else {}
    async with httpx.AsyncClient(timeout=20) as http_client:
        resp = await http_client.get(_OPENROUTER_MODELS_URL, headers=headers)
    if resp.status_code != 200:
        return {'provider': 'openrouter', 'source': 'error', 'models': [], 'error': f'{resp.status_code}: {resp.text[:200]}'}
    data = resp.json()
    models = [
        {'id': m.get('id', ''), 'name': m.get('name') or m.get('id', '')}
        for m in data.get('data', []) if m.get('id')
    ]
    return {'provider': 'openrouter', 'source': 'live', 'models': models}


def truncate_title(text: str) -> str:
    words = text.strip().split()
    short = ' '.join(words[:6])
    if len(short) > 40:
        short = short[:40].rstrip()
    if len(words) > 6 or len(text.strip()) > len(short):
        short += '…'
    return short or text.strip()


async def generate_wish_title(text: str, settings: dict) -> str:
    text = (text or '').strip()
    if not text:
        return text

    default = ((settings.get('simple_models') or {}).get('default') or '').strip()
    provider, _, model_id = default.partition(':')
    api_key = (settings.get('api_keys') or {}).get(provider, '')

    try:
        if provider == 'google' and model_id and api_key:
            title = await _complete_google(model_id, api_key, text)
        elif provider == 'openrouter' and model_id and api_key:
            title = await _complete_openrouter(model_id, api_key, text)
        else:
            return truncate_title(text)
        return title.strip().strip('"').strip() or truncate_title(text)
    except Exception:
        return truncate_title(text)


async def _complete_google(model_id: str, api_key: str, text: str) -> str:
    url = _GEMINI_GENERATE_URL.format(model=model_id)
    async with httpx.AsyncClient(timeout=20) as http_client:
        resp = await http_client.post(
            url,
            params={'key': api_key},
            json={'contents': [{'parts': [{'text': _TITLE_PROMPT.format(text=text)}]}]},
        )
    if resp.status_code != 200:
        raise RuntimeError(f'Gemini API вернул {resp.status_code}: {resp.text[:200]}')
    data = resp.json()
    return data['candidates'][0]['content']['parts'][0]['text']


async def _complete_openrouter(model_id: str, api_key: str, text: str) -> str:
    async with httpx.AsyncClient(timeout=20) as http_client:
        resp = await http_client.post(
            _OPENROUTER_CHAT_URL,
            headers={'Authorization': f'Bearer {api_key}'},
            json={'model': model_id, 'messages': [{'role': 'user', 'content': _TITLE_PROMPT.format(text=text)}]},
        )
    if resp.status_code != 200:
        raise RuntimeError(f'OpenRouter API вернул {resp.status_code}: {resp.text[:200]}')
    data = resp.json()
    return data['choices'][0]['message']['content']
