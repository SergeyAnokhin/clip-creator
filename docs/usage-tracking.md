# AI usage & cost tracking

Every paid AI call the backend makes (Suno text generation, wish-title
completion, scene image generation) is recorded to a local ledger with
tokens/images, a computed cost, and short previews of the prompt/response.
The frontend reads that ledger for a "Расходы"/"Usage" screen, a
today's-spend pill in every header, and price hints in the model pickers.

```text
provider call (suno.py / text_models.py / images.py)
   │  usage.record(ctx, model, kind, status, duration_ms, units, prompt, response, provider_cost?)
   ▼
pricing.compute_cost(model, units, overrides)   ← only if the provider didn't report its own cost
   ▼
app_data/usage/YYYY-MM.jsonl   (append-only, one JSON object per line)
   │
   ▼
routers/usage.py  →  GET /api/usage/records | /summary | /today, GET|PUT /api/usage/pricing
   │
   ▼
hooks/useUsage.js  →  UsageScreen, UsagePill (3 headers), price labels in ModelPicker/ModelFavorites
```

## Storage: `backend/app/usage.py`

Append-only JSONL, one file per calendar month:
`app_data/usage/YYYY-MM.jsonl` (via `storage.usage_dir()`). Chosen over a
single JSON file because `providers/images.py` runs several image
generations concurrently as background `asyncio` tasks — a read-modify-write
dict (like `storage.save_project`) would lose writes under that concurrency,
while appending one line per call does not: on a single event loop,
`usage.record()` contains no `await` between opening and closing the file, so
two concurrent calls can never interleave their writes. Month-sharding also
bounds how much has to be read for a "today" or date-ranged query.

### Record schema

| Field | Type | Notes |
| --- | --- | --- |
| `id` | str | `u_` + 12 hex chars |
| `ts` | str | UTC ISO-8601, `…Z` |
| `task` | str | `suno_generate` \| `wish_refine` \| `wish_title` \| `scene_storyboard` \| `scene_image` |
| `project_id` | str \| null | The project slug (= "стих"); `null` for calls with no project (wish-title) |
| `provider`, `model_id`, `model` | str | `model` is the `"{provider}:{model_id}"` composite, denormalized for grouping |
| `status` | str | `ok` \| `error` |
| `duration_ms` | int | Wall-clock around the provider call |
| `units` | dict | `{kind, input_tokens, output_tokens, reasoning_tokens, cached_input_tokens, total_tokens, images, compute_seconds}` — fields the provider didn't report are `null`/absent, not `0` |
| `cost` | dict | `{amount, currency, source, pricing_version}` — see below |
| `prompt_preview`, `response_preview` | str | First 300 chars (see "Preview convention") |
| `prompt_chars`, `response_chars` | int | True length of what was actually sent/received |
| `error` | str \| null | Truncated to 300 chars |
| `meta` | dict | Small free-form extras: `skill_id`, `scene_index`, `count` |

**Cost is never a silent zero.** `cost.amount` is `null` whenever the price
or the units needed to compute it are missing; `cost.source` is one of:

- `provider` — the API itself reported an exact cost (currently only
  OpenRouter, via `usage: {include: true}` on the request). Never
  recomputed.
- `catalog` — computed from `pricing.BUILTIN_PRICING`/overrides. **Recomputed
  on every read** against the *current* catalog (see `usage._resolved_cost`),
  so fixing a placeholder price in `pricing.py` or in the Settings → Prices
  tab retroactively corrects historical rows. The stored `amount` on disk is
  the price at call time, kept as an audit trail.
- `unknown` — no price is known for that model, or the provider didn't
  return the token/image counts needed. Every summary carries a separate
  `unknown_cost_calls` count so a total is never read as "the whole truth"
  when part of it is missing.

**Preview convention.** `prompt_preview`/`response_preview` are the text that
makes a call *distinguishable*, not necessarily the literal bytes sent. For
`suno_generate` that's the raw compiled lyrics (`raw_lyrics`), not the full
assembled prompt — the assembled prompt's first 300 chars are almost always
identical boilerplate from `settings.suno_base_prompt`, and
`suno_reference_examples` alone can run to 84 KB. `prompt_chars` still
reflects the true full length.

**Errors are recorded too.** A 4xx/5xx is usually unbilled, but a `200`
whose body carries a truncated/blocked response may still have consumed
(and billed) tokens — so error calls are written with whatever `units` the
response did carry, defaulting to unknown cost rather than guessing either
0 or the full price.

### Public API

