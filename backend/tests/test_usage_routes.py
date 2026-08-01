import datetime
import json
import os
from pathlib import Path

import pytest

from app import pricing


def _write_shard(rec: dict, ym: str | None = None):
    """Directly appends a ledger record, bypassing usage.record(), so tests
    can control the timestamp precisely without touching wall-clock time."""
    data_dir = Path(os.environ['APP_DATA_DIR']) / 'usage'
    data_dir.mkdir(parents=True, exist_ok=True)
    ym = ym or rec['ts'][:7]
    path = data_dir / f'{ym}.jsonl'
    with path.open('a', encoding='utf-8') as f:
        f.write(json.dumps(rec) + '\n')


def _base_record(**overrides) -> dict:
    rec = {
        'id': 'u_test', 'ts': '2026-07-15T12:00:00.000Z', 'task': 'suno_generate',
        'project_id': 'poem-a', 'provider': 'google', 'model_id': 'gemini-2.5-flash',
        'model': 'google:gemini-2.5-flash', 'status': 'ok', 'duration_ms': 500,
        'units': {'input_tokens': 1000, 'output_tokens': 500},
        'cost': {'amount': None, 'currency': 'USD', 'source': 'unknown', 'pricing_version': None},
        'prompt_preview': 'once upon a time', 'response_preview': 'style + lyrics',
        'prompt_chars': 17, 'response_chars': 14, 'error': None, 'meta': {'skill_id': 'skill_a'},
    }
    rec.update(overrides)
    return rec


def test_list_records_empty(client):
    resp = client.get('/api/usage/records')
    assert resp.status_code == 200
    body = resp.json()
    assert body == {'records': [], 'total': 0, 'limit': 100, 'offset': 0,
                     'totals': {'calls': 0, 'errors': 0, 'cost': 0, 'currency': 'USD', 'unknown_cost_calls': 0}}


def test_list_records_and_filters(client):
    _write_shard(_base_record())
    _write_shard(_base_record(id='u_test2', project_id='poem-b', task='scene_image',
                               provider='fal', model_id='fal-ai/flux/dev', model='fal:fal-ai/flux/dev',
                               status='error', units={'kind': 'image'}))

    resp = client.get('/api/usage/records')
    assert resp.status_code == 200
    body = resp.json()
    assert body['total'] == 2
    assert body['records'][0]['id'] in {'u_test', 'u_test2'}

    resp = client.get('/api/usage/records', params={'project_id': 'poem-a'})
    assert resp.json()['total'] == 1

    resp = client.get('/api/usage/records', params={'task': 'scene_image'})
    assert resp.json()['total'] == 1

    resp = client.get('/api/usage/records', params={'status': 'error'})
    assert resp.json()['total'] == 1

    resp = client.get('/api/usage/records', params={'provider': 'fal'})
    assert resp.json()['total'] == 1


def test_list_records_pagination(client):
    for i in range(5):
        _write_shard(_base_record(id=f'u_{i}', ts=f'2026-07-15T{10+i:02d}:00:00.000Z'))

    resp = client.get('/api/usage/records', params={'limit': 2, 'offset': 0})
    body = resp.json()
    assert len(body['records']) == 2
    assert body['total'] == 5
    assert body['limit'] == 2
    assert body['offset'] == 0

    resp2 = client.get('/api/usage/records', params={'limit': 2, 'offset': 2})
    assert len(resp2.json()['records']) == 2


def test_summary_group_by_project(client):
    _write_shard(_base_record(units={'input_tokens': 1_000_000, 'output_tokens': 0}))
    _write_shard(_base_record(id='u_2', project_id='poem-b',
                               units={'input_tokens': 1_000_000, 'output_tokens': 0}))

    resp = client.get('/api/usage/summary', params={'group_by': 'project'})
    assert resp.status_code == 200
    groups = {g['key']: g for g in resp.json()['groups']}
    assert groups['poem-a']['calls'] == 1
    assert groups['poem-b']['calls'] == 1


def test_today_endpoint(client):
    now = datetime.datetime.now(datetime.timezone.utc)
    _write_shard(_base_record(id='u_today', ts=now.isoformat().replace('+00:00', 'Z'),
                               units={'input_tokens': 1_000_000, 'output_tokens': 0}))

    resp = client.get('/api/usage/today')
    assert resp.status_code == 200
    body = resp.json()
    assert body['calls'] == 1
    assert body['date'] == now.strftime('%Y-%m-%d')


