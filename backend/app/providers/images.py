"""Provider seam for scene image generation.

`model` is the composite "{provider}:{model_id}" string from
`settings.image_models` (see `image_models.py` / `ScenesStage.jsx`'s
`ModelPicker`). Real calls go to Krea, Replicate and FAL (async job + polling)
or Google Imagen (single synchronous `:predict` call) - see
`docs/architecture.md` for the endpoints, confirmed against each provider's
docs in this session:
- Krea: POST https://api.krea.ai/generate/image/{model_id} -> {job_id, status},
  then GET https://api.krea.ai/jobs/{job_id} until status == 'completed',
  image URL at result.urls[0] (docs.krea.ai, 2026-07).
- Replicate: POST https://api.replicate.com/v1/models/{owner}/{name}/predictions
  (works because CURATED_IMAGE_MODELS ids are already bare "owner/name", no
  version hash needed for official models) -> {id, status, urls: {get}},
  poll `urls.get` until status == 'succeeded', image URL(s) in `output`
  (replicate.com/docs, 2026-07).
- FAL: POST https://queue.fal.run/{model_id} -> {status_url, response_url},
  poll `status_url` until status == 'COMPLETED', then GET `response_url` for
  `images[].url` (docs.fal.ai, 2026-07). FAL's own moderation doesn't fail
  the request on flagged content - a NSFW-detected generation still comes
  back with a 200 and a (blank/blurred) `images[0].url`, only distinguishable
  via the sibling `has_nsfw_concepts: [bool, ...]` array, so that's checked
  explicitly instead of trusting `images` being non-empty (fal.ai model API
  reference, 2026-08). Also, the `status_url` poll itself can reply `202
  Accepted` (not 200) while the job is still IN_QUEUE/IN_PROGRESS - confirmed
  from a real log line (`FAL API (poll) вернул 202: {"status":"IN_PROGRESS"...`)
  - so only HTTP >=400 is treated as a transport error there; the JSON
  `status` field is what actually drives the poll loop (2026-08).
- Google Imagen: POST .../v1beta/models/{model_id}:predict (same host as
  suno.py's Gemini call) -> {predictions: [{bytesBase64Encoded, mimeType}]},
  no job/polling - it's a single synchronous call (ai.google.dev, 2026-07).
- OpenRouter: POST https://openrouter.ai/api/v1/images (OpenRouter's Unified
  Image API, launched 2026-06) -> {data: [{b64_json, media_type}], usage:
  {..., cost}}, no job/polling - a single synchronous call like Google Imagen,
  confirmed against openrouter.ai/docs/guides/overview/multimodal/image-generation
  (2026-08). `usage.cost` is OpenRouter's own exact USD price for the call
  (all-or-nothing billing - a failed generation is never charged), so it's
  threaded through as `usage_out['cost']` and wins over the price catalog the
  same way `text_models.py`'s `_complete_openrouter` already does for text.

Every provider call happens inside a background asyncio task tracked in
`_jobs` (in-memory - lost on server restart, acceptable for this single-user
local tool). Routers start a job and get a `job_id` back immediately instead
of blocking the request for the whole generation; `get_job` backs the status
endpoint. A completed job has already been written to disk and persisted onto
the project by the time its status is polled as 'completed'.
"""

import asyncio
import base64
import ipaddress
import socket
import time
from datetime import datetime, timezone
from urllib.parse import urlparse
from uuid import uuid4

import httpx

from .. import console_log, pricing, storage, usage

# Cap for user-pasted/dropped image URLs (scene-image upload endpoint) - not
# applied to `_download` above, which only ever fetches URLs a trusted
# provider API just handed back.
_MAX_UPLOAD_BYTES = 15 * 1024 * 1024

_KREA_BASE = 'https://api.krea.ai'
_REPLICATE_BASE = 'https://api.replicate.com/v1'
_FAL_BASE = 'https://queue.fal.run'
_GOOGLE_PREDICT_URL = 'https://generativelanguage.googleapis.com/v1beta/models/{model}:predict'
_OPENROUTER_IMAGES_URL = 'https://openrouter.ai/api/v1/images'

_POLL_INTERVAL = 2.0
_JOB_TIMEOUT = 300.0

_MIME_EXT = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp'}

