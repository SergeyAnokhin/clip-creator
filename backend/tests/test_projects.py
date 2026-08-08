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


# ---------- Rename-on-patch (folder + id follow title/author) ----------

def test_patch_renames_project_folder_and_id_when_title_or_author_changes(client):
    from app import storage

    created = client.post('/api/projects', json={'url': '', 'raw_text': 'Строка первая\n\nСтрока вторая'}).json()
    old_id = created['id']

    patched = client.patch(f'/api/projects/{old_id}', json={'author': 'Пушкин', 'title': 'Зимнее утро'}).json()
    new_id = patched['id']

    assert new_id != old_id
    assert new_id == 'Пушкин - Зимнее утро'
    # Old id must still resolve (redirect) - a client that hasn't picked up
    # the new id yet (e.g. a stale in-flight request) must not 404.
    assert client.get(f'/api/projects/{old_id}').json()['id'] == new_id
    assert client.get(f'/api/projects/{new_id}').json()['title'] == 'Зимнее утро'
    # The physical folder was actually moved, not duplicated.
    assert not (storage.projects_dir() / old_id).is_dir()
    assert (storage.projects_dir() / new_id).is_dir()


def test_patch_rename_uniquifies_on_slug_collision(client):
    from app import storage

    storage.save_project('Пушкин - Зимнее утро', {'id': 'Пушкин - Зимнее утро', 'author': 'Пушкин', 'title': 'Зимнее утро'})

    created = client.post('/api/projects', json={'url': '', 'raw_text': 'Текст'}).json()
    old_id = created['id']

    patched = client.patch(f'/api/projects/{old_id}', json={'author': 'Пушкин', 'title': 'Зимнее утро'}).json()

    assert patched['id'] == 'Пушкин - Зимнее утро-2'


def test_late_background_write_under_old_slug_lands_in_renamed_folder(client):
    """Simulates a Mureka generation job that captured the *old* slug before
    a rename finished, then saves its result 30-90s later - the redirect in
    storage.py must make that write land in the renamed folder instead of
    recreating an orphaned old one (see storage.resolve_slug)."""
    from app import storage

    created = client.post('/api/projects', json={'url': '', 'raw_text': 'Текст'}).json()
    old_id = created['id']

    client.patch(f'/api/projects/{old_id}', json={'author': 'Иван', 'title': 'Новое название'})

    late_project = storage.load_project(old_id)
    late_project['mureka'] = {'tracks': [{'track_id': 'trk_late'}]}
    storage.save_project(old_id, late_project)

    reloaded = storage.load_project('Иван - Новое название')
    assert reloaded['mureka']['tracks'][0]['track_id'] == 'trk_late'
    assert not (storage.projects_dir() / old_id).is_dir()


def test_redirect_does_not_hijack_an_unrelated_project_at_the_same_old_slug(client):
    """Confirmed live, 2026-08: a still-default "Неизвестный автор - Новое
    стихотворение" project got silently redirected into a *different*,
    already-renamed project's folder, because that exact string happened to
    be the other project's pre-rename address. Slugs aren't permanently
    unique identifiers - a real, currently-existing project's own address
    must always win over a stale redirect entry that happens to match it."""
    import json
    from app import storage

    # Project A: created, then renamed - leaves behind a redirect entry
    # keyed by its old (now vacated) slug.
    a_old = 'Автор А - Название А'
    storage.save_project(a_old, {'id': a_old, 'author': 'Автор А', 'title': 'Название А'})
    a_new_id = client.patch(f'/api/projects/{a_old}', json={'author': 'Автор А2', 'title': 'Название А'}).json()['id']
    assert a_new_id != a_old
    assert storage.load_redirects().get(a_old) == a_new_id

    # Project B: a wholly unrelated project that now genuinely lives at that
    # exact vacated slug - written directly to disk, since going through
    # storage.save_project here would itself resolve through the redirect
    # above and clobber A's data instead of setting up this scenario (that's
    # a separate, correct behavior - see the create-time uniqueness tests).
    b_dir = storage.projects_dir() / a_old
    b_dir.mkdir(parents=True, exist_ok=True)
    (b_dir / 'config.json').write_text(
        json.dumps({'id': a_old, 'author': 'Автор Б (не А)', 'title': 'Совсем другой проект'}, ensure_ascii=False),
        encoding='utf-8',
    )

    fetched = client.get(f'/api/projects/{a_old}').json()
    assert fetched['author'] == 'Автор Б (не А)'
    assert fetched['title'] == 'Совсем другой проект'

    patched = client.patch(f'/api/projects/{a_old}', json={'style': 'edit B'}).json()
    assert patched['id'] == a_old
    assert patched['author'] == 'Автор Б (не А)'

    # Project A's own data must be completely untouched by any of this.
    a_reloaded = storage.load_project(a_new_id)
    assert a_reloaded['author'] == 'Автор А2'


def test_patch_without_title_or_author_change_does_not_rename(client):
    created = client.post('/api/projects', json={'url': '', 'raw_text': 'Текст'}).json()
    old_id = created['id']

    patched = client.patch(f'/api/projects/{old_id}', json={'style': 'some style'}).json()

    assert patched['id'] == old_id
