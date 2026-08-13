import { useEffect, useRef, useState } from 'react';
import { api, mediaUrl } from '../api/client.js';
import { buildDefaultClips, defaultMurekaTrackId } from '../lib/editorDefaults.js';
import { computeTimelineClips, findActiveClip, getTotalDurationMs } from '../lib/timeline.js';

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
  const [renderLoading, setRenderLoading] = useState(false);
  const [renderError, setRenderError] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const rafRef = useRef(null);
  const activeClipIndexRef = useRef(-1);

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

  function patchVideoEdit(mutator, opts) {
    updateProject((p) => ({ ...p, video_edit: mutator(p.video_edit || EMPTY_VIDEO_EDIT) }), opts);
  }

  function moveClipUp(clipId) {
    patchVideoEdit((edit) => {
      const idx = edit.clips.findIndex((c) => c.clip_id === clipId);
      if (idx <= 0) return edit;
      const next = [...edit.clips];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      return { ...edit, clips: next };
    });
  }
  function moveClipDown(clipId) {
    patchVideoEdit((edit) => {
      const idx = edit.clips.findIndex((c) => c.clip_id === clipId);
      if (idx === -1 || idx >= edit.clips.length - 1) return edit;
      const next = [...edit.clips];
      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      return { ...edit, clips: next };
    });
  }
  function removeClip(clipId) {
    patchVideoEdit((edit) => ({ ...edit, clips: edit.clips.filter((c) => c.clip_id !== clipId) }));
  }
  function addSceneClip(sceneIndex, videoId) {
    patchVideoEdit((edit) => ({
      ...edit,
      clips: [...edit.clips, {
        clip_id: randomId('clip'), scene_index: sceneIndex, video_id: videoId,
        trim_start_ms: 0, trim_end_ms: null, speed: 1.0,
      }],
    }));
  }
  function changeClipVideo(clipId, videoId) {
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
      if (isPlaying) videoEl.play().catch(() => {});
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
    const clamped = Math.max(0, Math.min(ms, totalDurationMs));
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
      videoRef, audioRef,
    },
    resetForProject,
    actions: {
      moveClipUp, moveClipDown, removeClip, addSceneClip, changeClipVideo,
      setClipTrim, setClipSpeed, setMurekaTrackId,
      play, pause, seek, startRender, deleteRender, downloadRender,
    },
  };
}
