def test_get_suno_prompt_presets_covers_both_services(client):
    from app.providers.suno_prompt_defaults import DEFAULT_SUNO_BASE_PROMPT

    resp = client.get('/api/settings/suno-prompt-presets')
    assert resp.status_code == 200
    presets = resp.json()

    ids = [p['id'] for p in presets]
    assert len(ids) == len(set(ids))

    services = {p['service'] for p in presets}
    assert services == {'Suno', 'Mureka'}

    for preset in presets:
        assert preset['name']
        assert preset['description']
        assert 'STYLE-BLOCK' in preset['prompt']
        assert 'LYRICS-MARKUP' in preset['prompt']

    suno_presets = [p for p in presets if p['service'] == 'Suno']
    assert suno_presets[0]['prompt'] == DEFAULT_SUNO_BASE_PROMPT


def test_get_settings_returns_defaults(client):
    resp = client.get('/api/settings')
    assert resp.status_code == 200
    body = resp.json()
    assert body['api_keys'] == {
        'replicate': '', 'google': '', 'google_free': '', 'fal': '', 'openrouter': '', 'deepseek': '',
        'krea': '', 'google_translate': '',
    }
    assert body['text_models'] == {'favorites': [], 'default': 'google:gemini-2.5-flash'}
    assert body['simple_models'] == {'favorites': [], 'default': ''}
    assert body['image_models'] == {'favorites': [], 'default': ''}
    assert body['suno_wish_library'] == []
    assert body['hide_motion_prompt'] is False


def test_get_settings_normalizes_legacy_string_wishes(client):
    client.put('/api/settings', json={'suno_wish_library': ['добавь больше саксофона']})

    resp = client.get('/api/settings')

    wishes = resp.json()['suno_wish_library']
    assert len(wishes) == 1
    assert wishes[0]['text'] == 'добавь больше саксофона'
    assert wishes[0]['title']
    assert wishes[0]['id']


def test_get_models_curated_provider_needs_no_key(client):
    resp = client.get('/api/settings/models/replicate')
    assert resp.status_code == 200
    body = resp.json()
    assert body['source'] == 'curated'
    assert len(body['models']) > 0


def test_get_models_deepseek_without_key_returns_error_not_404(client):
    resp = client.get('/api/settings/models/deepseek')
    assert resp.status_code == 200
    assert resp.json()['source'] == 'error'


def test_get_models_unknown_provider_returns_404(client):
    resp = client.get('/api/settings/models/anthropic')
    assert resp.status_code == 404


def test_get_models_google_without_key_returns_error_not_500(client):
    resp = client.get('/api/settings/models/google')
    assert resp.status_code == 200
    assert resp.json()['source'] == 'error'


def test_get_image_models_curated_provider_needs_no_key(client):
    resp = client.get('/api/settings/image-models/fal')
    assert resp.status_code == 200
    body = resp.json()
    assert body['source'] == 'curated'
    assert len(body['models']) > 0


def test_get_image_models_unknown_provider_returns_404(client):
    resp = client.get('/api/settings/image-models/anthropic')
    assert resp.status_code == 404


def test_get_image_models_google_without_key_returns_error_not_500(client):
    resp = client.get('/api/settings/image-models/google')
    assert resp.status_code == 200
    assert resp.json()['source'] == 'error'


def test_get_image_models_krea_returns_curated(client):
    resp = client.get('/api/settings/image-models/krea')
    assert resp.status_code == 200
    body = resp.json()
    assert body['source'] == 'curated'
    assert len(body['models']) > 0


def test_get_models_krea_is_not_a_text_provider(client):
    """Krea is image/video-only - it must not be selectable for text models."""
    resp = client.get('/api/settings/models/krea')
    assert resp.status_code == 404


def test_models_catalog_is_empty_before_any_refresh(client):
    resp = client.get('/api/settings/models-catalog')
    assert resp.status_code == 200
    assert resp.json() == {'text': {}, 'image': {}}


def test_get_models_persists_into_catalog(client):
    client.get('/api/settings/models/replicate')

    catalog = client.get('/api/settings/models-catalog').json()
    assert catalog['text']['replicate']['source'] == 'curated'
    assert len(catalog['text']['replicate']['models']) > 0
    assert catalog['image'] == {}


