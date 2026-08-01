import asyncio
import json

import pytest


@pytest.fixture
def usage(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_DATA_DIR', str(tmp_path))
    from app import usage as usage_module
    return usage_module


def test_record_writes_one_jsonl_line(usage):
    ctx = usage.context('suno_generate', 'my-poem', {})
    usage.record(ctx, model='google:gemini-2.5-flash', kind='text', status='ok', duration_ms=120,
                 units={'input_tokens': 100, 'output_tokens': 50}, prompt='hello', response='world')

    # google:gemini-2.5-flash has a real builtin price (see pricing.py), so
    # this also checks the record's cost gets computed, not just stored.
    result = usage.query()
    assert result['total'] == 1
    rec = result['records'][0]
    assert rec['task'] == 'suno_generate'
    assert rec['project_id'] == 'my-poem'
    assert rec['provider'] == 'google'
    assert rec['model_id'] == 'gemini-2.5-flash'
    assert rec['model'] == 'google:gemini-2.5-flash'
    assert rec['status'] == 'ok'
    assert rec['prompt_preview'] == 'hello'
    assert rec['response_preview'] == 'world'
    assert rec['prompt_chars'] == 5
    assert rec['cost']['source'] == 'catalog'
    assert rec['cost']['amount'] is not None


def test_shard_filename_is_year_month(usage, tmp_path):
    ctx = usage.context('wish_title', None, {})
    usage.record(ctx, model='deepseek:deepseek-chat', kind='text', status='ok', duration_ms=1,
                 units={'input_tokens': 1, 'output_tokens': 1})
    files = list((tmp_path / 'usage').glob('*.jsonl'))
    assert len(files) == 1
    import re
    assert re.fullmatch(r'\d{4}-\d{2}\.jsonl', files[0].name)


def test_two_records_same_month_share_one_file_two_lines(usage, tmp_path):
    ctx = usage.context('wish_title', None, {})
    usage.record(ctx, model='deepseek:deepseek-chat', kind='text', status='ok', duration_ms=1,
                 units={'input_tokens': 1, 'output_tokens': 1})
    usage.record(ctx, model='deepseek:deepseek-chat', kind='text', status='ok', duration_ms=1,
                 units={'input_tokens': 1, 'output_tokens': 1})
    files = list((tmp_path / 'usage').glob('*.jsonl'))
    assert len(files) == 1
    lines = files[0].read_text(encoding='utf-8').splitlines()
    assert len(lines) == 2
    for line in lines:
        json.loads(line)  # each line parses independently


def test_ctx_none_records_nothing(usage):
    usage.record(None, model='google:gemini-2.5-flash', kind='text', status='ok', duration_ms=1)
    assert usage.query()['total'] == 0


def test_out_of_range_shards_are_skipped_even_if_corrupt(usage, tmp_path):
    usage_dir = tmp_path / 'usage'
    usage_dir.mkdir(parents=True, exist_ok=True)
    (usage_dir / '2020-01.jsonl').write_text('{not valid json\n', encoding='utf-8')

    ctx = usage.context('wish_title', None, {})
    usage.record(ctx, model='deepseek:deepseek-chat', kind='text', status='ok', duration_ms=1,
                 units={'input_tokens': 1, 'output_tokens': 1})

    result = usage.query(date_from='2026-07-01', date_to='2026-07-31')
    assert result['total'] >= 0  # must not raise


def test_malformed_line_in_range_is_skipped(usage, tmp_path):
    import datetime
    ym = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m')
    usage_dir = tmp_path / 'usage'
    usage_dir.mkdir(parents=True, exist_ok=True)
    good = json.dumps({
        'id': 'u_good', 'ts': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z'),
        'task': 'wish_title', 'project_id': None, 'provider': 'deepseek', 'model_id': 'deepseek-chat',
        'model': 'deepseek:deepseek-chat', 'status': 'ok', 'duration_ms': 1,
        'units': {'input_tokens': 1, 'output_tokens': 1}, 'cost': {'amount': None, 'source': 'unknown'},
        'prompt_preview': '', 'response_preview': '', 'prompt_chars': 0, 'response_chars': 0,
        'error': None, 'meta': {},
    })
    (usage_dir / f'{ym}.jsonl').write_text(good + '\ngarbage-line-not-json\n', encoding='utf-8')

    result = usage.query()
    assert result['total'] == 1
    assert result['records'][0]['id'] == 'u_good'


def test_filter_by_project_task_provider_model_status(usage):
    ctx_a = usage.context('suno_generate', 'poem-a', {})
    ctx_b = usage.context('scene_image', 'poem-b', {})
    usage.record(ctx_a, model='google:gemini-2.5-flash', kind='text', status='ok', duration_ms=1,
                 units={'input_tokens': 1, 'output_tokens': 1})
    usage.record(ctx_b, model='fal:fal-ai/flux/dev', kind='image', status='error', duration_ms=1,
                 error='boom')

    assert usage.query(project_id='poem-a')['total'] == 1
    assert usage.query(project_id='poem-b')['total'] == 1
    assert usage.query(task='scene_image')['total'] == 1
    assert usage.query(provider='fal')['total'] == 1
    assert usage.query(model='google:gemini-2.5-flash')['total'] == 1
    assert usage.query(status='error')['total'] == 1
    assert usage.query(status='ok')['total'] == 1
    assert usage.query(project_id='nonexistent')['total'] == 0


def test_date_from_and_to_are_inclusive(usage, tmp_path):
    import datetime
    usage_dir = tmp_path / 'usage'
    usage_dir.mkdir(parents=True, exist_ok=True)

    def make(date_str):
        return json.dumps({
            'id': f'u_{date_str}', 'ts': f'{date_str}T12:00:00.000Z', 'task': 'wish_title',
            'project_id': None, 'provider': 'deepseek', 'model_id': 'deepseek-chat',
            'model': 'deepseek:deepseek-chat', 'status': 'ok', 'duration_ms': 1,
            'units': {'input_tokens': 1, 'output_tokens': 1}, 'cost': {'amount': None, 'source': 'unknown'},
            'prompt_preview': '', 'response_preview': '', 'prompt_chars': 0, 'response_chars': 0,
            'error': None, 'meta': {},
        })

    (usage_dir / '2026-07.jsonl').write_text(
        '\n'.join([make('2026-07-10'), make('2026-07-15'), make('2026-07-20')]) + '\n', encoding='utf-8',
    )

    result = usage.query(date_from='2026-07-10', date_to='2026-07-15')
    assert result['total'] == 2
    ids = {r['id'] for r in result['records']}
    assert ids == {'u_2026-07-10', 'u_2026-07-15'}


def test_summarize_groups_by_project_task_model_provider(usage):
    ctx_a = usage.context('suno_generate', 'poem-a', {})
    ctx_b = usage.context('scene_image', 'poem-b', {})
    usage.record(ctx_a, model='google:gemini-2.5-flash', kind='text', status='ok', duration_ms=100,
                 units={'input_tokens': 1000, 'output_tokens': 1000})
    usage.record(ctx_a, model='google:gemini-2.5-flash', kind='text', status='ok', duration_ms=200,
                 units={'input_tokens': 1000, 'output_tokens': 1000})
    usage.record(ctx_b, model='fal:fal-ai/flux/dev', kind='image', status='ok', duration_ms=300,
                 units={'images': 1})

    by_project = usage.summarize(group_by='project')
    keys = {g['key']: g for g in by_project['groups']}
    assert keys['poem-a']['calls'] == 2
    assert keys['poem-b']['calls'] == 1

    by_task = usage.summarize(group_by='task')
    assert {g['key'] for g in by_task['groups']} == {'suno_generate', 'scene_image'}

    by_model = usage.summarize(group_by='model')
    assert {g['key'] for g in by_model['groups']} == {'google:gemini-2.5-flash', 'fal:fal-ai/flux/dev'}

    by_provider = usage.summarize(group_by='provider')
    assert {g['key'] for g in by_provider['groups']} == {'google', 'fal'}


def test_unknown_cost_calls_do_not_contribute_to_sum(usage):
    ctx = usage.context('wish_title', None, {})
    usage.record(ctx, model='totally:unknown-model', kind='text', status='ok', duration_ms=1,
                 units={'input_tokens': 1000, 'output_tokens': 1000})
    usage.record(ctx, model='google:gemini-2.5-flash', kind='text', status='ok', duration_ms=1,
                 units={'input_tokens': 1_000_000, 'output_tokens': 0})

    # google:gemini-2.5-flash has a real builtin price (see pricing.py), so
    # only the truly unpriced model counts as unknown.
    totals = usage.query()['totals']
    assert totals['unknown_cost_calls'] == 1
    assert totals['cost'] == pytest.approx(0.30)


def test_recompute_on_read_reflects_new_override(usage):
    ctx = usage.context('wish_title', None, {})
    usage.record(ctx, model='google:gemini-2.5-flash', kind='text', status='ok', duration_ms=1,
                 units={'input_tokens': 1_000_000, 'output_tokens': 0})

    # google:gemini-2.5-flash has a real builtin price of 0.30/2.50 (see pricing.py).
    stock = usage.query()['records'][0]
    assert stock['cost']['amount'] == pytest.approx(0.30)

    overridden = usage.query(overrides={'google:gemini-2.5-flash': {'kind': 'text', 'input': 5.0, 'output': 1.0}})
    assert overridden['records'][0]['cost']['amount'] == pytest.approx(5.0)


def test_provider_reported_cost_is_never_recomputed(usage):
    ctx = usage.context('wish_title', None, {})
    usage.record(ctx, model='openrouter:openai/gpt-4o-mini', kind='text', status='ok', duration_ms=1,
                 units={'input_tokens': 1000, 'output_tokens': 1000}, provider_cost=0.00042)

    rec = usage.query()['records'][0]
    assert rec['cost']['source'] == 'provider'
    assert rec['cost']['amount'] == pytest.approx(0.00042)

    # Even with an override present, the provider-reported amount wins.
    overridden = usage.query(overrides={'openrouter:openai/gpt-4o-mini': {'kind': 'text', 'input': 99, 'output': 99}})
    assert overridden['records'][0]['cost']['amount'] == pytest.approx(0.00042)
    assert overridden['records'][0]['cost']['source'] == 'provider'


def test_record_never_raises_when_write_fails(usage, monkeypatch):
    def boom(*args, **kwargs):
        raise OSError('disk full')
    monkeypatch.setattr(usage, '_shard_path', boom)

    ctx = usage.context('wish_title', None, {})
    # Must not raise.
    usage.record(ctx, model='google:gemini-2.5-flash', kind='text', status='ok', duration_ms=1)
    assert usage.query()['total'] == 0


def test_concurrent_appends_all_land(usage):
    ctx = usage.context('scene_image', 'poem-x', {})

    async def one(i):
        usage.record(ctx, model='fal:fal-ai/flux/dev', kind='image', status='ok', duration_ms=i,
                     units={'images': 1}, prompt=f'prompt {i}')

    async def run_all():
        await asyncio.gather(*[one(i) for i in range(20)])

    asyncio.run(run_all())

    result = usage.query(limit=50)
    assert result['total'] == 20
    prompts = {r['prompt_preview'] for r in result['records']}
    assert len(prompts) == 20  # every write landed intact, none clobbered


def test_today_total_respects_timezone_offset(usage, tmp_path, monkeypatch):
    # Fix "now" to a deterministic instant well clear of any UTC day boundary
    # (the record's 22:30Z timestamp and a +180min offset would otherwise
    # straddle midnight depending on real wall-clock time at test run).
    import datetime
    fixed_now = datetime.datetime(2026, 7, 15, 10, 0, 0, tzinfo=datetime.timezone.utc)
    monkeypatch.setattr(usage, '_utcnow', lambda: fixed_now)

    usage_dir = tmp_path / 'usage'
    usage_dir.mkdir(parents=True, exist_ok=True)
    late_utc = fixed_now.replace(hour=22, minute=30, second=0, microsecond=0)
    ym = late_utc.strftime('%Y-%m')
    rec = {
        'id': 'u_late', 'ts': late_utc.isoformat().replace('+00:00', 'Z'), 'task': 'wish_title',
        'project_id': None, 'provider': 'deepseek', 'model_id': 'deepseek-chat',
        'model': 'deepseek:deepseek-chat', 'status': 'ok', 'duration_ms': 1,
        'units': {'input_tokens': 1_000_000, 'output_tokens': 0}, 'cost': {'amount': 0.27, 'source': 'catalog'},
        'prompt_preview': '', 'response_preview': '', 'prompt_chars': 0, 'response_chars': 0,
        'error': None, 'meta': {},
    }
    (usage_dir / f'{ym}.jsonl').write_text(json.dumps(rec) + '\n', encoding='utf-8')

    utc_today = usage.today_total(tz_offset=0)
    assert utc_today['calls'] == 1
    assert utc_today['date'] == late_utc.strftime('%Y-%m-%d')

    plus3_today = usage.today_total(tz_offset=180)  # UTC+3, "now" fixed at 10:00Z: 22:30Z is tomorrow locally
    assert plus3_today['calls'] == 0
    assert plus3_today['date'] == (fixed_now + datetime.timedelta(minutes=180)).strftime('%Y-%m-%d')


def test_summarize_by_day_uses_timezone_offset(usage, tmp_path):
    usage_dir = tmp_path / 'usage'
    usage_dir.mkdir(parents=True, exist_ok=True)
    rec = {
        'id': 'u_late2', 'ts': '2026-07-15T22:30:00.000Z', 'task': 'wish_title',
        'project_id': None, 'provider': 'deepseek', 'model_id': 'deepseek-chat',
        'model': 'deepseek:deepseek-chat', 'status': 'ok', 'duration_ms': 1,
        'units': {'input_tokens': 1, 'output_tokens': 1}, 'cost': {'amount': None, 'source': 'unknown'},
        'prompt_preview': '', 'response_preview': '', 'prompt_chars': 0, 'response_chars': 0,
        'error': None, 'meta': {},
    }
    (usage_dir / '2026-07.jsonl').write_text(json.dumps(rec) + '\n', encoding='utf-8')

    utc_summary = usage.summarize(group_by='day', tz_offset=0)
    assert utc_summary['groups'][0]['key'] == '2026-07-15'

    plus3_summary = usage.summarize(group_by='day', tz_offset=180)
    assert plus3_summary['groups'][0]['key'] == '2026-07-16'