# Aspect ratios offered in the UI (ImagesStage.jsx's picker) - the 3 common
# framings plus "no preference" (aspect_ratio=None below, meaning: don't send
# the param at all, let the provider/model use its own default). Verified
# each provider accepts this exact "W:H" string for these 3 ratios in its own
# docs (2026-08): Krea (krea.ai/docs/api-reference), Replicate (flux-schnell/
# flux-dev/stable-diffusion-3.5-large's `aspect_ratio` input), Google Imagen
# (`aspectRatio` predict parameter), OpenRouter (Unified Image API's
# `aspect_ratio` field). FAL doesn't take this string directly - see
# `_FAL_IMAGE_SIZE` below.
_ASPECT_RATIOS = ('1:1', '16:9', '9:16')

# FAL's models (flux/*, fast-sdxl, aura-flow) take an `image_size` enum
# instead of an aspect-ratio string (fal.ai model API reference, 2026-08).
_FAL_IMAGE_SIZE = {'1:1': 'square_hd', '16:9': 'landscape_16_9', '9:16': 'portrait_16_9'}

# stability-ai/sdxl on Replicate has no `aspect_ratio` input (unlike the FLUX/
# SD3.5 models on the same platform) - only numeric width/height, best run at
# one of its documented "optimal" resolutions (replicate.com/blog/run-sdxl-
# with-an-api, 2026-08) to avoid unintended cropping.
_REPLICATE_SDXL_SIZE = {'1:1': (1024, 1024), '16:9': (1344, 768), '9:16': (768, 1344)}

_jobs: dict[str, dict] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def _ext_from_response(url: str, content_type: str) -> str:
    tail = url.split('?', 1)[0].rsplit('.', 1)[-1].lower()
    if tail in ('png', 'jpg', 'jpeg', 'webp'):
        return tail
    return _MIME_EXT.get(content_type.split(';')[0].strip(), 'png')


async def _download(url: str) -> tuple[bytes, str]:
    async with httpx.AsyncClient(timeout=60) as http_client:
        resp = await http_client.get(url)
    if resp.status_code != 200:
        raise RuntimeError(f'Не удалось скачать изображение ({resp.status_code})')
    return resp.content, _ext_from_response(url, resp.headers.get('content-type', ''))


def _is_public_host(host: str) -> bool:
    """Resolves `host` and rejects it if any address it resolves to is
    private/loopback/link-local/reserved - the SSRF guard for
    `download_user_image_url` below, whose URL comes directly from user
    input (a pasted or dropped link) rather than a trusted provider API."""
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            return False
    return True


