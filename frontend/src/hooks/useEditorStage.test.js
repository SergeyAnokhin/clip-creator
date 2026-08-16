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

function makeMultiClipProject() {
  return {
    id: 'p2',
    scenes: [
      { scene_index: 0, videos: [{ video_id: 'va', file_path: 'a.mp4', duration_seconds: 10 }] },
      { scene_index: 1, videos: [{ video_id: 'vb', file_path: 'b.mp4', duration_seconds: 10 }] },
      { scene_index: 2, videos: [{ video_id: 'vc', file_path: 'c.mp4', duration_seconds: 10 }] },
    ],
    mureka: { tracks: [] },
    video_edit: {
      mureka_track_id: null,
      clips: [
        { clip_id: 'clip_a', scene_index: 0, video_id: 'va', trim_start_ms: 0, trim_end_ms: 5000, speed: 1 },
        { clip_id: 'clip_b', scene_index: 1, video_id: 'vb', trim_start_ms: 0, trim_end_ms: 5000, speed: 1 },
        { clip_id: 'clip_c', scene_index: 2, video_id: 'vc', trim_start_ms: 0, trim_end_ms: 5000, speed: 1 },
      ],
      renders: [],
    },
  };
}

// A fresh project instance per test, mutated in place by `updateProject` the
// same way the real app's autosave hook works - avoids state leaking between
// tests the way one shared module-level fixture would.
function setupMultiClip() {
  const project = makeMultiClipProject();
  const { result } = renderHook(() => useEditorStage({
    activeProject: project, setActiveProject: vi.fn(), updateProject: (mutator) => {
      project.video_edit = mutator(project).video_edit;
    }, flushPendingSave: vi.fn(), showToast: vi.fn(), L: {},
  }));
  return { result, project };
}

describe('useEditorStage selection', () => {
  it('plain click replaces the selection; ctrl+click toggles; shift+click range-selects', () => {
    const { result } = setupMultiClip();

    act(() => { result.current.actions.selectClip('clip_a'); });
    expect(result.current.state.selectedClipIds).toEqual(new Set(['clip_a']));

    act(() => { result.current.actions.selectClip('clip_c', { additive: true }); });
    expect(result.current.state.selectedClipIds).toEqual(new Set(['clip_a', 'clip_c']));

    // Shift+click ranges from the anchor (the last plain/ctrl click, which
    // moved to clip_c above) to the clicked clip.
    act(() => { result.current.actions.selectClip('clip_b', { range: true }); });
    expect(result.current.state.selectedClipIds).toEqual(new Set(['clip_b', 'clip_c']));

    act(() => { result.current.actions.selectClip(null); });
    expect(result.current.state.selectedClipIds).toEqual(new Set());
  });

  it('selectAll selects every clip on the timeline', () => {
    const { result } = setupMultiClip();
    act(() => { result.current.actions.selectAll(); });
    expect(result.current.state.selectedClipIds).toEqual(new Set(['clip_a', 'clip_b', 'clip_c']));
  });
});

describe('useEditorStage clip mutations', () => {
  it('removeClips drops every id in the set and clears them from the selection', () => {
    const { result, project } = setupMultiClip();
    act(() => { result.current.actions.selectClip('clip_a'); });
    act(() => { result.current.actions.selectClip('clip_b', { additive: true }); });

    act(() => { result.current.actions.removeClips(['clip_a', 'clip_b']); });

    expect(project.video_edit.clips.map((c) => c.clip_id)).toEqual(['clip_c']);
    expect(result.current.state.selectedClipIds).toEqual(new Set());
  });

  it('duplicateClips inserts a copy of each selected clip right after the original and selects the copies', () => {
    const { result, project } = setupMultiClip();

    act(() => { result.current.actions.duplicateClips(['clip_a', 'clip_c']); });

    const ids = project.video_edit.clips.map((c) => c.clip_id);
    expect(ids).toHaveLength(5);
    expect(ids[0]).toBe('clip_a');
    expect(ids[1]).not.toBe('clip_a'); // clip_a's duplicate, right after it
    expect(ids[2]).toBe('clip_b');
    expect(ids[3]).toBe('clip_c');
    expect(ids[4]).not.toBe('clip_c'); // clip_c's duplicate, right after it
    expect(result.current.state.selectedClipIds).toEqual(new Set([ids[1], ids[4]]));
  });

  it('copyClips + pasteClips appends fresh-id copies to the end of the timeline', () => {
    const { result, project } = setupMultiClip();

    act(() => { result.current.actions.copyClips(['clip_a']); });
    act(() => { result.current.actions.pasteClips(); });

    const ids = project.video_edit.clips.map((c) => c.clip_id);
    expect(ids).toHaveLength(4);
    expect(ids.slice(0, 3)).toEqual(['clip_a', 'clip_b', 'clip_c']);
    expect(ids[3]).not.toBe('clip_a');
    expect(project.video_edit.clips[3].video_id).toBe('va');
    expect(result.current.state.selectedClipIds).toEqual(new Set([ids[3]]));
  });
});

