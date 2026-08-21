"""Routes in `app/routers/generation_export.py`: the video-export zip, the
batch clip import, the final-export bundle, and the Editor stage's render
start/poll/delete + overlay-video upload."""

import os
import time
from pathlib import Path
from unittest.mock import AsyncMock

from PIL import Image

from app.providers import editor, images, video

from tests.generation_fixtures import _tiny_png

# ---------- Editor stage (providers/editor.py) ----------

def test_start_editor_render_rejects_empty_clips(client):
    pid = client.get('/api/projects').json()[0]['id']
    resp = client.post(f'/api/projects/{pid}/editor/render')
    assert resp.status_code == 422
    assert 'Таймлайн пуст' in resp.json()['detail']


def test_start_editor_render_rejects_missing_track(client):
    pid = client.get('/api/projects').json()[0]['id']
    client.patch(f'/api/projects/{pid}', json={'video_edit': {'clips': [{'scene_index': 0, 'video_id': 'v'}]}})

    resp = client.post(f'/api/projects/{pid}/editor/render')

    assert resp.status_code == 422
    assert 'аудиотрек' in resp.json()['detail']


def test_start_editor_render_starts_job(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    client.patch(f'/api/projects/{pid}', json={'video_edit': {
        'mureka_track_id': 'trk_1', 'clips': [{'scene_index': 0, 'video_id': 'v'}],
    }})
    monkeypatch.setattr(editor, 'start_render_job', lambda slug, range_start_ms=None, range_end_ms=None: 'job_123')

    resp = client.post(f'/api/projects/{pid}/editor/render')

    assert resp.status_code == 200
    assert resp.json() == {'job_id': 'job_123'}


def test_start_editor_render_with_range_passes_it_through(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    client.patch(f'/api/projects/{pid}', json={'video_edit': {
        'mureka_track_id': 'trk_1', 'clips': [{'scene_index': 0, 'video_id': 'v'}],
    }})
    captured = {}

    def fake_start_render_job(slug, range_start_ms=None, range_end_ms=None):
        captured['range_start_ms'] = range_start_ms
        captured['range_end_ms'] = range_end_ms
        return 'job_123'

    monkeypatch.setattr(editor, 'start_render_job', fake_start_render_job)

    resp = client.post(f'/api/projects/{pid}/editor/render', json={'range_start_ms': 500, 'range_end_ms': 1500})

    assert resp.status_code == 200
    assert captured == {'range_start_ms': 500, 'range_end_ms': 1500}


def test_start_editor_render_missing_project_returns_404(client):
    assert client.post('/api/projects/does-not-exist/editor/render').status_code == 404


def test_get_editor_render_job_returns_status(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    render_record = {'render_id': 'rnd_1', 'file_path': 'editor/rnd_1.mp4', 'duration_ms': 1000, 'clip_count': 1}
    monkeypatch.setattr(editor, 'get_job', lambda job_id: {'status': 'completed', 'render': render_record, 'error': None})

    resp = client.get(f'/api/projects/{pid}/editor/jobs/job_1')

    assert resp.status_code == 200
    assert resp.json() == {'status': 'completed', 'render': render_record, 'error': None}


def test_get_editor_render_job_missing_returns_404(client, monkeypatch):
    pid = client.get('/api/projects').json()[0]['id']
    monkeypatch.setattr(editor, 'get_job', lambda job_id: None)

    resp = client.get(f'/api/projects/{pid}/editor/jobs/does-not-exist')

    assert resp.status_code == 404


def test_delete_editor_render_removes_entry_and_file(client):
    pid = client.get('/api/projects').json()[0]['id']
    data_root = Path(os.environ['APP_DATA_DIR'])
    editor_dir = data_root / 'projects' / pid / 'editor'
    editor_dir.mkdir(parents=True, exist_ok=True)
    (editor_dir / 'rnd_1.mp4').write_bytes(b'MP4DATA')
    client.patch(f'/api/projects/{pid}', json={'video_edit': {
        'mureka_track_id': 'trk_1', 'clips': [],
        'renders': [{'render_id': 'rnd_1', 'file_path': 'editor/rnd_1.mp4', 'duration_ms': 1000, 'clip_count': 1}],
    }})

    resp = client.delete(f'/api/projects/{pid}/editor/renders/rnd_1')

    assert resp.status_code == 200
    assert resp.json()['renders'] == []
    assert not (editor_dir / 'rnd_1.mp4').is_file()
    assert client.get(f'/api/projects/{pid}').json()['video_edit']['renders'] == []


def test_delete_editor_render_missing_returns_404(client):
    pid = client.get('/api/projects').json()[0]['id']
    resp = client.delete(f'/api/projects/{pid}/editor/renders/does-not-exist')
    assert resp.status_code == 404


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
    monkeypatch.setattr(video.httpx, 'AsyncClient', lambda **kwargs: fake_client)
    monkeypatch.setattr(video.asyncio, 'sleep', AsyncMock())

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
    monkeypatch.setattr(images, 'download_user_image_url', fake_download)

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

    monkeypatch.setattr(images, 'download_user_image_url', _reject)

    resp = client.post(
        f'/api/projects/{pid}/scenes/2/images/upload',
        data={'url': 'http://127.0.0.1/x.png'},
    )

    assert resp.status_code == 422
