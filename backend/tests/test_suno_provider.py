import pytest

from app.providers import suno


def test_generate_falls_back_to_stub_without_gemini_key():
    project = {'blocks': [{'id': 'b1', 'type': 'verse', 'content': 'Line one'}]}

    import asyncio
    result = asyncio.run(suno.generate(project, model='google:gemini-2.5-flash', settings={'api_keys': {'google': ''}}))

    assert result == {'style': 'Cinematic Orchestral Folk, Warm Vocal, 90 BPM, Nostalgic', 'lyrics': '[Verse]\nLine one'}


def test_generate_falls_back_to_stub_for_non_google_provider():
    project = {'blocks': [{'id': 'b1', 'type': 'verse', 'content': 'Line one'}]}

    import asyncio
    result = asyncio.run(suno.generate(project, model='replicate:some-model', settings={'api_keys': {'google': 'key'}}))

    assert result['lyrics'] == '[Verse]\nLine one'


def test_parse_gemini_response_splits_on_markers():
    text = f'{suno._STYLE_MARKER}\nSynthpop, 128 BPM\n{suno._LYRICS_MARKER}\n[Verse]\nHello'
    result = suno._parse_gemini_response(text, fallback_lyrics='fallback')
    assert result == {'style': 'Synthpop, 128 BPM', 'lyrics': '[Verse]\nHello'}


def test_parse_gemini_response_without_markers_falls_back_to_raw_text():
    result = suno._parse_gemini_response('some unstructured reply', fallback_lyrics='fallback')
    assert result == {'style': '', 'lyrics': 'some unstructured reply'}


def test_build_gemini_prompt_includes_base_examples_and_skill_prompt():
    settings = {
        'suno_base_prompt': 'BASE RULES',
        'suno_reference_examples': ['EXAMPLE ONE'],
    }
    prompt = suno._build_gemini_prompt('[Verse]\nRaw poem', 'SKILL PROMPT', settings)

    assert 'BASE RULES' in prompt
    assert 'EXAMPLE ONE' in prompt
    assert 'SKILL PROMPT' in prompt
    assert '[Verse]\nRaw poem' in prompt
    assert suno._STYLE_MARKER in prompt
    assert suno._LYRICS_MARKER in prompt


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

    async def post(self, url, params=None, json=None):
        self.last_call = {'url': url, 'params': params, 'json': json}
        return self._response


def test_generate_calls_gemini_and_parses_result(monkeypatch):
    payload = {
        'candidates': [{'content': {'parts': [{'text': (
            f'{suno._STYLE_MARKER}\nSynthpop\n{suno._LYRICS_MARKER}\n[Verse]\nAdapted'
        )}]}}],
    }
    fake_client = _FakeAsyncClient(_FakeResponse(200, payload))
    monkeypatch.setattr(suno.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    project = {'blocks': [{'id': 'b1', 'type': 'verse', 'content': 'Raw line'}]}
    settings = {'api_keys': {'google': 'test-key'},
                'suno_base_prompt': 'BASE', 'suno_reference_examples': []}

    import asyncio
    result = asyncio.run(suno.generate(project, skill_prompt='Adapt it', model='google:gemini-2.5-flash', settings=settings))

    assert result == {'style': 'Synthpop', 'lyrics': '[Verse]\nAdapted'}
    assert fake_client.last_call['params'] == {'key': 'test-key'}
    assert 'gemini-2.5-flash' in fake_client.last_call['url']


def test_generate_raises_on_non_200_gemini_response(monkeypatch):
    fake_client = _FakeAsyncClient(_FakeResponse(429, text='rate limited'))
    monkeypatch.setattr(suno.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    project = {'blocks': []}
    settings = {'api_keys': {'google': 'test-key'}}

    import asyncio
    with pytest.raises(RuntimeError, match='429'):
        asyncio.run(suno.generate(project, model='google:gemini-2.5-flash', settings=settings))


@pytest.fixture
def usage_ledger(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_DATA_DIR', str(tmp_path))
    from app import usage as usage_module
    return usage_module


def test_generate_records_usage_with_token_counts(monkeypatch, usage_ledger):
    payload = {
        'candidates': [{'content': {'parts': [{'text': (
            f'{suno._STYLE_MARKER}\nSynthpop\n{suno._LYRICS_MARKER}\n[Verse]\nAdapted'
        )}]}}],
        'usageMetadata': {'promptTokenCount': 500, 'candidatesTokenCount': 120, 'totalTokenCount': 620},
    }
    fake_client = _FakeAsyncClient(_FakeResponse(200, payload))
    monkeypatch.setattr(suno.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    project = {'blocks': [{'id': 'b1', 'type': 'verse', 'content': 'Raw line'}]}
    settings = {'api_keys': {'google': 'test-key'}, 'suno_base_prompt': 'BASE', 'suno_reference_examples': []}
    ctx = usage_ledger.context('suno_generate', 'my-poem', settings, skill_id='skill_a')

    import asyncio
    asyncio.run(suno.generate(project, skill_prompt='Adapt it', model='google:gemini-2.5-flash',
                               settings=settings, usage_ctx=ctx))

    records = usage_ledger.query()['records']
    assert len(records) == 1
    rec = records[0]
    assert rec['task'] == 'suno_generate'
    assert rec['project_id'] == 'my-poem'
    assert rec['model'] == 'google:gemini-2.5-flash'
    assert rec['status'] == 'ok'
    assert rec['units']['input_tokens'] == 500
    assert rec['units']['output_tokens'] == 120
    assert rec['meta']['skill_id'] == 'skill_a'


def test_generate_records_error_on_non_200_and_still_raises(monkeypatch, usage_ledger):
    fake_client = _FakeAsyncClient(_FakeResponse(429, text='rate limited'))
    monkeypatch.setattr(suno.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    project = {'blocks': []}
    settings = {'api_keys': {'google': 'test-key'}}
    ctx = usage_ledger.context('suno_generate', 'my-poem', settings)

    import asyncio
    with pytest.raises(RuntimeError, match='429'):
        asyncio.run(suno.generate(project, model='google:gemini-2.5-flash', settings=settings, usage_ctx=ctx))

    rec = usage_ledger.query()['records'][0]
    assert rec['status'] == 'error'
    assert rec['cost']['amount'] is None


def test_stub_fallback_records_nothing_because_no_call_was_made(usage_ledger):
    project = {'blocks': [{'id': 'b1', 'type': 'verse', 'content': 'Line one'}]}
    settings = {'api_keys': {'google': ''}}
    ctx = usage_ledger.context('suno_generate', 'my-poem', settings)

    import asyncio
    asyncio.run(suno.generate(project, model='google:gemini-2.5-flash', settings=settings, usage_ctx=ctx))

    assert usage_ledger.query()['total'] == 0
