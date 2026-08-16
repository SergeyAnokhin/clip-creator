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
| `generation_export.py` | `/video-export`, `/video-import-batch`, `/final-export`, Editor-stage render start/poll/delete |
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
| `editor.py` | — (local ffmpeg) | `build_render_plan` + `build_ffmpeg_command` (both pure/testable), then the render job |
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
Two tests use a real local `ffmpeg` and `skipif` it isn't on `PATH`
(`test_mureka_provider.py`'s trim, `test_editor_provider.py`'s render).

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

### `lib/` — pure, tested modules

| File | Does |
| --- | --- |
| `lyrics.js` | Block/line transforms (function table at the bottom of this file) |
| `sunoPrompt.js` | `buildSunoPromptPreview` — client mirror of `suno.py`'s prompt builder; `groupPresetsByService` |
| `scenes.js` | `pickMainByRating`, `resolveAnimateImage` (which image the Video stage animates) |
| `titleCard.js` | `pickTopReferenceImages` — auto-fills the Title Card reference slots |
| `lyricsTiming.js` | Mureka `lyrics_sections` → karaoke line list, plus manual anchor re-timing. Handles untimed/partially-timed responses |
| `timeline.js` | Editor-stage timeline math: clip offsets, `findActiveClip`, `clampTrim`, plus the direct-manipulation helpers (`moveClip`, `dropIndexForStart`, `applyEdgeTrim`, `splitClipsAt`) |
| `editorDefaults.js` | `buildDefaultClips`, `defaultMurekaTrackId` — the Editor stage's first-open seed |
| `editorClipLabel.js` | `sceneLabel` — the "N. description" text shared by a timeline clip block's hover tooltip and the add-scene chips |
| `posterLayers.js` | Poster constructor's pure helpers: layer/effect factories (incl. `makeMagicLayer`), stored-poster normalization, `moveLayerInList`, `bestMagicLayerGroup` (also used by the `✨N` badge outside the constructor), center-snap and zoom-clamp math, `FONT_OPTIONS` |
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
| `useEditorStage` | Editor stage: EDL seeding, clip mutations, the rAF-clocked preview engine, render job |
| `useClipThumbnails` | A timeline clip block's real video-frame thumbnails: samples interior midpoints of the clip's trimmed window, serialized through one shared hidden `<video>`, cached module-level by video/trim/count |
| `useVoice` | Web Speech API dictation. Created **last**. Also exports `useFieldVoice` for Settings |
| `useHtmlImage` | URL → `HTMLImageElement` via `fetch`+`blob:` (works around a Chrome cross-origin race). Poster constructor only — once per fixed slot, plus once per magic layer via `MagicLayerNode` |

### `components/home/`

`HomeScreen` + `Header`, `FilterChips`, `ProjectGrid`, `ProjectCard`,
`EmptyState`, `NewProjectModal`.

### `components/workflow/` — the nine stages

`WorkflowScreen` → `WorkflowHeader`, `Sidebar`, and one stage component each.

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
| `PosterCanvasLayers.jsx` | The overlay node types it renders (image, magic layer, glass panel, text) |
| `MagicLayersButton.jsx` | The ✨ button + its method/layer-count popup, shared by all three magic-layer entry points |
| `MagicLayersPreviewModal.jsx` | The `✨N` badge's drag-to-test sandbox for one already-decomposed group — nothing is saved |
| `PosterPanels.jsx` | Its side-panel widgets (effects, layer toolbar, glass/text panels, picker rows) |
| `PosterGallery.jsx` | Saved posters; select-main, delete, reopen for editing |
| `VideoStage.jsx` | Animation stage — **one scene at a time**; motion prompt, image pick, wishes, generation, batch export/import |
| `VideoGallery.jsx` | All candidate clips for the scene, hover-preview `<video>`s, resizable tiles |
| `VideoExportModal.jsx` | Scene picker for the batch export download |
| `ExportStage.jsx` | Picks what goes in the final zip and downloads it |
| `EditorStage.jsx` | App-style layout, not a scrolling page: program monitor fills the height left after the timeline (docked to the very bottom); the right side panel holds everything else — playback transport, the `toolsSlot` DOM node `EditorTimeline.jsx` portals its toolbar/inspector/add-row into, the audio track picker, the renders list, and the render CTA pinned at the panel's own bottom |
| `EditorPreview.jsx` | Program monitor only: muted `<video>` synced to a hidden `<audio>`. Approximate, not the real render — see `useEditorStage.js` |
| `EditorTimeline.jsx` | The timeline proper: ruler, clip blocks (`TimelineClipBlock.jsx`) drawn to scale, playhead, zoom — pared to just those 3 rows, since the toolbar/`TimelineClipInspector.jsx`/add-scene-chips render into `EditorStage.jsx`'s side panel via a `createPortal` into a slot passed down as `toolsSlotNode` (falls back to rendering inline in this component when no slot is given, e.g. in tests). Drag = reorder, edge drag = trim, ruler drag = scrub, razor = split. Desktop-oriented by design: layout adapts down to mobile/tablet widths, but the drag/trim gestures themselves are mouse-only — no touch adaptation (clips are keyboard-operable via Tab/arrows/Enter as a mouse alternative, not a touch one) |
| `TimelineClipBlock.jsx` | One clip block: real sampled frames from its own trimmed window (`useClipThumbnails`) over the scene's static image as a load-in-progress placeholder, no text. Split out of `EditorTimeline.jsx`'s `clips.map()` because a hook can't be called from inside a loop |
| `TimelineAudioTrack.jsx` | The timeline's audio row — decoded waveform `<canvas>` on the same px/ms scale |
| `TimelineClipInspector.jsx` | Selected clip's exact values: video variant, trim, speed, remove |
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
