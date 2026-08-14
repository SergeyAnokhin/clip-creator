# AI usage & cost tracking

Every paid AI call the backend makes is recorded to a local ledger with
unit counts, a computed cost, and short previews of the prompt/response. The
frontend reads it back for a "Расходы"/Usage screen, a today's-spend pill in
every header, and price hints in the model pickers. The same calls also print a
colored line to the backend's dev console (see "Console logging").

```text
provider call (suno.py / text_models.py / images.py / video.py / title_card.py / translate.py)
   │  usage.record(ctx, model, kind, status, duration_ms, units, prompt, response, provider_cost?)
   ▼
pricing.compute_cost(model, units, overrides)   ← only if the provider didn't report its own cost
   ▼
app_data/usage/YYYY-MM.jsonl   (append-only, one JSON object per line)
   │
   ▼
routers/usage.py  →  GET /api/usage/records | /summary | /today | /period-totals, GET|PUT /api/usage/pricing
   │
   ▼
hooks/useUsage.js  →  UsageScreen, UsagePill (3 headers), price labels in ModelPicker/ModelFavorites
```

## Storage: `backend/app/usage.py`

Append-only JSONL, one file per calendar month (`storage.usage_dir()`). Chosen
over a single JSON file because `providers/images.py` runs several generations
concurrently as background tasks: a read-modify-write dict would lose writes,
while appending one line does not — on a single event loop `usage.record()`
contains **no `await` between opening and closing the file**, so two concurrent
calls can't interleave. Month-sharding also bounds how much is read for a "today"
or date-ranged query.

### Record schema

| Field | Type | Notes |
| --- | --- | --- |
| `id` | str | `u_` + 12 hex chars |
| `ts` | str | UTC ISO-8601, `…Z` |
| `task` | str | `suno_generate` \| `wish_title` \| `scene_storyboard` \| `scene_image` \| `scene_image_crop` \| `scene_video` \| `title_card` \| `title_card_bg_remove` \| `magic_layers` \| `translate` |
| `project_id` | str \| null | The project slug; `null` for `wish_title` calls made from Settings → Wishes (library-only) and always `null` for `translate` |
| `provider`, `model_id`, `model` | str | `model` is the `"{provider}:{model_id}"` composite, denormalized for grouping |
| `status` | str | `ok` \| `error` |
| `duration_ms` | int | Wall-clock around the provider call |
| `units` | dict | `{kind, input_tokens, output_tokens, reasoning_tokens, cached_input_tokens, total_tokens, images, seconds, compute_seconds, characters}` — fields the provider didn't report are `null`/absent, **not `0`**; `characters` is `translate`-only, `seconds` is `scene_video`-only (the requested duration, used to price Veo off the catalog's per-second rate) |
| `cost` | dict | `{amount, currency, source, pricing_version, saved_amount?}` — see below |
| `prompt_preview`, `response_preview` | str | First 300 chars (see "Preview convention") |
| `prompt_chars`, `response_chars` | int | True length of what was actually sent/received |
| `error` | str \| null | Truncated to 300 chars |
| `meta` | dict | Small free-form extras: `skill_id`, `scene_index`, `count` |

**Cost is never a silent zero.** `cost.amount` is `null` whenever the price or
the units needed to compute it are missing. `cost.source` is one of:

- `provider` — the API reported an exact cost (currently only OpenRouter: text
  via `usage: {include: true}`, images via the Unified Image API's `usage.cost`,
  video via the Unified Video API's poll-response `usage.cost`). **Never
  recomputed.**
- `catalog` — computed from `pricing.BUILTIN_PRICING`/overrides. **Recomputed on
  every read** against the *current* catalog (`usage._resolved_cost`), so fixing
  a placeholder price retroactively corrects historical rows. The stored `amount`
  on disk is the price at call time, kept as an audit trail.
- `unknown` — no price is known, or the provider didn't return the counts needed.
  Every summary carries a separate `unknown_cost_calls` count so a total is never
  read as the whole truth when part of it is missing.
- `free` — the call went out through `google_free` (a free-tier Google key, see
  `pricing._PROVIDER_PRICE_ALIAS`). `amount` is always `0`, never the aliased
  paid-tier price, so it can't inflate a spend total; what it *would* have cost
  is kept as `cost.saved_amount` and rolled into every totals object's
  `saved_cost`. Computed on every read, same as `catalog`.

**Preview convention.** `prompt_preview`/`response_preview` are the text that
makes a call *distinguishable*, not necessarily the literal bytes sent. For
`suno_generate` that's the raw compiled lyrics, not the assembled prompt — whose
first 300 chars are almost always identical boilerplate, and whose
`suno_reference_examples` alone can run to 84 KB. `prompt_chars` still reflects
the true full length.

**Errors are recorded too.** A 4xx/5xx is usually unbilled, but a `200` whose
body carries a truncated/blocked response may still have consumed tokens — so
error calls are written with whatever `units` the response did carry, defaulting
to unknown cost rather than guessing 0 or full price.

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
`-new Date().getTimezoneOffset()`) and bucket each record by its **local** date,
because local-today can straddle two UTC days. **Both endpoints must be called
with the same offset** or the header pill and the day-grouped table disagree
right at the boundary.

