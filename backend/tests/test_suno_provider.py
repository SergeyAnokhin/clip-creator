import pytest

from app.providers import suno


def test_generate_falls_back_to_stub_without_api_key():
    project = {'blocks': [{'id': 'b1', 'type': 'verse', 'content': 'Line one'}]}

    import asyncio
    result = asyncio.run(suno.generate(project, model='google:gemini-2.5-flash', settings={'api_keys': {'google': ''}}))

    assert result['style'] == 'Cinematic Orchestral Folk, Warm Vocal, 90 BPM, Nostalgic'
    assert result['lyrics'] == '[Verse]\nLine one'
    assert result['debug'] == {'stub': True, 'reason': 'no_api_key', 'requested_model': 'google:gemini-2.5-flash'}


def test_generate_falls_back_to_stub_for_unsupported_provider():
    project = {'blocks': [{'id': 'b1', 'type': 'verse', 'content': 'Line one'}]}

    import asyncio
    result = asyncio.run(suno.generate(project, model='replicate:some-model', settings={'api_keys': {'google': 'key'}}))

    assert result['lyrics'] == '[Verse]\nLine one'
    assert result['debug'] == {'stub': True, 'reason': 'unsupported_provider', 'requested_model': 'replicate:some-model'}


def test_generate_falls_back_to_stub_when_no_model_selected():
    project = {'blocks': [{'id': 'b1', 'type': 'verse', 'content': 'Line one'}]}

    import asyncio
    result = asyncio.run(suno.generate(project, model='', settings={'api_keys': {'google': 'key'}}))

    assert result['debug'] == {'stub': True, 'reason': 'no_model_selected', 'requested_model': ''}


def test_parse_model_response_splits_on_markers():
    text = f'{suno._STYLE_MARKER}\nSynthpop, 128 BPM\n{suno._LYRICS_MARKER}\n[Verse]\nHello'
    result = suno._parse_model_response(text, fallback_lyrics='fallback')
    assert result == {'style': 'Synthpop, 128 BPM', 'lyrics': '[Verse]\nHello'}


def test_parse_model_response_without_markers_falls_back_to_raw_text():
    result = suno._parse_model_response('some unstructured reply', fallback_lyrics='fallback')
    assert result == {'style': '', 'lyrics': 'some unstructured reply'}


def test_build_prompt_includes_base_examples_and_skill_prompt():
    settings = {
        'suno_base_prompt': 'BASE RULES',
        'suno_reference_examples': ['EXAMPLE ONE'],
    }
    prompt = suno._build_prompt('[Verse]\nRaw poem', 'SKILL PROMPT', settings)

    assert 'BASE RULES' in prompt
    assert 'EXAMPLE ONE' in prompt
    assert 'SKILL PROMPT' in prompt
    assert '[Verse]\nRaw poem' in prompt
    assert suno._STYLE_MARKER in prompt
    assert suno._LYRICS_MARKER in prompt


def test_build_prompt_places_active_wishes_in_marked_block_right_after_base():
    settings = {'suno_base_prompt': 'BASE RULES', 'suno_reference_examples': ['EXAMPLE ONE']}
    prompt = suno._build_prompt(
        '[Verse]\nRaw poem', 'SKILL PROMPT', settings,
        active_wishes=['Больше саксофона', 'Женский бэк-вокал'],
    )

    assert 'ВАЖНЫЕ ТРЕБОВАНИЯ ПОЛЬЗОВАТЕЛЯ' in prompt
    assert '1. Больше саксофона' in prompt
    assert '2. Женский бэк-вокал' in prompt
    # right after the base prompt, before the reference examples
    assert prompt.index('BASE RULES') < prompt.index('ВАЖНЫЕ ТРЕБОВАНИЯ') < prompt.index('EXAMPLE ONE')


