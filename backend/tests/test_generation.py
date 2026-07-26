from unittest.mock import AsyncMock

from app.routers import generation as generation_router


def test_generate_suno_calls_provider_seam_and_persists(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    monkeypatch.setattr(
        generation_router.suno, 'generate',
        AsyncMock(return_value={'style': 'Test Style', 'lyrics': 'Test Lyrics'}),
    )

    resp = client.post(f'/api/projects/{pid}/suno/generate')

    assert resp.status_code == 200
    assert resp.json() == {'style': 'Test Style', 'lyrics': 'Test Lyrics'}
    assert client.get(f'/api/projects/{pid}').json()['style'] == 'Test Style'


def test_generate_scene_images_calls_provider_seam_and_appends(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    monkeypatch.setattr(
        generation_router.images, 'generate',
        AsyncMock(return_value=[{'label': 'X', 'rating': 0, 'main': True}]),
    )

    resp = client.post(f'/api/projects/{pid}/scenes/2/images')

    assert resp.status_code == 200
    assert resp.json()['images'][-1] == {'label': 'X', 'rating': 0, 'main': True}


def test_generate_scene_images_out_of_range_returns_404(client):
    pid = client.get('/api/projects').json()[0]['id']
    assert client.post(f'/api/projects/{pid}/scenes/99/images').status_code == 404


def test_generate_suno_missing_project_returns_404(client):
    assert client.post('/api/projects/does-not-exist/suno/generate').status_code == 404
