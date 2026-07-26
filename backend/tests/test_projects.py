def test_create_list_patch_delete_roundtrip(client):
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


def test_create_without_raw_text_falls_back_to_placeholder_block(client):
    created = client.post('/api/projects', json={'url': 'https://example.com/poem'}).json()
    assert len(created['blocks']) == 1
    assert created['blocks'][0]['type'] == 'intro'
