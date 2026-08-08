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
- `POST https://api.mureka.ai/v1/song/describe` `{url}` (a hosted link or a
  base64 data URI, <=10MB decoded - same technique `song/stem` uses) ->
  `{instrument[], genres[], tags[], description}`, synchronous, no track
  needed on Mureka's side.
- `POST https://api.mureka.ai/v1/song/transcribe` `{song_id}` -> `{zip_url,
  expires_at}` (a .musicxml + .pdf pair), synchronous like `song/stem`.
- `POST https://api.mureka.ai/v1/lyrics-video/generate` `{song_id, title?,
  aspect_ratio?}` -> `{url}` (mp4, valid 30 days), synchronous. All three
  confirmed against platform.mureka.ai/docs, 2026-08 - none of them go
  through the task/poll dance `song/generate`/`song/extend` use.

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
import base64
import shutil
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import httpx

from .. import console_log, storage, usage

_API_BASE = 'https://api.mureka.ai'
# Mureka's own docs cite 30-90s typical generation time (vs. images.py's
# ~1-30s), so both the poll cadence and the timeout are longer.
_POLL_INTERVAL = 3.0
_JOB_TIMEOUT = 600.0
_TERMINAL_STATUSES = {'succeeded', 'failed', 'timeouted', 'cancelled'}
# /v1/song/stem's `url` field accepts a base64 data URI in lieu of a hosted
# link (confirmed against platform.mureka.ai/docs, 2026-08) capped at 10MB -
# checked against the *decoded* local file before ever making the call.
_STEM_MAX_BYTES = 10 * 1024 * 1024

_jobs: dict[str, dict] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def _extract_error_message(resp: httpx.Response) -> str:
    """Mureka's real error body is `{"error": {"message": "..."}}`
    (confirmed live, 2026-08 - e.g. "Invalid Request, The audio duration
    should be at least 30 seconds."). Surfacing just that message instead of
    the raw JSON blob is the difference between a toast the user can act on
    and one that reads like a stack trace."""
    try:
        message = (resp.json().get('error') or {}).get('message')
        if message:
            return message
    except Exception:
        pass
    return f'{resp.status_code}: {resp.text[:300]}'


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
        raise RuntimeError(f'Mureka API (files/upload): {_extract_error_message(resp)}')
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
        raise RuntimeError(f'Mureka API: {_extract_error_message(resp)}')
    return resp.json(), debug_request


async def _poll(task_id: str, api_key: str, job_id: str | None = None) -> dict:
    """Polls `song/query/{task_id}` until a terminal status. When `job_id` is
    given, mirrors each intermediate `status` (preparing/queued/running/
    streaming - see the SongTask schema) into `_jobs[job_id]['stage']` so
    `GET /mureka/jobs/{job_id}` can show real progress instead of just an
    elapsed-seconds counter."""
    headers = {'Authorization': f'Bearer {api_key}'}
    deadline = time.monotonic() + _JOB_TIMEOUT
    while True:
        await asyncio.sleep(_POLL_INTERVAL)
        async with httpx.AsyncClient(timeout=30) as http_client:
            resp = await http_client.get(f'{_API_BASE}/v1/song/query/{task_id}', headers=headers)
        if resp.status_code != 200:
            raise RuntimeError(f'Mureka API (poll): {_extract_error_message(resp)}')
        data = resp.json()
        status = data.get('status')
        if job_id is not None and job_id in _jobs and status not in _TERMINAL_STATUSES:
            _jobs[job_id]['stage'] = status
        if status in _TERMINAL_STATUSES:
            return data
        if time.monotonic() > deadline:
            raise RuntimeError('Mureka: превышено время ожидания генерации')


