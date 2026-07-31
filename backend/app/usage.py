"""Append-only ledger of every paid AI call (text generation, image
generation) made by the app, plus read-side query/summary helpers.

Storage: one JSONL file per calendar month at `app_data/usage/YYYY-MM.jsonl`
(see `storage.usage_dir()`), one JSON object per line, timestamps in UTC.
JSONL instead of a single JSON file because `providers/images.py` runs
several generations concurrently as background asyncio tasks - dictionary
read-modify-write (as `storage.save_project` does) would lose writes under
that concurrency, while appending one line per call does not: on a single
event loop, `record()` contains no `await` between opening and closing the
file, so two concurrent calls can never interleave their writes.

Cost policy: `cost.amount` is `None`, never `0`, whenever the price or the
usage units needed to compute it are missing - a call with unknown cost is
not free, and a 0 would silently understate spend. Records whose cost came
from `pricing.BUILTIN_PRICING` (`cost.source == 'catalog'`) are recomputed
against the *current* catalog every time they're read (see `_resolved_cost`),
so correcting a placeholder price in `pricing.py` retroactively fixes
history. Records priced directly by the provider (`cost.source == 'provider'`,
e.g. OpenRouter's `usage.cost`) are never recomputed - that number was exact
when it arrived.

`record()` never raises: a ledger failure must not break a generation that
otherwise succeeded (same philosophy as `text_models.generate_wish_title`'s
blanket except-fallback).
"""

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from . import pricing, storage

TASKS = ('suno_generate', 'wish_title', 'scene_storyboard', 'scene_image')
GROUP_KEYS = ('project', 'task', 'model', 'provider', 'day')
PREVIEW_LIMIT = 300


def _utcnow() -> datetime:
    """Thin wrapper so tests can monkeypatch "now" deterministically instead
    of depending on wall-clock time (today_total's day-boundary math is
    otherwise flaky within ~a few minutes of UTC midnight)."""
    return datetime.now(timezone.utc)


def _preview(text: str) -> str:
    text = (text or '').strip()
    if len(text) <= PREVIEW_LIMIT:
        return text
    return text[:PREVIEW_LIMIT].rstrip() + '…'


def context(task: str, project_id: str | None = None, settings: dict | None = None, **meta) -> dict:
    """Built once per request/route and threaded down to the provider call as
    `usage_ctx`. `meta` becomes the record's `meta` dict (e.g. `skill_id`,
    `scene_index`) - keys with a None value are dropped so callers can pass
    optional fields unconditionally."""
    settings = settings or {}
    return {
        'task': task,
        'project_id': project_id,
        'pricing_overrides': settings.get('pricing_overrides') or {},
        'meta': {k: v for k, v in meta.items() if v is not None},
    }


def record(ctx: dict | None, *, model: str, kind: str, status: str, duration_ms: int,
           units: dict | None = None, prompt: str = '', response: str = '',
           provider_cost: float | None = None, error: str | None = None,
           meta: dict | None = None) -> None:
    """Appends one call to the ledger. `ctx=None` means "don't record" (used
    by no-network fallback paths, e.g. suno.generate()'s stub branch, which
    cost nothing and never happened as far as billing is concerned).

    `provider_cost`, when given (e.g. OpenRouter's `usage.cost`), always wins
    over the catalog - a provider-reported price is a fact, a catalog price
    is an estimate.
    """
    if not ctx:
        return
    try:
        _write(ctx, model=model, kind=kind, status=status, duration_ms=duration_ms,
               units=units, prompt=prompt, response=response, provider_cost=provider_cost,
               error=error, meta=meta)
    except Exception:
        pass


