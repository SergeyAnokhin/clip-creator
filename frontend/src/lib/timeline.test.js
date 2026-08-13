import { describe, expect, it } from 'vitest';
import {
  UNKNOWN_DURATION_FALLBACK_MS, clampTrim, computeClipDurationMs, computeTimelineClips, findActiveClip,
  getTotalDurationMs, resolveTrimEndMs,
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
