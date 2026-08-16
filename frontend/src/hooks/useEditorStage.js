import { useEffect, useRef, useState } from 'react';
import { api, mediaUrl } from '../api/client.js';
import { buildDefaultClips, defaultMurekaTrackId } from '../lib/editorDefaults.js';
import {
  computeTimelineClips, findActiveClip, getTotalDurationMs, moveClip, splitClipsAt,
} from '../lib/timeline.js';

const EMPTY_VIDEO_EDIT = { mureka_track_id: null, clips: [], renders: [] };
// Only re-seek the preview <video> once the drift from where it should be
// exceeds this - avoids constantly reseeking (which stutters playback) for
// the normal small amount of clock drift between rAF ticks.
const DRIFT_THRESHOLD_MS = 250;

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
  const [renderLoading, setRenderLoading] = useState(false);
  const [renderError, setRenderError] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
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
      updateProject((p) => ({ ...p, video_edit: { mureka_track_id, clips, renders: [] } }));
    }
  }

  const videoEdit = activeProject?.video_edit || EMPTY_VIDEO_EDIT;
  const clips = videoEdit.clips || [];
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

  /** Drag-and-drop reorder on the timeline - array indices, not clip ids,
   * because that is what `lib/timeline.js`'s drop-slot math returns. */
  function reorderClip(fromIndex, toIndex) {
    invalidatePreviewClip();
    patchVideoEdit((edit) => ({ ...edit, clips: moveClip(edit.clips, fromIndex, toIndex) }));
  }
  /** Razor tool: cuts the clip under the playhead in two. */
  function splitAtPlayhead() {
    invalidatePreviewClip();
    patchVideoEdit((edit) => ({
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
    patchVideoEdit((edit) => ({ ...edit, clips: edit.clips.filter((c) => !idSet.has(c.clip_id)) }));
  }

  /** Plain click replaces the selection; Ctrl/Cmd+click toggles one clip in
   * or out of it; Shift+click extends from the last plain/modifier click
   * (`selectionAnchorRef`) to the clicked clip, by timeline order. `null`
   * (background click) always clears, regardless of modifiers. */
  function selectClip(clipId, opts = {}) {
    const { additive, range } = opts;
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
    setSelectedClipIds(new Set(clipIds));
  }
  function selectAll() {
    setSelectedClipIds(new Set(timelineClips.map((c) => c.clip_id)));
  }
  function duplicateClips(clipIds) {
    const idSet = new Set(clipIds);
    const idMap = new Map();
    clips.forEach((c) => { if (idSet.has(c.clip_id)) idMap.set(c.clip_id, randomId('clip')); });
    if (!idMap.size) return;
    invalidatePreviewClip();
    patchVideoEdit((edit) => {
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
    patchVideoEdit((edit) => ({ ...edit, clips: [...edit.clips, ...pasted] }));
    setSelectedClipIds(new Set(pasted.map((c) => c.clip_id)));
  }
  function addSceneClip(sceneIndex, videoId) {
    invalidatePreviewClip();
    patchVideoEdit((edit) => ({
      ...edit,
      clips: [...edit.clips, {
        clip_id: randomId('clip'), scene_index: sceneIndex, video_id: videoId,
        trim_start_ms: 0, trim_end_ms: null, speed: 1.0,
      }],
    }));
  }
  function changeClipVideo(clipId, videoId) {
    invalidatePreviewClip();
    patchVideoEdit((edit) => ({
      ...edit,
      clips: edit.clips.map((c) => (c.clip_id === clipId ? { ...c, video_id: videoId, trim_start_ms: 0, trim_end_ms: null } : c)),
    }));
  }
  function setClipTrim(clipId, trimStartMs, trimEndMs) {
    patchVideoEdit((edit) => ({
      ...edit,
      clips: edit.clips.map((c) => (c.clip_id === clipId ? { ...c, trim_start_ms: trimStartMs, trim_end_ms: trimEndMs } : c)),
    }), { immediate: false });
  }
  function setClipSpeed(clipId, speed) {
    patchVideoEdit((edit) => ({
      ...edit,
      clips: edit.clips.map((c) => (c.clip_id === clipId ? { ...c, speed } : c)),
    }));
  }
  function setMurekaTrackId(trackId) {
    patchVideoEdit((edit) => ({ ...edit, mureka_track_id: trackId }));
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
      videoEdit, clips: timelineClips, totalDurationMs, selectedTrack, tracks,
      playheadMs, isPlaying, renderLoading, renderError, elapsedSeconds,
      selectedClipIds, videoRef, audioRef,
    },
    resetForProject,
    actions: {
      reorderClip, splitAtPlayhead, removeClips, addSceneClip, changeClipVideo,
      setClipTrim, setClipSpeed, setMurekaTrackId, selectClip, setSelection, selectAll,
      duplicateClips, copyClips, pasteClips,
      play, pause, seek, startRender, deleteRender, downloadRender,
    },
  };
}
