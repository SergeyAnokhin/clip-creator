import asyncio
import shutil

import pytest

from app.providers import mureka


class _FakeResponse:
    def __init__(self, status_code, payload=None, text='', content=b''):
        self.status_code = status_code
        self._payload = payload
        self.text = text
        self.content = content

    def json(self):
        return self._payload


class _FakeAsyncClient:
    """Same fake instance is returned by every `httpx.AsyncClient(...)` call
    site the code under test opens, so its `_responses` queue is popped in
    call order across submit/poll/download - mirrors
    test_images_provider.py's fake client."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def _next(self, method, url, **kwargs):
        self.calls.append({'method': method, 'url': url, **kwargs})
        return self._responses.pop(0)

    async def post(self, url, headers=None, json=None, files=None, data=None):
        return await self._next('POST', url, headers=headers, json=json, files=files, data=data)

    async def get(self, url, headers=None):
        return await self._next('GET', url, headers=headers)


_real_sleep = asyncio.sleep


class _FastSleep:
    """Real (0-delay) sleep so the poll loop still yields to the event loop
    without tests waiting out `_POLL_INTERVAL` - see
    test_images_provider.py's identical fixture."""

    async def __call__(self, *args, **kwargs):
        await _real_sleep(0)


@pytest.fixture(autouse=True)
def _no_real_sleep(monkeypatch):
    monkeypatch.setattr(mureka.asyncio, 'sleep', _FastSleep())


def _install(monkeypatch, responses):
    fake_client = _FakeAsyncClient(responses)
    monkeypatch.setattr(mureka.httpx, 'AsyncClient', lambda **kwargs: fake_client)
    return fake_client


# ---------- upload_reference_audio ----------

def test_upload_reference_audio_success(monkeypatch):
    fake_client = _install(monkeypatch, [
        _FakeResponse(200, {'id': 'file_123', 'bytes': 9, 'created_at': 1, 'filename': 'ref.mp3', 'purpose': 'reference'}),
    ])

    result = asyncio.run(mureka.upload_reference_audio(b'audiodata', 'ref.mp3', 'test-key'))

    assert result['id'] == 'file_123'
    call = fake_client.calls[0]
    assert call['url'] == 'https://api.mureka.ai/v1/files/upload'
    assert call['headers'] == {'Authorization': 'Bearer test-key'}
    assert call['files'] == {'file': ('ref.mp3', b'audiodata')}
    assert call['data'] == {'purpose': 'reference'}


def test_upload_reference_audio_missing_key_raises():
    with pytest.raises(RuntimeError, match='Mureka'):
        asyncio.run(mureka.upload_reference_audio(b'x', 'ref.mp3', ''))


def test_upload_reference_audio_error_status_raises(monkeypatch):
    _install(monkeypatch, [_FakeResponse(500, text='boom')])
    with pytest.raises(RuntimeError, match='500'):
        asyncio.run(mureka.upload_reference_audio(b'x', 'ref.mp3', 'key'))


# ---------- _submit ----------

def test_submit_builds_minimal_body(monkeypatch):
    fake_client = _install(monkeypatch, [_FakeResponse(200, {'id': 't1', 'status': 'preparing'})])

    data, debug_request = asyncio.run(mureka._submit('a style', 'some lyrics', 'auto', 2, None, None, 'test-key'))

    assert data == {'id': 't1', 'status': 'preparing'}
    assert debug_request['url'] == 'https://api.mureka.ai/v1/song/generate'
    call = fake_client.calls[0]
    assert call['json'] == {'lyrics': 'some lyrics', 'model': 'auto', 'n': 2, 'prompt': 'a style'}
    assert call['headers']['Authorization'] == 'Bearer test-key'


def test_submit_includes_gender_and_reference_id_when_given(monkeypatch):
    fake_client = _install(monkeypatch, [_FakeResponse(200, {'id': 't1', 'status': 'preparing'})])

    asyncio.run(mureka._submit('style', 'lyrics', 'mureka-8', 1, 'female', 'file_abc', 'test-key'))

    assert fake_client.calls[0]['json'] == {
        'lyrics': 'lyrics', 'model': 'mureka-8', 'n': 1, 'prompt': 'style',
        'gender': 'female', 'reference_id': 'file_abc',
    }


