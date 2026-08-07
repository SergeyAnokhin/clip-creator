import asyncio
import base64
import io

import numpy as np
import pytest
from PIL import Image

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


def test_generate_krea_aspect_ratio_passed_through(monkeypatch):
    fake_client = _install(monkeypatch, [
        _FakeResponse(200, {'job_id': 'j1', 'status': 'queued'}),
        _FakeResponse(200, {'status': 'completed', 'result': {'urls': ['https://cdn.example/img.png']}}),
        _FakeResponse(200, content=b'PNGDATA', headers={'content-type': 'image/png'}),
    ])

    asyncio.run(images._generate_krea('krea/krea-2/medium', 'a prompt', 'test-key', aspect_ratio='9:16'))

    assert fake_client.calls[0]['json'] == {'prompt': 'a prompt', 'aspect_ratio': '9:16'}


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


def test_generate_replicate_aspect_ratio_passed_through(monkeypatch):
    fake_client = _install(monkeypatch, [
        _FakeResponse(200, {'id': 'p1', 'status': 'succeeded', 'output': ['https://cdn.example/img.jpg'], 'urls': {'get': 'https://x'}}),
        _FakeResponse(200, content=b'JPGDATA', headers={'content-type': 'image/jpeg'}),
    ])

    asyncio.run(images._generate_replicate('black-forest-labs/flux-schnell', 'a prompt', 'test-key', aspect_ratio='16:9'))

    assert fake_client.calls[0]['json'] == {'input': {'prompt': 'a prompt', 'aspect_ratio': '16:9'}}


def test_generate_replicate_sdxl_aspect_ratio_maps_to_width_height(monkeypatch):
    fake_client = _install(monkeypatch, [
        _FakeResponse(200, {'id': 'p1', 'status': 'succeeded', 'output': ['https://cdn.example/img.jpg'], 'urls': {'get': 'https://x'}}),
        _FakeResponse(200, content=b'JPGDATA', headers={'content-type': 'image/jpeg'}),
    ])

    asyncio.run(images._generate_replicate('stability-ai/sdxl', 'a prompt', 'test-key', aspect_ratio='9:16'))

    assert fake_client.calls[0]['json'] == {'input': {'prompt': 'a prompt', 'width': 768, 'height': 1344}}


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


def test_generate_fal_aspect_ratio_maps_to_image_size(monkeypatch):
    fake_client = _install(monkeypatch, [
        _FakeResponse(200, {
            'status': 'COMPLETED', 'request_id': 'r1',
            'status_url': 'https://x/status', 'response_url': 'https://x',
        }),
        _FakeResponse(200, {'images': [{'url': 'https://cdn.example/img.webp'}]}),
        _FakeResponse(200, content=b'WEBPDATA', headers={'content-type': 'image/webp'}),
    ])

    asyncio.run(images._generate_fal('fal-ai/flux/dev', 'a prompt', 'test-key', aspect_ratio='1:1'))

    assert fake_client.calls[0]['json'] == {'prompt': 'a prompt', 'image_size': 'square_hd'}


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


def test_generate_fal_poll_202_in_progress_keeps_polling(monkeypatch):
    fake_client = _install(monkeypatch, [
        _FakeResponse(200, {
            'status': 'IN_QUEUE', 'request_id': 'r1',
            'status_url': 'https://queue.fal.run/fal-ai/flux-pro/req/r1/status',
            'response_url': 'https://queue.fal.run/fal-ai/flux-pro/req/r1',
        }),
        _FakeResponse(202, {'status': 'IN_PROGRESS'}),
        _FakeResponse(202, {'status': 'IN_PROGRESS'}),
        _FakeResponse(200, {'status': 'COMPLETED'}),
        _FakeResponse(200, {'images': [{'url': 'https://cdn.example/img.webp'}]}),
        _FakeResponse(200, content=b'WEBPDATA', headers={'content-type': 'image/webp'}),
    ])

    content, ext = asyncio.run(images._generate_fal('fal-ai/flux-pro/v1.1', 'a prompt', 'test-key'))

    assert content == b'WEBPDATA'
    assert ext == 'webp'
    assert len(fake_client.calls) == 6


