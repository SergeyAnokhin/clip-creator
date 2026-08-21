# Data model & API

Everything is JSON on disk under `app_data/` (git-ignored, override the root
with the `APP_DATA_DIR` env var). No database, no migrations — a project file is
whatever shape `storage.save_project` last wrote.

```text
app_data/
  settings.json
  model_catalog.json          # last-known-good model list per provider (see below)
  projects/
    _redirects.json           # {old_slug: new_slug} - see "Project rename" below
    <slug>/                  # slug = "Author - Title", filesystem-sanitized = project id
      config.json            # the whole project
      images/scene_{n}_{shorthex}.{png|jpg|webp}
      videos/scene_{n}_{shorthex}.mp4
      references/ref_{uuid}.{ext}
      titlecard/{shorthex}.{png|jpg|webp}
      titlecard/posters/{shorthex}.png   # Poster constructor output (flattened)
      magic/{group_id}/L{n}.png          # Magic-layer group: one RGBA layer per file
      music/{track_id}.mp3               # Mureka tracks, downloaded immediately (see below)
      music/{stem_id}.zip                # stem-separation output (see MurekaTrack.stems)
      music/references/ref_{uuid}.{ext}  # trimmed reference audio actually sent to Mureka
      music/reference-sources/{id}.{ext} # raw uploaded file, pre-trim staging area
      editor/rnd_{shorthex}.mp4          # Editor stage final renders (local ffmpeg only)
  logos/logo_{shorthex}.{png|webp}       # global, cross-project - see settings.logos
  usage/
    YYYY-MM.jsonl             # append-only AI-call ledger, one JSON object per line
```

## Project (`config.json`)

| Field | Type | Notes |
| --- | --- | --- |
| `id` | str | = folder slug; collisions get `-2`, `-3`, … |
| `author`, `title` | str | Fall back to `"Неизвестный автор"` / `"Новое стихотворение"`. Editing either one **renames the folder and `id` to match** (`routers/projects.py::patch_project` recomputes the slug, moves the folder, and records a redirect — see "Project rename" below); the response's `id` may differ from the one the request was sent to, and callers must adopt it (`useProjects.js`'s `adoptRenamedId`) |
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
| `active_video_wish_ids` | str[] | Ids of `settings.video_wish_library` entries toggled on for this project — same idea as `active_scene_wish_ids`, separate library (animation/video wishes, e.g. "плавное движение камеры") |
| `mureka` | Mureka \| absent | Real audio generation via the Mureka API (distinct from `style`/`lyrics` above, which are just text) — absent until the stage is first opened, defaults to `{style_input: '', lyrics_input: '', reference_audio: [], reference_sources: [], tracks: []}` |
| `video_edit` | VideoEdit \| absent/null | Editor stage state (final render) — absent/`null` until the stage is first opened, or if it's ever explicitly cleared; the frontend treats either the same and re-seeds a fresh default (see below) |
| `magic_layer_groups` | MagicLayerGroup[] \| absent | Decomposed-image layer sets (see below) — absent until the first ✨ decomposition; every read site defaults it to `[]` |

### Project rename

**Project rename** (`app_data/projects/_redirects.json`): a `PATCH` that changes
`title`/`author` moves the folder to the new slug (uniquified like
`create_project`'s `-2`/`-3` suffix) and appends `{old_slug: new_slug}` to this
flat, never-pruned map. `storage.resolve_slug`/`project_dir`/`project_lock`
follow the chain, so a caller still holding the old slug — a background job that
started before the rename, or a stale client request — lands in the renamed
folder instead of recreating an orphaned one. **`resolve_slug` only follows a
redirect when `slug` isn't itself a real, currently-existing project** (it checks
for `<slug>/config.json` first): slugs are content-derived and not permanently
unique, so a vacated old slug can later be a wholly unrelated project's real
address, and without that check opening it would silently load and overwrite the
renamed one's data.

### Block

**Block**: `{id, type, importance, content}` — `type` is
`intro|verse|chorus|bridge|outro|interlude`; `content` is plain multi-line text.
`interlude` blocks hold a Suno meta-tag (e.g. `[Vocal Interlude]`) and render as
a compact single-line card. `importance` (1-5) is **dead** — still written for
backward compatibility, never read or edited.

### Scene

**Scene**: `{lyric_segment, static_prompt, motion_prompt, images[], videos[],
animate_image_id?}` — `videos` is absent/`[]` until the Video stage first
generates one. `animate_image_id` is an optional override set by clicking a
thumbnail in the Video stage's picker: it names which `images[].image_id` gets
animated, independent of that image's `is_selected` flag, so picking something to
animate never changes the scene's main picture elsewhere. Resolution order
(`lib/scenes.js`'s `resolveAnimateImage`, mirrored server-side by the `image_id`
override on `POST .../scenes/{n}/videos`): `animate_image_id` match → the
`is_selected` image → the first image → none.

### Image

**Image**: `{image_id, file_path, rating, is_selected, generated_at, model,
aspect_ratio, cost, source_image_id?}` — `file_path` is relative to the project
folder (`images/scene_1_a1b2c3d4.png`), `rating` 0-5, exactly one `is_selected`
per scene once anything is rated. `model` is `'upload'` for a user upload,
`'local:crop'` for a plain crop, `fal:fal-ai/flux-2-pro/outpaint` for an
outpainted one, or the usual `{provider}:{model_id}` composite. `source_image_id`
appears only on a crop/outpaint result and points at the original, which is left
untouched — cropping always **appends**, mirroring
`TitleCardVariant.source_variant_id` below.

### Video