describe('useEditorStage history (undo/redo)', () => {
  it('undo/redo step through history; edits more than the coalescing window apart become separate steps', async () => {
    const { result, project } = setupMultiClip();

    act(() => { result.current.actions.removeClips(['clip_a']); });
    // Past HISTORY_COALESCE_MS (400ms) - the next edit must record its own
    // history entry rather than folding into this one.
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    act(() => { result.current.actions.removeClips(['clip_b']); });

    expect(project.video_edit.clips.map((c) => c.clip_id)).toEqual(['clip_c']);

    act(() => { result.current.actions.undo(); });
    expect(project.video_edit.clips.map((c) => c.clip_id)).toEqual(['clip_b', 'clip_c']);
    expect(result.current.state.canRedo).toBe(true);

    act(() => { result.current.actions.undo(); });
    expect(project.video_edit.clips.map((c) => c.clip_id)).toEqual(['clip_a', 'clip_b', 'clip_c']);
    expect(result.current.state.canUndo).toBe(false);

    act(() => { result.current.actions.redo(); });
    expect(project.video_edit.clips.map((c) => c.clip_id)).toEqual(['clip_b', 'clip_c']);
  });

  it('rapid edits within the coalescing window collapse into a single undo step', () => {
    const { result, project } = setupMultiClip();
    act(() => { result.current.actions.removeClips(['clip_a']); });
    act(() => { result.current.actions.removeClips(['clip_b']); });
    expect(project.video_edit.clips.map((c) => c.clip_id)).toEqual(['clip_c']);

    act(() => { result.current.actions.undo(); });
    expect(project.video_edit.clips.map((c) => c.clip_id)).toEqual(['clip_a', 'clip_b', 'clip_c']);
    expect(result.current.state.canUndo).toBe(false);
  });

  it('a fresh edit after undo clears the redo branch', () => {
    const { result } = setupMultiClip();
    act(() => { result.current.actions.removeClips(['clip_a']); });
    act(() => { result.current.actions.undo(); });
    expect(result.current.state.canRedo).toBe(true);

    act(() => { result.current.actions.removeClips(['clip_b']); });
    expect(result.current.state.canRedo).toBe(false);
  });
});

describe('useEditorStage resetClip', () => {
  it("reverts a clip's trim and speed back to the full source at 1x", () => {
    const { result, project } = setupMultiClip();
    act(() => { result.current.actions.setClipSpeed('clip_a', 2); });
    act(() => { result.current.actions.setClipTrim('clip_a', 500, 3000); });

    act(() => { result.current.actions.resetClip('clip_a'); });

    expect(project.video_edit.clips.find((c) => c.clip_id === 'clip_a')).toMatchObject({
      trim_start_ms: 0, trim_end_ms: null, speed: 1.0,
    });
  });
});