def test_submit_missing_key_raises():
    with pytest.raises(RuntimeError, match='Mureka'):
        asyncio.run(mureka._submit('s', 'l', 'auto', 1, None, None, ''))


def test_submit_error_status_raises(monkeypatch):
    _install(monkeypatch, [_FakeResponse(400, text='bad request')])
    with pytest.raises(RuntimeError, match='400'):
        asyncio.run(mureka._submit('s', 'l', 'auto', 1, None, None, 'key'))


# ---------- _poll ----------

def test_poll_returns_on_terminal_status(monkeypatch):
    _install(monkeypatch, [
        _FakeResponse(200, {'status': 'preparing'}),
        _FakeResponse(200, {'status': 'running'}),
        _FakeResponse(200, {'status': 'succeeded', 'choices': []}),
    ])

    data = asyncio.run(mureka._poll('t1', 'key'))

    assert data['status'] == 'succeeded'


def test_poll_error_status_raises(monkeypatch):
    _install(monkeypatch, [_FakeResponse(500, text='boom')])
    with pytest.raises(RuntimeError, match='500'):
        asyncio.run(mureka._poll('t1', 'key'))


# ---------- start_job / _run_job (end-to-end) ----------

async def _wait_for_terminal(job_id, attempts=500):
    for _ in range(attempts):
        job = mureka.get_job(job_id)
        if job['status'] != 'pending':
            return job
        await asyncio.sleep(0)
    raise AssertionError('job did not resolve')


