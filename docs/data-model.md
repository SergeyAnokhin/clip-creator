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
      images/scene_{n}_var_{m}.svg
      references/ref_{uuid}.{ext}
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
`file_path` is relative to the project folder (`images/scene_1_var_1.svg`),
`rating` 0-5, exactly one `is_selected` per scene once anything is rated.

## Settings (`settings.json`)

`{lang, api_keys{openai,anthropic,deepseek,replicate}, text_model_default,
image_model_default, special_tags[]}`. Reads and writes merge over
`DEFAULT_SETTINGS` in
[`routers/settings.py`](../backend/app/routers/settings.py), so adding a key
there is enough — existing files keep loading.

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
| `POST /api/projects/{id}/suno/generate` | `{skill_id, skill_prompt, model}` → `{style, lyrics, skill_id, model_used}` |
| `POST /api/projects/{id}/suno/refine` | `{comment}` → `{skill_prompt, refinement_comments}` |
| `POST /api/projects/{id}/scenes/generate` | `{style_description}` → `{scenes, style_description}` — **replaces all scenes**, clearing their images |
| `POST /api/projects/{id}/scenes/{n}/images` | `{count, model}` → `{images}` — appends variants, never deletes |
| `POST /api/projects/{id}/reference-images` | multipart `file` → `{reference_images}` |
| `DELETE /api/projects/{id}/reference-images/{filename}` | → `{reference_images}` |
| `GET /media/<path>` | Static passthrough over `app_data/`; build URLs with `mediaUrl()` in `api/client.js` |

Every generation route persists its result onto the project before returning,
so the client never has to `PATCH` afterwards.
