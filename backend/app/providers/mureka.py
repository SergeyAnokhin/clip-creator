"""Provider seam for real music generation via the Mureka API (distinct from
`suno.py`, which only writes a style/lyrics *text* pair for pasting into an
external service - this module actually calls out and produces audio files).

Confirmed against platform.mureka.ai/docs, 2026-08:
- `POST https://api.mureka.ai/v1/song/generate` `{lyrics, model, n, prompt,
  gender?, reference_id?}` -> `{id, created_at, model, status, trace_id}`
  (async task).
- `GET https://api.mureka.ai/v1/song/query/{task_id}` -> `{id, created_at,
  finished_at, model, status ('preparing'|'queued'|'running'|'streaming'|
  'succeeded'|'failed'|'timeouted'|'cancelled'), failed_reason, choices:
  [{index, id, url, flac_url, wav_url, duration (ms), lyrics_sections}]}`.
  `url` is only valid for 30 days, so a succeeded job's audio is downloaded
  to disk immediately rather than kept as a link.
- `POST https://api.mureka.ai/v1/files/upload` (multipart, `purpose:
  'reference'`, mp3/m4a, exactly 30s - excess trimmed by Mureka) ->
  `{id, bytes, created_at, filename, purpose}` - the returned `id` is what
  `reference_id` on `song/generate` expects.

Unlike `images.py`'s per-variant job (`start_jobs` -> one job per requested
image), Mureka's own `n` parameter returns several songs from a *single*
task, so this module submits and polls **one** job per generate click
(`start_job`/`get_job`, singular) and materializes up to `n` track records
from that one task's `choices[]` on completion. Mureka doesn't report a
per-call cost, so `usage.record` is called without `provider_cost` and with
no matching `pricing.py` catalog row - cost resolves to `None`/"unknown" by
the existing convention (see `docs/usage-tracking.md`) rather than a made-up
number.
"""

import asyncio
import time
from datetime import datetime, timezone
from uuid import uuid4

import httpx

from .. import console_log, storage, usage

_API_BASE = 'https://api.mureka.ai'
# Mureka's own docs cite 30-90s typical generation time (vs. images.py's
# ~1-30s), so both the poll cadence and the timeout are longer.
_POLL_INTERVAL = 3.0
_JOB_TIMEOUT = 600.0
_TERMINAL_STATUSES = {'succeeded', 'failed', 'timeouted', 'cancelled'}

_jobs: dict[str, dict] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


async def upload_reference_audio(content: bytes, filename: str, api_key: str) -> dict:
    """`POST /v1/files/upload`, `purpose='reference'` - the returned `id` is a
    Mureka file id, usable as `reference_id` on `song/generate`."""
    if not api_key:
        raise RuntimeError('Нет API-ключа Mureka')
    headers = {'Authorization': f'Bearer {api_key}'}
    async with httpx.AsyncClient(timeout=30) as http_client:
        resp = await http_client.post(
            f'{_API_BASE}/v1/files/upload', headers=headers,
            files={'file': (filename, content)}, data={'purpose': 'reference'},
        )
    if resp.status_code != 200:
        raise RuntimeError(f'Mureka API (files/upload) вернул {resp.status_code}: {resp.text[:300]}')
    return resp.json()


