import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ADJUST, DEFAULT_FREEZE_MS, MAX_SPEED, MIN_CLIP_MS, MIN_SPEED, UNKNOWN_DURATION_FALLBACK_MS,
  applyEdgeSpeed, applyEdgeTrim, clampTrim, computeClipDurationMs, computeTimelineClips, dropIndexForStart,
  findActiveClip, freezeClipsAt, getTotalDurationMs, isDefaultAdjust, moveClip, nextSpeedPreset,
  resolveTrimEndMs, splitClipsAt, trimEdgeToPlayhead,
} from './timeline.js';

describe('resolveTrimEndMs', () => {
  it('uses trim_end_ms when set', () => {
    expect(resolveTrimEndMs({ trim_end_ms: 3000 }, 5000)).toBe(3000);
  });

  it('falls back to the source duration when null', () => {
    expect(resolveTrimEndMs({ trim_end_ms: null }, 5000)).toBe(5000);
  });

  it('falls back to a fixed stand-in when both trim_end_ms and the source duration are unknown', () => {
    // e.g. an imported/uploaded clip - video.save_uploaded_video never
    // probes the real file, so duration_seconds (and thus sourceDurationMs
    // here) is 0/missing.
    expect(resolveTrimEndMs({ trim_end_ms: null }, 0)).toBe(UNKNOWN_DURATION_FALLBACK_MS);
  });
});

describe('computeClipDurationMs', () => {
  it('is the trim window at 1x speed', () => {
    const clip = { trim_start_ms: 500, trim_end_ms: 4500, speed: 1 };
    expect(computeClipDurationMs(clip, 5000)).toBe(4000);
  });

  it('shrinks with a higher speed', () => {
    const clip = { trim_start_ms: 0, trim_end_ms: 4000, speed: 2 };
    expect(computeClipDurationMs(clip, 4000)).toBe(2000);
  });

  it('grows with a lower speed', () => {
    const clip = { trim_start_ms: 0, trim_end_ms: 4000, speed: 0.5 };
    expect(computeClipDurationMs(clip, 4000)).toBe(8000);
  });

  it('defaults trim_end_ms to the full source duration', () => {
    const clip = { trim_start_ms: 0, trim_end_ms: null, speed: 1 };
    expect(computeClipDurationMs(clip, 3000)).toBe(3000);
  });
});

describe('computeTimelineClips', () => {
  const clips = [
    { clip_id: 'a', video_id: 'va', trim_start_ms: 0, trim_end_ms: 2000, speed: 1 },
    { clip_id: 'b', video_id: 'vb', trim_start_ms: 1000, trim_end_ms: 3000, speed: 1 },
    { clip_id: 'c', video_id: 'vc', trim_start_ms: 0, trim_end_ms: 1000, speed: 2 },
  ];
  const durations = { va: 2000, vb: 3000, vc: 4000 };

  it('lays clips back to back with cumulative offsets', () => {
    const result = computeTimelineClips(clips, durations);
    expect(result[0]).toMatchObject({ startMs: 0, endMs: 2000, durationMs: 2000 });
    expect(result[1]).toMatchObject({ startMs: 2000, endMs: 4000, durationMs: 2000 });
    expect(result[2]).toMatchObject({ startMs: 4000, endMs: 4500, durationMs: 500 });
  });

  it('falls back to a fixed stand-in duration when the source duration is unknown', () => {
    const result = computeTimelineClips([{ clip_id: 'x', video_id: 'unknown', trim_start_ms: 0, trim_end_ms: null, speed: 1 }], {});
    expect(result[0].durationMs).toBe(UNKNOWN_DURATION_FALLBACK_MS);
  });
});

describe('getTotalDurationMs', () => {
  it('is the last clip end', () => {
    const clips = [
      { video_id: 'va', trim_start_ms: 0, trim_end_ms: 2000, speed: 1 },
      { video_id: 'vb', trim_start_ms: 0, trim_end_ms: 3000, speed: 1 },
    ];
    expect(getTotalDurationMs(clips, { va: 2000, vb: 3000 })).toBe(5000);
  });

  it('is 0 for an empty timeline', () => {
    expect(getTotalDurationMs([], {})).toBe(0);
  });
});