def _write(ctx: dict, *, model: str, kind: str, status: str, duration_ms: int,
           units: dict | None, prompt: str, response: str,
           provider_cost: float | None, error: str | None, meta: dict | None) -> None:
    provider, _, model_id = (model or '').partition(':')
    units = dict(units or {})
    units.setdefault('kind', kind)

    if provider_cost is not None:
        amount, source = float(provider_cost), 'provider'
    else:
        amount, source = pricing.compute_cost(model, units, ctx.get('pricing_overrides'))

    now = _utcnow()
    rec = {
        'id': f'u_{uuid4().hex[:12]}',
        'ts': now.isoformat().replace('+00:00', 'Z'),
        'task': ctx.get('task'),
        'project_id': ctx.get('project_id'),
        'provider': provider,
        'model_id': model_id,
        'model': model,
        'status': status,
        'duration_ms': int(duration_ms or 0),
        'units': units,
        'cost': {
            'amount': amount,
            'currency': pricing.CURRENCY,
            'source': source,
            'pricing_version': pricing.PRICING_VERSION if source == 'catalog' else None,
        },
        'prompt_preview': _preview(prompt),
        'response_preview': _preview(response),
        'prompt_chars': len(prompt or ''),
        'response_chars': len(response or ''),
        'error': str(error)[:PREVIEW_LIMIT] if error else None,
        'meta': {**ctx.get('meta', {}), **(meta or {})},
    }

    path = _shard_path(now.strftime('%Y-%m'))
    # Single write() call with no `await` in between open/close: on a single
    # asyncio event loop this makes each record's append atomic with respect
    # to other concurrently-running provider calls (see module docstring).
    with path.open('a', encoding='utf-8', newline='\n') as f:
        f.write(json.dumps(rec, ensure_ascii=False) + '\n')


def _shard_path(year_month: str) -> Path:
    return storage.usage_dir() / f'{year_month}.jsonl'


def _shards_in_range(date_from: str | None, date_to: str | None) -> list[Path]:
    d = storage.usage_dir()
    if not d.is_dir():
        return []
    files = sorted(d.glob('*.jsonl'))
    if date_from is None and date_to is None:
        return files
    from_ym = date_from[:7] if date_from else None
    to_ym = date_to[:7] if date_to else None
    out = []
    for p in files:
        ym = p.stem
        if from_ym and ym < from_ym:
            continue
        if to_ym and ym > to_ym:
            continue
        out.append(p)
    return out


def _iter_records(date_from: str | None = None, date_to: str | None = None):
    for path in _shards_in_range(date_from, date_to):
        try:
            text = path.read_text(encoding='utf-8')
        except OSError:
            continue
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                # A truncated last line (e.g. after a crash mid-write) must
                # not take the whole shard down with it.
                continue
            date_part = (rec.get('ts') or '')[:10]
            if date_from and date_part < date_from:
                continue
            if date_to and date_part > date_to:
                continue
            yield rec


def _resolved_cost(rec: dict, overrides: dict | None) -> dict:
    cost = rec.get('cost') or {}
    if cost.get('source') == 'provider':
        return cost
    amount, source = pricing.compute_cost(rec.get('model', ''), rec.get('units'), overrides)
    return {
        'amount': amount,
        'currency': cost.get('currency', pricing.CURRENCY),
        'source': source,
        'pricing_version': pricing.PRICING_VERSION if source == 'catalog' else None,
    }


def _matching_records(*, project_id=None, task=None, provider=None, model=None, status=None,
                       date_from=None, date_to=None, overrides=None) -> list:
    matched = []
    for rec in _iter_records(date_from, date_to):
        if project_id is not None and rec.get('project_id') != project_id:
            continue
        if task and rec.get('task') != task:
            continue
        if provider and rec.get('provider') != provider:
            continue
        if model and rec.get('model') != model:
            continue
        if status and rec.get('status') != status:
            continue
        matched.append({**rec, 'cost': _resolved_cost(rec, overrides)})
    matched.sort(key=lambda r: r.get('ts', ''), reverse=True)
    return matched


def _totals(records: list) -> dict:
    calls = len(records)
    errors = sum(1 for r in records if r.get('status') == 'error')
    cost_sum = sum(r['cost']['amount'] for r in records if r['cost'].get('amount') is not None)
    unknown = sum(1 for r in records if r['cost'].get('amount') is None)
    return {
        'calls': calls, 'errors': errors, 'cost': cost_sum,
        'currency': pricing.CURRENCY, 'unknown_cost_calls': unknown,
    }


