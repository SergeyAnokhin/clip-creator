# Data model & API

Everything is JSON on disk under `app_data/` (git-ignored, override the root
with the `APP_DATA_DIR` env var). No database, no migrations — a project file
is whatever shape `storage.save_project` last wrote.

```text
app_data/
  settings.json
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
| `skill_id`, `skill_prompt` | str | Active Suno skill and its (editable) prompt |
| `refinement_comments` | str[] | Raw "AI-wish" history |
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
  (see below); `simple_models.default` is used for lightweight tasks —
  currently only wish-library title generation
  ([`providers/text_models.py`](../backend/app/providers/text_models.py)
  `generate_wish_title`); `image_models.default`/`.favorites` populate the
  image-model picker in Settings ([`providers/image_models.py`](../backend/app/providers/image_models.py))
  and the per-generation `ModelPicker` in `ScenesStage.jsx`, whose composite
  is what `providers/images.py` actually dispatches to a real provider call
  (see `architecture.md`).
- `suno_base_prompt` — the general "how to adapt for Suno" instructions, sent
  on every `suno/generate` call that uses Gemini.
- `suno_reference_examples` — curated example style+lyrics blocks, sent
  alongside the base prompt as "reference, don't copy verbatim" material.
- `suno_wish_library` — saved wish snippets for reuse across projects
  (distinct from a project's own `refinement_comments` history), each
  `{id, title, text, created_at}`. `title` is generated once, on save, by
  `generate_wish_title` (real LLM call if `simple_models.default` points at
  Google/OpenRouter/DeepSeek with a key configured, otherwise a local
  truncate of `text`). Legacy plain-string entries are normalized to this shape on
  `GET /api/settings` (not rewritten to disk until the next save).
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
| `GET /api/settings/models/{provider}` | `provider` = `google\|openrouter\|deepseek\|replicate\|fal` → `{provider, source: 'live'\|'curated'\|'error', models: [{id, name}], error?}`. Google/OpenRouter/DeepSeek query the provider's real API with the stored key; Replicate/FAL always return the curated fallback (see `code-map.md`) |
| `GET /api/settings/image-models/{provider}` | Same shape as `/settings/models/{provider}`, plus `krea` as a valid `provider` (image/video-only, not accepted by `/settings/models/`) — Google queries the same "list models" endpoint filtered to `predict`-capable (Imagen) models; Replicate/FAL/OpenRouter/DeepSeek/Krea return a curated fallback ([`providers/image_models.py`](../backend/app/providers/image_models.py)) |
| `POST /api/settings/wish-library` | `{text, model?}` → `{suno_wish_library, wish}`. Generates `wish.title` via `model` if given (a `"{provider}:{model_id}"` composite, applied to a throwaway settings copy so it never overwrites `simple_models.default`), else the configured simple model, else a truncate fallback; appends, persists |
| `POST /api/projects/{id}/suno/generate` | `{skill_id, skill_prompt, model}` → `{style, lyrics, skill_id, model_used}`. `model` is the `"{provider}:{model_id}"` composite from `settings.text_models.default`; `provider == 'google'` + a Google key calls the real Gemini API; a failed call returns `502` instead of falling back |
| `POST /api/projects/{id}/suno/refine` | `{comment}` → `{skill_prompt, refinement_comments}` |
| `POST /api/projects/{id}/scenes/generate` | `{style_description, model?}` → `{scenes, style_description}` — **replaces all scenes**, clearing their images. `model` (from `settings.text_models`) is accepted and forwarded to the provider seam but not yet used - `scenes.py` is still a non-AI stub (see `architecture.md`) |
| `POST /api/projects/{id}/scenes/{n}/images` | `{count, model}` → `{job_ids}` — starts one background generation job per requested variant (`model` = `"{provider}:{model_id}"` from `settings.image_models`, provider ∈ `krea\|replicate\|fal\|google`) and returns immediately; poll each job below. A finished job appends its image to `scenes[n].images` on its own, independent of polling |
| `GET /api/projects/{id}/scenes/{n}/images/jobs/{job_id}` | → `{status: 'pending'\|'completed'\|'failed', image: Image\|null, error: str\|null}` — polled every 1.5s by the frontend (`useScenesStage.js`); job state is in-memory only (see `architecture.md`) |
| `POST /api/projects/{id}/reference-images` | multipart `file` → `{reference_images}` |
| `DELETE /api/projects/{id}/reference-images/{filename}` | → `{reference_images}` |
| `GET /media/<path>` | Static passthrough over `app_data/`; build URLs with `mediaUrl()` in `api/client.js` |
| `GET /api/usage/records` | Filters `project_id\|task\|provider\|model\|status\|date_from\|date_to\|limit\|offset` → `{records, total, limit, offset, totals}` |
| `GET /api/usage/summary` | Same filters + `group_by ∈ project\|task\|model\|provider\|day`, `tz_offset` → `{group_by, currency, groups[], totals}` |
| `GET /api/usage/today` | `tz_offset` → `{date, cost, currency, calls, unknown_cost_calls}` |
| `GET /api/usage/pricing` / `PUT /api/usage/pricing` | Merged price catalog `{pricing_version, currency, models[], overrides}` / body `{pricing_overrides}`, `422` on an invalid row |

Every generation route persists its result onto the project before returning,
so the client never has to `PATCH` afterwards — except the scene-images job
route, which returns `job_ids` immediately and persists each image
asynchronously when its background job completes (see `architecture.md`).