describe('findActiveClip', () => {
  const clips = [
    { video_id: 'va', trim_start_ms: 500, trim_end_ms: 2500, speed: 1 },
    { video_id: 'vb', trim_start_ms: 0, trim_end_ms: 2000, speed: 2 },
  ];
  const timelineClips = computeTimelineClips(clips, { va: 3000, vb: 4000 });
  // clip 0: output 0..2000 (trim 500..2500 @1x), clip 1: output 2000..3000 (trim 0..2000 @2x)

  it('returns null for an empty timeline', () => {
    expect(findActiveClip([], 0)).toBeNull();
  });

  it('clamps a negative playhead to the first clip start', () => {
    const active = findActiveClip(timelineClips, -100);
    expect(active.index).toBe(0);
    expect(active.localOffsetMs).toBe(500);
  });

  it('resolves a mid-clip playhead with the correct local seek offset', () => {
    const active = findActiveClip(timelineClips, 500);
    expect(active.index).toBe(0);
    expect(active.localOffsetMs).toBe(1000); // 500 (trim start) + 500 * 1x
  });

  it('accounts for speed when computing the local offset of the second clip', () => {
    const active = findActiveClip(timelineClips, 2500);
    expect(active.index).toBe(1);
    expect(active.localOffsetMs).toBe(1000); // 0 (trim start) + 500 * 2x
  });

  it('pins to the last clip end when the playhead runs past the timeline', () => {
    const active = findActiveClip(timelineClips, 999999);
    expect(active.index).toBe(1);
    expect(active.localOffsetMs).toBe(2000); // last clip's own trimEndMs
  });
});

describe('clampTrim', () => {
  it('leaves an in-bounds range untouched', () => {
    expect(clampTrim(1000, 4000, 5000)).toEqual({ trimStartMs: 1000, trimEndMs: 4000 });
  });

  it('clamps a negative start to 0', () => {
    expect(clampTrim(-500, 4000, 5000)).toEqual({ trimStartMs: 0, trimEndMs: 4000 });
  });

  it('clamps an end past the source duration', () => {
    expect(clampTrim(1000, 9000, 5000)).toEqual({ trimStartMs: 1000, trimEndMs: 5000 });
  });

  it('keeps at least 1ms between start and end when they cross', () => {
    expect(clampTrim(3000, 2000, 5000)).toEqual({ trimStartMs: 3000, trimEndMs: 3001 });
  });
});

describe('moveClip', () => {
  const clips = [{ clip_id: 'a' }, { clip_id: 'b' }, { clip_id: 'c' }];

  it('moves a clip forward', () => {
    expect(moveClip(clips, 0, 2).map((c) => c.clip_id)).toEqual(['b', 'c', 'a']);
  });

  it('moves a clip backward', () => {
    expect(moveClip(clips, 2, 0).map((c) => c.clip_id)).toEqual(['c', 'a', 'b']);
  });

  it('is a no-op for the same or an out-of-range index', () => {
    expect(moveClip(clips, 1, 1)).toBe(clips);
    expect(moveClip(clips, 1, 5)).toBe(clips);
  });
});

describe('dropIndexForStart', () => {
  // output layout: a 0..2000, b 2000..4000, c 4000..6000
  const timelineClips = computeTimelineClips([
    { clip_id: 'a', video_id: 'v', trim_start_ms: 0, trim_end_ms: 2000, speed: 1 },
    { clip_id: 'b', video_id: 'v', trim_start_ms: 0, trim_end_ms: 2000, speed: 1 },
    { clip_id: 'c', video_id: 'v', trim_start_ms: 0, trim_end_ms: 2000, speed: 1 },
  ], { v: 2000 });

  it('keeps the index for a drag that stays in place', () => {
    expect(dropIndexForStart(timelineClips, 0, 0)).toBe(0);
  });

  it('swaps with the next clip once the dragged centre passes it', () => {
    expect(dropIndexForStart(timelineClips, 0, 2500)).toBe(1);
  });

  it('lands last when dragged past every other clip', () => {
    expect(dropIndexForStart(timelineClips, 0, 9000)).toBe(2);
  });

  it('lands first when dragged before every other clip', () => {
    expect(dropIndexForStart(timelineClips, 2, -1000)).toBe(0);
  });
});

