"""Provider seam for "magic layers" - the inverse of the poster constructor.

The Poster constructor only ever *composes*: background + title-card variant +
logo + text are flattened into one PNG. This module does the opposite - it
takes one flat image and decomposes it back into N independent RGBA layers
(background, person, caption, logo...), each of which the constructor can then
move on its own **without leaving a hole**: every layer already carries fully
painted content behind whatever used to cover it.

Model: **Qwen-Image-Layered** (arxiv 2512.15603, Apache 2.0) - an end-to-end
diffusion model that decomposes an RGB image into a variable number (1-10) of
semantically disentangled, full-canvas RGBA layers, inpainting the occluded
pixels as it goes. Two hosted seams, picked per click like background removal:
- **FAL** `fal-ai/qwen-image-layered`: `{image_url (data URI ok), num_layers,
  num_inference_steps, guidance_scale, acceleration, output_format}` through
  the usual queue/poll shape; result is an `images[]` **list**, one entry per
  layer (fal.ai model API reference, 2026-08). $0.05 per decomposition, flat
  regardless of layer count.
- **Replicate** `qwen/qwen-image-layered`: an *official* model, so the
  shorthand `models/{owner}/{name}/predictions` route works (unlike
  `title_card.py`'s community `851-labs/background-remover`); `output` is a
  list of layer URLs. ~$0.03 per decomposition.

Two things the model does **not** guarantee, both compensated for here:

1. **Ordering.** fal's docs state layer order is "semantically determined by
   the model" and not guaranteed background-first. `_postprocess` therefore
   detects the background itself (the layer with the largest opaque area) and
   flags it, rather than trusting index 0.
2. **Resolution.** The model runs in ~640/1024px buckets, so the layers come
   back smaller than the source. `_postprocess` upscales every layer to the
   source's exact size, and for the *foreground* layers re-takes the RGB from
   the full-resolution original through the upscaled alpha - so objects stay
   pixel-sharp and only the cut edge is model-resolution. The background plate
   is the one layer that genuinely has to come from the model (it contains
   invented pixels), and it is only ever visible where an object moved away.

Job/persistence pattern mirrors `title_card.py`: an in-memory `_jobs` dict, a
background asyncio task, and a group that is already written to disk and
persisted onto the project by the time the job flips to 'completed'. One
decomposition is one *group* (`project.magic_layer_groups[]`) with its layer
PNGs under `magic/{group_id}/`, reusable by every poster in the project.
"""

import asyncio
import base64
import io
import time
from datetime import datetime, timezone
from uuid import uuid4

import httpx
import numpy as np
from PIL import Image

from .. import console_log, pricing, storage, usage
from . import fal_client

_FAL_BASE = 'https://queue.fal.run'
_FAL_LAYERED_ID = 'fal-ai/qwen-image-layered'
_REPLICATE_BASE = 'https://api.replicate.com/v1'
_REPLICATE_LAYERED_ID = 'qwen/qwen-image-layered'

_POLL_INTERVAL = 2.0
_JOB_TIMEOUT = 300.0

# The model's own documented range for `num_layers`.
_MIN_LAYERS = 2
_MAX_LAYERS = 10

# A layer whose opaque area is below this fraction of the canvas carries
# nothing useful (the model pads unused layer slots with near-empty output) -
# dropped so the constructor doesn't get invisible, undraggable layers.
_MIN_OPAQUE_FRACTION = 0.0005

_jobs: dict[str, dict] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


async def _download(url: str) -> bytes:
    async with httpx.AsyncClient(timeout=60) as http_client:
        resp = await http_client.get(url)
    if resp.status_code != 200:
        raise RuntimeError(f'Не удалось скачать слой ({resp.status_code})')
    return resp.content


def clamp_layers(num_layers) -> int:
    try:
        value = int(num_layers)
    except (TypeError, ValueError):
        return 4
    return max(_MIN_LAYERS, min(_MAX_LAYERS, value))


