import io
import os
from pathlib import Path

from PIL import Image

from app.providers import magic_layers


def _tiny_png(width=10, height=10):
    out = io.BytesIO()
    Image.new('RGB', (width, height), (40, 80, 120)).save(out, 'PNG')
    return out.getvalue()


def _upload_source(client, pid):
    return client.post(
        f'/api/projects/{pid}/scenes/2/images/upload',
        files={'file': ('mine.png', _tiny_png(), 'image/png')},
    ).json()['image']


def _fake_group(group_id='mg_test1234', source_path='images/x.png'):
    return {
        'group_id': group_id, 'source_path': source_path, 'source_kind': 'scene_image',
        'canvas': {'width': 10, 'height': 10}, 'method': 'fal',
        'model': 'fal:fal-ai/qwen-image-layered', 'num_layers': 2, 'requested_layers': 2,
        'layers': [
            {'index': 0, 'file_path': f'magic/{group_id}/L0.png',
             'bbox': {'x': 0, 'y': 0, 'width': 10, 'height': 10}, 'is_background': True},
            {'index': 1, 'file_path': f'magic/{group_id}/L1.png',
             'bbox': {'x': 2, 'y': 2, 'width': 4, 'height': 4}, 'is_background': False},
        ],
        'cost': 0.05, 'generated_at': '2026-08-14T00:00:00Z',
    }


def test_start_magic_layers_returns_a_job_id(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    source = _upload_source(client, pid)
    captured = {}

    def fake_start_job(slug, source_path, source_kind, settings, num_layers=None, method=None, usage_ctx=None):
        captured.update({'slug': slug, 'source_path': source_path, 'source_kind': source_kind,
                         'num_layers': num_layers, 'method': method, 'task': usage_ctx['task']})
        return 'job-1'
    monkeypatch.setattr(magic_layers, 'start_job', fake_start_job)

    resp = client.post(
        f'/api/projects/{pid}/magic-layers',
        json={'source_path': source['file_path'], 'num_layers': 6,
              'method': 'replicate', 'source_kind': 'title_card_variant'},
    )

    assert resp.status_code == 200
    assert resp.json() == {'job_id': 'job-1'}
    assert captured == {'slug': pid, 'source_path': source['file_path'],
                        'source_kind': 'title_card_variant', 'num_layers': 6,
                        'method': 'replicate', 'task': 'magic_layers'}


def test_start_magic_layers_requires_a_source_path(client):
    pid = client.get('/api/projects').json()[0]['id']
    assert client.post(f'/api/projects/{pid}/magic-layers', json={}).status_code == 422


def test_start_magic_layers_rejects_a_path_outside_the_project(client):
    pid = client.get('/api/projects').json()[0]['id']
    resp = client.post(
        f'/api/projects/{pid}/magic-layers',
        json={'source_path': '../../settings.json'},
    )
    assert resp.status_code == 422


def test_start_magic_layers_unknown_project_returns_404(client):
    resp = client.post('/api/projects/nope/magic-layers', json={'source_path': 'images/x.png'})
    assert resp.status_code == 404


def test_magic_layers_job_status_is_polled_by_id(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    group = _fake_group()
    monkeypatch.setattr(
        magic_layers, 'get_job',
        lambda job_id: {'status': 'completed', 'group': group, 'error': None} if job_id == 'job-1' else None,
    )

    ok = client.get(f'/api/projects/{pid}/magic-layers/jobs/job-1')
    assert ok.status_code == 200
    assert ok.json()['group']['group_id'] == group['group_id']
    assert client.get(f'/api/projects/{pid}/magic-layers/jobs/nope').status_code == 404


def test_delete_magic_layer_group_removes_the_record_and_its_files(client):
    pid = client.get('/api/projects').json()[0]['id']
    group = _fake_group()

    data_root = Path(os.environ['APP_DATA_DIR'])
    group_dir = data_root / 'projects' / pid / 'magic' / group['group_id']
    group_dir.mkdir(parents=True, exist_ok=True)
    for layer in group['layers']:
        (data_root / 'projects' / pid / layer['file_path']).write_bytes(_tiny_png())

    client.patch(f'/api/projects/{pid}', json={'magic_layer_groups': [group]})

    resp = client.delete(f'/api/projects/{pid}/magic-layers/{group["group_id"]}')

    assert resp.status_code == 200
    assert resp.json() == {'magic_layer_groups': []}
    assert client.get(f'/api/projects/{pid}').json()['magic_layer_groups'] == []
    assert not group_dir.exists()


def test_delete_unknown_magic_layer_group_returns_404(client):
    pid = client.get('/api/projects').json()[0]['id']
    assert client.delete(f'/api/projects/{pid}/magic-layers/mg_nope').status_code == 404
