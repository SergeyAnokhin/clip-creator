"""Provider seam for scene video (image-to-video animation) generation.

`model` is the composite "{provider}:{model_id}" string from
`settings.video_models` (see `video_models.py` / `VideoStage.jsx`'s
`ModelPicker`). Real calls go to Google (Veo) or OpenRouter's Unified Video
API - the only two providers confirmed to do image-to-video for this app
(endpoints confirmed against each provider's own docs, 2026-08):

- Google Veo: `POST .../v1beta/models/{model_id}:predictLongRunning` with the
  source frame as `instances[0].image.inlineData{mimeType,data}` (base64) +
  `prompt`, and `parameters{aspectRatio, resolution, durationSeconds}`
  (ai.google.dev/gemini-api/docs/veo). Unlike Imagen's `:predict` (a single
  synchronous call, see `images.py`), this returns a long-running operation
  resource name (`{name: "models/.../operations/..."}`) that must be polled -
  `GET .../v1beta/{operation_name}` (same host, `key` query param) until
  `done: true`; the finished video's URI is at
  `response.generateVideoResponse.generatedSamples[0].video.uri`, itself a
  Google-hosted resource that needs the same `key` query param to download,
  not a plain public URL. Veo 3.1 only accepts `durationSeconds` of `"4"`,
  `"6"` or `"8"` (as strings) - `_nearest_google_duration` rounds the
  requested duration to the closest of those.
- OpenRouter: `POST https://openrouter.ai/api/v1/videos` (Unified Video API,
  confirmed against openrouter.ai/docs/guides/overview/multimodal/
  video-generation, 2026-08) with `frame_images: [{type: 'image_url',
  image_url: {url}, frame_type: 'first_frame'}]` (a data: URI works directly,
  no upload step) for image-to-video, plus `duration`/`resolution`/
  `aspect_ratio`. Returns `202 {id, polling_url, status}` immediately; poll
  `GET /api/v1/videos/{id}` until `status` is `completed`/`failed`, video at
  `unsigned_urls[0]` - despite the name this still 401s without the same
  `Authorization: Bearer` header used for submit/poll (confirmed 2026-08-10
  after a real generation's download failed with 401), so it's downloaded
  with those headers too. `usage.cost`
  in the poll response is OpenRouter's own exact price for the call - threaded
  through as `provider_cost`, same bypass `images.py`'s `_generate_openrouter`
  uses for images.

Video generation runs for minutes, not seconds - poll interval and timeout
are both longer than `images.py`'s. Every call happens inside a background
asyncio task tracked in `_jobs` (in-memory, lost on restart - same acceptable
trade-off as `images.py`). Routers start a job and get a `job_id` back
immediately; `get_job` backs the status-poll endpoint.
"""

import asyncio
import base64
import time
from datetime import datetime, timezone
from uuid import uuid4

import httpx

from .. import console_log, pricing, storage, usage

_GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta'
_OPENROUTER_VIDEOS_URL = 'https://openrouter.ai/api/v1/videos'

_POLL_INTERVAL = 6.0
_JOB_TIMEOUT = 600.0

