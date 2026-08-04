"""Provider seam for image-model catalog lookups, mirroring text_models.py's
shape (`{provider, source, models, error?}`) so the frontend's ModelFavorites
component works unmodified for both.

Google exposes image-capable models through the same "list models" endpoint
used for text: Imagen is distinguished by the `predict` generation method (a
live call), and the Gemini "Nano Banana" image family (`gemini-*-image`,
e.g. `gemini-3.1-flash-lite-image`) by `generateContent` *plus* an
`-image`-shaped id (see `is_gemini_image_model` - it has no `predict` in
`supportedGenerationMethods` to tell it apart from a text model, so id shape
is the only signal, shared with `text_models.py` which excludes the same
ids from its own catalog). OpenRouter has no dedicated image-models
endpoint either, but its general `/models` listing includes an
`architecture.output_modalities` field per model (see
`is_openrouter_image_model`), so filtering that live list client-side is
just as good as a real one - no curation needed, and new image models (like
future Nano Banana releases via OpenRouter) show up automatically. Replicate
and FAL don't have a filterable list-of-image-models endpoint worth calling
here (see text_models.py for why); Krea (krea.ai) has no discovery endpoint
either - each of its models is its own fixed REST path (`POST
/generate/image/{id}` against `https://api.krea.ai`, e.g.
`/generate/image/bfl/flux-1-dev`) rather than one endpoint with a model
parameter, confirmed against https://www.krea.ai/docs/api-reference/
(2026-07). DeepSeek doesn't route image models at all. So Replicate, FAL and
Krea fall back to a small curated constant (DeepSeek's list stays empty).
The user can still add any model id manually in the UI.

Krea is image/video-only (no text/LLM models), so it's deliberately absent
from text_models.py's provider set - see settings.py's
`_IMAGE_MODEL_PROVIDERS` vs `_MODEL_PROVIDERS`.
"""

import re

import httpx

_GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models'
_OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'

# Gemini's "Nano Banana" image-generation family (gemini-*-image, e.g.
# gemini-3.1-flash-lite-image) answers through the same :generateContent
# method as text models - there's no `predict` in supportedGenerationMethods
# to tell them apart, so id shape is the only signal. Shared with
# text_models.py, which needs to exclude the exact same ids from the text
# catalog.
_GEMINI_IMAGE_ID_RE = re.compile(r'-image(-preview[\w.]*)?$', re.IGNORECASE)


def is_gemini_image_model(model_id: str) -> bool:
    return bool(_GEMINI_IMAGE_ID_RE.search(model_id or ''))


def is_openrouter_image_model(m: dict) -> bool:
    """OpenRouter's `/models` listing has no dedicated image-models endpoint,
    but each entry's `architecture.output_modalities` says what it can
    return - `'image'` there means it's an image generator, our real
    signal instead of guessing from the id/name."""
    architecture = m.get('architecture') or {}
    return 'image' in (architecture.get('output_modalities') or [])

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
        if provider == 'openrouter':
            return await _list_openrouter(api_key)
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
        model_id = (m.get('name') or '').removeprefix('models/')
        if not model_id:
            continue
        methods = m.get('supportedGenerationMethods', [])
        is_imagen = 'predict' in methods
        is_nano_banana = 'generateContent' in methods and is_gemini_image_model(model_id)
        if not (is_imagen or is_nano_banana):
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
        for m in data.get('data', []) if m.get('id') and is_openrouter_image_model(m)
    ]
    return {'provider': 'openrouter', 'source': 'live', 'models': models}
