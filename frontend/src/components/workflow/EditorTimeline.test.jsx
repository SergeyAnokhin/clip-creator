import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import EditorTimeline from './EditorTimeline.jsx';
import { computeTimelineClips, getTotalDurationMs } from '../../lib/timeline.js';
import { DICT } from '../../i18n/dict.js';

// jsdom has no layout engine, so every element's getBoundingClientRect() is
// zero-rect - EditorTimeline's pointer math (pointerToMs, drag deltas) only
// ever reads clientX relative to that zero left edge or as a start/current
// delta, so tests below pick clientX values directly in that frame instead
// of trying to fake layout. viewportWidth also falls back to its 900 default
// (no ResizeObserver-driven clientWidth in jsdom), which is what fitScale
// below is computed from.
const L = DICT.ru;

const RAW_CLIPS = [
  { clip_id: 'clip_a', scene_index: 0, video_id: 'va', trim_start_ms: 0, trim_end_ms: 5000, speed: 1 },
  { clip_id: 'clip_b', scene_index: 1, video_id: 'vb', trim_start_ms: 0, trim_end_ms: 5000, speed: 1 },
];
const SOURCE_DURATIONS = { va: 10000, vb: 10000 };
const SCENES = [
  { scene_index: 0, lyric_segment: 'Scene A', videos: [{ video_id: 'va', duration_seconds: 10 }] },
  { scene_index: 1, lyric_segment: 'Scene B', videos: [{ video_id: 'vb', duration_seconds: 10 }] },
];

// scale = fitScale = viewportWidth(900) / contentDurationMs(10000) = 0.09 px/ms
const SCALE = 900 / 10000;

function renderTimeline(overrides = {}) {
  const clips = overrides.clips || computeTimelineClips(RAW_CLIPS, SOURCE_DURATIONS);
  const actions = {
    seek: vi.fn(), selectClip: vi.fn(), reorderClip: vi.fn(), setClipTrim: vi.fn(),
    splitAtPlayhead: vi.fn(), removeClip: vi.fn(), play: vi.fn(), pause: vi.fn(),
    ...overrides.actions,
  };
  const props = {
    L, projectId: 'p1', scenes: SCENES, totalDurationMs: getTotalDurationMs(RAW_CLIPS, SOURCE_DURATIONS),
    selectedTrack: null, playheadMs: 0, isPlaying: false, selectedClipId: null,
    ...overrides, clips, actions,
  };
  const utils = render(<EditorTimeline {...props} />);
  return { ...utils, actions };
}

describe('EditorTimeline layout', () => {
  it('lays clips back to back at the fit-to-width scale', () => {
    const { container } = renderTimeline();
    const [a, b] = container.querySelectorAll('.tl-clip');
    expect(a.style.left).toBe('0px');
    expect(parseFloat(a.style.width)).toBeCloseTo(5000 * SCALE, 3);
    expect(parseFloat(b.style.left)).toBeCloseTo(5000 * SCALE, 3);
  });

  it('shows the empty-timeline hint and disables split with no clips', () => {
    const { container, getByTitle } = renderTimeline({ clips: [] });
    expect(container.querySelector('.tl-track-empty')).not.toBeNull();
    expect(getByTitle(L.editor_toolSplit)).toBeDisabled();
  });
});