async def _download(url: str) -> bytes:
    async with httpx.AsyncClient(timeout=60) as http_client:
        resp = await http_client.get(url)
    if resp.status_code != 200:
        raise RuntimeError(f'Не удалось скачать трек: {_extract_error_message(resp)}')
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
        result = await _poll(task_id, api_key, job_id)
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
        _jobs[job_id] = {'status': 'failed', 'tracks': None, 'error': str(exc), 'stage': None}
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
            'generated_at': _now(), 'raw': choice, 'reference_used': None,
        })

    if not tracks:
        err = 'Mureka: не удалось скачать ни одного трека'
        usage.record(usage_ctx, model=model_composite, kind='audio', status='error',
                     duration_ms=int((time.monotonic() - started) * 1000), prompt=style, error=err,
                     debug={'request': debug_request, 'response': result})
        _jobs[job_id] = {'status': 'failed', 'tracks': None, 'error': err, 'stage': None}
        return

    async with storage.project_lock(slug):
        project = storage.load_project(slug)
        if project is not None:
            mureka_data = project.setdefault('mureka', {'reference_audio': [], 'tracks': []})
            reference_used = None
            if reference_id:
                ref_entry = next(
                    (r for r in mureka_data.get('reference_audio', []) if r.get('mureka_file_id') == reference_id),
                    None,
                )
                if ref_entry:
                    reference_used = {
                        'source_id': ref_entry.get('source_id'), 'filename': ref_entry.get('filename'),
                        'start_ms': ref_entry.get('start_ms'), 'end_ms': ref_entry.get('end_ms'),
                    }
            for track in tracks:
                track['reference_used'] = reference_used
            mureka_data['tracks'] = [*mureka_data.get('tracks', []), *tracks]
            project['updated_at'] = _now()
            storage.save_project(slug, project)

    usage.record(usage_ctx, model=model_composite, kind='audio', status='ok',
                 duration_ms=int((time.monotonic() - started) * 1000),
                 units={'tracks': len(tracks)}, prompt=style, response=tracks[0]['file_path'],
                 debug={'request': debug_request, 'response': result})
    _jobs[job_id] = {'status': 'completed', 'tracks': tracks, 'error': None, 'stage': None}


def start_job(
    slug: str, style: str, lyrics: str, model: str, n: int, gender: str | None,
    reference_id: str | None, settings: dict, usage_ctx: dict | None = None,
) -> str:
    api_key = (settings.get('api_keys') or {}).get('mureka', '')
    job_id = uuid4().hex
    _jobs[job_id] = {'status': 'pending', 'tracks': None, 'error': None, 'stage': None}
    n_clamped = max(1, min(3, n or 1))
    asyncio.create_task(
        _run_job(job_id, slug, style, lyrics, model, n_clamped, gender, reference_id, api_key, usage_ctx),
    )
    return job_id


def get_job(job_id: str) -> dict | None:
    return _jobs.get(job_id)


async def get_billing(api_key: str) -> dict:
    """`GET /v1/account/billing` - confirmed live, 2026-08:
    `{account_id, balance, total_recharge, total_spending,
    concurrent_request_limit, trace_id}`. The currency/unit of `balance`
    isn't documented anywhere on platform.mureka.ai - shown to the user
    as-is, no invented conversion."""
    if not api_key:
        raise RuntimeError('Нет API-ключа Mureka')
    headers = {'Authorization': f'Bearer {api_key}'}
    async with httpx.AsyncClient(timeout=15) as http_client:
        resp = await http_client.get(f'{_API_BASE}/v1/account/billing', headers=headers)
    if resp.status_code != 200:
        raise RuntimeError(f'Mureka API (account/billing): {_extract_error_message(resp)}')
    return resp.json()


# ---------- Extend an existing track (POST /v1/song/extend) ----------
# Mirrors the generate flow above almost exactly: submit -> poll (SongTask,
# same shape) -> download each choice - same _jobs dict/get_job, so the
# frontend reuses the existing GET /mureka/jobs/{job_id} poll route
# unchanged. Confirmed against the docs site's own embedded OpenAPI spec,
# 2026-08 (SongExtendReq): required `lyrics` (continuation text) +
# `extend_at` (ms), optional `song_id` (a `Song.id` from a prior
# generate/extend - what we store as `track['raw']['id']`), `extend_type`
# ('tail'|'head', mureka-8 only) and `model`.

