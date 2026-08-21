# Code map

Where to look when you need to change something. One short line per file —
**behavior** lives in [architecture.md](architecture.md), **data shapes and
routes** in [data-model.md](data-model.md), **cost tracking** in
[usage-tracking.md](usage-tracking.md).

Rule of thumb: find the file here, then read the file — its own module
docstring / header comment carries the detail that used to be in this table.

**Keep every cell under ~250 characters.** This file is an index, read in full
on every orientation pass; implementation detail belongs in the file itself,
where it is only paid for when that file is opened. When a change needs more
explanation than one line, put it in the source file's header, not here.

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
| `editor.py` | — (local ffmpeg) | The Editor seam's public face: job store, `render_to_file`, `save_overlay_video_source`, and re-exports of the two below — callers import this one module. **Subsystem overview in its docstring** |
| `editor_plan.py` | — | EDL → render plan: resolve/validate/clamp clips, fit, adjust, freeze, overlays, transitions, fades, audio, export. Pure unless a `project_dir` is passed (`ffprobe` fallback, text rasterization). Also `_trim_plan_to_range` (test renders) |
| `editor_ffmpeg.py` | — | Plan → ffmpeg: `build_ffmpeg_command` (the only place that knows filtergraph syntax) and `_run_ffmpeg_render` |
| `translate.py` | Google Cloud Translation v2 | One-off prompt translation (separate key from Gemini) |
| `text_models.py` | Google / OpenRouter / DeepSeek | Model catalog + `clean_wish_and_title`; local fallback when no key |
| `image_models.py` | Google / OpenRouter | Image-model catalog; curated fallback for Replicate/FAL/Krea |
| `video_models.py` | Google / OpenRouter | Video-model catalog — only these two do image-to-video here |
| `fal_client.py` | — | `submit_poll_fetch`: the shared submit→poll→fetch skeleton for every FAL queue call |
| `wish_library.py` | — | `add_or_get_wish` — clean + title a wish and append it to a settings library |
| `url_parser.py` | — | httpx + BeautifulSoup → `{author, title, raw_text}` |
| `*_prompt_defaults.py` | — | Seed text and built-in presets for suno / mureka / scenes / title_card. Edited from Settings afterward, not here |

### Tests — [`backend/tests/`](../backend/tests/)

One `test_<module>.py` per provider/router, each mirroring its source file's
own split:

| Tests | Cover |
| --- | --- |
| `test_editor_plan.py` / `test_editor_ffmpeg.py` / `test_editor_provider.py` | Plan resolution / the built command / job store + real-ffmpeg integration. Shared builders in `editor_fixtures.py` |
| `test_generation_{scenes,music,title_card,export}.py` | The matching `routers/generation_*.py` (title_card also covers `routers/magic_layers.py`). Shared fakes/pollers in `generation_fixtures.py` |

Every external call is `httpx`-mocked
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
| `components/shared/CanvasLayer.jsx` | Generic "one draggable/resizable/rotatable object on a Konva stage" (Group+Transformer), transform reported as percentages of a caller-supplied box (`lib/canvasLayer.js`). Shared by `PosterCanvasLayers.jsx` and `EditorPreview.jsx` |

### `lib/` — pure, tested modules