async def _generate_fal(
    image_bytes: bytes, ext: str, api_key: str, num_layers: int,
    usage_out: dict | None = None, params: dict | None = None,
) -> list[bytes]:
    """FAL's `fal-ai/qwen-image-layered`. Same queue/poll skeleton as every
    other FAL call here (`fal_client.submit_poll_fetch`), same base64 data-URI
    input trick as `title_card.py`'s reference images - no upload step. The
    result differs from the other image seams in that **all** of `images[]`
    matters, not just `[0]`: each entry is one layer."""
    if not api_key:
        raise RuntimeError('Нет API-ключа FAL')
    model_id = (params or {}).get('model') or _FAL_LAYERED_ID
    data_uri = f'data:image/{ext if ext != "jpg" else "jpeg"};base64,{base64.b64encode(image_bytes).decode()}'
    body = {
        'image_url': data_uri,
        'num_layers': num_layers,
        'output_format': 'png',
    }
    for key in ('num_inference_steps', 'guidance_scale', 'acceleration'):
        value = (params or {}).get(key)
        if value is not None:
            body[key] = value
    debug_request = {
        'url': f'{_FAL_BASE}/{model_id}', 'model': model_id,
        'body': {**body, 'image_url': f'<image data, {len(image_bytes)} bytes>'},
    }

    payload = await fal_client.submit_poll_fetch(
        _FAL_BASE, model_id, body, api_key, debug_request,
        usage_out=usage_out, poll_interval=_POLL_INTERVAL, job_timeout=_JOB_TIMEOUT,
    )
    images = payload.get('images') or []
    urls = [img.get('url') for img in images if img.get('url')]
    if usage_out is not None:
        redacted = {**payload, 'images': [{**img, 'url': '<redacted>'} for img in images]}
        usage_out['debug'] = {'request': debug_request, 'response': redacted}
    if not urls:
        raise RuntimeError('FAL: результат не содержит слоёв')
    return [await _download(url) for url in urls]


