# Data model & API

Everything is JSON on disk under `app_data/` (git-ignored, override the root
with the `APP_DATA_DIR` env var). No database, no migrations — a project file
is whatever shape `storage.save_project` last wrote.

```text
app_data/
  settings.json
  model_catalog.json          # last-known-good model list per provider (see below)
  projects/
    <slug>/                  # slug = "Author - Title", filesystem-sanitized = project id
      config.json            # the whole project
      images/scene_{n}_{shorthex}.{png|jpg|webp}
      references/ref_{uuid}.{ext}
  usage/
    YYYY-MM.jsonl             # append-only AI-call ledger, one JSON object per line
```

## Project (`config.json`)

| Field | Type | Notes |
| --- | --- | --- |
| `id` | str | = folder slug; collisions get `-2`, `-3`, … |
| `author`, `title` | str | Fall back to `"Неизвестный автор"` / `"Новое стихотворение"` |
| `created_at`, `updated_at` | str | ISO-8601 `…Z`; `updated_at` refreshed on every write |
| `tags` | str[] | Home-screen chips only |
| `blocks` | Block[] | Source of truth for the lyrics builder |
| `skill_id`, `skill_prompt` | str | Active Suno skill and its (freely editable) "Дополнения к промпту" text — always sent last in the assembled prompt, after the base prompt and any active wishes |
| `active_wish_ids` | str[] | Ids of `settings.suno_wish_library` entries currently toggled on for this project (see below) — resolved to their `text` and sent as an emphasized block on `suno/generate` |
| `refinement_comments` | str[] | Unused — kept only for backward compatibility with old `config.json` files. Was the "AI-wish" history under the old `suno/refine` flow (removed); always `[]` on projects created or migrated since |
| `style`, `lyrics` | str | Suno output; `style` non-empty ⇒ `suno_done` in the list view |
| `model_used` | str | Text model used for the last generation |
| `track_url` | str | User-pasted Suno track link |
| `style_description` | str | Free-text visual style for the storyboard |
| `reference_images` | str[] | Paths relative to `app_data/`, e.g. `projects/<slug>/references/ref_ab12cd34.png` |
| `scenes` | Scene[] | `[]` until the storyboard is generated |
| `source_url` | str | Original URL, if the project came from one |

**Block**: `{id, type, importance, content}` — `type` is
`intro|verse|chorus|bridge|outro|interlude`; `content` is plain multi-line text.
`interlude` blocks hold a Suno meta-tag (e.g. `[Vocal Interlude]`) and render as
a compact single-line card. `importance` (1-5) is **dead** — still written for
backward compatibility, never read or edited.

**Scene**: `{lyric_segment, static_prompt, motion_prompt, images[]}`.

**Image**: `{image_id, file_path, rating, is_selected, generated_at}` —
`file_path` is relative to the project folder (`images/scene_1_a1b2c3d4.png`;
extension depends on the provider - `png`/`jpg`/`webp`), `rating` 0-5, exactly
one `is_selected` per scene once anything is rated.

**Legacy migration**: a project's *absence* of `active_wish_ids` marks it as
predating the AI-wish library rework. The first time such a project loads
through any route (`routers/projects.py::migrate_legacy_project`), its
`skill_prompt` is reset to the default skill text, `refinement_comments` is
cleared, and `active_wish_ids` is set to `[]` — persisted immediately, so
this only ever fires once per project.

## Usage ledger (`app_data/usage/YYYY-MM.jsonl`)

One JSON object per line, append-only, one file per calendar month. Full
field-by-field detail, cost-resolution rules, and how to instrument a new
call site are in [usage-tracking.md](usage-tracking.md); summary:

`{id, ts, task, project_id, provider, model_id, model, status, duration_ms, units{kind,input_tokens,output_tokens,reasoning_tokens,cached_input_tokens,total_tokens,images,compute_seconds}, cost{amount,currency,source,pricing_version}, prompt_preview, response_preview, prompt_chars, response_chars, error, meta}`

`task` is one of `suno_generate|wish_title|scene_storyboard|scene_image`.
`cost.amount` is `null` (never `0`) when the price or usage units needed to
compute it are unknown; `cost.source` is `provider|catalog|unknown`.

## Settings (`settings.json`)

