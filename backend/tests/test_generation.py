import os
import time
from pathlib import Path
from unittest.mock import AsyncMock

from app.routers import generation as generation_router


class _FakeImagesResponse:
    def __init__(self, status_code, payload=None, text=''):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self):
        return self._payload


class _FakeImagesAsyncClient:
    def __init__(self, responses):
        self._responses = list(responses)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, headers=None, json=None, params=None):
        return self._responses.pop(0)

    async def get(self, url, headers=None, params=None):
        return self._responses.pop(0)


def _poll_until_done(client, pid, scene_index, job_id, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = client.get(f'/api/projects/{pid}/scenes/{scene_index}/images/jobs/{job_id}').json()
        if job['status'] != 'pending':
            return job
        time.sleep(0.05)
    raise AssertionError('Job did not complete in time')


def test_generate_suno_calls_provider_seam_and_persists(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    monkeypatch.setattr(
        generation_router.suno, 'generate',
        AsyncMock(return_value={'style': 'Test Style', 'lyrics': 'Test Lyrics'}),
    )

    resp = client.post(
        f'/api/projects/{pid}/suno/generate',
        json={'skill_id': 'skill_b', 'skill_prompt': 'Custom prompt', 'model': 'gpt'},
    )

    assert resp.status_code == 200
    assert resp.json() == {
        'style': 'Test Style', 'lyrics': 'Test Lyrics', 'skill_id': 'skill_b', 'model_used': 'gpt',
    }
    saved = client.get(f'/api/projects/{pid}').json()
    assert saved['style'] == 'Test Style'
    assert saved['skill_id'] == 'skill_b'
    assert saved['skill_prompt'] == 'Custom prompt'
    assert saved['model_used'] == 'gpt'


def test_generate_suno_passes_usage_ctx_with_project_id_and_task(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    fake_generate = AsyncMock(return_value={'style': 'S', 'lyrics': 'L'})
    monkeypatch.setattr(generation_router.suno, 'generate', fake_generate)

    client.post(f'/api/projects/{pid}/suno/generate', json={'skill_id': 'skill_b'})

    usage_ctx = fake_generate.call_args.kwargs['usage_ctx']
    assert usage_ctx is not None
    assert usage_ctx['task'] == 'suno_generate'
    assert usage_ctx['project_id'] == pid
    assert usage_ctx['meta']['skill_id'] == 'skill_b'


def test_generate_suno_formats_lyrics_from_current_blocks(client):
    """The stub must reflect whatever blocks the Lyrics stage currently holds
    (order, repeated chorus, interlude tags) rather than any previously
    cached/canned lyrics text."""
    pid = client.get('/api/projects').json()[0]['id']
    project = client.get(f'/api/projects/{pid}').json()
    project['blocks'] = [
        {'id': 'b1', 'type': 'intro', 'importance': 3, 'content': 'Line one'},
        {'id': 'b2', 'type': 'interlude', 'importance': 3, 'content': '[Vocal Interlude]'},
        {'id': 'b3', 'type': 'verse', 'importance': 3, 'content': 'Line two'},
    ]
    project['lyrics'] = 'stale cached lyrics that should not be reused'
    client.patch(f'/api/projects/{pid}', json=project)

    resp = client.post(f'/api/projects/{pid}/suno/generate', json={})

    assert resp.json()['lyrics'] == '[Intro]\nLine one\n\n[Vocal Interlude]\n\n[Verse]\nLine two'


def test_refine_suno_rewrites_prompt_and_appends_comment_history(client):
    pid = client.get('/api/projects').json()[0]['id']
    before = client.get(f'/api/projects/{pid}').json()

    resp = client.post(f'/api/projects/{pid}/suno/refine', json={'comment': 'Add more jazz'})

    assert resp.status_code == 200
    body = resp.json()
    assert body['skill_prompt'].startswith(before['skill_prompt'].rstrip('.'))
    assert 'Add more jazz' in body['skill_prompt']
    assert body['refinement_comments'] == ['Add more jazz']

    saved = client.get(f'/api/projects/{pid}').json()
    assert saved['skill_prompt'] == body['skill_prompt']
    assert saved['refinement_comments'] == ['Add more jazz']

    resp2 = client.post(f'/api/projects/{pid}/suno/refine', json={'comment': 'Saxophone solo'})
    assert resp2.json()['refinement_comments'] == ['Add more jazz', 'Saxophone solo']


def test_refine_suno_cleans_comment_via_configured_simple_model(client, monkeypatch):
    from app.providers import text_models

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {'candidates': [{'content': {'parts': [{'text': 'Добавь больше саксофона'}]}}]}

    class _FakeAsyncClient:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            return False
        async def post(self, url, params=None, json=None):
            return _FakeResponse()

    monkeypatch.setattr(text_models.httpx, 'AsyncClient', lambda **kwargs: _FakeAsyncClient())
    client.put('/api/settings', json={
        'api_keys': {'google': 'test-key'},
        'simple_models': {'favorites': [], 'default': 'google:gemini-2.0-flash-lite'},
    })

    pid = client.get('/api/projects').json()[0]['id']
    resp = client.post(f'/api/projects/{pid}/suno/refine', json={'comment': 'саксофона саксофона побольше эм'})

    assert resp.status_code == 200
    body = resp.json()
    assert 'Добавь больше саксофона' in body['skill_prompt']
    assert body['refinement_comments'] == ['Добавь больше саксофона']


def test_refine_suno_rejects_blank_comment(client):
    pid = client.get('/api/projects').json()[0]['id']
    assert client.post(f'/api/projects/{pid}/suno/refine', json={'comment': '  '}).status_code == 422


def test_generate_scenes_calls_provider_seam_and_persists(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    canned = [{'lyric_segment': 'X', 'static_prompt': 'sp', 'motion_prompt': 'mp', 'images': []}]
    monkeypatch.setattr(generation_router.scenes, 'generate', AsyncMock(return_value=canned))

    resp = client.post(
        f'/api/projects/{pid}/scenes/generate',
        json={'style_description': 'Neon noir', 'scene_count': 1},
    )

    assert resp.status_code == 200
    assert resp.json() == {'scenes': canned, 'style_description': 'Neon noir'}
    saved = client.get(f'/api/projects/{pid}').json()
    assert saved['scenes'] == canned
    assert saved['style_description'] == 'Neon noir'


def test_generate_scenes_missing_project_returns_404(client):
    assert client.post('/api/projects/does-not-exist/scenes/generate', json={}).status_code == 404


def test_generate_scenes_forwards_model_to_provider(client, monkeypatch):
    """The scene-text model picker sends `model`; the router must forward it
    to the provider seam even though the stub itself ignores it."""
    pid = client.get('/api/projects').json()[0]['id']
    fake_generate = AsyncMock(return_value=[])
    monkeypatch.setattr(generation_router.scenes, 'generate', fake_generate)

    client.post(f'/api/projects/{pid}/scenes/generate', json={'model': 'google:gemini-2.5-flash'})

    assert fake_generate.call_args.kwargs['model'] == 'google:gemini-2.5-flash'


def test_generate_scene_images_starts_jobs_and_forwards_prompt_and_model(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    project = client.get(f'/api/projects/{pid}').json()
    project['scenes'][2]['static_prompt'] = 'a cinematic frame'
    client.patch(f'/api/projects/{pid}', json=project)
    monkeypatch.setattr(generation_router.images, 'start_jobs', lambda *a, **kw: ['job_1', 'job_2'])

    resp = client.post(f'/api/projects/{pid}/scenes/2/images', json={'count': 2, 'model': 'krea:krea/krea-2/medium'})

    assert resp.status_code == 200
    assert resp.json() == {'job_ids': ['job_1', 'job_2']}


def test_generate_scene_images_zero_count_returns_no_jobs(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    monkeypatch.setattr(generation_router.images, 'start_jobs', lambda *a, **kw: [])

    resp = client.post(f'/api/projects/{pid}/scenes/2/images', json={'count': 0})

    assert resp.json() == {'job_ids': []}


def test_generate_scene_images_out_of_range_returns_404(client):
    pid = client.get('/api/projects').json()[0]['id']
    assert client.post(f'/api/projects/{pid}/scenes/99/images', json={}).status_code == 404


def test_get_scene_image_job_returns_status(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    image = {'image_id': 'img_x', 'file_path': 'images/x.png', 'rating': 0, 'is_selected': False, 'generated_at': 'now'}
    monkeypatch.setattr(generation_router.images, 'get_job', lambda job_id: {'status': 'completed', 'image': image, 'error': None})

    resp = client.get(f'/api/projects/{pid}/scenes/2/images/jobs/job_1')

    assert resp.status_code == 200
    assert resp.json() == {'status': 'completed', 'image': image, 'error': None}


def test_get_scene_image_job_missing_returns_404(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    monkeypatch.setattr(generation_router.images, 'get_job', lambda job_id: None)

    resp = client.get(f'/api/projects/{pid}/scenes/2/images/jobs/does-not-exist')

    assert resp.status_code == 404


def test_generate_scene_images_end_to_end_with_google_writes_file_and_persists(client, monkeypatch):
    """Exercises the real job pipeline (router -> images.start_jobs -> background
    task -> disk write -> project persistence) with only the Google Imagen HTTP
    call itself mocked - see test_images_provider.py for per-provider request/
    response shape coverage."""
    pid = client.get('/api/projects').json()[0]['id']
    project = client.get(f'/api/projects/{pid}').json()
    project['scenes'][2]['static_prompt'] = 'a cinematic frame'
    settings = client.get('/api/settings').json()
    settings['api_keys']['google'] = 'test-key'
    client.patch(f'/api/projects/{pid}', json=project)
    client.put('/api/settings', json=settings)

    import base64
    payload = {'predictions': [{'bytesBase64Encoded': base64.b64encode(b'PNGDATA').decode(), 'mimeType': 'image/png'}]}
    fake_client = _FakeImagesAsyncClient([_FakeImagesResponse(200, payload)])
    monkeypatch.setattr(generation_router.images.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    resp = client.post(f'/api/projects/{pid}/scenes/2/images', json={'count': 1, 'model': 'google:imagen-4.0-generate-001'})
    assert resp.status_code == 200
    job_id = resp.json()['job_ids'][0]

    job = _poll_until_done(client, pid, 2, job_id)

    assert job['status'] == 'completed'
    image = job['image']
    assert image['file_path'].startswith('images/scene_3_') and image['file_path'].endswith('.png')
    assert image['rating'] == 0
    assert image['is_selected'] is False

    data_root = Path(os.environ['APP_DATA_DIR'])
    written = data_root / 'projects' / pid / image['file_path']
    assert written.is_file()
    assert written.read_bytes() == b'PNGDATA'

    saved = client.get(f'/api/projects/{pid}').json()
    assert saved['scenes'][2]['images'][-1] == image


def test_generate_suno_missing_project_returns_404(client):
    assert client.post('/api/projects/does-not-exist/suno/generate', json={}).status_code == 404


def test_refine_suno_missing_project_returns_404(client):
    assert client.post(
        '/api/projects/does-not-exist/suno/refine', json={'comment': 'hi'},
    ).status_code == 404


def test_upload_reference_image_writes_file_and_appends(client):
    pid = client.get('/api/projects').json()[0]['id']

    resp = client.post(
        f'/api/projects/{pid}/reference-images',
        files={'file': ('style.png', b'fake-png-bytes', 'image/png')},
    )

    assert resp.status_code == 200
    refs = resp.json()['reference_images']
    assert len(refs) == 1
    assert refs[0].startswith('references/ref_') and refs[0].endswith('.png')

    data_root = Path(os.environ['APP_DATA_DIR'])
    written = data_root / 'projects' / pid / refs[0]
    assert written.is_file()
    assert written.read_bytes() == b'fake-png-bytes'

    saved = client.get(f'/api/projects/{pid}').json()
    assert saved['reference_images'] == refs


def test_upload_reference_image_rejects_bad_extension(client):
    pid = client.get('/api/projects').json()[0]['id']
    resp = client.post(
        f'/api/projects/{pid}/reference-images',
        files={'file': ('notes.txt', b'hello', 'text/plain')},
    )
    assert resp.status_code == 415


def test_delete_reference_image_removes_file_and_entry(client):
    pid = client.get('/api/projects').json()[0]['id']
    upload = client.post(
        f'/api/projects/{pid}/reference-images',
        files={'file': ('style.jpg', b'fake-jpg-bytes', 'image/jpeg')},
    )
    filename = upload.json()['reference_images'][0].split('/', 1)[1]
    data_root = Path(os.environ['APP_DATA_DIR'])
    file_path = data_root / 'projects' / pid / 'references' / filename
    assert file_path.is_file()

    resp = client.delete(f'/api/projects/{pid}/reference-images/{filename}')

    assert resp.status_code == 200
    assert resp.json()['reference_images'] == []
    assert not file_path.is_file()
    saved = client.get(f'/api/projects/{pid}').json()
    assert saved['reference_images'] == []