def test_build_prompt_omits_wishes_block_when_none_active():
    settings = {'suno_base_prompt': 'BASE RULES', 'suno_reference_examples': []}
    prompt = suno._build_prompt('[Verse]\nRaw poem', 'SKILL PROMPT', settings, active_wishes=[])

    assert 'ВАЖНЫЕ ТРЕБОВАНИЯ' not in prompt


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

    assert result['style'] == 'Synthpop'
    assert result['lyrics'] == '[Verse]\nAdapted'
    assert result['debug']['stub'] is False
    assert result['debug']['response'] == payload
    assert result['debug']['request']['model'] == 'gemini-2.5-flash'
    assert fake_client.last_call['params'] == {'key': 'test-key'}
    assert 'gemini-2.5-flash' in fake_client.last_call['url']
    assert result['debug']['missing_markers'] is False


def test_generate_flags_missing_markers_when_model_ignores_the_format(monkeypatch):
    payload = {'candidates': [{'content': {'parts': [{'text': 'some unstructured reply'}]}}]}
    fake_client = _FakeAsyncClient(_FakeResponse(200, payload))
    monkeypatch.setattr(suno.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    project = {'blocks': [{'id': 'b1', 'type': 'verse', 'content': 'Raw line'}]}
    settings = {'api_keys': {'google': 'test-key'}}

    import asyncio
    result = asyncio.run(suno.generate(project, model='google:gemini-2.5-flash', settings=settings))

    assert result['style'] == ''
    assert result['debug']['stub'] is False
    assert result['debug']['missing_markers'] is True


def test_generate_calls_openrouter_and_parses_result(monkeypatch):
    payload = {
        'choices': [{'message': {'content': (
            f'{suno._STYLE_MARKER}\nSynthpop\n{suno._LYRICS_MARKER}\n[Verse]\nAdapted'
        )}}],
        'usage': {'prompt_tokens': 400, 'completion_tokens': 90, 'total_tokens': 490, 'cost': 0.002},
    }
    fake_client = _FakeAsyncClient(_FakeResponse(200, payload))
    monkeypatch.setattr(suno.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    project = {'blocks': [{'id': 'b1', 'type': 'verse', 'content': 'Raw line'}]}
    settings = {'api_keys': {'openrouter': 'or-key'}, 'suno_base_prompt': 'BASE', 'suno_reference_examples': []}

    import asyncio
    result = asyncio.run(suno.generate(
        project, skill_prompt='Adapt it', model='openrouter:google/gemini-3.6-flash', settings=settings,
    ))

    assert result['style'] == 'Synthpop'
    assert result['lyrics'] == '[Verse]\nAdapted'
    assert result['debug']['stub'] is False
    assert result['debug']['request']['model'] == 'google/gemini-3.6-flash'
    assert fake_client.last_call['headers'] == {'Authorization': 'Bearer or-key'}
    assert fake_client.last_call['json']['model'] == 'google/gemini-3.6-flash'


def test_generate_calls_deepseek_and_parses_result(monkeypatch):
    payload = {
        'choices': [{'message': {'content': (
            f'{suno._STYLE_MARKER}\nSynthpop\n{suno._LYRICS_MARKER}\n[Verse]\nAdapted'
        )}}],
        'usage': {'prompt_tokens': 300, 'completion_tokens': 60, 'total_tokens': 360},
    }
    fake_client = _FakeAsyncClient(_FakeResponse(200, payload))
    monkeypatch.setattr(suno.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    project = {'blocks': [{'id': 'b1', 'type': 'verse', 'content': 'Raw line'}]}
    settings = {'api_keys': {'deepseek': 'ds-key'}, 'suno_base_prompt': 'BASE', 'suno_reference_examples': []}

    import asyncio
    result = asyncio.run(suno.generate(
        project, skill_prompt='Adapt it', model='deepseek:deepseek-chat', settings=settings,
    ))

    assert result['style'] == 'Synthpop'
    assert result['lyrics'] == '[Verse]\nAdapted'
    assert result['debug']['stub'] is False
    assert fake_client.last_call['headers'] == {'Authorization': 'Bearer ds-key'}
    assert fake_client.last_call['json']['model'] == 'deepseek-chat'


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


def test_generate_via_gemini_includes_usage_summary_with_catalog_cost(monkeypatch):
    payload = {
        'candidates': [{'content': {'parts': [{'text': (
            f'{suno._STYLE_MARKER}\nSynthpop\n{suno._LYRICS_MARKER}\n[Verse]\nAdapted'
        )}]}}],
        'usageMetadata': {'promptTokenCount': 500, 'candidatesTokenCount': 120, 'totalTokenCount': 620},
    }
    fake_client = _FakeAsyncClient(_FakeResponse(200, payload))
    monkeypatch.setattr(suno.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    project = {'blocks': [{'id': 'b1', 'type': 'verse', 'content': 'Raw line'}]}
    settings = {'api_keys': {'google': 'test-key'}}

    import asyncio
    result = asyncio.run(suno.generate(project, model='google:gemini-2.5-flash', settings=settings))

    usage_summary = result['debug']['usage']
    assert usage_summary['input_tokens'] == 500
    assert usage_summary['output_tokens'] == 120
    # No cost field in Gemini's response - priced from BUILTIN_PRICING instead.
    assert usage_summary['cost']['source'] == 'catalog'
    assert usage_summary['cost']['amount'] is not None
    assert usage_summary['duration_ms'] >= 0


def test_generate_via_openrouter_usage_summary_uses_provider_cost(monkeypatch):
    payload = {
        'choices': [{'message': {'content': (
            f'{suno._STYLE_MARKER}\nSynthpop\n{suno._LYRICS_MARKER}\n[Verse]\nAdapted'
        )}}],
        'usage': {'prompt_tokens': 400, 'completion_tokens': 90, 'total_tokens': 490, 'cost': 0.002},
    }
    fake_client = _FakeAsyncClient(_FakeResponse(200, payload))
    monkeypatch.setattr(suno.httpx, 'AsyncClient', lambda **kwargs: fake_client)

    project = {'blocks': [{'id': 'b1', 'type': 'verse', 'content': 'Raw line'}]}
    settings = {'api_keys': {'openrouter': 'or-key'}}

    import asyncio
    result = asyncio.run(suno.generate(project, model='openrouter:google/gemini-3.6-flash', settings=settings))

    # OpenRouter's exact reported cost wins over the catalog estimate.
    assert result['debug']['usage']['cost'] == {'amount': 0.002, 'currency': 'USD', 'source': 'provider'}


def test_generate_raises_clear_timeout_error_and_records_it(monkeypatch, usage_ledger):
    class _TimeoutClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, *args, **kwargs):
            raise suno.httpx.ReadTimeout('timed out')

    monkeypatch.setattr(suno.httpx, 'AsyncClient', lambda **kwargs: _TimeoutClient())

    project = {'blocks': [{'id': 'b1', 'type': 'verse', 'content': 'Raw line'}]}
    settings = {'api_keys': {'google': 'test-key'}}
    ctx = usage_ledger.context('suno_generate', 'my-poem', settings)

    import asyncio
    with pytest.raises(RuntimeError, match='Таймаут'):
        asyncio.run(suno.generate(project, model='google:gemini-2.5-flash', settings=settings, usage_ctx=ctx))

    rec = usage_ledger.query()['records'][0]
    assert rec['status'] == 'error'
    assert 'Таймаут' in rec['error']


def test_stub_fallback_records_nothing_because_no_call_was_made(usage_ledger):
    project = {'blocks': [{'id': 'b1', 'type': 'verse', 'content': 'Line one'}]}
    settings = {'api_keys': {'google': ''}}
    ctx = usage_ledger.context('suno_generate', 'my-poem', settings)

    import asyncio
    asyncio.run(suno.generate(project, model='google:gemini-2.5-flash', settings=settings, usage_ctx=ctx))

    assert usage_ledger.query()['total'] == 0
