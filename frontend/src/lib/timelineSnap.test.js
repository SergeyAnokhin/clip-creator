import { describe, expect, it } from 'vitest';
import { buildSnapTargets, snapDelta, snapMs } from './timelineSnap.js';

const CLIPS = [
  { clip_id: 'a', startMs: 0, endMs: 4000 },
  { clip_id: 'b', startMs: 4000, endMs: 9000 },
];
const OVERLAYS = [{ overlay_id: 'o1', start_ms: 2000, duration_ms: 1000 }];
const MARKERS = [{ marker_id: 'm1', at_ms: 6500 }];

describe('buildSnapTargets', () => {
  it('collects clip boundaries, overlay edges, markers, the playhead and both ends', () => {
    expect(buildSnapTargets({
      clips: CLIPS, overlays: OVERLAYS, markers: MARKERS, playheadMs: 1234, totalDurationMs: 9000,
    })).toEqual([0, 1234, 2000, 3000, 4000, 6500, 9000]);
  });

  it('excludes the object being dragged, so it cannot snap to its own edges', () => {
    const targets = buildSnapTargets({
      clips: CLIPS, overlays: OVERLAYS, markers: [], totalDurationMs: 9000, excludeOverlayId: 'o1',
    });
    expect(targets).not.toContain(2000);
    expect(targets).not.toContain(3000);

    const clipTargets = buildSnapTargets({ clips: CLIPS, totalDurationMs: 9000, excludeClipId: 'b' });
    expect(clipTargets).toEqual([0, 4000, 9000]);
  });

  it('drops negative and non-finite candidates and de-duplicates the rest', () => {
    expect(buildSnapTargets({
      clips: [{ clip_id: 'a', startMs: 0, endMs: 4000 }],
      markers: [{ at_ms: -100 }, { at_ms: 4000 }],
      playheadMs: undefined,
      totalDurationMs: 4000,
    })).toEqual([0, 4000]);
  });
});

describe('snapMs', () => {
  it('pulls a value onto the nearest target inside the threshold', () => {
    expect(snapMs(3980, [0, 4000, 9000], 50)).toEqual({ ms: 4000, snappedTo: 4000 });
  });

  it('leaves a value alone when nothing is close enough', () => {
    expect(snapMs(3900, [0, 4000, 9000], 50)).toEqual({ ms: 3900, snappedTo: null });
  });

  it('prefers the closest of two in-range targets', () => {
    expect(snapMs(4010, [4000, 4030], 50).ms).toBe(4000);
  });
});

describe('snapDelta', () => {
  it('snaps the resulting position and reports the delta that gets there', () => {
    // The edge sits at 3900 and is dragged +80ms; 4000 is within 50ms of the
    // 3980 landing spot, so the delta becomes +100.
    expect(snapDelta(3900, 80, [0, 4000], 50)).toEqual({ deltaMs: 100, snappedTo: 4000 });
  });

  it('passes the delta straight through when snapping is disabled (Alt held)', () => {
    expect(snapDelta(3900, 80, [0, 4000], 50, false)).toEqual({ deltaMs: 80, snappedTo: null });
  });
});