def query(*, project_id=None, task=None, provider=None, model=None, status=None,
          date_from=None, date_to=None, limit=100, offset=0, overrides=None) -> dict:
    limit = max(1, min(int(limit or 100), 500))
    offset = max(0, int(offset or 0))
    matched = _matching_records(
        project_id=project_id, task=task, provider=provider, model=model, status=status,
        date_from=date_from, date_to=date_to, overrides=overrides,
    )
    return {
        'records': matched[offset:offset + limit],
        'total': len(matched),
        'limit': limit,
        'offset': offset,
        'totals': _totals(matched),
    }


def _local_date(ts: str, tz_offset: int) -> str:
    try:
        dt = datetime.fromisoformat((ts or '').replace('Z', '+00:00'))
    except ValueError:
        return (ts or '')[:10]
    local = dt + timedelta(minutes=tz_offset)
    return local.strftime('%Y-%m-%d')


def _group_key(rec: dict, group_by: str, tz_offset: int) -> str:
    if group_by == 'project':
        return rec.get('project_id') or ''
    if group_by == 'task':
        return rec.get('task') or ''
    if group_by == 'model':
        return rec.get('model') or ''
    if group_by == 'provider':
        return rec.get('provider') or ''
    return _local_date(rec.get('ts', ''), tz_offset)


def summarize(*, group_by='day', tz_offset=0, project_id=None, task=None, provider=None,
              model=None, status=None, date_from=None, date_to=None, overrides=None) -> dict:
    if group_by not in GROUP_KEYS:
        group_by = 'day'
    matched = _matching_records(
        project_id=project_id, task=task, provider=provider, model=model, status=status,
        date_from=date_from, date_to=date_to, overrides=overrides,
    )

    groups: dict[str, dict] = {}
    for rec in matched:
        key = _group_key(rec, group_by, tz_offset)
        g = groups.setdefault(key, {
            'key': key, 'calls': 0, 'errors': 0, 'cost': 0.0, 'unknown_cost_calls': 0,
            'input_tokens': 0, 'output_tokens': 0, 'images': 0, 'duration_ms': 0,
        })
        g['calls'] += 1
        if rec.get('status') == 'error':
            g['errors'] += 1
        amount = rec['cost'].get('amount')
        if amount is None:
            g['unknown_cost_calls'] += 1
        else:
            g['cost'] += amount
        units = rec.get('units') or {}
        g['input_tokens'] += units.get('input_tokens') or 0
        g['output_tokens'] += units.get('output_tokens') or 0
        g['images'] += units.get('images') or 0
        g['duration_ms'] += rec.get('duration_ms') or 0

    group_list = list(groups.values())
    if group_by == 'day':
        group_list.sort(key=lambda g: g['key'], reverse=True)
    else:
        group_list.sort(key=lambda g: (-g['cost'], g['key']))

    return {
        'group_by': group_by, 'currency': pricing.CURRENCY,
        'groups': group_list, 'totals': _totals(matched),
    }


def today_total(tz_offset: int = 0, overrides: dict | None = None) -> dict:
    """Cost for "today" in the caller's local time zone. Records are stored
    in UTC, so local-today can straddle two UTC calendar days (e.g. late
    evening in UTC+3) - bound the shard scan by the UTC range that could
    contain any part of local-today, then keep only records whose *local*
    date actually matches."""
    local_now = _utcnow() + timedelta(minutes=tz_offset)
    local_midnight = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    today_str = local_midnight.strftime('%Y-%m-%d')

    utc_start = local_midnight - timedelta(minutes=tz_offset)
    utc_end = utc_start + timedelta(days=1)
    matched = _matching_records(
        date_from=utc_start.strftime('%Y-%m-%d'), date_to=utc_end.strftime('%Y-%m-%d'),
        overrides=overrides,
    )
    today_records = [r for r in matched if _local_date(r.get('ts', ''), tz_offset) == today_str]
    totals = _totals(today_records)
    return {
        'date': today_str, 'cost': totals['cost'], 'currency': pricing.CURRENCY,
        'calls': totals['calls'], 'unknown_cost_calls': totals['unknown_cost_calls'],
    }
