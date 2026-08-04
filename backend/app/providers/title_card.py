"""Provider seam for the Title Card stage: unlike `images.py`'s scene-image
generators (pure text-to-image, one call per scene), this feature sends the
model *N reference images* (picked from already-generated scene images or
uploaded) plus a title/author text block and asks it to render that text in
the reference images' visual style - genuinely image-to-image, and its result
is project-level (`project.title_card.variants`), not scene-indexed. Kept as
its own module rather than folded into `images.py` for both reasons: the
provider call shape is different (multi-image input) and the persistence
target is different (no `scene_index`).

Only two providers currently confirmed (2026-08) to accept multiple
reference images the way this feature needs:
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

OpenRouter's Unified Image API also documents reference-image support
(`input_references`), but its exact request-body field shape couldn't be
confirmed from public docs in this session, so it's deliberately not wired
here - `_GENERATORS` is a dict precisely so a third provider is a one-line
addition once that's confirmed. Replicate/FAL have no reference-capable
models in the current curated catalog (`image_models.CURATED_IMAGE_MODELS`).

Job/persistence pattern mirrors `images.py`'s `_jobs`/`start_jobs`/`_run_job`/
`get_job` exactly, but as its own in-memory dict - a title-card job id and a
scene-image job id are unrelated and must never collide.
"""

import asyncio
import base64
import time
from datetime import datetime, timezone
from uuid import uuid4

import httpx

from .. import console_log, pricing, storage, usage

_GOOGLE_GENERATE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent'
_KREA_BASE = 'https://api.krea.ai'
_KREA_NANO_BANANA_PRO_ID = 'google/nano-banana-pro'

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

    async with httpx.AsyncClient(timeout=90) as http_client:
        resp = await http_client.post(
            _GOOGLE_GENERATE_URL.format(model=model_id),
            params={'key': api_key},
            json={'contents': [{'parts': parts}], 'generationConfig': generation_config},
        )
    if resp.status_code != 200:
        raise RuntimeError(f'Google Gemini API вернул {resp.status_code}: {resp.text[:300]}')
    data = resp.json()
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


_GENERATORS = {
    'google': _generate_google,
    'krea': _generate_krea,
}

_jobs: dict[str, dict] = {}


def _build_prompt(base_prompt: str, title_text: str, author_text: str) -> str:
    lines = [f'"{title_text}"'] if title_text else []
    if author_text:
        lines.append(f'"{author_text}"')
    return f'{base_prompt}\n' + '\n'.join(lines) if lines else base_prompt


async def _run_job(
    job_id: str, slug: str, reference_images: list[tuple[bytes, str]], reference_paths: list[str],
    title_text: str, author_text: str, base_prompt: str, provider: str, model_id: str, api_key: str,
    usage_ctx: dict | None = None, aspect_ratio: str | None = None,
) -> None:
    model = f'{provider}:{model_id}'
    prompt = _build_prompt(base_prompt, title_text, author_text)
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
                     duration_ms=int((time.monotonic() - started) * 1000), prompt=prompt, error=str(exc))
        _jobs[job_id] = {'status': 'failed', 'variant': None, 'error': str(exc)}
        return

    titlecard_dir = storage.project_dir(slug) / 'titlecard'
    titlecard_dir.mkdir(parents=True, exist_ok=True)
    variant_id = f'tc_{uuid4().hex[:8]}'
    filename = f'{variant_id.removeprefix("tc_")}.{ext}'
    (titlecard_dir / filename).write_bytes(content)

    provider_cost = provider_usage.pop('cost', None)
    units = {'images': 1, **provider_usage}
    if provider_cost is not None:
        cost = provider_cost
    else:
        cost, _ = pricing.compute_cost(model, units, (usage_ctx or {}).get('pricing_overrides'))
    variant = {
        'variant_id': variant_id, 'file_path': f'titlecard/{filename}',
        'rating': 0, 'is_selected': False, 'generated_at': _now(),
        'model': model, 'aspect_ratio': aspect_ratio, 'cost': cost,
        'title_text': title_text, 'author_text': author_text, 'base_prompt': base_prompt,
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
                 provider_cost=provider_cost)
    _jobs[job_id] = {'status': 'completed', 'variant': variant, 'error': None}


def start_jobs(
    slug: str, reference_paths: list[str], title_text: str, author_text: str, base_prompt: str,
    count: int, model: str, settings: dict, usage_ctx: dict | None = None, aspect_ratio: str | None = None,
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
                job_id, slug, reference_images, reference_paths, title_text, author_text, base_prompt,
                provider, model_id, api_key, usage_ctx, aspect_ratio,
            ),
        )
        job_ids.append(job_id)
    return job_ids


def get_job(job_id: str) -> dict | None:
    return _jobs.get(job_id)
