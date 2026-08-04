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


def test_add_suno_wish_creates_card_and_activates_it_for_project(client):
    pid = client.get('/api/projects').json()[0]['id']
    before = client.get(f'/api/projects/{pid}').json()

    resp = client.post(f'/api/projects/{pid}/suno/wishes', json={'text': 'Add more jazz'})

    assert resp.status_code == 200
    body = resp.json()
    wish = body['wish']
    assert wish['text'] == 'Add more jazz'
    assert wish['title']
    assert body['active_wish_ids'] == [wish['id']]
    assert any(w['id'] == wish['id'] for w in body['suno_wish_library'])

    # skill_prompt is left untouched - no more folding the wish into it
    saved = client.get(f'/api/projects/{pid}').json()
    assert saved['active_wish_ids'] == [wish['id']]
    assert saved['skill_prompt'] == before['skill_prompt']
    assert saved['refinement_comments'] == []

    settings = client.get('/api/settings').json()
    assert any(w['id'] == wish['id'] for w in settings['suno_wish_library'])


def test_add_suno_wish_reuses_existing_card_by_text(client):
    pid = client.get('/api/projects').json()[0]['id']
    first = client.post(f'/api/projects/{pid}/suno/wishes', json={'text': 'Saxophone solo'}).json()
    second = client.post(f'/api/projects/{pid}/suno/wishes', json={'text': 'Saxophone solo'}).json()

    assert first['wish']['id'] == second['wish']['id']
    assert second['active_wish_ids'] == [first['wish']['id']]


def test_add_suno_wish_cleans_and_titles_via_configured_simple_model(client, monkeypatch):
    from app.providers import text_models

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {'candidates': [{'content': {'parts': [{
                'text': '===WISH===\nДобавь больше саксофона\n===TITLE===\n🎷 Больше саксофона',
            }]}}]}

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
    resp = client.post(f'/api/projects/{pid}/suno/wishes', json={'text': 'саксофона саксофона побольше эм'})

    assert resp.status_code == 200
    wish = resp.json()['wish']
    assert wish['text'] == 'Добавь больше саксофона'
    assert wish['title'] == '🎷 Больше саксофона'


def test_add_suno_wish_rejects_blank_text(client):
    pid = client.get('/api/projects').json()[0]['id']
    assert client.post(f'/api/projects/{pid}/suno/wishes', json={'text': '  '}).status_code == 422