_EXT_MIME = {'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'webp': 'image/webp'}

# Offered in the UI (VideoStage.jsx) - '' means "don't send it, use the
# provider/model's own default", same convention as images.py's aspect_ratio.
_ASPECT_RATIOS = ('1:1', '16:9', '9:16')
_RESOLUTIONS = ('720p', '1080p')
_GOOGLE_DURATIONS = (4, 6, 8)

_jobs: dict[str, dict] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def _mime_for(file_path: str) -> str:
    ext = file_path.rsplit('.', 1)[-1].lower() if '.' in file_path else 'png'
    return _EXT_MIME.get(ext, 'image/png')


def _nearest_google_duration(seconds: int) -> str:
    return str(min(_GOOGLE_DURATIONS, key=lambda o: abs(o - seconds)))


def build_prompt(motion_prompt: str, active_wishes: list[str] | None) -> str:
    """Same "ВАЖНЫЕ ТРЕБОВАНИЯ ПОЛЬЗОВАТЕЛЯ" block convention as
    `scenes.py`'s `_build_prompt` - the active video wishes, if any, are
    appended after the scene's own motion_prompt as an emphasized numbered
    list rather than silently folded in."""
    motion_prompt = (motion_prompt or '').strip()
    if not active_wishes:
        return motion_prompt
    items = '\n'.join(f'{i}. {w}' for i, w in enumerate(active_wishes, start=1))
    wishes_block = 'ВАЖНЫЕ ТРЕБОВАНИЯ ПОЛЬЗОВАТЕЛЯ — обязательно учесть:\n' + items
    return '\n\n'.join(part for part in [motion_prompt, wishes_block] if part)


async def _download_google(url: str, api_key: str) -> bytes:
    async with httpx.AsyncClient(timeout=120) as http_client:
        resp = await http_client.get(url, params={'key': api_key})
    if resp.status_code != 200:
        raise RuntimeError(f'Не удалось скачать видео от Google ({resp.status_code})')
    return resp.content


async def _download_plain(url: str, headers: dict | None = None) -> bytes:
    async with httpx.AsyncClient(timeout=120) as http_client:
        resp = await http_client.get(url, headers=headers)
    if resp.status_code != 200:
        raise RuntimeError(f'Не удалось скачать видео ({resp.status_code})')
    return resp.content


async def _generate_google_veo(
    model_id: str, prompt: str, api_key: str, image_bytes: bytes, mime_type: str,
    usage_out: dict | None = None, aspect_ratio: str | None = None,
    resolution: str | None = None, duration_seconds: int = 5,
) -> tuple[bytes, str]:
    if not api_key:
        raise RuntimeError('Нет API-ключа Google')
    google_duration = _nearest_google_duration(duration_seconds)
    parameters = {'durationSeconds': google_duration}
    if aspect_ratio:
        parameters['aspectRatio'] = aspect_ratio
    if resolution:
        parameters['resolution'] = resolution
    b64 = base64.b64encode(image_bytes).decode()
    body = {
        'instances': [{'prompt': prompt, 'image': {'inlineData': {'mimeType': mime_type, 'data': b64}}}],
        'parameters': parameters,
    }
    url = f'{_GOOGLE_BASE}/models/{model_id}:predictLongRunning'
    debug_request = {
        'url': url, 'model': model_id, 'prompt': prompt, 'parameters': parameters,
        'image': f'<image data, {len(image_bytes)} bytes>',
    }

    async with httpx.AsyncClient(timeout=60) as http_client:
        resp = await http_client.post(url, params={'key': api_key}, json=body)
    if resp.status_code != 200:
        if usage_out is not None:
            usage_out['debug'] = {'request': debug_request, 'response': {'status': resp.status_code, 'text': resp.text[:500]}}
        raise RuntimeError(f'Google Veo API вернул {resp.status_code}: {resp.text[:300]}')
    operation_name = resp.json().get('name')
    if not operation_name:
        raise RuntimeError('Google Veo: ответ не содержит имени операции')

    deadline = time.monotonic() + _JOB_TIMEOUT
    op_url = f'{_GOOGLE_BASE}/{operation_name}'
    data: dict = {}
    while True:
        await asyncio.sleep(_POLL_INTERVAL)
        async with httpx.AsyncClient(timeout=30) as http_client:
            poll = await http_client.get(op_url, params={'key': api_key})
        if poll.status_code != 200:
            if usage_out is not None:
                usage_out['debug'] = {'request': debug_request, 'response': {'status': poll.status_code, 'text': poll.text[:500]}}
            raise RuntimeError(f'Google Veo API (poll) вернул {poll.status_code}: {poll.text[:300]}')
        data = poll.json()
        if data.get('done'):
            break
        if time.monotonic() > deadline:
            raise RuntimeError('Google Veo: превышено время ожидания генерации')

    if usage_out is not None:
        usage_out['debug'] = {'request': debug_request, 'response': data}
    if data.get('error'):
        raise RuntimeError(f'Google Veo: {data["error"].get("message", data["error"])}')
    samples = ((data.get('response') or {}).get('generateVideoResponse') or {}).get('generatedSamples') or []
    video_uri = (samples[0].get('video') or {}).get('uri') if samples else None
    if not video_uri:
        raise RuntimeError(f'Google Veo: неожиданный ответ {data}')

    if usage_out is not None:
        usage_out['units'] = {'seconds': int(google_duration)}
    content = await _download_google(video_uri, api_key)
    return content, 'mp4'


async def _generate_openrouter_video(
    model_id: str, prompt: str, api_key: str, image_bytes: bytes, mime_type: str,
    usage_out: dict | None = None, aspect_ratio: str | None = None,
    resolution: str | None = None, duration_seconds: int = 5,
) -> tuple[bytes, str]:
    if not api_key:
        raise RuntimeError('Нет API-ключа OpenRouter')
    headers = {'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}
    data_uri = f'data:{mime_type};base64,{base64.b64encode(image_bytes).decode()}'
    body = {
        'model': model_id, 'prompt': prompt,
        'frame_images': [{'type': 'image_url', 'image_url': {'url': data_uri}, 'frame_type': 'first_frame'}],
        'duration': int(duration_seconds),
    }
    if resolution:
        body['resolution'] = resolution
    if aspect_ratio:
        body['aspect_ratio'] = aspect_ratio
    debug_request = {
        'url': _OPENROUTER_VIDEOS_URL, 'model': model_id,
        'body': {**body, 'frame_images': [{'type': 'image_url', 'image_url': f'<image data, {len(image_bytes)} bytes>', 'frame_type': 'first_frame'}]},
    }

    async with httpx.AsyncClient(timeout=60) as http_client:
        resp = await http_client.post(_OPENROUTER_VIDEOS_URL, headers=headers, json=body)
    if resp.status_code not in (200, 202):
        if usage_out is not None:
            usage_out['debug'] = {'request': debug_request, 'response': {'status': resp.status_code, 'text': resp.text[:500]}}
        raise RuntimeError(f'OpenRouter API вернул {resp.status_code}: {resp.text[:300]}')
    job_id = resp.json().get('id')
    if not job_id:
        raise RuntimeError('OpenRouter: ответ не содержит id задания')

    deadline = time.monotonic() + _JOB_TIMEOUT
    poll_url = f'{_OPENROUTER_VIDEOS_URL}/{job_id}'
    data: dict = {}
    while True:
        await asyncio.sleep(_POLL_INTERVAL)
        async with httpx.AsyncClient(timeout=30) as http_client:
            poll = await http_client.get(poll_url, headers=headers)
        if poll.status_code != 200:
            if usage_out is not None:
                usage_out['debug'] = {'request': debug_request, 'response': {'status': poll.status_code, 'text': poll.text[:500]}}
            raise RuntimeError(f'OpenRouter API (poll) вернул {poll.status_code}: {poll.text[:300]}')
        data = poll.json()
        status = data.get('status')
        if status in ('completed', 'failed'):
            break
        if time.monotonic() > deadline:
            raise RuntimeError('OpenRouter: превышено время ожидания генерации')

    if usage_out is not None:
        usage_out['debug'] = {'request': debug_request, 'response': data}
    if data.get('status') != 'completed':
        raise RuntimeError(f'OpenRouter: {data.get("error") or data.get("status")}')
    urls = data.get('unsigned_urls') or []
    if not urls:
        raise RuntimeError('OpenRouter: задание завершено, но URL видео не найден')

    if usage_out is not None:
        cost = (data.get('usage') or {}).get('cost')
        if cost is not None:
            usage_out['cost'] = cost
    content = await _download_plain(urls[0], headers=headers)
    return content, 'mp4'


_GENERATORS = {
    'google': _generate_google_veo,
    'google_free': _generate_google_veo,
    'openrouter': _generate_openrouter_video,
}


async def _run_job(
    job_id: str, slug: str, scene_index: int, image_path: str, source_image_id: str,
    prompt: str, provider: str, model_id: str, api_key: str, usage_ctx: dict | None,
    aspect_ratio: str | None, resolution: str | None, duration_seconds: int,
) -> None:
    model = f'{provider}:{model_id}'
    started = time.monotonic()
    generator = _GENERATORS.get(provider)
    provider_usage: dict = {}
    try:
        if generator is None:
            raise RuntimeError(f'Неизвестный провайдер видео: {provider or "(не выбран)"}')
        console_log.log_request_start(model, 'video', usage_ctx.get('task') if usage_ctx else None)
        image_bytes = (storage.project_dir(slug) / image_path).read_bytes()
        mime_type = _mime_for(image_path)
        content, ext = await generator(
            model_id, prompt, api_key, image_bytes, mime_type, usage_out=provider_usage,
            aspect_ratio=aspect_ratio, resolution=resolution, duration_seconds=duration_seconds,
        )
    except Exception as exc:
        usage.record(usage_ctx, model=model, kind='video', status='error',
                     duration_ms=int((time.monotonic() - started) * 1000), prompt=prompt, error=str(exc),
                     debug=provider_usage.get('debug'))
        _jobs[job_id] = {'status': 'failed', 'video': None, 'error': str(exc), 'debug': provider_usage.get('debug')}
        return

    generation_ms = int((time.monotonic() - started) * 1000)
    scene_number = scene_index + 1
    videos_dir = storage.project_dir(slug) / 'videos'
    videos_dir.mkdir(parents=True, exist_ok=True)
    video_id = f'vid_{uuid4().hex[:8]}'
    filename = f'scene_{scene_number}_{video_id.removeprefix("vid_")}.{ext}'
    (videos_dir / filename).write_bytes(content)

    provider_cost = provider_usage.pop('cost', None)
    debug_info = provider_usage.pop('debug', None)
    units = {'seconds': duration_seconds, **provider_usage.pop('units', {})}
    if provider_cost is not None:
        cost = provider_cost
    else:
        cost, _ = pricing.compute_cost(model, units, (usage_ctx or {}).get('pricing_overrides'))

    video = {
        'video_id': video_id, 'file_path': f'videos/{filename}',
        'rating': 0, 'is_selected': False, 'generated_at': _now(),
        'model': model, 'motion_prompt': prompt, 'aspect_ratio': aspect_ratio,
        'resolution': resolution, 'duration_seconds': duration_seconds,
        'generation_ms': generation_ms, 'cost': cost, 'source_image_id': source_image_id,
    }

    async with storage.project_lock(slug):
        project = storage.load_project(slug)
        if project is not None:
            scene_list = project.get('scenes', [])
            if 0 <= scene_index < len(scene_list):
                scene_list[scene_index]['videos'] = [*scene_list[scene_index].get('videos', []), video]
                project['updated_at'] = _now()
                storage.save_project(slug, project)

    usage.record(usage_ctx, model=model, kind='video', status='ok',
                 duration_ms=generation_ms, units=units, prompt=prompt, response=video['file_path'],
                 provider_cost=provider_cost, debug=debug_info)
    _jobs[job_id] = {'status': 'completed', 'video': video, 'error': None, 'debug': debug_info}


def start_jobs(
    slug: str, scene_index: int, prompt: str, image_path: str, source_image_id: str,
    count: int, model: str, settings: dict, usage_ctx: dict | None = None,
    aspect_ratio: str | None = None, resolution: str | None = None, duration_seconds: int = 5,
) -> list[str]:
    if count <= 0:
        return []
    provider, _, model_id = (model or '').partition(':')
    api_key = (settings.get('api_keys') or {}).get(provider, '')
    aspect_ratio = aspect_ratio if aspect_ratio in _ASPECT_RATIOS else None
    resolution = resolution if resolution in _RESOLUTIONS else None
    duration_seconds = max(1, min(int(duration_seconds or 5), 8))

    job_ids = []
    for _ in range(count):
        job_id = uuid4().hex
        _jobs[job_id] = {'status': 'pending', 'video': None, 'error': None}
        asyncio.create_task(
            _run_job(
                job_id, slug, scene_index, image_path, source_image_id, prompt, provider, model_id, api_key,
                usage_ctx, aspect_ratio, resolution, duration_seconds,
            ),
        )
        job_ids.append(job_id)
    return job_ids


def get_job(job_id: str) -> dict | None:
    return _jobs.get(job_id)


def save_uploaded_video(slug: str, scene_index: int, content: bytes, ext: str) -> dict:
    """Writes an already-validated video file into the same `videos/` dir and
    `scene.videos` dict shape `_run_job` produces for AI-generated videos -
    used by the scene-video-upload endpoint so a clip animated elsewhere (a
    different tool, a manual edit) and dropped in by hand is indistinguishable
    from a generated one to the rest of the UI (carousel, rating, delete,
    select-main). `model`/`motion_prompt`/`aspect_ratio`/`resolution`/
    `duration_seconds`/`generation_ms`/`source_image_id` are all `None`/`0`
    "not AI-generated" values, mirroring `images.save_uploaded_image`."""
    scene_number = scene_index + 1
    videos_dir = storage.project_dir(slug) / 'videos'
    videos_dir.mkdir(parents=True, exist_ok=True)
    video_id = f'vid_{uuid4().hex[:8]}'
    filename = f'scene_{scene_number}_{video_id.removeprefix("vid_")}.{ext}'
    (videos_dir / filename).write_bytes(content)
    return {
        'video_id': video_id, 'file_path': f'videos/{filename}',
        'rating': 0, 'is_selected': False, 'generated_at': _now(),
        'model': 'upload', 'motion_prompt': None, 'aspect_ratio': None,
        'resolution': None, 'duration_seconds': None, 'generation_ms': None,
        'cost': 0, 'source_image_id': None,
    }
