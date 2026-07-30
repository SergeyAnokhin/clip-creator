import os
from pathlib import Path
from unittest.mock import AsyncMock

from app.routers import generation as generation_router


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


def test_generate_scene_images_calls_provider_seam_and_appends(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    monkeypatch.setattr(
        generation_router.images, 'generate',
        AsyncMock(return_value=[{'image_id': 'img_x', 'file_path': 'images/x.svg', 'rating': 0, 'is_selected': False, 'generated_at': 'now'}]),
    )

    resp = client.post(f'/api/projects/{pid}/scenes/2/images', json={'count': 2, 'model': 'flux'})

    assert resp.status_code == 200
    assert resp.json()['images'][-1] == {
        'image_id': 'img_x', 'file_path': 'images/x.svg', 'rating': 0, 'is_selected': False, 'generated_at': 'now',
    }
    generation_router.images.generate.assert_awaited_once()
    args, kwargs = generation_router.images.generate.await_args
    assert args[:2] == (pid, 2)
    assert kwargs == {'count': 2, 'model': 'flux'}


def test_generate_scene_images_writes_real_placeholder_file(client):
    pid = client.get('/api/projects').json()[0]['id']

    resp = client.post(f'/api/projects/{pid}/scenes/2/images', json={'count': 1, 'model': 'flux'})

    assert resp.status_code == 200
    image = resp.json()['images'][-1]
    assert image['file_path'] == 'images/scene_3_var_1.svg'
    assert image['rating'] == 0
    assert image['is_selected'] is False
    assert image['image_id'].startswith('img_')
    assert image['generated_at']

    data_root = Path(os.environ['APP_DATA_DIR'])
    written = data_root / 'projects' / pid / image['file_path']
    assert written.is_file()
    assert '<svg' in written.read_text(encoding='utf-8')


def test_generate_scene_images_zero_count_returns_no_new_images(client):
    pid = client.get('/api/projects').json()[0]['id']
    before = client.get(f'/api/projects/{pid}').json()['scenes'][2]['images']

    resp = client.post(f'/api/projects/{pid}/scenes/2/images', json={'count': 0})

    assert resp.json()['images'] == before


def test_generate_scene_images_out_of_range_returns_404(client):
    pid = client.get('/api/projects').json()[0]['id']
    assert client.post(f'/api/projects/{pid}/scenes/99/images', json={}).status_code == 404


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
