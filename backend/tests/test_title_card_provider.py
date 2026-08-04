import asyncio
import base64

import pytest

from app.providers import title_card


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
    monkeypatch.setattr(title_card.asyncio, 'sleep', _FastSleep())


def _install(monkeypatch, responses):
    fake_client = _FakeAsyncClient(responses)
    monkeypatch.setattr(title_card.httpx, 'AsyncClient', lambda **kwargs: fake_client)
    return fake_client


_REFS = [(b'REF1DATA', 'png'), (b'REF2DATA', 'jpg')]


def test_generate_google_sends_one_inline_data_part_per_reference(monkeypatch):
    payload = {'candidates': [{'content': {'parts': [
        {'inlineData': {'data': base64.b64encode(b'PNGDATA').decode(), 'mimeType': 'image/png'}},
    ]}}]}
    fake_client = _install(monkeypatch, [_FakeResponse(200, payload)])

    content, ext = asyncio.run(title_card._generate_google('gemini-3.1-flash-lite-image', 'render this', _REFS, 'test-key'))

    assert content == b'PNGDATA'
    assert ext == 'png'
    call = fake_client.calls[0]
    assert call['url'] == 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-image:generateContent'
    assert call['params'] == {'key': 'test-key'}
    parts = call['json']['contents'][0]['parts']
    assert len(parts) == 3
    assert parts[0]['inline_data']['mime_type'] == 'image/png'
    assert parts[0]['inline_data']['data'] == base64.b64encode(b'REF1DATA').decode()
    assert parts[1]['inline_data']['mime_type'] == 'image/jpeg'
    assert parts[2] == {'text': 'render this'}
    assert call['json']['generationConfig'] == {'responseModalities': ['IMAGE']}


def test_generate_google_aspect_ratio_sets_image_config(monkeypatch):
    payload = {'candidates': [{'content': {'parts': [
        {'inlineData': {'data': base64.b64encode(b'PNGDATA').decode(), 'mimeType': 'image/png'}},
    ]}}]}
    _install(monkeypatch, [_FakeResponse(200, payload)])

    asyncio.run(title_card._generate_google('gemini-3.1-flash-lite-image', 'p', _REFS, 'key', aspect_ratio='16:9'))


def test_generate_google_records_redacted_debug_info(monkeypatch):
    payload = {'candidates': [{'content': {'parts': [
        {'inlineData': {'data': base64.b64encode(b'PNGDATA').decode(), 'mimeType': 'image/png'}},
    ]}}]}
    _install(monkeypatch, [_FakeResponse(200, payload)])
    usage_out = {}

    asyncio.run(title_card._generate_google('gemini-3.1-flash-lite-image', 'render this', _REFS, 'test-key', usage_out=usage_out))

    debug = usage_out['debug']
    assert debug['request']['prompt'] == 'render this'
    assert debug['request']['reference_images'] == ['<png image, 8 bytes>', '<jpg image, 8 bytes>']
    redacted_data = debug['response']['candidates'][0]['content']['parts'][0]['inlineData']['data']
    assert redacted_data.startswith('<image data omitted')
    assert base64.b64encode(b'PNGDATA').decode() not in str(debug['response'])


def test_generate_google_missing_key_raises():
    with pytest.raises(RuntimeError, match='Google'):
        asyncio.run(title_card._generate_google('gemini-3.1-flash-lite-image', 'p', _REFS, ''))


def test_generate_google_error_status_raises(monkeypatch):
    _install(monkeypatch, [_FakeResponse(500, text='boom')])
    with pytest.raises(RuntimeError, match='500'):
        asyncio.run(title_card._generate_google('gemini-3.1-flash-lite-image', 'p', _REFS, 'key'))


