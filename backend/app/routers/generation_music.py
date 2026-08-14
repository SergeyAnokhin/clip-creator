"""Music-stage routes: the Suno prompt generator and every Mureka call.

Suno here is the *text* generator (style + lyrics); Mureka is the real
audio API. Data shapes live in `docs/data-model.md`, the providers in
`providers/suno.py` and `providers/mureka.py`.
"""

from uuid import uuid4

from fastapi import APIRouter, Body, File, HTTPException, UploadFile

from .. import console_log, storage, usage
from ..providers import mureka, suno, wish_library
from .generation_common import _now
from .projects import migrate_legacy_project
from .settings import DEFAULT_SETTINGS

router = APIRouter(prefix='/api/projects', tags=['generation'])


_ALLOWED_AUDIO_EXTENSIONS = {'.mp3', '.m4a'}


# Reference-audio *sources* (ReferenceAudioTrimmer.jsx) are a staging area,
# not what actually gets sent to Mureka - the trimmed clip that comes out
# the other end is what upload_mureka_reference_audio validates/sends, so
# this is a looser allowlist of whatever ffmpeg (and the browser's
# decodeAudioData for the waveform) can realistically decode.
_ALLOWED_REFERENCE_SOURCE_EXTENSIONS = {'.mp3', '.m4a', '.wav', '.ogg', '.flac', '.aac', '.webm'}


@router.post('/{project_id}/suno/generate')
async def generate_suno(project_id: str, body: dict = Body(default={})):
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')
    project = migrate_legacy_project(project)

    skill_id = body.get('skill_id', project.get('skill_id', 'skill_a'))
    skill_prompt = body.get('skill_prompt', project.get('skill_prompt', ''))
    model = body.get('model', '')
    active_wish_ids = body.get('active_wish_ids', project.get('active_wish_ids', []))
    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    wish_lookup = {w['id']: w['text'] for w in wish_library.normalize_wish_library(settings.get('suno_wish_library', []))}
    active_wishes = [wish_lookup[wid] for wid in active_wish_ids if wid in wish_lookup]
    usage_ctx = usage.context('suno_generate', project_id, settings, skill_id=skill_id)

    try:
        result = await suno.generate(
            project, skill_prompt=skill_prompt, model=model, settings=settings,
            usage_ctx=usage_ctx, active_wishes=active_wishes,
        )
    except Exception as exc:
        raise HTTPException(502, f'Не удалось сгенерировать через {model or "провайдер"}: {exc}') from exc
    project['style'] = result['style']
    project['lyrics'] = result['lyrics']
    project['skill_id'] = skill_id
    project['skill_prompt'] = skill_prompt
    project['model_used'] = model
    project['updated_at'] = _now()
    storage.save_project(project_id, project)
    return {**result, 'skill_id': skill_id, 'model_used': model}


@router.post('/{project_id}/suno/wishes')
async def add_suno_wish(project_id: str, body: dict = Body(...)):
    """Cleans+titles the user's free-text wish (dictated or typed), saves it
    to the global, cross-project settings.suno_wish_library (or reuses an
    existing entry with the same text - see wish_library.add_or_get_wish),
    and immediately activates it for this project. Replaces the old
    suno/refine flow, which destructively folded the wish into skill_prompt
    instead of keeping it as a reusable, toggleable card."""
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')
    project = migrate_legacy_project(project)

    text = (body.get('text') or '').strip()
    if not text:
        raise HTTPException(422, 'text is required')

    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    usage_ctx = usage.context('wish_title', project_id, settings)
    result = await wish_library.add_or_get_wish(text, settings, usage_ctx=usage_ctx)
    wish = result['wish']

    active_wish_ids = project.get('active_wish_ids', [])
    if wish['id'] not in active_wish_ids:
        active_wish_ids = [*active_wish_ids, wish['id']]
    project['active_wish_ids'] = active_wish_ids
    project['updated_at'] = _now()
    storage.save_project(project_id, project)
    return {'wish': wish, 'suno_wish_library': result['wish_library'], 'active_wish_ids': active_wish_ids}


@router.post('/{project_id}/mureka/generate')
async def generate_mureka(project_id: str, body: dict = Body(default={})):
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')

    style = body.get('style', '')
    lyrics = (body.get('lyrics') or '').strip()
    if not lyrics:
        raise HTTPException(422, 'lyrics is required')
    model = body.get('model', 'auto')
    n = body.get('n', 2)
    gender = body.get('gender')
    reference_id = body.get('reference_id')
    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    usage_ctx = usage.context('mureka_generate', project_id, settings, model=model, n=n)
    job_id = mureka.start_job(project_id, style, lyrics, model, n, gender, reference_id, settings, usage_ctx=usage_ctx)
    return {'job_id': job_id}


