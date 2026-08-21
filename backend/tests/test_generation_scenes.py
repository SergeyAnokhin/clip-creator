"""Routes in `app/routers/generation_scenes.py`: scene text, scene images
(generate/poll/upload/crop) and scene videos (generate/poll/upload/delete),
plus the project reference images they share."""

import io
import os
import zipfile
from pathlib import Path
from unittest.mock import AsyncMock

from app import storage
from app.providers import images, scenes, suno, video

from tests.generation_fixtures import _FakeImagesAsyncClient, _FakeImagesResponse, _poll_until_done


def test_generate_suno_calls_provider_seam_and_persists(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    monkeypatch.setattr(
        suno, 'generate',
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
    monkeypatch.setattr(suno, 'generate', fake_generate)

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
    monkeypatch.setattr(suno, 'generate', fake_generate)

    client.post(f'/api/projects/{pid}/suno/generate', json={'active_wish_ids': [added['wish']['id']]})

    assert fake_generate.call_args.kwargs['active_wishes'] == ['Add more jazz']


def test_generate_suno_falls_back_to_projects_active_wish_ids_when_not_sent(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    client.post(f'/api/projects/{pid}/suno/wishes', json={'text': 'Add more jazz'})
    fake_generate = AsyncMock(return_value={'style': 'S', 'lyrics': 'L'})
    monkeypatch.setattr(suno, 'generate', fake_generate)

    client.post(f'/api/projects/{pid}/suno/generate', json={})

    assert fake_generate.call_args.kwargs['active_wishes'] == ['Add more jazz']


def test_generate_scenes_calls_provider_seam_and_persists(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    canned = [{'lyric_segment': 'X', 'static_prompt': 'sp', 'motion_prompt': 'mp', 'images': []}]
    monkeypatch.setattr(scenes, 'generate', AsyncMock(return_value={'scenes': canned, 'debug': {'stub': True}}))

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
    monkeypatch.setattr(scenes, 'generate', fake_generate)

    client.post(f'/api/projects/{pid}/scenes/generate', json={'model': 'google:gemini-2.5-flash'})

    assert fake_generate.call_args.kwargs['model'] == 'google:gemini-2.5-flash'


def test_generate_scene_images_starts_jobs_and_forwards_prompt_and_model(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    project = client.get(f'/api/projects/{pid}').json()
    project['scenes'][2]['static_prompt'] = 'a cinematic frame'
    client.patch(f'/api/projects/{pid}', json=project)
    monkeypatch.setattr(images, 'start_jobs', lambda *a, **kw: ['job_1', 'job_2'])

    resp = client.post(f'/api/projects/{pid}/scenes/2/images', json={'count': 2, 'model': 'krea:krea/krea-2/medium'})

    assert resp.status_code == 200
    assert resp.json() == {'job_ids': ['job_1', 'job_2']}


def test_generate_scene_images_zero_count_returns_no_jobs(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    monkeypatch.setattr(images, 'start_jobs', lambda *a, **kw: [])

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

    monkeypatch.setattr(images, 'start_jobs', fake_start_jobs)

    client.post(f'/api/projects/{pid}/scenes/2/images', json={'count': 1, 'model': 'krea:krea/krea-2/medium', 'aspect_ratio': '9:16'})

    assert captured['aspect_ratio'] == '9:16'


def test_get_scene_image_job_returns_status(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    image = {'image_id': 'img_x', 'file_path': 'images/x.png', 'rating': 0, 'is_selected': False, 'generated_at': 'now'}
    monkeypatch.setattr(images, 'get_job', lambda job_id: {'status': 'completed', 'image': image, 'error': None})

    resp = client.get(f'/api/projects/{pid}/scenes/2/images/jobs/job_1')

    assert resp.status_code == 200
    assert resp.json() == {'status': 'completed', 'image': image, 'error': None}


def test_get_scene_image_job_missing_returns_404(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    monkeypatch.setattr(images, 'get_job', lambda job_id: None)

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
    monkeypatch.setattr(images.httpx, 'AsyncClient', lambda **kwargs: fake_client)

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
    monkeypatch.setattr(images.httpx, 'AsyncClient', lambda **kwargs: fake_client)
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

    monkeypatch.setattr(video, 'start_jobs', fake_start_jobs)

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
    monkeypatch.setattr(video, 'start_jobs', lambda *a, **kw: (captured.update(args=a) or ['job_1']))

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
    monkeypatch.setattr(video, 'start_jobs', lambda *a, **kw: (captured.update(args=a) or ['job_1']))

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
    monkeypatch.setattr(video, 'get_job', lambda job_id: {'status': 'completed', 'video': video_record, 'error': None})

    resp = client.get(f'/api/projects/{pid}/scenes/0/videos/jobs/job_1')

    assert resp.status_code == 200
    assert resp.json() == {'status': 'completed', 'video': video_record, 'error': None}


def test_get_scene_video_job_missing_returns_404(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    monkeypatch.setattr(video, 'get_job', lambda job_id: None)

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


def test_final_export_bundles_videos_audio_and_marked_title_cards(client):
    pid = client.get('/api/projects').json()[0]['id']

    # Two video candidates for scene 0, different ratings - both must be
    # included (unlike video-export, which only ever resolves one image per
    # scene), named so the 5-star one sorts before the 3-star one.
    client.post(
        f'/api/projects/{pid}/scenes/0/videos/upload',
        files={'file': ('a.mp4', b'video-a-bytes', 'video/mp4')},
    )
    client.post(
        f'/api/projects/{pid}/scenes/0/videos/upload',
        files={'file': ('b.mp4', b'video-b-bytes', 'video/mp4')},
    )
    project = client.get(f'/api/projects/{pid}').json()
    project['scenes'][0]['videos'][0]['rating'] = 3
    project['scenes'][0]['videos'][1]['rating'] = 5

    # A selected Mureka track with a real file on disk.
    project_dir = storage.project_dir(pid)
    music_dir = project_dir / 'music'
    music_dir.mkdir(parents=True, exist_ok=True)
    (music_dir / 'track1.mp3').write_bytes(b'audio-bytes')
    project['mureka'] = {
        'style_input': '', 'lyrics_input': '', 'reference_audio': [], 'reference_sources': [],
        'tracks': [{'track_id': 'trk_1', 'file_path': 'music/track1.mp3', 'is_selected': True, 'rating': 0}],
    }

    # Two title-card variants, only one marked for export.
    titlecard_dir = project_dir / 'titlecard'
    titlecard_dir.mkdir(parents=True, exist_ok=True)
    (titlecard_dir / 'tc1.png').write_bytes(b'title-bytes')
    (titlecard_dir / 'tc2.png').write_bytes(b'title-bytes-2')
    project['title_card'] = {
        'reference_image_paths': [], 'variants': [
            {'variant_id': 'tc_1', 'file_path': 'titlecard/tc1.png', 'rating': 0, 'is_selected': False, 'marked_for_export': True},
            {'variant_id': 'tc_2', 'file_path': 'titlecard/tc2.png', 'rating': 0, 'is_selected': False, 'marked_for_export': False},
        ],
    }

    client.patch(f'/api/projects/{pid}', json=project)

    resp = client.get(f'/api/projects/{pid}/final-export')

    assert resp.status_code == 200
    assert resp.headers['content-type'] == 'application/zip'
    zf = zipfile.ZipFile(io.BytesIO(resp.content))
    names = zf.namelist()

    video_names = sorted(n for n in names if n.startswith('videos/'))
    assert len(video_names) == 2
    assert video_names[0].startswith('videos/0★_scene001_')
    assert video_names[1].startswith('videos/2★_scene001_')

    assert 'audio/track1.mp3' in names
    assert zf.read('audio/track1.mp3') == b'audio-bytes'

    assert names.count('title/01_tc1.png') == 1
    assert zf.read('title/01_tc1.png') == b'title-bytes'
    assert not any(n.endswith('tc2.png') for n in names)


def test_final_export_falls_back_to_selected_title_card_when_none_marked(client):
    pid = client.get('/api/projects').json()[0]['id']
    project_dir = storage.project_dir(pid)
    titlecard_dir = project_dir / 'titlecard'
    titlecard_dir.mkdir(parents=True, exist_ok=True)
    (titlecard_dir / 'tc1.png').write_bytes(b'title-bytes')

    project = client.get(f'/api/projects/{pid}').json()
    project['title_card'] = {
        'reference_image_paths': [],
        'variants': [{'variant_id': 'tc_1', 'file_path': 'titlecard/tc1.png', 'rating': 0, 'is_selected': True}],
    }
    client.patch(f'/api/projects/{pid}', json=project)

    resp = client.get(f'/api/projects/{pid}/final-export')

    zf = zipfile.ZipFile(io.BytesIO(resp.content))
    assert 'title/01_tc1.png' in zf.namelist()


def test_final_export_missing_project_returns_404(client):
    assert client.get('/api/projects/does-not-exist/final-export').status_code == 404
