import asyncio
import io

import numpy as np
import pytest
from PIL import Image

from app.providers import magic_layers


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
    """One instance backs every `httpx.AsyncClient(...)` the code under test
    opens, so its `_responses` queue is popped in call order across
    submit/poll/fetch/download - same convention as test_images_provider.py."""

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
    monkeypatch.setattr(magic_layers.asyncio, 'sleep', _FastSleep())


def _install(monkeypatch, responses):
    fake_client = _FakeAsyncClient(responses)
    monkeypatch.setattr(magic_layers.httpx, 'AsyncClient', lambda **kwargs: fake_client)
    return fake_client


@pytest.fixture
def usage_ledger(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_DATA_DIR', str(tmp_path))
    from app import usage as usage_module
    return usage_module


def _rgb_png(width, height, rgb=(30, 60, 90)):
    arr = np.zeros((height, width, 3), dtype=np.uint8)
    arr[:, :, :] = rgb
    out = io.BytesIO()
    Image.fromarray(arr, 'RGB').save(out, 'PNG')
    return out.getvalue()


def _rgba_png(width, height, rgb=(200, 10, 10), opaque_box=None):
    """`opaque_box` is `(x0, y0, x1, y1)` (exclusive end) - everything outside
    it is fully transparent. `None` means the whole canvas is opaque."""
    arr = np.zeros((height, width, 4), dtype=np.uint8)
    arr[:, :, :3] = rgb
    if opaque_box is None:
        arr[:, :, 3] = 255
    else:
        x0, y0, x1, y1 = opaque_box
        arr[y0:y1, x0:x1, 3] = 255
    out = io.BytesIO()
    Image.fromarray(arr, 'RGBA').save(out, 'PNG')
    return out.getvalue()


def _open_rgba(png_bytes):
    return np.asarray(Image.open(io.BytesIO(png_bytes)).convert('RGBA'), dtype=np.uint8)


# ---------------------------------------------------------------- postprocess


def test_postprocess_upscales_layers_to_the_source_size():
    source = _rgb_png(20, 20, (10, 20, 30))
    layers = magic_layers._postprocess(source, [
        _rgba_png(10, 10, (1, 2, 3)),
        _rgba_png(10, 10, (250, 250, 250), opaque_box=(2, 2, 6, 6)),
    ])

    assert len(layers) == 2
    for layer in layers:
        assert _open_rgba(layer['png']).shape == (20, 20, 4)


def test_postprocess_marks_the_largest_opaque_layer_as_background():
    source = _rgb_png(20, 20)
    layers = magic_layers._postprocess(source, [
        # Deliberately not background-first: the model does not guarantee
        # ordering, so the detection must not just trust index 0.
        _rgba_png(10, 10, (250, 250, 250), opaque_box=(2, 2, 6, 6)),
        _rgba_png(10, 10, (1, 2, 3)),
    ])

    assert [layer['is_background'] for layer in layers] == [False, True]
    assert [layer['index'] for layer in layers] == [0, 1]


def test_postprocess_takes_foreground_rgb_from_the_full_resolution_source():
    """The model runs in ~640/1024 buckets, so its foreground RGB is soft.
    Only the alpha is kept from the model; the colours come from the original.
    """
    source = _rgb_png(20, 20, (10, 20, 30))
    layers = magic_layers._postprocess(source, [
        _rgba_png(10, 10, (1, 2, 3)),
        _rgba_png(10, 10, (250, 250, 250), opaque_box=(2, 2, 6, 6)),
    ])

    background, foreground = layers[0], layers[1]
    assert background['is_background'] is True
    # Background keeps the model's own pixels - it is the one layer holding
    # invented (inpainted) content that is not in the source at all.
    assert tuple(_open_rgba(background['png'])[0, 0, :3]) == (1, 2, 3)
    # Foreground got the source's colour, not the model's.
    fg = _open_rgba(foreground['png'])
    assert tuple(fg[8, 8, :3]) == (10, 20, 30)
    assert fg[8, 8, 3] == 255
    assert fg[0, 0, 3] == 0


def test_postprocess_drops_effectively_empty_layers():
    source = _rgb_png(20, 20)
    layers = magic_layers._postprocess(source, [
        _rgba_png(10, 10, (1, 2, 3)),
        _rgba_png(10, 10, (5, 5, 5), opaque_box=(0, 0, 0, 0)),
    ])

    assert len(layers) == 1
    assert layers[0]['index'] == 0


def test_postprocess_records_the_opaque_bbox_in_canvas_pixels():
    source = _rgb_png(20, 20)
    layers = magic_layers._postprocess(source, [
        _rgba_png(10, 10, (1, 2, 3)),
        _rgba_png(10, 10, (250, 250, 250), opaque_box=(2, 2, 6, 6)),
    ])

    assert layers[0]['bbox'] == {'x': 0, 'y': 0, 'width': 20, 'height': 20}
    box = layers[1]['bbox']
    # (2,2)-(6,6) of a 10px layer upscaled to 20px, ±1px of LANCZOS bleed.
    assert box['x'] == pytest.approx(4, abs=1)
    assert box['y'] == pytest.approx(4, abs=1)
    assert box['width'] == pytest.approx(8, abs=2)


def test_postprocess_raises_when_every_layer_is_empty():
    with pytest.raises(RuntimeError):
        magic_layers._postprocess(_rgb_png(20, 20), [_rgba_png(10, 10, opaque_box=(0, 0, 0, 0))])


def test_clamp_layers_stays_inside_the_models_range():
    assert magic_layers.clamp_layers(1) == 2
    assert magic_layers.clamp_layers(99) == 10
    assert magic_layers.clamp_layers(None) == 4
    assert magic_layers.clamp_layers('6') == 6


# ------------------------------------------------------------------ providers


def test_generate_fal_sends_a_data_uri_and_downloads_every_layer(monkeypatch):
    fake_client = _install(monkeypatch, [
        _FakeResponse(200, {'status_url': 'https://q/status', 'response_url': 'https://q/result', 'status': 'COMPLETED'}),
        _FakeResponse(200, {'images': [{'url': 'https://cdn.example/l0.png'}, {'url': 'https://cdn.example/l1.png'}]}),
        _FakeResponse(200, content=b'L0', headers={'content-type': 'image/png'}),
        _FakeResponse(200, content=b'L1', headers={'content-type': 'image/png'}),
    ])
    usage_out = {}

    layers = asyncio.run(magic_layers._generate_fal(b'SRC', 'png', 'test-key', 3, usage_out=usage_out))

    assert layers == [b'L0', b'L1']
    submit = fake_client.calls[0]
    assert submit['url'] == 'https://queue.fal.run/fal-ai/qwen-image-layered'
    assert submit['headers']['Authorization'] == 'Key test-key'
    assert submit['json']['num_layers'] == 3
    assert submit['json']['output_format'] == 'png'
    assert submit['json']['image_url'].startswith('data:image/png;base64,')
    # Raw image bytes must never reach the debug panel / usage ledger.
    assert '<image data' in usage_out['debug']['request']['body']['image_url']
    assert usage_out['debug']['response']['images'][0]['url'] == '<redacted>'


def test_generate_fal_passes_tuning_params_through(monkeypatch):
    fake_client = _install(monkeypatch, [
        _FakeResponse(200, {'status_url': 'https://q/status', 'response_url': 'https://q/result', 'status': 'COMPLETED'}),
        _FakeResponse(200, {'images': [{'url': 'https://cdn.example/l0.png'}]}),
        _FakeResponse(200, content=b'L0', headers={'content-type': 'image/png'}),
    ])

    asyncio.run(magic_layers._generate_fal(
        b'SRC', 'png', 'k', 4, params={'num_inference_steps': 15, 'acceleration': 'high'},
    ))

    body = fake_client.calls[0]['json']
    assert body['num_inference_steps'] == 15
    assert body['acceleration'] == 'high'


def test_generate_fal_without_a_key_makes_no_call(monkeypatch):
    def _no_client(**kwargs):
        raise AssertionError('must not open an HTTP client without an API key')
    monkeypatch.setattr(magic_layers.httpx, 'AsyncClient', _no_client)

    with pytest.raises(RuntimeError, match='FAL'):
        asyncio.run(magic_layers._generate_fal(b'SRC', 'png', '', 4))


def test_generate_replicate_uses_the_official_model_shorthand_route(monkeypatch):
    fake_client = _install(monkeypatch, [
        _FakeResponse(200, {'id': 'p1', 'status': 'starting', 'urls': {'get': 'https://api.replicate.com/v1/predictions/p1'}}),
        _FakeResponse(200, {
            'status': 'succeeded',
            'output': ['https://cdn.example/l0.png', 'https://cdn.example/l1.png'],
            'urls': {'get': 'https://api.replicate.com/v1/predictions/p1'},
            'metrics': {'predict_time': 12.5},
        }),
        _FakeResponse(200, content=b'L0', headers={'content-type': 'image/png'}),
        _FakeResponse(200, content=b'L1', headers={'content-type': 'image/png'}),
    ])
    usage_out = {}

    layers = asyncio.run(magic_layers._generate_replicate(b'SRC', 'png', 'test-key', 5, usage_out=usage_out))

    assert layers == [b'L0', b'L1']
    create = fake_client.calls[0]
    assert create['url'] == 'https://api.replicate.com/v1/models/qwen/qwen-image-layered/predictions'
    assert create['json']['input']['num_layers'] == 5
    assert create['json']['input']['image'].startswith('data:image/png;base64,')
    assert usage_out['compute_seconds'] == pytest.approx(12.5)
    assert '<image data' in usage_out['debug']['request']['input']['image']


def test_generate_replicate_raises_on_a_failed_prediction(monkeypatch):
    _install(monkeypatch, [
        _FakeResponse(200, {'id': 'p1', 'status': 'starting', 'urls': {'get': 'https://api.replicate.com/v1/predictions/p1'}}),
        _FakeResponse(200, {'status': 'failed', 'error': 'boom', 'urls': {'get': 'https://api.replicate.com/v1/predictions/p1'}}),
    ])

    with pytest.raises(RuntimeError, match='boom'):
        asyncio.run(magic_layers._generate_replicate(b'SRC', 'png', 'k', 4))


# ------------------------------------------------------------------ full job


def _seed_project(slug, image_bytes):
    from app import storage
    images_dir = storage.project_dir(slug) / 'images'
    images_dir.mkdir(parents=True, exist_ok=True)
    (images_dir / 'scene_1_src.png').write_bytes(image_bytes)
    storage.save_project(slug, {'id': slug, 'scenes': [{'images': []}]})
    return 'images/scene_1_src.png'


async def _await_job(job_id):
    """Waits with a real (small) delay rather than `sleep(0)` like the other
    provider tests: `_run_job` hops to a worker thread for `_postprocess`, and
    a bare yield loop would spin through its iterations before that thread
    ever gets to finish."""
    for _ in range(200):
        job = magic_layers.get_job(job_id)
        if job['status'] != 'pending':
            return job
        await _real_sleep(0.01)
    raise AssertionError('job did not resolve')


def test_start_job_writes_layer_files_and_persists_the_group(monkeypatch, usage_ledger):
    from app import storage
    source_path = _seed_project('poem-a', _rgb_png(20, 20, (10, 20, 30)))
    _install(monkeypatch, [
        _FakeResponse(200, {'status_url': 'https://q/status', 'response_url': 'https://q/result', 'status': 'COMPLETED'}),
        _FakeResponse(200, {'images': [{'url': 'https://cdn.example/l0.png'}, {'url': 'https://cdn.example/l1.png'}]}),
        _FakeResponse(200, content=_rgba_png(10, 10, (1, 2, 3)), headers={'content-type': 'image/png'}),
        _FakeResponse(200, content=_rgba_png(10, 10, (9, 9, 9), opaque_box=(2, 2, 6, 6)),
                      headers={'content-type': 'image/png'}),
    ])

    async def scenario():
        ctx = usage_ledger.context('magic_layers', 'poem-a', {})
        job_id = magic_layers.start_job(
            'poem-a', source_path, 'scene_image', {'api_keys': {'fal': 'k'}}, num_layers=2, method='fal', usage_ctx=ctx,
        )
        return await _await_job(job_id)

    job = asyncio.run(scenario())
    assert job['status'] == 'completed', job['error']

    group = job['group']
    assert group['method'] == 'fal'
    assert group['model'] == 'fal:fal-ai/qwen-image-layered'
    assert group['source_path'] == source_path
    assert group['source_kind'] == 'scene_image'
    assert group['canvas'] == {'width': 20, 'height': 20}
    assert group['num_layers'] == 2
    assert group['cost'] == pytest.approx(0.05)
    assert [layer['is_background'] for layer in group['layers']] == [True, False]

    project_root = storage.project_dir('poem-a')
    for index, layer in enumerate(group['layers']):
        assert layer['file_path'] == f'magic/{group["group_id"]}/L{index}.png'
        written = project_root / layer['file_path']
        assert written.is_file()
        with Image.open(written) as img:
            assert img.size == (20, 20)

    assert storage.load_project('poem-a')['magic_layer_groups'] == [group]

    record = usage_ledger.query()['records'][0]
    assert record['task'] == 'magic_layers'
    assert record['model'] == 'fal:fal-ai/qwen-image-layered'
    assert record['status'] == 'ok'
    assert record['units']['images'] == 1
    assert record['cost']['amount'] == pytest.approx(0.05)


def test_start_job_records_an_error_row_and_leaves_the_project_untouched(monkeypatch, usage_ledger):
    from app import storage
    source_path = _seed_project('poem-a', _rgb_png(20, 20))

    async def scenario():
        ctx = usage_ledger.context('magic_layers', 'poem-a', {})
        job_id = magic_layers.start_job(
            'poem-a', source_path, 'scene_image', {'api_keys': {}}, method='fal', usage_ctx=ctx,
        )
        return await _await_job(job_id)

    job = asyncio.run(scenario())
    assert job['status'] == 'failed'
    assert 'FAL' in job['error']
    assert 'magic_layer_groups' not in storage.load_project('poem-a')
    assert usage_ledger.query()['records'][0]['status'] == 'error'


def test_start_job_rejects_a_missing_source_file(usage_ledger):
    _seed_project('poem-a', _rgb_png(20, 20))
    with pytest.raises(ValueError):
        magic_layers.start_job('poem-a', 'images/nope.png', 'scene_image', {})