async def _generate_replicate(
    image_bytes: bytes, ext: str, api_key: str, num_layers: int,
    usage_out: dict | None = None, params: dict | None = None,
) -> list[bytes]:
    """Replicate's `qwen/qwen-image-layered`. An official model, so this uses
    the shorthand `models/{owner}/{name}/predictions` route `images.py` uses -
    no version resolution needed (that dance in `title_card.py` exists only
    because its background remover is a community model). `output` is a list
    of layer URLs."""
    if not api_key:
        raise RuntimeError('Нет API-ключа Replicate')
    model_id = (params or {}).get('model') or _REPLICATE_LAYERED_ID
    headers = {'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}
    data_uri = f'data:image/{ext if ext != "jpg" else "jpeg"};base64,{base64.b64encode(image_bytes).decode()}'
    input_body = {
        **{k: v for k, v in (params or {}).items() if k != 'model'},
        'image': data_uri, 'num_layers': num_layers, 'output_format': 'png',
    }
    create_url = f'{_REPLICATE_BASE}/models/{model_id}/predictions'
    debug_request = {
        'url': create_url, 'model': model_id,
        'input': {**input_body, 'image': f'<image data, {len(image_bytes)} bytes>'},
    }

    async with httpx.AsyncClient(timeout=30) as http_client:
        resp = await http_client.post(create_url, headers=headers, json={'input': input_body})
    if resp.status_code not in (200, 201):
        if usage_out is not None:
            usage_out['debug'] = {'request': debug_request,
                                  'response': {'status': resp.status_code, 'text': resp.text[:500]}}
        raise RuntimeError(f'Replicate API вернул {resp.status_code}: {resp.text[:300]}')
    data = resp.json()
    get_url = data['urls']['get']

    deadline = time.monotonic() + _JOB_TIMEOUT
    while data.get('status') not in ('succeeded', 'failed', 'canceled'):
        if time.monotonic() > deadline:
            raise RuntimeError('Replicate: превышено время ожидания разбора на слои')
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
    urls = output if isinstance(output, list) else ([output] if output else [])
    if not urls:
        raise RuntimeError('Replicate: задание завершено, но слоёв нет')
    if usage_out is not None:
        usage_out['compute_seconds'] = (data.get('metrics') or {}).get('predict_time')
    return [await _download(url) for url in urls]


def _alpha_bbox(alpha: np.ndarray) -> dict | None:
    """Tight box around the layer's opaque pixels, in canvas coordinates -
    stored per layer so the UI can label/preview a layer without decoding the
    PNG. `None` when the layer is fully transparent."""
    rows = np.where(alpha.any(axis=1))[0]
    cols = np.where(alpha.any(axis=0))[0]
    if rows.size == 0 or cols.size == 0:
        return None
    return {
        'x': int(cols[0]), 'y': int(rows[0]),
        'width': int(cols[-1] - cols[0] + 1), 'height': int(rows[-1] - rows[0] + 1),
    }


def _postprocess(source_bytes: bytes, layer_pngs: list[bytes]) -> list[dict]:
    """Model output -> the layer records this feature stores, as a pure
    function (no I/O, no network) so it can be tested on its own.

    Per layer: upscale to the source's exact pixel size (the model works in
    ~640/1024 buckets), drop the ones that came back effectively empty, and
    measure the opaque bbox. The layer with the largest opaque area is the
    background plate; **every other layer gets its RGB re-taken from the
    full-resolution source** through its own upscaled alpha, so foreground
    objects keep the original's sharpness and only the cut edge is limited by
    the model's resolution.

    Returns `[{'index', 'png', 'bbox', 'is_background', 'opaque_fraction'}]`
    in the model's own order (which is bottom-to-top), background first if the
    model put it there. Raises `RuntimeError` if nothing usable came back.
    """
    source = Image.open(io.BytesIO(source_bytes)).convert('RGBA')
    width, height = source.size
    source_rgb = np.asarray(source, dtype=np.uint8)[:, :, :3]
    canvas_area = float(width * height)

    candidates = []
    for index, png in enumerate(layer_pngs):
        layer = Image.open(io.BytesIO(png)).convert('RGBA')
        if layer.size != (width, height):
            # RGB and alpha are resampled differently on purpose: LANCZOS
            # keeps the (background) colours crisp, but its ringing would put
            # semi-transparent speckles inside an object and a faint halo well
            # outside it - on the alpha channel that reads as holes and dirt.
            # BILINEAR is monotone, so an opaque interior stays opaque and a
            # transparent area stays transparent.
            rgb_part = layer.convert('RGB').resize((width, height), Image.LANCZOS)
            alpha_part = layer.getchannel('A').resize((width, height), Image.BILINEAR)
            layer = Image.merge('RGBA', (*rgb_part.split(), alpha_part))
        arr = np.asarray(layer, dtype=np.uint8)
        alpha = arr[:, :, 3]
        bbox = _alpha_bbox(alpha)
        opaque_fraction = float((alpha > 0).sum()) / canvas_area if canvas_area else 0.0
        if bbox is None or opaque_fraction < _MIN_OPAQUE_FRACTION:
            continue
        candidates.append({'index': index, 'arr': arr, 'alpha': alpha,
                           'bbox': bbox, 'opaque_fraction': opaque_fraction})

    if not candidates:
        raise RuntimeError('Модель вернула пустой набор слоёв')

    background = max(candidates, key=lambda c: c['opaque_fraction'])

    layers = []
    for position, candidate in enumerate(candidates):
        arr = candidate['arr']
        is_background = candidate is background
        if not is_background:
            arr = np.dstack((source_rgb, candidate['alpha']))
        out = io.BytesIO()
        Image.fromarray(arr, 'RGBA').save(out, 'PNG')
        layers.append({
            'index': position, 'png': out.getvalue(), 'bbox': candidate['bbox'],
            'is_background': is_background, 'opaque_fraction': round(candidate['opaque_fraction'], 4),
        })
    return layers


async def _run_job(
    job_id: str, slug: str, source_path: str, source_kind: str, image_bytes: bytes, ext: str,
    method: str, num_layers: int, settings: dict, usage_ctx: dict | None = None,
) -> None:
    fal_params = settings.get('magic_layers_fal_params') or {}
    replicate_params = settings.get('magic_layers_replicate_params') or {}
    if method == 'replicate':
        model = f'replicate:{replicate_params.get("model") or _REPLICATE_LAYERED_ID}'
    else:
        model = f'fal:{fal_params.get("model") or _FAL_LAYERED_ID}'

    started = time.monotonic()
    provider_usage: dict = {}
    try:
        console_log.log_request_start(model, 'image', usage_ctx.get('task') if usage_ctx else None)
        if method == 'replicate':
            api_key = (settings.get('api_keys') or {}).get('replicate', '')
            layer_pngs = await _generate_replicate(
                image_bytes, ext, api_key, num_layers, usage_out=provider_usage, params=replicate_params,
            )
        else:
            api_key = (settings.get('api_keys') or {}).get('fal', '')
            layer_pngs = await _generate_fal(
                image_bytes, ext, api_key, num_layers, usage_out=provider_usage, params=fal_params,
            )
        layers = await asyncio.to_thread(_postprocess, image_bytes, layer_pngs)
    except Exception as exc:
        usage.record(usage_ctx, model=model, kind='image', status='error',
                     duration_ms=int((time.monotonic() - started) * 1000), prompt=source_path, error=str(exc),
                     debug=provider_usage.get('debug'))
        _jobs[job_id] = {'status': 'failed', 'group': None, 'error': str(exc),
                         'debug': provider_usage.get('debug')}
        return

    group_id = f'mg_{uuid4().hex[:8]}'
    group_dir = storage.project_dir(slug) / 'magic' / group_id
    group_dir.mkdir(parents=True, exist_ok=True)
    with Image.open(io.BytesIO(image_bytes)) as source:
        canvas = {'width': source.width, 'height': source.height}

    layer_records = []
    for layer in layers:
        filename = f'L{layer["index"]}.png'
        (group_dir / filename).write_bytes(layer['png'])
        layer_records.append({
            'index': layer['index'], 'file_path': f'magic/{group_id}/{filename}',
            'bbox': layer['bbox'], 'is_background': layer['is_background'],
        })

    provider_cost = provider_usage.pop('cost', None)
    debug_info = provider_usage.pop('debug', None)
    units = {'images': 1, **provider_usage}
    if provider_cost is not None:
        cost = provider_cost
    else:
        cost, _ = pricing.compute_cost(model, units, (usage_ctx or {}).get('pricing_overrides'))
    group = {
        'group_id': group_id, 'source_path': source_path, 'source_kind': source_kind,
        'canvas': canvas, 'method': method, 'model': model,
        'num_layers': len(layer_records), 'requested_layers': num_layers,
        'layers': layer_records, 'cost': cost, 'generated_at': _now(),
    }

    async with storage.project_lock(slug):
        project = storage.load_project(slug)
        if project is not None:
            project['magic_layer_groups'] = [*project.get('magic_layer_groups', []), group]
            project['updated_at'] = _now()
            storage.save_project(slug, project)

    usage.record(usage_ctx, model=model, kind='image', status='ok',
                 duration_ms=int((time.monotonic() - started) * 1000),
                 units=units, prompt=source_path, response=f'magic/{group_id}',
                 provider_cost=provider_cost, debug=debug_info)
    _jobs[job_id] = {'status': 'completed', 'group': group, 'error': None, 'debug': debug_info}


def start_job(
    slug: str, source_path: str, source_kind: str, settings: dict,
    num_layers=None, method: str | None = None, usage_ctx: dict | None = None,
) -> str:
    """Reads the source image, then hands the whole decomposition to a
    background task - the call itself takes 15-30s, far too long to hold a
    request open. Raises `ValueError` if the source file is missing (the route
    maps it to a 404); the path itself is validated by the route before this
    is reached."""
    file_path = storage.project_dir(slug) / source_path
    if not file_path.is_file():
        raise ValueError('Source image not found')
    ext = file_path.suffix.removeprefix('.').lower() or 'png'
    image_bytes = file_path.read_bytes()

    method = method if method in ('fal', 'replicate') else (settings.get('magic_layers_method') or 'fal')
    num_layers = clamp_layers(num_layers if num_layers is not None else settings.get('magic_layers_num_layers'))

    job_id = uuid4().hex
    _jobs[job_id] = {'status': 'pending', 'group': None, 'error': None}
    asyncio.create_task(
        _run_job(job_id, slug, source_path, source_kind, image_bytes, ext, method, num_layers, settings, usage_ctx),
    )
    return job_id


def get_job(job_id: str) -> dict | None:
    return _jobs.get(job_id)
