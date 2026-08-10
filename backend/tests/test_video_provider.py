import asyncio
import base64

import pytest

from app.providers import video


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
    site under test, popped in call order across submit/poll/download -
    mirrors test_images_provider.py's fake client."""

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
    async def __call__(self, *args, **kwargs):
        await _real_sleep(0)


@pytest.fixture(autouse=True)
def _no_real_sleep(monkeypatch):
    monkeypatch.setattr(video.asyncio, 'sleep', _FastSleep())


def _install(monkeypatch, responses):
    fake_client = _FakeAsyncClient(responses)
    monkeypatch.setattr(video.httpx, 'AsyncClient', lambda **kwargs: fake_client)
    return fake_client


# ---------- build_prompt / _nearest_google_duration (pure helpers) ----------

def test_build_prompt_no_wishes_returns_motion_prompt_unchanged():
    assert video.build_prompt('camera slowly zooms in', None) == 'camera slowly zooms in'


def test_build_prompt_appends_numbered_wishes_block():
    prompt = video.build_prompt('camera slowly zooms in', ['no sudden cuts', 'keep it dreamy'])
    assert prompt.startswith('camera slowly zooms in')
    assert 'ВАЖНЫЕ ТРЕБОВАНИЯ ПОЛЬЗОВАТЕЛЯ' in prompt
    assert '1. no sudden cuts' in prompt
    assert '2. keep it dreamy' in prompt


@pytest.mark.parametrize('seconds,expected', [(3, '4'), (4, '4'), (5, '4'), (6, '6'), (7, '6'), (8, '8'), (100, '8')])
def test_nearest_google_duration_rounds_to_supported_values(seconds, expected):
    assert video._nearest_google_duration(seconds) == expected


# ---------- Google Veo ----------

def test_generate_google_veo_success(monkeypatch):
    op_response = {
        'done': True,
        'response': {
            'generateVideoResponse': {'generatedSamples': [{'video': {'uri': 'https://files.example/vid1'}}]},
        },
    }
    fake_client = _install(monkeypatch, [
        _FakeResponse(200, {'name': 'models/veo-3.1-generate-preview/operations/op1'}),
        _FakeResponse(200, op_response),
        _FakeResponse(200, content=b'MP4DATA'),
    ])

    usage_out = {}
    content, ext = asyncio.run(video._generate_google_veo(
        'veo-3.1-generate-preview', 'a prompt', 'test-key', b'IMGBYTES', 'image/png',
        usage_out=usage_out, aspect_ratio='16:9', resolution='720p', duration_seconds=6,
    ))

    assert content == b'MP4DATA'
    assert ext == 'mp4'
    assert usage_out['units'] == {'seconds': 6}

    submit_call = fake_client.calls[0]
    assert submit_call['url'] == 'https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning'
    assert submit_call['params'] == {'key': 'test-key'}
    assert submit_call['json']['parameters'] == {'durationSeconds': '6', 'aspectRatio': '16:9', 'resolution': '720p'}
    image_part = submit_call['json']['instances'][0]['image']['inlineData']
    assert image_part['mimeType'] == 'image/png'
    assert base64.b64decode(image_part['data']) == b'IMGBYTES'

    poll_call = fake_client.calls[1]
    assert poll_call['url'] == 'https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview/operations/op1'
    assert poll_call['params'] == {'key': 'test-key'}

    download_call = fake_client.calls[2]
    assert download_call['url'] == 'https://files.example/vid1'
    assert download_call['params'] == {'key': 'test-key'}


def test_generate_google_veo_missing_key_raises():
    with pytest.raises(RuntimeError, match='Google'):
        asyncio.run(video._generate_google_veo('veo-3.1-generate-preview', 'p', '', b'x', 'image/png'))


def test_generate_google_veo_polls_until_done(monkeypatch):
    op_response = {
        'done': True,
        'response': {
            'generateVideoResponse': {'generatedSamples': [{'video': {'uri': 'https://files.example/vid1'}}]},
        },
    }
    _install(monkeypatch, [
        _FakeResponse(200, {'name': 'operations/op1'}),
        _FakeResponse(200, {'done': False}),
        _FakeResponse(200, {'done': False}),
        _FakeResponse(200, op_response),
        _FakeResponse(200, content=b'MP4DATA'),
    ])

    content, ext = asyncio.run(video._generate_google_veo(
        'veo-3.1-generate-preview', 'p', 'key', b'x', 'image/png',
    ))
    assert content == b'MP4DATA'
    assert ext == 'mp4'


def test_generate_google_veo_operation_error_raises(monkeypatch):
    _install(monkeypatch, [
        _FakeResponse(200, {'name': 'operations/op1'}),
        _FakeResponse(200, {'done': True, 'error': {'message': 'blocked by safety filters'}}),
    ])
    with pytest.raises(RuntimeError, match='blocked by safety filters'):
        asyncio.run(video._generate_google_veo('veo-3.1-generate-preview', 'p', 'key', b'x', 'image/png'))