def test_get_image_models_persists_into_catalog(client):
    client.get('/api/settings/image-models/fal')

    catalog = client.get('/api/settings/models-catalog').json()
    assert catalog['image']['fal']['source'] == 'curated'
    assert catalog['text'] == {}


def test_failed_model_fetch_does_not_overwrite_a_good_catalog_entry(client):
    client.get('/api/settings/models/replicate')
    good = client.get('/api/settings/models-catalog').json()['text']['replicate']

    # deepseek has no key configured -> source == 'error', must not wipe replicate's entry
    client.get('/api/settings/models/deepseek')

    catalog = client.get('/api/settings/models-catalog').json()
    assert catalog['text']['replicate'] == good
    assert 'deepseek' not in catalog['text']


def test_add_wish_generates_title_and_persists(client):
    resp = client.post('/api/settings/wish-library', json={'text': 'добавь больше саксофона'})
    assert resp.status_code == 200
    body = resp.json()
    assert body['wish']['text'] == 'добавь больше саксофона'
    assert body['wish']['title']
    assert body['wish']['id']
    assert body['suno_wish_library'] == [body['wish']]

    saved = client.get('/api/settings').json()['suno_wish_library']
    assert saved == [body['wish']]


def test_add_wish_model_override_is_used_but_not_persisted(client, monkeypatch):
    """A per-save `model` picked in the UI should only affect that title,
    not silently become the new settings.simple_models.default."""
    from app.providers import text_models

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {'candidates': [{'content': {'parts': [{
                'text': '===WISH===\nсделай медленнее\n===TITLE===\nЗаголовок из override',
            }]}}]}

    class _FakeAsyncClient:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            return False
        async def post(self, url, params=None, json=None):
            return _FakeResponse()

    monkeypatch.setattr(text_models.httpx, 'AsyncClient', lambda **kwargs: _FakeAsyncClient())

    client.put('/api/settings', json={
        'api_keys': {'google': 'test-key'},
        'simple_models': {'favorites': [], 'default': ''},
    })

    resp = client.post('/api/settings/wish-library', json={
        'text': 'сделай медленнее', 'model': 'google:gemini-2.0-flash-lite',
    })
    assert resp.status_code == 200
    assert resp.json()['wish']['title'] == 'Заголовок из override'

    assert client.get('/api/settings').json()['simple_models']['default'] == ''


def test_add_wish_rejects_blank_text(client):
    resp = client.post('/api/settings/wish-library', json={'text': '  '})
    assert resp.status_code == 422


def test_add_wish_deduplicates_identical_text(client):
    first = client.post('/api/settings/wish-library', json={'text': 'добавь драйва'}).json()
    second = client.post('/api/settings/wish-library', json={'text': 'добавь драйва'}).json()

    assert first['wish']['id'] == second['wish']['id']
    assert len(second['suno_wish_library']) == 1


def test_update_wish_edits_title_and_text(client):
    wish = client.post('/api/settings/wish-library', json={'text': 'добавь больше саксофона'}).json()['wish']

    resp = client.patch(f'/api/settings/wish-library/{wish["id"]}', json={'title': 'Саксофон', 'text': 'ещё больше саксофона'})
    assert resp.status_code == 200
    body = resp.json()
    assert body['wish']['id'] == wish['id']
    assert body['wish']['title'] == 'Саксофон'
    assert body['wish']['text'] == 'ещё больше саксофона'

    saved = client.get('/api/settings').json()['suno_wish_library']
    assert saved == [body['wish']]


def test_update_wish_partial_body_only_changes_given_field(client):
    wish = client.post('/api/settings/wish-library', json={'text': 'добавь больше саксофона'}).json()['wish']

    resp = client.patch(f'/api/settings/wish-library/{wish["id"]}', json={'title': 'Новый заголовок'})
    assert resp.status_code == 200
    body = resp.json()['wish']
    assert body['title'] == 'Новый заголовок'
    assert body['text'] == 'добавь больше саксофона'


def test_update_wish_rejects_blank_text(client):
    wish = client.post('/api/settings/wish-library', json={'text': 'добавь больше саксофона'}).json()['wish']

    resp = client.patch(f'/api/settings/wish-library/{wish["id"]}', json={'text': '  '})
    assert resp.status_code == 422


def test_update_wish_unknown_id_returns_404(client):
    resp = client.patch('/api/settings/wish-library/does-not-exist', json={'title': 'x'})
    assert resp.status_code == 404