async def _submit_extend(
    song_id: str, lyrics: str, extend_at: int, model: str | None, extend_type: str | None, api_key: str,
) -> tuple[dict, dict]:
    if not api_key:
        raise RuntimeError('Нет API-ключа Mureka')
    body: dict = {'song_id': song_id, 'lyrics': lyrics, 'extend_at': extend_at}
    if model:
        body['model'] = model
    if extend_type:
        body['extend_type'] = extend_type
    headers = {'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}
    debug_request = {'url': f'{_API_BASE}/v1/song/extend', 'body': body}
    async with httpx.AsyncClient(timeout=30) as http_client:
        resp = await http_client.post(f'{_API_BASE}/v1/song/extend', headers=headers, json=body)
    if resp.status_code != 200:
        raise RuntimeError(f'Mureka API (song/extend): {_extract_error_message(resp)}')
    return resp.json(), debug_request


async def _run_extend_job(
    job_id: str, slug: str, source_track_id: str, song_id: str, lyrics: str, extend_at: int,
    model: str | None, extend_type: str | None, api_key: str, usage_ctx: dict | None = None,
) -> None:
    started = time.monotonic()
    model_composite = f'mureka:{model or "auto"}'
    debug_request = None
    try:
        console_log.log_request_start(model_composite, 'audio', usage_ctx.get('task') if usage_ctx else None)
        submitted, debug_request = await _submit_extend(song_id, lyrics, extend_at, model, extend_type, api_key)
        task_id = submitted['id']
        result = await _poll(task_id, api_key, job_id)
        if result.get('status') != 'succeeded':
            reason = f' ({result["failed_reason"]})' if result.get('failed_reason') else ''
            raise RuntimeError(f'Mureka: продление завершилось со статусом {result.get("status")}{reason}')
        choices = result.get('choices') or []
        if not choices:
            raise RuntimeError('Mureka: задание завершено, но треков не найдено')
    except Exception as exc:
        usage.record(usage_ctx, model=model_composite, kind='audio', status='error',
                     duration_ms=int((time.monotonic() - started) * 1000), prompt=lyrics, error=str(exc),
                     debug={'request': debug_request} if debug_request else None)
        _jobs[job_id] = {'status': 'failed', 'tracks': None, 'error': str(exc), 'stage': None}
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
            'model': model_composite, 'style': '', 'lyrics': lyrics,
            'params': {'extend_at': extend_at, 'extend_type': extend_type},
            'extended_from_track_id': source_track_id,
            'rating': 0, 'is_selected': False, 'tag_ids': [],
            'generated_at': _now(), 'raw': choice,
        })

    if not tracks:
        err = 'Mureka: не удалось скачать ни одного трека'
        usage.record(usage_ctx, model=model_composite, kind='audio', status='error',
                     duration_ms=int((time.monotonic() - started) * 1000), prompt=lyrics, error=err,
                     debug={'request': debug_request, 'response': result})
        _jobs[job_id] = {'status': 'failed', 'tracks': None, 'error': err, 'stage': None}
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
                 units={'tracks': len(tracks)}, prompt=lyrics, response=tracks[0]['file_path'],
                 debug={'request': debug_request, 'response': result})
    _jobs[job_id] = {'status': 'completed', 'tracks': tracks, 'error': None, 'stage': None}


def start_extend_job(
    slug: str, source_track_id: str, song_id: str, lyrics: str, extend_at: int,
    model: str | None, extend_type: str | None, settings: dict, usage_ctx: dict | None = None,
) -> str:
    api_key = (settings.get('api_keys') or {}).get('mureka', '')
    job_id = uuid4().hex
    _jobs[job_id] = {'status': 'pending', 'tracks': None, 'error': None, 'stage': None}
    asyncio.create_task(
        _run_extend_job(job_id, slug, source_track_id, song_id, lyrics, extend_at, model, extend_type, api_key, usage_ctx),
    )
    return job_id


# ---------- Stem separation (POST /v1/song/stem) ----------
# Unlike generate/extend, this is a *synchronous* call - the response
# already carries the result (SongStemResp: {zip_url, expires_at,
# midi_zip_url}), no task/poll dance. Confirmed against the docs site's
# embedded OpenAPI spec, 2026-08 (SongStemReq): required `url` - a hosted
# link OR a base64 data URI (`data:audio/mpeg;base64,...`), capped at 10MB
# decoded - we already have the track's mp3 on disk, so a data URI avoids
# needing any hosting. Optional `model` picks stem count/format
# (audio-separation-1/2/3). `zip_url` is only valid until `expires_at`, so
# (like every other Mureka result URL in this file) it's downloaded to disk
# immediately rather than kept as a link.