def test_generate_google_no_image_in_response_raises(monkeypatch):
    _install(monkeypatch, [_FakeResponse(200, {'candidates': [{'content': {'parts': [{'text': 'no image, sorry'}]}}]})])
    with pytest.raises(RuntimeError, match='нет изображения'):
        asyncio.run(title_card._generate_google('gemini-3.1-flash-lite-image', 'p', _REFS, 'key'))


def test_generate_krea_sends_style_images_and_polls_to_completion(monkeypatch):
    fake_client = _install(monkeypatch, [
        _FakeResponse(200, {'job_id': 'j1', 'status': 'queued'}),
        _FakeResponse(200, {'status': 'processing'}),
        _FakeResponse(200, {'status': 'completed', 'result': {'urls': ['https://cdn.example/poster.png']}}),
        _FakeResponse(200, content=b'PNGDATA', headers={'content-type': 'image/png'}),
    ])

    content, ext = asyncio.run(title_card._generate_krea('google/nano-banana-pro', 'render this', _REFS, 'test-key'))

    assert content == b'PNGDATA'
    assert ext == 'png'
    first_call = fake_client.calls[0]
    assert first_call['url'] == 'https://api.krea.ai/generate/image/google/nano-banana-pro'
    style_images = first_call['json']['style_images']
    assert len(style_images) == 2
    assert style_images[0] == {'url': f'data:image/png;base64,{base64.b64encode(b"REF1DATA").decode()}', 'strength': 1}
    assert style_images[1]['url'].startswith('data:image/jpeg;base64,')


def test_generate_krea_rejects_unsupported_model():
    with pytest.raises(RuntimeError, match='не поддерживает'):
        asyncio.run(title_card._generate_krea('krea/krea-2/medium', 'p', _REFS, 'key'))


def test_generate_krea_missing_key_raises():
    with pytest.raises(RuntimeError, match='Krea'):
        asyncio.run(title_card._generate_krea('google/nano-banana-pro', 'p', _REFS, ''))


def test_generate_krea_failed_status_raises(monkeypatch):
    _install(monkeypatch, [
        _FakeResponse(200, {'job_id': 'j1', 'status': 'queued'}),
        _FakeResponse(200, {'status': 'failed'}),
    ])
    with pytest.raises(RuntimeError, match='failed'):
        asyncio.run(title_card._generate_krea('google/nano-banana-pro', 'p', _REFS, 'key'))


def test_generate_fal_sends_image_urls_and_polls_to_completion(monkeypatch):
    fake_client = _install(monkeypatch, [
        _FakeResponse(200, {'status_url': 'https://q/status', 'response_url': 'https://q/result', 'status': 'IN_QUEUE'}),
        _FakeResponse(200, {'status': 'COMPLETED'}),
        _FakeResponse(200, {'images': [{'url': 'https://cdn.example/poster.png'}], 'has_nsfw_concepts': [False]}),
        _FakeResponse(200, content=b'PNGDATA', headers={'content-type': 'image/png'}),
    ])

    content, ext = asyncio.run(title_card._generate_fal('fal-ai/nano-banana/edit', 'render this', _REFS, 'test-key'))

    assert content == b'PNGDATA'
    assert ext == 'png'
    first_call = fake_client.calls[0]
    assert first_call['url'] == 'https://queue.fal.run/fal-ai/nano-banana/edit'
    image_urls = first_call['json']['image_urls']
    assert len(image_urls) == 2
    assert image_urls[0] == f'data:image/png;base64,{base64.b64encode(b"REF1DATA").decode()}'
    assert image_urls[1].startswith('data:image/jpeg;base64,')


def test_generate_fal_rejects_unsupported_model():
    with pytest.raises(RuntimeError, match='не поддерживает'):
        asyncio.run(title_card._generate_fal('fal-ai/flux/dev', 'p', _REFS, 'key'))


def test_generate_fal_missing_key_raises():
    with pytest.raises(RuntimeError, match='FAL'):
        asyncio.run(title_card._generate_fal('fal-ai/nano-banana/edit', 'p', _REFS, ''))