def test_generate_suno_sends_active_wishes_as_resolved_list(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    added = client.post(f'/api/projects/{pid}/suno/wishes', json={'text': 'Add more jazz'}).json()
    fake_generate = AsyncMock(return_value={'style': 'S', 'lyrics': 'L'})
    monkeypatch.setattr(generation_router.suno, 'generate', fake_generate)

    client.post(f'/api/projects/{pid}/suno/generate', json={'active_wish_ids': [added['wish']['id']]})

    assert fake_generate.call_args.kwargs['active_wishes'] == ['Add more jazz']


def test_generate_suno_falls_back_to_projects_active_wish_ids_when_not_sent(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    client.post(f'/api/projects/{pid}/suno/wishes', json={'text': 'Add more jazz'})
    fake_generate = AsyncMock(return_value={'style': 'S', 'lyrics': 'L'})
    monkeypatch.setattr(generation_router.suno, 'generate', fake_generate)

    client.post(f'/api/projects/{pid}/suno/generate', json={})

    assert fake_generate.call_args.kwargs['active_wishes'] == ['Add more jazz']


def test_generate_scenes_calls_provider_seam_and_persists(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    canned = [{'lyric_segment': 'X', 'static_prompt': 'sp', 'motion_prompt': 'mp', 'images': []}]
    monkeypatch.setattr(generation_router.scenes, 'generate', AsyncMock(return_value={'scenes': canned, 'debug': {'stub': True}}))

    resp = client.post(
        f'/api/projects/{pid}/scenes/generate',
        json={'style_description': 'Neon noir', 'scene_count': 1},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body['scenes'] == canned
    assert body['style_description'] == 'Neon noir'
    assert body['scene_mode'] == 'narrative'
    saved = client.get(f'/api/projects/{pid}').json()
    assert saved['scenes'] == canned
    assert saved['style_description'] == 'Neon noir'


def test_generate_scenes_missing_project_returns_404(client):
    assert client.post('/api/projects/does-not-exist/scenes/generate', json={}).status_code == 404


def test_generate_scenes_forwards_model_to_provider(client, monkeypatch):
    """The scene-text model picker sends `model`; the router must forward it
    to the provider seam even though the stub itself ignores it."""
    pid = client.get('/api/projects').json()[0]['id']
    fake_generate = AsyncMock(return_value={'scenes': [], 'debug': {'stub': True}})
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


def test_generate_scene_images_forwards_aspect_ratio(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    captured = {}

    def fake_start_jobs(*args, **kwargs):
        captured.update(kwargs)
        return ['job_1']

    monkeypatch.setattr(generation_router.images, 'start_jobs', fake_start_jobs)

    client.post(f'/api/projects/{pid}/scenes/2/images', json={'count': 1, 'model': 'krea:krea/krea-2/medium', 'aspect_ratio': '9:16'})

    assert captured['aspect_ratio'] == '9:16'


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


def test_add_suno_wish_missing_project_returns_404(client):
    assert client.post(
        '/api/projects/does-not-exist/suno/wishes', json={'text': 'hi'},
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


def test_delete_scene_image_removes_file_and_entry(client, monkeypatch):
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
    job_id = client.post(
        f'/api/projects/{pid}/scenes/2/images', json={'count': 1, 'model': 'google:imagen-4.0-generate-001'},
    ).json()['job_ids'][0]
    image = _poll_until_done(client, pid, 2, job_id)['image']

    data_root = Path(os.environ['APP_DATA_DIR'])
    file_path = data_root / 'projects' / pid / image['file_path']
    assert file_path.is_file()

    resp = client.delete(f'/api/projects/{pid}/scenes/2/images/{image["image_id"]}')

    assert resp.status_code == 200
    assert resp.json()['images'] == []
    assert not file_path.is_file()
    saved = client.get(f'/api/projects/{pid}').json()
    assert saved['scenes'][2]['images'] == []


def test_delete_scene_image_missing_image_returns_404(client):
    pid = client.get('/api/projects').json()[0]['id']
    assert client.delete(f'/api/projects/{pid}/scenes/2/images/does-not-exist').status_code == 404


def test_delete_scene_image_out_of_range_scene_returns_404(client):
    pid = client.get('/api/projects').json()[0]['id']
    assert client.delete(f'/api/projects/{pid}/scenes/99/images/x').status_code == 404


def test_upload_scene_image_file_writes_file_and_appends(client):
    pid = client.get('/api/projects').json()[0]['id']
    before = len(client.get(f'/api/projects/{pid}').json()['scenes'][2]['images'])

    resp = client.post(
        f'/api/projects/{pid}/scenes/2/images/upload',
        files={'file': ('mine.png', b'fake-png-bytes', 'image/png')},
    )

    assert resp.status_code == 200
    image = resp.json()['image']
    assert image['model'] == 'upload'
    assert image['file_path'].startswith('images/scene_3_') and image['file_path'].endswith('.png')

    data_root = Path(os.environ['APP_DATA_DIR'])
    written = data_root / 'projects' / pid / image['file_path']
    assert written.is_file()
    assert written.read_bytes() == b'fake-png-bytes'

    saved = client.get(f'/api/projects/{pid}').json()
    assert len(saved['scenes'][2]['images']) == before + 1
    assert saved['scenes'][2]['images'][-1]['image_id'] == image['image_id']


def test_upload_scene_image_rejects_bad_extension(client):
    pid = client.get('/api/projects').json()[0]['id']
    resp = client.post(
        f'/api/projects/{pid}/scenes/2/images/upload',
        files={'file': ('notes.txt', b'hello', 'text/plain')},
    )
    assert resp.status_code == 415


def test_upload_scene_image_requires_file_or_url(client):
    pid = client.get('/api/projects').json()[0]['id']
    assert client.post(f'/api/projects/{pid}/scenes/2/images/upload').status_code == 422


def test_upload_scene_image_rejects_both_file_and_url(client):
    pid = client.get('/api/projects').json()[0]['id']
    resp = client.post(
        f'/api/projects/{pid}/scenes/2/images/upload',
        files={'file': ('mine.png', b'data', 'image/png')},
        data={'url': 'http://example.com/x.png'},
    )
    assert resp.status_code == 422


def test_upload_scene_image_out_of_range_scene_returns_404(client):
    pid = client.get('/api/projects').json()[0]['id']
    resp = client.post(
        f'/api/projects/{pid}/scenes/99/images/upload',
        files={'file': ('mine.png', b'data', 'image/png')},
    )
    assert resp.status_code == 404


def test_upload_scene_image_from_url_uses_download_helper(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    fake_download = AsyncMock(return_value=(b'downloaded-bytes', 'jpg'))
    monkeypatch.setattr(generation_router.images, 'download_user_image_url', fake_download)

    resp = client.post(
        f'/api/projects/{pid}/scenes/2/images/upload',
        data={'url': 'http://example.com/pic.jpg'},
    )

    assert resp.status_code == 200
    image = resp.json()['image']
    assert image['file_path'].endswith('.jpg')
    fake_download.assert_awaited_once_with('http://example.com/pic.jpg')

    data_root = Path(os.environ['APP_DATA_DIR'])
    written = data_root / 'projects' / pid / image['file_path']
    assert written.read_bytes() == b'downloaded-bytes'


def test_upload_scene_image_from_url_surfaces_ssrf_rejection(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']

    async def _reject(url):
        raise RuntimeError('Ссылка указывает на недопустимый адрес')

    monkeypatch.setattr(generation_router.images, 'download_user_image_url', _reject)

    resp = client.post(
        f'/api/projects/{pid}/scenes/2/images/upload',
        data={'url': 'http://127.0.0.1/x.png'},
    )

    assert resp.status_code == 422


# ---------- title-card ----------

def _upload_reference(client, pid, filename='style.png'):
    resp = client.post(
        f'/api/projects/{pid}/reference-images',
        files={'file': (filename, b'fake-png-bytes', 'image/png')},
    )
    return resp.json()['reference_images'][-1]


def test_generate_title_card_starts_jobs_and_forwards_fields(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    ref_path = _upload_reference(client, pid)
    captured = {}

    def fake_start_jobs(*args, **kwargs):
        captured['args'] = args
        captured['kwargs'] = kwargs
        return ['job_1', 'job_2']

    monkeypatch.setattr(generation_router.title_card, 'start_jobs', fake_start_jobs)

    resp = client.post(f'/api/projects/{pid}/title-card/generate', json={
        'title_text': 'Зимнее утро', 'author_text': 'Пушкин', 'base_prompt': 'base',
        'reference_image_paths': [ref_path], 'model': 'google:gemini-3.1-flash-lite-image',
        'aspect_ratio': '16:9', 'count': 2,
    })

    assert resp.status_code == 200
    assert resp.json() == {'job_ids': ['job_1', 'job_2']}
    assert captured['args'][0] == pid
    assert captured['args'][1] == [ref_path]
    assert captured['args'][2] == 'Зимнее утро'
    assert captured['args'][3] == 'Пушкин'
    assert captured['kwargs']['aspect_ratio'] == '16:9'


def test_generate_title_card_missing_project_returns_404(client):
    resp = client.post('/api/projects/does-not-exist/title-card/generate', json={'reference_image_paths': ['references/x.png']})
    assert resp.status_code == 404


def test_generate_title_card_requires_reference_paths(client):
    pid = client.get('/api/projects').json()[0]['id']
    resp = client.post(f'/api/projects/{pid}/title-card/generate', json={'reference_image_paths': []})
    assert resp.status_code == 422


def test_generate_title_card_rejects_more_than_four_references(client):
    pid = client.get('/api/projects').json()[0]['id']
    ref_path = _upload_reference(client, pid)
    resp = client.post(f'/api/projects/{pid}/title-card/generate', json={
        'reference_image_paths': [ref_path, ref_path, ref_path, ref_path, ref_path],
    })
    assert resp.status_code == 422


def test_generate_title_card_rejects_nonexistent_reference(client):
    pid = client.get('/api/projects').json()[0]['id']
    resp = client.post(f'/api/projects/{pid}/title-card/generate', json={
        'reference_image_paths': ['references/does-not-exist.png'],
    })
    assert resp.status_code == 422


def test_generate_title_card_rejects_path_escaping_project_dir(client):
    pid = client.get('/api/projects').json()[0]['id']
    resp = client.post(f'/api/projects/{pid}/title-card/generate', json={
        'reference_image_paths': ['../../etc/passwd'],
    })
    assert resp.status_code == 422


def test_get_title_card_job_returns_status(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    variant = {'variant_id': 'tc_x', 'file_path': 'titlecard/x.png', 'rating': 0, 'is_selected': False, 'generated_at': 'now'}
    monkeypatch.setattr(generation_router.title_card, 'get_job', lambda job_id: {'status': 'completed', 'variant': variant, 'error': None})

    resp = client.get(f'/api/projects/{pid}/title-card/jobs/job_1')

    assert resp.status_code == 200
    assert resp.json() == {'status': 'completed', 'variant': variant, 'error': None}


def test_get_title_card_job_missing_returns_404(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    monkeypatch.setattr(generation_router.title_card, 'get_job', lambda job_id: None)

    resp = client.get(f'/api/projects/{pid}/title-card/jobs/does-not-exist')

    assert resp.status_code == 404


def _poll_title_card_until_done(client, pid, job_id, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = client.get(f'/api/projects/{pid}/title-card/jobs/{job_id}').json()
        if job['status'] != 'pending':
            return job
        time.sleep(0.05)
    raise AssertionError('Job did not complete in time')


def test_generate_title_card_end_to_end_with_google_writes_file_and_persists(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    ref_path = _upload_reference(client, pid)
    settings = client.get('/api/settings').json()
    settings['api_keys']['google'] = 'test-key'
    client.put('/api/settings', json=settings)

    import base64
    payload = {'candidates': [{'content': {'parts': [
        {'inlineData': {'data': base64.b64encode(b'PNGDATA').decode(), 'mimeType': 'image/png'}},
    ]}}]}
    fake_client = _FakeImagesAsyncClient([_FakeImagesResponse(200, payload)])
    monkeypatch.setattr(generation_router.title_card.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    resp = client.post(f'/api/projects/{pid}/title-card/generate', json={
        'title_text': 'Зимнее утро', 'author_text': 'Пушкин', 'base_prompt': 'base instructions',
        'reference_image_paths': [ref_path], 'model': 'google:gemini-3.1-flash-lite-image',
    })
    assert resp.status_code == 200
    job_id = resp.json()['job_ids'][0]

    job = _poll_title_card_until_done(client, pid, job_id)

    assert job['status'] == 'completed'
    variant = job['variant']
    assert variant['file_path'].startswith('titlecard/') and variant['file_path'].endswith('.png')
    assert variant['title_text'] == 'Зимнее утро'
    assert variant['author_text'] == 'Пушкин'
    assert variant['reference_image_paths'] == [ref_path]

    data_root = Path(os.environ['APP_DATA_DIR'])
    written = data_root / 'projects' / pid / variant['file_path']
    assert written.is_file()
    assert written.read_bytes() == b'PNGDATA'

    saved = client.get(f'/api/projects/{pid}').json()
    assert saved['title_card']['variants'][-1] == variant


def test_delete_title_card_variant_removes_file_and_entry(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    ref_path = _upload_reference(client, pid)
    settings = client.get('/api/settings').json()
    settings['api_keys']['google'] = 'test-key'
    client.put('/api/settings', json=settings)

    import base64
    payload = {'candidates': [{'content': {'parts': [
        {'inlineData': {'data': base64.b64encode(b'PNGDATA').decode(), 'mimeType': 'image/png'}},
    ]}}]}
    fake_client = _FakeImagesAsyncClient([_FakeImagesResponse(200, payload)])
    monkeypatch.setattr(generation_router.title_card.httpx, 'AsyncClient', lambda **kwargs: fake_client)
    job_id = client.post(f'/api/projects/{pid}/title-card/generate', json={
        'reference_image_paths': [ref_path], 'model': 'google:gemini-3.1-flash-lite-image',
    }).json()['job_ids'][0]
    variant = _poll_title_card_until_done(client, pid, job_id)['variant']

    data_root = Path(os.environ['APP_DATA_DIR'])
    file_path = data_root / 'projects' / pid / variant['file_path']
    assert file_path.is_file()

    resp = client.delete(f'/api/projects/{pid}/title-card/variants/{variant["variant_id"]}')

    assert resp.status_code == 200
    assert resp.json()['variants'] == []
    assert not file_path.is_file()
    saved = client.get(f'/api/projects/{pid}').json()
    assert saved['title_card']['variants'] == []


def test_delete_title_card_variant_missing_returns_404(client):
    pid = client.get('/api/projects').json()[0]['id']
    assert client.delete(f'/api/projects/{pid}/title-card/variants/does-not-exist').status_code == 404