**Testing day-boundary logic:** `usage._utcnow()` exists purely so tests can
monkeypatch a fixed "now". A test that builds a record near a day boundary
without pinning it is flaky — it only fails when the suite happens to run near a
real UTC midnight. Follow this pattern for any new date-boundary logic.

## Pricing: `backend/app/pricing.py`

Pure data + arithmetic, no network or disk access, and no dependency on
`usage.py` — the direction is `providers/* → usage → pricing`, never back.

`BUILTIN_PRICING` is keyed by the same `"{provider}:{model_id}"` composite, with
three row kinds: `{kind: 'text', input, output, cached_input?}` (USD per 1M
tokens), `{kind: 'image', per_image}`, and `{kind: 'video', per_second}` (Veo's
own billing unit).

**`BUILTIN_PRICING` only holds prices that were actually looked up, cited by
source** — it holds the app's default models plus a few common ones per
provider, each checked against the provider's pricing page or its OpenRouter
listing, with the source URL in a comment on the row (see the module docstring
for caveats). Everything else comes from `settings.pricing_overrides`, entered by
hand or imported. `source` in the catalog is `'builtin'` for a verified
hardcoded row, `'catalog'` for a model with no price yet, and otherwise the
override row's own `source` — `'manual'` (typed in the Prices tab) or `'import'`
(loaded from JSON, unless the file's row carried its own string). An override
saved before this field existed falls back to `'manual'`. **If a price is ever
added or corrected in `BUILTIN_PRICING`, bump `pricing.PRICING_VERSION`** —
because catalog costs are recomputed on read, that fixes history too.

Resolution order in `pricing.get_price(model, overrides)`:

1. Exact user override — `settings.pricing_overrides["provider:model_id"]`.
2. `BUILTIN_PRICING` exact match.
3. Provider-wide wildcard override — `settings.pricing_overrides["provider:*"]`
   (built-ins never use wildcards).
4. Provider alias — steps 1-3 again under `pricing._PROVIDER_PRICE_ALIAS`
   (currently just `google_free -> google`). Aliased rows aren't listed
   separately in the Prices tab: the alias affects cost *lookups* only, not what
   `catalog()` enumerates.
5. `None` — cost is unknown, not zero.

A partially-filled override row (e.g. `input` without `output`) is treated as
**invalid**, not partial — it falls through rather than producing half a price.

`pricing.estimate(...)` is the ex-ante estimator `lib/pricing.js` mirrors for
model-picker labels; `input_chars` uses a crude ~4-chars-per-token heuristic, so
the UI must treat these as approximate, never as the billed amount.

`pricing.catalog_with_known_models(overrides, known_models)` extends `catalog()`
with one unpriced placeholder row per composite that isn't priced yet.
`known_models` is built by `routers/usage.py::_known_models()` from the persisted
model catalog, keeping `pricing.py` itself disk-free — this is what lets the
Prices tab list every model the Models tab has ever seen.

## Instrumenting a new AI call site

1. In the router, build a context once:
   `ctx = usage.context(task, project_id, settings, **extra_meta)`.
2. Pass `usage_ctx=ctx` down to the provider function as a trailing optional
   parameter defaulting to `None`, so existing callers and tests keep working.
3. Around the actual HTTP call, time it with `time.monotonic()` and call
   `usage.record(...)` on **every** exit path including the error path —
   `usage.record` never raises, so the caller's own error handling is unaffected.
4. Pull `units` from wherever that provider puts its counts (table below); leave
   fields the response doesn't have as `None`/absent rather than guessing.
5. Leave the model **unpriced** until a real price exists — a
   `settings.pricing_overrides` entry for day-to-day use, or a cited, verified
   `BUILTIN_PRICING` row if it's worth hardcoding. Never a number from memory.

### Where each provider's usage fields live

| Provider | Response field | Notes |
| --- | --- | --- |
| Google Gemini (`suno.py`, `text_models._complete_google`) | `data.usageMetadata.{promptTokenCount, candidatesTokenCount, totalTokenCount, cachedContentTokenCount, thoughtsTokenCount}` | No cost field — catalog-priced |
| OpenRouter text (`text_models._complete_openrouter`) | `data.usage.{prompt_tokens, completion_tokens, total_tokens, cost}` | Request body must include `"usage": {"include": true}` to get `cost` (exact USD, `source: 'provider'`) |
| DeepSeek (`text_models._complete_deepseek`) | `data.usage.{prompt_tokens, completion_tokens, total_tokens, prompt_cache_hit_tokens}` | No cost field; cache-hit tokens map to `cached_input_tokens`, billed at the `cached_input` rate |
| Replicate (`images.py`) | `data.metrics.predict_time` | Seconds, not cost — stored in `units.compute_seconds`, priced from the catalog's `per_image` |
| FAL (`images.py`) | `payload.timings.inference` | Same treatment as Replicate |
| Krea, Google Imagen (`images.py`) | none | `units: {images: 1}` only, catalog-priced |
| OpenRouter images (`images.py`) | `data.usage.cost` | Exact USD, `source: 'provider'` |
| Replicate background remover (`title_card.py`) | none | `units: {images: 1}`, catalog-priced off the `replicate:851-labs/background-remover` row. Task `title_card_bg_remove` |
| Magic layers (`magic_layers.py`) | FAL: `payload.timings.inference`; Replicate: `data.metrics.predict_time` | `units: {images: 1}` — one decomposition is one billed call regardless of how many layers come back. Catalog-priced off `fal:fal-ai/qwen-image-layered` ($0.05) or `replicate:qwen/qwen-image-layered` ($0.03). Task `magic_layers` |
| Google Translate (`providers/translate.py`) | none | `units: {characters: len(text)}` — `pricing.py` has no per-character row shape, so cost always reads `unknown` unless an override is entered for `google_translate:v2` |
| FAL outpaint (`images.py`'s `crop_image`) | none — billed per output **megapixel**, a shape the catalog can't express | Cost computed from the result's pixel size and set on `usage_out['cost']` (same bypass as OpenRouter). **No `BUILTIN_PRICING` row**, so don't add one expecting it to be used. A plain in-bounds crop is a separate `local:crop` model hardcoded at `0.0` |
| Google Veo (`providers/video.py`) | none | `units: {seconds: duration_seconds}`, catalog-priced off the `google:veo-3.1-*` `per_second` rows. Task `scene_video` |
| OpenRouter video (`providers/video.py`) | poll response's `usage.cost` | Exact USD, `source: 'provider'` |

`text_models.list_models` / `image_models.list_models` (the "refresh models"
catalog calls) are **not logged** — they're free lookups, and the refresh button
fires several at once.

**Suno generate: a usage summary in the response, not just the ledger.** Each
provider function attaches a `usage` object to the `debug` dict it already
returns (`{duration_ms, input_tokens, output_tokens, total_tokens,
reasoning_tokens, cached_input_tokens, cost: {amount, currency, source}}`), built
by `suno._usage_summary()`. It mirrors `usage._write`'s cost-source priority
exactly, so the debug panel's numbers can never disagree with the ledger. This
exists because `SunoStage.jsx` never fetches the ledger — the panel only has what
`POST .../suno/generate` returned.

A timeout is caught explicitly rather than left to bubble up as a generic
`httpx.TimeoutException`, recorded as an error with a human-readable message
("Таймаут: модель {model} не ответила за {N} секунд."), and re-raised as a
`RuntimeError` carrying that same message, which the `generation_*.py` routers
wrap into an HTTP 502 whose `detail` the frontend surfaces verbatim.

## HTTP API — `backend/app/routers/usage.py`

| Route | Notes |
| --- | --- |
| `GET /api/usage/records` | Filters: `project_id, task, provider, model, status, date_from, date_to, limit (≤500, default 100), offset`. → `{records, total, limit, offset, totals}`, newest first |
| `GET /api/usage/summary` | Same filters + `group_by ∈ project\|task\|model\|provider\|day` (default `day`) + `tz_offset`. → `{group_by, currency, groups: [{key, calls, errors, cost, unknown_cost_calls, input_tokens, output_tokens, images, duration_ms}], totals}` |
| `GET /api/usage/today` | `tz_offset` → `{date, cost, currency, calls, unknown_cost_calls}` — the header pill's collapsed view |
| `GET /api/usage/period-totals` | `tz_offset` → `{currency, today, week, month, total}`, each a `{calls, errors, cost, unknown_cost_calls, saved_cost}` object (`week` since local Monday, `month` since the 1st) — the pill's expanded view, fetched lazily on first expand |
| `GET /api/usage/pricing` | → `{pricing_version, currency, models: [...], overrides}` — merged catalog for the UI |
| `PUT /api/usage/pricing` | Body `{pricing_overrides}` → validated (`pricing.validate_overrides`) and persisted into `settings.pricing_overrides`; `422` on a malformed row |

## Frontend

File-by-file roles are in [code-map.md](code-map.md); the behavior worth knowing:

- **Nothing is polled.** `useUsage` loads `today`/`pricing` once on mount,
  `periodTotals` lazily when the header pill first expands, and
  `records`/`summary` only when the Usage screen asks. Refresh is push-based:
  `refreshToday` is passed as `onAiCall` into `useSunoStage`, `useScenesStage`
  and `useSettings`, and called in the `finally` of `generateSuno`,
  `generateStoryboard`, `generateSceneImages` and `saveWishToLibrary`.
- **`UsagePill`** is the only route to the full Usage screen. `App.jsx` keeps a
  *separate* `usageReturnScreen` from `prevScreen` (which Settings uses) —
  reusing it would make `settings → usage → back` land on `usage` itself.
- **Estimates are marked as such.** `ModelPicker`/`ModelFavorites` append a price
  suffix per model; `SunoStage`'s `UsageSummaryLine` prefixes cost with `≈` when
  `cost.source !== 'provider'` and with nothing when the provider billed exactly
  that. That line renders **whether or not the debug panel is expanded** — the
  point is not having to open raw JSON to see what a call cost.
- **Errors persist, toasts don't.** `useSunoStage`'s `sunoError` stays until the
  *next* `generateSuno()` call, so a timeout doesn't flash past;
  `elapsedSeconds` is driven by a `sunoLoading` effect rather than from inside
  `generateSuno()`, so it can't drift out of sync with the spinner.
  `useTitleCardStage` mirrors both.
- **Pricing export/import** (Prices tab) round-trips the whole catalog through an
  external pricing lookup. Export writes the *saved* catalog (ignoring unsaved
  edits) as `{pricing_version, currency, exported_at, models: {"provider:model_id":
  row}}`, each row carrying its `source`. **Unpriced rows are exported with
  `null` prices on purpose** — that's what the external pass fills in. Import
  accepts the same shape (or a bare `{composite: row}` map) and stages valid rows
  as pending drafts, so it still needs "Save" to persist; missing, malformed or
  still-`null` rows are skipped and counted rather than guessed.

## Console logging: `backend/app/console_log.py`

A dev-visibility aid, separate from the ledger (never raises, never affects
request behavior). Two lines per real provider call: `log_request_start` right
before the outbound call, and `log_result` called once from `usage._write()` — so
it fires for every call that reaches the ledger and **can never disagree with
it**. Green on success (`✅ [suno_generate] … · 🔤 812→340 · ⏱ 1.8s · 💰
$0.0041`), red on error.

Stub/no-network fallbacks call neither — nothing is printed for a request that
never went out, matching the ledger's "don't bill what didn't happen" rule.

Both print via `_safe_print`, which writes real UTF-8 bytes straight to
`sys.stdout.buffer` if a plain `print()` fails: `npm run dev`'s `concurrently`
wrapper makes `sys.stdout.encoding` look like a legacy codepage even though the
terminal is UTF-8, which used to turn emoji/Cyrillic into mojibake.

`request_log.RequestLogMiddleware` separately replaces uvicorn's access log with
one line per request (`HH:MM:SS <emoji> METHOD path -> status (ms)`, colored by
outcome, no client IP or date); `main.py` disables the built-in `uvicorn.access`
logger at import time so requests aren't logged twice.

## Known gaps / not implemented

- OpenRouter's `/models` `pricing` field is fetched for the model list but not
  auto-imported into the catalog. Doing so would save pricing OpenRouter models
  by hand or via the Export/Import round trip.
- No automatic ledger pruning. Growth is small (~450 bytes/record), and
  month-sharded files can be deleted by hand — there is no `DELETE` route.
- `settings.pricing_overrides` is not in the Settings screen's general Backup
  export/import; it has its own Export/Import on the Prices tab.