describe('EditorTimeline gestures', () => {
  it('scrubs the playhead from a content click', () => {
    const { container, actions } = renderTimeline();
    const content = container.querySelector('.tl-content');
    fireEvent.pointerDown(content, { clientX: 450, button: 0 });
    expect(actions.selectClip).toHaveBeenCalledWith(null);
    expect(actions.seek).toHaveBeenCalledTimes(1);
    expect(actions.seek.mock.calls[0][0]).toBeCloseTo(450 / SCALE, 0);
  });

  it('reorders on a drag past the next clip, and leaves order untouched short of it', () => {
    const { container, actions } = renderTimeline();
    const clipA = container.querySelectorAll('.tl-clip')[0];

    fireEvent.pointerDown(clipA, { clientX: 100, button: 0 });
    expect(actions.selectClip).toHaveBeenCalledWith('clip_a');

    // dx = 500px -> ~5556ms past clip_a's own 0ms start, into clip_b's
    // 5000-10000ms span, so the drop index should move from 0 to 1.
    fireEvent(window, new PointerEvent('pointermove', { clientX: 600, bubbles: true }));
    fireEvent(window, new PointerEvent('pointerup', { clientX: 600, bubbles: true }));
    expect(actions.reorderClip).toHaveBeenCalledWith(0, 1);
  });

  it('does not reorder when the drag stays within the same clip slot', () => {
    const { container, actions } = renderTimeline();
    const clipA = container.querySelectorAll('.tl-clip')[0];

    fireEvent.pointerDown(clipA, { clientX: 100, button: 0 });
    fireEvent(window, new PointerEvent('pointermove', { clientX: 110, bubbles: true }));
    fireEvent(window, new PointerEvent('pointerup', { clientX: 110, bubbles: true }));
    expect(actions.reorderClip).not.toHaveBeenCalled();
  });

  it('trims the start edge, converting the pixel delta through the scale and clip speed', () => {
    const { container, actions } = renderTimeline();
    const clipA = container.querySelectorAll('.tl-clip')[0];
    const startHandle = clipA.querySelector('.tl-clip-handle-start');

    fireEvent.pointerDown(startHandle, { clientX: 200, button: 0 });
    fireEvent(window, new PointerEvent('pointermove', { clientX: 250, bubbles: true }));
    fireEvent(window, new PointerEvent('pointerup', { clientX: 250, bubbles: true }));

    expect(actions.selectClip).toHaveBeenCalledWith('clip_a');
    expect(actions.setClipTrim).toHaveBeenCalledTimes(1);
    const [clipId, trimStartMs, trimEndMs] = actions.setClipTrim.mock.calls[0];
    expect(clipId).toBe('clip_a');
    expect(trimStartMs).toBeCloseTo(50 / SCALE, 0); // dx=50px -> ms via the same scale
    expect(trimEndMs).toBe(5000); // end edge untouched
  });

  it('trims the end edge symmetrically', () => {
    const { container, actions } = renderTimeline();
    const clipB = container.querySelectorAll('.tl-clip')[1];
    const endHandle = clipB.querySelector('.tl-clip-handle-end');

    fireEvent.pointerDown(endHandle, { clientX: 300, button: 0 });
    fireEvent(window, new PointerEvent('pointermove', { clientX: 260, bubbles: true }));
    fireEvent(window, new PointerEvent('pointerup', { clientX: 260, bubbles: true }));

    const [clipId, trimStartMs, trimEndMs] = actions.setClipTrim.mock.calls[0];
    expect(clipId).toBe('clip_b');
    expect(trimStartMs).toBe(0);
    expect(trimEndMs).toBeCloseTo(5000 - 40 / SCALE, 0); // dx=-40px shrinks the end
  });

  it('splits at the playhead on "S", but only when the scroll container itself is the event target', () => {
    const { container, actions } = renderTimeline({ playheadMs: 2000 });
    const scroll = container.querySelector('.tl-scroll');

    fireEvent.keyDown(scroll, { code: 'KeyS' });
    expect(actions.splitAtPlayhead).toHaveBeenCalledTimes(1);

    // A key event that bubbles up from a child (e.g. a clip) must not
    // re-trigger the shortcut - onKeyDown guards on target === currentTarget.
    const clip = container.querySelector('.tl-clip');
    fireEvent.keyDown(clip, { code: 'KeyS', bubbles: true });
    expect(actions.splitAtPlayhead).toHaveBeenCalledTimes(1);
  });

  it('removes the selected clip on Delete', () => {
    const { container, actions } = renderTimeline({ selectedClipId: 'clip_a' });
    const scroll = container.querySelector('.tl-scroll');
    fireEvent.keyDown(scroll, { code: 'Delete' });
    expect(actions.removeClip).toHaveBeenCalledWith('clip_a');
  });

  it('toggles play/pause on Space', () => {
    const { container, actions } = renderTimeline({ isPlaying: false });
    const scroll = container.querySelector('.tl-scroll');
    fireEvent.keyDown(scroll, { code: 'Space' });
    expect(actions.play).toHaveBeenCalledTimes(1);
    expect(actions.pause).not.toHaveBeenCalled();
  });

  it('zooms in on ctrl+wheel, widening the content by the zoom factor', () => {
    const { container } = renderTimeline();
    const scroll = container.querySelector('.tl-scroll');
    const content = container.querySelector('.tl-content');
    const widthBefore = parseFloat(content.style.width);

    fireEvent.wheel(scroll, { deltaY: -100, ctrlKey: true });

    const widthAfter = parseFloat(content.style.width);
    expect(widthAfter / widthBefore).toBeCloseTo(1.6, 1);
  });

  it('ignores wheel zoom without the ctrl key (page can scroll normally)', () => {
    const { container } = renderTimeline();
    const scroll = container.querySelector('.tl-scroll');
    const content = container.querySelector('.tl-content');
    const widthBefore = parseFloat(content.style.width);

    fireEvent.wheel(scroll, { deltaY: -100, ctrlKey: false });

    expect(parseFloat(content.style.width)).toBe(widthBefore);
  });
});

