import asyncio

import pytest

from app.providers import translate


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
        self.last_call = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, params=None, json=None):
        self.last_call = {'url': url, 'params': params, 'json': json}
        return self._response


def _install(monkeypatch, response):
    fake_client = _FakeAsyncClient(response)
    monkeypatch.setattr(translate.httpx, 'AsyncClient', lambda **kwargs: fake_client)
    return fake_client


def test_translate_text_empty_returns_empty():
    assert asyncio.run(translate.translate_text('', 'ru', 'key')) == ''


def test_translate_text_missing_key_raises():
    with pytest.raises(RuntimeError, match='API-ключа'):
        asyncio.run(translate.translate_text('hello', 'ru', ''))


def test_translate_text_success(monkeypatch):
    payload = {'data': {'translations': [{'translatedText': 'привет'}]}}
    fake_client = _install(monkeypatch, _FakeResponse(200, payload))

    result = asyncio.run(translate.translate_text('hello', 'ru', 'test-key'))

    assert result == 'привет'
    assert fake_client.last_call['url'] == translate._TRANSLATE_URL
    assert fake_client.last_call['params'] == {'key': 'test-key'}
    assert fake_client.last_call['json'] == {'q': 'hello', 'target': 'ru', 'format': 'text'}


def test_translate_text_error_status_raises(monkeypatch):
    _install(monkeypatch, _FakeResponse(500, text='boom'))
    with pytest.raises(RuntimeError, match='500'):
        asyncio.run(translate.translate_text('hello', 'ru', 'test-key'))


def test_translate_text_empty_translations_raises(monkeypatch):
    _install(monkeypatch, _FakeResponse(200, {'data': {'translations': []}}))
    with pytest.raises(RuntimeError, match='Google Translate'):
        asyncio.run(translate.translate_text('hello', 'ru', 'test-key'))


@pytest.fixture
def usage_ledger(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_DATA_DIR', str(tmp_path))
    from app import usage as usage_module
    return usage_module


def test_translate_text_records_usage_on_success(monkeypatch, usage_ledger):
    payload = {'data': {'translations': [{'translatedText': 'привет'}]}}
    _install(monkeypatch, _FakeResponse(200, payload))

    ctx = usage_ledger.context('translate', None, {})
    asyncio.run(translate.translate_text('hello', 'ru', 'test-key', usage_ctx=ctx))

    rec = usage_ledger.query()['records'][0]
    assert rec['status'] == 'ok'
    assert rec['units']['characters'] == 5
    assert rec['response_preview'] == 'привет'


def test_translate_text_records_usage_on_error(monkeypatch, usage_ledger):
    _install(monkeypatch, _FakeResponse(500, text='boom'))

    ctx = usage_ledger.context('translate', None, {})
    with pytest.raises(RuntimeError):
        asyncio.run(translate.translate_text('hello', 'ru', 'test-key', usage_ctx=ctx))

    rec = usage_ledger.query()['records'][0]
    assert rec['status'] == 'error'


def test_translate_route_returns_translated_text(client, monkeypatch):
    payload = {'data': {'translations': [{'translatedText': 'привет'}]}}
    _install(monkeypatch, _FakeResponse(200, payload))
    client.put('/api/settings', json={'api_keys': {'google_translate': 'test-key'}})

    resp = client.post('/api/translate', json={'text': 'hello'})

    assert resp.status_code == 200
    assert resp.json() == {'translated': 'привет'}


def test_translate_route_requires_text(client):
    resp = client.post('/api/translate', json={'text': '  '})
    assert resp.status_code == 422


def test_translate_route_surfaces_provider_failure_as_502(client, monkeypatch):
    _install(monkeypatch, _FakeResponse(500, text='boom'))
    client.put('/api/settings', json={'api_keys': {'google_translate': 'test-key'}})

    resp = client.post('/api/translate', json={'text': 'hello'})

    assert resp.status_code == 502
