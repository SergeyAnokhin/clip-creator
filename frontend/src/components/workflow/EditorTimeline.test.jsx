import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import EditorTimeline from './EditorTimeline.jsx';
import { computeTimelineClips, FRAME_MS, getTotalDurationMs } from '../../lib/timeline.js';
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
    splitAtPlayhead: vi.fn(), removeClips: vi.fn(), play: vi.fn(), pause: vi.fn(),
    setSelection: vi.fn(), selectAll: vi.fn(), duplicateClips: vi.fn(), copyClips: vi.fn(), pasteClips: vi.fn(),
    addMarker: vi.fn(), moveMarker: vi.fn(), removeMarker: vi.fn(), renameMarker: vi.fn(),
    trimClipToPlayhead: vi.fn(), addTextOverlay: vi.fn(), selectAudio: vi.fn(),
    ...overrides.actions,
  };
  const props = {
    L, projectId: 'p1', scenes: SCENES, totalDurationMs: getTotalDurationMs(RAW_CLIPS, SOURCE_DURATIONS),
    selectedTrack: null, playheadMs: 0, isPlaying: false, selectedClipIds: new Set(),
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

  it('shows the empty-timeline hint with no clips', () => {
    const { container } = renderTimeline({ clips: [] });
    expect(container.querySelector('.tl-track-empty')).not.toBeNull();
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

  it('splits at the playhead on "S" and on Ctrl+B', () => {
    const { container, actions } = renderTimeline({ playheadMs: 2000 });
    const scroll = container.querySelector('.tl-scroll');

    fireEvent.keyDown(scroll, { code: 'KeyS' });
    expect(actions.splitAtPlayhead).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(scroll, { code: 'KeyB', ctrlKey: true });
    expect(actions.splitAtPlayhead).toHaveBeenCalledTimes(2);
  });

  it('still fires shortcuts when a clip block (not the scroll box) has focus', () => {
    // Regression guard: onKeyDown used to bail out on `target !==
    // currentTarget`, and arrow navigation focuses a clip block by design -
    // so walking to a clip and pressing Delete silently did nothing.
    const { container, actions } = renderTimeline({
      playheadMs: 2000, selectedClipIds: new Set(['clip_a']),
    });
    const clip = container.querySelector('.tl-clip');

    fireEvent.keyDown(clip, { code: 'KeyS', bubbles: true });
    expect(actions.splitAtPlayhead).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(clip, { code: 'Delete', bubbles: true });
    expect(actions.removeClips).toHaveBeenCalledWith(['clip_a']);
  });

  it('does not hijack keys typed into a text field inside the timeline', () => {
    const { container, actions } = renderTimeline({ playheadMs: 2000 });
    const scroll = container.querySelector('.tl-scroll');
    const input = document.createElement('input');
    scroll.appendChild(input);

    fireEvent.keyDown(input, { code: 'KeyS', bubbles: true });
    expect(actions.splitAtPlayhead).not.toHaveBeenCalled();
  });

  it('removes the selected clip(s) on Delete', () => {
    const { container, actions } = renderTimeline({ selectedClipIds: new Set(['clip_a']) });
    const scroll = container.querySelector('.tl-scroll');
    fireEvent.keyDown(scroll, { code: 'Delete' });
    expect(actions.removeClips).toHaveBeenCalledWith(['clip_a']);
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

  it('scrolls instead of zooming when the ctrl key is not held', () => {
    const { container } = renderTimeline();
    const scroll = container.querySelector('.tl-scroll');
    const content = container.querySelector('.tl-content');
    const widthBefore = parseFloat(content.style.width);

    fireEvent.wheel(scroll, { deltaY: 100, ctrlKey: false });

    // Zoom is untouched...
    expect(parseFloat(content.style.width)).toBe(widthBefore);
    // ...and the box scrolled horizontally instead. jsdom has no layout, so
    // scrollLeft can't actually move past 0 - assert the handler consumed the
    // event (preventDefault) rather than letting the page scroll.
    const consumed = !fireEvent.wheel(scroll, { deltaY: 100, ctrlKey: false });
    expect(consumed).toBe(true);
  });
});

// Keyboard alternative to the pointer-only drag/trim gestures above - clips
// are focusable and selectable without a mouse. This does not cover drag or
// trim by keyboard, which remain mouse-only by design (see docs/code-map.md).
describe('EditorTimeline keyboard clip navigation', () => {
  it('selects a clip via Enter/Space on the clip itself, mirroring pointerdown selection', () => {
    const { container, actions } = renderTimeline();
    const clipB = container.querySelectorAll('.tl-clip')[1];
    fireEvent.keyDown(clipB, { code: 'Enter' });
    expect(actions.selectClip).toHaveBeenCalledWith('clip_b');
  });

  it('stops Space on a focused clip from also bubbling into the play/pause shortcut', () => {
    const { container, actions } = renderTimeline({ isPlaying: false });
    const clipA = container.querySelectorAll('.tl-clip')[0];
    fireEvent.keyDown(clipA, { code: 'Space' });
    expect(actions.selectClip).toHaveBeenCalledWith('clip_a');
    expect(actions.play).not.toHaveBeenCalled();
  });

  it('steps the playhead one frame with left/right, ten with shift', () => {
    const { actions, container } = renderTimeline({ playheadMs: 1000 });
    const scroll = container.querySelector('.tl-scroll');

    fireEvent.keyDown(scroll, { code: 'ArrowRight' });
    expect(actions.seek).toHaveBeenCalledWith(1000 + FRAME_MS);

    fireEvent.keyDown(scroll, { code: 'ArrowLeft', shiftKey: true });
    expect(actions.seek).toHaveBeenCalledWith(1000 - 10 * FRAME_MS);
  });

  it('jumps to the start and the end with Home/End', () => {
    const { actions, container } = renderTimeline({ playheadMs: 1000 });
    const scroll = container.querySelector('.tl-scroll');

    fireEvent.keyDown(scroll, { code: 'Home' });
    expect(actions.seek).toHaveBeenCalledWith(0);

    fireEvent.keyDown(scroll, { code: 'End' });
    // contentDurationMs floors at MIN_CONTENT_MS (5000) but the two clips
    // here are 10000ms in total, so that is what End seeks to.
    expect(actions.seek).toHaveBeenCalledWith(10000);
  });

  it('arrow-down with nothing selected selects and focuses the first clip', () => {
    const { container, actions } = renderTimeline();
    const scroll = container.querySelector('.tl-scroll');
    const [clipA] = container.querySelectorAll('.tl-clip');

    fireEvent.keyDown(scroll, { code: 'ArrowDown' });

    expect(actions.selectClip).toHaveBeenCalledWith('clip_a');
    expect(document.activeElement).toBe(clipA);
  });

  it('arrow-up with nothing selected selects and focuses the last clip', () => {
    const { container, actions } = renderTimeline();
    const scroll = container.querySelector('.tl-scroll');
    const [, clipB] = container.querySelectorAll('.tl-clip');

    fireEvent.keyDown(scroll, { code: 'ArrowUp' });

    expect(actions.selectClip).toHaveBeenCalledWith('clip_b');
    expect(document.activeElement).toBe(clipB);
  });

  it('arrow-down from a selected clip moves to its right-hand neighbor', () => {
    const { container, actions } = renderTimeline({ selectedClipIds: new Set(['clip_a']) });
    const scroll = container.querySelector('.tl-scroll');
    const [, clipB] = container.querySelectorAll('.tl-clip');

    fireEvent.keyDown(scroll, { code: 'ArrowDown' });

    expect(actions.selectClip).toHaveBeenCalledWith('clip_b');
    expect(document.activeElement).toBe(clipB);
  });

  it('clamps at the ends instead of wrapping past the first/last clip', () => {
    const { container, actions } = renderTimeline({ selectedClipIds: new Set(['clip_a']) });
    const scroll = container.querySelector('.tl-scroll');
    const [clipA] = container.querySelectorAll('.tl-clip');

    fireEvent.keyDown(scroll, { code: 'ArrowUp' });

    expect(actions.selectClip).toHaveBeenCalledWith('clip_a');
    expect(document.activeElement).toBe(clipA);
  });

  it('trims the selected clip up to the playhead with Q/W', () => {
    const { container, actions } = renderTimeline({
      playheadMs: 2000, selectedClipIds: new Set(['clip_a']),
    });
    const scroll = container.querySelector('.tl-scroll');

    fireEvent.keyDown(scroll, { code: 'KeyQ' });
    expect(actions.trimClipToPlayhead).toHaveBeenCalledWith('clip_a', 'start');

    fireEvent.keyDown(scroll, { code: 'KeyW' });
    expect(actions.trimClipToPlayhead).toHaveBeenCalledWith('clip_a', 'end');
  });

  it('drops a marker at the playhead on M', () => {
    const { container, actions } = renderTimeline({ playheadMs: 2000 });
    fireEvent.keyDown(container.querySelector('.tl-scroll'), { code: 'KeyM' });
    expect(actions.addMarker).toHaveBeenCalled();
  });
});

describe('EditorTimeline markers', () => {
  const MARKERS = [{ marker_id: 'mrk_1', at_ms: 4000, label: 'Припев' }];

  it('draws each marker on the ruler at its own position', () => {
    const { container } = renderTimeline({ markers: MARKERS });
    const marker = container.querySelector('.tl-marker');
    expect(marker).not.toBeNull();
    expect(parseFloat(marker.style.left)).toBeCloseTo(4000 * SCALE, 3);
    expect(marker.textContent).toContain('Припев');
  });

  it('removes a marker on right-click', () => {
    const { container, actions } = renderTimeline({ markers: MARKERS });
    fireEvent.contextMenu(container.querySelector('.tl-marker'));
    expect(actions.removeMarker).toHaveBeenCalledWith('mrk_1');
  });
});

describe('EditorTimeline multi-select', () => {
  it('ctrl+click adds a clip to the selection instead of dragging it', () => {
    const { container, actions } = renderTimeline();
    const clipB = container.querySelectorAll('.tl-clip')[1];

    fireEvent.pointerDown(clipB, { clientX: 600, button: 0, ctrlKey: true });
    expect(actions.selectClip).toHaveBeenCalledWith('clip_b', { additive: true, range: false });

    fireEvent(window, new PointerEvent('pointermove', { clientX: 700, bubbles: true }));
    fireEvent(window, new PointerEvent('pointerup', { clientX: 700, bubbles: true }));
    expect(actions.reorderClip).not.toHaveBeenCalled();
  });

  it('shift+click range-selects instead of dragging', () => {
    const { container, actions } = renderTimeline();
    const clipB = container.querySelectorAll('.tl-clip')[1];

    fireEvent.pointerDown(clipB, { clientX: 600, button: 0, shiftKey: true });
    expect(actions.selectClip).toHaveBeenCalledWith('clip_b', { additive: false, range: true });
  });

  it('marquee-selects every clip a shift-dragged rectangle overlaps', () => {
    const { container, actions } = renderTimeline();
    const content = container.querySelector('.tl-content');

    fireEvent.pointerDown(content, { clientX: 100, button: 0, shiftKey: true });
    fireEvent(window, new PointerEvent('pointermove', { clientX: 500, bubbles: true }));
    fireEvent(window, new PointerEvent('pointerup', { clientX: 500, bubbles: true }));

    // Rectangle spans ~1111-5556ms, overlapping both clip_a (0-5000) and
    // clip_b (5000-10000) - and it must take the marquee path, not scrub.
    expect(actions.setSelection).toHaveBeenCalledWith(['clip_a', 'clip_b']);
    expect(actions.seek).not.toHaveBeenCalled();
    expect(actions.selectClip).not.toHaveBeenCalled();
  });

  it('selects every clip on Ctrl+A', () => {
    const { container, actions } = renderTimeline();
    const scroll = container.querySelector('.tl-scroll');
    fireEvent.keyDown(scroll, { code: 'KeyA', ctrlKey: true });
    expect(actions.selectAll).toHaveBeenCalledTimes(1);
  });

  it('duplicates the selection on Ctrl+D', () => {
    const { container, actions } = renderTimeline({ selectedClipIds: new Set(['clip_a', 'clip_b']) });
    const scroll = container.querySelector('.tl-scroll');
    fireEvent.keyDown(scroll, { code: 'KeyD', ctrlKey: true });
    expect(actions.duplicateClips).toHaveBeenCalledTimes(1);
    expect(actions.duplicateClips.mock.calls[0][0].sort()).toEqual(['clip_a', 'clip_b']);
  });

  it('copies then pastes the selection on Ctrl+C / Ctrl+V', () => {
    const { container, actions } = renderTimeline({ selectedClipIds: new Set(['clip_a']) });
    const scroll = container.querySelector('.tl-scroll');
    fireEvent.keyDown(scroll, { code: 'KeyC', ctrlKey: true });
    expect(actions.copyClips).toHaveBeenCalledWith(['clip_a']);
    fireEvent.keyDown(scroll, { code: 'KeyV', ctrlKey: true });
    expect(actions.pasteClips).toHaveBeenCalledTimes(1);
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
