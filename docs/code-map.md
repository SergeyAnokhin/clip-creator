# Code map

Where to look when you need to change something. One short line per file —
**behavior** lives in [architecture.md](architecture.md), **data shapes and
routes** in [data-model.md](data-model.md), **cost tracking** in
[usage-tracking.md](usage-tracking.md).

Rule of thumb: find the file here, then read the file — its own module
docstring / header comment carries the detail that used to be in this table.

## Backend — [`backend/app/`](../backend/app/)

### Core

| File | Responsibility |
| --- | --- |
| `main.py` | FastAPI app, CORS (localhost regex), `/media` static mount, router registration, demo seed |
| `storage.py` | All disk I/O + `project_lock`. `APP_DATA_DIR` overrides the root. Slug redirects survive a project rename |
| `slug.py` | `(author, title)` → folder name = project `id` |
| `seed.py` | 3 demo projects, only when `app_data/projects/` is empty |
| `models.py` | Only `ProjectCreate` — every other payload is an untyped `dict` |
| `pricing.py` | Price catalog + cost math. Row kinds: `text`, `image`, `video`. Pure, no I/O |
| `usage.py` | AI usage ledger — append-only `app_data/usage/YYYY-MM.jsonl` |
| `console_log.py` | Colored dev-console lines for every provider call; called from `usage._write` so it can't disagree with the ledger |
| `request_log.py` | `RequestLogMiddleware` — one line per HTTP request, replaces uvicorn's access log |

### Routers — [`routers/`](../backend/app/routers/)

All share the `/api/projects` prefix and are thin: load project → call
provider → persist. Full route table in [data-model.md](data-model.md).

| File | Owns |
| --- | --- |
| `projects.py` | Project CRUD, `_split_into_blocks`, list projection. Renames the folder/`id` when title/author change |
| `settings.py` | `/api/settings` + model/image/video catalogs, wish libraries, logos, music tags, prompt presets. `DEFAULT_SETTINGS` lives here |
| `generation_common.py` | Shared by the four below: `_now`, `_resolve_reference_path`, allowed video extensions |
| `generation_music.py` | Suno prompt generation + every Mureka route (generate/poll/extend/stem/describe/transcribe/lyrics-video, reference audio + trimmer staging) |
| `generation_scenes.py` | Scene text, scene images (generate/poll/upload/crop), scene videos (generate/poll/upload), project reference images |
| `generation_title_card.py` | Title-card generate/poll/delete/remove-background + poster save/delete |
| `generation_export.py` | `/video-export`, `/video-import-batch`, `/final-export`, Editor-stage render start/poll/delete (optional `{range_start_ms, range_end_ms}` body → a test render), overlay-video upload/delete |
| `magic_layers.py` | `/magic-layers` start/poll/delete — decomposing one image into movable RGBA layers |
| `translate.py` | `POST /api/translate` — thin wrapper over `providers/translate.py` |
| `usage.py` | `GET /api/usage/records\|summary\|today\|period-totals`, `GET/PUT /api/usage/pricing` |

### Providers — [`providers/`](../backend/app/providers/)

"Real seam" = makes a real, billable API call. Each module's docstring names
its provider and quirks.

| File | Real seam | Does |
| --- | --- | --- |
| `suno.py` | Google / OpenRouter / DeepSeek | Poem → Suno style + lyrics. `_format_lyrics` mirrors `lib/lyrics.js`; `_build_prompt` mirrors `lib/sunoPrompt.js` — **keep both in sync** |
| `scenes.py` | Google / OpenRouter / DeepSeek | Lyrics → JSON scene storyboard; falls back to a chunked stub on a bad reply |
| `mureka.py` | Mureka API | Real audio: generate/poll/extend/stem/describe/transcribe/lyrics-video, reference upload, billing, `trim_audio` (shells out to **ffmpeg**) |
| `images.py` | Krea/Replicate/FAL/Google/OpenRouter | Scene images: job store, upload (SSRF-guarded URL fetch), `crop_image` (local crop or FAL outpaint) |
| `video.py` | Google Veo / OpenRouter | Image-to-video: job store (6s poll), `build_prompt`, `save_uploaded_video` |
| `title_card.py` | Google Nano Banana / Krea | Multi-reference image-to-image title cards + `remove_background` (Replicate, versioned endpoint) |
| `magic_layers.py` | FAL / Replicate (Qwen-Image-Layered) | Image → N inpainted RGBA layers: job store, both provider seams, and the pure `_postprocess` (upscale + alpha remap + background detection) |
| `editor.py` | — (local ffmpeg) | `build_render_plan` + `build_ffmpeg_command` (pure/testable when `build_render_plan`'s optional `project_dir` is omitted, the ~80-test default; `render_to_file` always passes it, wrapping the whole call in `asyncio.to_thread` since it may now shell out). With `project_dir`, a clip with a genuinely unknown length (`trim_end_ms: null` + unprobed `Video.duration_seconds` - an upload/import) gets one `ffprobe` fallback call (`_probe_duration_ms`, silently `None` on any failure) - without it, `xfade`'s `offset`/`fade_out`'s `st` can't be computed and a transition/fade_out touching that clip silently no-ops (a real bug against an all-uploads project, fixed 2026-08-19). Output canvas defaults to 1080×1920 unless some clip's own `aspect_ratio` is *explicitly* not `9:16` (an unprobed/`null` one - a manually uploaded clip - doesn't force landscape); `video_edit.canvas_orientation` (`'auto'`/`'portrait'`/`'landscape'`) overrides that heuristic outright. `_resolve_overlays` resolves/validates/clamps `video_edit.overlays[]` (title-card variant, global logo, or project-scoped `overlay_video_sources[]` video - `_migrate_overlay_position` upgrades an old 9-point-grid overlay on read, and separately rescales `height_pct` onto the `height_axis: 'width'` convention for anything saved before it existed); overlays composite via a chained ffmpeg `overlay` filter (independent width_pct/height_pct scale, **both** against canvas width so an overlay's real aspect ratio survives a `canvas_orientation` switch, `rotate=` for `rotation_deg` via a pad-to-double-then-rotate trick pivoting on the overlay's own top-left corner, `_overlay_alpha_filters` for flat opacity or chained `fade=...:alpha=1` in/out ramps - **not** a `colorchannelmixer` eval expression, confirmed unsupported against a real ffmpeg build), each on its own `enable='between(t,…)'` window; a video-kind overlay gets a real (non-looped) second input with `setpts`-shifted timestamps. `_resolve_fit`/per-clip filtergraph branch: `cover` (default) scale-up+crop via a `ceil(iw*max(...)*zoom)` expression, `contain` keeps the old scale+pad letterbox chain. `_TRANSITION_XFADE_NAME`/`_resolve_fade` resolve/clamp `EditorClip.transition_in`/`fade_in`/`fade_out`; `build_ffmpeg_command` chains clips pairwise (`xfade` at a transition boundary, plain `concat=n=2` at a hard cut) only when at least one clip has a `transition_in`. `_trim_plan_to_range` post-processes an already-resolved plan down to one time window (test/range render); `save_overlay_video_source` writes an uploaded overlay video into `editor/overlay_sources/`. `_run_ffmpeg_render` retries once (after a 1s sleep) when ffmpeg exits nonzero with **no** stdout/stderr at all - observed as Windows returncode `3221225794`/`0xC0000142` (`STATUS_DLL_INIT_FAILED`), a real-time-antivirus-scan pattern against the freshly spawned `ffmpeg.exe` rather than a real filtergraph failure, and gone on a second try almost every time |
| `translate.py` | Google Cloud Translation v2 | One-off prompt translation (separate key from Gemini) |
| `text_models.py` | Google / OpenRouter / DeepSeek | Model catalog + `clean_wish_and_title`; local fallback when no key |
| `image_models.py` | Google / OpenRouter | Image-model catalog; curated fallback for Replicate/FAL/Krea |
| `video_models.py` | Google / OpenRouter | Video-model catalog — only these two do image-to-video here |
| `fal_client.py` | — | `submit_poll_fetch`: the shared submit→poll→fetch skeleton for every FAL queue call |
| `wish_library.py` | — | `add_or_get_wish` — clean + title a wish and append it to a settings library |
| `url_parser.py` | — | httpx + BeautifulSoup → `{author, title, raw_text}` |
| `*_prompt_defaults.py` | — | Seed text and built-in presets for suno / mureka / scenes / title_card. Edited from Settings afterward, not here |