```python
usage.context(task, project_id, settings, **meta) -> dict        # built once per request
usage.record(ctx, *, model, kind, status, duration_ms,
             units=None, prompt='', response='',
             provider_cost=None, error=None, meta=None) -> None  # never raises; ctx=None means "don't log"
usage.query(project_id=, task=, provider=, model=, status=,
            date_from=, date_to=, limit=100, offset=0, overrides=) -> {records, total, totals}
usage.summarize(group_by='day'|'project'|'task'|'model'|'provider',
                 tz_offset=0, **filters) -> {groups, totals}
usage.today_total(tz_offset=0, overrides=) -> {date, cost, calls, unknown_cost_calls}
```

### Time zone handling

Records are stored in UTC. `/api/usage/today` and `/api/usage/summary
?group_by=day` both take `tz_offset` (minutes east of UTC, i.e.
`-new Date().getTimezoneOffset()` from the browser) and bucket each record by
its **local** date. This matters because local-today can straddle two UTC
calendar days — a record at `22:30Z` is "today" for `tz_offset=0` but
"tomorrow" for `tz_offset=180` (UTC+3). Both endpoints must be called with
the *same* offset or the header pill and the day-grouped table will disagree
right at the boundary.

**Testing day-boundary logic:** `usage._utcnow()` is a thin wrapper around
`datetime.now(timezone.utc)` that exists purely so tests can monkeypatch a
fixed "now". A test that builds a record near a day boundary and calls
`today_total`/`summarize` *without* pinning `_utcnow()` is flaky — it only
fails when the suite happens to run near a real UTC midnight. Follow this
pattern for any new date-boundary logic instead of asserting against
`datetime.now()` directly.

## Pricing: `backend/app/pricing.py`

Pure data + arithmetic, no network/disk access, no dependency on `usage.py`
(dependency direction is `providers/* → usage → pricing`, never back).

`BUILTIN_PRICING` is keyed by the same `"{provider}:{model_id}"` composite as
everywhere else, text rows as `{kind: 'text', input, output, cached_input?}`
(USD per 1M tokens), image rows as `{kind: 'image', per_image}` (USD per
generated image).

**`BUILTIN_PRICING` only holds prices that were actually looked up, cited by
source.** It used to come pre-filled with prices "seeded from memory" rather
than looked up, and there was no way to tell a guess apart from a number the
user had actually verified in the UI — both showed up as an equally
confident price. It was emptied out for that reason, then repopulated
(2026-07-31) with a small set of rows — the app's own default models plus a
few common ones per provider — each checked against the provider's current
pricing page or its openrouter.ai listing, with the source URL in a comment
on the row; see the module docstring in `pricing.py` for the full list and
caveats (e.g. `google:gemini-3.5-flash-lite`'s price was sourced via its
OpenRouter listing rather than Google's own page). Everything else still
comes from `settings.pricing_overrides`, entered by hand in Settings → Prices
or imported from a JSON file (see "Pricing export/import" below); `source` in
the catalog is `'builtin'` for a verified hardcoded row, `'override'` for a
user-entered one, and a model with neither just shows as unpriced. If a price
is ever added or corrected in `BUILTIN_PRICING`, bump `pricing.PRICING_VERSION`
— because catalog costs are recomputed on read, that also fixes history, not
just future calls.

Resolution order in `pricing.get_price(model, overrides)`:

1. Exact user override — `settings.pricing_overrides["provider:model_id"]`.
2. `BUILTIN_PRICING` exact match.
3. Provider-wide wildcard override — `settings.pricing_overrides["provider:*"]`
   (an escape hatch for pricing a whole provider at once; built-ins never use
   wildcards).
4. `None` — cost is unknown, not zero.

A partially-filled override row (e.g. `input` without `output`) is treated as
**invalid**, not partial — it falls through to the next step rather than
producing half a price.

`pricing.estimate(model, *, input_tokens, output_tokens, images, input_chars,
overrides)` is the ex-ante estimator the frontend's `lib/pricing.js` mirrors
for model-picker labels — `input_chars` uses a crude ~4-chars-per-token
heuristic, which is why the UI should treat these as approximate, never as
the billed amount.

`pricing.catalog_with_known_models(overrides, known_models: dict[str, str])`
extends `catalog()` with one unpriced placeholder row (`source: 'catalog'`,
all price fields `None`) for every composite in `known_models` (composite ->
`'text'`/`'image'`) that isn't already priced. `known_models` is built by
`routers/usage.py::_known_models()` from the persisted model catalog (see
below) - `pricing.py` itself stays disk-free. This is what lets the Settings
"Prices" tab list every model the "Models" tab has ever seen, not just the
ones someone has already priced.

## Instrumenting a new AI call site

1. In the router, build a context once: `ctx = usage.context(task, project_id, settings, **extra_meta)`.
2. Pass `usage_ctx=ctx` down to the provider function (add it as a trailing
   optional parameter, default `None` — existing callers/tests keep working
   untouched).
3. Around the actual HTTP call, time it (`time.monotonic()` before/after) and
   call `usage.record(usage_ctx, model=..., kind='text'|'image', status='ok'|'error',
   duration_ms=..., units={...}, prompt=..., response=..., error=...)` on
   every exit path — including the error path, since `usage.record` never
   raises and the caller's existing error handling (raise, fallback, etc.) is
   unaffected.
4. Pull `units` from wherever the provider's response puts its token/image
   counts (see the table below); leave fields the response doesn't have as
   `None`/absent rather than guessing.
5. Leave the model unpriced ("price unknown" in the UI) until a real price is
   added — via a `settings.pricing_overrides` entry (manual or imported) for
   day-to-day use, or a cited, verified row in `pricing.BUILTIN_PRICING` if
   it's worth hardcoding app-wide (see that module's docstring). Never a
   number typed in from memory, in either place.

