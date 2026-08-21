import { useRef, useState } from 'react';
import { api } from '../api/client.js';
import {
  buildDefaultClips, DEFAULT_AUDIO_SETTINGS, DEFAULT_EXPORT_SETTINGS, defaultMurekaTrackId, EMPTY_VIDEO_EDIT,
} from '../lib/editorDefaults.js';
import {
  DEFAULT_OVERLAY_DURATION_MS, DEFAULT_TEXT_OVERLAY, defaultOverlayTransform, migrateOverlay,
} from '../lib/overlays.js';
import {
  computeTimelineClips, freezeClipsAt, getTotalDurationMs, moveClip, splitClipsAt, trimEdgeToPlayhead,
} from '../lib/timeline.js';
import { resolveCanvasSize } from '../lib/canvasOrientation.js';
import { useEditorPreview } from './useEditorPreview.js';
import { useEditorRender } from './useEditorRender.js';

// Undo/redo history depth (oldest snapshots drop off past this) - mirrors
// PosterConstructor.jsx's MAX_HISTORY.
const MAX_HISTORY = 50;
// Rapid edits within this window (a drag's continuous pointermove calls, or
// a fast run of keystrokes in a number field) coalesce into the one history
// entry from before the gesture started, instead of one entry per tick -
// same coalescing PosterConstructor.jsx's commit() does.
const HISTORY_COALESCE_MS = 400;

function randomId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/** {video_id: durationMs} for every video referenced anywhere in `scenes` -
 * what lib/timeline.js's duration math needs to resolve a clip's
 * `trim_end_ms: null` default. */
function buildSourceDurations(scenes) {
  const out = {};
  (scenes || []).forEach((scene) => {
    (scene.videos || []).forEach((v) => {
      out[v.video_id] = (v.duration_seconds || 0) * 1000;
    });
  });
  return out;
}

/** Editor stage: the final step - assembles the project's picked scene
 * video clips into one rendered file, synced to the project's selected
 * Mureka audio track (`providers/editor.py`, a local ffmpeg call, no
 * external API). `project.video_edit` (`{mureka_track_id, clips[],
 * overlays[], renders[]}`) is the edit decision list - clip/overlay/
 * transition/track edits all ride the generic `updateProject` autosave, same
 * convention as every other rating/`is_selected` edit elsewhere in this app.
 *
 * This hook owns the EDL itself: clip/overlay/transition/fade mutations, the
 * three mutually-exclusive selections (`selectedClipIds`/`selectedOverlayId`/
 * `selectedTransitionClipId`), and the undo/redo history that spans all of
 * them (`commitVideoEdit` below). The in-browser preview engine and the
 * render job are independent of all that - neither touches `video_edit`'s
 * undo history or cares which selection is active - so they're split into
 * `useEditorPreview.js`/`useEditorRender.js` and just composed here; this
 * hook merges their state/actions into the same public shape it always
 * returned, so nothing downstream (`EditorStage.jsx`, `App.jsx`) had to
 * change for the split. */
