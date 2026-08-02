from unittest.mock import AsyncMock

from app.routers import projects as projects_router


def test_create_list_patch_delete_roundtrip(client, monkeypatch):
    monkeypatch.setattr(projects_router.url_parser, 'parse', AsyncMock(return_value=None))
    created = client.post('/api/projects', json={'url': 'https://example.com/poem'}).json()
    pid = created['id']
    assert created['source_url'] == 'https://example.com/poem'

    listing = client.get('/api/projects').json()
    assert any(p['id'] == pid for p in listing)

    patched = client.patch(f'/api/projects/{pid}', json={'title': 'Renamed'}).json()
    assert patched['title'] == 'Renamed'
    assert client.get(f'/api/projects/{pid}').json()['title'] == 'Renamed'

    assert client.delete(f'/api/projects/{pid}').status_code == 204
    assert client.get(f'/api/projects/{pid}').status_code == 404


def test_get_missing_project_returns_404(client):
    assert client.get('/api/projects/does-not-exist').status_code == 404


def test_legacy_project_without_active_wish_ids_is_reset_once_on_load(client):
    """Projects created before the AI-wish library rework have no
    `active_wish_ids` key and may carry `skill_prompt` text folded in by the
    old suno.refine() flow - both get reset to defaults the first time such
    a project loads (see projects.migrate_legacy_project)."""
    import json
    import os
    from pathlib import Path

    pid = client.get('/api/projects').json()[0]['id']
    config_path = Path(os.environ['APP_DATA_DIR']) / 'projects' / pid / 'config.json'
    legacy = json.loads(config_path.read_text(encoding='utf-8'))
    del legacy['active_wish_ids']
    legacy['skill_prompt'] = 'Custom prompt. Additionally, old folded wish.'
    legacy['refinement_comments'] = ['old folded wish']
    config_path.write_text(json.dumps(legacy), encoding='utf-8')

    fetched = client.get(f'/api/projects/{pid}').json()

    assert fetched['active_wish_ids'] == []
    assert fetched['refinement_comments'] == []
    assert fetched['skill_prompt'] == projects_router.DEFAULT_SKILL_PROMPT

    persisted = json.loads(config_path.read_text(encoding='utf-8'))
    assert persisted['active_wish_ids'] == []
    assert persisted['skill_prompt'] == projects_router.DEFAULT_SKILL_PROMPT


def test_patch_missing_project_returns_404(client):
    assert client.patch('/api/projects/does-not-exist', json={'title': 'x'}).status_code == 404


def test_seeded_demo_projects_are_present(client):
    listing = client.get('/api/projects').json()
    authors = {p['author'] for p in listing}
    assert 'Александр Пушкин' in authors


def test_create_with_raw_text_splits_blocks_on_blank_lines(client):
    raw_text = 'Строка один\nСтрока два\n\nВторой блок\n\n\nТретий блок'
    created = client.post('/api/projects', json={'raw_text': raw_text}).json()
    contents = [b['content'] for b in created['blocks']]
    assert contents == ['Строка один\nСтрока два', 'Второй блок', 'Третий блок']
    assert all(b['type'] == 'verse' for b in created['blocks'])


def test_create_without_raw_text_falls_back_to_placeholder_block(client, monkeypatch):
    monkeypatch.setattr(projects_router.url_parser, 'parse', AsyncMock(return_value=None))
    created = client.post('/api/projects', json={'url': 'https://example.com/poem'}).json()
    assert len(created['blocks']) == 1
    assert created['blocks'][0]['type'] == 'intro'


def test_create_with_url_uses_parsed_author_title_and_text(client, monkeypatch):
    monkeypatch.setattr(
        projects_router.url_parser, 'parse',
        AsyncMock(return_value={
            'author': 'Александр Пушкин',
            'title': 'Зимнее утро',
            'raw_text': 'Мороз и солнце; день чудесный!\n\nЕщё ты дремлешь, друг прелестный.',
        }),
    )
    created = client.post('/api/projects', json={'url': 'https://example.com/poem'}).json()
    assert created['author'] == 'Александр Пушкин'
    assert created['title'] == 'Зимнее утро'
    assert [b['content'] for b in created['blocks']] == [
        'Мороз и солнце; день чудесный!',
        'Ещё ты дремлешь, друг прелестный.',
    ]


def test_create_prefers_raw_text_over_url_parsing(client, monkeypatch):
    parse_mock = AsyncMock()
    monkeypatch.setattr(projects_router.url_parser, 'parse', parse_mock)
    created = client.post('/api/projects', json={'url': 'https://example.com/poem', 'raw_text': 'Явный текст'}).json()
    parse_mock.assert_not_called()
    assert created['blocks'][0]['content'] == 'Явный текст'