async def download_user_image_url(url: str) -> tuple[bytes, str]:
    """Fetches a user-supplied image URL for the scene-image upload endpoint
    (generation.py's `upload_scene_image`). Unlike `_download` above, `url`
    here is arbitrary user input (pasted or dropped by the user), so this is
    hardened accordingly: only http(s) with a hostname, the host is resolved
    up front and rejected if it points at a private/loopback/link-local
    address (`_is_public_host`), redirects are not followed (a redirect
    could otherwise retarget a validated public URL at an internal one), the
    response must declare an `image/*` content-type, and the body is capped
    at `_MAX_UPLOAD_BYTES` while streaming (rejects before buffering an
    oversized response in memory)."""
    parsed = urlparse(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        raise RuntimeError('Некорректная ссылка на изображение')
    if not _is_public_host(parsed.hostname):
        raise RuntimeError('Ссылка указывает на недопустимый адрес')

    async with httpx.AsyncClient(timeout=20, follow_redirects=False) as http_client:
        async with http_client.stream('GET', url) as resp:
            if resp.status_code != 200:
                raise RuntimeError(f'Не удалось скачать изображение ({resp.status_code})')
            content_type = resp.headers.get('content-type', '').split(';')[0].strip()
            if not content_type.startswith('image/'):
                raise RuntimeError('Ссылка не указывает на изображение')
            content = bytearray()
            async for chunk in resp.aiter_bytes():
                content.extend(chunk)
                if len(content) > _MAX_UPLOAD_BYTES:
                    raise RuntimeError('Изображение слишком большое (лимит 15 МБ)')
    return bytes(content), _ext_from_response(url, content_type)


def save_uploaded_image(slug: str, scene_index: int, content: bytes, ext: str) -> dict:
    """Writes an already-fetched/validated image into the same `images/` dir
    and `scene.images` dict shape `_run_job` produces for AI-generated
    images (see this module's docstring) - used by the scene-image-upload
    endpoint for both the local-file and pasted-URL paths, so uploaded
    images are indistinguishable from generated ones to the rest of the UI
    (carousel, rating, delete, lightbox). `model`/`aspect_ratio`/`cost` are
    set to the "not AI-generated" values (`'upload'`/`None`/`0`)."""
    scene_number = scene_index + 1
    images_dir = storage.project_dir(slug) / 'images'
    images_dir.mkdir(parents=True, exist_ok=True)
    image_id = f'img_{uuid4().hex[:8]}'
    filename = f'scene_{scene_number}_{image_id.removeprefix("img_")}.{ext}'
    (images_dir / filename).write_bytes(content)
    return {
        'image_id': image_id, 'file_path': f'images/{filename}',
        'rating': 0, 'is_selected': False, 'generated_at': _now(),
        'model': 'upload', 'aspect_ratio': None, 'cost': 0,
    }


async def _generate_krea(
    model_id: str, prompt: str, api_key: str, usage_out: dict | None = None, aspect_ratio: str | None = None,
) -> tuple[bytes, str]:
    if not api_key:
        raise RuntimeError('Нет API-ключа Krea')
    headers = {'Authorization': f'Bearer {api_key}'}
    body = {'prompt': prompt}
    if aspect_ratio:
        body['aspect_ratio'] = aspect_ratio

    async with httpx.AsyncClient(timeout=30) as http_client:
        resp = await http_client.post(f'{_KREA_BASE}/generate/image/{model_id}', headers=headers, json=body)
    if resp.status_code not in (200, 201, 202):
        raise RuntimeError(f'Krea API вернул {resp.status_code}: {resp.text[:300]}')
    job_id = resp.json()['job_id']

    deadline = time.monotonic() + _JOB_TIMEOUT
    while True:
        await asyncio.sleep(_POLL_INTERVAL)
        async with httpx.AsyncClient(timeout=30) as http_client:
            poll = await http_client.get(f'{_KREA_BASE}/jobs/{job_id}', headers=headers)
        if poll.status_code != 200:
            raise RuntimeError(f'Krea API (poll) вернул {poll.status_code}: {poll.text[:300]}')
        data = poll.json()
        status = data.get('status')
        if status == 'completed':
            urls = (data.get('result') or {}).get('urls') or []
            if not urls:
                raise RuntimeError('Krea: задание завершено, но URL изображения не найден')
            return await _download(urls[0])
        if status in ('failed', 'cancelled'):
            raise RuntimeError(f'Krea: задание завершилось со статусом {status}')
        if time.monotonic() > deadline:
            raise RuntimeError('Krea: превышено время ожидания генерации')


async def _generate_replicate(
    model_id: str, prompt: str, api_key: str, usage_out: dict | None = None, aspect_ratio: str | None = None,
) -> tuple[bytes, str]:
    if not api_key:
        raise RuntimeError('Нет API-ключа Replicate')
    headers = {'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}
    input_body = {'prompt': prompt}
    if aspect_ratio:
        if model_id == 'stability-ai/sdxl':
            width, height = _REPLICATE_SDXL_SIZE[aspect_ratio]
            input_body['width'], input_body['height'] = width, height
        else:
            input_body['aspect_ratio'] = aspect_ratio

    async with httpx.AsyncClient(timeout=30) as http_client:
        resp = await http_client.post(
            f'{_REPLICATE_BASE}/models/{model_id}/predictions', headers=headers, json={'input': input_body},
        )
    if resp.status_code not in (200, 201):
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

    if data.get('status') != 'succeeded':
        raise RuntimeError(f'Replicate: {data.get("error") or data.get("status")}')
    output = data.get('output')
    url = output[0] if isinstance(output, list) else output
    if not url:
        raise RuntimeError('Replicate: задание завершено, но результат пуст')
    if usage_out is not None:
        usage_out['compute_seconds'] = (data.get('metrics') or {}).get('predict_time')
    return await _download(url)


async def _generate_fal(
    model_id: str, prompt: str, api_key: str, usage_out: dict | None = None, aspect_ratio: str | None = None,
) -> tuple[bytes, str]:
    if not api_key:
        raise RuntimeError('Нет API-ключа FAL')
    headers = {'Authorization': f'Key {api_key}', 'Content-Type': 'application/json'}
    body = {'prompt': prompt}
    if aspect_ratio:
        body['image_size'] = _FAL_IMAGE_SIZE[aspect_ratio]

    async with httpx.AsyncClient(timeout=30) as http_client:
        resp = await http_client.post(f'{_FAL_BASE}/{model_id}', headers=headers, json=body)
    if resp.status_code >= 400:
        raise RuntimeError(f'FAL API вернул {resp.status_code}: {resp.text[:300]}')
    submitted = resp.json()
    status_url = submitted['status_url']
    response_url = submitted['response_url']

    deadline = time.monotonic() + _JOB_TIMEOUT
    status = submitted.get('status')
    while status != 'COMPLETED':
        if status == 'FAILED':
            raise RuntimeError('FAL: задание завершилось с ошибкой')
        if time.monotonic() > deadline:
            raise RuntimeError('FAL: превышено время ожидания генерации')
        await asyncio.sleep(_POLL_INTERVAL)
        async with httpx.AsyncClient(timeout=30) as http_client:
            poll = await http_client.get(status_url, headers=headers)
        # FAL's status endpoint replies 202 Accepted (not 200) while a job is
        # still IN_QUEUE/IN_PROGRESS - only >=400 is a real HTTP-level error,
        # the job's own status field (checked below) is what decides whether
        # to keep polling.
        if poll.status_code >= 400:
            raise RuntimeError(f'FAL API (poll) вернул {poll.status_code}: {poll.text[:300]}')
        status = poll.json().get('status')

    async with httpx.AsyncClient(timeout=30) as http_client:
        result = await http_client.get(response_url, headers=headers)
    if result.status_code >= 400:
        raise RuntimeError(f'FAL API (результат) вернул {result.status_code}: {result.text[:300]}')
    payload = result.json()
    images = payload.get('images') or []
    if not images:
        raise RuntimeError('FAL: результат не содержит изображений')
    if (payload.get('has_nsfw_concepts') or [False])[0]:
        raise RuntimeError(
            'FAL: изображение заблокировано модерацией (обнаружен NSFW-контент). Измените промпт и попробуйте снова.'
        )
    if usage_out is not None:
        usage_out['compute_seconds'] = (payload.get('timings') or {}).get('inference')
    return await _download(images[0]['url'])


async def _generate_google(
    model_id: str, prompt: str, api_key: str, usage_out: dict | None = None, aspect_ratio: str | None = None,
) -> tuple[bytes, str]:
    if not api_key:
        raise RuntimeError('Нет API-ключа Google')
    parameters = {'sampleCount': 1}
    if aspect_ratio:
        parameters['aspectRatio'] = aspect_ratio

    async with httpx.AsyncClient(timeout=60) as http_client:
        resp = await http_client.post(
            _GOOGLE_PREDICT_URL.format(model=model_id),
            params={'key': api_key},
            json={'instances': [{'prompt': prompt}], 'parameters': parameters},
        )
    if resp.status_code != 200:
        raise RuntimeError(f'Google Imagen API вернул {resp.status_code}: {resp.text[:300]}')
    data = resp.json()
    predictions = data.get('predictions') or []
    b64 = predictions[0].get('bytesBase64Encoded') if predictions else None
    if not b64:
        raise RuntimeError(f'Google Imagen: неожиданный ответ {data}')
    ext = _MIME_EXT.get(predictions[0].get('mimeType', 'image/png'), 'png')
    return base64.b64decode(b64), ext


async def _generate_openrouter(
    model_id: str, prompt: str, api_key: str, usage_out: dict | None = None, aspect_ratio: str | None = None,
) -> tuple[bytes, str]:
    if not api_key:
        raise RuntimeError('Нет API-ключа OpenRouter')
    headers = {'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}
    body = {'model': model_id, 'prompt': prompt, 'n': 1}
    if aspect_ratio:
        body['aspect_ratio'] = aspect_ratio

    async with httpx.AsyncClient(timeout=90) as http_client:
        resp = await http_client.post(_OPENROUTER_IMAGES_URL, headers=headers, json=body)
    if resp.status_code != 200:
        raise RuntimeError(f'OpenRouter API вернул {resp.status_code}: {resp.text[:300]}')
    data = resp.json()
    items = data.get('data') or []
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
    'krea': _generate_krea,
    'replicate': _generate_replicate,
    'fal': _generate_fal,
    'google': _generate_google,
    # Same Gemini/Imagen call as 'google' - a separate provider id only so
    # its own API key (a free-tier Gemini token) is billed/tracked apart
    # from the paid 'google' key. See pricing.py's provider alias for cost
    # lookups.
    'google_free': _generate_google,
    'openrouter': _generate_openrouter,
}


async def _run_job(
    job_id: str, slug: str, scene_index: int, prompt: str, provider: str, model_id: str, api_key: str,
    usage_ctx: dict | None = None, aspect_ratio: str | None = None,
) -> None:
    model = f'{provider}:{model_id}'
    started = time.monotonic()
    generator = _GENERATORS.get(provider)
    provider_usage: dict = {}
    try:
        if generator is not None:
            console_log.log_request_start(model, 'image', usage_ctx.get('task') if usage_ctx else None)
        if generator is None:
            raise RuntimeError(f'Неизвестный провайдер изображений: {provider or "(не выбран)"}')
        content, ext = await generator(model_id, prompt, api_key, usage_out=provider_usage, aspect_ratio=aspect_ratio)
    except Exception as exc:
        usage.record(usage_ctx, model=model, kind='image', status='error',
                     duration_ms=int((time.monotonic() - started) * 1000), prompt=prompt, error=str(exc))
        _jobs[job_id] = {'status': 'failed', 'image': None, 'error': str(exc)}
        return

    scene_number = scene_index + 1
    images_dir = storage.project_dir(slug) / 'images'
    images_dir.mkdir(parents=True, exist_ok=True)
    image_id = f'img_{uuid4().hex[:8]}'
    filename = f'scene_{scene_number}_{image_id.removeprefix("img_")}.{ext}'
    (images_dir / filename).write_bytes(content)

    provider_cost = provider_usage.pop('cost', None)
    units = {'images': 1, **provider_usage}
    if provider_cost is not None:
        cost = provider_cost
    else:
        cost, _ = pricing.compute_cost(model, units, (usage_ctx or {}).get('pricing_overrides'))
    image = {
        'image_id': image_id, 'file_path': f'images/{filename}',
        'rating': 0, 'is_selected': False, 'generated_at': _now(),
        'model': model, 'aspect_ratio': aspect_ratio, 'cost': cost,
    }

    async with storage.project_lock(slug):
        project = storage.load_project(slug)
        if project is not None:
            scene_list = project.get('scenes', [])
            if 0 <= scene_index < len(scene_list):
                scene_list[scene_index]['images'] = [*scene_list[scene_index].get('images', []), image]
                project['updated_at'] = _now()
                storage.save_project(slug, project)

    usage.record(usage_ctx, model=model, kind='image', status='ok',
                 duration_ms=int((time.monotonic() - started) * 1000),
                 units=units, prompt=prompt, response=image['file_path'],
                 provider_cost=provider_cost)
    _jobs[job_id] = {'status': 'completed', 'image': image, 'error': None}


def start_jobs(
    slug: str, scene_index: int, prompt: str, count: int, model: str, settings: dict,
    usage_ctx: dict | None = None, aspect_ratio: str | None = None,
) -> list[str]:
    if count <= 0:
        return []
    provider, _, model_id = (model or '').partition(':')
    api_key = (settings.get('api_keys') or {}).get(provider, '')
    aspect_ratio = aspect_ratio if aspect_ratio in _ASPECT_RATIOS else None

    job_ids = []
    for _ in range(count):
        job_id = uuid4().hex
        _jobs[job_id] = {'status': 'pending', 'image': None, 'error': None}
        asyncio.create_task(
            _run_job(job_id, slug, scene_index, prompt, provider, model_id, api_key, usage_ctx, aspect_ratio),
        )
        job_ids.append(job_id)
    return job_ids


def get_job(job_id: str) -> dict | None:
    return _jobs.get(job_id)