### Tests — [`backend/tests/`](../backend/tests/)

One `test_<module>.py` per provider/router. Every external call is `httpx`-mocked
and `asyncio.sleep` faked; `conftest.py` points `APP_DATA_DIR` at a tmp dir.
A handful of tests use a real local `ffmpeg` and `skipif` it isn't on `PATH`
(`test_mureka_provider.py`'s trim; `test_editor_provider.py`'s several -
rotation, per-clip cover/crop zoom, video overlay, overlay fades, a reversed
clip, a reversed video overlay, and a ranged/test render each get their own
real run, since a filtergraph string can look right and still fail ffmpeg's
own parser - this caught a real bug
during development: `colorchannelmixer`'s `aa` option turned out not to
support time-varying `t`-based expressions at all, only a real run surfaced
it).

## Frontend — [`frontend/src/`](../frontend/src/)

### Entry & shared

| File | Responsibility |
| --- | --- |
| `App.jsx` | Composition root only: navigation, hook wiring, per-stage prop bundles |
| `api/client.js` | One function per route + `mediaUrl(path)`. `VITE_API_URL` overrides the base |
| `i18n/dict.js` | `DICT.ru` / `DICT.en` — **add every key to both** |
| `styles/theme.css` | The whole visual system: palette vars + per-component classes. Grep the class name from the JSX |
| `components/Toast.jsx` | The single transient message |
| `components/UsagePill.jsx` | Header spend pill; click expands today/week/month/all-time |
| `components/MiniPlayerWidget.jsx` | Header "now playing" pill; renders nothing until a track has been started |
| `components/common/JsonTreeView.jsx` | Generic collapsible JSON viewer (no dependency) |
| `components/shared/CanvasLayer.jsx` | Generic "one draggable/resizable/rotatable object on a Konva stage" primitive - a Group+Transformer wrapper reporting its transform as percentages of a caller-supplied container box (`lib/canvasLayer.js`'s math), so a poster's static-image container and the Editor stage's dynamic live-video container can share it. `Transformer` has `keepRatio` (corner-drag resize stays locked to the content's natural aspect ratio). `showOutline` (opt-in) draws a thin dashed border around the content's own box when it isn't the current selection - `Transformer`'s own selection border already covers the selected case. Used by `PosterCanvasLayers.jsx`'s `OverlayImage` and `EditorPreview.jsx`'s `OverlayCanvasNode` |

### `lib/` — pure, tested modules

