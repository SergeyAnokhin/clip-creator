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
      titlecard/{shorthex}.{png|jpg|webp}
      titlecard/posters/{shorthex}.png   # Poster constructor output (flattened)
      music/{track_id}.mp3               # Mureka-generated tracks, downloaded immediately (see below)
      music/references/ref_{uuid}.{ext}  # user-uploaded reference audio (mp3/m4a)
  logos/logo_{shorthex}.{png|webp}       # global, cross-project - see settings.logos
  usage/
    YYYY-MM.jsonl             # append-only AI-call ledger, one JSON object per line
```

## Project (`config.json`)

| Field | Type | Notes |
| --- | --- | --- |
| `id` | str | = folder slug; collisions get `-2`, `-3`, … |
| `author`, `title` | str | Fall back to `"Неизвестный автор"` / `"Новое стихотворение"`. Editing these later does **not** rename the folder/`id` — the slug is fixed at creation time, so a project's folder name and its current `author`/`title` can legitimately diverge (don't assume the folder name reflects current content when navigating `app_data/projects/` by hand) |
| `created_at`, `updated_at` | str | ISO-8601 `…Z`; `updated_at` refreshed on every write |
| `tags` | str[] | Home-screen chips only |
| `blocks` | Block[] | Source of truth for the lyrics builder |
| `skill_id`, `skill_prompt` | str | Active Suno skill and its (freely editable) "Дополнения к промпту" text — always sent last in the assembled prompt, after the base prompt and any active wishes |
| `active_wish_ids` | str[] | Ids of `settings.suno_wish_library` entries currently toggled on for this project (see below) — resolved to their `text` and sent as an emphasized block on `suno/generate` |
| `refinement_comments` | str[] | Unused — kept only for backward compatibility with old `config.json` files. Was the "AI-wish" history under the old `suno/refine` flow (removed); always `[]` on projects created or migrated since |
| `style`, `lyrics` | str | Suno output; `style` non-empty ⇒ `suno_done` in the list view |
| `model_used` | str | Text model used for the last generation |
| `track_url` | str | User-pasted Suno track link |
| `style_description` | str | Free-text visual style, sent to `scenes.generate` (edited on the Scenes stage) |
| `scene_mode` | str | `narrative`\|`abstract` — which `scene_base_prompt_*` the last `scenes/generate` call used; defaults to `narrative` |
| `active_scene_wish_ids` | str[] | Ids of `settings.scene_wish_library` entries toggled on for this project — same idea as `active_wish_ids`, separate library (scene/imagery wishes vs. music/lyrics ones) |
| `reference_images` | str[] | Paths relative to `app_data/`, e.g. `projects/<slug>/references/ref_ab12cd34.png` |
| `scenes` | Scene[] | `[]` until the storyboard is generated |
| `source_url` | str | Original URL, if the project came from one |
| `title_card` | TitleCard \| absent | Title Card stage state — absent on projects that predate this stage; the frontend and every backend read site default it to `{reference_image_paths: [], variants: [], posters: []}` (`text_block` is seeded lazily on first stage visit, see below) |
| `active_title_card_wish_ids` | str[] | Ids of `settings.title_card_wish_library` entries toggled on for this project — same idea as `active_scene_wish_ids`, separate library (poster wishes vs. scene/imagery ones) |
| `mureka` | Mureka \| absent | Real audio generation via the Mureka API (distinct from `style`/`lyrics` above, which are just text) — absent until the stage is first opened, defaults to `{style_input: '', lyrics_input: '', reference_audio: [], tracks: []}` |

**Block**: `{id, type, importance, content}` — `type` is
`intro|verse|chorus|bridge|outro|interlude`; `content` is plain multi-line text.
`interlude` blocks hold a Suno meta-tag (e.g. `[Vocal Interlude]`) and render as
a compact single-line card. `importance` (1-5) is **dead** — still written for
backward compatibility, never read or edited.

**Scene**: `{lyric_segment, static_prompt, motion_prompt, images[]}`.

**Image**: `{image_id, file_path, rating, is_selected, generated_at, model,
aspect_ratio, cost, source_image_id?}` — `file_path` is relative to the
project folder (`images/scene_1_a1b2c3d4.png`; extension depends on the
provider - `png`/`jpg`/`webp`), `rating` 0-5, exactly one `is_selected` per
scene once anything is rated. `model` is `'upload'` for a user-uploaded
image, `'local:crop'` for a plain (no outpainting) crop, or the usual
`{provider}:{model_id}` composite otherwise (`fal:fal-ai/flux-2-pro/outpaint`
for an outpainted crop). `source_image_id` is only present on a crop/outpaint
result (`images.crop_image` — see the API table below): it points at the
original image's `image_id`, and the original is left untouched — cropping
always **appends** a new image, mirroring `TitleCardVariant.source_variant_id`
below.

**TitleCard**: `{text_block, reference_image_paths, variants, posters}` — `text_block`
is one free-text field the user edits directly (not separate title/author
inputs the server wraps in quotes), lazily seeded to `'"Заголовок"\n"Автор"'`
the first time the stage loads for a project (`useTitleCardStage.js`'s
`resetForProject`, only if the key is `undefined`, so a later intentional
clear-to-`''` sticks). It's appended to the assembled prompt verbatim
(`title_card._build_prompt`). `reference_image_paths` is up to 4 paths
(relative to the project folder) picked from `scenes[].images[].file_path` or
`reference_images`, persisted so the picks survive a reload.
**TitleCardVariant**: `{variant_id, file_path, rating, is_selected,
generated_at, model, aspect_ratio, cost, text_block, base_prompt,
reference_image_paths, source_variant_id?}` — same `rating`/`is_selected`/
`model`/`aspect_ratio`/`cost` shape as `Image` (`file_path` under
`titlecard/` instead of `images/`), plus a snapshot of the text/prompt/
references that produced it. `variants` is append-only; deleting one removes
it from this array and unlinks its file. `source_variant_id` is only present
on a "remove background" result (`title_card.remove_background` — see the API
table below): it points at the original variant's `variant_id`, and the
original is left untouched — background removal always **appends** a new
variant rather than replacing one.

**Poster**: `{poster_id, file_path, background_path, title_card_variant_id,
logo_id, canvas_size{width,height}, layers{title_card[{id,x,y,scaleX,scaleY,rotation,crop,effects}],
logo[{...}]|null, glass{x,y,width,height,scaleX,scaleY,rotation,cornerRadius,opacity,thickness}|null,
text[{id,x,y,scaleX,scaleY,rotation,textType,text,fontFamily,fontSize,color,bgColor,effects}]},
rating, is_selected, generated_at}` — the Poster
constructor's output: `background_path` (a scene/reference image path,
same shape as `TitleCard.reference_image_paths` entries) and
`title_card_variant_id` (points into `variants[]`) are the two source
layers, `logo_id` optionally points into the global `settings.logos[]`;
`file_path` is the flattened PNG (composited client-side, see
`architecture.md`'s "Poster constructor"), `layers` the per-layer
drag/scale/rotate transform, kept so `PosterConstructor.jsx` can reopen and
re-edit the exact same arrangement. `posters` is append-only like `variants`
except re-saving with an existing `poster_id` updates that entry in place
(new flattened PNG, same id/file path) instead of appending.

`title_card` and `logo` are **arrays**, not single objects — the same
source image (the chosen title-card variant, or the chosen logo) can appear
as several independent layers, each with its own transform/crop/effects,
via `PosterConstructor.jsx`'s "Дублировать" (duplicate) button. `crop` is
`{x,y,width,height}` in the source image's natural pixel space, or `null`
for the full image — how a single title-card render (e.g. headline + author
baked into one PNG) gets split into independently-movable pieces (crop one
duplicate to the headline, another to the author line). Older saved posters
stored a single transform object here instead of an array; the frontend
wraps it into a one-item array on load (`normalizeLayers` in
`PosterConstructor.jsx`), so both shapes still open correctly.

Each layer's `effects` is opaque to the backend (stored and round-tripped
as-is, no schema validation) — `PosterConstructor.jsx` currently writes
`{glow{enabled,color,blur,distance,opacity}, clone{enabled,offsetX,offsetY,opacity,blur}, opacity}`,
`glow` rendered client-side as a Konva shadow on the overlay's own alpha
shape, `clone` an offset second copy of the same layer rendered behind the
real one (a cheap fake-depth "double object" look; it renders with the same
`glow` as the real layer, plus its own `opacity` and an optional `blur` -
Konva filter, needs `.cache()` - that only ever applies to this back copy),
and `opacity` applied directly to the image; all are baked into the
flattened PNG at save time, same as position/scale/rotation/crop.
`glow.opacity` is stored 0-5 (the constructor's intensity slider shows it as
0-100%, i.e. `glow.opacity/5*100` - a single Konva shadow pass caps its
visible strength once `shadowOpacity` reaches ~1, so values above the old
1.0/100% ceiling render as several stacked shadow passes instead of one,
see `glowPasses` in `PosterConstructor.jsx`). (An earlier `backdrop` effect
— a feathered filled `Rect` behind the image — was dropped in favor of the
plain `opacity` control; old saved posters with a `backdrop` key simply
lose that effect on next load, no migration.)

Unlike `title_card`/`logo`, `glass` is not tied to a picked source image —
it's a standalone decorative rounded-rect panel (a simulated "frosted glass"
look), limited to one instance, and also opaque/unvalidated on the backend.

`text` is an array of freely-editable text layers (also opaque/unvalidated on
the backend, added client-side after both title-card variants and posters
already existed, so older saved posters simply have no `text` key —
`normalizeTextLayers` in `PosterConstructor.jsx` treats a missing/non-array
value as `[]`). `textType` is `'badge'` (a black rounded-pill background with
white text, defaults to the author line) or `'halo'` (bare text with a
drop-shadow "halo" effect reusing the `effects.glow` shape below, defaults to
the title line) — both default from `title_card.text_block`'s two quoted
lines (title / author), parsed by `parseTextBlock`. `fontFamily` is one of
`PosterConstructor.jsx`'s `FONT_OPTIONS` (Forum, Montserrat, PT Sans, Lato,
Oswald, Roboto Condensed, Rubik, Playfair Display — all verified to include
cyrillic glyphs except Lato, kept only for latin text since poster text is
typically Russian). `fontSize`/`color` and, for `badge`, `bgColor` are plain
per-layer style fields; `align` is `'left'\|'center'\|'right'` (defaults to
`'left'` on any older layer missing the key); `effects` reuses the exact
same `{glow{...}, clone{...}, opacity}` shape as `title_card`/`logo` layers.

**Mureka**: `{style_input, lyrics_input, reference_audio[], tracks[]}` — the
Mureka stage's own state, seeded once (lazily, only if `style_input`/
`lyrics_input` are `undefined`) from the project's `style`/`lyrics` the first
time the stage loads (`useMurekaStage.js`'s `resetForProject`), then freely
editable independent of the Suno-stage originals — this is literally what
gets sent to Mureka's `song/generate`, so it doubles as the "what goes to the
model" preview the stage shows. `reference_audio` is
`[{id, mureka_file_id, file_path, filename, uploaded_at}]` — `file_path` a
local copy under `music/references/`, `mureka_file_id` the id Mureka's
`files/upload` returned for it (usable as `reference_id` on a generate call).
`tracks` is append-only, one entry per generated song:

**MurekaTrack**: `{track_id, task_id, choice_index, file_path, duration_ms,
model, style, lyrics, params{n, gender, reference_id}, rating, is_selected,
tag_ids[], generated_at, raw}` — `file_path` under `music/` (always `.mp3`,
downloaded immediately since Mureka's own `url` expires after 30 days).
`style`/`lyrics`/`params` are a snapshot of exactly what was sent for this
track (a "regenerate 3 tracks" call can produce several `MurekaTrack`s from
one task, one per `choices[]` entry — `choice_index` is that entry's index).
`rating` (0-5) and `is_selected` mirror `Image`'s shape, but **`is_selected`
is set only by an explicit user action** (`PATCH /api/projects/{id}` with a
recomputed `tracks` array — see the API table below) — unlike `Image`, it is
never auto-promoted from the highest rating; this stage treats "sounds good"
(rating) and "this is the one I'll use" (`is_selected`) as independent
judgments. `tag_ids` references `settings.music_tags` entries (see below).
`raw` is the untouched `choices[]` entry Mureka returned (`url`/`flac_url`/
`wav_url`/`lyrics_sections`) — kept for reference even though only the plain
MP3 is downloaded to disk.

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

`{id, ts, task, project_id, provider, model_id, model, status, duration_ms, units{kind,input_tokens,output_tokens,reasoning_tokens,cached_input_tokens,total_tokens,images,compute_seconds}, cost{amount,currency,source,pricing_version,saved_amount?}, prompt_preview, response_preview, prompt_chars, response_chars, error, meta}`

`task` is one of `suno_generate|wish_title|scene_storyboard|scene_image|title_card|title_card_bg_remove|translate`.
`cost.amount` is `null` (never `0`) when the price or usage units needed to
compute it are unknown; `cost.source` is `provider|catalog|free|unknown`. A
`google_free` call always resolves to `amount: 0`/`source: 'free'` (it's a
free-tier API key, not a discount) — `cost.saved_amount` carries what the
same call would have cost on the paid `google` catalog price, so it's visible
without polluting any spend total. See [usage-tracking.md](usage-tracking.md).

## Settings (`settings.json`)

`{lang, api_keys{replicate,google,google_free,fal,openrouter,deepseek,krea,google_translate,mureka}, text_models{favorites[],default},
simple_models{favorites[],default}, image_models{favorites[],default}, image_models_simple{favorites[],default},
special_tags[], suno_base_prompt, suno_reference_examples[], suno_wish_library[],
scene_base_prompt_narrative, scene_base_prompt_abstract, scene_wish_library[], pricing_overrides{},
request_timeout_seconds, hide_motion_prompt, title_card_base_prompt, title_card_base_prompt_presets[],
title_card_wish_library[], background_remover_method, background_remover_local_params{bg,threshold},
background_remover_fal_params{model}, background_remover_params{background_type,format,threshold,reverse},
outpaint_quality_mode, logos[], poster_templates[], music_tags[]}`.
The Title Card stage's "remove background" button offers 3 interchangeable methods (see `architecture.md`),
each with its own param group here (Settings → Providers): `background_remover_method` is which one the
button defaults to when no `method` is passed per-call (`'local'\|'fal'\|'replicate'`, default `'replicate'`);
`background_remover_local_params` (`bg`: `'black'\|'white'`, `threshold`: 0-255) feeds the free pixel-threshold
cutout; `background_remover_fal_params.model` picks between FAL's `fal-ai/bria/background/remove` and
`fal-ai/imageutils/rembg`; `background_remover_params` feeds Replicate's `851-labs/background-remover`'s input
directly (defaults match the model's own schema defaults). `outpaint_quality_mode`
(`'fast'\|'quality'`, default `'fast'`) is the default for the Images stage's crop/outpaint
editor's fast-vs-quality toggle (see `architecture.md`'s "Crop/outpaint editor" section) —
overridable per-save in the editor itself, same shape as `background_remover_method` above.
`logos` is `[{id, name, file_path}]` — the global,
cross-project logo library for the Poster constructor (Settings → Logos;
`POST/DELETE /api/settings/logos[/{id}]`, files under `app_data/logos/`).
`poster_templates` is `[{id, name, layers{logo_id, logo[], glass, text[]}, created_at}]`
— reusable poster layouts saved from the constructor ("Сохранить как
шаблон"/"Save as template"), global like `logos` but plain-array CRUD'd
through the regular partial-merge `PUT` (no dedicated endpoint, same
pattern as `title_card_base_prompt_presets`). `layers` deliberately omits
`background_path`/`title_card_variant_id`/`title_card` layers - those are
specific to the poem the poster was originally built for; applying a
template only restores the logo, glass panel, and text layers (with fresh
ids) onto whatever background/title-card is already picked. `google_free` is a second Google Gemini API key (see `architecture.md`'s
provider-seams section) - same models/calls as `google`, but always priced at `$0`/`source: 'free'`
in the usage ledger (see [usage-tracking.md](usage-tracking.md)) since it's a free-tier key, not a
discount. Reads and
writes merge over `DEFAULT_SETTINGS` in
[`routers/settings.py`](../backend/app/routers/settings.py) (seed text for
`suno_base_prompt`/`suno_reference_examples` comes from
[`providers/suno_prompt_defaults.py`](../backend/app/providers/suno_prompt_defaults.py)),
so adding a key there is enough — existing files keep loading. `PUT` is a
partial merge server-side, so the frontend can persist e.g. just
`{suno_wish_library}` without resending the whole settings object.

- `text_models` / `simple_models` / `image_models` / `image_models_simple` —
  same shape: `favorites` is `{provider, id, label}[]`; `default` is a
  composite `"{provider}:{id}"` string (e.g. `"google:gemini-2.5-flash"`).
  `text_models`/`simple_models` only accept `provider`
  `google|google_free|openrouter|deepseek|replicate|fal`; `image_models`/`image_models_simple`
  additionally accept `krea` (Krea AI is image/video-only, so it's excluded
  from the text-model provider set — see `_IMAGE_MODEL_PROVIDERS` vs
  `_MODEL_PROVIDERS` in `routers/settings.py`). `text_models.default` is
  what `suno.generate`/`scenes.generate` parse to decide whether to call a
  real chat API (see below); `simple_models.default` is used for lightweight
  tasks — in one call, tidying up the user's free-text "AI-wish" and
  generating its emoji-prefixed title when it's saved to `suno_wish_library`
  ([`providers/text_models.py`](../backend/app/providers/text_models.py)
  `clean_wish_and_title`, wrapped by
  [`providers/wish_library.py`](../backend/app/providers/wish_library.py)
  `add_or_get_wish`) — there is deliberately **no** per-call model picker for
  this on the Suno stage, only the one global default in Settings;
  `image_models`/`image_models_simple` are a quality/cheap tier pair — both
  populate their own favorites panel in Settings
  ([`providers/image_models.py`](../backend/app/providers/image_models.py))
  and the per-generation `ModelPicker` in `ImagesStage.jsx` (a tier toggle
  picks which list feeds it), whose composite is what `providers/images.py`
  actually dispatches to a real provider call (see `architecture.md`).
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
  `{id, title, text, created_at, use_count?}`. `use_count` is bumped by
  `useSettings.js`'s `bumpWishUse` every time the wish is toggled *on* on the
  Suno stage (client-side, via the regular partial `PUT /api/settings` — no
  dedicated route) and drives the chip list's display order
  (`lib/wishes.js`'s `sortByUseCount`, most-used first; missing/`0` sorts
  last). A chip's "×" (`removeWishSnippet`) deletes the wish outright, same
  partial-`PUT` mechanism. `text` and `title` are both produced in a
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
- `scene_base_prompt_narrative` / `scene_base_prompt_abstract` — the general
  "how to turn this text into a scene image prompt" instructions, one per
  `scene_mode`, sent on every real (non-stub) `scenes/generate` call (see
  "The scene prompt" in `architecture.md`). Seeded from
  [`providers/scenes_prompt_defaults.py`](../backend/app/providers/scenes_prompt_defaults.py).
  No presets-to-load endpoint like Suno's — each is directly edited in
  Settings or in the compact panel on the Scenes stage itself.
- `scene_wish_library` — global, reusable scene/imagery wish "cards", same
  `{id, title, text, created_at, use_count?}` shape (incl. the same
  `use_count`/sort-by-popularity/delete-via-partial-`PUT` behaviour as
  `suno_wish_library` above, via `bumpSceneWishUse`/`removeSceneWishSnippet`)
  and `clean_wish_and_title` flow as `suno_wish_library`, but a **separate**
  list (`wish_library.add_or_get_wish`'s `library_key` parameter picks which
  one) — scene wishes ("больше драмы", "зимняя атмосфера") are a different
  domain from music/lyrics wishes. Each project toggles a subset on via its
  own `active_scene_wish_ids` (see above).
- `request_timeout_seconds` — how long (seconds) a single outbound call to a
  text-model provider may run before being treated as a timeout; read by
  `suno.py`'s `_generate_via_*`, `scenes.py`'s `_generate_via_*` and
  `text_models.py`'s `_complete_*`. Defaults to `60` when unset. Edited from
  Settings → General.
- `hide_motion_prompt` — UI-only preference shared by the Scenes and Images
  stages: hides every `motion_prompt` field/label (and its translate button)
  when set, leaving only the static image prompt. Doesn't touch any scene's
  actual `motion_prompt` value — purely what's rendered. Toggled from a chip
  on either stage (`ScenesStage.jsx`/`ImagesStage.jsx`), autosaves immediately
  via `useSettings.js`'s `setHideMotionPrompt` (same one-boolean-flip pattern
  as everything else that isn't a debounced text field).
- `title_card_base_prompt` — the general "render this text in the reference
  images' style" instructions for the Title Card stage, sent ahead of the
  active-wishes block and the stage's free-text `text_block` on every
  `title-card/generate` call. Seeded from
  [`providers/title_card_prompt_defaults.py`](../backend/app/providers/title_card_prompt_defaults.py),
  editable in the stage's own collapsible panel (autosaves like
  `updateSunoBasePrompt`).
- `title_card_base_prompt_presets` — unlike Suno's read-only
  `suno-prompt-presets` endpoint, this is a **user-managed** list of named
  variants of the base prompt, `{id, name, prompt}[]`, seeded by default with
  3 built-ins from `title_card_prompt_defaults.TITLE_CARD_BASE_PROMPT_PRESETS`
  (2 user-supplied "black background lettering" style prompts + this app's own
  default). Saved/loaded/deleted entirely client-side (`useSettings.js`'s
  `saveTitleCardBasePromptPreset` / `loadTitleCardBasePromptPreset` /
  `deleteTitleCardBasePromptPreset`) against the regular partial-merge `PUT
  /api/settings` — no dedicated endpoints, unlike
  `suno_wish_library`/`scene_wish_library`/`title_card_wish_library` which get
  their own routes because saving those also involves an LLM clean+title call.
- `title_card_wish_library` — global, reusable poster-generation wish "cards",
  same `{id, title, text, created_at, use_count?}` shape and
  `clean_wish_and_title` flow as `suno_wish_library`/`scene_wish_library`
  (incl. the same `use_count` popularity sort), but its own separate list
  (`wish_library.add_or_get_wish`'s `library_key='title_card_wish_library'`).
  Each project toggles a subset on via its own `active_title_card_wish_ids`
  (see above); resolved wish texts are folded into the prompt ahead of the
  stage's `text_block` (`title_card._build_prompt`). Unlike the other two
  libraries, it isn't surfaced in `SettingsScreen.jsx` at all (only inline on
  the Title Card stage), so its delete action (`removeTitleCardWishSnippet`)
  lives in `useSettings.js` but is only wired up from `TitleCardStage.jsx`.
- `pricing_overrides` — user-supplied AI price corrections, keyed by
  `"{provider}:{model_id}"` (or `"{provider}:*"` as a whole-provider
  wildcard), same row shape as `pricing.BUILTIN_PRICING` (see
  [usage-tracking.md](usage-tracking.md)). Saved via its own
  `PUT /api/usage/pricing`, not the general settings `PUT` — **not** included
  in the Settings screen's backup export/import.
- `music_tags` — user-defined quality-review labels for Mureka tracks,
  `{id, label}[]`, global (cross-project) and plain-array CRUD'd through the
  regular partial-merge `PUT` (`useSettings.js`'s `addMusicTag`/
  `removeMusicTag`/`updateMusicTag`, same pattern as `poster_templates` — no
  dedicated endpoint, no LLM call). Assigned to a track via its `tag_ids`
  (see `MurekaTrack` above); edited from Settings → Музыкальные промпты
  ("Теги для оценки треков"), same inline add/edit/delete UI as `special_tags`.
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

Base `http://localhost:8020`. All request/response bodies are JSON except the
reference-image upload (multipart).