`{lang, api_keys{replicate,google,fal,openrouter,deepseek,krea}, text_models{favorites[],default},
simple_models{favorites[],default}, image_models{favorites[],default}, special_tags[],
suno_base_prompt, suno_reference_examples[], suno_wish_library[], pricing_overrides{}}`. Reads and
writes merge over `DEFAULT_SETTINGS` in
[`routers/settings.py`](../backend/app/routers/settings.py) (seed text for
`suno_base_prompt`/`suno_reference_examples` comes from
[`providers/suno_prompt_defaults.py`](../backend/app/providers/suno_prompt_defaults.py)),
so adding a key there is enough — existing files keep loading. `PUT` is a
partial merge server-side, so the frontend can persist e.g. just
`{suno_wish_library}` without resending the whole settings object.

- `text_models` / `simple_models` / `image_models` — same shape: `favorites`
  is `{provider, id, label}[]`; `default` is a composite `"{provider}:{id}"`
  string (e.g. `"google:gemini-2.5-flash"`). `text_models`/`simple_models`
  only accept `provider` `google|openrouter|deepseek|replicate|fal`;
  `image_models` additionally accepts `krea` (Krea AI is image/video-only, so
  it's excluded from the text-model provider set — see `_IMAGE_MODEL_PROVIDERS` vs
  `_MODEL_PROVIDERS` in `routers/settings.py`). `text_models.default` is
  what `suno.generate` parses to decide whether to call the real Gemini API
  (see below); `simple_models.default` is used for lightweight tasks — in one
  call, tidying up the user's free-text "AI-wish" and generating its
  emoji-prefixed title when it's saved to `suno_wish_library`
  ([`providers/text_models.py`](../backend/app/providers/text_models.py)
  `clean_wish_and_title`, wrapped by
  [`providers/wish_library.py`](../backend/app/providers/wish_library.py)
  `add_or_get_wish`) — there is deliberately **no** per-call model picker for
  this on the Suno stage, only the one global default in Settings;
  `image_models.default`/`.favorites` populate the
  image-model picker in Settings ([`providers/image_models.py`](../backend/app/providers/image_models.py))
  and the per-generation `ModelPicker` in `ScenesStage.jsx`, whose composite
  is what `providers/images.py` actually dispatches to a real provider call
  (see `architecture.md`).
- `suno_base_prompt` — the general "how to adapt for this music service"
  instructions, sent on every real (non-stub) `suno/generate` call.
  `GET /api/settings/suno-prompt-presets` (not part of `settings.json` — a
  read-only, hardcoded list combining `suno_prompt_defaults.SUNO_BASE_PROMPT_PRESETS`
  and `mureka_prompt_defaults.MUREKA_BASE_PROMPT_PRESETS`) offers alternate
  full-text variants of this prompt to load into the field from Settings, for
  A/B testing. Each entry is `{id, service, name, description, prompt}` —
  `service` groups them in the UI ("Suno": vocal-first vs. canonical
  genre-first field ordering; "Mureka": vocal cues only in the Style-block vs.
  also as in-text parenthetical directives like `(whispering)`).
- `suno_reference_examples` — curated example style+lyrics blocks, sent
  alongside the base prompt as "reference, don't copy verbatim" material.
- `suno_wish_library` — global, reusable wish "cards", each
  `{id, title, text, created_at}`. `text` and `title` are both produced in a
  single call to `clean_wish_and_title` on save — `text` is the tidied-up
  wish (not the user's raw input verbatim), `title` a short auto-generated
  label prefixed with one emoji (e.g. `"🎷 Больше саксофона"`) — real LLM
  call if `simple_models.default` points at Google/OpenRouter/DeepSeek with a
  key configured, otherwise `text` is kept as-is and `title` falls back to a
  local truncate. Legacy plain-string entries are normalized to this shape on
  `GET /api/settings` (not rewritten to disk until the next save). Each
  project independently toggles a subset of these cards on via its own
  `active_wish_ids` (see above) — the same card can be active for one song
  and inactive for another.
- `pricing_overrides` — user-supplied AI price corrections, keyed by
  `"{provider}:{model_id}"` (or `"{provider}:*"` as a whole-provider
  wildcard), same row shape as `pricing.BUILTIN_PRICING` (see
  [usage-tracking.md](usage-tracking.md)). Saved via its own
  `PUT /api/usage/pricing`, not the general settings `PUT` — **not** included
  in the Settings screen's backup export/import.
- The Settings screen's "Backup" controls (`SettingsScreen.jsx`, general and
  providers tabs) export/import `api_keys` separately from every other
  settings field as downloadable JSON files. This is pure client-side file
  I/O (`Blob` download, `FileReader` + hidden `<input type="file">`) — there
  is no dedicated `/export`/`/import` route; import just calls the existing
  `PUT /api/settings` with the parsed file content
  ([`hooks/useSettings.js`](../frontend/src/hooks/useSettings.js)
  `importApiKeys`/`importGeneralSettings`).