| File | Does |
| --- | --- |
| `lyrics.js` | Block/line transforms (function table at the bottom of this file) |
| `sunoPrompt.js` | `buildSunoPromptPreview` — client mirror of `suno.py`'s prompt builder; `groupPresetsByService` |
| `scenes.js` | `pickMainByRating`, `resolveAnimateImage` (which image the Video stage animates) |
| `titleCard.js` | `pickTopReferenceImages` — auto-fills the Title Card reference slots |
| `lyricsTiming.js` | Mureka `lyrics_sections` → karaoke line list, plus manual anchor re-timing. Handles untimed/partially-timed responses |
| `timeline.js` | Editor-stage timeline math: clip offsets, `findActiveClip`, `clampTrim`, plus the direct-manipulation helpers (`moveClip`, `dropIndexForStart`, `applyEdgeTrim`, `applyEdgeSpeed` - the Ctrl+drag "speed ramp" gesture, trim window untouched, only `speed` changes - `splitClipsAt`). Also the `TRANSITION_TYPES`/`FADE_COLORS`/default-duration constants shared by `TimelineTransitionInspector.jsx` and `TimelineClipInspector.jsx`'s fade rows - deliberately **not** any transition/fade *layout* math, since neither affects this file's back-to-back timeline math (see the file's own header comment for why); `nextSpeedPreset` - the 0.5/1/1.5/2× quick-cycle `EditorPreviewContextMenu.jsx`'s "Скорость" row steps through, wrapping past the last preset |
| `editorDefaults.js` | `buildDefaultClips`, `defaultMurekaTrackId` — the Editor stage's first-open seed. Also exports `EMPTY_VIDEO_EDIT`, the `{mureka_track_id: null, clips: [], overlays: [], overlay_video_sources: [], renders: [], canvas_orientation: 'auto'}` fallback shape shared by `useEditorStage.js` and `useEditorRender.js` |
| `canvasOrientation.js` | `resolveCanvasSize(clips, scenes, orientation)` — client-side mirror of `providers/editor.py`'s canvas-size pick (1920×1080 vs 1080×1920), display-only (same "preview approximates, server does the real math" convention as `useEditorPreview.js`); used by `EditorStage.jsx`'s canvas-size readout |
| `editorClipLabel.js` | `sceneLabel` — the "N. description" text shared by a timeline clip block's hover tooltip and the add-scene chips |
| `overlays.js` | Editor-stage overlay-track math (title-card/logo/video overlays over the video, their own free-floating track - see `docs/data-model.md`'s `VideoEdit.overlays[]`): `activeOverlaysAt`; `applyOverlayMove`/`applyOverlayEdgeResize` (drag = move in time, edge drag = resize, no source-window trim to stay inside unlike a clip); `migrateOverlay`/`defaultOverlayTransform` (old 9-point-grid overlay → free `x_pct`/`y_pct`/`width_pct`/`height_pct`/`rotation_deg`, mirrors `providers/editor.py`'s `_migrate_overlay_position`; also recovers an overlay corrupted by a since-fixed bug that wrote `CanvasLayer.jsx`'s own camelCase fields straight onto it; separately rescales `height_pct` onto the `height_axis: 'width'` convention - percentage of canvas width, same axis as `width_pct`, so an overlay's real aspect ratio survives a `canvas_orientation` switch - for anything saved before that convention existed); `overlayPatchFromCanvasLayer`/`canvasLayerHeightPct` (camelCase `CanvasLayer.jsx` onChange patch ↔ this file's snake_case fields at `EditorPreview.jsx`'s drag/resize boundary - `heightPct` gets an extra rescale between `CanvasLayer`'s own "percentage of container height" contract and this file's canvas-width-relative one, `overlayPatchFromCanvasLayer` also stamps `height_axis: 'width'` since the patch merges onto whatever's still on disk, which may predate the stamp); `assignOverlayLanes` (greedy interval-graph coloring - which display row each overlay gets when it time-overlaps another); `overlayOpacityAt` (the fade-in/fade-out ramp at a given playhead, mirrors `providers/editor.py`'s `_overlay_alpha_filters`) |
| `overlaySource.js` | `resolveOverlaySource` — an overlay's `{src, label}` display info (image URL, or a video overlay's raw file URL - fine as a CSS background or as `useVideoFirstFrame`'s input), shared by the timeline block, the inspector, and the live preview so all three agree on what a given overlay shows |
| `posterLayers.js` | Poster constructor's pure helpers: layer/effect factories (incl. `makeMagicLayer`), stored-poster normalization, `moveLayerInList`, `bestMagicLayerGroup` (also used by the `✨N` badge outside the constructor), center-snap and zoom-clamp math, `FONT_OPTIONS` |
| `canvasLayer.js` | `pctTransformToPixels`/`pixelsToPctTransform` — the pure math behind `components/shared/CanvasLayer.jsx`: converts a layer's stored `{xPct,yPct,widthPct,heightPct,rotationDeg}` (fractions of whatever container box a caller supplies) to/from Konva's own pixel-space `x/y/scaleX/scaleY/rotation` |
| `videoFrameRect.js` | `computeContentRect` — replicates `object-fit: contain`'s math in JS, to find where a `<video>`'s real (non-letterboxed) picture sits inside its container box; used by `EditorPreview.jsx` for the frame-bounds outline and to position the overlay Konva stage |
| `snapping.js` | `snapNodeToCanvas(node, containerW, containerH, effectiveScale)` — drag-time magnet snap for `EditorPreview.jsx`'s overlay canvas: checks the dragged Konva node's client-rect center/edges against the container's center/edges within a `CANVAS_SNAP_PX` screen-px threshold, mutates the node's `x()`/`y()` directly (no React state, so it doesn't spam re-renders mid-drag), and returns `{v, h}` guide-line coordinates (or `null`) for whichever axis snapped. Generalizes `lib/posterLayers.js`'s center-only `snapGroupToCenter` to edges too - same technique, independent implementation (the two canvases are otherwise unrelated) |
| `pricing.js` | Cost formatting/estimation for `text`/`image`/`video` kinds |
| `musicTagColors.js` | Tag palette — mirrors `routers/settings.py`'s `MUSIC_TAG_COLORS`, **keep in sync** |
| `videoModelLimits.js` | Hand-curated per-model duration/resolution limits. Informational only, never enforced |
| `wishes.js` | `sortByUseCount` |
| `format.js` / `debounce.js` / `download.js` | Date labels / `debounce(fn, ms)` / `downloadJSON` |
| `a11y.js` | Keyboard/ARIA helpers shared by the components: `onActivateKey` (Enter/Space twin of an `onClick`), `onBackdropClick` (close a modal only on a real backdrop click), `focusOnMount` (callback ref replacing `autoFocus`) — see [a11y.md](a11y.md) |

Tests: `lib/*.test.js` (Vitest). **Only `lib/` is covered — components and
hooks have no tests.**

### `hooks/` — where all state lives

Created in this order in `App.jsx`; each takes its dependencies as arguments,
so wiring is explicit and there is no context/provider indirection. Stage
hooks return `{ state, actions }`.

| Hook | Owns |
| --- | --- |
| `useToast` | The single transient message; every other hook depends on `showToast` |
| `useViewport` | Breakpoint + workflow sidebar |
| `useUsage` | Usage ledger + price catalog. Created **before** `useSettings` |
| `useMiniPlayer` | The one piece of state that outlives navigation: the "now playing" track + the `<audio>` props `App.jsx` spreads at its root |
| `useSettings` | Everything in `settings.json`: language, keys, model favorites, the four wish libraries, base prompts + presets, logos, poster templates, music tags |
| `useProjects` | Project list, open project, **and persistence** (`updateProject`, `flushPendingSave`); adopts a renamed `id` from the response |
| `useLyricsStage` | Block/line editing |
| `useSunoStage` | Skill prompt, wish toggling, prompt generation, per-call model |
| `useMurekaStage` | Real audio: inputs, generation job, rating/tags, reference audio + trimmer, extend/stem, billing |
| `useScenesStage` | Scene text, mode/count, scene wishes, per-scene cheap image preview |
| `useImagesStage` | Reference images, image variants, ratings, tier/model, upload, crop |
| `useTitleCardStage` | `project.title_card`: text block, 4 reference slots, wishes, generation, rating, background removal |
| `usePosterConstructor` | Poster modal open/save/delete/select-main. Separate from `useTitleCardStage` — posters composite, they don't call a model |
| `useMagicLayers` | `project.magic_layer_groups`: start a decomposition, poll it, delete a group. Shared by the Images stage, the Title Card gallery and the poster constructor |
| `useVideoStage` | Per-scene videos: one-scene-at-a-time nav, video wishes, generation, rating, folder import |
| `useExportStage` | Export stage: `marked_for_export` toggles + the zip download |
| `useEditorStage` | Editor stage: EDL seeding, clip/overlay/transition/fade mutations, the mutually-exclusive selections, and the undo/redo history that spans all of them - composes `useEditorPreview`/`useEditorRender` (below) for the two pieces that don't touch any of that (preview playback, the render job) and merges their state/actions back into the same public `{state, resetForProject, actions}` shape this hook always returned. Selection is a `selectedClipIds` `Set` (plain/Ctrl/Shift click and marquee release all go through `selectClip`/`setSelection`), plus `selectAll`/`duplicateClips`/`copyClips`/`pasteClips`/`removeClips` — copy/paste is in-memory (a ref) and same-project only, not the OS clipboard. Every `video_edit`-mutating action routes through `commitVideoEdit`, a `past`/`future` undo/redo history (`canUndo`/`canRedo`/`undo`/`redo`) that coalesces edits under 400ms into one step, mirroring `PosterConstructor.jsx`'s `commit()`. `resetClip` reverts one clip's trim/speed/reverse back to the full source, forward, at 1x; `setClipFit` patches its per-clip `fit`; `setClipReverse` toggles playback direction independent of speed. Overlays (`overlays` state is lazily migrated via `migrateOverlay` on every read) are managed by `addOverlay`/`setOverlayTiming`/`setOverlayTransform` (free x/y/w/h/rotation, partial patch)/`setOverlayOpacity`/`setOverlayReverse` (only meaningful for a `kind: 'video'` overlay)/`setOverlayFade`/`removeOverlay`, with its own single-select `selectedOverlayId`; `resolveOverlayNaturalAspect(overlayId, naturalW, naturalH)` corrects the square `width_pct`/`height_pct` placeholder `addOverlay` starts a *freshly created* overlay with (no image is loaded yet at creation time to know its real aspect ratio) once `EditorPreview.jsx`'s `OverlayCanvasNode` learns the source's actual pixel size - gated to only the overlay just created (via `pendingAspectFitOverlayIdRef`), so it never overwrites a later manual resize on an older overlay; `uploadOverlayVideo`/`deleteOverlayVideo` manage `overlayVideoSources` state directly (the backend route owns persistence for these, so they merge the API response into local state rather than going through `commitVideoEdit`). `setClipTransition`/`setClipFadeIn`/`setClipFadeOut` patch a clip's `transition_in`/`fade_in`/`fade_out`; `selectTransition` is a third single-select, `selectedTransitionClipId` (the *later* clip of the pair). All three selections - `selectedClipIds`, `selectedOverlayId`, `selectedTransitionClipId` - are mutually exclusive, each `select*` action clearing the other two |
| `useEditorPreview` | The in-browser preview engine, split out of `useEditorStage.js`: the rAF-clocked playhead, the shared `<audio>`/`<video>` sync (`applyActiveClip`/`tick`), `play`/`pause`/`seek`. Only reads `activeProject`/`timelineClips`/`scenes`/`selectedTrack`/`totalDurationMs` - no `video_edit` mutation or undo history here. Exposes `invalidatePreviewClip` (called by `useEditorStage.js` after any edit that changes which source frame sits under the playhead) and `resetPreview` (called from `resetForProject`) |
| `useEditorRender` | The render job, split out of `useEditorStage.js`: `startRender(options)` (`options.range` → a test render)/`deleteRender`/`downloadRender`, `renderLoading`/`renderError`/`elapsedSeconds`, mirrors `useVideoStage.js`'s generate/poll pattern. Only touches `activeProject`/`setActiveProject` for the resulting `renders[]` entry - independent of `video_edit`'s undo history |
| `useTimelineDrag` | `EditorTimeline.jsx`'s direct-manipulation gesture state machine, split out because it's self-contained: one `drag`/`dragDx` state pair and a single pointermove/pointerup effect resolve every drag (clip reorder/trim/speed-ramp, overlay move/resize, ruler scrub, marquee-select) into an `actions` call. The ruler has no gesture of its own - a click/drag there falls through to `startContentPointerDown`'s default scrub, same as anywhere else outside a track. The test-render range is picked in `TestRangeModal.jsx` instead (opened from `EditorStage.jsx`'s "Собрать тестовое видео" button), not by a ruler drag. Owns `contentRef` (the `.tl-content` element) since `pointerToMs` needs its bounding rect |
| `useClipThumbnails` | A timeline clip block's real video-frame thumbnails: samples interior midpoints of the clip's trimmed window, serialized through one shared hidden `<video>` (skips the reload when the same source is already loaded), cached module-level by video/trim/count. Thumbnail count grows with the block's rendered width (one roughly every `MIN_SLOT_PX`, capped at `MAX_THUMBS`) - crossing a count threshold re-fetches asynchronously and swaps the new frames in once decoded, which is what keeps a heavily zoomed-in block from stretching one thumbnail past its source resolution. Exports `MIN_SLOT_PX` so `TimelineClipBlock.jsx` knows when a block is wide enough to expect a thumbnail at all. Also exports `useVideoFirstFrame` (one first-frame thumbnail for an arbitrary video URL, sharing the same frame-grab queue/cache - used by `EditorPreview.jsx`'s video-overlay canvas node, which only needs a static still, not live playback) |
| `useVoice` | Web Speech API dictation. Created **last**. Also exports `useFieldVoice` for Settings |
| `useHtmlImage` | URL → `HTMLImageElement` via `fetch`+`blob:` (works around a Chrome cross-origin race) — `cache: 'no-store'` so it never shares an HTTP cache entry with a plain `<img src>` elsewhere pointed at the same URL (that collision silently failed the `fetch` with `net::ERR_FAILED`, confirmed live 2026-08 as the Editor stage's overlay canvas never rendering a logo whose picker thumbnail had already loaded). Used by the Poster constructor (once per fixed slot, plus once per magic layer via `MagicLayerNode`) and `EditorPreview.jsx`'s `OverlayCanvasNode` (each active overlay's image) |

### `components/home/`

`HomeScreen` + `Header`, `FilterChips`, `ProjectGrid`, `ProjectCard`,
`EmptyState`, `NewProjectModal`.

### `components/workflow/` — the nine stages

`WorkflowScreen` → `WorkflowHeader`, `Sidebar`, and one stage component each. The
whole app shell is a fixed `height: 100vh; overflow: hidden` column
(`App.jsx`'s `.app-shell` wrapper); `.workflow-main` (the column next to
`Sidebar`) is the one part that scrolls (`overflow-y: auto`). A stage that
wants to fill the viewport instead of scrolling — like the Editor stage,
`.workflow-main-inner.is-wide` in `theme.css` — sets its own height to 100%
of that column rather than relying on page scroll; every other stage just
scrolls normally inside it.

| File | Responsibility |
| --- | --- |
| `LyricsStage.jsx` | Block list; per-block UI in `BlockCard.jsx` (+ `TypeMenu`, `TagMenu`) |
| `SunoStage.jsx` | Base-prompt panel, per-song add-ons, wish chips, "what will be sent" preview, model picker |
| `MurekaStage.jsx` | Real audio generation + the full-width track list (player, rating, tags, details, actions) |
| `KaraokeLyrics.jsx` | Compact timed-lyrics panel under a playing track |
| `MurekaTrackDetailModal.jsx` | Fullscreen karaoke/timing editor for one track (manual anchors, tempo marks, hotkeys) |
| `MurekaDescribeModal.jsx` / `MurekaTranscriptionModal.jsx` / `MurekaLyricsVideoModal.jsx` | The three per-track Mureka side calls, one modal each |
| `ReferenceAudioTrimmer.jsx` | Waveform + ≥30s selection window; trims server-side before the reference ever reaches Mureka |
| `ScenesStage.jsx` | Scene text stage; per-scene UI in `SceneTextCard.jsx` |
| `ImagesStage.jsx` | Image stage; per-scene UI in `SceneCard.jsx` |
| `SceneTextCard.jsx` / `SceneCard.jsx` | One scene = prompt card + edge-to-edge image panel side by side |
| `ImageCarousel.jsx` | The image panel: contain-fit, all controls overlaid on the image itself |
| `ImageCropEditor.jsx` | Fullscreen crop/outpaint editor (scene images only) |
| `ImageLightbox.jsx` | Click-to-enlarge modal over an image array, keyboard paging |
| `TitleCardStage.jsx` | Title-card generation + `TitleCardGallery.jsx` + the poster constructor entry point |
| `TitleCardGallery.jsx` | All variants at once, each in its own aspect ratio; select/delete/rate/remove-bg |
| `PosterConstructor.jsx` | The poster editor modal: Konva stage, layer state, undo/redo, zoom, templates, save |
| `PosterCanvasLayers.jsx` | The overlay node types it renders (image, magic layer, glass panel, text). `OverlayImage`'s outer Group+Transformer (drag/resize/rotate) is the shared `components/shared/CanvasLayer.jsx` primitive - converts its own pixel-space `layer.x/y/scaleX/scaleY` to/from `CanvasLayer`'s percentage contract only at this boundary (`lib/canvasLayer.js`), poster's own stored schema unchanged. `OverlayGlass`/`OverlayText` still wire their own Group+Transformer directly (not yet ported) |
| `MagicLayersButton.jsx` | The ✨ button + its method/layer-count popup, shared by all three magic-layer entry points |
| `MagicLayersPreviewModal.jsx` | The `✨N` badge's drag-to-test sandbox for one already-decomposed group — nothing is saved |
| `PosterPanels.jsx` | Its side-panel widgets (effects, layer toolbar, glass/text panels, picker rows) |
| `PosterGallery.jsx` | Saved posters; select-main, delete, reopen for editing |
| `VideoStage.jsx` | Animation stage — **one scene at a time**; motion prompt, image pick, wishes, generation, batch export/import |
| `VideoGallery.jsx` | All candidate clips for the scene, hover-preview `<video>`s, resizable tiles |
| `VideoExportModal.jsx` | Scene picker for the batch export download |
| `ExportStage.jsx` | Picks what goes in the final zip and downloads it |
| `EditorStage.jsx` | App-style layout, not a scrolling page: program monitor fills the height left after the timeline (docked to the very bottom), and nothing else ever sits directly between them - `EditorTimeline.jsx` is the sole element right after `.editor-layout` closes. Instantiates `EditorFloatingTransport` (via `EditorPreview`) and `EditorSidePanel.jsx` (the CapCut-style tabbed right panel - see that row) rather than rendering panel content itself; owns the `toolsSlot` ref (`setToolsSlot`, threaded down as `EditorSidePanel.jsx`'s `onToolsSlotRef` prop) that `EditorTimeline.jsx` portals `EditorTimelineTools.jsx`'s remaining toolbar/pickers markup into - the actual target `<div>` lives inside `EditorClipSettingsTab.jsx` now (its own row), not a strip here. No header/title block above the monitor - removed to keep every pixel for the monitor/timeline, unlike every other stage's `stage-heading-title`/`subtitle`. Owns `testRange` (the test-render window - a render-time input, not part of `video_edit` - seeded from and persisted to `localStorage` per project, key `editorTestRange_{projectId}`) and threads it plus `onClearTestRange` down into `EditorTimeline.jsx`; also owns `waveformScale` (`'linear'\|'log'\|'sqrt'`, persisted to `localStorage` under `editorWaveformScale`, threaded through `EditorSidePanel.jsx`'s Клип tab for the control and down into `EditorTimeline.jsx`→`TimelineAudioTrack.jsx` for the actual redraw - lifted here rather than owned by the tab component itself, since both ends need it). Chrome is minimal by design (near-zero padding/gaps — see `.editor-preview`/`.tl-panel`/`.editor-layout` in `theme.css`) so the monitor/timeline get the space. Owns the fullscreen toggle (`isFullscreen` - a fixed-position `.editor-fullscreen` overlay over the whole viewport, not the browser Fullscreen API, closed by Esc or the same button) and the preview/side-panel split (`.editor-resizer` drag handle, width persisted to `localStorage` under `editorSideWidthPx`). Derives `titleCardVariants` from `project.title_card.variants` and `canvasSize` (`resolveCanvasSize`) and threads them plus `logos`/`overlayVideoSources` down into `EditorPreview`/`EditorTimeline` for overlay-source resolution and overlay-canvas sizing |
| `EditorSidePanel.jsx` | The right-hand panel's tab shell (CapCut-style, replacing the old single scrolling block stack): a `.chip`-based tab bar (same convention as `SettingsScreen.jsx`'s `.settings-tabs`) over 3 tabs - **Свойства объекта** (`EditorObjectPropertiesTab.jsx`), **Клип** (`EditorClipSettingsTab.jsx`), **Готовые видео** (`EditorRendersTab.jsx`) - plus `EditorBottomToolbar.jsx` pinned below them, visible regardless of which tab is active (split/undo/redo/render are frequent enough actions to stay reachable from any tab, unlike everything else). The **Клип** tab body, uniquely among the three, is always mounted (a wrapping `<div style={{display: activeTab === 'clip' ? undefined : 'none'}}>`, not `{activeTab === 'clip' && ...}`) - see `EditorClipSettingsTab.jsx`'s row for why. Owns exactly one new piece of state, `activeTab`, and two effects that auto-switch it by reading `useEditorStage.js`'s existing state rather than duplicating it: a selection-key comparison (`clip:<ids>`/`overlay:<id>`/`transition:<id>`/`none`, via `useRef`) that jumps to **Свойства объекта** whenever the key changes to something (not on deselect, so clearing a selection doesn't yank the user off their current tab), and a `videoEdit.renders.length` comparison (also via `useRef`) that jumps to **Готовые видео** whenever it grows (a test or final render just finished - length-increase-only, so a failed render doesn't also switch tabs) |
| `EditorObjectPropertiesTab.jsx` | The three-way inspector switch (overlay / transition / clip, and the `selectedClip`/`selectedOverlay`/`selectedTransitionClip` lookups that pick which one) - unchanged logic, relocated out of `EditorTimelineTools.jsx` into its own tab once the panel became tabbed |
| `EditorClipSettingsTab.jsx` | The **Клип** tab: first, `onToolsSlotRef` - the portal target `EditorTimeline.jsx` portals `EditorTimelineTools.jsx`'s toolbar (zoom/shortcuts/test-range/add-scene/add-overlay) into, so that content lives here instead of a strip between the monitor and the timeline (per the "nothing but the timeline itself ever sits under the monitor" layout rule - see `EditorStage.jsx`'s row). `EditorSidePanel.jsx` keeps this tab's whole body mounted at all times (hidden via inline `display: none` when another tab is active, not unmounted) specifically so this ref target survives a tab switch - the timeline toolbar's zoom/scroll state (owned by `EditorTimeline.jsx`) would otherwise have nowhere stable to portal into. Then: audio track `<select>` + duration-mismatch warning (moved verbatim out of the old `EditorStage.jsx` block), the canvas-size readout + auto/portrait/landscape orientation picker (`resolveCanvasSize`, `actions.setCanvasOrientation`, also moved verbatim), and the waveform-scale 3-chip picker (Линейный/дБ/Адаптивный) plus a 4th standalone chip toggling frequency-coloring (Цвет по частотам) - see `TimelineAudioTrack.jsx`'s row. Exports `WAVEFORM_SCALE_MODES` for `EditorStage.jsx`'s `localStorage` load/validate |
| `EditorRendersTab.jsx` | The **Готовые видео** tab: the renders list (a "тест"/"test" badge + range timecodes on a `kind:'test'` entry, download/delete), moved verbatim out of the old `EditorStage.jsx` block. No longer needs its old `.editor-side-renders` `flex:1`-avoidance comment verbatim, but keeps the class - still true that this must not carry its own `flex:1`/`overflow-y:auto` since it's inside `EditorSidePanel.jsx`'s own scrolling tab body |
| `EditorBottomToolbar.jsx` | The panel's bottom row, icon-only with a `title` tooltip each: split, undo, redo, test-render (opens `TestRangeModal.jsx`), final-render (`startRender({})`) - consolidates what used to be `EditorTimelineTools.jsx`'s toolbar buttons plus `EditorStage.jsx`'s separate footer CTAs into one row |
| `EditorFloatingTransport.jsx` | Rewind/play-pause/time display, rendered by `EditorPreview.jsx` as an absolutely-positioned overlay inside `.editor-preview-frame` instead of a static side-panel block - CSS-only hover/`:focus-within` reveal (`.editor-floating-transport` in `theme.css`), no JS hover state |
| `EditorPreview.jsx` | Program monitor: muted `<video>` synced to a hidden `<audio>` (approximate, not the real render — see `useEditorStage.js`), plus a dashed `.editor-frame-bounds` outline and a `react-konva` `Stage` both sized/positioned to exactly the **output canvas** (`canvasSize` prop, from `EditorStage.jsx`'s `resolveCanvasSize`) letterboxed to fit the frame (`lib/videoFrameRect.js`'s `computeContentRect`, reused against `canvasSize` instead of the `<video>`'s own natural size - tracked via a `ResizeObserver` + the `<video>`'s `loadedmetadata`) - **not** the currently playing clip's own content rect, since `providers/editor.py` always scales an overlay's `width_pct`/`height_pct` against the fixed canvas; anchoring the live Stage to the per-clip content rect instead used to store percentages in the wrong coordinate space, producing a visibly squished/stretched overlay in the real render whenever the visible clip's own aspect ratio didn't match the canvas (e.g. pillarboxed landscape footage on a portrait canvas). The dashed outline still shows the clip's own real (non-letterboxed) content rect, now computed *inside* the canvas rect - purely informational. Active overlays (`activeOverlaysAt`) each render as an `OverlayCanvasNode` on that Stage - a `components/shared/CanvasLayer.jsx` wrapping a Konva `Image` (a video-kind overlay uses `useVideoFirstFrame`'s static thumbnail, not live playback), draggable/resizable/rotatable directly here (`showOutline={!isPlaying}` keeps a faint dashed box around an unselected overlay - e.g. a hard-to-see logo - while paused, hidden during playback), `opacity` driven by `overlayOpacityAt(overlay, playheadMs)` for a live fade preview. `CanvasLayer`'s own `onChange` reports camelCase `{xPct,yPct,widthPct,heightPct,rotationDeg}` (shared with `PosterCanvasLayers.jsx`, whose model uses that casing) - converted to this overlay model's snake_case fields right here at the boundary before `actions.setOverlayTransform`, not passed through as-is (a prior bug that skipped this conversion is what `lib/overlays.js`'s `migrateOverlay` now has a recovery branch for). `OverlayCanvasNode` also reports the source image's real pixel size (once `useHtmlImage` loads it) up to `actions.resolveOverlayNaturalAspect` - see `useEditorStage.js`'s own entry for what that corrects. Dragging an overlay also runs it through `lib/snapping.js`'s `snapNodeToCanvas` (own row below) when `snapEnabled` (plain local `useState(true)`, a session UI preference, not part of `video_edit`) - drawn as a dashed guide `Line` on whichever axis snapped (`guides` state, reset on drag-end/commit), toggled by a magnet icon-button in the frame's corner. Also hosts the fullscreen toggle button and `EditorFloatingTransport.jsx` (its own row) as further frame-corner/-center overlays, and (right-click on the frame) `EditorPreviewContextMenu.jsx` |
| `EditorPreviewContextMenu.jsx` | Right-click menu for the program monitor - split/copy/paste/duplicate/quick-cycle-speed (`nextSpeedPreset`)/reverse-toggle/reset, for whichever clip `EditorPreview.jsx` resolved as the target (the single selected clip if there's exactly one, else whatever's under the playhead via `findActiveClip`). `position: fixed` at the click's own viewport coordinates; closes on Escape or a pointerdown outside itself. `Paste` is the only row not gated on a target clip, since `pasteClips` always appends to the timeline's own end regardless of where the menu was opened |
| `EditorTimeline.jsx` | The timeline layout: ruler, an overlay track (`TimelineOverlayBlock.jsx`, one row per lane - `lib/overlays.js`'s `assignOverlayLanes`, track height grows with lane count) above the clip row (`TimelineClipBlock.jsx`), both drawn to scale, playhead, zoom - owns the scroll/zoom DOM state (`scrollRef`, `viewportWidth`/`zoomPxPerMs`/`scale`, the ctrl+wheel listener, the scroll-restore-on-zoom layout effect) and lays out the rows; the gesture state machine itself is `useTimelineDrag.js` and the portaled side-panel content is `EditorTimelineTools.jsx` (both split out of this file - see their own rows). Drag = reorder, edge drag = trim, **Ctrl/Cmd+edge drag = speed ramp instead** (whichever modifier was held at drag-start decides the gesture for the whole drag), ruler or background drag = scrub, razor = split. The ruler also shows a thin `.tl-test-range-tick` marker (confined to the ruler's own height, `pointer-events: none`) for the currently picked test-render range - picked via `TestRangeModal.jsx`, not a ruler gesture. Selection is multi-clip (`selectedClipIds`, a `Set`, owned by `useEditorStage.js`): plain click replaces it, Ctrl/Cmd+click toggles a clip, Shift+click range-selects from the last click, and dragging over empty timeline background (or anywhere while holding Shift/Ctrl, since clips tile the row edge to edge with no gaps to drag from) marquee-selects everything the rectangle overlaps - the overlay track is excluded from that background-click marquee trigger, since overlays are single-select only. Ctrl+A/D/C/V select-all/duplicate/copy/paste and Delete/Backspace all act on the whole selection (or the selected overlay/transition). A `TimelineTransitionMarker` sits on every boundary between two clips wide enough to show one (`MIN_CLIP_WIDTH_FOR_TRANSITION_PX = 28` - narrower and the 16px marker would sit on top of the clip block itself and block clicking it); clicking it opens `TimelineTransitionInspector.jsx`. Desktop-oriented by design: layout adapts down to mobile/tablet widths, but the drag/trim/marquee gestures themselves are mouse-only — no touch adaptation (clips are keyboard-operable via Tab/arrows/Enter as a mouse alternative, not a touch one) |
| `EditorTimelineTools.jsx` | `EditorTimeline.jsx`'s portaled toolbar-strip content, split out purely to keep the timeline file to "timeline layout" - now just what's left after split/undo/redo and the object inspector moved into `EditorBottomToolbar.jsx`/`EditorObjectPropertiesTab.jsx` (`EditorSidePanel.jsx`'s tab shell): the zoom cluster (`onZoomIn`/`onZoomOut`/`onZoomFit` callback props, not a raw `applyZoom` + `ZOOM_FACTOR`, so this component doesn't need to know the zoom factor) + shortcuts button, a test-range readout (timecodes + clear button, shown only when `testRange` is set), the add-scene-chips row (plus an "add all variants" chip, shown whenever any scene has a video variant not yet on the timeline, that calls `actions.addAllSceneClips()` to append every unused video from every scene - not just the selected one per scene - in one undo step, each scene's own variants landing back-to-back in selected-first order), and the add-overlay `PickerRow` (title-card variants, logos, `overlay_video_sources[]` thumbnails, and an upload button that calls `actions.uploadOverlayVideo` then `addOverlay('video', ...)`). Purely presentational - every value is a prop, every edit goes through `actions` |
| `TimelineClipBlock.jsx` | One clip block: real sampled frames from its own trimmed window (`useClipThumbnails`) over the scene's static image as a load-in-progress placeholder, no text. A `.tl-clip.is-loading` pulse shows while a block wide enough for at least one thumbnail (`useClipThumbnails`'s `MIN_SLOT_PX`) is still decoding. Split out of `EditorTimeline.jsx`'s `clips.map()` because a hook can't be called from inside a loop |
| `TimelineOverlayBlock.jsx` | One block on the overlay track - the overlay's own source image (already static, no frame sampling needed; a video overlay's raw file URL just silently shows no background image) as its background, free-floating (no back-to-back layout, no source-window trim - just drag-to-move and edge-drag-to-resize). `top`/`height` place it on its own lane row when it time-overlaps another overlay (`EditorTimeline.jsx`'s `assignOverlayLanes` call) |
| `TimelineAudioTrack.jsx` | The timeline's audio row — decoded waveform `<canvas>` on the same px/ms scale. Each bucket stores peak *and* RMS (a cheap one-pole band split also gives bass/mid/treble energy per bucket); drawn as two layers, a faint outer peak shape and a solid inner RMS shape (RMS reads as rhythm, peak alone only catches transients). `scaleMode` prop (`'linear'`\|`'db'`\|`'adaptive'`, default `'linear'`, from `EditorStage.jsx`'s `waveformScale`/`EditorClipSettingsTab.jsx`'s picker, `applyScale`) reshapes both layers' heights - `db` maps amplitude through a dB/floor curve (`DB_FLOOR`), `adaptive` normalizes each bucket against its own local neighborhood (`ADAPTIVE_WINDOW`) instead of the whole track, so dynamics stay visible in both quiet and loud sections. `colorByFrequency` prop (from the same tab's standalone toggle) additionally tints every bar by its bass/mid/treble share instead of the flat accent color. None of this touches the decode/`PEAK_BUCKETS` pipeline itself |
| `TimelineClipInspector.jsx` | Exact values for an exact single clip selection: video variant, trim, speed (plus a **reverse** toggle button right next to the speed field - plays the trimmed window back to front, independent of speed), a **Кадрирование** (framing) section (`ClipFitRow` - cover/contain toggle, and when cover, zoom/offset-X/offset-Y sliders reusing `EffectSlider`, patching `clip.fit`), fade in/out (`FadeRow` - a duration field, 0 = off, plus a black/white swatch pair that both picks the colour and turns the fade on if it was off), reset (back to full source, forward, at 1x, disabled once already default), remove. Each row gets its own full-width row (`.tl-inspector-row`) rather than cramming into one flex line, for legibility. `FadeRow`/`ClipFitRow` are top-level components (not nested inside this one) specifically so React doesn't remount their `<input>`s - and drop focus - on every keystroke. A 0 or 2+ clip selection shows an empty hint / a "N selected" summary with bulk duplicate+remove instead — see `selectedCount`/`selectedClipIds` |
| `TimelineTransitionMarker.jsx` | The small clickable circle sitting on the boundary between two clips - `+` (no transition yet) or a filled `Zap` (one is set); the exact type only shows once the inspector is open |
| `TimelineTransitionInspector.jsx` | Properties strip for the selected clip boundary: a type chip row (`none` sits among the real types - picking it *is* "remove the transition", no separate delete button) plus a duration field once a real type is picked |
| `TimelineOverlayInspector.jsx` | Numeric precise-entry fallback for the selected overlay (the actual placement UI is dragging/resizing it on the program monitor, see `EditorPreview.jsx`'s `CanvasLayer`, which keeps the natural aspect ratio locked): read-only source label (`resolveOverlaySource`), start/end in seconds, X/Y number fields, one **Масштаб**/scale slider that moves `width_pct`+`height_pct` together by the same factor (`setOverlayTransform`) rather than two independent width/height sliders (which used to let them drift apart and distort the overlay), rotation/opacity sliders, fade-in/fade-out number fields (`setOverlayFade`), a **reverse** toggle shown only for a `kind: 'video'` overlay (`setOverlayReverse` - meaningless for a still image), remove |
| `KeyboardShortcutsModal.jsx` | Static reference list of every keyboard/pointer binding the Editor stage actually has (playback, navigation, selection/editing, undo/redo history, overlay lane, transitions) — same `.modal-backdrop`/`.modal-card` shell as `MurekaTrackDetailModal.jsx` and friends, opened from `EditorTimeline.jsx`'s toolbar |
| `TestRangeModal.jsx` | Picks the `{startMs, endMs}` test-render window - mm:ss From/To number-input pairs, opened by `EditorStage.jsx`'s "Собрать тестовое видео" button. Same `.modal-backdrop`/`.modal-card` shell as `KeyboardShortcutsModal.jsx`/`ReferenceAudioTrimmer.jsx` |
| `ModelPicker.jsx` | `<select>` over a favorites list → `"{provider}:{id}"` composite |
| `TranslateButton.jsx` / `CopyButton.jsx` | Small self-contained utility buttons under a prompt field |
| `Sidebar.jsx` | Stage nav + per-stage completion icon. Rows are `div.stage-row`, **not** `<button>` — see the file's comment before automating clicks |

### `components/settings/`

| File | Responsibility |
| --- | --- |
| `SettingsScreen.jsx` | Shell only: header, tab bar, model catalogs, save button |
| `GeneralTab.jsx` | Language, request timeout, settings backup export/import |
| `ProvidersTab.jsx` | API keys (+ their own backup), the 3 background-removal methods, outpaint mode |
| `ModelsTab.jsx` | The 5 model-favorites panels |
| `PromptsTab.jsx` | Special tags, music tags, prompt presets, base prompts, reference examples |
| `WishesTab.jsx` | The music / scene / video wish libraries |
| `LogosTab.jsx` | Global logo library the poster constructor picks from |
| `modelProviders.js` | Which providers each favorites panel offers |
| `ModelFavorites.jsx` | Favorites list + default picker + catalog search, shared by all 5 panels |
| `PricingPanel.jsx` | Prices tab — editable catalog + overrides |
| `BasePromptPresetEditor.jsx` | Name + text list editor, used twice (Suno / Mureka user presets) |

### `components/usage/`

`UsageScreen` + `UsageFilters`, `UsageSummary`, `UsageTable` — the cost ledger
screen, see [usage-tracking.md](usage-tracking.md).

## `lib/lyrics.js` functions

| Function | Does |
| --- | --- |
| `compileLyrics(blocks)` | `blocks` → `{type, content}` segments |
| `formatLyrics(segments, typeLabel)` | Segments → Suno text. `interlude` emits raw content (no `[Label]` wrapper) |
| `moveBlock` / `moveBlockToEdge` | Reorder by one step / jump to start-end |
| `moveToEdgeForType` | `intro`→start, `outro`→end |
| `splitBlockAtLine` / `splitBlockEveryN` | Split a block at one line / into groups of N |
| `cloneBlockWithType` | Copy a block under a new type |
| `repeatChorusAfterVerses` | One-shot: insert a chorus clone after every verse |
| `insertBlockAdjacent` | Insert a tag block before/after a block |
| `setLine` / `duplicateLine` / `deleteLine` / `toggleLineBrackets` | Single-line edits inside a block |
