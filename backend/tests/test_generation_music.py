"""Routes in `app/routers/generation_music.py`: Suno prompt generation and
every Mureka route - track generate/poll, the reference-audio trimmer,
extend/stem, and describe/transcribe/lyrics-video."""

import os
import time
from pathlib import Path
from unittest.mock import AsyncMock

from app.providers import mureka

from tests.generation_fixtures import _FakeImagesAsyncClient, _FakeImagesResponse

# ---------- Mureka stage (real audio generation) ----------

def test_generate_mureka_requires_lyrics(client):
    pid = client.get('/api/projects').json()[0]['id']
    resp = client.post(f'/api/projects/{pid}/mureka/generate', json={'style': 's', 'lyrics': '  '})
    assert resp.status_code == 422


def test_generate_mureka_starts_job_and_forwards_fields(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    captured = {}

    def fake_start_job(slug, style, lyrics, model, n, gender, reference_id, settings, usage_ctx=None):
        captured.update(slug=slug, style=style, lyrics=lyrics, model=model, n=n, gender=gender, reference_id=reference_id)
        return 'job_1'

    monkeypatch.setattr(mureka, 'start_job', fake_start_job)

    resp = client.post(
        f'/api/projects/{pid}/mureka/generate',
        json={'style': 'synthwave', 'lyrics': 'la la la', 'model': 'mureka-8', 'n': 3, 'gender': 'female', 'reference_id': 'file_x'},
    )

    assert resp.status_code == 200
    assert resp.json() == {'job_id': 'job_1'}
    assert captured == {
        'slug': pid, 'style': 'synthwave', 'lyrics': 'la la la', 'model': 'mureka-8',
        'n': 3, 'gender': 'female', 'reference_id': 'file_x',
    }


def test_generate_mureka_missing_project_returns_404(client):
    resp = client.post('/api/projects/does-not-exist/mureka/generate', json={'lyrics': 'x'})
    assert resp.status_code == 404


def test_get_mureka_job_returns_status(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    track = {'track_id': 'trk_x', 'file_path': 'music/trk_x.mp3', 'rating': 0, 'is_selected': False, 'tag_ids': []}
    monkeypatch.setattr(mureka, 'get_job', lambda job_id: {'status': 'completed', 'tracks': [track], 'error': None})

    resp = client.get(f'/api/projects/{pid}/mureka/jobs/job_1')

    assert resp.status_code == 200
    assert resp.json() == {'status': 'completed', 'tracks': [track], 'error': None}


def test_get_mureka_job_missing_returns_404(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    monkeypatch.setattr(mureka, 'get_job', lambda job_id: None)

    resp = client.get(f'/api/projects/{pid}/mureka/jobs/does-not-exist')

    assert resp.status_code == 404


def test_generate_mureka_end_to_end_writes_file_and_persists(client, monkeypatch):
    """Exercises the real job pipeline (router -> mureka.start_job -> background
    task -> disk write -> project persistence) with only the Mureka HTTP calls
    mocked - see test_mureka_provider.py for request/response shape coverage."""
    pid = client.get('/api/projects').json()[0]['id']
    settings = client.get('/api/settings').json()
    settings['api_keys']['mureka'] = 'test-key'
    client.put('/api/settings', json=settings)

    async def _fast_sleep(*args, **kwargs):
        pass
    monkeypatch.setattr(mureka.asyncio, 'sleep', _fast_sleep)

    fake_client = _FakeImagesAsyncClient([
        _FakeImagesResponse(200, {'id': 'task_1', 'status': 'preparing'}),
        _FakeImagesResponse(200, {'status': 'succeeded', 'choices': [
            {'index': 0, 'id': 'c0', 'url': 'https://cdn.mureka.ai/c0.mp3', 'duration': 42000},
        ]}),
    ])
    monkeypatch.setattr(mureka.httpx, 'AsyncClient', lambda **kwargs: fake_client)
    monkeypatch.setattr(mureka, '_download', AsyncMock(return_value=b'MP3DATA'))

    resp = client.post(f'/api/projects/{pid}/mureka/generate', json={'style': 's', 'lyrics': 'la la', 'model': 'auto', 'n': 1})
    assert resp.status_code == 200
    job_id = resp.json()['job_id']

    deadline = time.monotonic() + 5.0
    job = None
    while time.monotonic() < deadline:
        job = client.get(f'/api/projects/{pid}/mureka/jobs/{job_id}').json()
        if job['status'] != 'pending':
            break
        time.sleep(0.05)
    assert job['status'] == 'completed'
    track = job['tracks'][0]
    assert track['file_path'].startswith('music/') and track['file_path'].endswith('.mp3')

    data_root = Path(os.environ['APP_DATA_DIR'])
    written = data_root / 'projects' / pid / track['file_path']
    assert written.is_file()
    assert written.read_bytes() == b'MP3DATA'

    saved = client.get(f'/api/projects/{pid}').json()
    assert saved['mureka']['tracks'][-1]['track_id'] == track['track_id']


def test_delete_mureka_track_removes_file_and_entry(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    project = client.get(f'/api/projects/{pid}').json()
    data_root = Path(os.environ['APP_DATA_DIR'])
    music_dir = data_root / 'projects' / pid / 'music'
    music_dir.mkdir(parents=True, exist_ok=True)
    (music_dir / 'trk_x.mp3').write_bytes(b'MP3DATA')
    project['mureka'] = {'reference_audio': [], 'tracks': [
        {'track_id': 'trk_x', 'file_path': 'music/trk_x.mp3', 'rating': 0, 'is_selected': False, 'tag_ids': []},
    ]}
    client.patch(f'/api/projects/{pid}', json=project)

    resp = client.delete(f'/api/projects/{pid}/mureka/tracks/trk_x')

    assert resp.status_code == 200
    assert resp.json()['tracks'] == []
    assert not (music_dir / 'trk_x.mp3').is_file()
    saved = client.get(f'/api/projects/{pid}').json()
    assert saved['mureka']['tracks'] == []


def test_delete_mureka_track_missing_returns_404(client):
    pid = client.get('/api/projects').json()[0]['id']
    assert client.delete(f'/api/projects/{pid}/mureka/tracks/does-not-exist').status_code == 404


def test_upload_mureka_reference_audio_writes_file_and_appends(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    monkeypatch.setattr(
        mureka, 'upload_reference_audio',
        AsyncMock(return_value={'id': 'mureka_file_1', 'filename': 'ref.mp3'}),
    )

    resp = client.post(
        f'/api/projects/{pid}/mureka/reference-audio',
        files={'file': ('ref.mp3', b'fake-mp3-bytes', 'audio/mpeg')},
    )

    assert resp.status_code == 200
    refs = resp.json()['reference_audio']
    assert len(refs) == 1
    assert refs[0]['mureka_file_id'] == 'mureka_file_1'
    assert refs[0]['file_path'].startswith('music/references/ref_') and refs[0]['file_path'].endswith('.mp3')

    data_root = Path(os.environ['APP_DATA_DIR'])
    written = data_root / 'projects' / pid / refs[0]['file_path']
    assert written.is_file()
    assert written.read_bytes() == b'fake-mp3-bytes'

    saved = client.get(f'/api/projects/{pid}').json()
    assert saved['mureka']['reference_audio'] == refs


def test_upload_mureka_reference_audio_rejects_bad_extension(client):
    pid = client.get('/api/projects').json()[0]['id']
    resp = client.post(
        f'/api/projects/{pid}/mureka/reference-audio',
        files={'file': ('notes.txt', b'hello', 'text/plain')},
    )
    assert resp.status_code == 415


def test_upload_mureka_reference_audio_provider_failure_returns_502(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    monkeypatch.setattr(
        mureka, 'upload_reference_audio',
        AsyncMock(side_effect=RuntimeError('Mureka API вернул 500')),
    )

    resp = client.post(
        f'/api/projects/{pid}/mureka/reference-audio',
        files={'file': ('ref.mp3', b'fake-mp3-bytes', 'audio/mpeg')},
    )

    assert resp.status_code == 502


def test_delete_mureka_reference_audio_removes_file_and_entry(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    monkeypatch.setattr(
        mureka, 'upload_reference_audio',
        AsyncMock(return_value={'id': 'mureka_file_1', 'filename': 'ref.mp3'}),
    )
    upload = client.post(
        f'/api/projects/{pid}/mureka/reference-audio',
        files={'file': ('ref.mp3', b'fake-mp3-bytes', 'audio/mpeg')},
    )
    ref_id = upload.json()['reference_audio'][0]['id']
    file_path = upload.json()['reference_audio'][0]['file_path']
    data_root = Path(os.environ['APP_DATA_DIR'])
    written = data_root / 'projects' / pid / file_path
    assert written.is_file()

    resp = client.delete(f'/api/projects/{pid}/mureka/reference-audio/{ref_id}')

    assert resp.status_code == 200
    assert resp.json()['reference_audio'] == []
    assert not written.is_file()


def test_delete_mureka_reference_audio_missing_returns_404(client):
    pid = client.get('/api/projects').json()[0]['id']
    assert client.delete(f'/api/projects/{pid}/mureka/reference-audio/does-not-exist').status_code == 404


# ---------- Reference-audio trimmer (upload source -> trim -> reference_audio) ----------

def test_upload_mureka_reference_source_writes_file_and_appends(client):
    pid = client.get('/api/projects').json()[0]['id']
    resp = client.post(
        f'/api/projects/{pid}/mureka/reference-sources',
        files={'file': ('long-song.mp3', b'raw-audio-bytes', 'audio/mpeg')},
    )
    assert resp.status_code == 200
    sources = resp.json()['reference_sources']
    assert len(sources) == 1
    assert sources[0]['filename'] == 'long-song.mp3'

    data_root = Path(os.environ['APP_DATA_DIR'])
    written = data_root / 'projects' / pid / sources[0]['file_path']
    assert written.read_bytes() == b'raw-audio-bytes'


def test_upload_mureka_reference_source_rejects_bad_extension(client):
    pid = client.get('/api/projects').json()[0]['id']
    resp = client.post(
        f'/api/projects/{pid}/mureka/reference-sources',
        files={'file': ('notes.txt', b'hello', 'text/plain')},
    )
    assert resp.status_code == 415


def test_delete_mureka_reference_source_removes_file_and_entry(client):
    pid = client.get('/api/projects').json()[0]['id']
    upload = client.post(
        f'/api/projects/{pid}/mureka/reference-sources',
        files={'file': ('song.mp3', b'raw-bytes', 'audio/mpeg')},
    )
    source = upload.json()['reference_sources'][0]
    data_root = Path(os.environ['APP_DATA_DIR'])
    written = data_root / 'projects' / pid / source['file_path']
    assert written.is_file()

    resp = client.delete(f'/api/projects/{pid}/mureka/reference-sources/{source["id"]}')

    assert resp.status_code == 200
    assert resp.json()['reference_sources'] == []
    assert not written.is_file()


def test_trim_mureka_reference_source_requires_valid_range(client):
    pid = client.get('/api/projects').json()[0]['id']
    upload = client.post(
        f'/api/projects/{pid}/mureka/reference-sources',
        files={'file': ('song.mp3', b'raw-bytes', 'audio/mpeg')},
    )
    source_id = upload.json()['reference_sources'][0]['id']

    resp = client.post(f'/api/projects/{pid}/mureka/reference-sources/{source_id}/trim', json={'start_ms': 5000, 'end_ms': 5000})
    assert resp.status_code == 422


def test_trim_mureka_reference_source_missing_returns_404(client):
    pid = client.get('/api/projects').json()[0]['id']
    resp = client.post(f'/api/projects/{pid}/mureka/reference-sources/does-not-exist/trim', json={'start_ms': 0, 'end_ms': 30000})
    assert resp.status_code == 404


def test_trim_mureka_reference_source_success_calls_ffmpeg_then_upload(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    upload = client.post(
        f'/api/projects/{pid}/mureka/reference-sources',
        files={'file': ('song.mp3', b'raw-bytes', 'audio/mpeg')},
    )
    source_id = upload.json()['reference_sources'][0]['id']

    async def fake_trim_audio(src_path, start_ms, end_ms, dest_path):
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        dest_path.write_bytes(b'trimmed-mp3-bytes')

    monkeypatch.setattr(mureka, 'trim_audio', fake_trim_audio)
    monkeypatch.setattr(
        mureka, 'upload_reference_audio',
        AsyncMock(return_value={'id': 'mureka_file_trimmed'}),
    )

    resp = client.post(
        f'/api/projects/{pid}/mureka/reference-sources/{source_id}/trim',
        json={'start_ms': 0, 'end_ms': 30000},
    )

    assert resp.status_code == 200
    refs = resp.json()['reference_audio']
    assert len(refs) == 1
    assert refs[0]['mureka_file_id'] == 'mureka_file_trimmed'
    assert refs[0]['source_id'] == source_id
    assert refs[0]['start_ms'] == 0
    assert refs[0]['end_ms'] == 30000

    data_root = Path(os.environ['APP_DATA_DIR'])
    written = data_root / 'projects' / pid / refs[0]['file_path']
    assert written.read_bytes() == b'trimmed-mp3-bytes'

    # The source itself is never deleted by a successful trim - it stays
    # available so the same upload can be trimmed into another window later.
    project = client.get(f'/api/projects/{pid}').json()
    assert any(s['id'] == source_id for s in project['mureka']['reference_sources'])


def test_trim_mureka_reference_source_twice_keeps_source_and_appends_second_clip(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    upload = client.post(
        f'/api/projects/{pid}/mureka/reference-sources',
        files={'file': ('song.mp3', b'raw-bytes', 'audio/mpeg')},
    )
    source_id = upload.json()['reference_sources'][0]['id']

    async def fake_trim_audio(src_path, start_ms, end_ms, dest_path):
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        dest_path.write_bytes(f'trimmed-{start_ms}-{end_ms}'.encode())

    monkeypatch.setattr(mureka, 'trim_audio', fake_trim_audio)
    monkeypatch.setattr(
        mureka, 'upload_reference_audio',
        AsyncMock(side_effect=[{'id': 'mureka_file_1'}, {'id': 'mureka_file_2'}]),
    )

    first = client.post(
        f'/api/projects/{pid}/mureka/reference-sources/{source_id}/trim',
        json={'start_ms': 0, 'end_ms': 30000},
    )
    second = client.post(
        f'/api/projects/{pid}/mureka/reference-sources/{source_id}/trim',
        json={'start_ms': 10000, 'end_ms': 45000},
    )

    assert first.status_code == 200 and second.status_code == 200
    refs = second.json()['reference_audio']
    assert len(refs) == 2
    assert [r['source_id'] for r in refs] == [source_id, source_id]
    assert [r['start_ms'] for r in refs] == [0, 10000]
    assert [r['end_ms'] for r in refs] == [30000, 45000]

    project = client.get(f'/api/projects/{pid}').json()
    assert any(s['id'] == source_id for s in project['mureka']['reference_sources'])


def test_trim_mureka_reference_source_ffmpeg_failure_returns_502(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    upload = client.post(
        f'/api/projects/{pid}/mureka/reference-sources',
        files={'file': ('song.mp3', b'raw-bytes', 'audio/mpeg')},
    )
    source_id = upload.json()['reference_sources'][0]['id']

    async def fake_trim_audio(*args, **kwargs):
        raise RuntimeError('ffmpeg не найден в PATH')

    monkeypatch.setattr(mureka, 'trim_audio', fake_trim_audio)

    resp = client.post(
        f'/api/projects/{pid}/mureka/reference-sources/{source_id}/trim',
        json={'start_ms': 0, 'end_ms': 30000},
    )
    assert resp.status_code == 502


# ---------- Extend / stem track operations ----------

def test_extend_mureka_track_requires_lyrics(client):
    pid = client.get('/api/projects').json()[0]['id']
    project = client.get(f'/api/projects/{pid}').json()
    project['mureka'] = {'reference_audio': [], 'tracks': [
        {'track_id': 'trk_x', 'file_path': 'music/trk_x.mp3', 'duration_ms': 30000, 'raw': {'id': 'song_1'}},
    ]}
    client.patch(f'/api/projects/{pid}', json=project)

    resp = client.post(f'/api/projects/{pid}/mureka/tracks/trk_x/extend', json={'lyrics': '  '})
    assert resp.status_code == 422


def test_extend_mureka_track_requires_song_id(client):
    pid = client.get('/api/projects').json()[0]['id']
    project = client.get(f'/api/projects/{pid}').json()
    project['mureka'] = {'reference_audio': [], 'tracks': [
        {'track_id': 'trk_x', 'file_path': 'music/trk_x.mp3', 'duration_ms': 30000, 'raw': {}},
    ]}
    client.patch(f'/api/projects/{pid}', json=project)

    resp = client.post(f'/api/projects/{pid}/mureka/tracks/trk_x/extend', json={'lyrics': 'more'})
    assert resp.status_code == 422


def test_extend_mureka_track_starts_job_defaulting_extend_at_to_duration(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    project = client.get(f'/api/projects/{pid}').json()
    project['mureka'] = {'reference_audio': [], 'tracks': [
        {'track_id': 'trk_x', 'file_path': 'music/trk_x.mp3', 'duration_ms': 45000, 'raw': {'id': 'song_1'}},
    ]}
    client.patch(f'/api/projects/{pid}', json=project)

    captured = {}

    def fake_start_extend_job(slug, source_track_id, song_id, lyrics, extend_at, model, extend_type, settings, usage_ctx=None):
        captured.update(slug=slug, source_track_id=source_track_id, song_id=song_id, lyrics=lyrics, extend_at=extend_at)
        return 'job_ext_1'

    monkeypatch.setattr(mureka, 'start_extend_job', fake_start_extend_job)

    resp = client.post(f'/api/projects/{pid}/mureka/tracks/trk_x/extend', json={'lyrics': 'continuation'})

    assert resp.status_code == 200
    assert resp.json() == {'job_id': 'job_ext_1'}
    assert captured == {
        'slug': pid, 'source_track_id': 'trk_x', 'song_id': 'song_1', 'lyrics': 'continuation', 'extend_at': 45000,
    }


def test_extend_mureka_track_missing_track_returns_404(client):
    pid = client.get('/api/projects').json()[0]['id']
    resp = client.post(f'/api/projects/{pid}/mureka/tracks/does-not-exist/extend', json={'lyrics': 'x'})
    assert resp.status_code == 404


def test_stem_mureka_track_success_appends_stem_entry(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    project = client.get(f'/api/projects/{pid}').json()
    data_root = Path(os.environ['APP_DATA_DIR'])
    music_dir = data_root / 'projects' / pid / 'music'
    music_dir.mkdir(parents=True, exist_ok=True)
    (music_dir / 'trk_x.mp3').write_bytes(b'fake-mp3')
    project['mureka'] = {'reference_audio': [], 'tracks': [
        {'track_id': 'trk_x', 'file_path': 'music/trk_x.mp3', 'duration_ms': 30000, 'raw': {}, 'stems': []},
    ]}
    client.patch(f'/api/projects/{pid}', json=project)

    async def fake_stem_track(content, model, api_key, dest_zip_path, usage_ctx=None):
        dest_zip_path.parent.mkdir(parents=True, exist_ok=True)
        dest_zip_path.write_bytes(b'zip-bytes')
        return {'zip_url': 'https://cdn.mureka.ai/x.zip', 'expires_at': 999}

    monkeypatch.setattr(mureka, 'stem_track', fake_stem_track)

    resp = client.post(f'/api/projects/{pid}/mureka/tracks/trk_x/stem', json={'model': 'audio-separation-1'})

    assert resp.status_code == 200
    tracks = resp.json()['tracks']
    assert len(tracks[0]['stems']) == 1
    assert tracks[0]['stems'][0]['model'] == 'audio-separation-1'
    written = data_root / 'projects' / pid / tracks[0]['stems'][0]['file_path']
    assert written.read_bytes() == b'zip-bytes'


def test_stem_mureka_track_provider_failure_returns_502(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    project = client.get(f'/api/projects/{pid}').json()
    data_root = Path(os.environ['APP_DATA_DIR'])
    music_dir = data_root / 'projects' / pid / 'music'
    music_dir.mkdir(parents=True, exist_ok=True)
    (music_dir / 'trk_x.mp3').write_bytes(b'fake-mp3')
    project['mureka'] = {'reference_audio': [], 'tracks': [
        {'track_id': 'trk_x', 'file_path': 'music/trk_x.mp3', 'duration_ms': 30000, 'raw': {}},
    ]}
    client.patch(f'/api/projects/{pid}', json=project)

    monkeypatch.setattr(mureka, 'stem_track', AsyncMock(side_effect=RuntimeError('boom')))

    resp = client.post(f'/api/projects/{pid}/mureka/tracks/trk_x/stem', json={})
    assert resp.status_code == 502


def test_stem_mureka_track_missing_audio_file_returns_404(client):
    pid = client.get('/api/projects').json()[0]['id']
    project = client.get(f'/api/projects/{pid}').json()
    project['mureka'] = {'reference_audio': [], 'tracks': [
        {'track_id': 'trk_x', 'file_path': 'music/does-not-exist.mp3', 'duration_ms': 30000, 'raw': {}},
    ]}
    client.patch(f'/api/projects/{pid}', json=project)

    resp = client.post(f'/api/projects/{pid}/mureka/tracks/trk_x/stem', json={})
    assert resp.status_code == 404


# ---------- describe / transcribe / lyrics-video track operations ----------

def test_describe_mureka_track_success_appends_description(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    project = client.get(f'/api/projects/{pid}').json()
    data_root = Path(os.environ['APP_DATA_DIR'])
    music_dir = data_root / 'projects' / pid / 'music'
    music_dir.mkdir(parents=True, exist_ok=True)
    (music_dir / 'trk_x.mp3').write_bytes(b'fake-mp3')
    project['mureka'] = {'reference_audio': [], 'tracks': [
        {'track_id': 'trk_x', 'file_path': 'music/trk_x.mp3', 'duration_ms': 30000, 'raw': {}},
    ]}
    client.patch(f'/api/projects/{pid}', json=project)

    async def fake_describe_song(content, api_key, usage_ctx=None):
        return {'instrument': ['piano'], 'genres': ['ballad'], 'tags': ['sad'], 'description': 'A sad piano ballad.'}

    monkeypatch.setattr(mureka, 'describe_song', fake_describe_song)

    resp = client.post(f'/api/projects/{pid}/mureka/tracks/trk_x/describe')

    assert resp.status_code == 200
    descriptions = resp.json()['tracks'][0]['descriptions']
    assert len(descriptions) == 1
    assert descriptions[0]['genres'] == ['ballad']
    assert descriptions[0]['description'] == 'A sad piano ballad.'


def test_describe_mureka_track_provider_failure_returns_502(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    project = client.get(f'/api/projects/{pid}').json()
    data_root = Path(os.environ['APP_DATA_DIR'])
    music_dir = data_root / 'projects' / pid / 'music'
    music_dir.mkdir(parents=True, exist_ok=True)
    (music_dir / 'trk_x.mp3').write_bytes(b'fake-mp3')
    project['mureka'] = {'reference_audio': [], 'tracks': [
        {'track_id': 'trk_x', 'file_path': 'music/trk_x.mp3', 'duration_ms': 30000, 'raw': {}},
    ]}
    client.patch(f'/api/projects/{pid}', json=project)

    monkeypatch.setattr(mureka, 'describe_song', AsyncMock(side_effect=RuntimeError('boom')))

    resp = client.post(f'/api/projects/{pid}/mureka/tracks/trk_x/describe')
    assert resp.status_code == 502


def test_describe_mureka_track_missing_audio_file_returns_404(client):
    pid = client.get('/api/projects').json()[0]['id']
    project = client.get(f'/api/projects/{pid}').json()
    project['mureka'] = {'reference_audio': [], 'tracks': [
        {'track_id': 'trk_x', 'file_path': 'music/does-not-exist.mp3', 'duration_ms': 30000, 'raw': {}},
    ]}
    client.patch(f'/api/projects/{pid}', json=project)

    resp = client.post(f'/api/projects/{pid}/mureka/tracks/trk_x/describe')
    assert resp.status_code == 404


def test_transcribe_mureka_track_success_appends_transcription(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    project = client.get(f'/api/projects/{pid}').json()
    project['mureka'] = {'reference_audio': [], 'tracks': [
        {'track_id': 'trk_x', 'file_path': 'music/trk_x.mp3', 'duration_ms': 30000, 'raw': {'id': 'song_1'}},
    ]}
    client.patch(f'/api/projects/{pid}', json=project)

    async def fake_transcribe_song(song_id, api_key, dest_zip_path, usage_ctx=None):
        assert song_id == 'song_1'
        dest_zip_path.parent.mkdir(parents=True, exist_ok=True)
        dest_zip_path.write_bytes(b'notes-zip')
        return {'zip_url': 'https://cdn.mureka.ai/notes.zip', 'expires_at': 999}

    monkeypatch.setattr(mureka, 'transcribe_song', fake_transcribe_song)

    resp = client.post(f'/api/projects/{pid}/mureka/tracks/trk_x/transcribe')

    assert resp.status_code == 200
    transcriptions = resp.json()['tracks'][0]['transcriptions']
    assert len(transcriptions) == 1
    assert transcriptions[0]['expires_at'] == 999
    data_root = Path(os.environ['APP_DATA_DIR'])
    written = data_root / 'projects' / pid / transcriptions[0]['file_path']
    assert written.read_bytes() == b'notes-zip'


def test_transcribe_mureka_track_requires_song_id(client):
    pid = client.get('/api/projects').json()[0]['id']
    project = client.get(f'/api/projects/{pid}').json()
    project['mureka'] = {'reference_audio': [], 'tracks': [
        {'track_id': 'trk_x', 'file_path': 'music/trk_x.mp3', 'duration_ms': 30000, 'raw': {}},
    ]}
    client.patch(f'/api/projects/{pid}', json=project)

    resp = client.post(f'/api/projects/{pid}/mureka/tracks/trk_x/transcribe')
    assert resp.status_code == 422


def test_transcribe_mureka_track_provider_failure_returns_502(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    project = client.get(f'/api/projects/{pid}').json()
    project['mureka'] = {'reference_audio': [], 'tracks': [
        {'track_id': 'trk_x', 'file_path': 'music/trk_x.mp3', 'duration_ms': 30000, 'raw': {'id': 'song_1'}},
    ]}
    client.patch(f'/api/projects/{pid}', json=project)

    monkeypatch.setattr(mureka, 'transcribe_song', AsyncMock(side_effect=RuntimeError('boom')))

    resp = client.post(f'/api/projects/{pid}/mureka/tracks/trk_x/transcribe')
    assert resp.status_code == 502


def test_lyrics_video_mureka_track_success_appends_video(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    project = client.get(f'/api/projects/{pid}').json()
    project['mureka'] = {'reference_audio': [], 'tracks': [
        {'track_id': 'trk_x', 'file_path': 'music/trk_x.mp3', 'duration_ms': 30000, 'raw': {'id': 'song_1'}},
    ]}
    client.patch(f'/api/projects/{pid}', json=project)

    async def fake_generate_lyrics_video(
        song_id, title, aspect_ratio, api_key, dest_path, selection_start=None, selection_end=None, usage_ctx=None,
    ):
        assert song_id == 'song_1'
        assert aspect_ratio == '16:9'
        assert (selection_start, selection_end) == (0, 30000)
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        dest_path.write_bytes(b'mp4-bytes')
        return {'url': 'https://cdn.mureka.ai/lyrics.mp4'}

    monkeypatch.setattr(mureka, 'generate_lyrics_video', fake_generate_lyrics_video)

    resp = client.post(
        f'/api/projects/{pid}/mureka/tracks/trk_x/lyrics-video', json={'aspect_ratio': '16:9'},
    )

    assert resp.status_code == 200
    videos = resp.json()['tracks'][0]['lyrics_videos']
    assert len(videos) == 1
    assert videos[0]['aspect_ratio'] == '16:9'
    data_root = Path(os.environ['APP_DATA_DIR'])
    written = data_root / 'projects' / pid / videos[0]['file_path']
    assert written.read_bytes() == b'mp4-bytes'


def test_lyrics_video_mureka_track_requires_song_id(client):
    pid = client.get('/api/projects').json()[0]['id']
    project = client.get(f'/api/projects/{pid}').json()
    project['mureka'] = {'reference_audio': [], 'tracks': [
        {'track_id': 'trk_x', 'file_path': 'music/trk_x.mp3', 'duration_ms': 30000, 'raw': {}},
    ]}
    client.patch(f'/api/projects/{pid}', json=project)

    resp = client.post(f'/api/projects/{pid}/mureka/tracks/trk_x/lyrics-video', json={})
    assert resp.status_code == 422


def test_lyrics_video_mureka_track_provider_failure_returns_502(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    project = client.get(f'/api/projects/{pid}').json()
    project['mureka'] = {'reference_audio': [], 'tracks': [
        {'track_id': 'trk_x', 'file_path': 'music/trk_x.mp3', 'duration_ms': 30000, 'raw': {'id': 'song_1'}},
    ]}
    client.patch(f'/api/projects/{pid}', json=project)

    monkeypatch.setattr(mureka, 'generate_lyrics_video', AsyncMock(side_effect=RuntimeError('boom')))

    resp = client.post(f'/api/projects/{pid}/mureka/tracks/trk_x/lyrics-video', json={})
    assert resp.status_code == 502
