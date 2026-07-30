import pytest

from app.providers import text_models


def test_list_models_returns_curated_for_replicate():
    import asyncio
    result = asyncio.run(text_models.list_models('replicate', ''))
    assert result['source'] == 'curated'
    assert result['models'] == text_models.CURATED_MODELS['replicate']


def test_list_models_returns_curated_for_fal():
    import asyncio
    result = asyncio.run(text_models.list_models('fal', ''))
    assert result['source'] == 'curated'
    assert result['models'] == text_models.CURATED_MODELS['fal']


def test_list_models_google_without_key_returns_error():
    import asyncio
    result = asyncio.run(text_models.list_models('google', ''))
    assert result['source'] == 'error'
    assert result['models'] == []


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

    async def post(self, url, params=None, headers=None, json=None):
        self.last_call = {'url': url, 'params': params, 'headers': headers, 'json': json}
        return self._response


def test_list_models_google_filters_to_generate_content(monkeypatch):
    payload = {'models': [
        {'name': 'models/gemini-2.5-flash', 'displayName': 'Gemini 2.5 Flash', 'supportedGenerationMethods': ['generateContent']},
        {'name': 'models/embedding-001', 'displayName': 'Embedding', 'supportedGenerationMethods': ['embedContent']},
    ]}
    fake_client = _FakeAsyncClient(_FakeResponse(200, payload))
    monkeypatch.setattr(text_models.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    import asyncio
    result = asyncio.run(text_models.list_models('google', 'test-key'))

    assert result['source'] == 'live'
    assert result['models'] == [{'id': 'gemini-2.5-flash', 'name': 'Gemini 2.5 Flash'}]


def test_list_models_openrouter_maps_ids(monkeypatch):
    payload = {'data': [{'id': 'openai/gpt-4o-mini', 'name': 'GPT-4o mini'}]}
    fake_client = _FakeAsyncClient(_FakeResponse(200, payload))
    monkeypatch.setattr(text_models.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    import asyncio
    result = asyncio.run(text_models.list_models('openrouter', ''))

    assert result['source'] == 'live'
    assert result['models'] == [{'id': 'openai/gpt-4o-mini', 'name': 'GPT-4o mini'}]


def test_list_models_unknown_provider_returns_error():
    import asyncio
    result = asyncio.run(text_models.list_models('anthropic', 'key'))
    assert result['source'] == 'error'


def test_truncate_title_shortens_long_text():
    title = text_models.truncate_title('добавь больше саксофона и медленнее темп в припеве пожалуйста')
    assert title.endswith('…')
    assert len(title) <= 41


def test_truncate_title_keeps_short_text_as_is():
    assert text_models.truncate_title('добавь драйва') == 'добавь драйва'


def test_generate_wish_title_falls_back_without_simple_model():
    import asyncio
    settings = {'simple_models': {'default': ''}, 'api_keys': {}}
    title = asyncio.run(text_models.generate_wish_title('добавь больше саксофона', settings))
    assert title == text_models.truncate_title('добавь больше саксофона')


def test_generate_wish_title_falls_back_when_key_missing():
    import asyncio
    settings = {'simple_models': {'default': 'google:gemini-2.0-flash-lite'}, 'api_keys': {'google': ''}}
    title = asyncio.run(text_models.generate_wish_title('добавь больше саксофона', settings))
    assert title == text_models.truncate_title('добавь больше саксофона')


def test_generate_wish_title_calls_google_when_configured(monkeypatch):
    payload = {'candidates': [{'content': {'parts': [{'text': 'Больше саксофона'}]}}]}
    fake_client = _FakeAsyncClient(_FakeResponse(200, payload))
    monkeypatch.setattr(text_models.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    import asyncio
    settings = {'simple_models': {'default': 'google:gemini-2.0-flash-lite'}, 'api_keys': {'google': 'test-key'}}
    title = asyncio.run(text_models.generate_wish_title('добавь больше саксофона', settings))

    assert title == 'Больше саксофона'
    assert 'gemini-2.0-flash-lite' in fake_client.last_call['url']


def test_generate_wish_title_calls_openrouter_when_configured(monkeypatch):
    payload = {'choices': [{'message': {'content': 'Больше саксофона'}}]}
    fake_client = _FakeAsyncClient(_FakeResponse(200, payload))
    monkeypatch.setattr(text_models.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    import asyncio
    settings = {'simple_models': {'default': 'openrouter:openai/gpt-4o-mini'}, 'api_keys': {'openrouter': 'test-key'}}
    title = asyncio.run(text_models.generate_wish_title('добавь больше саксофона', settings))

    assert title == 'Больше саксофона'
    assert fake_client.last_call['json']['model'] == 'openai/gpt-4o-mini'


def test_generate_wish_title_falls_back_on_api_error(monkeypatch):
    fake_client = _FakeAsyncClient(_FakeResponse(500, text='boom'))
    monkeypatch.setattr(text_models.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    import asyncio
    settings = {'simple_models': {'default': 'google:gemini-2.0-flash-lite'}, 'api_keys': {'google': 'test-key'}}
    title = asyncio.run(text_models.generate_wish_title('добавь больше саксофона', settings))

    assert title == text_models.truncate_title('добавь больше саксофона')