@router.get('/{project_id}/mureka/jobs/{job_id}')
async def get_mureka_job(project_id: str, job_id: str):
    job = mureka.get_job(job_id)
    if job is None:
        raise HTTPException(404, 'Job not found')
    return job


@router.delete('/{project_id}/mureka/tracks/{track_id}')
async def delete_mureka_track(project_id: str, track_id: str):
    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')
        mureka_field = project.get('mureka') or {}
        tracks = mureka_field.get('tracks', [])
        target = next((t for t in tracks if t.get('track_id') == track_id), None)
        if target is None:
            raise HTTPException(404, 'Track not found')

        remaining = [t for t in tracks if t.get('track_id') != track_id]
        mureka_field['tracks'] = remaining
        project['mureka'] = mureka_field
        project['updated_at'] = _now()
        storage.save_project(project_id, project)

    file_path = storage.project_dir(project_id) / target['file_path']
    if file_path.is_file():
        file_path.unlink()

    return {'tracks': remaining}


@router.post('/{project_id}/mureka/reference-audio')
async def upload_mureka_reference_audio(project_id: str, file: UploadFile = File(...)):
    suffix = ('.' + file.filename.rsplit('.', 1)[-1].lower()) if file.filename and '.' in file.filename else ''
    if suffix not in _ALLOWED_AUDIO_EXTENSIONS:
        raise HTTPException(415, 'Unsupported audio type')
    contents = await file.read()

    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    api_key = (settings.get('api_keys') or {}).get('mureka', '')
    try:
        uploaded = await mureka.upload_reference_audio(contents, file.filename or f'reference{suffix}', api_key)
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc
    console_log.log_step(
        '📤', 'reference-audio upload',
        f'project={project_id!r} filename={file.filename!r} bytes={len(contents)} -> mureka_file_id={uploaded.get("id")!r}',
    )

    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')

        references_dir = storage.project_dir(project_id) / 'music' / 'references'
        references_dir.mkdir(parents=True, exist_ok=True)
        filename = f'ref_{uuid4().hex[:8]}{suffix}'
        (references_dir / filename).write_bytes(contents)

        mureka_field = project.get('mureka') or {}
        reference_audio = [
            *mureka_field.get('reference_audio', []),
            {
                'id': f'mref_{uuid4().hex[:8]}', 'mureka_file_id': uploaded.get('id'),
                'file_path': f'music/references/{filename}', 'filename': file.filename,
                'uploaded_at': _now(),
            },
        ]
        mureka_field['reference_audio'] = reference_audio
        project['mureka'] = mureka_field
        project['updated_at'] = _now()
        storage.save_project(project_id, project)
    return {'reference_audio': reference_audio}


@router.delete('/{project_id}/mureka/reference-audio/{ref_id}')
async def delete_mureka_reference_audio(project_id: str, ref_id: str):
    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')
        mureka_field = project.get('mureka') or {}
        reference_audio = mureka_field.get('reference_audio', [])
        target = next((r for r in reference_audio if r.get('id') == ref_id), None)
        if target is None:
            raise HTTPException(404, 'Reference audio not found')

        remaining = [r for r in reference_audio if r.get('id') != ref_id]
        mureka_field['reference_audio'] = remaining
        project['mureka'] = mureka_field
        project['updated_at'] = _now()
        storage.save_project(project_id, project)

    file_path = storage.project_dir(project_id) / target['file_path']
    if file_path.is_file():
        file_path.unlink()

    return {'reference_audio': remaining}


# ---------- Reference-audio trimmer (ReferenceAudioTrimmer.jsx) ----------
# Mureka's reference upload hard-requires >=30s of audio - rather than
# uploading whatever the user picked straight to Mureka and risking a 400,
# an uploaded source file is kept locally first ("reference source") so the
# frontend can let the user audition it and pick a >=30s window; only the
# trimmed clip that comes out of /trim below ever reaches Mureka, via the
# same upload_mureka_reference_audio flow above. A source is never deleted
# by a successful trim - it stays in reference_sources so the same upload
# can be trimmed into another window later (the resulting reference_audio
# entry records which source_id/start_ms/end_ms it came from); only an
# explicit DELETE on the source itself removes it.