## Model catalog (`model_catalog.json`)

`{text: {provider: {source, models, error?}}, image: {provider: {...}}}` —
the last-known-good response of every `GET /api/settings/models/{provider}`
and `GET /api/settings/image-models/{provider}` call, keyed by provider,
managed by `storage.load_model_catalog`/`save_model_catalog`. Written by
`routers/settings.py::_remember_catalog_entry` on every successful (non-
`error`) model fetch, so a transient API failure never overwrites a
previously good list. Read back by `GET /api/settings/models-catalog` (the
Settings "Models" tab's initial state, before "Refresh models" is pressed in
the current session) and by `routers/usage.py::_known_models()` (feeds
`pricing.catalog_with_known_models`, see [usage-tracking.md](usage-tracking.md),
so the "Prices" tab lists every known model even before it has a price).

## API

Base `http://localhost:8000`. All request/response bodies are JSON except the
reference-image upload (multipart).

| Route | Body → Response |
| --- | --- |
| `GET /api/projects` | → summary[]: `{id, author, title, date, tags, suno_done, scenes_ready, scenes_total}` |
| `POST /api/projects` | `{url, raw_text}` → full project (201). `raw_text` wins if both are set; a `url` goes through `url_parser` |
| `GET /api/projects/{id}` | → full project |
| `PATCH /api/projects/{id}` | Partial project (the frontend sends the **whole** object) → full project |
| `DELETE /api/projects/{id}` | → 204 |
| `GET /api/settings` / `PUT /api/settings` | Settings dict (merged over defaults) |
| `GET /api/settings/models/{provider}` | `provider` = `google\|openrouter\|deepseek\|replicate\|fal` → `{provider, source: 'live'\|'curated'\|'error', models: [{id, name}], error?}`. Google/OpenRouter/DeepSeek query the provider's real API with the stored key; Replicate/FAL always return the curated fallback (see `code-map.md`). A non-`error` result is also upserted into the persisted model catalog (`app_data/model_catalog.json`) |
| `GET /api/settings/image-models/{provider}` | Same shape as `/settings/models/{provider}`, plus `krea` as a valid `provider` (image/video-only, not accepted by `/settings/models/`) — Google queries the same "list models" endpoint filtered to `predict`-capable (Imagen) models; Replicate/FAL/OpenRouter/DeepSeek/Krea return a curated fallback ([`providers/image_models.py`](../backend/app/providers/image_models.py)). Also upserted into the persisted model catalog |
| `GET /api/settings/models-catalog` | → `{text: {provider: {...}}, image: {provider: {...}}}` — the persisted last-known-good result of every `.../models/{provider}` and `.../image-models/{provider}` call so far this install (`storage.load_model_catalog()`), so the Settings "Models"/"Prices" tabs have something to show before "Refresh models" is pressed in the current session |
| `POST /api/settings/wish-library` | `{text, model?}` → `{suno_wish_library, wish}`. One `clean_wish_and_title` call (via `model` if given — a `"{provider}:{model_id}"` composite applied to a throwaway settings copy so it never overwrites `simple_models.default` — else the configured simple model) produces both `wish.text` (cleaned) and `wish.title`; no configured model degrades to `text` unchanged + a truncate-fallback title; appends, persists |
| `PATCH /api/settings/wish-library/{id}` | `{title?, text?}` → `{suno_wish_library, wish}`. Manual edit of an existing wish's title and/or text (either field, or both); no LLM call, so no usage tracking; `404` if `id` is unknown, `422` if a given field is blank |
| `POST /api/projects/{id}/suno/generate` | `{skill_id, skill_prompt, model, active_wish_ids?}` → `{style, lyrics, skill_id, model_used, debug}`. `model` is the `"{provider}:{model_id}"` composite — the Suno stage seeds it from `settings.text_models.default` but lets the user override it per-call via the `ModelPicker` next to "Сгенерировать промпт"/"Generate prompt"; `active_wish_ids` (falls back to the project's own field if omitted) is resolved against `settings.suno_wish_library` and sent as an emphasized, numbered "ВАЖНЫЕ ТРЕБОВАНИЯ ПОЛЬЗОВАТЕЛЯ" block right after the base prompt; `provider ∈ google\|openrouter\|deepseek` + a matching key calls that provider's real chat API; a failed call returns `502` instead of falling back. `debug` is either `{stub: false, request, response, missing_markers}` (real call — `missing_markers` true if the reply didn't follow the `===STYLE===`/`===LYRICS===` format) or `{stub: true, reason: no_model_selected\|unsupported_provider\|no_api_key, requested_model}` — shown in the Suno stage's debug panel, which auto-expands whenever either flag needs attention |
| `POST /api/projects/{id}/suno/wishes` | `{text}` → `{wish, suno_wish_library, active_wish_ids}`. Cleans+titles `text` via `wish_library.add_or_get_wish` (reuses an existing card with the same text instead of duplicating it), then immediately activates that wish's id for this project — the "Применить" button on the Suno stage's "Доработка через AI-пожелание" section. Replaces the old `suno/refine`, which instead folded the wish into `skill_prompt` and only kept a read-only history |
| `POST /api/projects/{id}/scenes/generate` | `{style_description, model?}` → `{scenes, style_description}` — **replaces all scenes**, clearing their images. `model` (from `settings.text_models`) is accepted and forwarded to the provider seam but not yet used - `scenes.py` is still a non-AI stub (see `architecture.md`) |
| `POST /api/projects/{id}/scenes/{n}/images` | `{count, model}` → `{job_ids}` — starts one background generation job per requested variant (`model` = `"{provider}:{model_id}"` from `settings.image_models`, provider ∈ `krea\|replicate\|fal\|google`) and returns immediately; poll each job below. A finished job appends its image to `scenes[n].images` on its own, independent of polling |
| `GET /api/projects/{id}/scenes/{n}/images/jobs/{job_id}` | → `{status: 'pending'\|'completed'\|'failed', image: Image\|null, error: str\|null}` — polled every 1.5s by the frontend (`useScenesStage.js`); job state is in-memory only (see `architecture.md`) |
| `POST /api/projects/{id}/reference-images` | multipart `file` → `{reference_images}` |
| `DELETE /api/projects/{id}/reference-images/{filename}` | → `{reference_images}` |
| `GET /media/<path>` | Static passthrough over `app_data/`; build URLs with `mediaUrl()` in `api/client.js` |
| `GET /api/usage/records` | Filters `project_id\|task\|provider\|model\|status\|date_from\|date_to\|limit\|offset` → `{records, total, limit, offset, totals}` |
| `GET /api/usage/summary` | Same filters + `group_by ∈ project\|task\|model\|provider\|day`, `tz_offset` → `{group_by, currency, groups[], totals}` |
| `GET /api/usage/today` | `tz_offset` → `{date, cost, currency, calls, unknown_cost_calls}` |
| `GET /api/usage/period-totals` | `tz_offset` → `{currency, today, week, month, total}` — each a `{calls, errors, cost, unknown_cost_calls}` totals object; backs the header cost pill's expanded view |
| `GET /api/usage/pricing` / `PUT /api/usage/pricing` | Merged price catalog `{pricing_version, currency, models[], overrides}` / body `{pricing_overrides}`, `422` on an invalid row. `models[]` also includes an unpriced row (`input`/`output`/`per_image: null`, `source: 'catalog'`) for every model in the persisted model catalog that isn't priced yet - so the Prices tab lists everything the Models tab has ever seen |

Every generation route persists its result onto the project before returning,
so the client never has to `PATCH` afterwards — except the scene-images job
route, which returns `job_ids` immediately and persists each image
asynchronously when its background job completes (see `architecture.md`).