export function useEditorStage({ activeProject, setActiveProject, updateProject, flushPendingSave, showToast, L, beginJob, endJob }) {
  const [selectedClipIds, setSelectedClipIds] = useState(() => new Set());
  const [selectedOverlayId, setSelectedOverlayId] = useState(null);
  const [selectedTransitionClipId, setSelectedTransitionClipId] = useState(null);
  // The audio row itself as a selectable object (CapCut: click the audio clip,
  // see its own volume/fades) - the fourth member of the mutually-exclusive
  // selection set below, a plain boolean since there is only ever one audio
  // track on this timeline.
  const [isAudioSelected, setIsAudioSelected] = useState(false);
  const [past, setPast] = useState([]);
  const [future, setFuture] = useState([]);
  const lastCommitAtRef = useRef(0);
  // Shift+click range-select anchors off the last plain/modifier click, not
  // off whatever the render order of the Set happens to be.
  const selectionAnchorRef = useRef(null);
  // Copy/paste is in-memory and same-project only (not the OS clipboard) -
  // no permission prompt, and "paste" only ever means "append a copy of
  // these clips to this timeline".
  const clipboardRef = useRef([]);
  // The overlay `addOverlay` just created, if any - `defaultOverlayTransform`
  // has to start every new overlay as a width_pct/height_pct square (no
  // source image is loaded yet at creation time to know its real aspect
  // ratio), so `resolveOverlayNaturalAspect` below corrects it to the real
  // aspect once EditorPreview.jsx's OverlayCanvasNode finishes loading the
  // source image. Scoped to only the just-created overlay (not every overlay
  // on every mount/playhead-scrub) so it never silently undoes a later
  // manual resize.
  const pendingAspectFitOverlayIdRef = useRef(null);

  const videoEdit = activeProject?.video_edit || EMPTY_VIDEO_EDIT;
  const clips = videoEdit.clips || [];
  const scenes = activeProject?.scenes || [];
  // The overlay migration below needs the canvas size an overlay's
  // height_pct is (or should be) relative to - see migrateOverlay's own
  // docstring on `height_axis`.
  const canvasSize = resolveCanvasSize(clips, scenes, videoEdit.canvas_orientation || 'auto');
  // Lazily normalized on every read - an overlay saved before free x/y/w/h/
  // rotation placement existed just has no `x_pct`/`y_pct` yet; any later
  // edit (even an unrelated one, like timing) commits the migrated shape
  // back through the normal autosave, so no separate one-time pass is
  // needed (see `migrateOverlay`'s own docstring).
  const overlays = (videoEdit.overlays || []).map((o) => migrateOverlay(o, canvasSize.width, canvasSize.height));
  const overlayVideoSources = videoEdit.overlay_video_sources || [];
  const markers = videoEdit.markers || [];
  const audioSettings = { ...DEFAULT_AUDIO_SETTINGS, ...(videoEdit.audio || {}) };
  const exportSettings = { ...DEFAULT_EXPORT_SETTINGS, ...(videoEdit.export || {}) };
  const sourceDurationsById = buildSourceDurations(scenes);
  const timelineClips = computeTimelineClips(clips, sourceDurationsById);
  const totalDurationMs = getTotalDurationMs(clips, sourceDurationsById);
  const tracks = activeProject?.mureka?.tracks || [];
  const selectedTrack = tracks.find((t) => t.track_id === videoEdit.mureka_track_id) || null;

  const preview = useEditorPreview({ activeProject, timelineClips, scenes, selectedTrack, totalDurationMs });
  const render = useEditorRender({ activeProject, setActiveProject, flushPendingSave, showToast, L, beginJob, endJob });
  const { invalidatePreviewClip } = preview;

  function resetForProject(project) {
    preview.resetPreview();
    render.resetRender();
    setSelectedClipIds(new Set());
    setSelectedOverlayId(null);
    setSelectedTransitionClipId(null);
    setIsAudioSelected(false);
    setPast([]);
    setFuture([]);
    lastCommitAtRef.current = 0;
    selectionAnchorRef.current = null;
    // Loose check on purpose: a project's `video_edit` can be persisted as
    // `null` (not just absent) - e.g. `updateProject((p) => ({ ...p,
    // video_edit: null }))` - and that should re-seed exactly like a project
    // that has never opened this stage, not permanently show an empty
    // timeline.
    if (project?.video_edit == null) {
      const clipsSeed = buildDefaultClips(project?.scenes);
      const mureka_track_id = defaultMurekaTrackId(project?.mureka?.tracks);
      updateProject((p) => ({
        ...p,
        video_edit: {
          mureka_track_id, clips: clipsSeed, overlays: [], overlay_video_sources: [], renders: [],
          canvas_orientation: 'auto', markers: [], audio: null, export: null,
        },
      }));
    }
  }

  function patchVideoEdit(mutator, opts) {
    updateProject((p) => ({ ...p, video_edit: mutator(p.video_edit || EMPTY_VIDEO_EDIT) }), opts);
  }

  /** Undo/redo history: a single choke point every `video_edit`-mutating
   * action below routes through instead of `patchVideoEdit` directly.
   * Snapshots the pre-mutation `{clips, mureka_track_id}` into `past`
   * (clearing `future` - a fresh edit invalidates any redo branch) before
   * applying `mutator`, unless the previous commit was under
   * HISTORY_COALESCE_MS ago, in which case it's coalesced into that same
   * snapshot instead of pushing a new one - what keeps a single edge-drag
   * (which calls this on every pointermove) or number-field edit from
   * flooding the history with one entry per pixel/keystroke. Mirrors
   * PosterConstructor.jsx's `commit()`. Renders aren't part of the document
   * here on purpose - they're an append-only log of past exports, not an
   * edit decision to undo. */
  function currentDoc() {
    return {
      clips: videoEdit.clips, overlays: videoEdit.overlays, markers: videoEdit.markers,
      audio: videoEdit.audio, mureka_track_id: videoEdit.mureka_track_id,
    };
  }
  function commitVideoEdit(mutator, opts) {
    const now = Date.now();
    if (now - lastCommitAtRef.current > HISTORY_COALESCE_MS) {
      setPast((p) => [...p, currentDoc()].slice(-MAX_HISTORY));
      setFuture([]);
    }
    lastCommitAtRef.current = now;
    patchVideoEdit(mutator, opts);
  }
  function undo() {
    if (!past.length) return;
    const prev = past[past.length - 1];
    setFuture((f) => [currentDoc(), ...f]);
    setPast((p) => p.slice(0, -1));
    invalidatePreviewClip();
    setSelectedClipIds(new Set());
    setSelectedOverlayId(null);
    setSelectedTransitionClipId(null);
    setIsAudioSelected(false);
    lastCommitAtRef.current = 0;
    patchVideoEdit((edit) => ({
      ...edit, clips: prev.clips, overlays: prev.overlays, markers: prev.markers,
      audio: prev.audio, mureka_track_id: prev.mureka_track_id,
    }));
  }
  function redo() {
    if (!future.length) return;
    const next = future[0];
    setPast((p) => [...p, currentDoc()]);
    setFuture((f) => f.slice(1));
    invalidatePreviewClip();
    setSelectedClipIds(new Set());
    setSelectedOverlayId(null);
    setSelectedTransitionClipId(null);
    setIsAudioSelected(false);
    lastCommitAtRef.current = 0;
    patchVideoEdit((edit) => ({
      ...edit, clips: next.clips, overlays: next.overlays, markers: next.markers,
      audio: next.audio, mureka_track_id: next.mureka_track_id,
    }));
  }

  /** Drag-and-drop reorder on the timeline - array indices, not clip ids,
   * because that is what `lib/timeline.js`'s drop-slot math returns. */
  function reorderClip(fromIndex, toIndex) {
    invalidatePreviewClip();
    commitVideoEdit((edit) => ({ ...edit, clips: moveClip(edit.clips, fromIndex, toIndex) }));
  }
  /** Razor tool: cuts the clip under the playhead in two. */
  function splitAtPlayhead() {
    invalidatePreviewClip();
    commitVideoEdit((edit) => ({
      ...edit,
      clips: splitClipsAt(edit.clips, sourceDurationsById, preview.playheadMs, () => randomId('clip')),
    }));
  }
  function removeClips(clipIds) {
    invalidatePreviewClip();
    const idSet = new Set(clipIds);
    setSelectedClipIds((current) => {
      const next = new Set(current);
      idSet.forEach((id) => next.delete(id));
      return next;
    });
    if (selectedTransitionClipId && idSet.has(selectedTransitionClipId)) setSelectedTransitionClipId(null);
    commitVideoEdit((edit) => ({ ...edit, clips: edit.clips.filter((c) => !idSet.has(c.clip_id)) }));
  }

  /** Plain click replaces the selection; Ctrl/Cmd+click toggles one clip in
   * or out of it; Shift+click extends from the last plain/modifier click
   * (`selectionAnchorRef`) to the clicked clip, by timeline order. `null`
   * (background click) always clears, regardless of modifiers. */
  function selectClip(clipId, opts = {}) {
    const { additive, range } = opts;
    setSelectedOverlayId(null);
    setSelectedTransitionClipId(null);
    setIsAudioSelected(false);
    if (clipId == null) {
      setSelectedClipIds(new Set());
      selectionAnchorRef.current = null;
      return;
    }
    if (range && selectionAnchorRef.current) {
      const ids = timelineClips.map((c) => c.clip_id);
      const anchorIndex = ids.indexOf(selectionAnchorRef.current);
      const targetIndex = ids.indexOf(clipId);
      if (anchorIndex !== -1 && targetIndex !== -1) {
        const [from, to] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
        setSelectedClipIds(new Set(ids.slice(from, to + 1)));
        return;
      }
    }
    if (additive) {
      setSelectedClipIds((current) => {
        const next = new Set(current);
        if (next.has(clipId)) next.delete(clipId); else next.add(clipId);
        return next;
      });
      selectionAnchorRef.current = clipId;
      return;
    }
    setSelectedClipIds(new Set([clipId]));
    selectionAnchorRef.current = clipId;
  }
  /** Marquee-drag release - replaces the selection wholesale with whatever
   * fell inside the rectangle (also used for select-all). */
  function setSelection(clipIds) {
    setSelectedOverlayId(null);
    setSelectedTransitionClipId(null);
    setIsAudioSelected(false);
    setSelectedClipIds(new Set(clipIds));
  }
  function selectAll() {
    setSelectedOverlayId(null);
    setSelectedTransitionClipId(null);
    setIsAudioSelected(false);
    setSelectedClipIds(new Set(timelineClips.map((c) => c.clip_id)));
  }
  /** Single-select for the overlay lane (no marquee/multi-select - overlays
   * are few enough per project that it hasn't been worth the extra
   * complexity `selectedClipIds` carries for clips). Picking an overlay
   * clears the clip/transition selection and vice versa - the inspector
   * only ever shows one of the three. */
  function selectOverlay(overlayId) {
    setSelectedClipIds(new Set());
    setSelectedTransitionClipId(null);
    setIsAudioSelected(false);
    setSelectedOverlayId(overlayId);
  }
  /** Single-select for the boundary between two clips - `clipId` is the
   * *later* clip, since that's where `transition_in` actually lives (see
   * setClipTransition below). */
  function selectTransition(clipId) {
    setSelectedClipIds(new Set());
    setSelectedOverlayId(null);
    setIsAudioSelected(false);
    setSelectedTransitionClipId(clipId);
  }
  /** Selects the audio row itself, so `EditorObjectPropertiesTab.jsx` shows
   * `TimelineAudioInspector.jsx` (volume/fades/offset) - the same
   * "click the object, edit the object" model the other three selections
   * follow. */
  function selectAudio() {
    setSelectedClipIds(new Set());
    setSelectedOverlayId(null);
    setSelectedTransitionClipId(null);
    setIsAudioSelected(true);
  }
  function duplicateClips(clipIds) {
    const idSet = new Set(clipIds);
    const idMap = new Map();
    clips.forEach((c) => { if (idSet.has(c.clip_id)) idMap.set(c.clip_id, randomId('clip')); });
    if (!idMap.size) return;
    invalidatePreviewClip();
    commitVideoEdit((edit) => {
      const next = [];
      edit.clips.forEach((c) => {
        next.push(c);
        if (idMap.has(c.clip_id)) next.push({ ...c, clip_id: idMap.get(c.clip_id) });
      });
      return { ...edit, clips: next };
    });
    setSelectedClipIds(new Set(idMap.values()));
  }
  function copyClips(clipIds) {
    const idSet = new Set(clipIds);
    clipboardRef.current = clips.filter((c) => idSet.has(c.clip_id)).map((c) => ({ ...c }));
  }
  function pasteClips() {
    if (!clipboardRef.current.length) return;
    invalidatePreviewClip();
    const pasted = clipboardRef.current.map((c) => ({ ...c, clip_id: randomId('clip') }));
    commitVideoEdit((edit) => ({ ...edit, clips: [...edit.clips, ...pasted] }));
    setSelectedClipIds(new Set(pasted.map((c) => c.clip_id)));
  }
  function addSceneClip(sceneIndex, videoId) {
    invalidatePreviewClip();
    commitVideoEdit((edit) => ({
      ...edit,
      clips: [...edit.clips, {
        clip_id: randomId('clip'), scene_index: sceneIndex, video_id: videoId,
        trim_start_ms: 0, trim_end_ms: null, speed: 1.0, reverse: false,
      }],
    }));
  }
  /** Appends every scene video not already on the timeline - not just one
   * per scene like `addSceneClip`. Within a scene the selected (or first)
   * video goes first, then its remaining variants, so a scene's clips land
   * back-to-back in the timeline in generation order. */
  function addAllSceneClips() {
    const usedVideoIds = new Set(clips.map((c) => c.video_id));
    const newClips = [];
    scenes.forEach((scene, sceneIndex) => {
      const videos = scene.videos || [];
      if (!videos.length) return;
      const selected = videos.find((v) => v.is_selected) || videos[0];
      const ordered = [selected, ...videos.filter((v) => v !== selected)];
      ordered.forEach((video) => {
        if (usedVideoIds.has(video.video_id)) return;
        newClips.push({
          clip_id: randomId('clip'), scene_index: sceneIndex, video_id: video.video_id,
          trim_start_ms: 0, trim_end_ms: null, speed: 1.0, reverse: false,
        });
      });
    });
    if (!newClips.length) return;
    invalidatePreviewClip();
    commitVideoEdit((edit) => ({ ...edit, clips: [...edit.clips, ...newClips] }));
  }
  function changeClipVideo(clipId, videoId) {
    invalidatePreviewClip();
    commitVideoEdit((edit) => ({
      ...edit,
      clips: edit.clips.map((c) => (c.clip_id === clipId ? { ...c, video_id: videoId, trim_start_ms: 0, trim_end_ms: null } : c)),
    }));
  }
  function setClipTrim(clipId, trimStartMs, trimEndMs) {
    commitVideoEdit((edit) => ({
      ...edit,
      clips: edit.clips.map((c) => (c.clip_id === clipId ? { ...c, trim_start_ms: trimStartMs, trim_end_ms: trimEndMs } : c)),
    }), { immediate: false });
  }
  function setClipSpeed(clipId, speed) {
    commitVideoEdit((edit) => ({
      ...edit,
      clips: edit.clips.map((c) => (c.clip_id === clipId ? { ...c, speed } : c)),
    }), { immediate: false });
  }
  /** Toggles a clip's `reverse` flag - plays its trimmed content back to
   * front (`providers/editor.py`'s `build_ffmpeg_command`), independent of
   * `speed`. Not simulated by the in-browser preview (nothing to invalidate
   * there) - see lib/timeline.js's own docstring on why. */
  function setClipReverse(clipId, reverse) {
    commitVideoEdit((edit) => ({
      ...edit,
      clips: edit.clips.map((c) => (c.clip_id === clipId ? { ...c, reverse } : c)),
    }), { immediate: false });
  }
  /** How a clip whose own aspect ratio doesn't match the render canvas fills
   * it - `fit: {mode:'cover'|'contain', zoom, offset_x_pct, offset_y_pct}`.
   * Absent/`null` means `cover` at `zoom:1`, centered (today's default -
   * fills the frame, cropping overflow, no letterbox bars); `contain` is the
   * old always-letterboxed behavior, now an explicit opt-in. Mirrors
   * `providers/editor.py`'s `build_ffmpeg_command` crop-vs-pad branch. */
  function setClipFit(clipId, fit) {
    commitVideoEdit((edit) => ({
      ...edit,
      clips: edit.clips.map((c) => (c.clip_id === clipId ? { ...c, fit } : c)),
    }), { immediate: false });
  }
  /** Reverts one clip's trim window, speed and reverse flag back to "the
   * whole source clip, forward, at 1x" - the same shape a freshly added clip
   * starts in (see addSceneClip above). */
  function resetClip(clipId) {
    invalidatePreviewClip();
    commitVideoEdit((edit) => ({
      ...edit,
      clips: edit.clips.map((c) => (
        c.clip_id === clipId ? { ...c, trim_start_ms: 0, trim_end_ms: null, speed: 1.0, reverse: false } : c
      )),
    }));
  }
  /** Q/W on the timeline (CapCut's "trim to playhead"): the selected clip
   * gives up whichever side of itself the playhead has already passed (or
   * hasn't reached yet). A no-op when the playhead isn't inside the clip or
   * the cut would leave a sliver - see `trimEdgeToPlayhead`. */
  function trimClipToPlayhead(clipId, edge) {
    const target = timelineClips.find((c) => c.clip_id === clipId);
    const next = trimEdgeToPlayhead(target, preview.playheadMs, edge);
    if (!next) return;
    invalidatePreviewClip();
    commitVideoEdit((edit) => ({
      ...edit,
      clips: edit.clips.map((c) => (
        c.clip_id === clipId ? { ...c, trim_start_ms: next.trimStartMs, trim_end_ms: next.trimEndMs } : c
      )),
    }));
  }
  /** Freeze frame: splits the clip under the playhead and drops a held still
   * of that exact frame between the halves (`freezeClipsAt`). */
  function freezeAtPlayhead() {
    invalidatePreviewClip();
    commitVideoEdit((edit) => ({
      ...edit,
      clips: freezeClipsAt(edit.clips, sourceDurationsById, preview.playheadMs, () => randomId('clip')),
    }));
  }
  /** Per-clip colour correction - `{brightness, contrast, saturation, gamma}`
   * in ffmpeg `eq` semantics (`providers/editor.py`), `null` to remove it
   * entirely. Previewed approximately as a CSS `filter` on the monitor's
   * `<video>` (EditorPreview.jsx), same tolerance the rest of the preview
   * already carries. */
  function setClipAdjust(clipId, adjust) {
    commitVideoEdit((edit) => ({
      ...edit,
      clips: edit.clips.map((c) => (c.clip_id === clipId ? { ...c, adjust } : c)),
    }), { immediate: false });
  }

  function setMurekaTrackId(trackId) {
    commitVideoEdit((edit) => ({ ...edit, mureka_track_id: trackId }));
  }
  function setCanvasOrientation(orientation) {
    commitVideoEdit((edit) => ({ ...edit, canvas_orientation: orientation }));
  }

  /** Partial patch of `video_edit.audio` (`{volume, fade_in_ms, fade_out_ms,
   * offset_ms}`) - how the picked track is laid under the video. `offset_ms`
   * skips that much of the track's own head, so the song can start from its
   * chorus; the in-browser preview mirrors it in `useEditorPreview.js` so the
   * playhead still means the same moment in both. */
  function setAudioSettings(patch) {
    commitVideoEdit((edit) => ({
      ...edit,
      audio: { ...DEFAULT_AUDIO_SETTINGS, ...(edit.audio || {}), ...patch },
    }), { immediate: false });
  }
  /** Partial patch of `video_edit.export` (`{resolution, fps, quality}`) -
   * output pixels/frames/bitrate, independent of `canvas_orientation` (which
   * only picks portrait vs landscape). */
  function setExportSettings(patch) {
    commitVideoEdit((edit) => ({
      ...edit,
      export: { ...DEFAULT_EXPORT_SETTINGS, ...(edit.export || {}), ...patch },
    }));
  }

  // ---------- markers ----------
  /** A labelled moment on the ruler - purely an editing aid (the renderer
   * never reads `video_edit.markers`), but a snap target for every timeline
   * gesture, which is the whole point: cut on the beat without eyeballing
   * the waveform. */
  function addMarker(atMs) {
    const at = Math.round(atMs ?? preview.playheadMs);
    commitVideoEdit((edit) => ({
      ...edit,
      markers: [...(edit.markers || []), { marker_id: randomId('mrk'), at_ms: at, label: '' }],
    }));
  }
  /** Replaces every marker with one per detected beat (`lib/beats.js`) -
   * "replace", not "append", so pressing it twice doesn't double up, and so
   * one undo takes the whole batch back. */
  function setBeatMarkers(beats) {
    commitVideoEdit((edit) => ({
      ...edit,
      markers: beats.map((beat) => ({ marker_id: randomId('mrk'), at_ms: Math.round(beat.at_ms), label: '' })),
    }));
  }
  function moveMarker(markerId, atMs) {
    commitVideoEdit((edit) => ({
      ...edit,
      markers: (edit.markers || []).map((m) => (m.marker_id === markerId ? { ...m, at_ms: Math.max(0, Math.round(atMs)) } : m)),
    }), { immediate: false });
  }
  function renameMarker(markerId, label) {
    commitVideoEdit((edit) => ({
      ...edit,
      markers: (edit.markers || []).map((m) => (m.marker_id === markerId ? { ...m, label } : m)),
    }), { immediate: false });
  }
  function removeMarker(markerId) {
    commitVideoEdit((edit) => ({
      ...edit,
      markers: (edit.markers || []).filter((m) => m.marker_id !== markerId),
    }));
  }
  function clearMarkers() {
    commitVideoEdit((edit) => ({ ...edit, markers: [] }));
  }

  // ---------- transitions & fades ----------
  /** The transition *into* `clipId` from whichever clip precedes it -
   * `type: 'none'` (or no clip preceding it) clears it back to a hard cut.
   * Real crossfade blending happens only at render time
   * (`providers/editor.py`'s `xfade` chain) - this is just the EDL. */
  function setClipTransition(clipId, type, durationMs) {
    commitVideoEdit((edit) => ({
      ...edit,
      clips: edit.clips.map((c) => (
        c.clip_id === clipId
          ? { ...c, transition_in: type === 'none' ? null : { type, duration_ms: durationMs } }
          : c
      )),
    }));
  }
  /** Same transition on every boundary at once - the single most repeated
   * action in CapCut/Movavi once a rough cut exists. The first clip has no
   * boundary before it, so it is always left alone. */
  function setAllTransitions(type, durationMs) {
    commitVideoEdit((edit) => ({
      ...edit,
      clips: edit.clips.map((c, i) => (
        i === 0
          ? { ...c, transition_in: null }
          : { ...c, transition_in: type === 'none' ? null : { type, duration_ms: durationMs } }
      )),
    }));
  }
  function setClipFadeIn(clipId, color, durationMs) {
    commitVideoEdit((edit) => ({
      ...edit,
      clips: edit.clips.map((c) => (
        c.clip_id === clipId ? { ...c, fade_in: durationMs > 0 ? { color, duration_ms: durationMs } : null } : c
      )),
    }), { immediate: false });
  }
  function setClipFadeOut(clipId, color, durationMs) {
    commitVideoEdit((edit) => ({
      ...edit,
      clips: edit.clips.map((c) => (
        c.clip_id === clipId ? { ...c, fade_out: durationMs > 0 ? { color, duration_ms: durationMs } : null } : c
      )),
    }), { immediate: false });
  }

  // ---------- overlay lane (title-card / logo images over the video) ----------
  /** Drops a new overlay at the playhead, `DEFAULT_OVERLAY_DURATION_MS` long
   * - `kind`/`sourceId` picks the image (a title-card variant or a global
   * logo), resolved to an actual file only at render time
   * (`providers/editor.py`). */
  function addOverlay(kind, sourceId) {
    const overlay = {
      overlay_id: randomId('ovl'), kind, source_id: sourceId,
      start_ms: Math.round(preview.playheadMs), duration_ms: DEFAULT_OVERLAY_DURATION_MS,
      ...defaultOverlayTransform(), opacity: 1, fade_in_ms: 0, fade_out_ms: 0,
    };
    pendingAspectFitOverlayIdRef.current = overlay.overlay_id;
    commitVideoEdit((edit) => ({ ...edit, overlays: [...(edit.overlays || []), overlay] }));
    setSelectedOverlayId(overlay.overlay_id);
  }
  /** Corrects the just-created overlay's square placeholder size to the
   * source image's real aspect ratio, once it's known - see
   * `pendingAspectFitOverlayIdRef`'s own comment above. `width_pct` stays as
   * placed; `height_pct` is recomputed from it (both are already fractions
   * of the canvas's own width - see lib/overlays.js's docstring - so their
   * ratio is exactly naturalH/naturalW regardless of canvas size), and
   * `y_pct` shifts to keep the box's bottom-right corner anchored where the
   * placeholder left it instead of only growing/shrinking downward. */
  function resolveOverlayNaturalAspect(overlayId, naturalW, naturalH) {
    if (pendingAspectFitOverlayIdRef.current !== overlayId || !naturalW || !naturalH) return;
    pendingAspectFitOverlayIdRef.current = null;
    commitVideoEdit((edit) => ({
      ...edit,
      overlays: (edit.overlays || []).map((o) => {
        if (o.overlay_id !== overlayId) return o;
        const heightPct = o.width_pct * (naturalH / naturalW);
        return { ...o, y_pct: o.y_pct + (o.height_pct - heightPct), height_pct: heightPct };
      }),
    }), { immediate: false });
  }
  /** A `kind: 'text'` overlay - carries its own `text` block (content +
   * styling) instead of a `source_id`, and is rasterized to a PNG by
   * `providers/editor.py` at render time so it rides the exact same overlay
   * compositing path every image overlay already uses. Starts wider than an
   * image overlay's default square because a line of text is wide;
   * `resolveOverlayNaturalAspect` corrects the height once the preview's
   * Konva `Text` node reports its measured size. */
  function addTextOverlay(content) {
    const overlay = {
      overlay_id: randomId('ovl'), kind: 'text', source_id: null,
      start_ms: Math.round(preview.playheadMs), duration_ms: DEFAULT_OVERLAY_DURATION_MS,
      ...defaultOverlayTransform(), opacity: 1, fade_in_ms: 0, fade_out_ms: 0,
      text: { ...DEFAULT_TEXT_OVERLAY, content: content ?? DEFAULT_TEXT_OVERLAY.content },
    };
    pendingAspectFitOverlayIdRef.current = overlay.overlay_id;
    commitVideoEdit((edit) => ({ ...edit, overlays: [...(edit.overlays || []), overlay] }));
    setSelectedOverlayId(overlay.overlay_id);
    setSelectedClipIds(new Set());
    setSelectedTransitionClipId(null);
    setIsAudioSelected(false);
  }
  /** Partial patch of a text overlay's own `text` block (content, font,
   * colour, outline, alignment) - placement/timing/opacity still go through
   * `setOverlayTransform`/`setOverlayTiming`/`setOverlayOpacity` like any
   * other overlay. */
  function setOverlayText(overlayId, patch) {
    commitVideoEdit((edit) => ({
      ...edit,
      overlays: (edit.overlays || []).map((o) => (
        o.overlay_id === overlayId ? { ...o, text: { ...DEFAULT_TEXT_OVERLAY, ...(o.text || {}), ...patch } } : o
      )),
    }), { immediate: false });
  }
  function setOverlayTiming(overlayId, startMs, durationMs) {
    commitVideoEdit((edit) => ({
      ...edit,
      overlays: (edit.overlays || []).map((o) => (
        o.overlay_id === overlayId ? { ...o, start_ms: startMs, duration_ms: durationMs } : o
      )),
    }), { immediate: false });
  }
  /** Partial patch of an overlay's free placement (`x_pct`/`y_pct`/
   * `width_pct`/`height_pct`/`rotation_deg`) - the one entry point both the
   * program monitor's drag/resize/rotate canvas (`EditorPreview.jsx`, via
   * `CanvasLayer`'s `onChange`) and the inspector's numeric precise-entry
   * fallback (`TimelineOverlayInspector.jsx`) call, so a drag and a typed
   * value both go through the exact same undo-coalescing path. */
  function setOverlayTransform(overlayId, patch) {
    commitVideoEdit((edit) => ({
      ...edit,
      overlays: (edit.overlays || []).map((o) => (o.overlay_id === overlayId ? { ...o, ...patch } : o)),
    }), { immediate: false });
  }
  function setOverlayOpacity(overlayId, opacity) {
    commitVideoEdit((edit) => ({
      ...edit,
      overlays: (edit.overlays || []).map((o) => (o.overlay_id === overlayId ? { ...o, opacity } : o)),
    }), { immediate: false });
  }
  /** Toggles a `kind: 'video'` overlay's `reverse` flag, same meaning as a
   * clip's own (`setClipReverse` above) - meaningless for an image overlay
   * (`_resolve_overlays`/`build_ffmpeg_command` on the render side only ever
   * read it for `kind: 'video'`), so `TimelineOverlayInspector.jsx` only
   * exposes this control there. */
  function setOverlayReverse(overlayId, reverse) {
    commitVideoEdit((edit) => ({
      ...edit,
      overlays: (edit.overlays || []).map((o) => (o.overlay_id === overlayId ? { ...o, reverse } : o)),
    }), { immediate: false });
  }
  function setOverlayFade(overlayId, fadeInMs, fadeOutMs) {
    commitVideoEdit((edit) => ({
      ...edit,
      overlays: (edit.overlays || []).map((o) => (
        o.overlay_id === overlayId ? { ...o, fade_in_ms: fadeInMs, fade_out_ms: fadeOutMs } : o
      )),
    }), { immediate: false });
  }
  function removeOverlay(overlayId) {
    if (selectedOverlayId === overlayId) setSelectedOverlayId(null);
    commitVideoEdit((edit) => ({
      ...edit,
      overlays: (edit.overlays || []).filter((o) => o.overlay_id !== overlayId),
    }));
  }
  /** Uploads a video file to overlay on the timeline (`kind: 'video'`) - the
   * backend route owns persistence for this one (mirrors `useEditorRender.
   * js`'s `deleteRender`/`startRender`: an upload/render result is server-
   * appended and read back, not built by a local edit action), so this just
   * merges the response into local state rather than going through
   * `commitVideoEdit`/`patchVideoEdit` (which would PATCH a second time). Not
   * part of the undo history for the same reason a render isn't - it's an
   * asset upload, not an edit decision to undo. */
  async function uploadOverlayVideo(file) {
    if (!activeProject) return null;
    try {
      const source = await api.uploadEditorOverlayVideo(activeProject.id, file);
      setActiveProject((p) => ({
        ...p,
        video_edit: {
          ...(p.video_edit || EMPTY_VIDEO_EDIT),
          overlay_video_sources: [...((p.video_edit || EMPTY_VIDEO_EDIT).overlay_video_sources || []), source],
        },
      }));
      return source;
    } catch {
      showToast(L.editor_overlayVideoUploadError, 'error');
      return null;
    }
  }
  async function deleteOverlayVideo(sourceId) {
    if (!activeProject) return;
    try {
      const result = await api.deleteEditorOverlayVideo(activeProject.id, sourceId);
      setActiveProject((p) => ({
        ...p,
        video_edit: { ...(p.video_edit || EMPTY_VIDEO_EDIT), overlay_video_sources: result.overlay_video_sources },
      }));
    } catch {
      showToast(L.editor_overlayVideoDeleteError, 'error');
    }
  }

  return {
    state: {
      videoEdit, clips: timelineClips, overlays, overlayVideoSources, totalDurationMs, selectedTrack, tracks,
      markers, audioSettings, exportSettings,
      playheadMs: preview.playheadMs, isPlaying: preview.isPlaying,
      renderLoading: render.renderLoading, renderError: render.renderError, elapsedSeconds: render.elapsedSeconds,
      selectedClipIds, selectedOverlayId, selectedTransitionClipId, isAudioSelected,
      videoRef: preview.videoRef, audioRef: preview.audioRef,
      canUndo: past.length > 0, canRedo: future.length > 0,
    },
    resetForProject,
    actions: {
      reorderClip, splitAtPlayhead, removeClips, addSceneClip, addAllSceneClips, changeClipVideo,
      setClipTrim, setClipSpeed, setClipReverse, setClipFit, setClipAdjust, resetClip,
      trimClipToPlayhead, freezeAtPlayhead,
      setMurekaTrackId, setCanvasOrientation, setAudioSettings, setExportSettings,
      addMarker, setBeatMarkers, moveMarker, renameMarker, removeMarker, clearMarkers,
      selectClip, setSelection, selectAll, selectAudio,
      duplicateClips, copyClips, pasteClips, undo, redo,
      addOverlay, addTextOverlay, setOverlayText,
      setOverlayTiming, setOverlayTransform, setOverlayOpacity, setOverlayReverse, setOverlayFade,
      removeOverlay, selectOverlay, uploadOverlayVideo, deleteOverlayVideo, resolveOverlayNaturalAspect,
      setClipTransition, setAllTransitions, setClipFadeIn, setClipFadeOut, selectTransition,
      play: preview.play, pause: preview.pause, seek: preview.seek,
      startRender: render.startRender, deleteRender: render.deleteRender, downloadRender: render.downloadRender,
    },
  };
}
