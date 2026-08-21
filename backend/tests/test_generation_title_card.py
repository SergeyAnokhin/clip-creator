"""Routes in `app/routers/generation_title_card.py` (title-card generate/poll/
delete/remove-background, poster save/delete) and `app/routers/magic_layers.py`."""

import os
from pathlib import Path

from app.providers import title_card

from tests.generation_fixtures import _FakeImagesAsyncClient, _FakeImagesResponse, _poll_title_card_until_done, _upload_reference


def test_generate_title_card_starts_jobs_and_forwards_fields(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    ref_path = _upload_reference(client, pid)
    captured = {}

    def fake_start_jobs(*args, **kwargs):
        captured['args'] = args
        captured['kwargs'] = kwargs
        return ['job_1', 'job_2']

    monkeypatch.setattr(title_card, 'start_jobs', fake_start_jobs)

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
    monkeypatch.setattr(title_card, 'get_job', lambda job_id: {'status': 'completed', 'variant': variant, 'error': None})

    resp = client.get(f'/api/projects/{pid}/title-card/jobs/job_1')

    assert resp.status_code == 200
    assert resp.json() == {'status': 'completed', 'variant': variant, 'error': None}


def test_get_title_card_job_missing_returns_404(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    monkeypatch.setattr(title_card, 'get_job', lambda job_id: None)

    resp = client.get(f'/api/projects/{pid}/title-card/jobs/does-not-exist')

    assert resp.status_code == 404


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
    monkeypatch.setattr(title_card.httpx, 'AsyncClient', lambda **kwargs: fake_client)

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
    monkeypatch.setattr(title_card.httpx, 'AsyncClient', lambda **kwargs: fake_client)
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