def test_generate_fal_nsfw_flagged_raises(monkeypatch):
    _install(monkeypatch, [
        _FakeResponse(200, {
            'status': 'COMPLETED', 'request_id': 'r1',
            'status_url': 'https://x/status', 'response_url': 'https://x',
        }),
        _FakeResponse(200, {
            'images': [{'url': 'https://cdn.example/img.png'}],
            'has_nsfw_concepts': [True],
        }),
    ])
    with pytest.raises(RuntimeError, match='NSFW'):
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


def test_generate_google_aspect_ratio_passed_through(monkeypatch):
    payload = {'predictions': [{'bytesBase64Encoded': base64.b64encode(b'PNGDATA').decode(), 'mimeType': 'image/png'}]}
    fake_client = _install(monkeypatch, [_FakeResponse(200, payload)])

    asyncio.run(images._generate_google('imagen-4.0-generate-001', 'a prompt', 'test-key', aspect_ratio='16:9'))

    assert fake_client.calls[0]['json'] == {
        'instances': [{'prompt': 'a prompt'}], 'parameters': {'sampleCount': 1, 'aspectRatio': '16:9'},
    }


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


def test_generate_openrouter_success(monkeypatch):
    payload = {
        'data': [{'b64_json': base64.b64encode(b'PNGDATA').decode(), 'media_type': 'image/png'}],
        'usage': {'cost': 0.04},
    }
    fake_client = _install(monkeypatch, [_FakeResponse(200, payload)])

    usage_out = {}
    content, ext = asyncio.run(images._generate_openrouter('google/gemini-2.5-flash-image', 'a prompt', 'test-key', usage_out=usage_out))

    assert content == b'PNGDATA'
    assert ext == 'png'
    assert usage_out['cost'] == 0.04
    call = fake_client.calls[0]
    assert call['url'] == 'https://openrouter.ai/api/v1/images'
    assert call['headers']['Authorization'] == 'Bearer test-key'
    assert call['json'] == {'model': 'google/gemini-2.5-flash-image', 'prompt': 'a prompt', 'n': 1}


def test_generate_openrouter_aspect_ratio_passed_through(monkeypatch):
    payload = {'data': [{'b64_json': base64.b64encode(b'PNGDATA').decode(), 'media_type': 'image/png'}]}
    fake_client = _install(monkeypatch, [_FakeResponse(200, payload)])

    asyncio.run(images._generate_openrouter('google/gemini-2.5-flash-image', 'a prompt', 'test-key', aspect_ratio='9:16'))

    assert fake_client.calls[0]['json'] == {'model': 'google/gemini-2.5-flash-image', 'prompt': 'a prompt', 'n': 1, 'aspect_ratio': '9:16'}


def test_generate_openrouter_missing_key_raises():
    with pytest.raises(RuntimeError, match='OpenRouter'):
        asyncio.run(images._generate_openrouter('google/gemini-2.5-flash-image', 'p', ''))


def test_generate_openrouter_empty_data_raises(monkeypatch):
    _install(monkeypatch, [_FakeResponse(200, {'data': []})])
    with pytest.raises(RuntimeError, match='OpenRouter'):
        asyncio.run(images._generate_openrouter('google/gemini-2.5-flash-image', 'p', 'key'))


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