describe('applyEdgeTrim', () => {
  const clip = { trim_start_ms: 1000, trim_end_ms: 4000, speed: 1 };

  it('moves only the dragged start edge', () => {
    expect(applyEdgeTrim(clip, 5000, 'start', 500)).toEqual({ trimStartMs: 1500, trimEndMs: 4000 });
  });

  it('moves only the dragged end edge', () => {
    expect(applyEdgeTrim(clip, 5000, 'end', -1000)).toEqual({ trimStartMs: 1000, trimEndMs: 3000 });
  });

  it('converts the output-space delta by the clip speed', () => {
    expect(applyEdgeTrim({ ...clip, speed: 2 }, 5000, 'end', 500)).toEqual({ trimStartMs: 1000, trimEndMs: 5000 });
  });

  it('clamps the start edge to 0 and the end edge to the source duration', () => {
    expect(applyEdgeTrim(clip, 5000, 'start', -9000).trimStartMs).toBe(0);
    expect(applyEdgeTrim(clip, 5000, 'end', 9000).trimEndMs).toBe(5000);
  });

  it('keeps at least MIN_CLIP_MS between the edges', () => {
    expect(applyEdgeTrim(clip, 5000, 'start', 9000).trimStartMs).toBe(4000 - MIN_CLIP_MS);
    expect(applyEdgeTrim(clip, 5000, 'end', -9000).trimEndMs).toBe(1000 + MIN_CLIP_MS);
  });

  it('leaves the end edge unbounded above when the source duration is unknown', () => {
    const imported = { trim_start_ms: 0, trim_end_ms: 5000, speed: 1 };
    expect(applyEdgeTrim(imported, 0, 'end', 3000).trimEndMs).toBe(8000);
  });
});

describe('applyEdgeSpeed', () => {
  // window = 4000-1000 = 3000ms, speed 1 -> 3000ms on the output timeline.
  const clip = { trim_start_ms: 1000, trim_end_ms: 4000, speed: 1 };

  it('slows the clip down when the end edge is dragged outward (longer output)', () => {
    // new duration 3000+1000=4000ms -> speed 3000/4000
    expect(applyEdgeSpeed(clip, 5000, 'end', 1000).speed).toBe(0.75);
  });

  it('speeds the clip up when the end edge is dragged inward (shorter output)', () => {
    // new duration 3000-2000=1000ms -> speed 3000/1000
    expect(applyEdgeSpeed(clip, 5000, 'end', -2000).speed).toBe(3);
  });

  it('the start edge reads the opposite sign of the same delta as the end edge', () => {
    expect(applyEdgeSpeed(clip, 5000, 'start', -1000).speed).toBe(applyEdgeSpeed(clip, 5000, 'end', 1000).speed);
  });

  it('leaves the trim window itself untouched - only speed changes', () => {
    const result = applyEdgeSpeed(clip, 5000, 'end', 1000);
    expect(result).not.toHaveProperty('trimStartMs');
    expect(result).not.toHaveProperty('trimEndMs');
  });

  it('clamps to MIN_SPEED/MAX_SPEED', () => {
    expect(applyEdgeSpeed(clip, 5000, 'end', 999999).speed).toBe(MIN_SPEED);
    expect(applyEdgeSpeed(clip, 5000, 'end', -2900).speed).toBe(MAX_SPEED);
  });
});

describe('nextSpeedPreset', () => {
  it('steps to the next preset above the current speed', () => {
    expect(nextSpeedPreset(0.5)).toBe(1);
    expect(nextSpeedPreset(1)).toBe(1.5);
    expect(nextSpeedPreset(1.5)).toBe(2);
  });

  it('wraps back to the smallest preset once past the largest', () => {
    expect(nextSpeedPreset(2)).toBe(0.5);
    expect(nextSpeedPreset(4)).toBe(0.5);
  });

  it('treats a missing/falsy speed as the default 1x', () => {
    expect(nextSpeedPreset(undefined)).toBe(1.5);
    expect(nextSpeedPreset(0)).toBe(1.5);
  });

  it('steps up from a non-preset custom value to the next preset above it', () => {
    expect(nextSpeedPreset(0.75)).toBe(1);
    expect(nextSpeedPreset(3)).toBe(0.5);
  });
});

describe('splitClipsAt', () => {
  const clips = [
    { clip_id: 'a', video_id: 'va', trim_start_ms: 0, trim_end_ms: 4000, speed: 1 },
    { clip_id: 'b', video_id: 'vb', trim_start_ms: 0, trim_end_ms: 4000, speed: 2 },
  ];
  // output layout: a 0..4000, b 4000..6000
  const durations = { va: 4000, vb: 4000 };
  const makeId = () => 'new';

  it('cuts the clip under the playhead into two back-to-back halves', () => {
    const result = splitClipsAt(clips, durations, 1500, makeId);
    expect(result.map((c) => c.clip_id)).toEqual(['a', 'new', 'b']);
    expect(result[0]).toMatchObject({ trim_start_ms: 0, trim_end_ms: 1500 });
    expect(result[1]).toMatchObject({ video_id: 'va', trim_start_ms: 1500, trim_end_ms: 4000 });
    expect(getTotalDurationMs(result, durations)).toBe(getTotalDurationMs(clips, durations));
  });

  it('converts the cut point to source time by the clip speed', () => {
    const result = splitClipsAt(clips, durations, 5000, makeId);
    expect(result[1]).toMatchObject({ trim_start_ms: 0, trim_end_ms: 2000 });
    expect(result[2]).toMatchObject({ trim_start_ms: 2000, trim_end_ms: 4000 });
  });

  it('is a no-op on a cut, past the end, or too close to an edge', () => {
    expect(splitClipsAt(clips, durations, 4000, makeId)).toBe(clips);
    expect(splitClipsAt(clips, durations, 99999, makeId)).toBe(clips);
    expect(splitClipsAt(clips, durations, 50, makeId)).toBe(clips);
  });
});