def test_start_job_success_writes_tracks_and_persists_project(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_DATA_DIR', str(tmp_path))
    from app import storage

    storage.save_project('poem-a', {'id': 'poem-a'})

    _install(monkeypatch, [
        _FakeResponse(200, {'id': 'task_1', 'status': 'preparing'}),
        _FakeResponse(200, {
            'status': 'succeeded', 'finished_at': 123,
            'choices': [
                {'index': 0, 'id': 'c0', 'url': 'https://cdn.mureka.ai/c0.mp3', 'duration': 45000},
                {'index': 1, 'id': 'c1', 'url': 'https://cdn.mureka.ai/c1.mp3', 'duration': 47000},
            ],
        }),
        _FakeResponse(200, content=b'MP3DATA0'),
        _FakeResponse(200, content=b'MP3DATA1'),
    ])

    async def scenario():
        job_id = mureka.start_job(
            'poem-a', 'a style', 'some lyrics', 'auto', 2, None, None, {'api_keys': {'mureka': 'k'}},
        )
        return await _wait_for_terminal(job_id)

    job = asyncio.run(scenario())

    assert job['status'] == 'completed'
    assert len(job['tracks']) == 2
    assert job['tracks'][0]['file_path'] == f'music/{job["tracks"][0]["track_id"]}.mp3'

    project = storage.load_project('poem-a')
    assert len(project['mureka']['tracks']) == 2
    for track, expected_bytes in zip(project['mureka']['tracks'], [b'MP3DATA0', b'MP3DATA1']):
        written = storage.project_dir('poem-a') / track['file_path']
        assert written.read_bytes() == expected_bytes
        assert track['rating'] == 0
        assert track['is_selected'] is False
        assert track['tag_ids'] == []
        assert track['style'] == 'a style'
        assert track['lyrics'] == 'some lyrics'
        assert track['reference_used'] is None
        assert track['request'] == {'url': 'https://api.mureka.ai/v1/song/generate', 'body': {'lyrics': 'some lyrics', 'model': 'auto', 'n': 2, 'prompt': 'a style'}}


def test_start_job_with_reference_id_records_reference_used(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_DATA_DIR', str(tmp_path))
    from app import storage

    storage.save_project('poem-a', {'id': 'poem-a', 'mureka': {
        'tracks': [],
        'reference_audio': [{
            'id': 'mref_1', 'mureka_file_id': 'file_abc', 'file_path': 'music/references/ref_1.mp3',
            'filename': 'song.mp3', 'uploaded_at': 't', 'source_id': 'msrc_1', 'start_ms': 1000, 'end_ms': 31000,
        }],
    }})

    _install(monkeypatch, [
        _FakeResponse(200, {'id': 'task_1', 'status': 'preparing'}),
        _FakeResponse(200, {
            'status': 'succeeded',
            'choices': [{'index': 0, 'id': 'c0', 'url': 'https://cdn.mureka.ai/c0.mp3', 'duration': 45000}],
        }),
        _FakeResponse(200, content=b'MP3DATA0'),
    ])

    async def scenario():
        job_id = mureka.start_job(
            'poem-a', 'a style', 'some lyrics', 'auto', 1, None, 'file_abc', {'api_keys': {'mureka': 'k'}},
        )
        return await _wait_for_terminal(job_id)

    job = asyncio.run(scenario())

    assert job['status'] == 'completed'
    assert job['tracks'][0]['reference_used'] == {
        'source_id': 'msrc_1', 'filename': 'song.mp3', 'start_ms': 1000, 'end_ms': 31000,
    }

    project = storage.load_project('poem-a')
    assert project['mureka']['tracks'][0]['reference_used']['source_id'] == 'msrc_1'


def test_start_job_missing_key_fails_job(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_DATA_DIR', str(tmp_path))

    async def scenario():
        job_id = mureka.start_job('poem-a', 's', 'l', 'auto', 1, None, None, {'api_keys': {}})
        return await _wait_for_terminal(job_id)

    job = asyncio.run(scenario())
    assert job['status'] == 'failed'
    assert 'Mureka' in job['error']


def test_start_job_failed_status_fails_job(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_DATA_DIR', str(tmp_path))
    _install(monkeypatch, [
        _FakeResponse(200, {'id': 'task_1', 'status': 'preparing'}),
        _FakeResponse(200, {'status': 'failed', 'failed_reason': 'lyrics rejected'}),
    ])

    async def scenario():
        job_id = mureka.start_job('poem-a', 's', 'l', 'auto', 1, None, None, {'api_keys': {'mureka': 'k'}})
        return await _wait_for_terminal(job_id)

    job = asyncio.run(scenario())
    assert job['status'] == 'failed'
    assert 'lyrics rejected' in job['error']


def test_start_job_clamps_n_to_valid_range(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_DATA_DIR', str(tmp_path))
    from app import storage
    storage.save_project('poem-a', {'id': 'poem-a'})

    fake_client = _install(monkeypatch, [
        _FakeResponse(200, {'id': 'task_1', 'status': 'preparing'}),
        _FakeResponse(200, {'status': 'succeeded', 'choices': []}),
    ])

    async def scenario():
        job_id = mureka.start_job('poem-a', 's', 'l', 'auto', 99, None, None, {'api_keys': {'mureka': 'k'}})
        return await _wait_for_terminal(job_id)

    job = asyncio.run(scenario())
    assert job['status'] == 'failed'  # no choices -> nothing downloaded
    assert fake_client.calls[0]['json']['n'] == 3


def test_get_job_unknown_id_returns_none():
    assert mureka.get_job('does-not-exist') is None


@pytest.fixture
def usage_ledger(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_DATA_DIR', str(tmp_path))
    from app import usage as usage_module
    return usage_module


def test_start_job_records_usage_row_with_unknown_cost(monkeypatch, usage_ledger):
    from app import storage
    storage.save_project('poem-b', {'id': 'poem-b'})

    _install(monkeypatch, [
        _FakeResponse(200, {'id': 'task_2', 'status': 'preparing'}),
        _FakeResponse(200, {'status': 'succeeded', 'choices': [
            {'index': 0, 'id': 'c0', 'url': 'https://cdn.mureka.ai/c0.mp3', 'duration': 30000},
        ]}),
        _FakeResponse(200, content=b'MP3DATA'),
    ])

    async def scenario():
        ctx = usage_ledger.context('mureka_generate', 'poem-b', {}, model='auto', n=1)
        job_id = mureka.start_job('poem-b', 's', 'l', 'auto', 1, None, None, {'api_keys': {'mureka': 'k'}}, usage_ctx=ctx)
        return await _wait_for_terminal(job_id)

    job = asyncio.run(scenario())
    assert job['status'] == 'completed'

    records = usage_ledger.query()['records']
    assert len(records) == 1
    rec = records[0]
    assert rec['task'] == 'mureka_generate'
    assert rec['model'] == 'mureka:auto'
    assert rec['status'] == 'ok'
    assert rec['units']['tracks'] == 1
    # No pricing.py catalog row for Mureka - cost must stay unknown (None), never 0.
    assert rec['cost']['amount'] is None


# ---------- _extract_error_message ----------

def test_extract_error_message_reads_mureka_error_shape():
    resp = _FakeResponse(400, {'error': {'message': 'Invalid Request, The audio duration should be at least 30 seconds.'}})
    assert mureka._extract_error_message(resp) == 'Invalid Request, The audio duration should be at least 30 seconds.'


def test_extract_error_message_falls_back_on_non_json_body():
    resp = _FakeResponse(502, text='<html>Bad Gateway</html>')
    resp.json = lambda: (_ for _ in ()).throw(ValueError('not json'))
    assert mureka._extract_error_message(resp) == '502: <html>Bad Gateway</html>'


def test_extract_error_message_falls_back_when_error_key_missing():
    resp = _FakeResponse(500, {'detail': 'something else'}, text='{"detail": "something else"}')
    assert mureka._extract_error_message(resp) == '500: {"detail": "something else"}'


def test_upload_reference_audio_error_message_is_clean_not_raw_json(monkeypatch):
    _install(monkeypatch, [_FakeResponse(
        400, {'error': {'message': 'Invalid Request, The audio duration should be at least 30 seconds.'}},
        text='{"error": {"message": "Invalid Request, The audio duration should be at least 30 seconds."}}',
    )])
    with pytest.raises(RuntimeError, match='at least 30 seconds') as exc_info:
        asyncio.run(mureka.upload_reference_audio(b'short', 'ref.mp3', 'key'))
    # The old behavior dumped the raw JSON blob into the message - assert
    # that's gone, not just that *a* substring matches.
    assert '{"error"' not in str(exc_info.value)


# ---------- get_billing ----------

def test_get_billing_success(monkeypatch):
    fake_client = _install(monkeypatch, [_FakeResponse(200, {
        'account_id': 153100679643137, 'balance': 2991, 'total_recharge': 3000,
        'total_spending': 9, 'concurrent_request_limit': 1, 'trace_id': 't1',
    })])

    result = asyncio.run(mureka.get_billing('test-key'))

    assert result['balance'] == 2991
    call = fake_client.calls[0]
    assert call['url'] == 'https://api.mureka.ai/v1/account/billing'
    assert call['headers'] == {'Authorization': 'Bearer test-key'}


def test_get_billing_missing_key_raises():
    with pytest.raises(RuntimeError, match='Mureka'):
        asyncio.run(mureka.get_billing(''))


def test_get_billing_error_status_raises_with_clean_message(monkeypatch):
    _install(monkeypatch, [_FakeResponse(401, {'error': {'message': 'Invalid API key'}})])
    with pytest.raises(RuntimeError, match='Invalid API key'):
        asyncio.run(mureka.get_billing('bad-key'))


# ---------- extend (song/extend) ----------

def test_submit_extend_builds_minimal_body(monkeypatch):
    fake_client = _install(monkeypatch, [_FakeResponse(200, {'id': 't1', 'status': 'preparing'})])

    data, debug_request = asyncio.run(mureka._submit_extend('song_1', 'more lyrics', 8000, None, None, 'key'))

    assert data == {'id': 't1', 'status': 'preparing'}
    assert debug_request['url'] == 'https://api.mureka.ai/v1/song/extend'
    assert fake_client.calls[0]['json'] == {'song_id': 'song_1', 'lyrics': 'more lyrics', 'extend_at': 8000}


def test_submit_extend_includes_model_and_extend_type(monkeypatch):
    fake_client = _install(monkeypatch, [_FakeResponse(200, {'id': 't1', 'status': 'preparing'})])

    asyncio.run(mureka._submit_extend('song_1', 'lyrics', 12000, 'mureka-8', 'head', 'key'))

    assert fake_client.calls[0]['json'] == {
        'song_id': 'song_1', 'lyrics': 'lyrics', 'extend_at': 12000, 'model': 'mureka-8', 'extend_type': 'head',
    }


def test_submit_extend_missing_key_raises():
    with pytest.raises(RuntimeError, match='Mureka'):
        asyncio.run(mureka._submit_extend('song_1', 'l', 8000, None, None, ''))


def test_start_extend_job_success_appends_tracks_tagged_with_source(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_DATA_DIR', str(tmp_path))
    from app import storage

    storage.save_project('poem-a', {'id': 'poem-a', 'mureka': {'tracks': [], 'reference_audio': []}})

    _install(monkeypatch, [
        _FakeResponse(200, {'id': 'task_ext', 'status': 'preparing'}),
        _FakeResponse(200, {
            'status': 'succeeded',
            'choices': [{'index': 0, 'id': 'song_2', 'url': 'https://cdn.mureka.ai/ext.mp3', 'duration': 60000}],
        }),
        _FakeResponse(200, content=b'EXTENDED-MP3'),
    ])

    async def scenario():
        job_id = mureka.start_extend_job(
            'poem-a', 'trk_source', 'song_1', 'continuation lyrics', 30000, None, None,
            {'api_keys': {'mureka': 'k'}},
        )
        return await _wait_for_terminal(job_id)

    job = asyncio.run(scenario())

    assert job['status'] == 'completed'
    assert len(job['tracks']) == 1
    track = job['tracks'][0]
    assert track['extended_from_track_id'] == 'trk_source'
    assert track['lyrics'] == 'continuation lyrics'
    assert track['params'] == {'extend_at': 30000, 'extend_type': None}
    assert track['request'] == {'url': 'https://api.mureka.ai/v1/song/extend', 'body': {'song_id': 'song_1', 'lyrics': 'continuation lyrics', 'extend_at': 30000}}

    project = storage.load_project('poem-a')
    assert len(project['mureka']['tracks']) == 1


def test_start_extend_job_failure_records_error(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_DATA_DIR', str(tmp_path))
    _install(monkeypatch, [_FakeResponse(400, {'error': {'message': 'Song not found'}})])

    async def scenario():
        job_id = mureka.start_extend_job(
            'poem-a', 'trk_source', 'song_1', 'lyrics', 30000, None, None, {'api_keys': {'mureka': 'k'}},
        )
        return await _wait_for_terminal(job_id)

    job = asyncio.run(scenario())
    assert job['status'] == 'failed'
    assert 'Song not found' in job['error']


# ---------- stem_track ----------

def test_stem_track_success_downloads_zip(tmp_path, monkeypatch):
    _install(monkeypatch, [
        _FakeResponse(200, {'zip_url': 'https://cdn.mureka.ai/stems.zip', 'expires_at': 123}),
        _FakeResponse(200, content=b'ZIPDATA'),
    ])
    dest = tmp_path / 'stem_abc.zip'

    result = asyncio.run(mureka.stem_track(b'fake-mp3-bytes', None, 'key', dest))

    assert result['zip_url'] == 'https://cdn.mureka.ai/stems.zip'
    assert dest.read_bytes() == b'ZIPDATA'


def test_stem_track_sends_base64_data_uri_and_model(tmp_path, monkeypatch):
    fake_client = _install(monkeypatch, [
        _FakeResponse(200, {'zip_url': 'https://cdn.mureka.ai/stems.zip'}),
        _FakeResponse(200, content=b'ZIPDATA'),
    ])
    dest = tmp_path / 'stem.zip'

    asyncio.run(mureka.stem_track(b'AB', 'audio-separation-2', 'key', dest))

    body = fake_client.calls[0]['json']
    assert body['model'] == 'audio-separation-2'
    assert body['url'].startswith('data:audio/mpeg;base64,')


def test_stem_track_rejects_oversized_file(tmp_path):
    dest = tmp_path / 'stem.zip'
    with pytest.raises(RuntimeError, match='MB'):
        asyncio.run(mureka.stem_track(b'x' * (mureka._STEM_MAX_BYTES + 1), None, 'key', dest))


def test_stem_track_missing_key_raises(tmp_path):
    dest = tmp_path / 'stem.zip'
    with pytest.raises(RuntimeError, match='Mureka'):
        asyncio.run(mureka.stem_track(b'x', None, '', dest))


def test_stem_track_records_usage_on_error(tmp_path, monkeypatch, usage_ledger):
    _install(monkeypatch, [_FakeResponse(500, text='boom')])
    dest = tmp_path / 'stem.zip'
    ctx = usage_ledger.context('mureka_stem', 'poem-c', {}, model=None)

    with pytest.raises(RuntimeError):
        asyncio.run(mureka.stem_track(b'x', None, 'key', dest, usage_ctx=ctx))

    records = usage_ledger.query()['records']
    assert len(records) == 1
    assert records[0]['status'] == 'error'


# ---------- describe_song ----------

def test_describe_song_success_sends_base64_data_uri(monkeypatch):
    fake_client = _install(monkeypatch, [
        _FakeResponse(200, {
            'instrument': ['piano', 'strings'], 'genres': ['ballad'], 'tags': ['sad', 'slow'],
            'description': 'A melancholic piano ballad.',
        }),
    ])

    result = asyncio.run(mureka.describe_song(b'fake-mp3-bytes', 'key'))

    assert result['genres'] == ['ballad']
    assert result['description'] == 'A melancholic piano ballad.'
    body = fake_client.calls[0]['json']
    assert body['url'].startswith('data:audio/mpeg;base64,')


def test_describe_song_rejects_oversized_file():
    with pytest.raises(RuntimeError, match='MB'):
        asyncio.run(mureka.describe_song(b'x' * (mureka._STEM_MAX_BYTES + 1), 'key'))


def test_describe_song_missing_key_raises():
    with pytest.raises(RuntimeError, match='Mureka'):
        asyncio.run(mureka.describe_song(b'x', ''))


def test_describe_song_error_status_raises(monkeypatch):
    _install(monkeypatch, [_FakeResponse(400, {'error': {'message': 'bad audio'}})])
    with pytest.raises(RuntimeError, match='bad audio'):
        asyncio.run(mureka.describe_song(b'x', 'key'))


def test_describe_song_records_usage_on_success(monkeypatch, usage_ledger):
    _install(monkeypatch, [_FakeResponse(200, {'instrument': [], 'genres': [], 'tags': [], 'description': 'x'})])
    ctx = usage_ledger.context('mureka_describe', 'poem-d', {})

    asyncio.run(mureka.describe_song(b'x', 'key', usage_ctx=ctx))

    records = usage_ledger.query()['records']
    assert len(records) == 1
    assert records[0]['status'] == 'ok'
    assert records[0]['task'] == 'mureka_describe'


# ---------- transcribe_song ----------

def test_transcribe_song_success_downloads_zip(tmp_path, monkeypatch):
    fake_client = _install(monkeypatch, [
        _FakeResponse(200, {'zip_url': 'https://cdn.mureka.ai/notes.zip', 'expires_at': 456}),
        _FakeResponse(200, content=b'NOTES-ZIP'),
    ])
    dest = tmp_path / 'xscr_abc.zip'

    result = asyncio.run(mureka.transcribe_song('song_1', 'key', dest))

    assert result['expires_at'] == 456
    assert dest.read_bytes() == b'NOTES-ZIP'
    assert fake_client.calls[0]['json'] == {'song_id': 'song_1'}


def test_transcribe_song_missing_key_raises(tmp_path):
    with pytest.raises(RuntimeError, match='Mureka'):
        asyncio.run(mureka.transcribe_song('song_1', '', tmp_path / 'x.zip'))


def test_transcribe_song_error_status_raises(tmp_path, monkeypatch):
    _install(monkeypatch, [_FakeResponse(400, {'error': {'message': 'song too old'}})])
    with pytest.raises(RuntimeError, match='song too old'):
        asyncio.run(mureka.transcribe_song('song_1', 'key', tmp_path / 'x.zip'))


# ---------- generate_lyrics_video ----------

def test_generate_lyrics_video_success_downloads_mp4(tmp_path, monkeypatch):
    fake_client = _install(monkeypatch, [
        _FakeResponse(200, {'url': 'https://cdn.mureka.ai/lyrics.mp4'}),
        _FakeResponse(200, content=b'MP4DATA'),
    ])
    dest = tmp_path / 'lvid_abc.mp4'

    result = asyncio.run(mureka.generate_lyrics_video('song_1', 'My Title', '9:16', 'key', dest))

    assert result['url'] == 'https://cdn.mureka.ai/lyrics.mp4'
    assert dest.read_bytes() == b'MP4DATA'
    assert fake_client.calls[0]['json'] == {'song_id': 'song_1', 'title': 'My Title', 'aspect_ratio': '9:16'}


def test_generate_lyrics_video_omits_optional_fields_when_not_given(tmp_path, monkeypatch):
    fake_client = _install(monkeypatch, [
        _FakeResponse(200, {'url': 'https://cdn.mureka.ai/lyrics.mp4'}),
        _FakeResponse(200, content=b'MP4DATA'),
    ])
    dest = tmp_path / 'lvid.mp4'

    asyncio.run(mureka.generate_lyrics_video('song_1', None, None, 'key', dest))

    assert fake_client.calls[0]['json'] == {'song_id': 'song_1'}


def test_generate_lyrics_video_includes_selection_range_when_given(tmp_path, monkeypatch):
    fake_client = _install(monkeypatch, [
        _FakeResponse(200, {'url': 'https://cdn.mureka.ai/lyrics.mp4'}),
        _FakeResponse(200, content=b'MP4DATA'),
    ])
    dest = tmp_path / 'lvid.mp4'

    asyncio.run(mureka.generate_lyrics_video('song_1', None, None, 'key', dest, selection_start=0, selection_end=30000))

    assert fake_client.calls[0]['json'] == {'song_id': 'song_1', 'selection_start': 0, 'selection_end': 30000}


def test_generate_lyrics_video_missing_key_raises(tmp_path):
    with pytest.raises(RuntimeError, match='Mureka'):
        asyncio.run(mureka.generate_lyrics_video('song_1', None, None, '', tmp_path / 'x.mp4'))


def test_generate_lyrics_video_error_status_raises(tmp_path, monkeypatch):
    _install(monkeypatch, [_FakeResponse(400, {'error': {'message': 'no lyrics found'}})])
    with pytest.raises(RuntimeError, match='no lyrics found'):
        asyncio.run(mureka.generate_lyrics_video('song_1', None, None, 'key', tmp_path / 'x.mp4'))


# ---------- trim_audio (ffmpeg) ----------

def test_trim_audio_missing_ffmpeg_raises(tmp_path, monkeypatch):
    monkeypatch.setattr(mureka.shutil, 'which', lambda _name: None)
    with pytest.raises(RuntimeError, match='ffmpeg'):
        asyncio.run(mureka.trim_audio(tmp_path / 'src.mp3', 0, 30000, tmp_path / 'out.mp3'))


def test_trim_audio_rejects_empty_range(tmp_path):
    (tmp_path / 'src.mp3').write_bytes(b'fake')
    with pytest.raises(RuntimeError, match='диапазон'):
        asyncio.run(mureka.trim_audio(tmp_path / 'src.mp3', 30000, 30000, tmp_path / 'out.mp3'))


@pytest.mark.skipif(shutil.which('ffmpeg') is None, reason='ffmpeg not installed in this environment')
def test_trim_audio_real_ffmpeg_produces_output(tmp_path):
    import subprocess
    src = tmp_path / 'src.wav'
    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', str(src)],
        check=True, capture_output=True,
    )
    dest = tmp_path / 'trimmed.mp3'

    asyncio.run(mureka.trim_audio(src, 500, 3000, dest))

    assert dest.is_file()
    assert dest.stat().st_size > 0