@router.post('/{project_id}/mureka/reference-sources')
async def upload_mureka_reference_source(project_id: str, file: UploadFile = File(...)):
    suffix = ('.' + file.filename.rsplit('.', 1)[-1].lower()) if file.filename and '.' in file.filename else ''
    if suffix not in _ALLOWED_REFERENCE_SOURCE_EXTENSIONS:
        raise HTTPException(415, 'Unsupported audio type')
    contents = await file.read()
    console_log.log_step('📤', 'reference-source upload', f'project={project_id!r} filename={file.filename!r} bytes={len(contents)}')

    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')

        sources_dir = storage.project_dir(project_id) / 'music' / 'reference-sources'
        sources_dir.mkdir(parents=True, exist_ok=True)
        source_id = f'msrc_{uuid4().hex[:8]}'
        filename = f'{source_id}{suffix}'
        (sources_dir / filename).write_bytes(contents)

        mureka_field = project.get('mureka') or {}
        reference_sources = [
            *mureka_field.get('reference_sources', []),
            {
                'id': source_id, 'file_path': f'music/reference-sources/{filename}',
                'filename': file.filename, 'uploaded_at': _now(),
            },
        ]
        mureka_field['reference_sources'] = reference_sources
        project['mureka'] = mureka_field
        project['updated_at'] = _now()
        storage.save_project(project_id, project)
    return {'reference_sources': reference_sources}


@router.delete('/{project_id}/mureka/reference-sources/{source_id}')
async def delete_mureka_reference_source(project_id: str, source_id: str):
    console_log.log_step('🗑️', 'reference-source delete', f'project={project_id!r} source_id={source_id!r}')
    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')
        mureka_field = project.get('mureka') or {}
        reference_sources = mureka_field.get('reference_sources', [])
        target = next((s for s in reference_sources if s.get('id') == source_id), None)
        if target is None:
            raise HTTPException(404, 'Reference source not found')

        remaining = [s for s in reference_sources if s.get('id') != source_id]
        mureka_field['reference_sources'] = remaining
        project['mureka'] = mureka_field
        project['updated_at'] = _now()
        storage.save_project(project_id, project)

    file_path = storage.project_dir(project_id) / target['file_path']
    if file_path.is_file():
        file_path.unlink()

    return {'reference_sources': remaining}


@router.post('/{project_id}/mureka/reference-sources/{source_id}/trim')
async def trim_mureka_reference_source(project_id: str, source_id: str, body: dict = Body(...)):
    start_ms, end_ms = body.get('start_ms'), body.get('end_ms')
    if start_ms is None or end_ms is None or end_ms <= start_ms:
        raise HTTPException(422, 'start_ms/end_ms required, end_ms must be greater than start_ms')

    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')
    mureka_field = project.get('mureka') or {}
    source = next((s for s in mureka_field.get('reference_sources', []) if s.get('id') == source_id), None)
    if source is None:
        raise HTTPException(404, 'Reference source not found')

    src_path = storage.project_dir(project_id) / source['file_path']
    trimmed_id = f'trim_{uuid4().hex[:8]}'
    trimmed_path = storage.project_dir(project_id) / 'music' / 'reference-sources' / f'{trimmed_id}.mp3'
    console_log.log_step(
        '✂️', 'reference-source trim',
        f'project={project_id!r} source_id={source_id!r} {start_ms}ms→{end_ms}ms src={src_path} exists={src_path.is_file()}',
    )
    try:
        await mureka.trim_audio(src_path, start_ms, end_ms, trimmed_path)
        trimmed_bytes = trimmed_path.read_bytes()

        settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
        api_key = (settings.get('api_keys') or {}).get('mureka', '')
        uploaded = await mureka.upload_reference_audio(trimmed_bytes, f'{trimmed_id}.mp3', api_key)
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc
    finally:
        trimmed_path.unlink(missing_ok=True)  # only the persisted reference_audio[] copy below is kept
    console_log.log_step(
        '📤', 'reference-audio upload (trimmed)',
        f'project={project_id!r} source_id={source_id!r} {start_ms}ms-{end_ms}ms -> mureka_file_id={uploaded.get("id")!r}',
    )

    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')
        mureka_field = project.get('mureka') or {}
        references_dir = storage.project_dir(project_id) / 'music' / 'references'
        references_dir.mkdir(parents=True, exist_ok=True)
        filename = f'ref_{uuid4().hex[:8]}.mp3'
        (references_dir / filename).write_bytes(trimmed_bytes)
        reference_audio = [
            *mureka_field.get('reference_audio', []),
            {
                'id': f'mref_{uuid4().hex[:8]}', 'mureka_file_id': uploaded.get('id'),
                'file_path': f'music/references/{filename}', 'filename': source.get('filename') or f'{trimmed_id}.mp3',
                'uploaded_at': _now(), 'source_id': source_id, 'start_ms': start_ms, 'end_ms': end_ms,
            },
        ]
        mureka_field['reference_audio'] = reference_audio
        project['mureka'] = mureka_field
        project['updated_at'] = _now()
        storage.save_project(project_id, project)
    return {'reference_audio': reference_audio}