### Where each provider's usage fields live (as of 2026-07)

| Provider | Response field | Notes |
| --- | --- | --- |
| Google Gemini (`suno.py`, `text_models._complete_google`) | `data.usageMetadata.{promptTokenCount, candidatesTokenCount, totalTokenCount, cachedContentTokenCount, thoughtsTokenCount}` | No cost field — catalog-priced |
| OpenRouter (`text_models._complete_openrouter`) | `data.usage.{prompt_tokens, completion_tokens, total_tokens, cost}` | Request body must include `"usage": {"include": true}` to get `cost` (exact USD, `source: 'provider'`); `/models` also exposes `pricing.{prompt,completion}` (USD per token) for the catalog, currently not auto-imported — see "Not implemented" below |
| DeepSeek (`text_models._complete_deepseek`) | `data.usage.{prompt_tokens, completion_tokens, total_tokens, prompt_cache_hit_tokens}` | No cost field; cache-hit tokens map to `cached_input_tokens` and are billed at `pricing`'s `cached_input` rate when present |
| Replicate (`images.py`) | `data.metrics.predict_time` | Seconds, not cost — stored in `units.compute_seconds`, priced from the catalog's `per_image` |
| FAL (`images.py`) | `payload.timings.inference` | Same treatment as Replicate |
| Krea, Google Imagen (`images.py`) | none | `units: {images: 1}` only, catalog-priced |

`text_models.list_models` / `image_models.list_models` (the Settings
"refresh models" catalog calls) are **not logged** — they're free/no-cost
catalog lookups, and the Settings refresh button fires several at once.

## HTTP API — `backend/app/routers/usage.py`

| Route | Notes |
| --- | --- |
| `GET /api/usage/records` | Filters: `project_id, task, provider, model, status, date_from, date_to, limit (≤500, default 100), offset`. → `{records, total, limit, offset, totals}`, newest first |
| `GET /api/usage/summary` | Same filters + `group_by ∈ project\|task\|model\|provider\|day` (default `day`) + `tz_offset`. → `{group_by, currency, groups: [{key, calls, errors, cost, unknown_cost_calls, input_tokens, output_tokens, images, duration_ms}], totals}` |
| `GET /api/usage/today` | `tz_offset` → `{date, cost, currency, calls, unknown_cost_calls}` — backs the header pill |
| `GET /api/usage/pricing` | → `{pricing_version, currency, models: [...], overrides}` — merged catalog for the UI |
| `PUT /api/usage/pricing` | Body `{pricing_overrides}` → validated (`pricing.validate_overrides`) and persisted into `settings.pricing_overrides`; `422` on a malformed row |

`DEFAULT_SETTINGS` in `routers/settings.py` gained `'pricing_overrides': {}`.

## Frontend

