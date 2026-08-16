import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useEditorStage } from './useEditorStage.js';

// tick() re-schedules itself via requestAnimationFrame once play() kicks it
// off (see useEditorStage.js's comment on isPlayingRef), so these tests
// drive the rAF loop by hand instead of waiting on real frames - jsdom has
// no compositor to fire them on, and even a real browser throttles rAF for
// a backgrounded/non-visible tab, which is exactly the scenario that made
// this bug hard to reproduce by eye.
let rafQueue;
beforeEach(() => {
  rafQueue = [];
  vi.stubGlobal('requestAnimationFrame', (cb) => { rafQueue.push(cb); return rafQueue.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

function flushRaf() {
  const queued = rafQueue;
  rafQueue = [];
  queued.forEach((cb) => cb());
}

function makeVideoEl() {
  const el = document.createElement('video');
  // jsdom's real .paused getter never flips just because a mocked .play()
  // resolved - tick()'s own loop-continuation check reads audioEl.paused,
  // so the mock has to behave like the real element for that to work.
  Object.defineProperty(el, 'paused', { value: true, writable: true, configurable: true });
  el.play = vi.fn(() => { el.paused = false; return Promise.resolve(); });
  el.pause = vi.fn(() => { el.paused = true; });
  return el;
}

const PROJECT = {
  id: 'p1',
  scenes: [
    { scene_index: 0, videos: [{ video_id: 'va', file_path: 'a.mp4', duration_seconds: 10 }] },
    { scene_index: 1, videos: [{ video_id: 'vb', file_path: 'b.mp4', duration_seconds: 10 }] },
  ],
  mureka: { tracks: [{ track_id: 't1', file_path: 'trk.mp3', duration_ms: 20000 }] },
  video_edit: {
    mureka_track_id: 't1',
    clips: [
      { clip_id: 'clip_a', scene_index: 0, video_id: 'va', trim_start_ms: 0, trim_end_ms: 5000, speed: 1 },
      { clip_id: 'clip_b', scene_index: 1, video_id: 'vb', trim_start_ms: 0, trim_end_ms: 5000, speed: 1 },
    ],
    renders: [],
  },
};

function setup() {
  const { result } = renderHook(() => useEditorStage({
    activeProject: PROJECT, setActiveProject: vi.fn(), updateProject: vi.fn(), flushPendingSave: vi.fn(), showToast: vi.fn(), L: {},
  }));
  const videoEl = makeVideoEl();
  const audioEl = makeVideoEl();
  act(() => {
    result.current.state.videoRef.current = videoEl;
    result.current.state.audioRef.current = audioEl;
  });
  return { result, videoEl, audioEl };
}

describe('useEditorStage preview engine', () => {
  it('plays every clip on transition, not just the one active when play() was pressed', () => {
    const { result, videoEl, audioEl } = setup();

    act(() => { result.current.actions.play(); });
    // First tick: audio clock still at 0, inside clip_a (0-5000ms output) -
    // loads clip_a's source and should call play() on it.
    act(() => { flushRaf(); });
    expect(videoEl.src).toContain('a.mp4');
    // play() itself also calls videoRef.current.play() directly at click
    // time (before any src is loaded) - so this is >=1, not necessarily 1.
    expect(videoEl.play).toHaveBeenCalled();

    // Audio clock crosses into clip_b's span (5000-10000ms output).
    audioEl.currentTime = 6;
    videoEl.play.mockClear();
    act(() => { flushRaf(); });

    // This is the bug: without isPlayingRef, applyActiveClip's `if
    // (isPlaying)` reads the stale value closed over when play() first
    // scheduled the rAF loop (always false, since setIsPlaying(true) hadn't
    // committed yet) - so the freshly-loaded clip_b source never actually
    // gets played, and the preview just sits on a frozen frame while
    // DRIFT_THRESHOLD_MS keeps yanking its currentTime to chase the audio
    // clock every tick after this.
    expect(videoEl.src).toContain('b.mp4');
    expect(videoEl.play).toHaveBeenCalledTimes(1);
  });

  it('does not re-trigger play() on every tick while staying inside the same clip (drift correction only)', () => {
    const { result, videoEl, audioEl } = setup();

    act(() => { result.current.actions.play(); });
    act(() => { flushRaf(); });
    videoEl.play.mockClear();

    audioEl.currentTime = 1; // still inside clip_a, well under DRIFT_THRESHOLD_MS
    act(() => { flushRaf(); });

    expect(videoEl.play).not.toHaveBeenCalled();
  });
});
