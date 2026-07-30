import asyncio
import base64

import pytest

from app.providers import images


class _FakeResponse:
    def __init__(self, status_code, payload=None, text='', content=b'', headers=None):
        self.status_code = status_code
        self._payload = payload
        self.text = text
        self.content = content
        self.headers = headers or {}

    def json(self):
        return self._payload


class _FakeAsyncClient:
    """Same fake instance is returned by every `httpx.AsyncClient(...)` call
    site the code under test opens, so its `_responses` queue is popped in
    call order across submit/poll/download regardless of which method
    (post/get) is used - mirrors test_suno_provider.py's fake client, extended
    to a multi-call queue for the job + polling flows."""

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

    async def post(self, url, headers=None, json=None, params=None):
        return await self._next('POST', url, headers=headers, json=json, params=params)

    async def get(self, url, headers=None, params=None):
        return await self._next('GET', url, headers=headers, params=params)


_real_sleep = asyncio.sleep


class _FastSleep:
    """Replaces `asyncio.sleep(_POLL_INTERVAL)` with a real (but 0-delay)
    `asyncio.sleep` so polling loops still actually yield to the event loop -
    needed for `start_jobs`'s background `create_task` to get scheduled -
    without tests waiting out the real multi-second poll interval. Captures
    the pre-patch `asyncio.sleep` directly rather than going through the
    (patched) `asyncio` module attribute, to avoid recursing into itself."""

    async def __call__(self, *args, **kwargs):
        await _real_sleep(0)


@pytest.fixture(autouse=True)
def _no_real_sleep(monkeypatch):
    monkeypatch.setattr(images.asyncio, 'sleep', _FastSleep())


def _install(monkeypatch, responses):
    fake_client = _FakeAsyncClient(responses)
    monkeypatch.setattr(images.httpx, 'AsyncClient', lambda **kwargs: fake_client)
    return fake_client


def test_generate_krea_success(monkeypatch):
    fake_client = _install(monkeypatch, [
        _FakeResponse(200, {'job_id': 'j1', 'status': 'queued'}),
        _FakeResponse(200, {'status': 'processing'}),
        _FakeResponse(200, {'status': 'completed', 'result': {'urls': ['https://cdn.example/img.png']}}),
        _FakeResponse(200, content=b'PNGDATA', headers={'content-type': 'image/png'}),
    ])

    content, ext = asyncio.run(images._generate_krea('krea/krea-2/medium', 'a prompt', 'test-key'))

    assert content == b'PNGDATA'
    assert ext == 'png'
    first_call = fake_client.calls[0]
    assert first_call['url'] == 'https://api.krea.ai/generate/image/krea/krea-2/medium'
    assert first_call['headers'] == {'Authorization': 'Bearer test-key'}
    assert first_call['json'] == {'prompt': 'a prompt'}


def test_generate_krea_missing_key_raises():
    with pytest.raises(RuntimeError, match='Krea'):
        asyncio.run(images._generate_krea('krea/krea-2/medium', 'p', ''))


def test_generate_krea_failed_status_raises(monkeypatch):
    _install(monkeypatch, [
        _FakeResponse(200, {'job_id': 'j1', 'status': 'queued'}),
        _FakeResponse(200, {'status': 'failed'}),
    ])
    with pytest.raises(RuntimeError, match='failed'):
        asyncio.run(images._generate_krea('krea/krea-2/medium', 'p', 'key'))


def test_generate_replicate_success(monkeypatch):
    fake_client = _install(monkeypatch, [
        _FakeResponse(200, {'id': 'p1', 'status': 'starting', 'urls': {'get': 'https://api.replicate.com/v1/predictions/p1'}}),
        _FakeResponse(200, {'status': 'processing', 'urls': {'get': 'https://api.replicate.com/v1/predictions/p1'}}),
        _FakeResponse(200, {'status': 'succeeded', 'output': ['https://cdn.example/img.jpg'], 'urls': {'get': 'https://api.replicate.com/v1/predictions/p1'}}),
        _FakeResponse(200, content=b'JPGDATA', headers={'content-type': 'image/jpeg'}),
    ])

    content, ext = asyncio.run(images._generate_replicate('black-forest-labs/flux-schnell', 'a prompt', 'test-key'))

    assert content == b'JPGDATA'
    assert ext == 'jpg'
    first_call = fake_client.calls[0]
    assert first_call['url'] == 'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions'
    assert first_call['headers']['Authorization'] == 'Bearer test-key'
    assert first_call['json'] == {'input': {'prompt': 'a prompt'}}


def test_generate_replicate_missing_key_raises():
    with pytest.raises(RuntimeError, match='Replicate'):
        asyncio.run(images._generate_replicate('owner/model', 'p', ''))