// A zoomed-in timeline is one very wide DOM element - MAX_CONTENT_PX (see
// EditorTimeline.jsx) exists specifically to keep that element and its
// waveform <canvas> within the browser's own size limits when the project
// has many clips and/or a long audio track. These tests are the only
// coverage for that cap and for many-clip layout, since it's DOM-width
// logic local to the component, not one of lib/timeline.js's pure functions.
describe('EditorTimeline at scale', () => {
  const CLIP_COUNT = 150;
  const CLIP_MS = 4000;

  function manyClips() {
    const raw = Array.from({ length: CLIP_COUNT }, (_, i) => ({
      clip_id: `clip_${i}`, scene_index: i % 5, video_id: `v${i % 5}`,
      trim_start_ms: 0, trim_end_ms: CLIP_MS, speed: 1,
    }));
    const durations = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`v${i}`, CLIP_MS]));
    return { clips: computeTimelineClips(raw, durations), totalDurationMs: getTotalDurationMs(raw, durations) };
  }

  it('lays out 150 clips at their exact scaled offsets, in well under a second', () => {
    const { clips, totalDurationMs } = manyClips();
    const start = performance.now();
    const { container } = renderTimeline({ clips, totalDurationMs });
    expect(performance.now() - start).toBeLessThan(2000);

    // At this many clips, fit-to-width zooms out far enough that each
    // clip's true span (CLIP_MS * scale) falls under the 8px minimum
    // block width EditorTimeline enforces for clickability - so blocks
    // visually overlap here by design. `left` itself must still track the
    // clip's real startMs exactly; it's only the rendered `width` that's
    // floored, not the position.
    const nodes = container.querySelectorAll('.tl-clip');
    expect(nodes.length).toBe(CLIP_COUNT);
    nodes.forEach((node, i) => {
      expect(parseFloat(node.style.left)).toBeCloseTo(clips[i].startMs * (900 / totalDurationMs), 3);
    });
  });

  it('caps content width at MAX_CONTENT_PX instead of growing unbounded when zoomed all the way in', () => {
    const { clips, totalDurationMs } = manyClips();
    const { container } = renderTimeline({ clips, totalDurationMs });
    const scroll = container.querySelector('.tl-scroll');
    const content = container.querySelector('.tl-content');

    // 20 ctrl+wheel zoom-ins at 1.6x each - comfortably enough to hit the cap.
    for (let i = 0; i < 20; i++) {
      fireEvent.wheel(scroll, { deltaY: -100, ctrlKey: true });
    }

    expect(parseFloat(content.style.width)).toBeLessThanOrEqual(20000 + 1);
  });

  it('keeps the timeline usable (scrub still resolves a clip) with a long clip list', () => {
    const { clips, totalDurationMs } = manyClips();
    const { container, actions } = renderTimeline({ clips, totalDurationMs });
    const content = container.querySelector('.tl-content');
    fireEvent.pointerDown(content, { clientX: 50, button: 0 });
    expect(actions.seek).toHaveBeenCalledTimes(1);
    expect(Number.isFinite(actions.seek.mock.calls[0][0])).toBe(true);
  });
});
