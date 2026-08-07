"""Provider seam for the Title Card stage: unlike `images.py`'s scene-image
generators (pure text-to-image, one call per scene), this feature sends the
model *N reference images* (picked from already-generated scene images or
uploaded) plus a title/author text block and asks it to render that text in
the reference images' visual style - genuinely image-to-image, and its result
is project-level (`project.title_card.variants`), not scene-indexed. Kept as
its own module rather than folded into `images.py` for both reasons: the
provider call shape is different (multi-image input) and the persistence
target is different (no `scene_index`).

Four providers confirmed (2026-08) to accept multiple reference images the
way this feature needs:
- **Google Gemini `generateContent`** ("Nano Banana" family, `gemini-*-image`
  ids - see `image_models.py`'s `is_gemini_image_model`): reference images go
  in as `inline_data` parts ahead of the text part in `contents[0].parts`;
  `generationConfig.responseModalities: ['IMAGE']` asks for an image back;
  `generationConfig.imageConfig.aspectRatio` frames it (confirmed against
  Firebase AI Logic's Gemini image-generation guide, 2026-08). This is the
  *same* Nano Banana model family `images.py`'s `_generate_google` currently
  can't reach (that function only speaks Imagen's `:predict`, text-only).
- **Krea's `google/nano-banana-pro` proxy**: `POST
  https://api.krea.ai/generate/image/google/nano-banana-pro` accepts
  `style_images: [{url, strength}]` where `url` may be a base64 data URI (no
  need to host references publicly), same job+poll shape as `images.py`'s
  other Krea calls (confirmed against krea.ai/docs/api-reference, 2026-08).
- **FAL's `fal-ai/nano-banana/edit`** (a fal-hosted proxy of the same Gemini
  image model, supports up to ~14 references per fal's own docs): `POST
  https://queue.fal.run/fal-ai/nano-banana/edit` with `{prompt, image_urls}`,
  where each entry in `image_urls` may be a `data:image/...;base64,...` URI
  (fal.ai model API reference, 2026-08) - same queue/poll shape as `images.py`'s
  `_generate_fal`. Only this specific fal model id supports references; the
  rest of the FAL catalog (`fal-ai/flux/dev` etc.) is text-to-image only.
- **OpenRouter's Unified Image API**: `POST https://openrouter.ai/api/v1/images`
  with `input_references: [{type: 'image_url', image_url: {url}}]`, where
  `url` may be a base64 data URL (confirmed against
  openrouter.ai/docs/guides/overview/multimodal/image-generation, 2026-08) -
  same single-call shape as `images.py`'s `_generate_openrouter`, just with
  the extra field. Whether a given OpenRouter-routed model actually honors
  references depends on the underlying model; unsupported ones should just
  ignore the field or error, same as any other OpenRouter parameter mismatch.

Replicate has no *multi*-reference model in the current curated catalog -
`black-forest-labs/flux-kontext-pro` supports exactly one `input_image`
(confirmed against replicate.com/blog/flux-kontext, 2026-08), which doesn't
fit this stage's "up to 4 references" shape, so it's deliberately left
unwired here rather than silently dropping 3 of 4 references.

Job/persistence pattern mirrors `images.py`'s `_jobs`/`start_jobs`/`_run_job`/
`get_job` exactly, but as its own in-memory dict - a title-card job id and a
scene-image job id are unrelated and must never collide.
"""

import asyncio
import base64
import io
import time
from copy import deepcopy
from datetime import datetime, timezone
from uuid import uuid4

import httpx
import numpy as np
from PIL import Image

from .. import console_log, pricing, storage, usage

_GOOGLE_GENERATE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent'
_KREA_BASE = 'https://api.krea.ai'
_KREA_NANO_BANANA_PRO_ID = 'google/nano-banana-pro'
_FAL_BASE = 'https://queue.fal.run'
_FAL_NANO_BANANA_EDIT_ID = 'fal-ai/nano-banana/edit'
_OPENROUTER_IMAGES_URL = 'https://openrouter.ai/api/v1/images'
_REPLICATE_BASE = 'https://api.replicate.com/v1'
_REPLICATE_BG_REMOVER_ID = '851-labs/background-remover'
_BG_REMOVE_MODEL = f'replicate:{_REPLICATE_BG_REMOVER_ID}'
# Three interchangeable background-removal methods (see the guide this was
# implemented from): 'local' is free pixel-threshold cutout for a flat
# black/white background (no network call, no model id); 'fal' and
# 'replicate' are AI models for complex backgrounds. `_BG_REMOVE_MODEL_LOCAL`
# is a synthetic composite id (no real provider) purely so it can flow
# through the same `model`/pricing/usage-ledger plumbing as the other two.
_BG_REMOVE_MODEL_LOCAL = 'local:pixel-threshold'
_FAL_BG_REMOVER_DEFAULT = 'fal-ai/bria/background/remove'

