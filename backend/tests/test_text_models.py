import pytest

from app import pricing
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


def test_list_models_deepseek_without_key_returns_error():
    import asyncio
    result = asyncio.run(text_models.list_models('deepseek', ''))
    assert result['source'] == 'error'
    assert result['models'] == []


def test_list_models_deepseek_maps_ids(monkeypatch):
    payload = {'data': [{'id': 'deepseek-chat'}]}
    fake_client = _FakeAsyncClient(_FakeResponse(200, payload))
    monkeypatch.setattr(text_models.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    import asyncio
    result = asyncio.run(text_models.list_models('deepseek', 'test-key'))

    assert result['source'] == 'live'
    assert result['models'] == [{'id': 'deepseek-chat', 'name': 'deepseek-chat'}]


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


def test_generate_wish_title_calls_deepseek_when_configured(monkeypatch):
    payload = {'choices': [{'message': {'content': 'Больше саксофона'}}]}
    fake_client = _FakeAsyncClient(_FakeResponse(200, payload))
    monkeypatch.setattr(text_models.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    import asyncio
    settings = {'simple_models': {'default': 'deepseek:deepseek-chat'}, 'api_keys': {'deepseek': 'test-key'}}
    title = asyncio.run(text_models.generate_wish_title('добавь больше саксофона', settings))

    assert title == 'Больше саксофона'
    assert fake_client.last_call['json']['model'] == 'deepseek-chat'


def test_generate_wish_title_falls_back_on_api_error(monkeypatch):
    fake_client = _FakeAsyncClient(_FakeResponse(500, text='boom'))
    monkeypatch.setattr(text_models.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    import asyncio
    settings = {'simple_models': {'default': 'google:gemini-2.0-flash-lite'}, 'api_keys': {'google': 'test-key'}}
    title = asyncio.run(text_models.generate_wish_title('добавь больше саксофона', settings))

    assert title == text_models.truncate_title('добавь больше саксофона')


@pytest.fixture
def usage_ledger(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_DATA_DIR', str(tmp_path))
    from app import usage as usage_module
    return usage_module


def test_openrouter_completion_sends_usage_include_flag(monkeypatch):
    payload = {'choices': [{'message': {'content': 'Больше саксофона'}}],
               'usage': {'prompt_tokens': 40, 'completion_tokens': 6, 'total_tokens': 46, 'cost': 0.00042}}
    fake_client = _FakeAsyncClient(_FakeResponse(200, payload))
    monkeypatch.setattr(text_models.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    import asyncio
    asyncio.run(text_models._complete_openrouter('openai/gpt-4o-mini', 'key', 'text'))

    assert fake_client.last_call['json']['usage'] == {'include': True}


def test_openrouter_completion_records_provider_reported_cost(monkeypatch, usage_ledger):
    payload = {'choices': [{'message': {'content': 'Больше саксофона'}}],
               'usage': {'prompt_tokens': 40, 'completion_tokens': 6, 'total_tokens': 46, 'cost': 0.00042}}
    fake_client = _FakeAsyncClient(_FakeResponse(200, payload))
    monkeypatch.setattr(text_models.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    import asyncio
    ctx = usage_ledger.context('wish_title', None, {})
    asyncio.run(text_models._complete_openrouter('openai/gpt-4o-mini', 'key', 'text', ctx))

    rec = usage_ledger.query()['records'][0]
    assert rec['cost']['source'] == 'provider'
    assert rec['cost']['amount'] == pytest.approx(0.00042)
    assert rec['units']['input_tokens'] == 40
    assert rec['units']['output_tokens'] == 6


def test_deepseek_completion_records_cache_hit_tokens(monkeypatch, usage_ledger):
    # 'deepseek-chat' isn't a real priced model (see pricing.BUILTIN_PRICING) -
    # a temp entry here is what makes this a test of "cached tokens get
    # costed", not "unknown", independent of what's actually priced.
    monkeypatch.setitem(
        pricing.BUILTIN_PRICING, 'deepseek:deepseek-chat',
        {'kind': 'text', 'input': 0.27, 'output': 1.10, 'cached_input': 0.07},
    )
    payload = {'choices': [{'message': {'content': 'Больше саксофона'}}],
               'usage': {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120,
                         'prompt_cache_hit_tokens': 60}}
    fake_client = _FakeAsyncClient(_FakeResponse(200, payload))
    monkeypatch.setattr(text_models.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    import asyncio
    ctx = usage_ledger.context('wish_title', None, {})
    asyncio.run(text_models._complete_deepseek('deepseek-chat', 'key', 'text', ctx))

    rec = usage_ledger.query()['records'][0]
    assert rec['units']['cached_input_tokens'] == 60
    assert rec['cost']['source'] == 'catalog'
    assert rec['cost']['amount'] is not None


def test_google_completion_records_tokens_from_usage_metadata(monkeypatch, usage_ledger):
    payload = {'candidates': [{'content': {'parts': [{'text': 'Больше саксофона'}]}}],
               'usageMetadata': {'promptTokenCount': 30, 'candidatesTokenCount': 5, 'totalTokenCount': 35}}
    fake_client = _FakeAsyncClient(_FakeResponse(200, payload))
    monkeypatch.setattr(text_models.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    import asyncio
    ctx = usage_ledger.context('wish_title', None, {})
    asyncio.run(text_models._complete_google('gemini-2.0-flash-lite', 'key', 'text', ctx))

    rec = usage_ledger.query()['records'][0]
    assert rec['units']['input_tokens'] == 30
    assert rec['units']['output_tokens'] == 5


def test_generate_wish_title_records_failed_call_even_though_it_falls_back(monkeypatch, usage_ledger):
    fake_client = _FakeAsyncClient(_FakeResponse(500, text='boom'))
    monkeypatch.setattr(text_models.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    import asyncio
    settings = {'simple_models': {'default': 'google:gemini-2.0-flash-lite'}, 'api_keys': {'google': 'test-key'}}
    ctx = usage_ledger.context('wish_title', None, settings)
    title = asyncio.run(text_models.generate_wish_title('добавь больше саксофона', settings, usage_ctx=ctx))

    assert title == text_models.truncate_title('добавь больше саксофона')
    rec = usage_ledger.query()['records'][0]
    assert rec['status'] == 'error'
    assert rec['cost']['amount'] is None