**Video** (`providers/video.py`): `{video_id, file_path, rating, is_selected,
generated_at, model, motion_prompt, aspect_ratio, resolution, duration_seconds,
generation_ms, cost, source_image_id}` — `file_path` is
`videos/scene_1_a1b2c3d4.mp4` (always `.mp4`, both providers), `model` a
`{provider}:{model_id}` composite with `provider ∈ google|google_free|openrouter`.
`motion_prompt` is a snapshot of the exact prompt sent (the scene's own field
plus any active video wishes), kept alongside the still-editable
`scene.motion_prompt` so a past video's prompt stays inspectable.
`source_image_id` points at the animated `Image`. `generation_ms` is wall-clock
time, stored on the record so it's visible without opening the debug panel or
Usage screen. `cost` follows `Image.cost`'s priority: a provider-reported price
(OpenRouter) wins over the catalog (Veo's `per_second` × `duration_seconds`).
`videos[]` is append-only. **A manually uploaded or imported clip is never
probed**, so `duration_seconds`/`resolution`/`aspect_ratio`/`generation_ms` are
`null` on it — which matters for the Editor stage's trim math below.

### VideoEdit (Editor stage)

**VideoEdit** (Editor stage, `providers/editor_plan.py`): `{mureka_track_id, clips[],
overlays[], overlay_video_sources[], renders[], canvas_orientation, markers[],
audio, export}`. Lazily seeded the first time
the stage opens (one clip per scene that has an `is_selected` video, in scene
order; `mureka_track_id` from whichever `MurekaTrack.is_selected`), but —
unlike `TitleCard.text_block` — persisted immediately, so a reload right after
first opening the stage doesn't lose it. `clips`/`overlays`/`mureka_track_id`
are edited only through the generic `PATCH /api/projects/{id}`; uploading an
overlay video and rendering are the only real job/API calls (see the route
table below).

#### EditorClip

An **`EditorClip`** is `{clip_id, scene_index, video_id, trim_start_ms,
trim_end_ms, speed, reverse?, fit?, adjust?, freeze?}` — `video_id` must resolve inside
`scenes[scene_index].videos[]` but need **not** be unique across `clips[]`: the
timeline's razor (`lib/timeline.js`'s `splitClipsAt`) turns one clip into two
entries over the same source video with adjacent trim windows, and the render
resolves every clip independently. `speed` is an ffmpeg `setpts` multiplier; video
clips are always muted, the picked track being the only audio. `reverse`
(absent/`false` by default) plays the trimmed window back to front - an
ffmpeg `reverse` filter placed right after the speed/PTS-reset
(`providers/editor_ffmpeg.py::build_ffmpeg_command`), independent of `speed`;
editable via `TimelineClipInspector.jsx`'s toggle next to the speed field or
the program monitor's right-click menu (`EditorPreviewContextMenu.jsx`). The
in-browser preview does **not** simulate it (a native `<video>` has no
negative `playbackRate`) - a reversed clip just plays forward there, same
"approximate, non-blocking" tolerance the rest of this preview already has.
`trim_end_ms: null` means "to the end of the source", falling back to that
video's `duration_seconds` — **except when that duration is itself unknown** (an
uploaded/imported clip), where `build_render_plan` falls back to `ffprobe`ing
the real file on disk (`_probe_duration_ms`, only when it's given a
`project_dir` - every render caller has one, but this keeps the function pure
for the ~80 plan-only tests that don't) before finally leaving the end
genuinely unbounded (ffmpeg runs to EOF) if even that fails (file missing,
`ffprobe` erroring). This probe is what makes a `transition_in`/`fade_out`
touching such a clip actually render at all - both need a real known length
to compute `xfade`'s `offset`/`fade`'s `st`, an absolute-seconds position -
without it, a transition against an unbounded clip silently degrades to a
hard cut and a `fade_out` on one silently doesn't apply (confirmed against a
real project where every clip was an upload, 2026-08-19). The frontend, which
never probes anything itself, still lays such a clip out with a fixed 5s
stand-in purely for display (`lib/timeline.js`'s `UNKNOWN_DURATION_FALLBACK_MS`) -
the real probed duration only exists render-side.

#### `fit` / `adjust` / `freeze` — per-clip look

`fit` (`{mode: 'cover'|'contain', zoom, offset_x_pct, offset_y_pct}`,
absent/`null` = `{mode: 'cover', zoom: 1, offset_x_pct: 50, offset_y_pct: 50}`)
is how a clip whose own aspect ratio doesn't match the render canvas fills it -
`cover` (the default) scales up and crops the overflow so the clip always
fills the frame with no letterbox bars, `zoom` (≥1) scales in further, and
`offset_x_pct`/`offset_y_pct` (0-100%, 50 = centered) pan within the resulting
overscanned image (`TimelineClipInspector.jsx`'s "Кадрирование" section);
`contain` is the old always-letterboxed behavior (scale down to fit, pad the
rest), an explicit opt-in for a clip the user deliberately wants letterboxed.

`adjust` (`{brightness, contrast, saturation, gamma}`, absent/`null` = no
correction) is per-clip colour correction in ffmpeg `eq` semantics — a single
`eq=` filter appended after the scale/crop chain and before the fades
(`providers/editor_plan.py`), and **omitted entirely** when it is absent or every
value is at its default, so an untouched clip's filter graph is byte-for-byte
what it was before this field existed (`lib/timeline.js`'s `isDefaultAdjust`
is the frontend mirror of that check). Edited in
`TimelineClipInspector.jsx`'s "Цветокоррекция" section (four sliders plus
warm/cool/mono/punch presets), and previewed approximately as a CSS `filter`
on the program monitor's `<video>` — `gamma` has no CSS equivalent and simply
isn't previewed, same tolerance as `fit`/`reverse`.

`freeze` (absent/`false` by default) makes the clip **hold the single frame at
`trim_start_ms`** for its whole trim window instead of playing it — the render
grabs one frame and clones it with `tpad` rather than trimming a range. Its
window length is therefore its output length, so nothing about the timeline
arithmetic, transitions or the tail pad changes for it. Created by
`useEditorStage.js`'s `freezeAtPlayhead` (`lib/timeline.js`'s `freezeClipsAt`
splits the clip under the playhead and inserts a `DEFAULT_FREEZE_MS` still
between the halves — CapCut's "freeze" behaviour), reachable from the clip
inspector and either right-click menu. `speed`/`reverse` are forced to their
defaults on such a clip and are ignored by the render.

#### `overlays[]`

An **overlay** entry is `{overlay_id, kind: 'title_card'|'logo'|'video'|'text',
source_id, start_ms, duration_ms, x_pct, y_pct, width_pct, height_pct,
rotation_deg, opacity, fade_in_ms, fade_out_ms, reverse?}` — shown over the
video for `[start_ms, start_ms+duration_ms)` on the same millisecond axis as a
clip's `startMs`/`durationMs`. Unlike clips, overlays don't tile back to back:
they float freely, may overlap or leave gaps, and live on their own track
(overlapping ones render on separate lanes — a *display* concern only, never
stored). Array order is z-order, later entries on top (mirrors
`Poster.layers`). Editing one only ever patches its own object — no cascading
layout the way clip trim/speed can shift every later clip.

`source_id` resolves per `kind`: `'title_card'` against this project's
`title_card.variants[].variant_id`, `'logo'` against the **global**
`settings.logos[].id`, `'video'` against this same `VideoEdit`'s
`overlay_video_sources[]` (project-scoped, like a title card, not global like
a logo).

`kind: 'text'` has **no `source_id` at all** — it carries its own `text` block
instead: `{content, font, color, outline_color, outline_width, align,
line_spacing}`. The render rasterizes that block to a transparent PNG cached
content-addressed at `editor/text_cache/{sha1}.png`, which then feeds the
existing image-overlay path, so every other overlay property works on it
unchanged (see `architecture.md` for why not `drawtext`). The path derives
purely from the styling block, so `build_render_plan` resolves it with no disk
access and only writes the file when given a `project_dir`. `font` is one of
`lib/overlays.js`'s `TEXT_FONTS` — a small list of Cyrillic-capable faces that
exist **both** in the browser and on the render host
(`providers/editor_plan.py`'s `_TEXT_FONT_FILES`, with DejaVu fallbacks), so
preview and render agree. There is no font-size field on purpose: how big the
text appears is `width_pct`/`height_pct`, exactly like an image.

`x_pct`/`y_pct` place the overlay's **top-left corner** (of its *unrotated*
bounding box) as a percentage of the canvas. `rotation_deg` (0-360) rotates it
about that same corner — mirroring how Konva places a `Group` (translate, then
rotate, offset always `(0,0)`), so the live monitor and the ffmpeg render land
on the same pixel.

`width_pct`/`height_pct` are **both a percentage of canvas *width***.
`height_pct` deliberately shares `width_pct`'s axis rather than being read
against canvas height: two percentages measured against two different axes
don't survive a `canvas_orientation` reshape undistorted, whereas this ratio
always reproduces the overlay's true pixel aspect ratio. `height_axis: 'width'`
marks an overlay already in this convention; anything saved before it is
lazily rescaled on read by `providers/editor_plan.py`'s
`_migrate_overlay_position` / `lib/overlays.js`'s `migrateOverlay`. The two
scale independently at the data level (no forced aspect lock), but the UI only
ever moves them together, so nothing writes a distorted pair through it.

Those same two functions also derive `x_pct`/`y_pct`/`height_pct`/
`rotation_deg` for an overlay saved before free placement existed (it has only
`position`, one of a 9-point grid, plus a bare `width_pct`), so old projects
open and render unchanged with no migration pass.

`opacity` (0-1) is the flat alpha; `fade_in_ms`/`fade_out_ms` (default `0`)
ramp it from/to `0` at the ends of its own window, clamped proportionally if
their sum would outlast `duration_ms`.

`reverse` (absent/`false`) only means anything for `kind: 'video'` — same
ffmpeg `reverse` filter as `EditorClip.reverse`, but applied *before* the video
overlay's frame-0 `setpts` realignment rather than after (`reverse` resets the
stream's PTS to start at 0, so the shift has to apply to that new axis).
Silently ignored for an image overlay: applying it to that kind's `-loop 1`
infinite still-image stream would hang ffmpeg, which needs a stream with a real
end to buffer.

#### `markers[]`

**`markers[]`** (`VideoEdit`) is `[{marker_id, at_ms, label?}]` — labelled
moments on the timeline ruler. **The renderer never reads them**: they exist
purely as an editing aid, and above all as snap targets for every timeline
gesture (`lib/timelineSnap.js`), which is what makes "cut on the beat"
practical. Added with `M`, dragged, renamed (double-click) and deleted
(right-click) on the ruler (`TimelineMarker.jsx`), or placed in bulk by the
beat-detection button, which runs `lib/beats.js`'s onset detection over the
bass envelope the waveform decode already produced (`hooks/useAudioPeaks.js`)
— that batch **replaces** the whole set rather than appending, so pressing it
twice doesn't double up and one undo takes it all back. Part of the undo
history alongside `clips`/`overlays`.

#### `audio`

**`audio`** (`VideoEdit`) is `{volume, fade_in_ms, fade_out_ms, offset_ms}`,
absent/`null` meaning exactly `{volume: 1, fade_in_ms: 0, fade_out_ms: 0,
offset_ms: 0}` — which is also what the renderer did before the field existed,
so nothing needs migrating. `volume` is a flat gain (clamped to 0–4×);
the fades are ramps at the very start and end of the **output** (so a
fade-out always lands on the last frame however the clips were trimmed), and
are compressed proportionally if together they would outlast it; `offset_ms`
skips that much of the track's own head ("start the video on the chorus"),
clamped inside the track. Rendered as
`atrim`/`asetpts`/`volume`/`afade`/`apad` and previewed by
`hooks/useEditorPreview.js`, which offsets the playhead↔`<audio>.currentTime`
relationship by the same amount so the playhead means the same moment in
both. A **test render's** own window offset is *added* to `offset_ms`, never
substituted for it, and the fades are re-clamped against the shorter window.
Edited by selecting the waveform row itself on the timeline —
`TimelineAudioInspector.jsx`, the fourth mutually-exclusive selection kind
alongside clip/overlay/transition.

#### `export`

**`export`** (`VideoEdit`) is `{resolution: 'source'|'720p'|'1080p'|'4k',
fps: 24|30|60, quality: 'high'|'medium'|'low'}`, absent/`null` meaning
`{'source', 30, 'high'}`. It is resolved *after* `canvas_orientation`
(`_resolve_export`): orientation picks the canvas **shape**, this scales it
(short side to the named height, both dimensions forced even for
libx264/yuv420p) and sets `fps` plus `-crf`/`-preset`
(high=18/medium, medium=23/medium, low=28/veryfast). Unknown values fall back
to the defaults rather than failing the render. Edited in the Editor stage's
**Клип** tab next to the canvas orientation, since both are project-level.

#### `overlay_video_sources[]`

**`overlay_video_sources[]`** (`VideoEdit`, alongside `overlays[]`) is
`[{id, file_path, duration_seconds}]` - uploaded video files usable as a
`kind: 'video'` overlay (video-in-video compositing). `file_path` is
`editor/overlay_sources/{id}.{ext}`, project-relative like a clip's own
`file_path`. `duration_seconds` is always `null` - never ffprobed, same
"unknown duration" convention `Video.duration_seconds` already has for an
uploaded/imported clip; the overlay's own `start_ms`/`duration_ms` governs its
on-timeline window regardless of the source video's real length. Managed via
its own upload/delete routes (below), not the generic `PATCH`.

#### `transition_in`, `fade_in` / `fade_out`

An `EditorClip` can also carry `transition_in` (`{type, duration_ms}`, absent =
a hard cut) and `fade_in`/`fade_out` (`{color: 'black'|'white', duration_ms}`,
absent = no fade).

`type` is one of the 16 entries in `lib/timeline.js`'s `TRANSITION_GROUPS` /
`providers/editor_plan.py`'s `_TRANSITION_XFADE_NAME` —
`dissolve`/`fadeblack`/`fadewhite`, four wipes, four slides, and
`circleopen`/`circleclose`/`radial`/`pixelize` — each mapping to the ffmpeg
`xfade` transition of the same name (`dissolve` is the one alias: it maps to
xfade's `fade`). An unrecognized type degrades to a hard cut rather than
failing the render.

`transition_in` describes the transition *into* this clip *from* the previous
one, so it is meaningless on the first clip. It renders as a real `xfade`: the
two clips' frames genuinely overlap and blend for `duration_ms`, making the
output that much *shorter* than the naive sum of both durations.
`build_render_plan` accounts for that when sizing the tail freeze-pad; the
frontend timeline does **not** model the overlap, and treats it as one more
source of the render-vs-timeline tolerance this stage already has (see
`renders[]` below and `architecture.md`).

`fade_in`/`fade_out` are a plain ffmpeg `fade` applied to that one clip only,
entirely within its own duration — no interaction with neighbours or layout.
Both they and a transition's duration are clamped at render time to never
exceed the content they'd apply to (`providers/editor_plan.py`'s
`_resolve_fade` and `build_render_plan`'s own transition clamp).

#### `renders[]` and `canvas_orientation`

`renders[]` is server-managed and append-only: `{render_id, file_path,
created_at, duration_ms, clip_count, mureka_track_id, kind: 'final'|'test',
range: {start_ms, end_ms}|null}`.

Output canvas is 1920×1080 or 1080×1920, picked by
`VideoEdit.canvas_orientation`: `'auto'` (default) resolves to 1080×1920 unless
some clip's `aspect_ratio` is *explicitly* not `9:16` — a clip with no probed
`aspect_ratio` (a manual upload, `null` per above) doesn't force landscape on
its own; `'portrait'`/`'landscape'` force that canvas regardless of the clips.
Each clip fills it per its own `fit`.

If the clips run **shorter** than the audio the last clip is frozen (ffmpeg
`tpad`) to fill the remainder; if **longer**, the render is hard-capped at the
audio's length (`-t`), silently truncating the tail. The UI shows a
non-blocking duration-mismatch warning for both, computed client-side.
Overlays composite on top of the concatenated clips via ffmpeg's `overlay`
filter, each gated to its own window with `enable='between(t,…)'` — see
`providers/editor_ffmpeg.py::build_ffmpeg_command`.

A **test render** (`kind: 'test'`, `range` set) covers only a
`[start_ms, end_ms)` window. The range is typed into `TestRangeModal.jsx` (from
the Editor's bottom toolbar) and is never part of `VideoEdit` itself — the
timeline ruler only draws it. `providers/editor_plan.py`'s
`_trim_plan_to_range` post-processes the normal, fully-resolved plan: clips
entirely outside the range are dropped, the new first/last clip's trim points
are tightened to their content inside it, overlays are kept only if they
intersect (shifted so the range's start becomes the new timeline zero), and the
audio is trimmed to the same window (`atrim`/`asetpts`). If the requested start
lands inside a transition's blend window, the *effective* start is first pulled
back to where that blend begins so the clip it blends from is kept and the
transition still renders, rather than silently turning into a hard cut — the
timeline draws clip blocks back-to-back with no cue for the overlap, so a range
typed against that display easily lands on such a boundary.

### TitleCard

**TitleCard**: `{text_block, reference_image_paths, variants, posters}` —
`text_block` is one free-text field the user edits directly (not separate
title/author inputs the server wraps in quotes), lazily seeded to
`'"Заголовок"\n"Автор"'` the first time the stage loads **only if the key is
`undefined`**, so a later intentional clear-to-`''` sticks. It's appended to the
assembled prompt verbatim. `reference_image_paths` is up to 4 paths picked from
`scenes[].images[].file_path` or `reference_images`, persisted so the picks
survive a reload.

### TitleCardVariant

**TitleCardVariant**: `{variant_id, file_path, rating, is_selected,
generated_at, model, aspect_ratio, cost, text_block, base_prompt,
reference_image_paths, source_variant_id?, marked_for_export?}` — same
`rating`/`is_selected`/`model`/`aspect_ratio`/`cost` shape as `Image` (under
`titlecard/`), plus a snapshot of the text/prompt/references that produced it.
`variants` is append-only; deleting one unlinks its file. `source_variant_id`
appears only on a "remove background" result and points at the original, which is
left untouched. `marked_for_export` (absent reads as unmarked, no migration) is
the Export stage's own per-variant toggle: unlike `is_selected` (a single "main"
pick used e.g. by the Poster constructor), **several variants can be marked at
once**, and the final-export zip includes every marked one, falling back to the
`is_selected` variant when none are.

### Poster

**Poster**: `{poster_id, file_path, background_path, title_card_variant_id,
logo_id, canvas_size{width,height}, layers{title_card[{id,x,y,scaleX,scaleY,rotation,crop,effects}],
logo[{...}]|null, glass{x,y,width,height,scaleX,scaleY,rotation,cornerRadius,opacity,thickness}|null,
text[{id,x,y,scaleX,scaleY,rotation,textType,text,fontFamily,fontSize,color,bgColor,effects}]},
rating, is_selected, generated_at}` — the Poster constructor's output.
`background_path` (a scene/reference image path) and `title_card_variant_id`
(into `variants[]`) are the two source layers; `logo_id` optionally points into
the global `settings.logos[]`; `file_path` is the client-side flattened PNG, and
`layers` the per-layer transform kept so the exact arrangement can be reopened.
`posters` is append-only **except** that re-saving with an existing `poster_id`
updates that entry in place (new PNG, same id and path).

`title_card` and `logo` are **arrays**, not single objects — the same source
image can appear as several independent layers, each with its own
transform/crop/effects. `crop` is `{x,y,width,height}` in the source image's
natural pixel space, or `null` for the full image. Older saved posters stored a
single transform object here; `normalizeLayers` in `lib/posterLayers.js` wraps it
into a one-item array on load, so both shapes still open.

Each layer's `effects` is **opaque to the backend** (stored and round-tripped
as-is, no schema validation). The frontend writes
`{glow{enabled,color,blur,distance,opacity}, clone{enabled,offsetX,offsetY,opacity,blur}, opacity}`,
all baked into the flattened PNG at save time alongside
position/scale/rotation/crop. `glow.opacity` is stored **0-5** while the slider
shows 0-100%; see `architecture.md` for why values past 1.0 render as stacked
shadow passes. An earlier `backdrop` effect was dropped in favor of plain
`opacity` — old posters carrying that key simply lose the effect on load, no
migration.

`glass` is not tied to any source image — a standalone decorative rounded-rect
panel, limited to one instance, also opaque/unvalidated on the backend.

`text` is an array of freely-editable text layers, added client-side after
variants and posters already existed, so **older posters have no `text` key at
all** (`normalizeTextLayers` treats a missing/non-array value as `[]`).
`textType` is `'badge'` or `'halo'`, both defaulting from
`title_card.text_block`'s two quoted lines (`parseTextBlock`). `fontFamily` is
one of `lib/posterLayers.js`'s `FONT_OPTIONS`; `fontSize`/`color` and, for
`badge`, `bgColor` are plain style fields; `align` is `'left'|'center'|'right'`
(defaults `'left'` on older layers); `effects` reuses the shape above.

`layers.magic` is the same image-layer shape plus a per-layer
`src{group_id, index, file_path, is_background}` — unlike every other image
layer, a magic layer carries its own source rather than sharing one of the
constructor's three fixed slots, since one group contributes N different images
(`normalizeMagicLayers` drops entries whose `src.file_path` didn't survive, and
reads a missing `magic` key as `[]`, so pre-feature posters open unchanged).
Alongside it, `layers.hide_background` / `layers.hide_title_card` (booleans,
absent = `false`) record that the flat original a group was made from must stop
rendering — see architecture.md.

### MagicLayerGroup

**MagicLayerGroup**: `{group_id, source_path, source_kind, canvas{width,height},
method, model, num_layers, requested_layers, layers[{index, file_path,
bbox{x,y,width,height}, is_background}], cost, generated_at}` — one
decomposition of one image (`providers/magic_layers.py`). `source_path` is the
project-relative path of the image it came from (a scene image or a title-card
variant, per `source_kind`: `scene_image|title_card_variant|reference`);
`method` is `fal|replicate`. `layers` is ordered bottom-to-top, each a
full-canvas RGBA PNG under `magic/{group_id}/`, exactly one flagged
`is_background` (the inpainted plate — detected by opaque area, not by index,
since the model doesn't guarantee ordering). `num_layers` is what actually came
back after empty layers were dropped; `requested_layers` is what was asked for.
`bbox` is the layer's opaque bounds in canvas pixels, kept so the UI can label a
layer without decoding the PNG. Groups are project-level and reusable — a poster
references one through `layers.magic[].src`, it does not copy it.

### Mureka

**Mureka**: `{style_input, lyrics_input, reference_audio[], reference_sources[],
tracks[]}`. `style_input`/`lyrics_input` are seeded lazily (only if still
`undefined`) from the project's `style`/`lyrics`, **and then re-synced on every
subsequent Suno-stage regenerate** (`useSunoStage.js`'s `generateSuno` overwrites
both) — otherwise a later regenerate would go unnoticed here. Editing them
directly on the Mureka stage still works freely in between; this is literally
what gets sent to `song/generate`, so it doubles as the "what goes to the model"
preview.

`reference_audio` is `[{id, mureka_file_id, file_path, filename, uploaded_at,
source_id?, start_ms?, end_ms?}]` — `file_path` a local copy under
`music/references/` (already trimmed, mp3), `mureka_file_id` the id Mureka's
`files/upload` returned. An entry produced by the trimmer also carries
`source_id` and the `start_ms`/`end_ms` window used; a plain direct upload leaves
all three `undefined`.

`reference_sources` is `[{id, file_path, filename, uploaded_at}]` — the
**untrimmed** upload (`music/reference-sources/`, any decodable format), staged
so a ≥30s window can be picked before anything reaches Mureka (which hard-rejects
reference audio under 30s). **A source is never deleted by a successful or
cancelled trim** — it stays so the same upload can be trimmed into another window
later; only an explicit `DELETE .../reference-sources/{id}` removes it, so this
array grows with every distinct upload.

### MurekaTrack

**MurekaTrack**: `{track_id, task_id, choice_index, file_path, duration_ms,
model, style, lyrics, params{n, gender, reference_id}, rating, is_selected,
tag_ids[], generated_at, raw, request?, reference_used?, extended_from_track_id?,
stems?, descriptions?, transcriptions?, lyrics_videos?}` — `file_path` under
`music/` (always `.mp3`, downloaded immediately since Mureka's own `url` expires
after 30 days).

- `style`/`lyrics`/`params` snapshot exactly what was sent. One task can produce
  several tracks (`choice_index` is the `choices[]` index). For a track produced
  by "Продлить" (extend), `params` is `{extend_at, extend_type}` instead and
  `extended_from_track_id` points back at the source track.
- `reference_used` is `{source_id, filename, start_ms, end_ms} | null` — set on
  generate (never extend) when `params.reference_id` resolved against
  `reference_audio`. It's a snapshot, not a live reference, so it still shows
  which clip/window produced the track after that entry is deleted.
- `request` is `{url, body} | null`, the exact HTTP request sent to Mureka, kept
  alongside `raw` so generation parameters can be double-checked from the UI.
  Tracks predating this field have **no `request` key at all**, not a `null`.
- `rating` (0-5) and `is_selected` mirror `Image`, but **`is_selected` is only
  ever set by explicit user action** — never auto-promoted from the highest
  rating, unlike `Image`. `tag_ids` references `settings.music_tags`.
- `tracks[]` always stays in generation order (oldest first); `MurekaStage.jsx`
  applies a display-only sort toggle that never touches the stored array.

`raw` is the untouched `choices[]` entry (`url`/`flac_url`/`wav_url`/`id`/
`lyrics_sections`); `raw.id` is the Mureka `song_id` that extend/transcribe/
lyrics-video key off. `lyrics_sections` carries per-line/per-word timing (ms) and
drives the karaoke views via `lib/lyricsTiming.js`. **Three data-quality quirks,
confirmed against real tracks, that `lib/lyricsTiming.js` and its consumers are
built around:**

1. Timing can stop well before the track's actual `duration_ms` (one response
   timed lines only to ~43% of the track, with nothing after).
2. A line's `words[]` array has been seen offset by one line (each line's words
   spell out the *previous* line's text), so `words[].text` is never rendered —
   only `.start`/`.end` would be trustworthy.
3. A leading run of sections can carry **no** `start`/`end` at all, neither on
   the section nor its lines — one response had an untimed `intro` and `verse`
   holding the track's actual opening hook. `flattenLyricsLines` still emits
   these as rows (`static: true`, both timestamps `null`) instead of dropping
   them, so the intro reads as intro text rather than vanishing.

Neither `song/generate` nor `song/query` exposes any parameter affecting how much
gets timed — quirks 1 and 3 are inherent to Mureka's alignment step. A further
wrinkle is documented but **not** corrected in code, since the true offset can't
be derived from the response: once lines do have timing, comparing by ear
suggests the timestamps may be measured from where alignment first locked on
rather than the track's true start, so untimed leading content can make every
later timestamp read seconds-to-tens-of-seconds early. Treat any
`lyrics_sections` timestamp as **approximate**, not frame-accurate.

`karaoke_sync` (absent until the user taps or marks anything) is
`{anchors: {[rowIndex]: userMs}, tempo_marks: [{id, time_ms, direction}]}` — the
manual correction for that drift, entirely client-derived and never touching
`raw`. `anchors` keys are indices into that track's `flattenLyricsLines(raw)`
output (stable as long as `raw` doesn't change); `applyManualAnchors` uses them
as pinned control points and linearly rescales every other line's timestamp
between the anchors bracketing it (falling back to interpolating by row position
when a line or its neighbouring anchor has no original timestamp), so tapping the
start of each verse/chorus corrects the whole track. This corrected timeline, not
the raw one, drives the current-line highlight. `tempo_marks` (`direction`:
`'faster'|'slower'`) is unrelated bookkeeping — user-placed markers for audible
tempo changes, shown inline but never affecting line timing. Persisted through
the same generic whole-project `PATCH` as rating/tag edits, no dedicated route.

`stems` (present once "Разделить на дорожки" has run) is `[{id, file_path, model,
expires_at, created_at}]` — `file_path` a downloaded copy of the separation zip
(`music/{stem_id}.zip`; Mureka's CDN link expires), `model` one of
`audio-separation-1|2|3`.

`descriptions`/`transcriptions`/`lyrics_videos` (each absent until its button has
been pressed) are append-only, one entry per call — repeat calls **add** an entry
rather than overwriting:

- `descriptions`: `[{id, instrument[], genres[], tags[], description,
  created_at}]` (`song/describe`, no file involved).
- `transcriptions`: `[{id, file_path, expires_at, created_at}]`
  (`song/transcribe` — `file_path` a downloaded copy of the `.musicxml`+`.pdf`
  zip under `music/{id}.zip`).
- `lyrics_videos`: `[{id, file_path, title, aspect_ratio, created_at}]`
  (`lyrics-video/generate` — mp4 under `music/{id}.mp4`). The call always sends
  the whole track as `selection_start: 0` / `selection_end: duration_ms`, since
  Mureka requires either that pair or a row-range pair and there's no UI for a
  partial range.

`transcribe`/`lyrics-video` key off `raw.id` rather than re-uploading audio, so
they share `/extend`'s "no `song_id`" `422` failure mode for a track past
Mureka's ~1-month retention window; `describe` has no such constraint since it
uploads the `.mp3` directly (base64 data URI, 10MB cap, same as `/stem`). None of
the three has a `pricing.py` row — same "cost: unknown" convention as the rest of
this file.

### Legacy migration (wish libraries)

**Legacy migration**: a project's *absence* of `active_wish_ids` marks it as
predating the AI-wish library rework. The first time such a project loads through
any route (`routers/projects.py::migrate_legacy_project`), its `skill_prompt` is
reset to the default skill text, `refinement_comments` cleared, and
`active_wish_ids` set to `[]` — persisted immediately, so it only fires once.

## Usage ledger (`app_data/usage/YYYY-MM.jsonl`)

One JSON object per line, append-only, one file per calendar month. Full
field-by-field detail, cost-resolution rules, and how to instrument a new call
site are in [usage-tracking.md](usage-tracking.md); summary:

`{id, ts, task, project_id, provider, model_id, model, status, duration_ms, units{kind,input_tokens,output_tokens,reasoning_tokens,cached_input_tokens,total_tokens,images,compute_seconds}, cost{amount,currency,source,pricing_version,saved_amount?}, prompt_preview, response_preview, prompt_chars, response_chars, error, meta}`

`task` is one of `suno_generate|wish_title|scene_storyboard|scene_image|scene_video|title_card|title_card_bg_remove|translate`.
`cost.amount` is `null` (never `0`) when the price or units needed to compute it
are unknown; `cost.source` is `provider|catalog|free|unknown`. A `google_free`
call always resolves to `amount: 0`/`source: 'free'` (a free-tier key, not a
discount), with `cost.saved_amount` carrying what it would have cost at the paid
rate so that figure is visible without polluting any spend total.

## Settings (`settings.json`)

`{lang, api_keys{replicate,google,google_free,fal,openrouter,deepseek,krea,google_translate,mureka}, text_models{favorites[],default},
simple_models{favorites[],default}, image_models{favorites[],default}, image_models_simple{favorites[],default},
video_models{favorites[],default}, video_wish_library[],
special_tags[], suno_base_prompt, suno_reference_examples[], suno_wish_library[],
scene_base_prompt_narrative, scene_base_prompt_abstract, scene_wish_library[], pricing_overrides{},
request_timeout_seconds, hide_motion_prompt, title_card_base_prompt, title_card_base_prompt_presets[],
title_card_wish_library[], background_remover_method, background_remover_local_params{bg,threshold},
background_remover_fal_params{model}, background_remover_params{background_type,format,threshold,reverse},
magic_layers_method, magic_layers_num_layers, magic_layers_fal_params{model,num_inference_steps,acceleration},
magic_layers_replicate_params{model},
outpaint_quality_mode, logos[], poster_templates[], music_tags[],
suno_base_prompt_user_presets[], mureka_base_prompt_user_presets[]}`

Reads and writes merge over `DEFAULT_SETTINGS` in
[`routers/settings.py`](../backend/app/routers/settings.py), so adding a key
there is enough — existing files keep loading. **`PUT` is a partial merge
server-side**, so the frontend can persist just `{suno_wish_library}` without
resending everything.

- **Model favorites lists** — `text_models` / `simple_models` / `image_models` /
  `image_models_simple` / `video_models` all share the shape
  `{favorites: {provider, id, label}[], default: "{provider}:{id}"}`. Accepted
  providers differ (`_MODEL_PROVIDERS` / `_IMAGE_MODEL_PROVIDERS` /
  `_VIDEO_MODEL_PROVIDERS` in `routers/settings.py`): text adds nothing beyond
  `google|google_free|openrouter|deepseek|replicate|fal`; image additionally
  accepts `krea`; video accepts only `google|google_free|openrouter`.
  `text_models.default` is what `suno.generate`/`scenes.generate` parse;
  `simple_models.default` drives `clean_wish_and_title` (no per-call picker
  anywhere); `image_models`/`image_models_simple` are a quality/cheap tier pair
  feeding the Images stage's `ModelPicker` via a tier toggle; `video_models` has
  no tier split.
- **Wish libraries** — `suno_wish_library`, `scene_wish_library`,
  `video_wish_library`, `title_card_wish_library` are four **separate** global
  lists of the same shape `{id, title, text, created_at, use_count?}`, all built
  by `wish_library.add_or_get_wish` parameterized by `library_key`. Each project
  toggles a subset of each on via its own `active_*_wish_ids`, so the same card
  can be active for one song and inactive for another. `text` and `title` are
  both produced by one `clean_wish_and_title` call on save — `text` is the
  **tidied** wish, not the raw input, and `title` a short emoji-prefixed label;
  with no model configured, `text` is kept as-is and `title` falls back to a
  local truncate. `use_count` is bumped client-side on every toggle-on and drives
  chip order (`lib/wishes.js`'s `sortByUseCount`; missing/`0` sorts last).
  Deleting a card is the same partial-`PUT`. Legacy plain-string entries are
  normalized on `GET /api/settings` (not rewritten to disk until the next save).
  `title_card_wish_library` is the one library with no Settings-screen UI — it's
  managed inline on the Title Card stage only.
- **Base prompts** — `suno_base_prompt`, `scene_base_prompt_narrative`/
  `_abstract`, `title_card_base_prompt` are each seeded from the matching
  `providers/*_prompt_defaults.py` and sent on every real (non-stub) call. See
  `architecture.md` for the layering, and for why editing a defaults constant
  does not affect an install that has already written settings once.
- **Prompt presets** — `GET /api/settings/suno-prompt-presets` serves a
  **read-only**, hardcoded list (`SUNO_BASE_PROMPT_PRESETS` +
  `MUREKA_BASE_PROMPT_PRESETS`, not part of `settings.json`) merged with the
  user-managed `suno_base_prompt_user_presets`/`mureka_base_prompt_user_presets`
  (`{id, name, prompt}[]`, converted to `{id, service, name, description: '',
  prompt}` on the way out) so both appear in the same picker.
  `title_card_base_prompt_presets` is likewise user-managed (`{id, name,
  prompt}[]`, seeded with 3 built-ins). All of these are plain client-side array
  CRUD through the partial-merge `PUT` — no dedicated endpoints, unlike the wish
  libraries, whose saves involve an LLM call.
- **`suno_reference_examples`** — curated example style+lyrics blocks sent
  alongside the base prompt as "reference, don't copy verbatim" material.
- **`background_remover_*`** — the Title Card stage's 3 interchangeable removal
  methods (see `architecture.md`), each with its own param group:
  `background_remover_method` is the default when no per-call `method` is passed
  (`'local'|'fal'|'replicate'`, default `'replicate'`);
  `background_remover_local_params` (`bg`: `'black'|'white'`, `threshold` 0-255)
  feeds the free pixel cutout; `background_remover_fal_params.model` picks
  between FAL's bria and rembg; `background_remover_params` feeds Replicate's
  model input directly (defaults match its own schema).
- **`magic_layers_*`** — the ✨ decomposition's defaults (see
  `architecture.md`): `magic_layers_method` (`'fal'|'replicate'`, default
  `'fal'`) and `magic_layers_num_layers` (default 4, clamped 2-10) are only
  fallbacks — the button passes both per click. `magic_layers_fal_params`
  (`model`, `num_inference_steps` 1-50, `acceleration`
  `none|regular|high`) and `magic_layers_replicate_params` (`model`) feed each
  host's request body.
- **`outpaint_quality_mode`** (`'fast'|'quality'`, default `'fast'`) — the
  default for the crop/outpaint editor's toggle, overridable per save.
- **`request_timeout_seconds`** (default 60) — caps a single outbound text-model
  call in `suno.py`/`scenes.py`/`text_models.py`.
- **`hide_motion_prompt`** — UI-only: hides every `motion_prompt` field and its
  translate button on the Scenes and Images stages. Doesn't touch any stored
  value. Autosaves immediately on toggle.
- **`music_tags`** — user-defined quality-review labels for Mureka tracks,
  `{id, label, color}[]`, global and plain-array CRUD'd through the partial-merge
  `PUT`. Seeded with 8 defaults (`DEFAULT_MUSIC_TAGS`). `color` is auto-assigned
  by list position from a fixed 10-hex palette (`MUSIC_TAG_COLORS` in
  `routers/settings.py`, **mirrored in `frontend/src/lib/musicTagColors.js` —
  keep both in sync**), never hand-picked, so two tags never collide visually;
  `GET /api/settings` backfills a `color` onto tags predating the field.
- **`logos`** — `[{id, name, file_path}]`, the global cross-project logo library
  for the Poster constructor (files under `app_data/logos/`, own endpoints) -
  also the source pool for `kind: 'logo'` Editor-stage overlays (see
  `VideoEdit.overlays[]` above).
- **`poster_templates`** — `[{id, name, layers{logo_id, logo[], glass, text[]},
  created_at}]`, reusable poster layouts, global like `logos` but no files, so
  plain array CRUD through the partial-merge `PUT`. `layers` deliberately omits
  `background_path`/`title_card_variant_id`/`title_card` layers — those belong to
  the poem the poster was built for.
- **`pricing_overrides`** — user price corrections keyed by
  `"{provider}:{model_id}"` (or `"{provider}:*"` as a whole-provider wildcard),
  same row shape as `pricing.BUILTIN_PRICING`. Saved via its own
  `PUT /api/usage/pricing`, **not** the general settings `PUT`, and therefore
  **not** part of the Settings screen's backup export/import (it has its own
  Export/Import on the Prices tab).
- **`api_keys.google_free`** is a second Google key: same models and calls as
  `google`, but always priced at `$0`/`source: 'free'` in the ledger.
- **Backup controls** (Settings, General and Providers tabs) export/import
  `api_keys` separately from every other settings field as downloadable JSON.
  Pure client-side file I/O — there is no `/export`/`/import` route; import just
  calls the existing `PUT /api/settings` with the parsed content.

## Model catalog (`model_catalog.json`)

`{text: {provider: {source, models, error?}}, image: {provider: {...}}, video: {provider: {...}}}` —
the last-known-good response of every `.../models/{provider}`,
`.../image-models/{provider}` and `.../video-models/{provider}` call, managed by
`storage.load_model_catalog`/`save_model_catalog`. `_remember_catalog_entry`
writes it only on a successful (non-`error`) fetch, **so a transient API failure
never overwrites a previously good list**. Read back by
`GET /api/settings/models-catalog` (the Models tab's initial state before
"Refresh models" is pressed) and by `routers/usage.py::_known_models()`, which
feeds `pricing.catalog_with_known_models` so the Prices tab lists every known
model even before it has a price.

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
| `GET /api/settings/models/{provider}` | `provider ∈ google\|google_free\|openrouter\|deepseek\|replicate\|fal` → `{provider, source: 'live'\|'curated'\|'error', models: [{id, name}], error?}`. Replicate/FAL are always curated. A non-`error` result is upserted into `model_catalog.json` |
| `GET /api/settings/image-models/{provider}` | Same shape, plus `krea` as a valid provider. Google filtered to `predict`-capable (Imagen); everything else curated. Also upserted into the catalog |
| `GET /api/settings/video-models/{provider}` | Same shape, `provider ∈ google\|google_free\|openrouter` only — Google filtered to `predictLongRunning` (Veo), OpenRouter via `GET /api/v1/videos/models`. Upserted under the catalog's own `'video'` key |
| `GET /api/settings/models-catalog` | → `{text: {provider: {...}}, image: {provider: {...}}}` — the persisted last-known-good result of every `.../models/{provider}` call so far (`storage.load_model_catalog()`), so the Settings tabs have something to show before a refresh |
| `GET /api/settings/mureka-billing` | → `{account_id, balance, total_recharge, total_spending, concurrent_request_limit, trace_id}` — passthrough of Mureka's `GET /v1/account/billing`. `balance`'s unit is undocumented upstream, so it's shown as-is; `502` if the call fails |
| `POST /api/settings/wish-library` | `{text, model?}` → `{suno_wish_library, wish}`. One `clean_wish_and_title` call (`model` = a `"{provider}:{model_id}"` composite applied to a throwaway settings copy, else the configured simple model) fills both `wish.text` and `wish.title`; no configured model degrades to `text` unchanged + a truncated title |
| `PATCH /api/settings/wish-library/{id}` | `{title?, text?}` → `{suno_wish_library, wish}`. Manual edit, no LLM call. `404` unknown id, `422` blank field |
| `POST /api/settings/scene-wish-library` / `PATCH .../{id}` | Same shape and behaviour, against `scene_wish_library` |
| `POST /api/settings/video-wish-library` / `PATCH .../{id}` | Same shape and behaviour, against `video_wish_library` |
| `POST /api/settings/logos` | multipart `file` (png/webp) + `name?` → `{logos}` — appends to the global `settings.logos`, file under `app_data/logos/` |
| `DELETE /api/settings/logos/{logo_id}` | → `{logos}` |
| `POST /api/projects/{id}/suno/generate` | `{skill_id, skill_prompt, model, active_wish_ids?}` → `{style, lyrics, skill_id, model_used, debug}`. `model` is the `"{provider}:{model_id}"` composite; `active_wish_ids` falls back to the project's own field and is sent as an emphasized block right after the base prompt. Real call when `provider ∈ google\|openrouter\|deepseek` **and** the key is set; a failed call is `502`, never a silent fallback. `debug` is `{stub: false, request, response, missing_markers}` or `{stub: true, reason: no_model_selected\|unsupported_provider\|no_api_key, requested_model}` |
| `POST /api/projects/{id}/suno/wishes` | `{text}` → `{wish, suno_wish_library, active_wish_ids}` — cleans+titles via `wish_library.add_or_get_wish` (reusing an existing card with the same text), then activates it for this project |
| `POST /api/projects/{id}/scenes/generate` | `{style_description, scene_count?, model?, scene_mode?, active_scene_wish_ids?}` → `{scenes, style_description, scene_mode, debug}` — **replaces all scenes**, clearing their images. `scene_mode ∈ narrative\|abstract` picks the matching `scene_base_prompt_*`. Same real-call / `502` / `debug` rules as `suno/generate`, plus `usage` in the debug payload |
| `POST /api/projects/{id}/scenes/wishes` | `{text}` → `{wish, scene_wish_library, active_scene_wish_ids}` — same as `suno/wishes`, against the scene library |
| `POST /api/projects/{id}/scenes/videos/wishes` | `{text}` → `{wish, video_wish_library, active_video_wish_ids}` — same again, against the video library. Project-level, not per-scene |
| `POST /api/projects/{id}/title-card/wishes` | `{text}` → `{wish, title_card_wish_library, active_title_card_wish_ids}` — same again, against the title-card library |
| `POST /api/projects/{id}/scenes/{n}/images` | `{count, model}` → `{job_ids}` — starts one background job per variant (`model` from `settings.image_models`/`image_models_simple`, provider ∈ `krea\|replicate\|fal\|google\|openrouter`) and returns immediately; each job appends its own image to `scenes[n].images` when it finishes, independent of polling. Also the Scenes stage's one-click preview (`count: 1`, cheap tier) |
| `GET /api/projects/{id}/scenes/{n}/images/jobs/{job_id}` | → `{status: 'pending'\|'completed'\|'failed', image: Image\|null, error: str\|null}`. Job state is in-memory only (see `architecture.md`) |
| `POST /api/projects/{id}/scenes/{n}/videos` | `{count?, model, motion_prompt?, image_id?, aspect_ratio?, resolution?, duration_seconds?, active_video_wish_ids?}` → `{job_ids}` — animates one scene image (`image_id`, else the scene's `is_selected` one; `422` if neither exists) with `motion_prompt` (defaults to the scene's own) plus resolved video wishes. `provider ∈ google\|google_free\|openrouter`. Same background-job shape as scene images |
| `GET /api/projects/{id}/scenes/{n}/videos/jobs/{job_id}` | → `{status, video: Video\|null, error: str\|null, debug: {request, response}\|null}`; in-memory-only job state |
| `DELETE /api/projects/{id}/scenes/{n}/videos/{video_id}` | → `{videos}` — removes one from `scene.videos` and deletes its file |
| `POST /api/projects/{id}/scenes/{n}/videos/upload` | multipart `file` (`.mp4\|.mov\|.webm\|.mkv`) → `{video}` — appends a hand-made clip to `scene.videos` with `model: 'upload'`, `cost: 0` and every generation-only field `null` (see `Video`). File-only, no pasted-URL variant; `415` on an unrecognized extension |
| `POST /api/projects/{id}/reference-images` | multipart `file` → `{reference_images}` |
| `DELETE /api/projects/{id}/reference-images/{filename}` | → `{reference_images}` |
| `GET /api/projects/{id}/video-export` | `?scenes=0,2,5` (comma-separated 0-based indices; omitted/`all` = every scene) → a zip. Per scene: the animate-source picture resolved as the Video stage does (`animate_image_id` → `is_selected` → first image → skip), written as `{scene_number:03d}_{motion_prompt_slug}.{ext}` with a **1-based** number, plus one `prompts.txt` of every included `motion_prompt`, blank-line separated, in scene order. A scene with no resolvable image is silently skipped. `404` if the project doesn't exist |
| `POST /api/projects/{id}/video-import-batch` | multipart `files` (`.mp4\|.mov\|.webm\|.mkv`) → `{assigned: [{filename, scene_index, video}], skipped: [{filename, reason}]}` — the reverse of `video-export`: each file is matched by the leading `{scene_number:03d}_` prefix on its **last path segment** (a folder upload may hand back `sub/008_clip.mp4`; `filename` in the response is still the unstripped original), 1-based number minus one giving `scene_index`. Matched files go through the same `video.save_uploaded_video` as the single upload. `reason ∈ unsupported_type\|no_scene_number\|scene_out_of_range` — a bad file is skipped, not a hard failure |
| `GET /api/projects/{id}/final-export` | → a zip: the Export stage's deliverable bundle (as opposed to `video-export`, which hands off *sources*). `videos/`: **every** `Video` across every scene, named `{5-rating}★_scene{n:03d}_{motion_prompt_slug}_{shortid}.mp4` — the inverted rating sorts the best first, `{shortid}` disambiguates candidates sharing a scene/prompt. `audio/`: the `is_selected` `MurekaTrack`'s `.mp3`, if any (no fallback). `title/`: every `TitleCardVariant` with `marked_for_export`, numbered `{i:02d}_{filename}`, falling back to the `is_selected` one when none are marked. Missing files are silently skipped |
| `POST /api/projects/{id}/editor/render` | optional `{range_start_ms, range_end_ms}` (both-or-neither) → `{job_id}`, reading `project.video_edit` as last `PATCH`ed. `422` if `clips` is empty or `mureka_track_id` is unset. Same background-job shape as images/video, but the work is a local `ffmpeg` call. With a range the `renders[]` entry is tagged `kind: 'test'` and only that window renders (`_trim_plan_to_range`); no body renders the full timeline (`kind: 'final'`) |
| `GET /api/projects/{id}/editor/jobs/{job_id}` | → `{status, render: Render\|null, error: str\|null}`; in-memory-only job state. On success the `render` entry is already appended to `video_edit.renders` server-side |
| `DELETE /api/projects/{id}/editor/renders/{render_id}` | → `{renders}` — removes one and deletes its file |
| `POST /api/projects/{id}/editor/overlay-videos` | multipart `file` → the new `overlay_video_sources[]` entry `{id, file_path, duration_seconds: null}`; `422` on an unsupported extension. The route appends under the project lock, not a separate `PATCH` round-trip |
| `DELETE /api/projects/{id}/editor/overlay-videos/{source_id}` | → `{overlay_video_sources}` — removes one and deletes its file |
| `POST /api/projects/{id}/title-card/generate` | `{text_block, base_prompt, reference_image_paths (1-4, must resolve inside the project folder and exist), model, aspect_ratio?, count?, active_title_card_wish_ids?}` → `{job_ids}`. `model` must be a reference-capable provider (see `architecture.md`); any other fails the job with a clear error rather than falling back |
| `GET /api/projects/{id}/title-card/jobs/{job_id}` | → `{status, variant: TitleCardVariant\|null, error: str\|null, debug: {request, response}\|null}`; in-memory-only job state. `debug` is redacted — image bytes replaced with `<... bytes>`, plain URLs kept |
| `DELETE /api/projects/{id}/title-card/variants/{variant_id}` | → `{variants}` — removes one and deletes its file |
| `POST /api/projects/{id}/title-card/variants/{variant_id}/remove-background` | `{method?}` (`'local'\|'fal'\|'replicate'`, defaults to `settings.background_remover_method`) → `{variant, variants, debug}` — **appends** the result as a new variant with `source_variant_id` pointing back at the original, which is left untouched. `404` unknown variant, `502` on a provider failure |
| `POST /api/projects/{id}/title-card/poster` | multipart: `file` (flattened PNG) + `background_path`, `title_card_variant_id`, `logo_id?`, `layers` (JSON), `canvas_size` (JSON), `poster_id?` → `{poster, posters}`. Creates a `Poster`, or re-renders one in place (same `file_path`) when `poster_id` matches. `422` if the two source ids don't resolve |
| `DELETE /api/projects/{id}/title-card/poster/{poster_id}` | → `{posters}` — removes one and deletes its file |
| `POST /api/projects/{id}/magic-layers` | `{source_path, num_layers?, method?, source_kind?}` → `{job_id}`. `source_path` must resolve inside the project folder and exist (`422`); `num_layers` clamped to 2-10, `method` to `fal\|replicate`, both falling back to `settings.magic_layers_*`. Background job — a decomposition runs 15-30s |
| `GET /api/projects/{id}/magic-layers/jobs/{job_id}` | → `{status, group: MagicLayerGroup\|null, error: str\|null, debug}`; in-memory-only job state. On success the group and its PNGs are already persisted |
| `DELETE /api/projects/{id}/magic-layers/{group_id}` | → `{magic_layer_groups}` — removes the group and its layer files. Posters referencing it keep their `layers.magic` entries, which then render nothing — deliberately not cascaded |
| `POST /api/projects/{id}/mureka/generate` | `{style, lyrics, model, n, gender?, reference_id?}` → `{job_id}` — one job per click (Mureka's own `n` of 1-3 returns several songs from a single task); `422` if `lyrics` is blank |
| `GET /api/projects/{id}/mureka/jobs/{job_id}` | → `{status, tracks: MurekaTrack[]\|null, error: str\|null, stage: str\|null, debug}`; in-memory-only job state. `stage` mirrors Mureka's own intermediate task status (`preparing\|queued\|running\|streaming`) while `status` is still `'pending'`. Shared with `/tracks/{id}/extend` |
| `DELETE /api/projects/{id}/mureka/tracks/{track_id}` | → `{tracks}` — removes one and deletes its `.mp3` |
| `POST /api/projects/{id}/mureka/reference-audio` | multipart `file` (mp3/m4a) → `{reference_audio}` — saves a local copy under `music/references/` **and** uploads it to Mureka's `files/upload` (`purpose=reference`) for the `mureka_file_id` usable as `reference_id`. `415` on a bad extension, `502` if the upload fails. Normally called with an already-trimmed clip from `/reference-sources/{id}/trim`, not a raw upload |
| `DELETE /api/projects/{id}/mureka/reference-audio/{ref_id}` | → `{reference_audio}` |
| `POST /api/projects/{id}/mureka/reference-sources` | multipart `file` (any decodable audio) → `{reference_sources}` — stages a raw upload under `music/reference-sources/` **without** touching Mureka, which hard-rejects reference audio under 30s; `415` on a bad extension |
| `DELETE /api/projects/{id}/mureka/reference-sources/{source_id}` | → `{reference_sources}` |
| `POST /api/projects/{id}/mureka/reference-sources/{source_id}/trim` | `{start_ms, end_ms}` → `{reference_audio}` — cuts `[start_ms, end_ms)` from the staged source via **ffmpeg** and forwards it through the same flow as `/reference-audio`, tagging the entry with `source_id`/`start_ms`/`end_ms`. `422` on an invalid range, `502` on an ffmpeg or Mureka failure (a missing `ffmpeg` surfaces here). The source stays in `reference_sources`, callable again for another clip |
| `POST /api/projects/{id}/mureka/tracks/{track_id}/extend` | `{lyrics, extend_at?, extend_type?, model?}` → `{job_id}` — real `song/extend`, same job/poll shape as `/mureka/generate`; `extend_at` defaults to the track's `duration_ms`. `422` if `lyrics` is blank or the track has no `raw.id` to extend from |
| `POST /api/projects/{id}/mureka/tracks/{track_id}/stem` | `{model?}` (`audio-separation-1\|2\|3`) → `{tracks}` — real `song/stem`, **synchronous** (unlike every other real Mureka call here); appends to the track's `stems[]`. `404` if the `.mp3` is missing, `502` on a provider failure |
| `POST /api/projects/{id}/mureka/tracks/{track_id}/describe` | no body → `{tracks}` — real `song/describe`, synchronous; sends the `.mp3` as a base64 data URI (same 10MB cap as `/stem`) and appends `{id, instrument[], genres[], tags[], description, created_at}` to `descriptions[]`. `404` if the `.mp3` is missing, `502` on failure |
| `POST /api/projects/{id}/mureka/tracks/{track_id}/transcribe` | no body → `{tracks}` — real `song/transcribe`, synchronous; keyed off `raw.id` rather than re-uploading audio, downloads the `.musicxml`+`.pdf` zip immediately (the CDN link expires) to `music/{id}.zip` and appends `{id, file_path, expires_at, created_at}` to `transcriptions[]`. `422` without a `song_id`, `502` on failure |
| `POST /api/projects/{id}/mureka/tracks/{track_id}/lyrics-video` | `{title?, aspect_ratio?}` (`∈ 16:9\|9:16\|3:4\|4:3`, Mureka defaults to `9:16`) → `{tracks}` — real `lyrics-video/generate`, synchronous; also keyed off `raw.id`, downloads the mp4 immediately to `music/{id}.mp4` and appends `{id, file_path, title, aspect_ratio, created_at}` to `lyrics_videos[]`. `title` defaults to the project's own. `422` without a `song_id`, `502` on failure |
| `POST /api/translate` | `{text, target_lang?}` (defaults to `ru`) → `{translated}`. Project-independent, never written back into the project. Google Cloud Translation v2 (Basic) with `settings.api_keys.google_translate`; a missing key or a failure is `502`, no silent fallback |
| `GET /media/<path>` | Static passthrough over `app_data/`; build URLs with `mediaUrl()` in `api/client.js` |
| `GET /api/usage/records` | Filters `project_id\|task\|provider\|model\|status\|date_from\|date_to\|limit\|offset` → `{records, total, limit, offset, totals}` |
| `GET /api/usage/summary` | Same filters + `group_by ∈ project\|task\|model\|provider\|day`, `tz_offset` → `{group_by, currency, groups[], totals}` |
| `GET /api/usage/today` | `tz_offset` → `{date, cost, currency, calls, unknown_cost_calls, saved_cost}` |
| `GET /api/usage/period-totals` | `tz_offset` → `{currency, today, week, month, total}`, each a `{calls, errors, cost, unknown_cost_calls, saved_cost}` object. `saved_cost` is what the bucket's `google_free` calls would have cost at the paid rate — informational, never added into `cost` |
| `GET /api/usage/pricing` / `PUT /api/usage/pricing` | Merged catalog `{pricing_version, currency, models[], overrides}` / body `{pricing_overrides}`, `422` on an invalid row. `models[]` also carries an unpriced row (`source: 'catalog'`) for every catalog model not priced yet, so the Prices tab lists everything the Models tab has seen |

Every generation route persists its result onto the project before returning,
so the client never has to `PATCH` afterwards — except the scene-images job
route, which returns `job_ids` immediately and persists each image
asynchronously when its background job completes (see `architecture.md`).

A `MurekaTrack`'s `rating`/`is_selected`/`tag_ids` have no dedicated route —
same convention as scene-image rating/selection — the frontend recomputes
the whole `project.mureka.tracks` array and sends it through the generic
`PATCH /api/projects/{id}` above.
