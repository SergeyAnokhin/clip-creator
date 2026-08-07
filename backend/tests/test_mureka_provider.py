import asyncio

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