@pytest.fixture
def usage_ledger(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_DATA_DIR', str(tmp_path))
    from app import usage as usage_module
    return usage_module


def test_start_jobs_records_a_usage_row_on_success(monkeypatch, usage_ledger):
    payload = {'predictions': [{'bytesBase64Encoded': base64.b64encode(b'PNGDATA').decode(), 'mimeType': 'image/png'}]}
    _install(monkeypatch, [_FakeResponse(200, payload)])

    async def scenario():
        ctx = usage_ledger.context('scene_image', 'poem-a', {}, scene_index=2, count=1)
        job_ids = images.start_jobs(
            'poem-a', 2, 'a scenic prompt', 1, 'google:imagen-4.0-generate-001', {'api_keys': {'google': 'k'}},
            usage_ctx=ctx,
        )
        for _ in range(200):
            job = images.get_job(job_ids[0])
            if job['status'] != 'pending':
                return job
            await asyncio.sleep(0)
        raise AssertionError('job did not resolve')

    job = asyncio.run(scenario())
    assert job['status'] == 'completed'

    records = usage_ledger.query()['records']
    assert len(records) == 1
    rec = records[0]
    assert rec['task'] == 'scene_image'
    assert rec['project_id'] == 'poem-a'
    assert rec['model'] == 'google:imagen-4.0-generate-001'
    assert rec['status'] == 'ok'
    assert rec['units']['images'] == 1
    assert rec['meta']['scene_index'] == 2


def test_start_jobs_records_replicate_compute_seconds(monkeypatch, usage_ledger):
    _install(monkeypatch, [
        _FakeResponse(200, {'id': 'p1', 'status': 'starting', 'urls': {'get': 'https://api.replicate.com/v1/predictions/p1'}}),
        _FakeResponse(200, {
            'status': 'succeeded', 'output': ['https://cdn.example/img.jpg'],
            'urls': {'get': 'https://api.replicate.com/v1/predictions/p1'},
            'metrics': {'predict_time': 1.87},
        }),
        _FakeResponse(200, content=b'JPGDATA', headers={'content-type': 'image/jpeg'}),
    ])

    async def scenario():
        ctx = usage_ledger.context('scene_image', 'poem-a', {}, scene_index=0, count=1)
        job_ids = images.start_jobs(
            'poem-a', 0, 'p', 1, 'replicate:black-forest-labs/flux-schnell', {'api_keys': {'replicate': 'k'}},
            usage_ctx=ctx,
        )
        for _ in range(200):
            job = images.get_job(job_ids[0])
            if job['status'] != 'pending':
                return job
            await asyncio.sleep(0)
        raise AssertionError('job did not resolve')

    asyncio.run(scenario())
    rec = usage_ledger.query()['records'][0]
    assert rec['units']['compute_seconds'] == pytest.approx(1.87)


def test_start_jobs_records_openrouter_provider_reported_cost(monkeypatch, usage_ledger):
    payload = {
        'data': [{'b64_json': base64.b64encode(b'PNGDATA').decode(), 'media_type': 'image/png'}],
        'usage': {'cost': 0.04},
    }
    _install(monkeypatch, [_FakeResponse(200, payload)])

    async def scenario():
        ctx = usage_ledger.context('scene_image', 'poem-a', {}, scene_index=0, count=1)
        job_ids = images.start_jobs(
            'poem-a', 0, 'p', 1, 'openrouter:google/gemini-2.5-flash-image', {'api_keys': {'openrouter': 'k'}},
            usage_ctx=ctx,
        )
        for _ in range(200):
            job = images.get_job(job_ids[0])
            if job['status'] != 'pending':
                return job
            await asyncio.sleep(0)
        raise AssertionError('job did not resolve')

    asyncio.run(scenario())
    rec = usage_ledger.query()['records'][0]
    assert rec['cost']['source'] == 'provider'
    assert rec['cost']['amount'] == pytest.approx(0.04)
    assert 'cost' not in rec['units']


def test_start_jobs_stores_model_aspect_ratio_and_cost_on_image(monkeypatch, usage_ledger):
    payload = {'predictions': [{'bytesBase64Encoded': base64.b64encode(b'PNGDATA').decode(), 'mimeType': 'image/png'}]}
    _install(monkeypatch, [_FakeResponse(200, payload)])

    async def scenario():
        ctx = usage_ledger.context('scene_image', 'poem-a', {}, scene_index=0, count=1)
        job_ids = images.start_jobs(
            'poem-a', 0, 'p', 1, 'google:imagen-4.0-generate-001', {'api_keys': {'google': 'k'}},
            usage_ctx=ctx, aspect_ratio='9:16',
        )
        for _ in range(200):
            job = images.get_job(job_ids[0])
            if job['status'] != 'pending':
                return job
            await asyncio.sleep(0)
        raise AssertionError('job did not resolve')

    job = asyncio.run(scenario())
    image = job['image']
    assert image['model'] == 'google:imagen-4.0-generate-001'
    assert image['aspect_ratio'] == '9:16'
    assert image['cost'] == pytest.approx(0.04)


def test_start_jobs_rejects_unknown_aspect_ratio(monkeypatch, usage_ledger):
    payload = {'predictions': [{'bytesBase64Encoded': base64.b64encode(b'PNGDATA').decode(), 'mimeType': 'image/png'}]}
    fake_client = _install(monkeypatch, [_FakeResponse(200, payload)])

    async def scenario():
        job_ids = images.start_jobs(
            'poem-a', 0, 'p', 1, 'google:imagen-4.0-generate-001', {'api_keys': {'google': 'k'}},
            aspect_ratio='not-a-ratio',
        )
        for _ in range(200):
            job = images.get_job(job_ids[0])
            if job['status'] != 'pending':
                return job
            await asyncio.sleep(0)
        raise AssertionError('job did not resolve')

    asyncio.run(scenario())
    assert 'aspectRatio' not in fake_client.calls[0]['json']['parameters']


def test_start_jobs_records_error_status_on_failure(usage_ledger):
    async def scenario():
        ctx = usage_ledger.context('scene_image', 'poem-a', {}, scene_index=0, count=1)
        job_ids = images.start_jobs(
            'poem-a', 0, 'prompt', 1, 'unknownprovider:x', {'api_keys': {}}, usage_ctx=ctx,
        )
        for _ in range(200):
            job = images.get_job(job_ids[0])
            if job['status'] != 'pending':
                return job
            await asyncio.sleep(0)
        raise AssertionError('job did not resolve')

    asyncio.run(scenario())
    rec = usage_ledger.query()['records'][0]
    assert rec['status'] == 'error'
    assert rec['cost']['amount'] is None
    assert 'unknownprovider' in rec['error']


# ---------- download_user_image_url (scene-image upload's SSRF guard) ----------

class _FakeStreamResponse:
    def __init__(self, status_code, headers, chunks):
        self.status_code = status_code
        self.headers = headers
        self._chunks = chunks

    async def aiter_bytes(self):
        for chunk in self._chunks:
            yield chunk


class _FakeStreamCtx:
    def __init__(self, response):
        self._response = response

    async def __aenter__(self):
        return self._response

    async def __aexit__(self, *args):
        return False


class _FakeStreamClient:
    """Mimics the subset of httpx.AsyncClient used by
    `download_user_image_url`'s streaming GET (`.stream(...)` as an async
    context manager) - the fixed-response `_FakeAsyncClient` above only
    covers `.post`/`.get`, which the streaming path doesn't call."""

    def __init__(self, response):
        self._response = response

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def stream(self, method, url):
        return _FakeStreamCtx(self._response)


def test_download_user_image_url_rejects_non_http_scheme():
    with pytest.raises(RuntimeError, match='ссылка'):
        asyncio.run(images.download_user_image_url('ftp://example.com/x.png'))


@pytest.mark.parametrize('url', [
    'http://127.0.0.1/x.png',
    'http://localhost/x.png',
    'http://10.0.0.5/x.png',
    'http://192.168.1.5/x.png',
    'http://169.254.169.254/latest/meta-data/',
])
def test_download_user_image_url_rejects_private_and_loopback_hosts(url):
    with pytest.raises(RuntimeError, match='адрес'):
        asyncio.run(images.download_user_image_url(url))


def test_download_user_image_url_rejects_non_image_content_type(monkeypatch):
    fake_client = _FakeStreamClient(_FakeStreamResponse(200, {'content-type': 'text/html'}, [b'<html>']))
    monkeypatch.setattr(images.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    with pytest.raises(RuntimeError, match='изображение'):
        asyncio.run(images.download_user_image_url('http://example.com/not-an-image'))


def test_download_user_image_url_rejects_oversized_body(monkeypatch):
    monkeypatch.setattr(images, '_MAX_UPLOAD_BYTES', 10)
    fake_client = _FakeStreamClient(_FakeStreamResponse(200, {'content-type': 'image/png'}, [b'x' * 20]))
    monkeypatch.setattr(images.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    with pytest.raises(RuntimeError, match='большое'):
        asyncio.run(images.download_user_image_url('http://example.com/huge.png'))


def test_download_user_image_url_success(monkeypatch):
    fake_client = _FakeStreamClient(_FakeStreamResponse(200, {'content-type': 'image/png'}, [b'fake-bytes']))
    monkeypatch.setattr(images.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    content, ext = asyncio.run(images.download_user_image_url('http://example.com/pic.png'))

    assert content == b'fake-bytes'
    assert ext == 'png'


def test_save_uploaded_image_writes_file_with_upload_marker(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_DATA_DIR', str(tmp_path))
    from app import storage

    image = images.save_uploaded_image('poem-a', 0, b'fake-bytes', 'png')

    assert image['model'] == 'upload'
    assert image['aspect_ratio'] is None
    assert image['cost'] == 0
    assert image['rating'] == 0
    assert image['is_selected'] is False
    written = storage.project_dir('poem-a') / image['file_path']
    assert written.is_file()


def _png(width, height, rgb=(30, 60, 90)):
    arr = np.zeros((height, width, 3), dtype=np.uint8)
    arr[:, :, :] = rgb
    out = io.BytesIO()
    Image.fromarray(arr, 'RGB').save(out, 'PNG')
    return out.getvalue()


def _save_scene_image(slug, image_bytes, image_id='img_src1', scene_index=0):
    """Seeds a minimal project with one scene whose `images` holds one real
    PNG on disk - `crop_image` always PIL-opens the source, so (unlike
    `remove_background`'s tests) arbitrary non-image bytes won't do here."""
    from app import storage
    images_dir = storage.project_dir(slug) / 'images'
    images_dir.mkdir(parents=True, exist_ok=True)
    filename = f'scene_{scene_index + 1}_src.png'
    (images_dir / filename).write_bytes(image_bytes)
    source_image = {
        'image_id': image_id, 'file_path': f'images/{filename}', 'rating': 0, 'is_selected': False,
        'generated_at': '', 'model': 'google:imagen-4.0-generate-001', 'aspect_ratio': '1:1', 'cost': 0.02,
    }
    scenes = [{'images': []} for _ in range(scene_index)] + [{'images': [source_image]}]
    storage.save_project(slug, {'id': slug, 'scenes': scenes})
    return source_image


def test_crop_image_inbounds_makes_no_network_call_and_appends_free_crop(tmp_path, monkeypatch, usage_ledger):
    from app import storage
    source = _save_scene_image('poem-a', _png(10, 10))

    def _no_client(**kwargs):
        raise AssertionError('in-bounds crop must not open an HTTP client')
    monkeypatch.setattr(images.httpx, 'AsyncClient', _no_client)

    ctx = usage_ledger.context('scene_image_crop', 'poem-a', {})
    result = asyncio.run(images.crop_image(
        'poem-a', 0, source['image_id'], {'x': 2, 'y': 2, 'width': 4, 'height': 4}, {'api_keys': {}}, usage_ctx=ctx,
    ))

    new_image = result['image']
    assert new_image['model'] == 'local:crop'
    assert new_image['cost'] == 0.0
    assert new_image['source_image_id'] == source['image_id']
    new_file = storage.project_dir('poem-a') / new_image['file_path']
    with Image.open(new_file) as cropped:
        assert cropped.size == (4, 4)
    project = storage.load_project('poem-a')
    assert project['scenes'][0]['images'] == [source, new_image]


def test_crop_image_right_overflow_fast_mode_calls_outpaint_once(tmp_path, monkeypatch, usage_ledger):
    from app import storage
    source = _save_scene_image('poem-a', _png(10, 10))

    _install(monkeypatch, [
        _FakeResponse(200, {'status_url': 'https://q/status', 'response_url': 'https://q/result', 'status': 'COMPLETED'}),
        _FakeResponse(200, {'images': [{'url': 'https://cdn.example/out.png'}]}),
        _FakeResponse(200, content=_png(14, 10), headers={'content-type': 'image/png'}),
    ])

    ctx = usage_ledger.context('scene_image_crop', 'poem-a', {})
    result = asyncio.run(images.crop_image(
        'poem-a', 0, source['image_id'], {'x': 0, 'y': 0, 'width': 14, 'height': 10}, {'api_keys': {'fal': 'k'}},
        usage_ctx=ctx, quality='fast',
    ))

    new_image = result['image']
    assert new_image['model'] == 'fal:fal-ai/flux-2-pro/outpaint'
    assert new_image['cost'] > 0
    new_file = storage.project_dir('poem-a') / new_image['file_path']
    with Image.open(new_file) as cropped:
        assert cropped.size == (14, 10)


def test_crop_image_quality_mode_with_only_left_overflow_skips_primary_call(tmp_path, monkeypatch, usage_ledger):
    """Only the left side overflows, so the "primary" (right/top/bottom)
    outpaint call would be asking FAL to expand by 0px on every side -
    `_outpaint_with_quality` skips it and reuses the source image directly,
    so only one FAL call (the mirrored left-edge one) happens; the 3-item
    fake queue below would under-run if a second call were made."""
    from app import storage
    source = _save_scene_image('poem-a', _png(10, 10))

    _install(monkeypatch, [
        _FakeResponse(200, {'status_url': 'https://q/status', 'response_url': 'https://q/result', 'status': 'COMPLETED'}),
        _FakeResponse(200, {'images': [{'url': 'https://cdn.example/left.png'}]}),
        _FakeResponse(200, content=_png(13, 10), headers={'content-type': 'image/png'}),
    ])

    ctx = usage_ledger.context('scene_image_crop', 'poem-a', {})
    result = asyncio.run(images.crop_image(
        'poem-a', 0, source['image_id'], {'x': -3, 'y': 0, 'width': 13, 'height': 10}, {'api_keys': {'fal': 'k'}},
        usage_ctx=ctx, quality='quality',
    ))

    new_image = result['image']
    assert new_image['model'] == 'fal:fal-ai/flux-2-pro/outpaint'
    new_file = storage.project_dir('poem-a') / new_image['file_path']
    with Image.open(new_file) as cropped:
        assert cropped.size == (13, 10)


def test_crop_image_missing_image_raises_value_error(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_DATA_DIR', str(tmp_path))
    from app import storage
    storage.save_project('poem-a', {'id': 'poem-a', 'scenes': [{'images': []}]})

    with pytest.raises(ValueError, match='Image not found'):
        asyncio.run(images.crop_image(
            'poem-a', 0, 'does-not-exist', {'x': 0, 'y': 0, 'width': 4, 'height': 4}, {'api_keys': {}},
        ))


def test_crop_image_too_large_selection_raises_outpaint_too_large_error(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_DATA_DIR', str(tmp_path))
    source = _save_scene_image('poem-a', _png(10, 10))

    with pytest.raises(images.OutpaintTooLargeError):
        asyncio.run(images.crop_image(
            'poem-a', 0, source['image_id'], {'x': 0, 'y': 0, 'width': 3000, 'height': 10}, {'api_keys': {}},
        ))
