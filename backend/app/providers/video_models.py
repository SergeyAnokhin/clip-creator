"""Provider seam for video-model catalog lookups, mirroring image_models.py's
shape (`{provider, source, models, error?}`) so the frontend's ModelFavorites
component works unmodified for video too.

Only two providers do image-to-video generation for this app (see
`providers/video.py`'s module docstring for the confirmed endpoints):

- Google exposes Veo through the same "list models" endpoint used for text/
  image - Veo models answer through `predictLongRunning` (a long-running
  operation, unlike Imagen's synchronous `predict` or Nano Banana's
  `generateContent`), so that's the real signal (`is_veo_model` below, id
  shape is a fallback in case a future Veo id doesn't literally start with
  "veo-"), confirmed against ai.google.dev/gemini-api/docs/veo (2026-08).
- OpenRouter has a dedicated video-model discovery endpoint (unlike its image
  API, which piggybacks on the general `/models` listing) -
  `GET /api/v1/videos/models`, confirmed against
  openrouter.ai/docs/guides/overview/multimodal/video-generation (2026-08).

No curated fallback for either - if the live call fails (missing key, network
error), the route surfaces `source: 'error'` the same way image_models.py
does, and the user can still add a model id by hand in the UI.
"""

import re

import httpx

_GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models'
_OPENROUTER_VIDEO_MODELS_URL = 'https://openrouter.ai/api/v1/videos/models'

_VEO_ID_RE = re.compile(r'^veo-', re.IGNORECASE)


def is_veo_model(model_id: str) -> bool:
    return bool(_VEO_ID_RE.match(model_id or ''))


async def list_models(provider: str, api_key: str) -> dict:
    try:
        if provider in ('google', 'google_free'):
            return await _list_google(provider, api_key)
        if provider == 'openrouter':
            return await _list_openrouter(api_key)
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
        model_id = (m.get('name') or '').removeprefix('models/')
        if not model_id:
            continue
        methods = m.get('supportedGenerationMethods', [])
        if 'predictLongRunning' not in methods and not is_veo_model(model_id):
            continue
        models.append({'id': model_id, 'name': m.get('displayName') or model_id})
    return {'provider': provider, 'source': 'live', 'models': models}


async def _list_openrouter(api_key: str) -> dict:
    headers = {'Authorization': f'Bearer {api_key}'} if api_key else {}
    async with httpx.AsyncClient(timeout=20) as http_client:
        resp = await http_client.get(_OPENROUTER_VIDEO_MODELS_URL, headers=headers)
    if resp.status_code != 200:
        return {'provider': 'openrouter', 'source': 'error', 'models': [], 'error': f'{resp.status_code}: {resp.text[:200]}'}
    data = resp.json()
    models = [
        {'id': m.get('id', ''), 'name': m.get('id', '')}
        for m in data.get('data', []) if m.get('id')
    ]
    return {'provider': 'openrouter', 'source': 'live', 'models': models}