def test_today_timezone_boundary(client, monkeypatch):
    from app import usage as usage_module
    # Fix "now" well clear of any UTC day boundary so the +180min offset
    # below can't accidentally land on the same real-world day as "now"
    # (which would make the assertions flaky depending on wall-clock time).
    fixed_now = datetime.datetime(2026, 7, 15, 10, 0, 0, tzinfo=datetime.timezone.utc)
    monkeypatch.setattr(usage_module, '_utcnow', lambda: fixed_now)

    late = fixed_now.replace(hour=23, minute=45, second=0, microsecond=0)
    _write_shard(_base_record(id='u_late', ts=late.isoformat().replace('+00:00', 'Z'),
                               units={'input_tokens': 1_000_000, 'output_tokens': 0}))

    resp_utc = client.get('/api/usage/today', params={'tz_offset': 0})
    assert resp_utc.json()['calls'] == 1

    # UTC+3: 23:45Z is already tomorrow locally, so it should drop out of "today".
    resp_plus3 = client.get('/api/usage/today', params={'tz_offset': 180})
    assert resp_plus3.json()['calls'] == 0

    resp_summary = client.get('/api/usage/summary', params={'group_by': 'day', 'tz_offset': 0})
    assert resp_summary.json()['groups'][0]['key'] == late.strftime('%Y-%m-%d')

    resp_summary_plus3 = client.get('/api/usage/summary', params={'group_by': 'day', 'tz_offset': 180})
    tomorrow = (late + datetime.timedelta(minutes=180)).strftime('%Y-%m-%d')
    assert resp_summary_plus3.json()['groups'][0]['key'] == tomorrow


def test_get_pricing_is_empty_with_no_builtins_overrides_or_known_models(client, monkeypatch):
    # With BUILTIN_PRICING cleared, nothing overridden, and no model catalog
    # persisted yet, there is nothing to list - this isolates the "empty
    # catalog" behavior from whatever real prices happen to be builtin.
    monkeypatch.setattr(pricing, 'BUILTIN_PRICING', {})
    resp = client.get('/api/usage/pricing')
    assert resp.status_code == 200
    body = resp.json()
    assert body['models'] == []
    assert body['overrides'] == {}


def test_put_pricing_persists_override(client):
    resp = client.put('/api/usage/pricing', json={
        'pricing_overrides': {'google:gemini-2.5-flash': {'kind': 'text', 'input': 9.0, 'output': 9.0}},
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body['overrides']['google:gemini-2.5-flash']['input'] == 9.0

    resp2 = client.get('/api/usage/pricing')
    override_row = next(m for m in resp2.json()['models'] if m['model'] == 'google:gemini-2.5-flash')
    assert override_row['source'] == 'override'
    assert override_row['input'] == 9.0


def test_put_pricing_rejects_invalid_row(client):
    resp = client.put('/api/usage/pricing', json={
        'pricing_overrides': {'google:x': {'kind': 'text', 'input': 1.0}},  # missing 'output'
    })
    assert resp.status_code == 422


def test_put_pricing_requires_body_field(client):
    resp = client.put('/api/usage/pricing', json={})
    assert resp.status_code == 422


def test_cost_recomputes_from_current_override_on_read(client):
    # 'test:unpriced-model' has no builtin price - the record starts
    # 'unknown', an override afterwards must retroactively price it on the
    # next read, and changing the override again must update it again,
    # without touching the stored record.
    _write_shard(_base_record(
        provider='test', model_id='unpriced-model', model='test:unpriced-model',
        units={'input_tokens': 1_000_000, 'output_tokens': 0},
    ))

    before = client.get('/api/usage/records').json()['records'][0]
    assert before['cost']['amount'] is None
    assert before['cost']['source'] == 'unknown'

    client.put('/api/usage/pricing', json={
        'pricing_overrides': {'test:unpriced-model': {'kind': 'text', 'input': 0.30, 'output': 2.50}},
    })
    first = client.get('/api/usage/records').json()['records'][0]
    assert first['cost']['amount'] == pytest.approx(0.30)
    assert first['cost']['source'] == 'catalog'

    client.put('/api/usage/pricing', json={
        'pricing_overrides': {'test:unpriced-model': {'kind': 'text', 'input': 5.0, 'output': 5.0}},
    })
    after = client.get('/api/usage/records').json()['records'][0]
    assert after['cost']['amount'] == pytest.approx(5.0)
    assert after['cost']['source'] == 'catalog'
