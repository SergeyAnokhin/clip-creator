import { describe, expect, it } from 'vitest';
import {
  MIN_OVERLAY_MS, activeOverlaysAt, applyOverlayEdgeResize, applyOverlayMove, assignOverlayLanes,
  defaultOverlayTransform, migrateOverlay, overlayOpacityAt,
} from './overlays.js';

describe('migrateOverlay', () => {
  it('passes an already-migrated overlay through unchanged', () => {
    const overlay = {
      overlay_id: 'a', x_pct: 12, y_pct: 34, width_pct: 20, height_pct: 15, rotation_deg: 90,
    };
    expect(migrateOverlay(overlay)).toBe(overlay);
  });

  it('anchors "top-left" at the point itself (no back-translate)', () => {
    const migrated = migrateOverlay({ position: 'top-left', width_pct: 20 });
    expect(migrated.x_pct).toBe(0);
    expect(migrated.y_pct).toBe(0);
    expect(migrated.width_pct).toBe(20);
    expect(migrated.height_pct).toBe(20);
    expect(migrated.rotation_deg).toBe(0);
  });

  it('pulls "bottom-right" back by its own full width/height', () => {
    const migrated = migrateOverlay({ position: 'bottom-right', width_pct: 20 });
    expect(migrated.x_pct).toBe(80);
    expect(migrated.y_pct).toBe(80);
  });

  it('pulls "center" back by half its own width/height', () => {
    const migrated = migrateOverlay({ position: 'center', width_pct: 20 });
    expect(migrated.x_pct).toBe(40);
    expect(migrated.y_pct).toBe(40);
  });

  it('falls back to the legacy default position for an unknown key', () => {
    const migrated = migrateOverlay({ position: 'nowhere', width_pct: 20 });
    expect(migrated.x_pct).toBe(80);
    expect(migrated.y_pct).toBe(80);
  });

  it('falls back to the default width when the legacy overlay has none', () => {
    const migrated = migrateOverlay({ position: 'top-left' });
    expect(migrated.width_pct).toBe(20);
    expect(migrated.height_pct).toBe(20);
  });
});

describe('defaultOverlayTransform', () => {
  it('matches migrating a fresh bottom-right/default-width legacy overlay', () => {
    const t = defaultOverlayTransform();
    expect(t).toEqual({
      x_pct: 80, y_pct: 80, width_pct: 20, height_pct: 20, rotation_deg: 0,
    });
  });
});

describe('assignOverlayLanes', () => {
  it('gives three mutually-overlapping overlays three distinct lanes', () => {
    const overlays = [
      { overlay_id: 'a', start_ms: 0, duration_ms: 3000 },
      { overlay_id: 'b', start_ms: 500, duration_ms: 3000 },
      { overlay_id: 'c', start_ms: 1000, duration_ms: 3000 },
    ];
    const lanes = assignOverlayLanes(overlays);
    expect(new Set(lanes.values()).size).toBe(3);
  });

  it('puts two non-overlapping overlays in the same lane (lane 0)', () => {
    const overlays = [
      { overlay_id: 'a', start_ms: 0, duration_ms: 1000 },
      { overlay_id: 'b', start_ms: 1000, duration_ms: 1000 },
    ];
    const lanes = assignOverlayLanes(overlays);
    expect(lanes.get('a')).toBe(0);
    expect(lanes.get('b')).toBe(0);
  });

  it('reuses a lane freed by an earlier overlay ending before a later one starts', () => {
    const overlays = [
      { overlay_id: 'a', start_ms: 0, duration_ms: 1000 }, // ends 1000, lane 0
      { overlay_id: 'b', start_ms: 200, duration_ms: 1000 }, // overlaps a -> lane 1
      { overlay_id: 'c', start_ms: 1500, duration_ms: 1000 }, // overlaps neither -> reuses lane 0
    ];
    const lanes = assignOverlayLanes(overlays);
    expect(lanes.get('a')).toBe(0);
    expect(lanes.get('b')).toBe(1);
    expect(lanes.get('c')).toBe(0);
  });

  it('is order-independent - sorts by start_ms internally', () => {
    const overlays = [
      { overlay_id: 'b', start_ms: 500, duration_ms: 3000 },
      { overlay_id: 'a', start_ms: 0, duration_ms: 3000 },
    ];
    const lanes = assignOverlayLanes(overlays);
    expect(new Set(lanes.values()).size).toBe(2);
  });

  it('returns an empty map for no overlays', () => {
    expect(assignOverlayLanes([]).size).toBe(0);
  });
});

describe('overlayOpacityAt', () => {
  // window: 1000..3000 (duration 2000), fade_in 400ms, fade_out 600ms
  const overlay = {
    start_ms: 1000, duration_ms: 2000, opacity: 0.8, fade_in_ms: 400, fade_out_ms: 600,
  };

  it('ramps up linearly during fade-in', () => {
    expect(overlayOpacityAt(overlay, 1000)).toBeCloseTo(0);
    expect(overlayOpacityAt(overlay, 1200)).toBeCloseTo(0.8 * 0.5);
    expect(overlayOpacityAt(overlay, 1400)).toBeCloseTo(0.8);
  });

  it('stays at the flat opacity in the steady middle', () => {
    expect(overlayOpacityAt(overlay, 2000)).toBeCloseTo(0.8);
  });

  it('ramps down linearly during fade-out', () => {
    expect(overlayOpacityAt(overlay, 2400)).toBeCloseTo(0.8);
    expect(overlayOpacityAt(overlay, 2700)).toBeCloseTo(0.8 * 0.5);
    expect(overlayOpacityAt(overlay, 3000)).toBeCloseTo(0);
  });

  it('returns the flat opacity with no fades set', () => {
    expect(overlayOpacityAt({ start_ms: 0, duration_ms: 1000, opacity: 0.6 }, 500)).toBe(0.6);
  });

  it('compresses fades proportionally when they would outlast the overlay', () => {
    // duration 1000, fade_in + fade_out = 1600 > duration -> scaled to 625/375
    const o = {
      start_ms: 0, duration_ms: 1000, opacity: 1, fade_in_ms: 1000, fade_out_ms: 600,
    };
    // Midpoint (the fade_in/fade_out boundary after scaling) should be at ~1 (peak).
    expect(overlayOpacityAt(o, 625)).toBeCloseTo(1);
    expect(overlayOpacityAt(o, 0)).toBeCloseTo(0);
    expect(overlayOpacityAt(o, 1000)).toBeCloseTo(0);
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