| File | Role |
| --- | --- |
| [`lib/pricing.js`](../frontend/src/lib/pricing.js) | Pure: `formatCost`, `formatTokens`, `estimateCost`, `priceLabel`, `modelPriceMap` — vitest-covered in `pricing.test.js` |
| [`hooks/useUsage.js`](../frontend/src/hooks/useUsage.js) | `today`/`pricing` load once on mount (cheap); `records`/`summary` load only when the Usage screen calls `loadRecords`/`loadSummary`, so a user who never opens it never pays for that request |
| [`components/UsagePill.jsx`](../frontend/src/components/UsagePill.jsx) | Shared "spend today" pill, used in `home/Header.jsx`, `workflow/WorkflowHeader.jsx`, and `settings/SettingsScreen.jsx`'s own header |
| [`components/usage/UsageScreen.jsx`](../frontend/src/components/usage/UsageScreen.jsx) + `UsageFilters`/`UsageSummary`/`UsageTable` | The "Расходы"/"Usage" screen — filters, group-by summary, an expandable record table showing prompt/response previews |
| [`components/settings/PricingPanel.jsx`](../frontend/src/components/settings/PricingPanel.jsx) | Settings → Prices tab: the merged catalog (a small set of verified `BUILTIN_PRICING` rows + overrides + unpriced catalog-only rows, see above) with editable input/output/per-image fields, an "overridden" badge + reset button per row, a provider filter + text search (same multi-term matching as `ModelFavorites`, needed once the catalog brings in a provider's full model list), a form for pricing a model not yet in the catalog, and an Export/Import pair (see below) for round-tripping the whole catalog through an external pricing lookup |
| `ModelPicker.jsx` / `ModelFavorites.jsx` | Both accept an optional `prices`/`L` prop and append a price suffix to each model's label (`· $0.30/$2.50`, `· $0.04 за кадр`, or `price ?` — the token price needs no unit suffix since "per 1M" is the only unit used app-wide, but the image price keeps `L.price_perImage` since that unit isn't obvious). `ModelFavorites`' default toggle is a fixed-size circular button (`.model-default-toggle` in `theme.css`) so the row layout never shifts between the "default" and "not default" states |

**Navigation note.** The Usage screen is reachable from all three top-level
screens (home/workflow/settings), including Settings itself. `App.jsx` keeps
a *separate* `usageReturnScreen` state distinct from `prevScreen` (which
Settings uses to get back to wherever it was opened from) — reusing
`prevScreen` would make `settings → usage → back` land back on `usage`
itself, an infinite loop.

**Spend-pill refresh.** Not polled — `useUsage().actions.refreshToday` is
passed as `onAiCall` into `useSunoStage`, `useScenesStage`, and `useSettings`,
and called in the `finally` of `generateSuno`, `generateStoryboard`,
`generateSceneImages`, and `saveWishToLibrary`.

**Pricing export/import.** The Prices tab's Export button downloads the
*saved* catalog (`pricing.models`, i.e. `GET /api/usage/pricing`'s merged
view — overrides + unpriced catalog-only placeholders, ignoring any unsaved
local edits) as `versecraft-model-prices.json`:
`{pricing_version, currency, exported_at, models: {"provider:model_id":
{kind, input, output, cached_input?} | {kind, per_image}}}`. Unpriced rows
are exported with `null` price fields, which is the point — the file is
meant to be handed to an external research pass (a model that can look up
current provider pricing) that fills in the missing numbers, then
re-imported. Import reads the same shape (or a bare `{composite: row}` map
without the wrapper) and stages every row with a valid `kind` + numeric
price as a pending override in the panel's local `drafts` — same as a
manual edit, so it still needs "Save" to persist via `PUT
/api/usage/pricing`. Rows that are missing, malformed, or still carry `null`
prices are skipped and counted in the status line rather than guessed.
Shared file-IO helpers (`downloadJSON`/`readJSONFile`) live in
[`lib/download.js`](../frontend/src/lib/download.js), also used by the
Settings "Backup" panel's API-keys/general-settings export/import.

## Known gaps / not implemented

- `providers/scenes.py` is still a non-AI stub; it accepts `usage_ctx` (so
  the router wiring is already in place) but records nothing yet, matching
  the "no network call, nothing to bill" rule.
- OpenRouter's `/models` `pricing` field is not yet auto-imported into the
  catalog — it's fetched by `text_models._list_openrouter` for the model list
  but the price isn't picked up from there. Doing so would save having to
  price OpenRouter models by hand or via the Export/Import round-trip.
- No automatic ledger pruning. Growth is small (~450 bytes/record; a few
  hundred KB per month of typical use), and month-sharded files can be
  deleted by hand if ever needed — there is no `DELETE` route for this.
- `settings.pricing_overrides` is not included in the Settings screen's
  general "Backup" export/import (General/API-keys tabs) — it's saved
  through its own `PUT /api/usage/pricing`, not the general `PUT
  /api/settings`. It has its own Export/Import pair on the Prices tab
  instead (see "Pricing export/import" above).