_POLL_INTERVAL = 2.0
_JOB_TIMEOUT = 300.0

_MIME_EXT = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp'}

# Same 3 framings offered elsewhere (images.py's _ASPECT_RATIOS) - the UI
# defaults this stage to 16:9 (horizontal poster), but any of the 3 is valid.
_ASPECT_RATIOS = ('1:1', '16:9', '9:16')


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def _ext_from_mime(mime_type: str) -> str:
    return _MIME_EXT.get((mime_type or '').split(';')[0].strip(), 'png')


async def _download(url: str) -> tuple[bytes, str]:
    async with httpx.AsyncClient(timeout=60) as http_client:
        resp = await http_client.get(url)
    if resp.status_code != 200:
        raise RuntimeError(f'Не удалось скачать изображение ({resp.status_code})')
    ext = _ext_from_mime(resp.headers.get('content-type', ''))
    return resp.content, ext


def _redact_inline_data(data: dict) -> dict:
    """Deep-copies `data` (a Gemini generateContent response) with every
    `inlineData.data` base64 payload replaced by a short placeholder - used
    for the debug panel, which shows the raw request/response JSON but must
    not dump megabytes of base64 image bytes into the UI."""
    redacted = deepcopy(data)
    candidates = redacted.get('candidates') or []
    for candidate in candidates:
        parts = (candidate.get('content') or {}).get('parts') or []
        for part in parts:
            inline = part.get('inlineData')
            if inline and inline.get('data'):
                inline['data'] = f'<image data omitted, {len(inline["data"])} base64 chars>'
    return redacted


async def _generate_google(
    model_id: str, prompt: str, reference_images: list[tuple[bytes, str]], api_key: str,
    usage_out: dict | None = None, aspect_ratio: str | None = None,
) -> tuple[bytes, str]:
    if not api_key:
        raise RuntimeError('Нет API-ключа Google')
    parts = [
        {'inline_data': {'mime_type': f'image/{ext if ext != "jpg" else "jpeg"}', 'data': base64.b64encode(content).decode()}}
        for content, ext in reference_images
    ]
    parts.append({'text': prompt})

    generation_config: dict = {'responseModalities': ['IMAGE']}
    if aspect_ratio:
        generation_config['imageConfig'] = {'aspectRatio': aspect_ratio}

    url = _GOOGLE_GENERATE_URL.format(model=model_id)
    debug_request = {
        'url': url, 'model': model_id, 'prompt': prompt,
        'reference_images': [f'<{ext} image, {len(content)} bytes>' for content, ext in reference_images],
        'generationConfig': generation_config,
    }

    async with httpx.AsyncClient(timeout=90) as http_client:
        resp = await http_client.post(
            url, params={'key': api_key},
            json={'contents': [{'parts': parts}], 'generationConfig': generation_config},
        )
    if resp.status_code != 200:
        if usage_out is not None:
            usage_out['debug'] = {'request': debug_request, 'response': {'status': resp.status_code, 'text': resp.text[:500]}}
        raise RuntimeError(f'Google Gemini API вернул {resp.status_code}: {resp.text[:300]}')
    data = resp.json()
    if usage_out is not None:
        usage_out['debug'] = {'request': debug_request, 'response': _redact_inline_data(data)}
    candidates = data.get('candidates') or []
    response_parts = (candidates[0].get('content') or {}).get('parts') if candidates else None
    inline = next((p.get('inlineData') for p in (response_parts or []) if p.get('inlineData')), None)
    if not inline or not inline.get('data'):
        raise RuntimeError(f'Google Gemini: в ответе нет изображения ({data})')
    return base64.b64decode(inline['data']), _ext_from_mime(inline.get('mimeType', 'image/png'))