| Route | Body → Response |
| --- | --- |
| `GET /api/projects` | → summary[]: `{id, author, title, date, tags, suno_done, scenes_ready, scenes_total}` |
| `POST /api/projects` | `{url, raw_text}` → full project (201). `raw_text` wins if both are set; a `url` goes through `url_parser` |
| `GET /api/projects/{id}` | → full project |
| `PATCH /api/projects/{id}` | Partial project (the frontend sends the **whole** object) → full project |
| `DELETE /api/projects/{id}` | → 204 |
| `GET /api/settings` / `PUT /api/settings` | Settings dict (merged over defaults) |
| `GET /api/settings/models/{provider}` | `provider` = `google\|google_free\|openrouter\|deepseek\|replicate\|fal` → `{provider, source: 'live'\|'curated'\|'error', models: [{id, name}], error?}`. Google/`google_free`/OpenRouter/DeepSeek query the provider's real API with the stored key (`google_free` hits the same Gemini endpoint as `google`, just with its own key); Replicate/FAL always return the curated fallback (see `code-map.md`). A non-`error` result is also upserted into the persisted model catalog (`app_data/model_catalog.json`) |
| `GET /api/settings/image-models/{provider}` | Same shape as `/settings/models/{provider}`, plus `krea` as a valid `provider` (image/video-only, not accepted by `/settings/models/`) — Google queries the same "list models" endpoint filtered to `predict`-capable (Imagen) models; Replicate/FAL/OpenRouter/DeepSeek/Krea return a curated fallback ([`providers/image_models.py`](../backend/app/providers/image_models.py)). Also upserted into the persisted model catalog |
| `GET /api/settings/models-catalog` | → `{text: {provider: {...}}, image: {provider: {...}}}` — the persisted last-known-good result of every `.../models/{provider}` and `.../image-models/{provider}` call so far this install (`storage.load_model_catalog()`), so the Settings "Models"/"Prices" tabs have something to show before "Refresh models" is pressed in the current session |
| `POST /api/settings/wish-library` | `{text, model?}` → `{suno_wish_library, wish}`. One `clean_wish_and_title` call (via `model` if given — a `"{provider}:{model_id}"` composite applied to a throwaway settings copy so it never overwrites `simple_models.default` — else the configured simple model) produces both `wish.text` (cleaned) and `wish.title`; no configured model degrades to `text` unchanged + a truncate-fallback title; appends, persists |
| `PATCH /api/settings/wish-library/{id}` | `{title?, text?}` → `{suno_wish_library, wish}`. Manual edit of an existing wish's title and/or text (either field, or both); no LLM call, so no usage tracking; `404` if `id` is unknown, `422` if a given field is blank |
| `POST /api/settings/scene-wish-library` / `PATCH .../{id}` | Same shape and behaviour as `/settings/wish-library`, against `scene_wish_library` instead — a separate library for scene/imagery wishes |
| `POST /api/projects/{id}/title-card/wishes` | `{text}` → `{wish, title_card_wish_library, active_title_card_wish_ids}`. Poster-generation equivalent of `scenes/wishes` — cleans+titles via `wish_library.add_or_get_wish` (`library_key='title_card_wish_library'`) then immediately activates it for this project |
| `POST /api/projects/{id}/suno/generate` | `{skill_id, skill_prompt, model, active_wish_ids?}` → `{style, lyrics, skill_id, model_used, debug}`. `model` is the `"{provider}:{model_id}"` composite — the Suno stage seeds it from `settings.text_models.default` but lets the user override it per-call via the `ModelPicker` next to "Сгенерировать промпт"/"Generate prompt"; `active_wish_ids` (falls back to the project's own field if omitted) is resolved against `settings.suno_wish_library` and sent as an emphasized, numbered "ВАЖНЫЕ ТРЕБОВАНИЯ ПОЛЬЗОВАТЕЛЯ" block right after the base prompt; `provider ∈ google\|openrouter\|deepseek` + a matching key calls that provider's real chat API; a failed call returns `502` instead of falling back. `debug` is either `{stub: false, request, response, missing_markers}` (real call — `missing_markers` true if the reply didn't follow the `===STYLE===`/`===LYRICS===` format) or `{stub: true, reason: no_model_selected\|unsupported_provider\|no_api_key, requested_model}` — shown in the Suno stage's debug panel, which auto-expands whenever either flag needs attention |
| `POST /api/projects/{id}/suno/wishes` | `{text}` → `{wish, suno_wish_library, active_wish_ids}`. Cleans+titles `text` via `wish_library.add_or_get_wish` (reuses an existing card with the same text instead of duplicating it), then immediately activates that wish's id for this project — the "Применить" button on the Suno stage's "Доработка через AI-пожелание" section. Replaces the old `suno/refine`, which instead folded the wish into `skill_prompt` and only kept a read-only history |
| `POST /api/projects/{id}/scenes/generate` | `{style_description, scene_count?, model?, scene_mode?, active_scene_wish_ids?}` → `{scenes, style_description, scene_mode, debug}` — **replaces all scenes**, clearing their images. `scene_mode ∈ narrative\|abstract` picks `scene_base_prompt_narrative`/`_abstract`; `active_scene_wish_ids` (falls back to the project's own field) resolves against `scene_wish_library` the same way Suno's wishes do; `provider ∈ google\|openrouter\|deepseek` + a matching key calls that provider's real chat API asking for a JSON scene array; a failed call returns `502`. `debug` shape mirrors `suno/generate`'s exactly (`{stub, request, response, missing_markers, usage}` or `{stub: true, reason, requested_model}`) |
| `POST /api/projects/{id}/scenes/wishes` | `{text}` → `{wish, scene_wish_library, active_scene_wish_ids}`. Scene-imagery equivalent of `suno/wishes` — cleans+titles then activates for this project |
| `POST /api/projects/{id}/scenes/{n}/images` | `{count, model}` → `{job_ids}` — starts one background generation job per requested variant (`model` = `"{provider}:{model_id}"` from `settings.image_models`/`image_models_simple`, provider ∈ `krea\|replicate\|fal\|google\|openrouter`) and returns immediately; poll each job below. A finished job appends its image to `scenes[n].images` on its own, independent of polling. Also called from the Scenes stage itself (`useScenesStage.js`'s `generateSceneImage`, always `count: 1` against the cheap-tier `sceneImageModel`) for a quick single-image preview without leaving that stage — same endpoint, same `scenes[n].images` array, just a different caller |
| `GET /api/projects/{id}/scenes/{n}/images/jobs/{job_id}` | → `{status: 'pending'\|'completed'\|'failed', image: Image\|null, error: str\|null}` — polled every 1.5s by the frontend (`useImagesStage.js`); job state is in-memory only (see `architecture.md`) |
| `POST /api/projects/{id}/reference-images` | multipart `file` → `{reference_images}` |
| `DELETE /api/projects/{id}/reference-images/{filename}` | → `{reference_images}` |
| `POST /api/projects/{id}/title-card/generate` | `{text_block, base_prompt, reference_image_paths (1-4, must resolve inside the project folder and exist), model, aspect_ratio?, count?, active_title_card_wish_ids?}` → `{job_ids}` — same immediate-return/background-job shape as scene images, but `model` must be a reference-capable provider (`google`/`google_free`'s Nano Banana ids, Krea's `google/nano-banana-pro`, FAL's `fal-ai/nano-banana/edit`, or OpenRouter with `input_references`; see `architecture.md`) — any other provider fails the job with a clear error instead of silently falling back |
| `GET /api/projects/{id}/title-card/jobs/{job_id}` | → `{status: 'pending'\|'completed'\|'failed', variant: TitleCardVariant\|null, error: str\|null, debug: {request, response}\|null}` — polled every 1.5s by the frontend (`useTitleCardStage.js`), same in-memory-only job state as scene images (a separate `title_card._jobs` dict). `debug` is a redacted snapshot of the actual provider request/response (reference-image bytes and inline result data replaced with `<... bytes>` placeholders; plain URLs kept) for the stage's debug panel |
| `DELETE /api/projects/{id}/title-card/variants/{variant_id}` | → `{variants}` — removes one result from `project.title_card.variants` and deletes its file |
| `POST /api/projects/{id}/title-card/variants/{variant_id}/remove-background` | `{method?}` (`'local'\|'fal'\|'replicate'`, defaults to `settings.background_remover_method`) → `{variant, variants, debug: {request, response}\|null}` — runs the variant through the chosen background-removal method (`title_card.remove_background`; see `architecture.md` for what each of the 3 does) and **appends** the result as a new variant (`source_variant_id` pointing back at the original, which is left untouched); `404` if `variant_id` doesn't exist, `502` on a provider failure |
| `POST /api/projects/{id}/title-card/poster` | multipart: `file` (flattened PNG) + `background_path`, `title_card_variant_id`, `logo_id?`, `layers` (JSON), `canvas_size` (JSON), `poster_id?` → `{poster, posters}`. Creates a new `Poster`, or re-renders one in place (same `file_path`) when `poster_id` matches an existing entry. `422` if `background_path`/`title_card_variant_id` don't resolve |
| `DELETE /api/projects/{id}/title-card/poster/{poster_id}` | → `{posters}` — removes one from `project.title_card.posters` and deletes its file |
| `POST /api/projects/{id}/mureka/generate` | `{style, lyrics, model, n, gender?, reference_id?}` → `{job_id}` — one job per click (unlike scene images, Mureka's own `n` (1-3) returns several songs from a single task); `422` if `lyrics` is blank |
| `GET /api/projects/{id}/mureka/jobs/{job_id}` | → `{status: 'pending'\|'completed'\|'failed', tracks: MurekaTrack[]\|null, error: str\|null, debug}` — polled every 3s (longer than image jobs — Mureka generation runs 30-90s), in-memory-only job state (`providers/mureka.py`'s own `_jobs` dict) |
| `DELETE /api/projects/{id}/mureka/tracks/{track_id}` | → `{tracks}` — removes one from `project.mureka.tracks` and deletes its `.mp3` file |
| `POST /api/projects/{id}/mureka/reference-audio` | multipart `file` (mp3/m4a) → `{reference_audio}` — saves a local copy under `music/references/` **and** uploads it to Mureka's `files/upload` (`purpose=reference`) to get the `mureka_file_id` usable as `reference_id`; `415` on a bad extension, `502` if the Mureka upload call fails |
| `DELETE /api/projects/{id}/mureka/reference-audio/{ref_id}` | → `{reference_audio}` |
| `POST /api/settings/logos` | multipart `file` (png/webp) + `name?` → `{logos}` — appends to the global `settings.logos`, file under `app_data/logos/` |
| `DELETE /api/settings/logos/{logo_id}` | → `{logos}` |
| `POST /api/translate` | `{text, target_lang?}` (`target_lang` defaults to `ru`) → `{translated}`. Project-independent - a one-off preview translation for the "translate" button next to each static/motion prompt (`TranslateButton.jsx`), never written back into the project. Calls the Google Cloud Translation API v2 (Basic) with `settings.api_keys.google_translate`; a missing key or provider failure returns `502` (no silent fallback) |
| `GET /media/<path>` | Static passthrough over `app_data/`; build URLs with `mediaUrl()` in `api/client.js` |
| `GET /api/usage/records` | Filters `project_id\|task\|provider\|model\|status\|date_from\|date_to\|limit\|offset` → `{records, total, limit, offset, totals}` |
| `GET /api/usage/summary` | Same filters + `group_by ∈ project\|task\|model\|provider\|day`, `tz_offset` → `{group_by, currency, groups[], totals}` |
| `GET /api/usage/today` | `tz_offset` → `{date, cost, currency, calls, unknown_cost_calls, saved_cost}` |
| `GET /api/usage/period-totals` | `tz_offset` → `{currency, today, week, month, total}` — each a `{calls, errors, cost, unknown_cost_calls, saved_cost}` totals object; backs the header cost pill's expanded view. `saved_cost` is what every `google_free` call in that bucket would have cost at the paid rate — informational only, never added into `cost` |
| `GET /api/usage/pricing` / `PUT /api/usage/pricing` | Merged price catalog `{pricing_version, currency, models[], overrides}` / body `{pricing_overrides}`, `422` on an invalid row. `models[]` also includes an unpriced row (`input`/`output`/`per_image: null`, `source: 'catalog'`) for every model in the persisted model catalog that isn't priced yet - so the Prices tab lists everything the Models tab has ever seen |

Every generation route persists its result onto the project before returning,
so the client never has to `PATCH` afterwards — except the scene-images job
route, which returns `job_ids` immediately and persists each image
asynchronously when its background job completes (see `architecture.md`).

A `MurekaTrack`'s `rating`/`is_selected`/`tag_ids` have no dedicated route —
same convention as scene-image rating/selection — the frontend recomputes
the whole `project.mureka.tracks` array and sends it through the generic
`PATCH /api/projects/{id}` above.
