import { describe, expect, it } from 'vitest';
import { detectBeats, MIN_BEAT_GAP_MS } from './beats.js';

/** A synthetic bass envelope: `count` sharp attacks, evenly spaced across
 * `length` buckets, each decaying over a few buckets - the shape a kick drum
 * leaves in `useAudioPeaks`'s bass band. */
function envelopeWithHits(length, count) {
  const out = new Float32Array(length);
  const spacing = Math.floor(length / count);
  for (let hit = 0; hit < count; hit += 1) {
    const at = hit * spacing;
    for (let decay = 0; decay < 6 && at + decay < length; decay += 1) {
      out[at + decay] = 1 - decay * 0.16;
    }
  }
  return out;
}

describe('detectBeats', () => {
  it('finds one beat per attack in a clean, evenly spaced envelope', () => {
    // 400 buckets over 20s = 50ms per bucket; 20 hits = one every second.
    // 19, not 20: an onset sitting exactly on bucket 0 has no preceding
    // bucket to have risen from, so there is nothing to detect there.
    const beats = detectBeats(envelopeWithHits(400, 20), 20000);
    expect(beats).toHaveLength(19);
    expect(beats[0].at_ms).toBeCloseTo(1000, -2);
    expect(beats[1].at_ms).toBeCloseTo(2000, -2);
  });

  it('never emits two beats closer together than MIN_BEAT_GAP_MS', () => {
    const beats = detectBeats(envelopeWithHits(400, 60), 20000);
    beats.slice(1).forEach((beat, i) => {
      expect(beat.at_ms - beats[i].at_ms).toBeGreaterThanOrEqual(MIN_BEAT_GAP_MS);
    });
  });

  it('finds nothing in flat silence', () => {
    expect(detectBeats(new Float32Array(400), 20000)).toEqual([]);
  });

  it('refuses envelopes too short or durations too bogus to mean anything', () => {
    expect(detectBeats(new Float32Array(4), 20000)).toEqual([]);
    expect(detectBeats(envelopeWithHits(400, 20), 0)).toEqual([]);
    expect(detectBeats(null, 20000)).toEqual([]);
  });
});