async def stem_track(
    content: bytes, model: str | None, api_key: str, dest_zip_path: Path, usage_ctx: dict | None = None,
) -> dict:
    started = time.monotonic()
    model_label = f'mureka:{model or "audio-separation-1"}'
    if not api_key:
        raise RuntimeError('Нет API-ключа Mureka')
    if len(content) > _STEM_MAX_BYTES:
        raise RuntimeError(
            f'Файл трека больше {_STEM_MAX_BYTES // (1024 * 1024)}MB - Mureka API не принимает такой размер для stem',
        )
    data_uri = f'data:audio/mpeg;base64,{base64.b64encode(content).decode("ascii")}'
    body: dict = {'url': data_uri}
    if model:
        body['model'] = model
    headers = {'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}
    try:
        async with httpx.AsyncClient(timeout=60) as http_client:
            resp = await http_client.post(f'{_API_BASE}/v1/song/stem', headers=headers, json=body)
        if resp.status_code != 200:
            raise RuntimeError(f'Mureka API (song/stem): {_extract_error_message(resp)}')
        result = resp.json()
        zip_url = result.get('zip_url')
        if not zip_url:
            raise RuntimeError('Mureka: ответ не содержит ссылку на архив со стемами')
        zip_bytes = await _download(zip_url)
        dest_zip_path.parent.mkdir(parents=True, exist_ok=True)
        dest_zip_path.write_bytes(zip_bytes)
    except Exception as exc:
        usage.record(usage_ctx, model=model_label, kind='audio', status='error',
                     duration_ms=int((time.monotonic() - started) * 1000), error=str(exc))
        raise RuntimeError(str(exc)) from exc
    usage.record(usage_ctx, model=model_label, kind='audio', status='ok',
                 duration_ms=int((time.monotonic() - started) * 1000), response=str(dest_zip_path.name))
    return result


# ---------- Song insight/utility calls (describe / transcribe / lyrics-video) ----------
# Three more real, synchronous Mureka calls (no task/poll, unlike generate/
# extend) - each returns its result directly in the response body, same
# shape as song/stem above. describe works on any audio (no Mureka-side
# track needed, so it's sent as a base64 data URI like song/stem); transcribe
# and lyrics-video both operate on an existing Mureka `song_id` (a track's
# `raw['id']`, same id "Продлить"/extend uses) rather than re-uploading
# bytes. No pricing.py catalog row for any of the three (Mureka doesn't
# report a per-call cost) - same "cost: unknown" convention as every other
# mureka.py call.

async def describe_song(content: bytes, api_key: str, usage_ctx: dict | None = None) -> dict:
    started = time.monotonic()
    model_label = 'mureka:song-describe'
    if not api_key:
        raise RuntimeError('Нет API-ключа Mureka')
    if len(content) > _STEM_MAX_BYTES:
        raise RuntimeError(
            f'Файл трека больше {_STEM_MAX_BYTES // (1024 * 1024)}MB - Mureka API не принимает такой размер для описания',
        )
    data_uri = f'data:audio/mpeg;base64,{base64.b64encode(content).decode("ascii")}'
    headers = {'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}
    try:
        async with httpx.AsyncClient(timeout=60) as http_client:
            resp = await http_client.post(f'{_API_BASE}/v1/song/describe', headers=headers, json={'url': data_uri})
        if resp.status_code != 200:
            raise RuntimeError(f'Mureka API (song/describe): {_extract_error_message(resp)}')
        result = resp.json()
    except Exception as exc:
        usage.record(usage_ctx, model=model_label, kind='audio', status='error',
                     duration_ms=int((time.monotonic() - started) * 1000), error=str(exc))
        raise RuntimeError(str(exc)) from exc
    usage.record(usage_ctx, model=model_label, kind='audio', status='ok',
                 duration_ms=int((time.monotonic() - started) * 1000), response=result.get('description', ''))
    return result


async def transcribe_song(song_id: str, api_key: str, dest_zip_path: Path, usage_ctx: dict | None = None) -> dict:
    started = time.monotonic()
    model_label = 'mureka:song-transcribe'
    if not api_key:
        raise RuntimeError('Нет API-ключа Mureka')
    headers = {'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}
    try:
        async with httpx.AsyncClient(timeout=60) as http_client:
            resp = await http_client.post(f'{_API_BASE}/v1/song/transcribe', headers=headers, json={'song_id': song_id})
        if resp.status_code != 200:
            raise RuntimeError(f'Mureka API (song/transcribe): {_extract_error_message(resp)}')
        result = resp.json()
        zip_url = result.get('zip_url')
        if not zip_url:
            raise RuntimeError('Mureka: ответ не содержит ссылку на архив с нотами')
        zip_bytes = await _download(zip_url)
        dest_zip_path.parent.mkdir(parents=True, exist_ok=True)
        dest_zip_path.write_bytes(zip_bytes)
    except Exception as exc:
        usage.record(usage_ctx, model=model_label, kind='audio', status='error',
                     duration_ms=int((time.monotonic() - started) * 1000), error=str(exc))
        raise RuntimeError(str(exc)) from exc
    usage.record(usage_ctx, model=model_label, kind='audio', status='ok',
                 duration_ms=int((time.monotonic() - started) * 1000), response=str(dest_zip_path.name))
    return result


async def generate_lyrics_video(
    song_id: str, title: str | None, aspect_ratio: str | None, api_key: str, dest_path: Path,
    usage_ctx: dict | None = None,
) -> dict:
    started = time.monotonic()
    model_label = 'mureka:lyrics-video'
    if not api_key:
        raise RuntimeError('Нет API-ключа Mureka')
    body: dict = {'song_id': song_id}
    if title:
        body['title'] = title
    if aspect_ratio:
        body['aspect_ratio'] = aspect_ratio
    headers = {'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}
    try:
        async with httpx.AsyncClient(timeout=120) as http_client:
            resp = await http_client.post(f'{_API_BASE}/v1/lyrics-video/generate', headers=headers, json=body)
        if resp.status_code != 200:
            raise RuntimeError(f'Mureka API (lyrics-video/generate): {_extract_error_message(resp)}')
        result = resp.json()
        video_url = result.get('url')
        if not video_url:
            raise RuntimeError('Mureka: ответ не содержит ссылку на видео')
        video_bytes = await _download(video_url)
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        dest_path.write_bytes(video_bytes)
    except Exception as exc:
        usage.record(usage_ctx, model=model_label, kind='audio', status='error',
                     duration_ms=int((time.monotonic() - started) * 1000), error=str(exc))
        raise RuntimeError(str(exc)) from exc
    usage.record(usage_ctx, model=model_label, kind='audio', status='ok',
                 duration_ms=int((time.monotonic() - started) * 1000), response=str(dest_path.name))
    return result


# ---------- Local reference-audio trimming (ffmpeg) ----------
# Mureka's reference-upload hard-requires >=30s of audio (confirmed live,
# 2026-08 - "The audio duration should be at least 30 seconds") - rather
# than blindly upload whatever the user picked and let it 400, the Mureka
# stage lets them audition the source file and pick a window first
# (ReferenceAudioTrimmer.jsx); this just executes that cut. ffmpeg is a
# *system* dependency (not a pip package, see README) - nothing else in
# this repo shells out to an external binary.

def _run_ffmpeg_trim(src_path: Path, start_s: float, duration_s: float, dest_path: Path) -> None:
    cmd = ['ffmpeg', '-y', '-i', str(src_path), '-ss', f'{start_s:.3f}', '-t', f'{duration_s:.3f}',
           '-c:a', 'libmp3lame', '-q:a', '2', str(dest_path)]
    result = subprocess.run(cmd, capture_output=True, check=False)
    if result.returncode != 0:
        stderr = result.stderr.decode(errors='replace').strip()
        stdout = result.stdout.decode(errors='replace').strip()
        # Seen live with an empty stderr *and* stdout despite a non-zero exit
        # code - ffmpeg itself always writes something before failing, so
        # that combination means the process was cut off before it could run
        # at all (most likely something external killed/blocked it, e.g.
        # antivirus flagging a subprocess spawned by the reloaded backend) -
        # worth calling out explicitly since a truly empty message otherwise
        # gives no lead at all.
        detail = stderr or stdout or (
            'ffmpeg ничего не вывел, хотя завершился с ошибкой - вероятно, процесс '
            'был прерван до запуска (например, антивирусом). Проверьте лог backend '
            'в терминале и попробуйте ещё раз.'
        )
        console_log.log_error(
            'ffmpeg trim',
            f'exit={result.returncode} cmd={" ".join(cmd)}\nstderr={stderr!r}\nstdout={stdout!r}',
        )
        raise RuntimeError(f'ffmpeg не смог обрезать файл (код {result.returncode}): {detail[-400:]}')


async def trim_audio(src_path: Path, start_ms: int, end_ms: int, dest_path: Path) -> None:
    if shutil.which('ffmpeg') is None:
        raise RuntimeError(
            'ffmpeg не найден в PATH - он нужен, чтобы обрезать референс-аудио. '
            'Установите ffmpeg (ffmpeg.org) и перезапустите backend.',
        )
    start_s = max(0, start_ms) / 1000
    duration_s = max(0.0, (end_ms - start_ms) / 1000)
    if duration_s <= 0:
        raise RuntimeError('Некорректный диапазон обрезки')
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    # `asyncio.create_subprocess_exec` needs a Proactor event loop on Windows
    # - not guaranteed under every ASGI server/reload setup (confirmed live:
    # under `uvicorn --reload`, it raised an empty-message NotImplementedError
    # instead of ever spawning ffmpeg). A plain blocking `subprocess.run` in a
    # worker thread has no such dependency, at the cost of tying up one
    # thread-pool thread for the duration of the cut (a few seconds at most).
    await asyncio.to_thread(_run_ffmpeg_trim, src_path, start_s, duration_s, dest_path)
