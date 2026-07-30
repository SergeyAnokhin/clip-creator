def test_get_settings_returns_defaults(client):
    resp = client.get('/api/settings')
    assert resp.status_code == 200
    body = resp.json()
    assert body['api_keys'] == {'replicate': '', 'google': '', 'fal': '', 'openrouter': '', 'krea': ''}
    assert body['text_models'] == {'favorites': [], 'default': 'google:gemini-2.5-flash'}
    assert body['simple_models'] == {'favorites': [], 'default': ''}
    assert body['image_models'] == {'favorites': [], 'default': ''}
    assert body['suno_wish_library'] == []


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
            return {'candidates': [{'content': {'parts': [{'text': 'Заголовок из override'}]}}]}

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
