import { useEffect, useRef, useState } from 'react';
import { api, mediaUrl } from '../api/client.js';
import { buildDefaultClips, defaultMurekaTrackId } from '../lib/editorDefaults.js';
import {
  DEFAULT_OVERLAY_DURATION_MS, DEFAULT_OVERLAY_POSITION, DEFAULT_OVERLAY_WIDTH_PCT,
} from '../lib/overlays.js';
import {
  computeTimelineClips, findActiveClip, getTotalDurationMs, moveClip, splitClipsAt,
} from '../lib/timeline.js';

const EMPTY_VIDEO_EDIT = { mureka_track_id: null, clips: [], overlays: [], renders: [] };
// Only re-seek the preview <video> once the drift from where it should be
// exceeds this - avoids constantly reseeking (which stutters playback) for
// the normal small amount of clock drift between rAF ticks.
const DRIFT_THRESHOLD_MS = 250;
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

function findSceneVideo(scenes, sceneIndex, videoId) {
  const videos = scenes?.[sceneIndex]?.videos || [];
  return videos.find((v) => v.video_id === videoId) || null;
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
 * renders[]}`) is the edit decision list - clip order/trim/speed/track
 * selection all ride the generic `updateProject` autosave, same convention
 * as every other rating/`is_selected` edit elsewhere in this app; only the
 * actual render is a job/poll call (mirrors useVideoStage.js's
 * generateVideo/pollVideoJob).
 *
 * The in-browser preview never touches ffmpeg - a shared <audio>/<video>
 * pair is driven off one rAF-clocked "playhead", with the audio element as
 * the sync source of truth (see `play`/`tick` below). It only approximates
 * cuts/reorder/trim/speed; it never letterboxes or renders the freeze-frame
 * pad the real render does - see EditorStage.jsx's disclaimer. */
export function useEditorStage({ activeProject, setActiveProject, updateProject, flushPendingSave, showToast, L }) {
  const [playheadMs, setPlayheadMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [selectedClipIds, setSelectedClipIds] = useState(() => new Set());
  const [selectedOverlayId, setSelectedOverlayId] = useState(null);
  const [selectedTransitionClipId, setSelectedTransitionClipId] = useState(null);
  const [renderLoading, setRenderLoading] = useState(false);
  const [renderError, setRenderError] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [past, setPast] = useState([]);
  const [future, setFuture] = useState([]);
  const lastCommitAtRef = useRef(0);
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const rafRef = useRef(null);
  const activeClipIndexRef = useRef(-1);
  // Shift+click range-select anchors off the last plain/modifier click, not
  // off whatever the render order of the Set happens to be.
  const selectionAnchorRef = useRef(null);
  // Copy/paste is in-memory and same-project only (not the OS clipboard) -
  // no permission prompt, and "paste" only ever means "append a copy of
  // these clips to this timeline".
  const clipboardRef = useRef([]);

  useEffect(() => {
    if (renderLoading) {
      setElapsedSeconds(0);
      const timer = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
      return () => clearInterval(timer);
    }
    return undefined;
  }, [renderLoading]);

  function resetForProject(project) {
    setPlayheadMs(0);
    setIsPlaying(false);
    setRenderError(null);
    setSelectedClipIds(new Set());
    setSelectedOverlayId(null);
    setSelectedTransitionClipId(null);
    setPast([]);
    setFuture([]);
    lastCommitAtRef.current = 0;
    selectionAnchorRef.current = null;
    activeClipIndexRef.current = -1;
    // Loose check on purpose: a project's `video_edit` can be persisted as
    // `null` (not just absent) - e.g. `updateProject((p) => ({ ...p,
    // video_edit: null }))` - and that should re-seed exactly like a project
    // that has never opened this stage, not permanently show an empty
    // timeline.
    if (project?.video_edit == null) {
      const clips = buildDefaultClips(project?.scenes);
      const mureka_track_id = defaultMurekaTrackId(project?.mureka?.tracks);
      updateProject((p) => ({ ...p, video_edit: { mureka_track_id, clips, overlays: [], renders: [] } }));
    }
  }

  const videoEdit = activeProject?.video_edit || EMPTY_VIDEO_EDIT;
  const clips = videoEdit.clips || [];
  const overlays = videoEdit.overlays || [];
  const scenes = activeProject?.scenes || [];
  const sourceDurationsById = buildSourceDurations(scenes);
  const timelineClips = computeTimelineClips(clips, sourceDurationsById);
  const totalDurationMs = getTotalDurationMs(clips, sourceDurationsById);
  const tracks = activeProject?.mureka?.tracks || [];
  const selectedTrack = tracks.find((t) => t.track_id === videoEdit.mureka_track_id) || null;

  // Always-current refs for the rAF loop below, which - once started by
  // `play()` - keeps calling the same `tick` closure across frames rather
  // than picking up a fresh one on every render.
  const timelineClipsRef = useRef(timelineClips);
  timelineClipsRef.current = timelineClips;
  const scenesRef = useRef(scenes);
  scenesRef.current = scenes;
  // `tick` re-schedules *itself* via requestAnimationFrame once play() kicks
  // it off, so the whole rAF loop keeps running the one closure captured at
  // that moment - including whatever `isPlaying` read as right then (always
  // `false`, since setIsPlaying(true) hasn't committed yet when play() calls
  // requestAnimationFrame(tick)). Without this ref, every clip transition's
  // `if (isPlayingRef.current) videoEl.play()` in applyActiveClip silently no-ops
  // forever after the first clip - the <video> sits paused on whatever frame
  // its src was last assigned to while DRIFT_THRESHOLD_MS below keeps
  // yanking its currentTime to chase the audio clock, which is the "first
  // clip plays fine, every clip after it just jitters" bug.
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  function patchVideoEdit(mutator, opts) {
    updateProject((p) => ({ ...p, video_edit: mutator(p.video_edit || EMPTY_VIDEO_EDIT) }), opts);
  }

  // Every edit that changes *which* source frame sits under the playhead
  // (order, cuts, removals) has to drop the "clip N is already loaded in the
  // <video>" memo, or the preview keeps showing the old clip until the
  // playhead happens to cross into another one.
  function invalidatePreviewClip() {
    activeClipIndexRef.current = -1;
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
    return { clips: videoEdit.clips, overlays: videoEdit.overlays, mureka_track_id: videoEdit.mureka_track_id };
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
    lastCommitAtRef.current = 0;
    patchVideoEdit((edit) => ({ ...edit, clips: prev.clips, overlays: prev.overlays, mureka_track_id: prev.mureka_track_id }));
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
    lastCommitAtRef.current = 0;
    patchVideoEdit((edit) => ({ ...edit, clips: next.clips, overlays: next.overlays, mureka_track_id: next.mureka_track_id }));
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
      clips: splitClipsAt(edit.clips, sourceDurationsById, playheadMs, () => randomId('clip')),
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
    setSelectedClipIds(new Set(clipIds));
  }
  function selectAll() {
    setSelectedOverlayId(null);
    setSelectedTransitionClipId(null);
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
    setSelectedOverlayId(overlayId);
  }
  /** Single-select for the boundary between two clips - `clipId` is the
   * *later* clip, since that's where `transition_in` actually lives (see
   * setClipTransition below). */
  function selectTransition(clipId) {
    setSelectedClipIds(new Set());
    setSelectedOverlayId(null);
    setSelectedTransitionClipId(clipId);
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
        trim_start_ms: 0, trim_end_ms: null, speed: 1.0,
      }],
    }));
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
  /** Reverts one clip's trim window and speed back to "the whole source clip,
   * at 1x" - the same shape a freshly added clip starts in (see
   * addSceneClip above). */
  function resetClip(clipId) {
    invalidatePreviewClip();
    commitVideoEdit((edit) => ({
      ...edit,
      clips: edit.clips.map((c) => (c.clip_id === clipId ? { ...c, trim_start_ms: 0, trim_end_ms: null, speed: 1.0 } : c)),
    }));
  }
  function setMurekaTrackId(trackId) {
    commitVideoEdit((edit) => ({ ...edit, mureka_track_id: trackId }));
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
      start_ms: Math.round(playheadMs), duration_ms: DEFAULT_OVERLAY_DURATION_MS,
      position: DEFAULT_OVERLAY_POSITION, width_pct: DEFAULT_OVERLAY_WIDTH_PCT, opacity: 1,
    };
    commitVideoEdit((edit) => ({ ...edit, overlays: [...(edit.overlays || []), overlay] }));
    setSelectedOverlayId(overlay.overlay_id);
  }
  function setOverlayTiming(overlayId, startMs, durationMs) {
    commitVideoEdit((edit) => ({
      ...edit,
      overlays: (edit.overlays || []).map((o) => (
        o.overlay_id === overlayId ? { ...o, start_ms: startMs, duration_ms: durationMs } : o
      )),
    }), { immediate: false });
  }
  function setOverlayPosition(overlayId, position) {
    commitVideoEdit((edit) => ({
      ...edit,
      overlays: (edit.overlays || []).map((o) => (o.overlay_id === overlayId ? { ...o, position } : o)),
    }));
  }
  function setOverlayWidthPct(overlayId, widthPct) {
    commitVideoEdit((edit) => ({
      ...edit,
      overlays: (edit.overlays || []).map((o) => (o.overlay_id === overlayId ? { ...o, width_pct: widthPct } : o)),
    }), { immediate: false });
  }
  function setOverlayOpacity(overlayId, opacity) {
    commitVideoEdit((edit) => ({
      ...edit,
      overlays: (edit.overlays || []).map((o) => (o.overlay_id === overlayId ? { ...o, opacity } : o)),
    }), { immediate: false });
  }
  function removeOverlay(overlayId) {
    if (selectedOverlayId === overlayId) setSelectedOverlayId(null);
    commitVideoEdit((edit) => ({
      ...edit,
      overlays: (edit.overlays || []).filter((o) => o.overlay_id !== overlayId),
    }));
  }

  // ---------- preview engine ----------
  function applyActiveClip(active) {
    const videoEl = videoRef.current;
    if (!active || !videoEl || !activeProject) return;
    const video = findSceneVideo(scenesRef.current, active.clip.scene_index, active.clip.video_id);
    if (!video) return;
    if (activeClipIndexRef.current !== active.index) {
      activeClipIndexRef.current = active.index;
      videoEl.src = mediaUrl(`projects/${activeProject.id}/${video.file_path}`);
      videoEl.playbackRate = active.clip.speed || 1;
      videoEl.currentTime = active.localOffsetMs / 1000;
      if (isPlayingRef.current) videoEl.play().catch(() => {});
    } else if (Math.abs(videoEl.currentTime * 1000 - active.localOffsetMs) > DRIFT_THRESHOLD_MS) {
      videoEl.currentTime = active.localOffsetMs / 1000;
    }
  }

  function tick() {
    const audioEl = audioRef.current;
    if (!audioEl) return;
    const ms = audioEl.currentTime * 1000;
    setPlayheadMs(ms);
    applyActiveClip(findActiveClip(timelineClipsRef.current, ms));
    if (!audioEl.paused && !audioEl.ended) {
      rafRef.current = requestAnimationFrame(tick);
    } else {
      setIsPlaying(false);
    }
  }

  function play() {
    if (!selectedTrack || !timelineClips.length) return;
    setIsPlaying(true);
    audioRef.current?.play().catch(() => {});
    videoRef.current?.play().catch(() => {});
    rafRef.current = requestAnimationFrame(tick);
  }
  function pause() {
    setIsPlaying(false);
    audioRef.current?.pause();
    videoRef.current?.pause();
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }
  function seek(ms) {
    // Clamped to the audio track too, not just the clips: when the clips run
    // shorter, the tail still exists in the output (the render freeze-frames
    // the last clip over it), so the playhead has to be able to go there.
    const clamped = Math.max(0, Math.min(ms, Math.max(totalDurationMs, selectedTrack?.duration_ms || 0)));
    if (audioRef.current) audioRef.current.currentTime = clamped / 1000;
    activeClipIndexRef.current = -1;
    setPlayheadMs(clamped);
    applyActiveClip(findActiveClip(timelineClipsRef.current, clamped));
  }

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  // ---------- render ----------
  async function pollRenderJob(projectId, jobId) {
    for (;;) {
      const job = await api.getEditorRenderJob(projectId, jobId);
      if (job.status === 'completed' || job.status === 'failed') return job;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  async function startRender() {
    if (!activeProject) return;
    setRenderLoading(true);
    setRenderError(null);
    try {
      await flushPendingSave();
      const { job_id: jobId } = await api.startEditorRender(activeProject.id);
      const job = await pollRenderJob(activeProject.id, jobId);
      if (job.status === 'completed') {
        setActiveProject((p) => ({
          ...p,
          video_edit: { ...(p.video_edit || EMPTY_VIDEO_EDIT), renders: [...(p.video_edit?.renders || []), job.render] },
        }));
        showToast(L.toast_generated);
      } else {
        setRenderError(job.error || 'Не удалось собрать видео');
        showToast(job.error || 'Не удалось собрать видео');
      }
    } catch (err) {
      const message = err?.detail || 'Не удалось собрать видео';
      console.error('[Editor render] request failed:', err);
      setRenderError(message);
      showToast(message);
    } finally {
      setRenderLoading(false);
    }
  }

  async function deleteRender(renderId) {
    if (!activeProject) return;
    try {
      const result = await api.deleteEditorRender(activeProject.id, renderId);
      setActiveProject((p) => ({ ...p, video_edit: { ...(p.video_edit || EMPTY_VIDEO_EDIT), renders: result.renders } }));
    } catch {
      showToast('Не удалось удалить видео');
    }
  }

  function downloadRender(render) {
    if (!activeProject) return;
    const a = document.createElement('a');
    a.href = mediaUrl(`projects/${activeProject.id}/${render.file_path}`);
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return {
    state: {
      videoEdit, clips: timelineClips, overlays, totalDurationMs, selectedTrack, tracks,
      playheadMs, isPlaying, renderLoading, renderError, elapsedSeconds,
      selectedClipIds, selectedOverlayId, selectedTransitionClipId,
      videoRef, audioRef, canUndo: past.length > 0, canRedo: future.length > 0,
    },
    resetForProject,
    actions: {
      reorderClip, splitAtPlayhead, removeClips, addSceneClip, changeClipVideo,
      setClipTrim, setClipSpeed, resetClip, setMurekaTrackId, selectClip, setSelection, selectAll,
      duplicateClips, copyClips, pasteClips, undo, redo,
      addOverlay, setOverlayTiming, setOverlayPosition, setOverlayWidthPct, setOverlayOpacity,
      removeOverlay, selectOverlay,
      setClipTransition, setClipFadeIn, setClipFadeOut, selectTransition,
      play, pause, seek, startRender, deleteRender, downloadRender,
    },
  };
}