describe('trimEdgeToPlayhead', () => {
  const CLIPS = computeTimelineClips(
    [
      { clip_id: 'a', video_id: 'v1', trim_start_ms: 0, trim_end_ms: 4000, speed: 1 },
      { clip_id: 'b', video_id: 'v1', trim_start_ms: 0, trim_end_ms: 4000, speed: 2 },
    ],
    { v1: 10000 },
  );

  it('gives up the part of the clip the playhead has already passed', () => {
    expect(trimEdgeToPlayhead(CLIPS[0], 1500, 'start')).toEqual({ trimStartMs: 1500, trimEndMs: 4000 });
  });

  it('gives up the part the playhead has not reached yet', () => {
    expect(trimEdgeToPlayhead(CLIPS[0], 1500, 'end')).toEqual({ trimStartMs: 0, trimEndMs: 1500 });
  });

  it('converts the playhead into source time through the clip speed', () => {
    // clip b runs 4000ms of source at 2x, so it occupies 4000..6000 on the
    // output timeline; 1000ms into it is 2000ms into the source.
    expect(trimEdgeToPlayhead(CLIPS[1], 5000, 'end')).toEqual({ trimStartMs: 0, trimEndMs: 2000 });
  });

  it('refuses when the playhead is outside the clip or would leave a sliver', () => {
    expect(trimEdgeToPlayhead(CLIPS[0], 4000, 'end')).toBeNull();
    expect(trimEdgeToPlayhead(CLIPS[0], 0, 'start')).toBeNull();
    expect(trimEdgeToPlayhead(CLIPS[0], 50, 'end')).toBeNull();
    expect(trimEdgeToPlayhead(CLIPS[0], 3950, 'start')).toBeNull();
    expect(trimEdgeToPlayhead(null, 1000, 'end')).toBeNull();
  });
});

describe('freezeClipsAt', () => {
  const CLIPS = [{ clip_id: 'a', video_id: 'v1', trim_start_ms: 0, trim_end_ms: 4000, speed: 1 }];
  const DURATIONS = { v1: 10000 };
  let counter = 0;
  const makeId = () => `new_${(counter += 1)}`;

  it('splits the clip and inserts a held still of the exact frame', () => {
    counter = 0;
    const result = freezeClipsAt(CLIPS, DURATIONS, 1500, makeId);

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ clip_id: 'a', trim_start_ms: 0, trim_end_ms: 1500 });
    expect(result[1]).toMatchObject({
      freeze: true, trim_start_ms: 1500, trim_end_ms: 1500 + DEFAULT_FREEZE_MS, speed: 1, reverse: false,
    });
    expect(result[2]).toMatchObject({ trim_start_ms: 1500, trim_end_ms: 4000 });
  });

  it('gives the still and the right half their own ids', () => {
    counter = 0;
    const result = freezeClipsAt(CLIPS, DURATIONS, 1500, makeId);
    const ids = result.map((c) => c.clip_id);
    expect(new Set(ids).size).toBe(3);
  });

  it('does nothing when the playhead sits outside the timeline or on a cut', () => {
    expect(freezeClipsAt(CLIPS, DURATIONS, 0, makeId)).toBe(CLIPS);
    expect(freezeClipsAt(CLIPS, DURATIONS, 4000, makeId)).toBe(CLIPS);
    expect(freezeClipsAt(CLIPS, DURATIONS, 9999, makeId)).toBe(CLIPS);
  });
});

describe('isDefaultAdjust', () => {
  it('treats absent, empty and all-default corrections as "no correction"', () => {
    expect(isDefaultAdjust(null)).toBe(true);
    expect(isDefaultAdjust(undefined)).toBe(true);
    expect(isDefaultAdjust({ ...DEFAULT_ADJUST })).toBe(true);
    expect(isDefaultAdjust({ brightness: 0 })).toBe(true);
  });

  it('detects any single value moved off its default', () => {
    expect(isDefaultAdjust({ ...DEFAULT_ADJUST, saturation: 0 })).toBe(false);
  });
});