describe('useEditorStage overlays', () => {
  it('addOverlay drops a new overlay at the playhead with sane defaults, and selects it', () => {
    const { result, project } = setupMultiClip();
    act(() => { result.current.actions.seek(1500); });

    act(() => { result.current.actions.addOverlay('logo', 'logo_1'); });

    expect(project.video_edit.overlays).toHaveLength(1);
    const overlay = project.video_edit.overlays[0];
    expect(overlay).toMatchObject({ kind: 'logo', source_id: 'logo_1', start_ms: 1500 });
    expect(overlay.duration_ms).toBeGreaterThan(0);
    expect(result.current.state.selectedOverlayId).toBe(overlay.overlay_id);
    // Picking an overlay clears any clip selection - the inspector shows one or the other.
    expect(result.current.state.selectedClipIds).toEqual(new Set());
  });

  it('setOverlayTiming/setOverlayPosition/setOverlayWidthPct/setOverlayOpacity patch just that overlay', () => {
    const { result, project } = setupMultiClip();
    act(() => { result.current.actions.addOverlay('title_card', 'tcv_1'); });
    const id = project.video_edit.overlays[0].overlay_id;

    act(() => { result.current.actions.setOverlayTiming(id, 2000, 4000); });
    act(() => { result.current.actions.setOverlayPosition(id, 'top-left'); });
    act(() => { result.current.actions.setOverlayWidthPct(id, 35); });
    act(() => { result.current.actions.setOverlayOpacity(id, 0.5); });

    expect(project.video_edit.overlays[0]).toMatchObject({
      start_ms: 2000, duration_ms: 4000, position: 'top-left', width_pct: 35, opacity: 0.5,
    });
  });

  it('selectOverlay clears the clip selection; selecting a clip clears the overlay selection', () => {
    const { result, project } = setupMultiClip();
    act(() => { result.current.actions.addOverlay('logo', 'logo_1'); });
    const overlayId = project.video_edit.overlays[0].overlay_id;

    act(() => { result.current.actions.selectClip('clip_a'); });
    expect(result.current.state.selectedOverlayId).toBeNull();

    act(() => { result.current.actions.selectOverlay(overlayId); });
    expect(result.current.state.selectedClipIds).toEqual(new Set());
    expect(result.current.state.selectedOverlayId).toBe(overlayId);
  });

  it('removeOverlay drops it and clears the selection if it was selected', () => {
    const { result, project } = setupMultiClip();
    act(() => { result.current.actions.addOverlay('logo', 'logo_1'); });
    const overlayId = project.video_edit.overlays[0].overlay_id;

    act(() => { result.current.actions.removeOverlay(overlayId); });

    expect(project.video_edit.overlays).toEqual([]);
    expect(result.current.state.selectedOverlayId).toBeNull();
  });

  it('undo/redo cover overlay edits too, not just clips', () => {
    const { result, project } = setupMultiClip();
    act(() => { result.current.actions.addOverlay('logo', 'logo_1'); });

    act(() => { result.current.actions.undo(); });
    // The fixture project never had an `overlays` key at all before this
    // edit - undo restores that exact prior shape (absent, not `[]`).
    expect(project.video_edit.overlays || []).toEqual([]);

    act(() => { result.current.actions.redo(); });
    expect(project.video_edit.overlays).toHaveLength(1);
  });
});

describe('useEditorStage transitions & fades', () => {
  it('setClipTransition sets transition_in on just that clip', () => {
    const { result, project } = setupMultiClip();

    act(() => { result.current.actions.setClipTransition('clip_b', 'dissolve', 750); });

    expect(project.video_edit.clips.find((c) => c.clip_id === 'clip_b').transition_in).toEqual({
      type: 'dissolve', duration_ms: 750,
    });
    expect(project.video_edit.clips.find((c) => c.clip_id === 'clip_a').transition_in).toBeUndefined();
  });

  it("setClipTransition('none', ...) clears it back to a hard cut", () => {
    const { result, project } = setupMultiClip();
    act(() => { result.current.actions.setClipTransition('clip_b', 'fadeblack', 500); });

    act(() => { result.current.actions.setClipTransition('clip_b', 'none', 0); });

    expect(project.video_edit.clips.find((c) => c.clip_id === 'clip_b').transition_in).toBeNull();
  });

  it('setClipFadeIn/setClipFadeOut set the fields, and a 0 duration clears them', () => {
    const { result, project } = setupMultiClip();

    act(() => { result.current.actions.setClipFadeIn('clip_a', 'black', 500); });
    act(() => { result.current.actions.setClipFadeOut('clip_a', 'white', 750); });

    let clip = project.video_edit.clips.find((c) => c.clip_id === 'clip_a');
    expect(clip.fade_in).toEqual({ color: 'black', duration_ms: 500 });
    expect(clip.fade_out).toEqual({ color: 'white', duration_ms: 750 });

    act(() => { result.current.actions.setClipFadeIn('clip_a', 'black', 0); });
    clip = project.video_edit.clips.find((c) => c.clip_id === 'clip_a');
    expect(clip.fade_in).toBeNull();
  });

  it('selectTransition clears clip/overlay selection; selecting a clip clears the transition selection', () => {
    const { result } = setupMultiClip();

    act(() => { result.current.actions.selectClip('clip_a'); });
    act(() => { result.current.actions.selectTransition('clip_b'); });
    expect(result.current.state.selectedClipIds).toEqual(new Set());
    expect(result.current.state.selectedTransitionClipId).toBe('clip_b');

    act(() => { result.current.actions.selectClip('clip_a'); });
    expect(result.current.state.selectedTransitionClipId).toBeNull();
  });

  it('removeClips clears the transition selection if the selected boundary was removed', () => {
    const { result } = setupMultiClip();
    act(() => { result.current.actions.selectTransition('clip_b'); });

    act(() => { result.current.actions.removeClips(['clip_b']); });

    expect(result.current.state.selectedTransitionClipId).toBeNull();
  });

  it('undo restores a cleared transition_in', () => {
    const { result, project } = setupMultiClip();
    act(() => { result.current.actions.setClipTransition('clip_b', 'dissolve', 500); });

    act(() => { result.current.actions.undo(); });

    expect(project.video_edit.clips.find((c) => c.clip_id === 'clip_b').transition_in).toBeUndefined();
  });
});

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
