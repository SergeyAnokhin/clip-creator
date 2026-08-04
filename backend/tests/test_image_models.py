import asyncio

from app.providers import image_models


def test_list_models_returns_curated_for_replicate():
    result = asyncio.run(image_models.list_models('replicate', ''))
    assert result['source'] == 'curated'
    assert result['models'] == image_models.CURATED_IMAGE_MODELS['replicate']


def test_list_models_returns_curated_for_fal():
    result = asyncio.run(image_models.list_models('fal', ''))
    assert result['source'] == 'curated'
    assert result['models'] == image_models.CURATED_IMAGE_MODELS['fal']


def test_list_models_returns_empty_curated_for_deepseek():
    result = asyncio.run(image_models.list_models('deepseek', ''))
    assert result['source'] == 'curated'
    assert result['models'] == []


def test_list_models_returns_curated_for_krea():
    result = asyncio.run(image_models.list_models('krea', ''))
    assert result['source'] == 'curated'
    assert result['models'] == image_models.CURATED_IMAGE_MODELS['krea']


def test_list_models_google_without_key_returns_error():
    result = asyncio.run(image_models.list_models('google', ''))
    assert result['source'] == 'error'
    assert result['models'] == []


def test_list_models_unknown_provider_returns_error():
    result = asyncio.run(image_models.list_models('anthropic', 'key'))
    assert result['source'] == 'error'


class _FakeResponse:
    def __init__(self, status_code, payload=None, text=''):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self):
        return self._payload


class _FakeAsyncClient:
    def __init__(self, response):
        self._response = response

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def get(self, url, params=None, headers=None):
        self.last_call = {'url': url, 'params': params, 'headers': headers}
        return self._response


def test_list_models_google_filters_to_predict(monkeypatch):
    payload = {'models': [
        {'name': 'models/imagen-3.0-generate', 'displayName': 'Imagen 3', 'supportedGenerationMethods': ['predict']},
        {'name': 'models/gemini-2.5-flash', 'displayName': 'Gemini 2.5 Flash', 'supportedGenerationMethods': ['generateContent']},
    ]}
    fake_client = _FakeAsyncClient(_FakeResponse(200, payload))
    monkeypatch.setattr(image_models.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    result = asyncio.run(image_models.list_models('google', 'test-key'))

    assert result['source'] == 'live'
    assert result['models'] == [{'id': 'imagen-3.0-generate', 'name': 'Imagen 3'}]


def test_list_models_google_includes_nano_banana_image_family(monkeypatch):
    payload = {'models': [
        {'name': 'models/gemini-3.1-flash-lite-image', 'displayName': 'Nano Banana 2 Lite',
         'supportedGenerationMethods': ['generateContent']},
        {'name': 'models/gemini-2.5-flash', 'displayName': 'Gemini 2.5 Flash',
         'supportedGenerationMethods': ['generateContent']},
    ]}
    fake_client = _FakeAsyncClient(_FakeResponse(200, payload))
    monkeypatch.setattr(image_models.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    result = asyncio.run(image_models.list_models('google', 'test-key'))

    assert result['source'] == 'live'
    assert result['models'] == [{'id': 'gemini-3.1-flash-lite-image', 'name': 'Nano Banana 2 Lite'}]


def test_list_models_google_error_status_returns_error(monkeypatch):
    fake_client = _FakeAsyncClient(_FakeResponse(500, text='boom'))
    monkeypatch.setattr(image_models.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    result = asyncio.run(image_models.list_models('google', 'test-key'))

    assert result['source'] == 'error'
    assert result['models'] == []


def test_list_models_openrouter_filters_to_image_output_modality(monkeypatch):
    payload = {'data': [
        {'id': 'google/gemini-3.1-flash-lite-image', 'name': 'Nano Banana 2 Lite',
         'architecture': {'output_modalities': ['text', 'image']}},
        {'id': 'openai/gpt-4o-mini', 'name': 'GPT-4o mini',
         'architecture': {'output_modalities': ['text']}},
    ]}
    fake_client = _FakeAsyncClient(_FakeResponse(200, payload))
    monkeypatch.setattr(image_models.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    result = asyncio.run(image_models.list_models('openrouter', ''))

    assert result['source'] == 'live'
    assert result['models'] == [{'id': 'google/gemini-3.1-flash-lite-image', 'name': 'Nano Banana 2 Lite'}]


def test_list_models_openrouter_error_status_returns_error(monkeypatch):
    fake_client = _FakeAsyncClient(_FakeResponse(500, text='boom'))
    monkeypatch.setattr(image_models.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    result = asyncio.run(image_models.list_models('openrouter', ''))

    assert result['source'] == 'error'
    assert result['models'] == []


def test_is_gemini_image_model_matches_known_ids():
    assert image_models.is_gemini_image_model('gemini-3.1-flash-lite-image')
    assert image_models.is_gemini_image_model('gemini-2.5-flash-image')
    assert not image_models.is_gemini_image_model('gemini-2.5-flash')