# ---------- Post-generation track operations (extend / stem) ----------
# Both are real Mureka API calls (see providers/mureka.py's module docstring
# for the confirmed request/response shapes) - extend is async (job/poll,
# reuses the existing GET .../mureka/jobs/{job_id} route), stem is
# synchronous. Neither has a pricing.py catalog row, same "cost: unknown"
# convention as ordinary generation.

@router.post('/{project_id}/mureka/tracks/{track_id}/extend')
async def extend_mureka_track(project_id: str, track_id: str, body: dict = Body(default={})):
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')
    tracks = (project.get('mureka') or {}).get('tracks', [])
    track = next((t for t in tracks if t.get('track_id') == track_id), None)
    if track is None:
        raise HTTPException(404, 'Track not found')
    song_id = (track.get('raw') or {}).get('id')
    if not song_id:
        raise HTTPException(422, 'У этого трека нет song_id Mureka - продление недоступно')

    lyrics = (body.get('lyrics') or '').strip()
    if not lyrics:
        raise HTTPException(422, 'lyrics is required')
    extend_at = body.get('extend_at')
    if extend_at is None:
        extend_at = track.get('duration_ms') or 0
    model = body.get('model') or None
    extend_type = body.get('extend_type') or None

    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    usage_ctx = usage.context('mureka_extend', project_id, settings, model=model)
    job_id = mureka.start_extend_job(
        project_id, track_id, song_id, lyrics, extend_at, model, extend_type, settings, usage_ctx=usage_ctx,
    )
    return {'job_id': job_id}


@router.post('/{project_id}/mureka/tracks/{track_id}/stem')
async def stem_mureka_track(project_id: str, track_id: str, body: dict = Body(default={})):
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')
    tracks = (project.get('mureka') or {}).get('tracks', [])
    track = next((t for t in tracks if t.get('track_id') == track_id), None)
    if track is None:
        raise HTTPException(404, 'Track not found')

    file_path = storage.project_dir(project_id) / track['file_path']
    if not file_path.is_file():
        raise HTTPException(404, 'Audio file not found on disk')
    content = file_path.read_bytes()

    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    api_key = (settings.get('api_keys') or {}).get('mureka', '')
    model = body.get('model') or None
    stem_id = f'stem_{uuid4().hex[:8]}'
    dest_zip_path = storage.project_dir(project_id) / 'music' / f'{stem_id}.zip'
    usage_ctx = usage.context('mureka_stem', project_id, settings, model=model)
    try:
        result = await mureka.stem_track(content, model, api_key, dest_zip_path, usage_ctx=usage_ctx)
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc

    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')
        mureka_field = project.get('mureka') or {}
        tracks = mureka_field.get('tracks', [])
        for t in tracks:
            if t.get('track_id') == track_id:
                t['stems'] = [*t.get('stems', []), {
                    'id': stem_id, 'file_path': f'music/{stem_id}.zip', 'model': model,
                    'expires_at': result.get('expires_at'), 'created_at': _now(),
                }]
                break
        mureka_field['tracks'] = tracks
        project['mureka'] = mureka_field
        project['updated_at'] = _now()
        storage.save_project(project_id, project)
    return {'tracks': tracks}


# ---------- Song insight/utility calls (describe / transcribe / lyrics-video) ----------
# All three are synchronous, one-shot Mureka calls (no job/poll, same shape
# as /stem above) - see providers/mureka.py's module docstring for the
# confirmed request/response shapes. Each appends its result to the track's
# own array (descriptions/transcriptions/lyrics_videos) rather than
# replacing anything, so repeat calls build up a small history instead of
# losing the previous result.

