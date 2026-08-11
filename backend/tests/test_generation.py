import io
import os
import time
import zipfile
from pathlib import Path
from unittest.mock import AsyncMock

from PIL import Image

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


def test_generate_scene_videos_starts_jobs_and_forwards_selected_image(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    project = client.get(f'/api/projects/{pid}').json()
    selected_image = next(img for img in project['scenes'][0]['images'] if img['is_selected'])
    captured = {}

    def fake_start_jobs(*args, **kwargs):
        captured['args'] = args
        captured.update(kwargs)
        return ['job_1', 'job_2']

    monkeypatch.setattr(generation_router.video, 'start_jobs', fake_start_jobs)

    resp = client.post(
        f'/api/projects/{pid}/scenes/0/videos',
        json={'count': 2, 'model': 'openrouter:google/veo-3.1', 'aspect_ratio': '16:9'},
    )

    assert resp.status_code == 200
    assert resp.json() == {'job_ids': ['job_1', 'job_2']}
    # slug, scene_index, prompt, image_path, source_image_id, count, model, settings
    _slug, _scene_index, prompt, image_path, source_image_id, count, model, _settings = captured['args']
    assert image_path == selected_image['file_path']
    assert source_image_id == selected_image['image_id']
    assert count == 2
    assert model == 'openrouter:google/veo-3.1'
    assert 'Slow camera pan' in prompt  # scene 0's own motion_prompt from seed data
    assert captured['aspect_ratio'] == '16:9'


def test_generate_scene_videos_explicit_image_id_overrides_selected(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    project = client.get(f'/api/projects/{pid}').json()
    non_selected = next(img for img in project['scenes'][0]['images'] if not img['is_selected'])
    captured = {}
    monkeypatch.setattr(generation_router.video, 'start_jobs', lambda *a, **kw: (captured.update(args=a) or ['job_1']))

    client.post(f'/api/projects/{pid}/scenes/0/videos', json={'model': 'x:y', 'image_id': non_selected['image_id']})

    assert captured['args'][3] == non_selected['file_path']
    assert captured['args'][4] == non_selected['image_id']


def test_generate_scene_videos_no_selected_image_returns_422(client):
    pid = client.get('/api/projects').json()[0]['id']
    # Scene 2 in the seed data has no images at all.
    resp = client.post(f'/api/projects/{pid}/scenes/2/videos', json={'model': 'x:y'})
    assert resp.status_code == 422


def test_generate_scene_videos_out_of_range_scene_returns_404(client):
    pid = client.get('/api/projects').json()[0]['id']
    assert client.post(f'/api/projects/{pid}/scenes/99/videos', json={'model': 'x:y'}).status_code == 404


def test_generate_scene_videos_sends_active_video_wishes_folded_into_prompt(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    added = client.post(f'/api/projects/{pid}/scenes/videos/wishes', json={'text': 'no sudden cuts'}).json()
    captured = {}
    monkeypatch.setattr(generation_router.video, 'start_jobs', lambda *a, **kw: (captured.update(args=a) or ['job_1']))

    client.post(
        f'/api/projects/{pid}/scenes/0/videos',
        json={'model': 'x:y', 'active_video_wish_ids': [added['wish']['id']]},
    )

    prompt = captured['args'][2]
    assert 'no sudden cuts' in prompt
    assert 'ВАЖНЫЕ ТРЕБОВАНИЯ' in prompt


def test_get_scene_video_job_returns_status(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    video_record = {'video_id': 'vid_x', 'file_path': 'videos/x.mp4', 'rating': 0, 'is_selected': False, 'generated_at': 'now'}
    monkeypatch.setattr(generation_router.video, 'get_job', lambda job_id: {'status': 'completed', 'video': video_record, 'error': None})

    resp = client.get(f'/api/projects/{pid}/scenes/0/videos/jobs/job_1')

    assert resp.status_code == 200
    assert resp.json() == {'status': 'completed', 'video': video_record, 'error': None}


def test_get_scene_video_job_missing_returns_404(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    monkeypatch.setattr(generation_router.video, 'get_job', lambda job_id: None)

    resp = client.get(f'/api/projects/{pid}/scenes/0/videos/jobs/does-not-exist')

    assert resp.status_code == 404


def test_delete_scene_video_removes_file_and_entry(client):
    pid = client.get('/api/projects').json()[0]['id']
    data_root = Path(os.environ['APP_DATA_DIR'])
    videos_dir = data_root / 'projects' / pid / 'videos'
    videos_dir.mkdir(parents=True, exist_ok=True)
    (videos_dir / 'scene_1_abcd1234.mp4').write_bytes(b'MP4DATA')

    project = client.get(f'/api/projects/{pid}').json()
    video_record = {
        'video_id': 'vid_abcd1234', 'file_path': 'videos/scene_1_abcd1234.mp4', 'rating': 0,
        'is_selected': False, 'generated_at': 'now', 'model': 'openrouter:google/veo-3.1',
    }
    project['scenes'][0]['videos'] = [video_record]
    client.patch(f'/api/projects/{pid}', json=project)

    resp = client.delete(f'/api/projects/{pid}/scenes/0/videos/{video_record["video_id"]}')

    assert resp.status_code == 200
    assert resp.json()['videos'] == []
    assert not (videos_dir / 'scene_1_abcd1234.mp4').is_file()
    saved = client.get(f'/api/projects/{pid}').json()
    assert saved['scenes'][0]['videos'] == []


def test_delete_scene_video_missing_video_returns_404(client):
    pid = client.get('/api/projects').json()[0]['id']
    assert client.delete(f'/api/projects/{pid}/scenes/0/videos/does-not-exist').status_code == 404


def test_delete_scene_video_out_of_range_scene_returns_404(client):
    pid = client.get('/api/projects').json()[0]['id']
    assert client.delete(f'/api/projects/{pid}/scenes/99/videos/x').status_code == 404


def test_upload_scene_video_file_writes_file_and_appends(client):
    pid = client.get('/api/projects').json()[0]['id']
    before = len(client.get(f'/api/projects/{pid}').json()['scenes'][0].get('videos', []))

    resp = client.post(
        f'/api/projects/{pid}/scenes/0/videos/upload',
        files={'file': ('mine.mp4', b'fake-mp4-bytes', 'video/mp4')},
    )

    assert resp.status_code == 200
    video_record = resp.json()['video']
    assert video_record['model'] == 'upload'
    assert video_record['cost'] == 0
    assert video_record['is_selected'] is False
    assert video_record['file_path'].startswith('videos/scene_1_') and video_record['file_path'].endswith('.mp4')

    data_root = Path(os.environ['APP_DATA_DIR'])
    written = data_root / 'projects' / pid / video_record['file_path']
    assert written.is_file()
    assert written.read_bytes() == b'fake-mp4-bytes'

    saved = client.get(f'/api/projects/{pid}').json()
    assert len(saved['scenes'][0]['videos']) == before + 1
    assert saved['scenes'][0]['videos'][-1]['video_id'] == video_record['video_id']


def test_upload_scene_video_rejects_bad_extension(client):
    pid = client.get('/api/projects').json()[0]['id']
    resp = client.post(
        f'/api/projects/{pid}/scenes/0/videos/upload',
        files={'file': ('notes.txt', b'hello', 'text/plain')},
    )
    assert resp.status_code == 415


def test_upload_scene_video_out_of_range_scene_returns_404(client):
    pid = client.get('/api/projects').json()[0]['id']
    resp = client.post(
        f'/api/projects/{pid}/scenes/99/videos/upload',
        files={'file': ('mine.mp4', b'data', 'video/mp4')},
    )
    assert resp.status_code == 404


def test_export_video_stage_zips_animate_images_and_prompts(client):
    # Scenes 2 and 3 (0-based) are the demo project's first two with no
    # pre-seeded images, so the newly-uploaded ones are unambiguously what
    # gets resolved/exported for them (scenes 0/1 already have a seeded
    # `is_selected` image whose placeholder file doesn't actually exist on
    # disk, which would otherwise make `_resolve_export_image` correctly but
    # confusingly skip them).
    pid = client.get('/api/projects').json()[0]['id']
    client.post(
        f'/api/projects/{pid}/scenes/2/images/upload',
        files={'file': ('mine.png', b'fake-png-bytes', 'image/png')},
    )
    client.post(
        f'/api/projects/{pid}/scenes/3/images/upload',
        files={'file': ('mine.png', b'fake-png-bytes-2', 'image/png')},
    )
    project = client.get(f'/api/projects/{pid}').json()
    motion_2 = project['scenes'][2]['motion_prompt']
    motion_3 = project['scenes'][3]['motion_prompt']

    resp = client.get(f'/api/projects/{pid}/video-export')

    assert resp.status_code == 200
    assert resp.headers['content-type'] == 'application/zip'
    zf = zipfile.ZipFile(io.BytesIO(resp.content))
    names = zf.namelist()
    assert 'prompts.txt' in names
    scene3_name = next(n for n in names if n.startswith('003_'))
    scene4_name = next(n for n in names if n.startswith('004_'))
    assert scene3_name.endswith('.png')
    assert zf.read(scene3_name) == b'fake-png-bytes'
    assert zf.read(scene4_name) == b'fake-png-bytes-2'
    assert zf.read('prompts.txt').decode('utf-8') == f'{motion_2}\n\n{motion_3}'
    # Scenes without a resolvable image (0, 1, and the last one) are skipped
    # entirely, not padded with a gap marker.
    assert not any(n.startswith('005_') for n in names)


def test_export_video_stage_filters_by_scenes_param(client):
    pid = client.get('/api/projects').json()[0]['id']
    client.post(
        f'/api/projects/{pid}/scenes/2/images/upload',
        files={'file': ('mine.png', b'fake-png-bytes', 'image/png')},
    )
    client.post(
        f'/api/projects/{pid}/scenes/3/images/upload',
        files={'file': ('mine.png', b'fake-png-bytes-2', 'image/png')},
    )

    resp = client.get(f'/api/projects/{pid}/video-export?scenes=2')

    zf = zipfile.ZipFile(io.BytesIO(resp.content))
    names = zf.namelist()
    assert any(n.startswith('003_') for n in names)
    assert not any(n.startswith('004_') for n in names)


def test_export_video_stage_missing_project_returns_404(client):
    assert client.get('/api/projects/does-not-exist/video-export').status_code == 404


def test_import_video_batch_matches_by_scene_number_prefix(client):
    pid = client.get('/api/projects').json()[0]['id']

    resp = client.post(
        f'/api/projects/{pid}/video-import-batch',
        files=[
            ('files', ('001_some-clip.mp4', b'clip-one', 'video/mp4')),
            ('files', ('003_another-clip.mp4', b'clip-three', 'video/mp4')),
        ],
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body['skipped'] == []
    assert [a['scene_index'] for a in body['assigned']] == [0, 2]

    saved = client.get(f'/api/projects/{pid}').json()
    assert saved['scenes'][0]['videos'][-1]['file_path'].endswith('.mp4')
    assert saved['scenes'][2]['videos'][-1]['file_path'].endswith('.mp4')

    data_root = Path(os.environ['APP_DATA_DIR'])
    written = data_root / 'projects' / pid / saved['scenes'][0]['videos'][-1]['file_path']
    assert written.read_bytes() == b'clip-one'


def test_import_video_batch_matches_by_scene_number_prefix_with_path(client):
    """A folder-picker upload can hand back a relative path instead of a bare
    filename depending on the browser - matching must look at the last path
    segment, not fail the whole file as `no_scene_number`."""
    pid = client.get('/api/projects').json()[0]['id']

    resp = client.post(
        f'/api/projects/{pid}/video-import-batch',
        files=[
            ('files', ('My Folder/001_some-clip.mp4', b'clip-one', 'video/mp4')),
            ('files', ('My Folder\\003_another-clip.mp4', b'clip-three', 'video/mp4')),
        ],
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body['skipped'] == []
    assert [a['scene_index'] for a in body['assigned']] == [0, 2]


def test_import_video_batch_skips_unmatched_and_out_of_range(client):
    pid = client.get('/api/projects').json()[0]['id']

    resp = client.post(
        f'/api/projects/{pid}/video-import-batch',
        files=[
            ('files', ('no-number.mp4', b'x', 'video/mp4')),
            ('files', ('999_way-out-there.mp4', b'x', 'video/mp4')),
            ('files', ('001_notes.txt', b'x', 'text/plain')),
        ],
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body['assigned'] == []
    reasons = {s['filename']: s['reason'] for s in body['skipped']}
    assert reasons['no-number.mp4'] == 'no_scene_number'
    assert reasons['999_way-out-there.mp4'] == 'scene_out_of_range'
    assert reasons['001_notes.txt'] == 'unsupported_type'


def test_import_video_batch_missing_project_returns_404(client):
    resp = client.post(
        '/api/projects/does-not-exist/video-import-batch',
        files=[('files', ('001_clip.mp4', b'x', 'video/mp4'))],
    )
    assert resp.status_code == 404


def test_add_video_wish_creates_card_and_activates_it_for_project(client):
    pid = client.get('/api/projects').json()[0]['id']

    resp = client.post(f'/api/projects/{pid}/scenes/videos/wishes', json={'text': 'smooth camera movement'})

    assert resp.status_code == 200
    body = resp.json()
    wish = body['wish']
    assert wish['text'] == 'smooth camera movement'
    assert body['active_video_wish_ids'] == [wish['id']]
    assert any(w['id'] == wish['id'] for w in body['video_wish_library'])

    saved = client.get(f'/api/projects/{pid}').json()
    assert saved['active_video_wish_ids'] == [wish['id']]
    # Separate library from scene_wish_library - must not leak into it.
    settings = client.get('/api/settings').json()
    assert settings['scene_wish_library'] == []


def test_add_video_wish_rejects_blank_text(client):
    pid = client.get('/api/projects').json()[0]['id']
    assert client.post(f'/api/projects/{pid}/scenes/videos/wishes', json={'text': '  '}).status_code == 422


def test_add_video_wish_missing_project_returns_404(client):
    assert client.post(
        '/api/projects/does-not-exist/scenes/videos/wishes', json={'text': 'hi'},
    ).status_code == 404


def test_generate_scene_videos_end_to_end_with_openrouter_writes_file_and_persists(client, monkeypatch):
    """Exercises the real job pipeline (router -> video.start_jobs -> background
    task -> disk write -> project persistence) with only the OpenRouter HTTP
    calls mocked - see test_video_provider.py for per-provider request/response
    shape coverage."""
    pid = client.get('/api/projects').json()[0]['id']
    project = client.get(f'/api/projects/{pid}').json()
    selected_image = next(img for img in project['scenes'][0]['images'] if img['is_selected'])
    data_root = Path(os.environ['APP_DATA_DIR'])
    image_path = data_root / 'projects' / pid / selected_image['file_path']
    image_path.parent.mkdir(parents=True, exist_ok=True)
    image_path.write_bytes(b'FAKEIMAGEBYTES')

    settings = client.get('/api/settings').json()
    settings['api_keys']['openrouter'] = 'test-key'
    client.put('/api/settings', json=settings)

    class _FakeVideoResponse:
        def __init__(self, status_code, payload=None, content=b''):
            self.status_code = status_code
            self._payload = payload
            self.text = ''
            self.content = content

        def json(self):
            return self._payload

    class _FakeVideoAsyncClient:
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

    fake_client = _FakeVideoAsyncClient([
        _FakeVideoResponse(202, {'id': 'job1', 'status': 'pending'}),
        _FakeVideoResponse(200, {'id': 'job1', 'status': 'completed', 'unsigned_urls': ['https://cdn.example/vid.mp4'], 'usage': {'cost': 0.5}}),
        _FakeVideoResponse(200, content=b'MP4DATA'),
    ])
    monkeypatch.setattr(generation_router.video.httpx, 'AsyncClient', lambda **kwargs: fake_client)
    monkeypatch.setattr(generation_router.video.asyncio, 'sleep', AsyncMock())

    resp = client.post(
        f'/api/projects/{pid}/scenes/0/videos', json={'model': 'openrouter:google/veo-3.1'},
    )
    assert resp.status_code == 200
    job_id = resp.json()['job_ids'][0]

    job = None
    for _ in range(200):
        job = client.get(f'/api/projects/{pid}/scenes/0/videos/jobs/{job_id}').json()
        if job['status'] != 'pending':
            break
        time.sleep(0.05)
    assert job['status'] == 'completed'
    video_record = job['video']
    assert video_record['file_path'].startswith('videos/scene_1_') and video_record['file_path'].endswith('.mp4')
    assert video_record['cost'] == 0.5
    assert video_record['source_image_id'] == selected_image['image_id']

    written = data_root / 'projects' / pid / video_record['file_path']
    assert written.is_file()
    assert written.read_bytes() == b'MP4DATA'

    saved = client.get(f'/api/projects/{pid}').json()
    assert saved['scenes'][0]['videos'][-1] == video_record


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


def _tiny_png(width=10, height=10):
    out = io.BytesIO()
    Image.new('RGB', (width, height), (40, 80, 120)).save(out, 'PNG')
    return out.getvalue()


def test_crop_scene_image_inbounds_appends_new_image_and_keeps_original(client):
    pid = client.get('/api/projects').json()[0]['id']
    source = client.post(
        f'/api/projects/{pid}/scenes/2/images/upload',
        files={'file': ('mine.png', _tiny_png(10, 10), 'image/png')},
    ).json()['image']

    resp = client.post(
        f'/api/projects/{pid}/scenes/2/images/{source["image_id"]}/crop',
        json={'crop': {'x': 1, 'y': 1, 'width': 4, 'height': 4}},
    )

    assert resp.status_code == 200
    new_image = resp.json()['image']
    assert new_image['model'] == 'local:crop'
    assert new_image['source_image_id'] == source['image_id']

    data_root = Path(os.environ['APP_DATA_DIR'])
    new_file = data_root / 'projects' / pid / new_image['file_path']
    assert new_file.is_file()
    with Image.open(new_file) as cropped:
        assert cropped.size == (4, 4)

    saved_images = client.get(f'/api/projects/{pid}').json()['scenes'][2]['images']
    assert saved_images[-1]['image_id'] == new_image['image_id']
    assert saved_images[0]['image_id'] == source['image_id']


def test_crop_scene_image_missing_crop_body_returns_400(client):
    pid = client.get('/api/projects').json()[0]['id']
    resp = client.post(f'/api/projects/{pid}/scenes/2/images/whatever/crop', json={})
    assert resp.status_code == 400


def test_crop_scene_image_missing_image_returns_404(client):
    pid = client.get('/api/projects').json()[0]['id']
    resp = client.post(
        f'/api/projects/{pid}/scenes/2/images/does-not-exist/crop',
        json={'crop': {'x': 0, 'y': 0, 'width': 4, 'height': 4}},
    )
    assert resp.status_code == 404


def test_crop_scene_image_too_large_selection_returns_400(client):
    pid = client.get('/api/projects').json()[0]['id']
    source = client.post(
        f'/api/projects/{pid}/scenes/2/images/upload',
        files={'file': ('mine.png', _tiny_png(10, 10), 'image/png')},
    ).json()['image']

    resp = client.post(
        f'/api/projects/{pid}/scenes/2/images/{source["image_id"]}/crop',
        json={'crop': {'x': 0, 'y': 0, 'width': 3000, 'height': 10}},
    )
    assert resp.status_code == 400


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
        'text_block': '"Зимнее утро"\n"Пушкин"', 'base_prompt': 'base',
        'reference_image_paths': [ref_path], 'model': 'google:gemini-3.1-flash-lite-image',
        'aspect_ratio': '16:9', 'count': 2,
    })

    assert resp.status_code == 200
    assert resp.json() == {'job_ids': ['job_1', 'job_2']}
    assert captured['args'][0] == pid
    assert captured['args'][1] == [ref_path]
    assert captured['args'][2] == '"Зимнее утро"\n"Пушкин"'
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
        'text_block': '"Зимнее утро"\n"Пушкин"', 'base_prompt': 'base instructions',
        'reference_image_paths': [ref_path], 'model': 'google:gemini-3.1-flash-lite-image',
    })
    assert resp.status_code == 200
    job_id = resp.json()['job_ids'][0]

    job = _poll_title_card_until_done(client, pid, job_id)

    assert job['status'] == 'completed'
    variant = job['variant']
    assert variant['file_path'].startswith('titlecard/') and variant['file_path'].endswith('.png')
    assert variant['text_block'] == '"Зимнее утро"\n"Пушкин"'
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

    monkeypatch.setattr(generation_router.mureka, 'start_job', fake_start_job)

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
    monkeypatch.setattr(generation_router.mureka, 'get_job', lambda job_id: {'status': 'completed', 'tracks': [track], 'error': None})

    resp = client.get(f'/api/projects/{pid}/mureka/jobs/job_1')

    assert resp.status_code == 200
    assert resp.json() == {'status': 'completed', 'tracks': [track], 'error': None}


def test_get_mureka_job_missing_returns_404(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    monkeypatch.setattr(generation_router.mureka, 'get_job', lambda job_id: None)

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
    monkeypatch.setattr(generation_router.mureka.asyncio, 'sleep', _fast_sleep)

    fake_client = _FakeImagesAsyncClient([
        _FakeImagesResponse(200, {'id': 'task_1', 'status': 'preparing'}),
        _FakeImagesResponse(200, {'status': 'succeeded', 'choices': [
            {'index': 0, 'id': 'c0', 'url': 'https://cdn.mureka.ai/c0.mp3', 'duration': 42000},
        ]}),
    ])
    monkeypatch.setattr(generation_router.mureka.httpx, 'AsyncClient', lambda **kwargs: fake_client)
    monkeypatch.setattr(generation_router.mureka, '_download', AsyncMock(return_value=b'MP3DATA'))

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
        generation_router.mureka, 'upload_reference_audio',
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
        generation_router.mureka, 'upload_reference_audio',
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
        generation_router.mureka, 'upload_reference_audio',
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

    monkeypatch.setattr(generation_router.mureka, 'trim_audio', fake_trim_audio)
    monkeypatch.setattr(
        generation_router.mureka, 'upload_reference_audio',
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

    monkeypatch.setattr(generation_router.mureka, 'trim_audio', fake_trim_audio)
    monkeypatch.setattr(
        generation_router.mureka, 'upload_reference_audio',
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

    monkeypatch.setattr(generation_router.mureka, 'trim_audio', fake_trim_audio)

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

    monkeypatch.setattr(generation_router.mureka, 'start_extend_job', fake_start_extend_job)

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

    monkeypatch.setattr(generation_router.mureka, 'stem_track', fake_stem_track)

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

    monkeypatch.setattr(generation_router.mureka, 'stem_track', AsyncMock(side_effect=RuntimeError('boom')))

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

    monkeypatch.setattr(generation_router.mureka, 'describe_song', fake_describe_song)

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

    monkeypatch.setattr(generation_router.mureka, 'describe_song', AsyncMock(side_effect=RuntimeError('boom')))

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

    monkeypatch.setattr(generation_router.mureka, 'transcribe_song', fake_transcribe_song)

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

    monkeypatch.setattr(generation_router.mureka, 'transcribe_song', AsyncMock(side_effect=RuntimeError('boom')))

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

    monkeypatch.setattr(generation_router.mureka, 'generate_lyrics_video', fake_generate_lyrics_video)

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

    monkeypatch.setattr(generation_router.mureka, 'generate_lyrics_video', AsyncMock(side_effect=RuntimeError('boom')))

    resp = client.post(f'/api/projects/{pid}/mureka/tracks/trk_x/lyrics-video', json={})
    assert resp.status_code == 502