def test_generate_replicate_failed_raises(monkeypatch):
    _install(monkeypatch, [
        _FakeResponse(200, {'id': 'p1', 'status': 'starting', 'urls': {'get': 'https://x'}}),
        _FakeResponse(200, {'status': 'failed', 'error': 'boom', 'urls': {'get': 'https://x'}}),
    ])
    with pytest.raises(RuntimeError, match='boom'):
        asyncio.run(images._generate_replicate('owner/model', 'p', 'key'))


def test_generate_fal_success(monkeypatch):
    fake_client = _install(monkeypatch, [
        _FakeResponse(200, {
            'status': 'IN_QUEUE', 'request_id': 'r1',
            'status_url': 'https://queue.fal.run/fal-ai/flux/dev/requests/r1/status',
            'response_url': 'https://queue.fal.run/fal-ai/flux/dev/requests/r1',
        }),
        _FakeResponse(200, {'status': 'IN_PROGRESS'}),
        _FakeResponse(200, {'status': 'COMPLETED'}),
        _FakeResponse(200, {'images': [{'url': 'https://cdn.example/img.webp'}]}),
        _FakeResponse(200, content=b'WEBPDATA', headers={'content-type': 'image/webp'}),
    ])

    content, ext = asyncio.run(images._generate_fal('fal-ai/flux/dev', 'a prompt', 'test-key'))

    assert content == b'WEBPDATA'
    assert ext == 'webp'
    first_call = fake_client.calls[0]
    assert first_call['url'] == 'https://queue.fal.run/fal-ai/flux/dev'
    assert first_call['headers'] == {'Authorization': 'Key test-key', 'Content-Type': 'application/json'}
    assert first_call['json'] == {'prompt': 'a prompt'}


def test_generate_fal_missing_key_raises():
    with pytest.raises(RuntimeError, match='FAL'):
        asyncio.run(images._generate_fal('fal-ai/flux/dev', 'p', ''))


def test_generate_fal_failed_raises(monkeypatch):
    _install(monkeypatch, [
        _FakeResponse(200, {'status': 'IN_QUEUE', 'status_url': 'https://x/status', 'response_url': 'https://x'}),
        _FakeResponse(200, {'status': 'FAILED'}),
    ])
    with pytest.raises(RuntimeError, match='FAL'):
        asyncio.run(images._generate_fal('fal-ai/flux/dev', 'p', 'key'))


def test_generate_google_success(monkeypatch):
    payload = {'predictions': [{'bytesBase64Encoded': base64.b64encode(b'PNGDATA').decode(), 'mimeType': 'image/png'}]}
    fake_client = _install(monkeypatch, [_FakeResponse(200, payload)])

    content, ext = asyncio.run(images._generate_google('imagen-4.0-generate-001', 'a prompt', 'test-key'))

    assert content == b'PNGDATA'
    assert ext == 'png'
    call = fake_client.calls[0]
    assert call['url'] == 'https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict'
    assert call['params'] == {'key': 'test-key'}
    assert call['json'] == {'instances': [{'prompt': 'a prompt'}], 'parameters': {'sampleCount': 1}}


def test_generate_google_missing_key_raises():
    with pytest.raises(RuntimeError, match='Google'):
        asyncio.run(images._generate_google('imagen-4.0-generate-001', 'p', ''))


def test_generate_google_error_status_raises(monkeypatch):
    _install(monkeypatch, [_FakeResponse(500, text='boom')])
    with pytest.raises(RuntimeError, match='500'):
        asyncio.run(images._generate_google('imagen-4.0-generate-001', 'p', 'key'))


def test_generate_google_empty_predictions_raises(monkeypatch):
    _install(monkeypatch, [_FakeResponse(200, {'predictions': []})])
    with pytest.raises(RuntimeError, match='Google Imagen'):
        asyncio.run(images._generate_google('imagen-4.0-generate-001', 'p', 'key'))


def test_start_jobs_unknown_provider_fails_job():
    async def scenario():
        job_ids = images.start_jobs('does-not-matter-slug', 0, 'prompt', 1, 'unknownprovider:x', {'api_keys': {}})
        for _ in range(200):
            job = images.get_job(job_ids[0])
            if job['status'] != 'pending':
                return job_ids, job
            await asyncio.sleep(0)
        raise AssertionError('job did not resolve')

    job_ids, job = asyncio.run(scenario())
    assert job['status'] == 'failed'
    assert 'unknownprovider' in job['error']


def test_get_job_unknown_id_returns_none():
    assert images.get_job('does-not-exist') is None


def test_ext_from_response_falls_back_to_content_type_when_url_has_no_extension():
    assert images._ext_from_response('https://cdn.example/deliver/abc123', 'image/webp; charset=binary') == 'webp'


def test_ext_from_response_defaults_to_png_for_unknown_content_type():
    assert images._ext_from_response('https://cdn.example/deliver/abc123', 'application/octet-stream') == 'png'