@router.post('/{project_id}/mureka/tracks/{track_id}/describe')
async def describe_mureka_track(project_id: str, track_id: str):
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')
    tracks = (project.get('mureka') or {}).get('tracks', [])
    track = next((t for t in tracks if t.get('track_id') == track_id), None)
    if track is None:
        raise HTTPException(404, 'Track not found')

    file_path = storage.project_dir(project_id) / track['file_path']
    if not file_path.is_file():
        raise HTTPException(404, 'Audio file not found on disk')
    content = file_path.read_bytes()

    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    api_key = (settings.get('api_keys') or {}).get('mureka', '')
    usage_ctx = usage.context('mureka_describe', project_id, settings)
    try:
        result = await mureka.describe_song(content, api_key, usage_ctx=usage_ctx)
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc

    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')
        mureka_field = project.get('mureka') or {}
        tracks = mureka_field.get('tracks', [])
        for t in tracks:
            if t.get('track_id') == track_id:
                t['descriptions'] = [*t.get('descriptions', []), {
                    'id': f'desc_{uuid4().hex[:8]}',
                    'instrument': result.get('instrument') or [], 'genres': result.get('genres') or [],
                    'tags': result.get('tags') or [], 'description': result.get('description') or '',
                    'created_at': _now(),
                }]
                break
        mureka_field['tracks'] = tracks
        project['mureka'] = mureka_field
        project['updated_at'] = _now()
        storage.save_project(project_id, project)
    return {'tracks': tracks}


@router.post('/{project_id}/mureka/tracks/{track_id}/transcribe')
async def transcribe_mureka_track(project_id: str, track_id: str):
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')
    tracks = (project.get('mureka') or {}).get('tracks', [])
    track = next((t for t in tracks if t.get('track_id') == track_id), None)
    if track is None:
        raise HTTPException(404, 'Track not found')
    song_id = (track.get('raw') or {}).get('id')
    if not song_id:
        raise HTTPException(422, 'У этого трека нет song_id Mureka - расшифровка в ноты недоступна')

    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    api_key = (settings.get('api_keys') or {}).get('mureka', '')
    transcription_id = f'xscr_{uuid4().hex[:8]}'
    dest_zip_path = storage.project_dir(project_id) / 'music' / f'{transcription_id}.zip'
    usage_ctx = usage.context('mureka_transcribe', project_id, settings)
    try:
        result = await mureka.transcribe_song(song_id, api_key, dest_zip_path, usage_ctx=usage_ctx)
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc

    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')
        mureka_field = project.get('mureka') or {}
        tracks = mureka_field.get('tracks', [])
        for t in tracks:
            if t.get('track_id') == track_id:
                t['transcriptions'] = [*t.get('transcriptions', []), {
                    'id': transcription_id, 'file_path': f'music/{transcription_id}.zip',
                    'expires_at': result.get('expires_at'), 'created_at': _now(),
                }]
                break
        mureka_field['tracks'] = tracks
        project['mureka'] = mureka_field
        project['updated_at'] = _now()
        storage.save_project(project_id, project)
    return {'tracks': tracks}


@router.post('/{project_id}/mureka/tracks/{track_id}/lyrics-video')
async def lyrics_video_mureka_track(project_id: str, track_id: str, body: dict = Body(default={})):
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(404, 'Project not found')
    tracks = (project.get('mureka') or {}).get('tracks', [])
    track = next((t for t in tracks if t.get('track_id') == track_id), None)
    if track is None:
        raise HTTPException(404, 'Track not found')
    song_id = (track.get('raw') or {}).get('id')
    if not song_id:
        raise HTTPException(422, 'У этого трека нет song_id Mureka - видео с текстом недоступно')

    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    api_key = (settings.get('api_keys') or {}).get('mureka', '')
    title = (body.get('title') or project.get('title') or '').strip() or None
    aspect_ratio = body.get('aspect_ratio') or None
    video_id = f'lvid_{uuid4().hex[:8]}'
    dest_path = storage.project_dir(project_id) / 'music' / f'{video_id}.mp4'
    usage_ctx = usage.context('mureka_lyrics_video', project_id, settings)
    duration_ms = track.get('duration_ms')
    try:
        result = await mureka.generate_lyrics_video(
            song_id, title, aspect_ratio, api_key, dest_path,
            selection_start=0 if duration_ms else None, selection_end=duration_ms,
            usage_ctx=usage_ctx,
        )
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc

    async with storage.project_lock(project_id):
        project = storage.load_project(project_id)
        if project is None:
            raise HTTPException(404, 'Project not found')
        mureka_field = project.get('mureka') or {}
        tracks = mureka_field.get('tracks', [])
        for t in tracks:
            if t.get('track_id') == track_id:
                t['lyrics_videos'] = [*t.get('lyrics_videos', []), {
                    'id': video_id, 'file_path': f'music/{video_id}.mp4',
                    'title': title, 'aspect_ratio': aspect_ratio, 'created_at': _now(),
                }]
                break
        mureka_field['tracks'] = tracks
        project['mureka'] = mureka_field
        project['updated_at'] = _now()
        storage.save_project(project_id, project)
    return {'tracks': tracks}
