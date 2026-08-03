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
  `images[].url` (docs.fal.ai, 2026-07).
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
import time
from datetime import datetime, timezone
from uuid import uuid4

import httpx

from .. import console_log, storage, usage

_KREA_BASE = 'https://api.krea.ai'
_REPLICATE_BASE = 'https://api.replicate.com/v1'
_FAL_BASE = 'https://queue.fal.run'
_GOOGLE_PREDICT_URL = 'https://generativelanguage.googleapis.com/v1beta/models/{model}:predict'
_OPENROUTER_IMAGES_URL = 'https://openrouter.ai/api/v1/images'

_POLL_INTERVAL = 2.0
_JOB_TIMEOUT = 300.0

_MIME_EXT = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp'}

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


async def _generate_krea(model_id: str, prompt: str, api_key: str, usage_out: dict | None = None) -> tuple[bytes, str]:
    if not api_key:
        raise RuntimeError('Нет API-ключа Krea')
    headers = {'Authorization': f'Bearer {api_key}'}

    async with httpx.AsyncClient(timeout=30) as http_client:
        resp = await http_client.post(
            f'{_KREA_BASE}/generate/image/{model_id}', headers=headers, json={'prompt': prompt},
        )
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


async def _generate_replicate(model_id: str, prompt: str, api_key: str, usage_out: dict | None = None) -> tuple[bytes, str]:
    if not api_key:
        raise RuntimeError('Нет API-ключа Replicate')
    headers = {'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}

    async with httpx.AsyncClient(timeout=30) as http_client:
        resp = await http_client.post(
            f'{_REPLICATE_BASE}/models/{model_id}/predictions', headers=headers, json={'input': {'prompt': prompt}},
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


async def _generate_fal(model_id: str, prompt: str, api_key: str, usage_out: dict | None = None) -> tuple[bytes, str]:
    if not api_key:
        raise RuntimeError('Нет API-ключа FAL')
    headers = {'Authorization': f'Key {api_key}', 'Content-Type': 'application/json'}

    async with httpx.AsyncClient(timeout=30) as http_client:
        resp = await http_client.post(f'{_FAL_BASE}/{model_id}', headers=headers, json={'prompt': prompt})
    if resp.status_code not in (200, 201):
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
        if poll.status_code != 200:
            raise RuntimeError(f'FAL API (poll) вернул {poll.status_code}: {poll.text[:300]}')
        status = poll.json().get('status')

    async with httpx.AsyncClient(timeout=30) as http_client:
        result = await http_client.get(response_url, headers=headers)
    if result.status_code != 200:
        raise RuntimeError(f'FAL API (результат) вернул {result.status_code}: {result.text[:300]}')
    payload = result.json()
    images = payload.get('images') or []
    if not images:
        raise RuntimeError('FAL: результат не содержит изображений')
    if usage_out is not None:
        usage_out['compute_seconds'] = (payload.get('timings') or {}).get('inference')
    return await _download(images[0]['url'])


async def _generate_google(model_id: str, prompt: str, api_key: str, usage_out: dict | None = None) -> tuple[bytes, str]:
    if not api_key:
        raise RuntimeError('Нет API-ключа Google')

    async with httpx.AsyncClient(timeout=60) as http_client:
        resp = await http_client.post(
            _GOOGLE_PREDICT_URL.format(model=model_id),
            params={'key': api_key},
            json={'instances': [{'prompt': prompt}], 'parameters': {'sampleCount': 1}},
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


async def _generate_openrouter(model_id: str, prompt: str, api_key: str, usage_out: dict | None = None) -> tuple[bytes, str]:
    if not api_key:
        raise RuntimeError('Нет API-ключа OpenRouter')
    headers = {'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}

    async with httpx.AsyncClient(timeout=90) as http_client:
        resp = await http_client.post(
            _OPENROUTER_IMAGES_URL, headers=headers, json={'model': model_id, 'prompt': prompt, 'n': 1},
        )
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
    'openrouter': _generate_openrouter,
}


async def _run_job(
    job_id: str, slug: str, scene_index: int, prompt: str, provider: str, model_id: str, api_key: str,
    usage_ctx: dict | None = None,
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
        content, ext = await generator(model_id, prompt, api_key, usage_out=provider_usage)
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
    image = {
        'image_id': image_id, 'file_path': f'images/{filename}',
        'rating': 0, 'is_selected': False, 'generated_at': _now(),
    }

    project = storage.load_project(slug)
    if project is not None:
        scene_list = project.get('scenes', [])
        if 0 <= scene_index < len(scene_list):
            scene_list[scene_index]['images'] = [*scene_list[scene_index].get('images', []), image]
            project['updated_at'] = _now()
            storage.save_project(slug, project)

    provider_cost = provider_usage.pop('cost', None)
    usage.record(usage_ctx, model=model, kind='image', status='ok',
                 duration_ms=int((time.monotonic() - started) * 1000),
                 units={'images': 1, **provider_usage}, prompt=prompt, response=image['file_path'],
                 provider_cost=provider_cost)
    _jobs[job_id] = {'status': 'completed', 'image': image, 'error': None}


def start_jobs(
    slug: str, scene_index: int, prompt: str, count: int, model: str, settings: dict,
    usage_ctx: dict | None = None,
) -> list[str]:
    if count <= 0:
        return []
    provider, _, model_id = (model or '').partition(':')
    api_key = (settings.get('api_keys') or {}).get(provider, '')

    job_ids = []
    for _ in range(count):
        job_id = uuid4().hex
        _jobs[job_id] = {'status': 'pending', 'image': None, 'error': None}
        asyncio.create_task(_run_job(job_id, slug, scene_index, prompt, provider, model_id, api_key, usage_ctx))
        job_ids.append(job_id)
    return job_ids


def get_job(job_id: str) -> dict | None:
    return _jobs.get(job_id)