def test_generate_fal_nsfw_flag_raises(monkeypatch):
    _install(monkeypatch, [
        _FakeResponse(200, {'status_url': 'https://q/status', 'response_url': 'https://q/result', 'status': 'COMPLETED'}),
        _FakeResponse(200, {'images': [{'url': 'https://cdn.example/poster.png'}], 'has_nsfw_concepts': [True]}),
    ])
    with pytest.raises(RuntimeError, match='модерацией'):
        asyncio.run(title_card._generate_fal('fal-ai/nano-banana/edit', 'p', _REFS, 'key'))


def test_generate_openrouter_sends_input_references(monkeypatch):
    fake_client = _install(monkeypatch, [
        _FakeResponse(200, {'data': [{'b64_json': base64.b64encode(b'PNGDATA').decode(), 'media_type': 'image/png'}]}),
    ])

    content, ext = asyncio.run(title_card._generate_openrouter('openai/gpt-image-1', 'render this', _REFS, 'test-key'))

    assert content == b'PNGDATA'
    assert ext == 'png'
    call = fake_client.calls[0]
    assert call['url'] == 'https://openrouter.ai/api/v1/images'
    refs = call['json']['input_references']
    assert len(refs) == 2
    assert refs[0] == {'type': 'image_url', 'image_url': {'url': f'data:image/png;base64,{base64.b64encode(b"REF1DATA").decode()}'}}
    assert refs[1]['image_url']['url'].startswith('data:image/jpeg;base64,')


def test_generate_openrouter_missing_key_raises():
    with pytest.raises(RuntimeError, match='OpenRouter'):
        asyncio.run(title_card._generate_openrouter('openai/gpt-image-1', 'p', _REFS, ''))


def test_generate_openrouter_error_status_raises(monkeypatch):
    _install(monkeypatch, [_FakeResponse(500, text='boom')])
    with pytest.raises(RuntimeError, match='500'):
        asyncio.run(title_card._generate_openrouter('openai/gpt-image-1', 'p', _REFS, 'key'))


def test_build_prompt_appends_text_block_verbatim():
    prompt = title_card._build_prompt('Base instructions', '"Зимнее утро"\n"Пушкин"')
    assert prompt == 'Base instructions\n"Зимнее утро"\n"Пушкин"'


def test_build_prompt_omits_blank_text_block():
    prompt = title_card._build_prompt('Base instructions', '')
    assert prompt == 'Base instructions'


def test_build_prompt_includes_active_wishes_before_text_block():
    prompt = title_card._build_prompt('Base instructions', '"Заголовок"', ['Больше контраста', 'Крупнее шрифт'])
    assert prompt == (
        'Base instructions\n\n'
        'ВАЖНЫЕ ТРЕБОВАНИЯ ПОЛЬЗОВАТЕЛЯ — обязательно учесть:\n'
        '1. Больше контраста\n2. Крупнее шрифт\n'
        '"Заголовок"'
    )


def test_start_jobs_unknown_provider_fails_job(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_DATA_DIR', str(tmp_path))
    from app import storage
    ref_dir = storage.project_dir('poem-a') / 'references'
    ref_dir.mkdir(parents=True)
    (ref_dir / 'ref_1.png').write_bytes(b'REFDATA')

    async def scenario():
        job_ids = title_card.start_jobs(
            'poem-a', ['references/ref_1.png'], '"Title"\n"Author"', 'base', 1, 'unknownprovider:x', {'api_keys': {}},
        )
        for _ in range(200):
            job = title_card.get_job(job_ids[0])
            if job['status'] != 'pending':
                return job
            await asyncio.sleep(0)
        raise AssertionError('job did not resolve')

    job = asyncio.run(scenario())
    assert job['status'] == 'failed'
    assert 'unknownprovider' in job['error']


def test_get_job_unknown_id_returns_none():
    assert title_card.get_job('does-not-exist') is None