async def _submit(
    style: str, lyrics: str, model: str, n: int, gender: str | None, reference_id: str | None, api_key: str,
) -> tuple[dict, dict]:
    if not api_key:
        raise RuntimeError('Нет API-ключа Mureka')
    body: dict = {'lyrics': lyrics, 'model': model or 'auto', 'n': n}
    if style:
        body['prompt'] = style
    if gender in ('male', 'female'):
        body['gender'] = gender
    if reference_id:
        body['reference_id'] = reference_id
    headers = {'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}
    debug_request = {'url': f'{_API_BASE}/v1/song/generate', 'body': body}

    async with httpx.AsyncClient(timeout=30) as http_client:
        resp = await http_client.post(f'{_API_BASE}/v1/song/generate', headers=headers, json=body)
    if resp.status_code != 200:
        raise RuntimeError(f'Mureka API вернул {resp.status_code}: {resp.text[:300]}')
    return resp.json(), debug_request


async def _poll(task_id: str, api_key: str) -> dict:
    headers = {'Authorization': f'Bearer {api_key}'}
    deadline = time.monotonic() + _JOB_TIMEOUT
    while True:
        await asyncio.sleep(_POLL_INTERVAL)
        async with httpx.AsyncClient(timeout=30) as http_client:
            resp = await http_client.get(f'{_API_BASE}/v1/song/query/{task_id}', headers=headers)
        if resp.status_code != 200:
            raise RuntimeError(f'Mureka API (poll) вернул {resp.status_code}: {resp.text[:300]}')
        data = resp.json()
        if data.get('status') in _TERMINAL_STATUSES:
            return data
        if time.monotonic() > deadline:
            raise RuntimeError('Mureka: превышено время ожидания генерации')


async def _download(url: str) -> bytes:
    async with httpx.AsyncClient(timeout=60) as http_client:
        resp = await http_client.get(url)
    if resp.status_code != 200:
        raise RuntimeError(f'Не удалось скачать трек ({resp.status_code})')
    return resp.content


async def _run_job(
    job_id: str, slug: str, style: str, lyrics: str, model: str, n: int,
    gender: str | None, reference_id: str | None, api_key: str, usage_ctx: dict | None = None,
) -> None:
    started = time.monotonic()
    model_composite = f'mureka:{model or "auto"}'
    debug_request = None
    try:
        console_log.log_request_start(model_composite, 'audio', usage_ctx.get('task') if usage_ctx else None)
        submitted, debug_request = await _submit(style, lyrics, model, n, gender, reference_id, api_key)
        task_id = submitted['id']
        result = await _poll(task_id, api_key)
        if result.get('status') != 'succeeded':
            reason = f' ({result["failed_reason"]})' if result.get('failed_reason') else ''
            raise RuntimeError(f'Mureka: генерация завершилась со статусом {result.get("status")}{reason}')
        choices = result.get('choices') or []
        if not choices:
            raise RuntimeError('Mureka: задание завершено, но треков не найдено')
    except Exception as exc:
        usage.record(usage_ctx, model=model_composite, kind='audio', status='error',
                     duration_ms=int((time.monotonic() - started) * 1000), prompt=style, error=str(exc),
                     debug={'request': debug_request} if debug_request else None)
        _jobs[job_id] = {'status': 'failed', 'tracks': None, 'error': str(exc)}
        return

    music_dir = storage.project_dir(slug) / 'music'
    music_dir.mkdir(parents=True, exist_ok=True)
    tracks = []
    for choice in choices:
        url = choice.get('url')
        if not url:
            continue
        try:
            content = await _download(url)
        except Exception:
            continue
        track_id = f'trk_{uuid4().hex[:8]}'
        filename = f'{track_id}.mp3'
        (music_dir / filename).write_bytes(content)
        tracks.append({
            'track_id': track_id, 'task_id': task_id, 'choice_index': choice.get('index'),
            'file_path': f'music/{filename}', 'duration_ms': choice.get('duration'),
            'model': model_composite, 'style': style, 'lyrics': lyrics,
            'params': {'n': n, 'gender': gender, 'reference_id': reference_id},
            'rating': 0, 'is_selected': False, 'tag_ids': [],
            'generated_at': _now(), 'raw': choice,
        })

    if not tracks:
        err = 'Mureka: не удалось скачать ни одного трека'
        usage.record(usage_ctx, model=model_composite, kind='audio', status='error',
                     duration_ms=int((time.monotonic() - started) * 1000), prompt=style, error=err,
                     debug={'request': debug_request, 'response': result})
        _jobs[job_id] = {'status': 'failed', 'tracks': None, 'error': err}
        return

    async with storage.project_lock(slug):
        project = storage.load_project(slug)
        if project is not None:
            mureka_data = project.setdefault('mureka', {'reference_audio': [], 'tracks': []})
            mureka_data['tracks'] = [*mureka_data.get('tracks', []), *tracks]
            project['updated_at'] = _now()
            storage.save_project(slug, project)

    usage.record(usage_ctx, model=model_composite, kind='audio', status='ok',
                 duration_ms=int((time.monotonic() - started) * 1000),
                 units={'tracks': len(tracks)}, prompt=style, response=tracks[0]['file_path'],
                 debug={'request': debug_request, 'response': result})
    _jobs[job_id] = {'status': 'completed', 'tracks': tracks, 'error': None}


def start_job(
    slug: str, style: str, lyrics: str, model: str, n: int, gender: str | None,
    reference_id: str | None, settings: dict, usage_ctx: dict | None = None,
) -> str:
    api_key = (settings.get('api_keys') or {}).get('mureka', '')
    job_id = uuid4().hex
    _jobs[job_id] = {'status': 'pending', 'tracks': None, 'error': None}
    n_clamped = max(1, min(3, n or 1))
    asyncio.create_task(
        _run_job(job_id, slug, style, lyrics, model, n_clamped, gender, reference_id, api_key, usage_ctx),
    )
    return job_id


def get_job(job_id: str) -> dict | None:
    return _jobs.get(job_id)