async def _generate_krea(
    model_id: str, prompt: str, reference_images: list[tuple[bytes, str]], api_key: str,
    usage_out: dict | None = None, aspect_ratio: str | None = None,
) -> tuple[bytes, str]:
    if not api_key:
        raise RuntimeError('Нет API-ключа Krea')
    if model_id != _KREA_NANO_BANANA_PRO_ID:
        raise RuntimeError(f'Krea: модель {model_id} не поддерживает референсные изображения')
    headers = {'Authorization': f'Bearer {api_key}'}
    style_images = [
        {'url': f'data:image/{ext if ext != "jpg" else "jpeg"};base64,{base64.b64encode(content).decode()}', 'strength': 1}
        for content, ext in reference_images
    ]
    body: dict = {'prompt': prompt, 'style_images': style_images}
    if aspect_ratio:
        body['aspect_ratio'] = aspect_ratio
    debug_request = {
        'url': f'{_KREA_BASE}/generate/image/{model_id}', 'model': model_id, 'prompt': prompt,
        'style_images': [f'<{ext} image, {len(content)} bytes>' for content, ext in reference_images],
        'aspect_ratio': aspect_ratio,
    }

    async with httpx.AsyncClient(timeout=30) as http_client:
        resp = await http_client.post(f'{_KREA_BASE}/generate/image/{model_id}', headers=headers, json=body)
    if resp.status_code not in (200, 201, 202):
        if usage_out is not None:
            usage_out['debug'] = {'request': debug_request, 'response': {'status': resp.status_code, 'text': resp.text[:500]}}
        raise RuntimeError(f'Krea API вернул {resp.status_code}: {resp.text[:300]}')
    job_id = resp.json()['job_id']

    deadline = time.monotonic() + _JOB_TIMEOUT
    while True:
        await asyncio.sleep(_POLL_INTERVAL)
        async with httpx.AsyncClient(timeout=30) as http_client:
            poll = await http_client.get(f'{_KREA_BASE}/jobs/{job_id}', headers=headers)
        if poll.status_code != 200:
            if usage_out is not None:
                usage_out['debug'] = {'request': debug_request, 'response': {'status': poll.status_code, 'text': poll.text[:500]}}
            raise RuntimeError(f'Krea API (poll) вернул {poll.status_code}: {poll.text[:300]}')
        data = poll.json()
        status = data.get('status')
        if status == 'completed':
            urls = (data.get('result') or {}).get('urls') or []
            if usage_out is not None:
                usage_out['debug'] = {'request': debug_request, 'response': data}
            if not urls:
                raise RuntimeError('Krea: задание завершено, но URL изображения не найден')
            return await _download(urls[0])
        if status in ('failed', 'cancelled'):
            if usage_out is not None:
                usage_out['debug'] = {'request': debug_request, 'response': data}
            raise RuntimeError(f'Krea: задание завершилось со статусом {status}')
        if time.monotonic() > deadline:
            raise RuntimeError('Krea: превышено время ожидания генерации')


async def _generate_fal(
    model_id: str, prompt: str, reference_images: list[tuple[bytes, str]], api_key: str,
    usage_out: dict | None = None, aspect_ratio: str | None = None,
) -> tuple[bytes, str]:
    if not api_key:
        raise RuntimeError('Нет API-ключа FAL')
    if model_id != _FAL_NANO_BANANA_EDIT_ID:
        raise RuntimeError(f'FAL: модель {model_id} не поддерживает референсные изображения')
    headers = {'Authorization': f'Key {api_key}', 'Content-Type': 'application/json'}
    image_urls = [
        f'data:image/{ext if ext != "jpg" else "jpeg"};base64,{base64.b64encode(content).decode()}'
        for content, ext in reference_images
    ]
    body: dict = {'prompt': prompt, 'image_urls': image_urls}
    debug_request = {
        'url': f'{_FAL_BASE}/{model_id}', 'model': model_id, 'prompt': prompt,
        'image_urls': [f'<{ext} image, {len(content)} bytes>' for content, ext in reference_images],
    }

    async with httpx.AsyncClient(timeout=30) as http_client:
        resp = await http_client.post(f'{_FAL_BASE}/{model_id}', headers=headers, json=body)
    if resp.status_code >= 400:
        if usage_out is not None:
            usage_out['debug'] = {'request': debug_request, 'response': {'status': resp.status_code, 'text': resp.text[:500]}}
        raise RuntimeError(f'FAL API вернул {resp.status_code}: {resp.text[:300]}')
    submitted = resp.json()
    status_url = submitted['status_url']
    response_url = submitted['response_url']

    deadline = time.monotonic() + _JOB_TIMEOUT
    status = submitted.get('status')
    while status != 'COMPLETED':
        if status == 'FAILED':
            if usage_out is not None:
                usage_out['debug'] = {'request': debug_request, 'response': {'status': 'FAILED'}}
            raise RuntimeError('FAL: задание завершилось с ошибкой')
        if time.monotonic() > deadline:
            raise RuntimeError('FAL: превышено время ожидания генерации')
        await asyncio.sleep(_POLL_INTERVAL)
        async with httpx.AsyncClient(timeout=30) as http_client:
            poll = await http_client.get(status_url, headers=headers)
        if poll.status_code >= 400:
            if usage_out is not None:
                usage_out['debug'] = {'request': debug_request, 'response': {'status': poll.status_code, 'text': poll.text[:500]}}
            raise RuntimeError(f'FAL API (poll) вернул {poll.status_code}: {poll.text[:300]}')
        status = poll.json().get('status')

    async with httpx.AsyncClient(timeout=30) as http_client:
        result = await http_client.get(response_url, headers=headers)
    if result.status_code >= 400:
        raise RuntimeError(f'FAL API (результат) вернул {result.status_code}: {result.text[:300]}')
    payload = result.json()
    images = payload.get('images') or []
    if usage_out is not None:
        redacted_response = {**payload, 'images': [{'url': img.get('url')} for img in images]}
        usage_out['debug'] = {'request': debug_request, 'response': redacted_response}
    if not images:
        raise RuntimeError('FAL: результат не содержит изображений')
    if (payload.get('has_nsfw_concepts') or [False])[0]:
        raise RuntimeError(
            'FAL: изображение заблокировано модерацией (обнаружен NSFW-контент). Измените промпт и попробуйте снова.'
        )
    return await _download(images[0]['url'])