def test_generate_google_veo_error_status_raises(monkeypatch):
    _install(monkeypatch, [_FakeResponse(500, text='boom')])
    with pytest.raises(RuntimeError, match='500'):
        asyncio.run(video._generate_google_veo('veo-3.1-generate-preview', 'p', 'key', b'x', 'image/png'))


# ---------- OpenRouter Unified Video API ----------

def test_generate_openrouter_video_success(monkeypatch):
    fake_client = _install(monkeypatch, [
        _FakeResponse(202, {'id': 'job1', 'status': 'pending', 'polling_url': 'https://openrouter.ai/api/v1/videos/job1'}),
        _FakeResponse(200, {'id': 'job1', 'status': 'in_progress'}),
        _FakeResponse(200, {'id': 'job1', 'status': 'completed', 'unsigned_urls': ['https://cdn.example/vid.mp4'], 'usage': {'cost': 0.6}}),
        _FakeResponse(200, content=b'MP4DATA'),
    ])

    usage_out = {}
    content, ext = asyncio.run(video._generate_openrouter_video(
        'google/veo-3.1', 'a prompt', 'test-key', b'IMGBYTES', 'image/png',
        usage_out=usage_out, aspect_ratio='9:16', resolution='1080p', duration_seconds=5,
    ))

    assert content == b'MP4DATA'
    assert ext == 'mp4'
    assert usage_out['cost'] == 0.6

    submit_call = fake_client.calls[0]
    assert submit_call['url'] == 'https://openrouter.ai/api/v1/videos'
    assert submit_call['headers']['Authorization'] == 'Bearer test-key'
    body = submit_call['json']
    assert body['model'] == 'google/veo-3.1'
    assert body['duration'] == 5
    assert body['resolution'] == '1080p'
    assert body['aspect_ratio'] == '9:16'
    frame = body['frame_images'][0]
    assert frame['frame_type'] == 'first_frame'
    assert frame['image_url']['url'].startswith('data:image/png;base64,')

    poll_call = fake_client.calls[1]
    assert poll_call['url'] == 'https://openrouter.ai/api/v1/videos/job1'

    download_call = fake_client.calls[3]
    assert download_call['url'] == 'https://cdn.example/vid.mp4'
    assert download_call['headers']['Authorization'] == 'Bearer test-key'


def test_generate_openrouter_video_missing_key_raises():
    with pytest.raises(RuntimeError, match='OpenRouter'):
        asyncio.run(video._generate_openrouter_video('google/veo-3.1', 'p', '', b'x', 'image/png'))


def test_generate_openrouter_video_failed_status_raises(monkeypatch):
    _install(monkeypatch, [
        _FakeResponse(202, {'id': 'job1', 'status': 'pending'}),
        _FakeResponse(200, {'id': 'job1', 'status': 'failed', 'error': 'moderation blocked'}),
    ])
    with pytest.raises(RuntimeError, match='moderation blocked'):
        asyncio.run(video._generate_openrouter_video('google/veo-3.1', 'p', 'key', b'x', 'image/png'))


def test_generate_openrouter_video_empty_urls_raises(monkeypatch):
    _install(monkeypatch, [
        _FakeResponse(202, {'id': 'job1', 'status': 'pending'}),
        _FakeResponse(200, {'id': 'job1', 'status': 'completed', 'unsigned_urls': []}),
    ])
    with pytest.raises(RuntimeError, match='URL видео'):
        asyncio.run(video._generate_openrouter_video('google/veo-3.1', 'p', 'key', b'x', 'image/png'))


# ---------- start_jobs / get_job ----------

