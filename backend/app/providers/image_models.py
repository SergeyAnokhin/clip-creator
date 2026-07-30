"""Provider seam for image-model catalog lookups, mirroring text_models.py's
shape (`{provider, source, models, error?}`) so the frontend's ModelFavorites
component works unmodified for both.

Google exposes image-capable models (Imagen) through the same "list models"
endpoint used for text, distinguished by the `predict` generation method -
so that one is a live call. Replicate and FAL don't have a filterable
list-of-image-models endpoint worth calling here (see text_models.py for
why); Krea (krea.ai) has no discovery endpoint either - each of its models
is its own fixed REST path (`POST /generate/image/{id}` against
`https://api.krea.ai`, e.g. `/generate/image/bfl/flux-1-dev`) rather than
one endpoint with a model parameter, confirmed against
https://www.krea.ai/docs/api-reference/ (2026-07). So those three, plus
OpenRouter and DeepSeek (neither of which route image models), fall back to
a small curated constant. The user can still add any model id manually in
the UI.

Krea is image/video-only (no text/LLM models), so it's deliberately absent
from text_models.py's provider set - see settings.py's
`_IMAGE_MODEL_PROVIDERS` vs `_MODEL_PROVIDERS`.
"""

import httpx

_GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

CURATED_IMAGE_MODELS = {
    'replicate': [
        {'id': 'black-forest-labs/flux-schnell', 'name': 'FLUX.1 [schnell]'},
        {'id': 'black-forest-labs/flux-dev', 'name': 'FLUX.1 [dev]'},
        {'id': 'stability-ai/stable-diffusion-3.5-large', 'name': 'Stable Diffusion 3.5 Large'},
        {'id': 'stability-ai/sdxl', 'name': 'SDXL'},
    ],
    'fal': [
        {'id': 'fal-ai/flux/dev', 'name': 'FLUX.1 [dev]'},
        {'id': 'fal-ai/flux-pro/v1.1', 'name': 'FLUX1.1 [pro]'},
        {'id': 'fal-ai/fast-sdxl', 'name': 'Fast SDXL'},
        {'id': 'fal-ai/aura-flow', 'name': 'AuraFlow'},
    ],
    'openrouter': [],
    'deepseek': [],
    'krea': [
        {'id': 'krea/krea-2/medium', 'name': 'Krea 2 (Medium)'},
        {'id': 'krea/krea-2/large', 'name': 'Krea 2 (Large)'},
        {'id': 'bfl/flux-1-dev', 'name': 'FLUX.1 [dev] (via Krea)'},
        {'id': 'google/imagen-4', 'name': 'Imagen 4 (via Krea)'},
        {'id': 'google/nano-banana-pro', 'name': 'Nano Banana Pro (via Krea)'},
        {'id': 'ideogram/ideogram-3', 'name': 'Ideogram 3.0 (via Krea)'},
        {'id': 'openai/gpt-image-2', 'name': 'ChatGPT Image (via Krea)'},
    ],
}


async def list_models(provider: str, api_key: str) -> dict:
    try:
        if provider == 'google':
            return await _list_google(api_key)
        if provider in CURATED_IMAGE_MODELS:
            return {'provider': provider, 'source': 'curated', 'models': CURATED_IMAGE_MODELS[provider]}
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
        if 'predict' not in m.get('supportedGenerationMethods', []):
            continue
        model_id = (m.get('name') or '').removeprefix('models/')
        if not model_id:
            continue
        models.append({'id': model_id, 'name': m.get('displayName') or model_id})
    return {'provider': 'google', 'source': 'live', 'models': models}