async def _generate_openrouter(
    model_id: str, prompt: str, reference_images: list[tuple[bytes, str]], api_key: str,
    usage_out: dict | None = None, aspect_ratio: str | None = None,
) -> tuple[bytes, str]:
    if not api_key:
        raise RuntimeError('Нет API-ключа OpenRouter')
    headers = {'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}
    input_references = [
        {
            'type': 'image_url',
            'image_url': {'url': f'data:image/{ext if ext != "jpg" else "jpeg"};base64,{base64.b64encode(content).decode()}'},
        }
        for content, ext in reference_images
    ]
    body: dict = {'model': model_id, 'prompt': prompt, 'n': 1, 'input_references': input_references}
    if aspect_ratio:
        body['aspect_ratio'] = aspect_ratio
    debug_request = {
        'url': _OPENROUTER_IMAGES_URL, 'model': model_id, 'prompt': prompt,
        'input_references': [f'<{ext} image, {len(content)} bytes>' for content, ext in reference_images],
        'aspect_ratio': aspect_ratio,
    }

    async with httpx.AsyncClient(timeout=90) as http_client:
        resp = await http_client.post(_OPENROUTER_IMAGES_URL, headers=headers, json=body)
    if resp.status_code != 200:
        if usage_out is not None:
            usage_out['debug'] = {'request': debug_request, 'response': {'status': resp.status_code, 'text': resp.text[:500]}}
        raise RuntimeError(f'OpenRouter API вернул {resp.status_code}: {resp.text[:300]}')
    data = resp.json()
    items = data.get('data') or []
    if usage_out is not None:
        redacted_response = {**data, 'data': [{'media_type': it.get('media_type')} for it in items]}
        usage_out['debug'] = {'request': debug_request, 'response': redacted_response}
    if not items:
        raise RuntimeError('OpenRouter: результат не содержит изображений')
    b64 = items[0].get('b64_json')
    if not b64:
        raise RuntimeError('OpenRouter: неожиданный формат ответа')
    if usage_out is not None:
        cost = (data.get('usage') or {}).get('cost')
        if cost is not None:
            usage_out['cost'] = cost
    ext = _MIME_EXT.get(items[0].get('media_type', 'image/png'), 'png')
    return base64.b64decode(b64), ext


_GENERATORS = {
    'google': _generate_google,
    # Same Gemini call as 'google', billed against a separate (free-tier) API key.
    'google_free': _generate_google,
    'krea': _generate_krea,
    'fal': _generate_fal,
    'openrouter': _generate_openrouter,
}

_jobs: dict[str, dict] = {}


_replicate_bg_remover_version: str | None = None


async def _resolve_bg_remover_version(api_key: str) -> str:
    """`851-labs/background-remover` is a community (non-"official") model -
    unlike the models `images.py`'s `_generate_replicate` calls, Replicate's
    shorthand `models/{owner}/{name}/predictions` route 404s for it (confirmed
    live, 2026-08: the shorthand route returned `{"detail": "The requested
    resource could not be found."}` while the versioned `/v1/predictions`
    route with an explicit `version` succeeded against the same input). So the
    latest version id must be resolved once and POSTed to `/v1/predictions`
    instead. Cached module-level for the process lifetime - the version
    changes rarely enough that a dev-server restart picking up a new one is
    fine, and this avoids an extra GET on every single button click."""
    global _replicate_bg_remover_version
    if _replicate_bg_remover_version:
        return _replicate_bg_remover_version
    headers = {'Authorization': f'Bearer {api_key}'}
    async with httpx.AsyncClient(timeout=30) as http_client:
        resp = await http_client.get(f'{_REPLICATE_BASE}/models/{_REPLICATE_BG_REMOVER_ID}', headers=headers)
    if resp.status_code != 200:
        raise RuntimeError(f'Replicate API (модель) вернул {resp.status_code}: {resp.text[:300]}')
    version = ((resp.json().get('latest_version') or {}).get('id'))
    if not version:
        raise RuntimeError('Replicate: не удалось определить версию модели background-remover')
    _replicate_bg_remover_version = version
    return version


def _generate_background_remover_local(image_bytes: bytes, params: dict | None = None) -> tuple[bytes, str]:
    """Method 1 (free, no network) from the background-removal guide this was
    implemented from: for a flat solid black/white background, a pixel is
    background - and gets alpha=0 - iff all 3 RGB channels are simultaneously
    below `threshold` (black) or above `255-threshold` (white); anything else
    (glow, particles, the text itself) is untouched. Only fits a flat
    background - complex/gradient ones need the FAL or Replicate AI methods.
    `params` is `settings.background_remover_local_params` (see
    routers/settings.py); defaults match the guide's own (`bg='black'`,
    `threshold=40`)."""
    defaults = {'bg': 'black', 'threshold': 40}
    opts = {**defaults, **(params or {})}
    bg = opts['bg'] if opts['bg'] in ('black', 'white') else 'black'
    threshold = max(0, min(255, int(opts['threshold'])))

    img = Image.open(io.BytesIO(image_bytes)).convert('RGBA')
    arr = np.asarray(img).astype(int)
    rgb = arr[:, :, :3]
    alpha = arr[:, :, 3].copy()
    if bg == 'black':
        is_bg = (rgb[:, :, 0] < threshold) & (rgb[:, :, 1] < threshold) & (rgb[:, :, 2] < threshold)
    else:
        is_bg = (rgb[:, :, 0] > 255 - threshold) & (rgb[:, :, 1] > 255 - threshold) & (rgb[:, :, 2] > 255 - threshold)
    alpha[is_bg] = 0
    arr[:, :, 3] = alpha

    out = io.BytesIO()
    Image.fromarray(arr.astype(np.uint8), 'RGBA').save(out, 'PNG')
    return out.getvalue(), 'png'


async def _generate_background_remover_fal(
    image_bytes: bytes, ext: str, api_key: str, usage_out: dict | None = None, params: dict | None = None,
) -> tuple[bytes, str]:
    """Method 2 from the background-removal guide: FAL's background-removal
    models (`fal-ai/bria/background/remove` - cleaner cut, commercial license
    - or `fal-ai/imageutils/rembg` - softer). Same queue/poll shape as this
    module's `_generate_fal` (reference-image call), but the input field is
    `image_url` (a base64 data URI works directly, same as `_generate_fal`'s
    `image_urls` - no separate upload step needed) and the result comes back
    as a single `image` object, not an `images` list. `params` is
    `settings.background_remover_fal_params` (see routers/settings.py)."""
    if not api_key:
        raise RuntimeError('Нет API-ключа FAL')
    model_id = (params or {}).get('model') or _FAL_BG_REMOVER_DEFAULT
    headers = {'Authorization': f'Key {api_key}', 'Content-Type': 'application/json'}
    data_uri = f'data:image/{ext if ext != "jpg" else "jpeg"};base64,{base64.b64encode(image_bytes).decode()}'
    body = {'image_url': data_uri}
    debug_request = {
        'url': f'{_FAL_BASE}/{model_id}', 'model': model_id,
        'body': {'image_url': f'<image data, {len(image_bytes)} bytes>'},
    }

    async with httpx.AsyncClient(timeout=30) as http_client:
        resp = await http_client.post(f'{_FAL_BASE}/{model_id}', headers=headers, json=body)
    if resp.status_code >= 400:
        if usage_out is not None:
            usage_out['debug'] = {'request': debug_request, 'response': {'status': resp.status_code, 'text': resp.text[:500]}}
        raise RuntimeError(f'FAL API вернул {resp.status_code}: {resp.text[:300]}')
    submitted = resp.json()
    status_url = submitted['status_url']
    response_url = submitted['response_url']

    deadline = time.monotonic() + _JOB_TIMEOUT
    status = submitted.get('status')
    while status != 'COMPLETED':
        if status == 'FAILED':
            if usage_out is not None:
                usage_out['debug'] = {'request': debug_request, 'response': {'status': 'FAILED'}}
            raise RuntimeError('FAL: задание завершилось с ошибкой')
        if time.monotonic() > deadline:
            raise RuntimeError('FAL: превышено время ожидания генерации')
        await asyncio.sleep(_POLL_INTERVAL)
        async with httpx.AsyncClient(timeout=30) as http_client:
            poll = await http_client.get(status_url, headers=headers)
        if poll.status_code >= 400:
            if usage_out is not None:
                usage_out['debug'] = {'request': debug_request, 'response': {'status': poll.status_code, 'text': poll.text[:500]}}
            raise RuntimeError(f'FAL API (poll) вернул {poll.status_code}: {poll.text[:300]}')
        status = poll.json().get('status')

    async with httpx.AsyncClient(timeout=30) as http_client:
        result = await http_client.get(response_url, headers=headers)
    if result.status_code >= 400:
        if usage_out is not None:
            usage_out['debug'] = {'request': debug_request, 'response': {'status': result.status_code, 'text': result.text[:500]}}
        raise RuntimeError(f'FAL API (результат) вернул {result.status_code}: {result.text[:300]}')
    payload = result.json()
    image = payload.get('image') or {}
    url = image.get('url')
    if usage_out is not None:
        redacted_response = {**payload, 'image': {**image, 'url': '<redacted>'}} if image else payload
        usage_out['debug'] = {'request': debug_request, 'response': redacted_response}
    if not url:
        raise RuntimeError('FAL: результат не содержит изображения')
    return await _download(url)


async def _generate_background_remover(
    image_bytes: bytes, ext: str, api_key: str, usage_out: dict | None = None, params: dict | None = None,
) -> tuple[bytes, str]:
    """Replicate's `851-labs/background-remover` (see the memory note this
    feature was planned from): a single `image` input (URL or base64 data
    URI) plus `background_type`/`format`/`threshold`/`reverse` (defaults
    below match the model's own schema defaults; `params` is
    `settings.background_remover_params`, see routers/settings.py). See
    `_resolve_bg_remover_version`'s docstring for why this goes through the
    versioned `/v1/predictions` endpoint rather than the shorthand one
    `images.py`'s official-model calls use."""
    if not api_key:
        raise RuntimeError('Нет API-ключа Replicate')
    version = await _resolve_bg_remover_version(api_key)
    headers = {'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}
    data_uri = f'data:image/{ext if ext != "jpg" else "jpeg"};base64,{base64.b64encode(image_bytes).decode()}'
    defaults = {'background_type': 'rgba', 'format': 'png', 'threshold': 0, 'reverse': False}
    input_body = {**defaults, **(params or {}), 'image': data_uri}
    debug_request = {
        'url': f'{_REPLICATE_BASE}/predictions', 'version': version,
        'input': {**input_body, 'image': f'<image data, {len(image_bytes)} bytes>'},
    }

    async with httpx.AsyncClient(timeout=30) as http_client:
        resp = await http_client.post(
            f'{_REPLICATE_BASE}/predictions',
            headers=headers, json={'version': version, 'input': input_body},
        )
    if resp.status_code not in (200, 201):
        if usage_out is not None:
            usage_out['debug'] = {'request': debug_request, 'response': {'status': resp.status_code, 'text': resp.text[:500]}}
        raise RuntimeError(f'Replicate API вернул {resp.status_code}: {resp.text[:300]}')
    data = resp.json()
    get_url = data['urls']['get']

    deadline = time.monotonic() + _JOB_TIMEOUT
    while data.get('status') not in ('succeeded', 'failed', 'canceled'):
        if time.monotonic() > deadline:
            raise RuntimeError('Replicate: превышено время ожидания генерации')
        await asyncio.sleep(_POLL_INTERVAL)
        async with httpx.AsyncClient(timeout=30) as http_client:
            poll = await http_client.get(get_url, headers=headers)
        if poll.status_code != 200:
            raise RuntimeError(f'Replicate API (poll) вернул {poll.status_code}: {poll.text[:300]}')
        data = poll.json()

    if usage_out is not None:
        usage_out['debug'] = {'request': debug_request, 'response': data}
    if data.get('status') != 'succeeded':
        raise RuntimeError(f'Replicate: {data.get("error") or data.get("status")}')
    output = data.get('output')
    url = output[0] if isinstance(output, list) else output
    if not url:
        raise RuntimeError('Replicate: задание завершено, но результат пуст')
    if usage_out is not None:
        usage_out['compute_seconds'] = (data.get('metrics') or {}).get('predict_time')
    return await _download(url)


def _build_prompt(base_prompt: str, text_block: str, active_wishes: list[str] | None = None) -> str:
    wishes_block = ''
    if active_wishes:
        items = '\n'.join(f'{i}. {w}' for i, w in enumerate(active_wishes, start=1))
        wishes_block = 'ВАЖНЫЕ ТРЕБОВАНИЯ ПОЛЬЗОВАТЕЛЯ — обязательно учесть:\n' + items
    instructions = '\n\n'.join(part for part in [base_prompt, wishes_block] if part.strip())
    text_block = (text_block or '').strip()
    return f'{instructions}\n{text_block}' if text_block else instructions


async def _run_job(
    job_id: str, slug: str, reference_images: list[tuple[bytes, str]], reference_paths: list[str],
    text_block: str, base_prompt: str, provider: str, model_id: str, api_key: str,
    usage_ctx: dict | None = None, aspect_ratio: str | None = None, active_wishes: list[str] | None = None,
) -> None:
    model = f'{provider}:{model_id}'
    prompt = _build_prompt(base_prompt, text_block, active_wishes)
    started = time.monotonic()
    generator = _GENERATORS.get(provider)
    provider_usage: dict = {}
    try:
        if generator is not None:
            console_log.log_request_start(model, 'image', usage_ctx.get('task') if usage_ctx else None)
        if generator is None:
            raise RuntimeError(f'Провайдер {provider or "(не выбран)"} не поддерживает референсные изображения')
        content, ext = await generator(
            model_id, prompt, reference_images, api_key, usage_out=provider_usage, aspect_ratio=aspect_ratio,
        )
    except Exception as exc:
        usage.record(usage_ctx, model=model, kind='image', status='error',
                     duration_ms=int((time.monotonic() - started) * 1000), prompt=prompt, error=str(exc),
                     debug=provider_usage.get('debug'))
        _jobs[job_id] = {'status': 'failed', 'variant': None, 'error': str(exc), 'debug': provider_usage.get('debug')}
        return

    titlecard_dir = storage.project_dir(slug) / 'titlecard'
    titlecard_dir.mkdir(parents=True, exist_ok=True)
    variant_id = f'tc_{uuid4().hex[:8]}'
    filename = f'{variant_id.removeprefix("tc_")}.{ext}'
    (titlecard_dir / filename).write_bytes(content)

    provider_cost = provider_usage.pop('cost', None)
    debug_info = provider_usage.pop('debug', None)
    units = {'images': 1, **provider_usage}
    if provider_cost is not None:
        cost = provider_cost
    else:
        cost, _ = pricing.compute_cost(model, units, (usage_ctx or {}).get('pricing_overrides'))
    variant = {
        'variant_id': variant_id, 'file_path': f'titlecard/{filename}',
        'rating': 0, 'is_selected': False, 'generated_at': _now(),
        'model': model, 'aspect_ratio': aspect_ratio, 'cost': cost,
        'text_block': text_block, 'base_prompt': base_prompt,
        'reference_image_paths': reference_paths,
    }

    async with storage.project_lock(slug):
        project = storage.load_project(slug)
        if project is not None:
            title_card = project.get('title_card') or {}
            title_card['variants'] = [*title_card.get('variants', []), variant]
            project['title_card'] = title_card
            project['updated_at'] = _now()
            storage.save_project(slug, project)

    usage.record(usage_ctx, model=model, kind='image', status='ok',
                 duration_ms=int((time.monotonic() - started) * 1000),
                 units=units, prompt=prompt, response=variant['file_path'],
                 provider_cost=provider_cost, debug=debug_info)
    _jobs[job_id] = {'status': 'completed', 'variant': variant, 'error': None, 'debug': debug_info}


def start_jobs(
    slug: str, reference_paths: list[str], text_block: str, base_prompt: str,
    count: int, model: str, settings: dict, usage_ctx: dict | None = None, aspect_ratio: str | None = None,
    active_wishes: list[str] | None = None,
) -> list[str]:
    if count <= 0:
        return []
    provider, _, model_id = (model or '').partition(':')
    api_key = (settings.get('api_keys') or {}).get(provider, '')
    aspect_ratio = aspect_ratio if aspect_ratio in _ASPECT_RATIOS else None

    reference_images = []
    for path in reference_paths:
        file_path = storage.project_dir(slug) / path
        ext = file_path.suffix.removeprefix('.').lower() or 'png'
        reference_images.append((file_path.read_bytes(), ext))

    job_ids = []
    for _ in range(count):
        job_id = uuid4().hex
        _jobs[job_id] = {'status': 'pending', 'variant': None, 'error': None}
        asyncio.create_task(
            _run_job(
                job_id, slug, reference_images, reference_paths, text_block, base_prompt,
                provider, model_id, api_key, usage_ctx, aspect_ratio, active_wishes,
            ),
        )
        job_ids.append(job_id)
    return job_ids


def get_job(job_id: str) -> dict | None:
    return _jobs.get(job_id)


async def remove_background(
    slug: str, variant_id: str, settings: dict, usage_ctx: dict | None = None, method: str | None = None,
) -> dict:
    """Runs one existing variant through one of the three methods from the
    background-removal guide this was implemented from - `method` is
    'local' / 'fal' / 'replicate' (falls back to
    `settings.background_remover_method`, then 'replicate' for back-compat
    with the single-method behaviour this replaced) - and appends the result
    as a **new** variant (`source_variant_id` pointing back at the original)
    - the source variant is left untouched, matching the "creates a copy"
    behaviour the user asked for. Synchronous (awaited directly by the route,
    no job/poll dance) since it's a single call, not a batch of `count` - the
    caller just shows a per-button spinner while this resolves. Raises
    `ValueError` if `variant_id` doesn't exist (mapped to a 404 by the
    route)."""
    project = storage.load_project(slug)
    if project is None:
        raise ValueError('Project not found')
    variants = (project.get('title_card') or {}).get('variants', [])
    source = next((v for v in variants if v.get('variant_id') == variant_id), None)
    if source is None:
        raise ValueError('Variant not found')

    file_path = storage.project_dir(slug) / source['file_path']
    ext = file_path.suffix.removeprefix('.').lower() or 'png'
    image_bytes = file_path.read_bytes()
    method = method if method in ('local', 'fal', 'replicate') else (settings.get('background_remover_method') or 'replicate')

    started = time.monotonic()
    provider_usage: dict = {}
    model = _BG_REMOVE_MODEL_LOCAL if method == 'local' else (_BG_REMOVE_MODEL if method == 'replicate' else None)
    try:
        if method == 'local':
            content, out_ext = _generate_background_remover_local(image_bytes, settings.get('background_remover_local_params'))
        elif method == 'fal':
            fal_params = settings.get('background_remover_fal_params') or {}
            model = f'fal:{(fal_params.get("model") or _FAL_BG_REMOVER_DEFAULT)}'
            api_key = (settings.get('api_keys') or {}).get('fal', '')
            console_log.log_request_start(model, 'image', usage_ctx.get('task') if usage_ctx else None)
            content, out_ext = await _generate_background_remover_fal(
                image_bytes, ext, api_key, usage_out=provider_usage, params=fal_params,
            )
        else:
            api_key = (settings.get('api_keys') or {}).get('replicate', '')
            console_log.log_request_start(model, 'image', usage_ctx.get('task') if usage_ctx else None)
            content, out_ext = await _generate_background_remover(
                image_bytes, ext, api_key, usage_out=provider_usage, params=settings.get('background_remover_params'),
            )
    except Exception as exc:
        usage.record(usage_ctx, model=model, kind='image', status='error',
                     duration_ms=int((time.monotonic() - started) * 1000), prompt=source['file_path'], error=str(exc),
                     debug=provider_usage.get('debug'))
        raise RuntimeError(str(exc)) from exc

    titlecard_dir = storage.project_dir(slug) / 'titlecard'
    titlecard_dir.mkdir(parents=True, exist_ok=True)
    new_variant_id = f'tc_{uuid4().hex[:8]}'
    filename = f'{new_variant_id.removeprefix("tc_")}.{out_ext}'
    (titlecard_dir / filename).write_bytes(content)

    units = {'images': 1, **{k: v for k, v in provider_usage.items() if k not in ('debug',)}}
    # Local is genuinely free (no API call at all) - priced as 0 directly
    # rather than through the catalog, which has no row for the synthetic
    # 'local:pixel-threshold' id and would otherwise show it as "unknown".
    cost = 0.0 if method == 'local' else pricing.compute_cost(model, units, (usage_ctx or {}).get('pricing_overrides'))[0]
    new_variant = {
        'variant_id': new_variant_id, 'file_path': f'titlecard/{filename}',
        'rating': 0, 'is_selected': False, 'generated_at': _now(),
        'model': model, 'aspect_ratio': source.get('aspect_ratio'), 'cost': cost,
        'text_block': source.get('text_block'), 'base_prompt': source.get('base_prompt'),
        'reference_image_paths': source.get('reference_image_paths', []),
        'source_variant_id': variant_id,
    }

    async with storage.project_lock(slug):
        project = storage.load_project(slug)
        title_card = project.get('title_card') or {}
        current_variants = [*title_card.get('variants', []), new_variant]
        title_card['variants'] = current_variants
        project['title_card'] = title_card
        project['updated_at'] = _now()
        storage.save_project(slug, project)

    debug_info = provider_usage.get('debug')
    usage.record(usage_ctx, model=model, kind='image', status='ok',
                 duration_ms=int((time.monotonic() - started) * 1000),
                 units=units, prompt=source['file_path'], response=new_variant['file_path'], debug=debug_info)
    return {'variant': new_variant, 'variants': current_variants, 'debug': debug_info}
