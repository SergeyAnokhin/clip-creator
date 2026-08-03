import asyncio

import pytest

from app.providers import scenes


def test_generate_falls_back_to_stub_without_api_key():
    project = {'blocks': [{'id': 'b1', 'type': 'verse', 'content': 'Line one'}]}

    result = asyncio.run(scenes.generate(project, model='google:gemini-2.5-flash', scene_count=2, settings={'api_keys': {'google': ''}}))

    assert result['debug'] == {'stub': True, 'reason': 'no_api_key', 'requested_model': 'google:gemini-2.5-flash'}
    assert len(result['scenes']) == 2
    assert result['scenes'][0]['lyric_segment'] == 'Line one'


def test_generate_falls_back_to_stub_for_unsupported_provider():
    project = {'blocks': [{'id': 'b1', 'type': 'verse', 'content': 'Line one'}]}

    result = asyncio.run(scenes.generate(project, model='replicate:some-model', settings={'api_keys': {'google': 'key'}}))

    assert result['debug'] == {'stub': True, 'reason': 'unsupported_provider', 'requested_model': 'replicate:some-model'}


def test_generate_falls_back_to_stub_when_no_model_selected():
    project = {'blocks': [{'id': 'b1', 'type': 'verse', 'content': 'Line one'}]}

    result = asyncio.run(scenes.generate(project, model='', settings={'api_keys': {'google': 'key'}}))

    assert result['debug'] == {'stub': True, 'reason': 'no_model_selected', 'requested_model': ''}


def test_parse_model_response_reads_json_block():
    text = '```json\n[{"lyric_segment": "a", "static_prompt": "sp", "motion_prompt": "mp"}]\n```'
    scenes_out, missing = scenes._parse_model_response(text, ['a'], 1, 'style', [])
    assert missing is False
    assert scenes_out == [{'lyric_segment': 'a', 'static_prompt': 'sp', 'motion_prompt': 'mp', 'images': []}]


def test_parse_model_response_pads_short_list_and_flags_missing_markers():
    text = '```json\n[{"lyric_segment": "a", "static_prompt": "sp", "motion_prompt": "mp"}]\n```'
    scenes_out, missing = scenes._parse_model_response(text, ['a', 'b'], 2, 'style', [])
    assert missing is True
    assert len(scenes_out) == 2
    assert scenes_out[0]['static_prompt'] == 'sp'
    assert scenes_out[1]['static_prompt']  # falls back to a generic placeholder, never empty


def test_parse_model_response_without_json_falls_back_to_stub_scenes():
    scenes_out, missing = scenes._parse_model_response('not json at all', ['line one'], 1, 'Cinematic', [])
    assert missing is True
    assert len(scenes_out) == 1
    assert 'line one' in scenes_out[0]['static_prompt']


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

    async def post(self, url, params=None, json=None, headers=None):
        self.last_call = {'url': url, 'params': params, 'json': json, 'headers': headers}
        return self._response


@pytest.fixture
def usage_ledger(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_DATA_DIR', str(tmp_path))
    from app import usage as usage_module
    return usage_module


def test_generate_calls_gemini_and_parses_json_scenes(monkeypatch):
    payload = {
        'candidates': [{'content': {'parts': [{'text': (
            '```json\n[{"lyric_segment": "Line one", "static_prompt": "((sad man))", "motion_prompt": "slow drift"}]\n```'
        )}]}}],
    }
    fake_client = _FakeAsyncClient(_FakeResponse(200, payload))
    monkeypatch.setattr(scenes.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    project = {'blocks': [{'id': 'b1', 'type': 'verse', 'content': 'Line one'}]}
    settings = {
        'api_keys': {'google': 'test-key'},
        'scene_base_prompt_narrative': 'BASE RULES',
    }
    result = asyncio.run(scenes.generate(project, model='google:gemini-2.5-flash', scene_count=1, settings=settings))

    assert result['scenes'] == [{'lyric_segment': 'Line one', 'static_prompt': '((sad man))', 'motion_prompt': 'slow drift', 'images': []}]
    assert result['debug']['stub'] is False
    assert result['debug']['missing_markers'] is False
    assert 'BASE RULES' in fake_client.last_call['json']['contents'][0]['parts'][0]['text']


def test_generate_records_usage_with_token_counts(monkeypatch, usage_ledger):
    payload = {
        'candidates': [{'content': {'parts': [{'text': '```json\n[{"lyric_segment": "a", "static_prompt": "sp", "motion_prompt": "mp"}]\n```'}]}}],
        'usageMetadata': {'promptTokenCount': 300, 'candidatesTokenCount': 80, 'totalTokenCount': 380},
    }
    fake_client = _FakeAsyncClient(_FakeResponse(200, payload))
    monkeypatch.setattr(scenes.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    project = {'blocks': [{'id': 'b1', 'type': 'verse', 'content': 'Raw line'}]}
    settings = {'api_keys': {'google': 'test-key'}}
    ctx = usage_ledger.context('scene_storyboard', 'my-poem', settings)

    result = asyncio.run(scenes.generate(project, model='google:gemini-2.5-flash', scene_count=1, settings=settings, usage_ctx=ctx))

    assert result['debug']['usage']['input_tokens'] == 300
    assert result['debug']['usage']['output_tokens'] == 80
    rec = usage_ledger.query()['records'][0]
    assert rec['status'] == 'ok'
    assert rec['units']['input_tokens'] == 300


def test_generate_raises_clear_timeout_error_and_records_it(monkeypatch, usage_ledger):
    class _TimeoutClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, *args, **kwargs):
            raise scenes.httpx.ReadTimeout('timed out')

    monkeypatch.setattr(scenes.httpx, 'AsyncClient', lambda **kwargs: _TimeoutClient())

    project = {'blocks': [{'id': 'b1', 'type': 'verse', 'content': 'Raw line'}]}
    settings = {'api_keys': {'google': 'test-key'}}
    ctx = usage_ledger.context('scene_storyboard', 'my-poem', settings)

    with pytest.raises(RuntimeError, match='Таймаут'):
        asyncio.run(scenes.generate(project, model='google:gemini-2.5-flash', settings=settings, usage_ctx=ctx))

    rec = usage_ledger.query()['records'][0]
    assert rec['status'] == 'error'
    assert 'Таймаут' in rec['error']


def test_stub_fallback_records_nothing_because_no_call_was_made(usage_ledger):
    project = {'blocks': [{'id': 'b1', 'type': 'verse', 'content': 'Line one'}]}
    ctx = usage_ledger.context('scene_storyboard', 'my-poem', {})

    asyncio.run(scenes.generate(project, model='', settings={}, usage_ctx=ctx))

    assert usage_ledger.query()['records'] == []
