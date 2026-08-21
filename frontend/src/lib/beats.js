/**
 * Beat/onset detection over an already-computed bass-energy envelope, used by
 * the Editor timeline's "маркеры по битам" button to drop a marker on every
 * detected hit (`useEditorStage.js`'s `addBeatMarkers`).
 *
 * Deliberately *not* an audio-grade beat tracker: `hooks/useAudioPeaks.js`
 * already decodes the track once and reduces it to `PEAK_BUCKETS` per-bucket
 * band energies for the waveform drawing, so this reuses that same array
 * rather than decoding or FFT-ing anything again. At ~4000 buckets over a
 * 3-minute track a bucket is ~45ms, which resolves a 120bpm beat (500ms) with
 * room to spare - plenty for "put a marker where the kick is", which is what
 * the feature is for. Anything the detector misplaces is a marker the user
 * drags, so a cheap, predictable heuristic beats a fragile clever one.
 *
 * The heuristic is classic spectral-flux onset detection reduced to one band:
 * take the positive first difference of the envelope (energy *rising* is what
 * a hit sounds like), compare each frame against a local moving average of
 * that difference times a sensitivity factor, and keep local maxima that
 * clear it. A minimum spacing then throws away the double-triggers a single
 * hit's attack produces across two or three adjacent buckets.
 */

// Ignore anything closer than this to the previous accepted beat - 300ms is
// a 200bpm ceiling, above which "beats" are almost certainly one hit's
// attack ringing across neighbouring buckets rather than separate notes.
export const MIN_BEAT_GAP_MS = 300;
// Half-width, in buckets, of the moving average each frame is judged
// against. Wide enough that one loud hit doesn't raise the bar for its own
// neighbours, narrow enough to follow a track that gets louder over time.
const WINDOW_BUCKETS = 20;
// How far above the local average the rise must be to count. Higher = fewer,
// more confident beats.
const THRESHOLD_FACTOR = 1.5;

/** `[{at_ms}]` for every detected onset in `envelope` (a 0..1 energy value
 * per bucket, evenly spanning `durationMs`). `sensitivity` scales the
 * threshold - >1 finds more beats, <1 fewer. Returns `[]` for an envelope too
 * short to say anything about. */
export function detectBeats(envelope, durationMs, sensitivity = 1) {
  if (!envelope || envelope.length < 8 || !(durationMs > 0)) return [];
  const bucketMs = durationMs / envelope.length;

  // Positive first difference - only rising energy is an onset candidate.
  const flux = new Float32Array(envelope.length);
  for (let i = 1; i < envelope.length; i += 1) {
    flux[i] = Math.max(0, envelope[i] - envelope[i - 1]);
  }

  const beats = [];
  let lastAtMs = -Infinity;
  for (let i = 1; i < flux.length - 1; i += 1) {
    // Local maximum first - cheapest test, rejects most frames outright.
    if (flux[i] <= flux[i - 1] || flux[i] < flux[i + 1]) continue;
    const from = Math.max(0, i - WINDOW_BUCKETS);
    const to = Math.min(flux.length, i + WINDOW_BUCKETS + 1);
    let sum = 0;
    for (let j = from; j < to; j += 1) sum += flux[j];
    const average = sum / (to - from);
    if (flux[i] < (average * THRESHOLD_FACTOR) / (sensitivity || 1)) continue;
    const atMs = Math.round(i * bucketMs);
    if (atMs - lastAtMs < MIN_BEAT_GAP_MS) continue;
    lastAtMs = atMs;
    beats.push({ at_ms: atMs });
  }
  return beats;
}