| File | Does |
| --- | --- |
| `lyrics.js` | Block/line transforms (function table at the bottom of this file) |
| `sunoPrompt.js` | `buildSunoPromptPreview` — client mirror of `suno.py`'s prompt builder; `groupPresetsByService` |
| `scenes.js` | `pickMainByRating`, `resolveAnimateImage` (which image the Video stage animates) |
| `titleCard.js` | `pickTopReferenceImages` — auto-fills the Title Card reference slots |
| `lyricsTiming.js` | Mureka `lyrics_sections` → karaoke line list, plus manual anchor re-timing. Handles untimed/partially-timed responses |
| `timeline.js` | Editor timeline math: clip offsets, `findActiveClip`, `clampTrim`, `moveClip`/`dropIndexForStart`/`applyEdgeTrim`/`applyEdgeSpeed`/`splitClipsAt`/`nextSpeedPreset`, plus the shared `TRANSITION_TYPES`/`FADE_COLORS` constants. Deliberately no transition *layout* math — see the file header |
| `editorDefaults.js` | `buildDefaultClips`, `defaultMurekaTrackId`, `EMPTY_VIDEO_EDIT` — the Editor stage's first-open seed |
| `canvasOrientation.js` | `resolveCanvasSize(clips, scenes, orientation)` — display-only mirror of `providers/editor_plan.py`'s canvas-size pick, **keep in sync** |
| `editorClipLabel.js` | `sceneLabel` — the "N. description" text shared by a timeline clip block's hover tooltip and the add-scene chips |
| `overlays.js` | Overlay-track math: `activeOverlaysAt`, `applyOverlayMove`/`applyOverlayEdgeResize`, `migrateOverlay`/`defaultOverlayTransform`, `overlayPatchFromCanvasLayer`, `assignOverlayLanes`, `overlayOpacityAt`. Mirrors `editor_plan.py`'s `_migrate_overlay_position`/`_overlay_alpha_filters`, **keep in sync** |
| `overlaySource.js` | `resolveOverlaySource` — an overlay's `{src, label}` display info, shared by the timeline block, the inspector and the preview so all three agree |
| `posterLayers.js` | Poster constructor's pure helpers: layer/effect factories, stored-poster normalization, `moveLayerInList`, `bestMagicLayerGroup`, snap/zoom math, `FONT_OPTIONS` |
| `canvasLayer.js` | `pctTransformToPixels`/`pixelsToPctTransform` — the pure math behind `components/shared/CanvasLayer.jsx` |
| `videoFrameRect.js` | `computeContentRect` — `object-fit: contain` math in JS: where a `<video>`'s real picture sits inside its container box |
| `snapping.js` | `snapNodeToCanvas` — drag-time magnet snap for the program monitor's overlay canvas; mutates the Konva node directly and returns `{v, h}` guide coords |
| `timelineSnap.js` | Time-axis counterpart to `snapping.js` (CapCut's Track Magnet): `buildSnapTargets`/`snapMs`/`snapDelta`. Pure — `useTimelineDrag.js` decides *whether* to snap |
| `beats.js` | `detectBeats` — cheap onset detection over the bass envelope `hooks/useAudioPeaks.js` already computed; feeds `useEditorStage.js`'s `setBeatMarkers` |
| `pricing.js` | Cost formatting/estimation for `text`/`image`/`video` kinds |
| `musicTagColors.js` | Tag palette — mirrors `routers/settings.py`'s `MUSIC_TAG_COLORS`, **keep in sync** |
| `videoModelLimits.js` | Hand-curated per-model duration/resolution limits. Informational only, never enforced |
| `wishes.js` | `sortByUseCount` |
| `format.js` / `debounce.js` / `download.js` | Date labels / `debounce(fn, ms)` / `downloadJSON` |
| `a11y.js` | `onActivateKey`, `onBackdropClick`, `focusOnMount` — see [a11y.md](a11y.md) |

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
| `useEditorStage` | Editor stage: EDL seeding, clip/overlay/transition/fade/marker mutations, the mutually-exclusive selections, and the undo/redo history spanning all of them. Composes `useEditorPreview`/`useEditorRender` |
| `useEditorPreview` | Preview engine split out of `useEditorStage.js`: rAF-clocked playhead, `<audio>`/`<video>` sync, `play`/`pause`/`seek`. Read-only on `video_edit` |
| `useEditorRender` | Render job split out of `useEditorStage.js`: `startRender(options)` (`options.range` → a test render)/`deleteRender`/`downloadRender`. Same generate/poll pattern as `useVideoStage.js` |
| `useTimelineDrag` | `EditorTimeline.jsx`'s gesture state machine: one `drag`/`dragDx` pair and one pointermove/pointerup effect resolve every drag (clip reorder/trim/speed-ramp, overlay move/resize, ruler scrub, marquee, markers) |
| `useAudioPeaks` | Decodes the selected track once (Web Audio) into `PEAK_BUCKETS` × `{peak, rms, bass, mid, treble}`. Shared by `TimelineAudioTrack.jsx` and `lib/beats.js` |
| `useClipThumbnails` | A clip block's real video-frame thumbnails: interior midpoints of the trimmed window, serialized through one shared hidden `<video>`, cached module-level by video/trim/count |
| `useVoice` | Web Speech API dictation. Created **last**. Also exports `useFieldVoice` for Settings |
| `usePosterHistory` | The Poster constructor's undo/redo: `past`/`future` stacks, the coalescing `commit` every mutation runs through, and Ctrl/Cmd+Z / Ctrl/Cmd+Y. Document-agnostic — the caller supplies `currentDoc`/`applyDoc` |
| `usePosterViewport` | The Poster constructor's view transform: display budget (windowed vs fullscreen), fit scale, zoom/pan, overflow margin. Pure view state, never the document |
| `useHtmlImage` | URL → `HTMLImageElement` via `fetch`+`blob:` with `cache: 'no-store'` — works around a Chrome cross-origin race, see the file header |

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
| `PosterCanvasLayers.jsx` | The overlay node types (image, magic layer, glass panel, text); `OverlayImage` wraps the shared `components/shared/CanvasLayer.jsx` primitive |
| `MagicLayersButton.jsx` | The ✨ button + its method/layer-count popup, shared by all three magic-layer entry points |
| `MagicLayersPreviewModal.jsx` | The `✨N` badge's drag-to-test sandbox for one already-decomposed group — nothing is saved |
| `PosterPanels.jsx` | Its side-panel widgets (effects, layer toolbar, glass/text panels, picker rows) |
| `PosterGallery.jsx` | Saved posters; select-main, delete, reopen for editing |
| `VideoStage.jsx` | Animation stage — **one scene at a time**; motion prompt, image pick, wishes, generation, batch export/import |
| `VideoGallery.jsx` | All candidate clips for the scene, hover-preview `<video>`s, resizable tiles |
| `VideoExportModal.jsx` | Scene picker for the batch export download |
| `ExportStage.jsx` | Picks what goes in the final zip and downloads it |
| `EditorStage.jsx` | App-style layout: the program monitor fills whatever height is left after the bottom-docked `EditorTimeline.jsx`, with nothing between them. Wires the side panel, the modals and the canvas-size readout |
| `EditorSidePanel.jsx` | The right-hand 3-tab shell (Свойства объекта / Клип / Готовые видео) plus `EditorBottomToolbar.jsx`. Keeps the **Клип** tab's body mounted at all times (CSS-hidden) so the timeline's portal target survives a tab switch |
| `EditorObjectPropertiesTab.jsx` | The four-way inspector switch (audio / overlay / transition / clip) and the lookups that pick which one |
| `TimelineAudioInspector.jsx` | Properties strip when the audio row is the selected object — volume, fades and track offset, mapping 1:1 onto `video_edit.audio` |
| `EditorClipSettingsTab.jsx` | The **Клип** tab: `onToolsSlotRef` (the portal target for `EditorTimelineTools.jsx`) plus the project-level pickers — audio track, canvas size/orientation, waveform display scale |
| `EditorRendersTab.jsx` | The **Готовые видео** tab: the renders list, with a "тест" badge + range timecodes on a `kind:'test'` entry, download/delete |
| `EditorBottomToolbar.jsx` | Icon-only bottom row (a `title` tooltip each): split, undo, redo, test render (`TestRangeModal.jsx`), final render. Visible whichever tab is active |
| `EditorFloatingTransport.jsx` | Rewind/play-pause/time, positioned over the monitor by `EditorPreview.jsx`; CSS-only hover reveal (`.editor-floating-transport`) |
| `EditorPreview.jsx` | Program monitor: muted `<video>` synced to a hidden `<audio>` (approximate, not the real render), plus a dashed frame outline and a `react-konva` `Stage` sized to the output canvas for direct overlay placement. Hosts the context menu and floating transport |
| `EditorPreviewContextMenu.jsx` | Right-click menu for the monitor: split / copy / paste / duplicate / speed cycle / reverse / reset, against whichever clip `EditorPreview.jsx` resolved as the target |
| `EditorTimeline.jsx` | Timeline layout — ruler + markers, overlay track (one row per lane), clip row, audio row, playhead, zoom. Owns the scroll/zoom state and portals its own toolbar out via `EditorTimelineTools.jsx` |
| `EditorTimelineTools.jsx` | The portaled toolbar-strip content: timecode, magnet toggle, zoom, markers, shortcuts button, test-range chip, add-scene chips, add-overlay picker |
| `TimelineClipBlock.jsx` | One clip block: real sampled frames from its own trimmed window (`useClipThumbnails`) over the scene's static image as a load-in-progress placeholder |
| `TimelineOverlayBlock.jsx` | One block on the overlay track — free-floating (drag to move, edges to resize; no back-to-back layout, no source-window trim) |
| `TimelineMarker.jsx` | One marker flag on the ruler (`video_edit.markers[]`) — drag to move (snapped), double-click to rename, right-click or Delete to remove |
| `TimelineAudioTrack.jsx` | The audio row: decoded waveform `<canvas>` on the timeline's px/ms scale, peak + RMS layers and an optional frequency tint. Display scale/colour are `localStorage` view prefs only, never touching the decode pipeline |
| `TimelineClipInspector.jsx` | Exact values for a single selected clip: video variant, trim, speed + reverse, **Кадрирование** (fit/zoom/offset), colour correction, freeze, fades |
| `TimelineTransitionMarker.jsx` | The small clickable circle sitting on the boundary between two clips - `+` (no transition yet) or a filled `Zap` (one is set); the exact type only shows once the inspector is open |
| `TimelineTransitionInspector.jsx` | The selected clip boundary: a type chip row (`none` *is* "remove the transition") plus a duration field once a real type is picked |
| `TimelineOverlayInspector.jsx` | Numeric precise-entry fallback for the selected overlay — the real placement UI is dragging it on the program monitor |
| `KeyboardShortcutsModal.jsx` | Static reference list of every Editor keyboard/pointer binding — the single source of truth for them |
| `TestRangeModal.jsx` | Picks the `{startMs, endMs}` test-render window (mm:ss From/To pairs), opened from `EditorBottomToolbar.jsx` |
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