def test_start_jobs_unknown_provider_fails_job(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_DATA_DIR', str(tmp_path))
    from app import storage
    storage.save_project('poem-a', {'id': 'poem-a', 'scenes': [{'images': [], 'videos': []}]})

    async def scenario():
        job_ids = video.start_jobs(
            'poem-a', 0, 'prompt', 'images/does-not-matter.png', 'img_1', 1, 'unknownprovider:x', {'api_keys': {}},
        )
        for _ in range(200):
            job = video.get_job(job_ids[0])
            if job['status'] != 'pending':
                return job
            await asyncio.sleep(0)
        raise AssertionError('job did not resolve')

    job = asyncio.run(scenario())
    assert job['status'] == 'failed'
    assert 'unknownprovider' in job['error']


def test_get_job_unknown_id_returns_none():
    assert video.get_job('does-not-exist') is None


@pytest.fixture
def usage_ledger(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_DATA_DIR', str(tmp_path))
    from app import usage as usage_module
    return usage_module


def _seed_scene_with_image(slug, image_bytes=b'PNGDATA'):
    from app import storage
    images_dir = storage.project_dir(slug) / 'images'
    images_dir.mkdir(parents=True, exist_ok=True)
    (images_dir / 'scene_1_src.png').write_bytes(image_bytes)
    storage.save_project(slug, {'id': slug, 'scenes': [{'images': [
        {'image_id': 'img_src1', 'file_path': 'images/scene_1_src.png', 'rating': 0, 'is_selected': True},
    ], 'videos': []}]})


def test_start_jobs_records_usage_and_stores_video_on_success(monkeypatch, usage_ledger):
    _seed_scene_with_image('poem-a')
    op_response = {
        'done': True,
        'response': {
            'generateVideoResponse': {'generatedSamples': [{'video': {'uri': 'https://files.example/vid1'}}]},
        },
    }
    _install(monkeypatch, [
        _FakeResponse(200, {'name': 'operations/op1'}),
        _FakeResponse(200, op_response),
        _FakeResponse(200, content=b'MP4DATA'),
    ])

    async def scenario():
        ctx = usage_ledger.context('scene_video', 'poem-a', {}, scene_index=0, count=1)
        job_ids = video.start_jobs(
            'poem-a', 0, 'camera pans left', 'images/scene_1_src.png', 'img_src1', 1,
            'google:veo-3.1-generate-preview', {'api_keys': {'google': 'k'}},
            usage_ctx=ctx, aspect_ratio='16:9', resolution='720p', duration_seconds=6,
        )
        for _ in range(200):
            job = video.get_job(job_ids[0])
            if job['status'] != 'pending':
                return job
            await asyncio.sleep(0)
        raise AssertionError('job did not resolve')

    job = asyncio.run(scenario())
    assert job['status'] == 'completed'
    v = job['video']
    assert v['model'] == 'google:veo-3.1-generate-preview'
    assert v['motion_prompt'] == 'camera pans left'
    assert v['source_image_id'] == 'img_src1'
    assert v['duration_seconds'] == 6
    assert v['cost'] == pytest.approx(6 * 0.40)
    assert v['generation_ms'] >= 0

    from app import storage
    project = storage.load_project('poem-a')
    assert project['scenes'][0]['videos'] == [v]

    records = usage_ledger.query()['records']
    assert len(records) == 1
    rec = records[0]
    assert rec['task'] == 'scene_video'
    assert rec['units']['seconds'] == 6
    assert rec['cost']['source'] == 'catalog'


def test_start_jobs_openrouter_provider_cost_wins(monkeypatch, usage_ledger):
    _seed_scene_with_image('poem-a')
    _install(monkeypatch, [
        _FakeResponse(202, {'id': 'job1', 'status': 'pending'}),
        _FakeResponse(200, {'id': 'job1', 'status': 'completed', 'unsigned_urls': ['https://cdn.example/vid.mp4'], 'usage': {'cost': 0.6}}),
        _FakeResponse(200, content=b'MP4DATA'),
    ])

    async def scenario():
        ctx = usage_ledger.context('scene_video', 'poem-a', {}, scene_index=0, count=1)
        job_ids = video.start_jobs(
            'poem-a', 0, 'camera pans left', 'images/scene_1_src.png', 'img_src1', 1,
            'openrouter:google/veo-3.1', {'api_keys': {'openrouter': 'k'}}, usage_ctx=ctx,
        )
        for _ in range(200):
            job = video.get_job(job_ids[0])
            if job['status'] != 'pending':
                return job
            await asyncio.sleep(0)
        raise AssertionError('job did not resolve')

    job = asyncio.run(scenario())
    assert job['video']['cost'] == pytest.approx(0.6)
    rec = usage_ledger.query()['records'][0]
    assert rec['cost']['source'] == 'provider'
    assert rec['cost']['amount'] == pytest.approx(0.6)


def test_start_jobs_records_error_status_on_failure(monkeypatch, usage_ledger):
    _seed_scene_with_image('poem-a')

    async def scenario():
        ctx = usage_ledger.context('scene_video', 'poem-a', {}, scene_index=0, count=1)
        job_ids = video.start_jobs(
            'poem-a', 0, 'prompt', 'images/scene_1_src.png', 'img_src1', 1, 'unknownprovider:x', {'api_keys': {}},
            usage_ctx=ctx,
        )
        for _ in range(200):
            job = video.get_job(job_ids[0])
            if job['status'] != 'pending':
                return job
            await asyncio.sleep(0)
        raise AssertionError('job did not resolve')

    asyncio.run(scenario())
    rec = usage_ledger.query()['records'][0]
    assert rec['status'] == 'error'
    assert rec['cost']['amount'] is None
