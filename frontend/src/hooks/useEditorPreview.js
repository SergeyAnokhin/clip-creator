import { useEffect, useRef, useState } from 'react';
import { mediaUrl } from '../api/client.js';
import { findActiveClip } from '../lib/timeline.js';

// Only re-seek the preview <video> once the drift from where it should be
// exceeds this - avoids constantly reseeking (which stutters playback) for
// the normal small amount of clock drift between rAF ticks.
const DRIFT_THRESHOLD_MS = 250;

function findSceneVideo(scenes, sceneIndex, videoId) {
  const videos = scenes?.[sceneIndex]?.videos || [];
  return videos.find((v) => v.video_id === videoId) || null;
}

/** The Editor stage's in-browser preview engine - a shared <audio>/<video>
 * pair driven off one rAF-clocked "playhead", with the audio element as the
 * sync source of truth (see `play`/`tick` below). It only approximates
 * cuts/reorder/trim/speed; it never letterboxes or renders the freeze-frame
 * pad the real render does - see EditorStage.jsx's disclaimer.
 *
 * Split out of `useEditorStage.js` (which composes this alongside
 * `useEditorRender.js`): this piece only reads
 * `activeProject`/`timelineClips`/`scenes`/`selectedTrack`/`totalDurationMs`
 * and owns no state any clip/overlay/transition mutation needs, so it
 * doesn't have to share the undo/redo history or `video_edit` at all.
 * `invalidatePreviewClip` is exposed for the caller to run after any edit
 * that changes *which* source frame sits under the playhead (order, cuts,
 * removals) - otherwise the preview keeps showing the old clip until the
 * playhead happens to cross into another one. */
export function useEditorPreview({ activeProject, timelineClips, scenes, selectedTrack, totalDurationMs }) {
  const [playheadMs, setPlayheadMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const rafRef = useRef(null);
  const activeClipIndexRef = useRef(-1);

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

  function invalidatePreviewClip() {
    activeClipIndexRef.current = -1;
  }

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

  /** Called by useEditorStage.js's `resetForProject` on project switch. */
  function resetPreview() {
    setPlayheadMs(0);
    setIsPlaying(false);
    activeClipIndexRef.current = -1;
  }

  return {
    playheadMs, isPlaying, videoRef, audioRef,
    invalidatePreviewClip, play, pause, seek, resetPreview,
  };
}
