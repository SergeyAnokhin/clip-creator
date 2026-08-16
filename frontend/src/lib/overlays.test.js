import { describe, expect, it } from 'vitest';
import {
  MIN_OVERLAY_MS, activeOverlaysAt, applyOverlayEdgeResize, applyOverlayMove, overlayPositionStyle,
} from './overlays.js';

describe('overlayPositionStyle', () => {
  it('pins the top-left grid point to the frame origin, untranslated', () => {
    expect(overlayPositionStyle('top-left')).toEqual({ top: '0%', left: '0%', transform: 'translate(0, 0)' });
  });

  it('pins the bottom-right grid point to the far corner, pulled back by its own size', () => {
    expect(overlayPositionStyle('bottom-right')).toEqual({
      top: '100%', left: '100%', transform: 'translate(-100%, -100%)',
    });
  });

  it('centers on both axes for "center"', () => {
    expect(overlayPositionStyle('center')).toEqual({ top: '50%', left: '50%', transform: 'translate(-50%, -50%)' });
  });

  it('falls back to the default position for an unknown key', () => {
    expect(overlayPositionStyle('nowhere')).toEqual(overlayPositionStyle('bottom-right'));
  });
});

describe('activeOverlaysAt', () => {
  const overlays = [
    { overlay_id: 'a', start_ms: 0, duration_ms: 1000 },
    { overlay_id: 'b', start_ms: 500, duration_ms: 1000 },
  ];

  it('includes an overlay whose window contains the playhead', () => {
    expect(activeOverlaysAt(overlays, 200).map((o) => o.overlay_id)).toEqual(['a']);
  });

  it('overlapping overlays can both be active at once, in array (z-)order', () => {
    expect(activeOverlaysAt(overlays, 700).map((o) => o.overlay_id)).toEqual(['a', 'b']);
  });

  it('the end bound is exclusive', () => {
    expect(activeOverlaysAt(overlays, 1000).map((o) => o.overlay_id)).toEqual(['b']);
  });

  it('is empty outside every window', () => {
    expect(activeOverlaysAt(overlays, 5000)).toEqual([]);
  });
});

describe('applyOverlayMove', () => {
  it('shifts start_ms by the delta', () => {
    expect(applyOverlayMove({ start_ms: 1000 }, 500)).toEqual({ startMs: 1500 });
  });

  it('clamps to 0', () => {
    expect(applyOverlayMove({ start_ms: 200 }, -9000)).toEqual({ startMs: 0 });
  });
});

describe('applyOverlayEdgeResize', () => {
  const overlay = { start_ms: 1000, duration_ms: 2000 }; // window: 1000..3000

  it('dragging the end edge only changes duration', () => {
    expect(applyOverlayEdgeResize(overlay, 'end', 500)).toEqual({ startMs: 1000, durationMs: 2500 });
  });

  it('dragging the start edge moves start and shrinks/grows duration, keeping the end fixed', () => {
    expect(applyOverlayEdgeResize(overlay, 'start', 500)).toEqual({ startMs: 1500, durationMs: 1500 });
    expect(applyOverlayEdgeResize(overlay, 'start', -500)).toEqual({ startMs: 500, durationMs: 2500 });
  });

  it('keeps at least MIN_OVERLAY_MS when the end edge is dragged past the start', () => {
    expect(applyOverlayEdgeResize(overlay, 'end', -9000).durationMs).toBe(MIN_OVERLAY_MS);
  });

  it('keeps at least MIN_OVERLAY_MS and never goes negative when the start edge is dragged past the end', () => {
    const result = applyOverlayEdgeResize(overlay, 'start', 9000);
    expect(result.startMs).toBe(3000 - MIN_OVERLAY_MS);
    expect(result.durationMs).toBe(MIN_OVERLAY_MS);
  });

  it('the start edge cannot go negative', () => {
    expect(applyOverlayEdgeResize({ start_ms: 100, duration_ms: 2000 }, 'start', -9000).startMs).toBe(0);
  });
});
