import { useEffect, useState } from 'react';
import { mediaUrl } from '../api/client.js';

// One peak per this many output pixels at the widest zoom - decoding is done
// once per track, consumers then read the same peak arrays at whatever
// resolution they need.
export const PEAK_BUCKETS = 4000;

// Cutoffs (Hz) for the cheap one-pole band split: below BASS_CUTOFF_HZ =
// bass, between it and MID_CUTOFF_HZ = mid, above = treble. Not audio-grade
// filters, just enough separation to color a bar by "what kind of energy is
// here" (kick/bass-heavy vs bright/airy) and to give `lib/beats.js` a bass
// envelope to find kicks in.
const BASS_CUTOFF_HZ = 200;
const MID_CUTOFF_HZ = 2000;

// One-pole low-pass filter, cheap enough to run over a whole decoded track
// twice purely for visual band-splitting - not meant to be an accurate
// crossover.
function onePoleLowPass(samples, sampleRate, cutoffHz) {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / sampleRate;
  const alpha = dt / (rc + dt);
  const out = new Float32Array(samples.length);
  let prev = 0;
  for (let i = 0; i < samples.length; i++) {
    prev += alpha * (samples[i] - prev);
    out[i] = prev;
  }
  return out;
}

/** Decodes the project's selected audio track once and reduces it to
 * `PEAK_BUCKETS` per-bucket values: `{peak, rms, bass, mid, treble}`, each a
 * `Float32Array`. `null` until it's ready (or forever, if decoding fails -
 * every consumer treats the waveform as decorative).
 *
 * Lifted out of `TimelineAudioTrack.jsx`, which used to own this decode as
 * local state, because a second consumer appeared: `lib/beats.js`'s onset
 * detection reads the same `bass` envelope to place beat markers. Called once
 * in `EditorStage.jsx` and passed down to both, so a track is never decoded
 * twice for one screen. */
export function useAudioPeaks(projectId, track) {
  const [peaks, setPeaks] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setPeaks(null);
    if (!track) return undefined;
    fetch(mediaUrl(`projects/${projectId}/${track.file_path}`))
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioCtx();
        return ctx.decodeAudioData(buf).finally(() => ctx.close());
      })
      .then((audioBuffer) => {
        if (cancelled) return;
        const channel = audioBuffer.getChannelData(0);
        const bass = onePoleLowPass(channel, audioBuffer.sampleRate, BASS_CUTOFF_HZ);
        const bassMid = onePoleLowPass(channel, audioBuffer.sampleRate, MID_CUTOFF_HZ);

        const bucketSize = Math.max(1, Math.floor(channel.length / PEAK_BUCKETS));
        const peak = new Float32Array(PEAK_BUCKETS);
        const rms = new Float32Array(PEAK_BUCKETS);
        const bassE = new Float32Array(PEAK_BUCKETS);
        const midE = new Float32Array(PEAK_BUCKETS);
        const trebleE = new Float32Array(PEAK_BUCKETS);

        for (let i = 0; i < PEAK_BUCKETS; i++) {
          const start = i * bucketSize;
          const end = Math.min(channel.length, start + bucketSize);
          let max = 0;
          let sumSq = 0;
          let bassSq = 0;
          let midSq = 0;
          let trebleSq = 0;
          for (let j = start; j < end; j++) {
            const v = channel[j];
            const av = Math.abs(v);
            if (av > max) max = av;
            sumSq += v * v;
            const bassV = bass[j];
            const midV = bassMid[j] - bassV;
            const trebleV = v - bassMid[j];
            bassSq += bassV * bassV;
            midSq += midV * midV;
            trebleSq += trebleV * trebleV;
          }
          const count = Math.max(1, end - start);
          peak[i] = max;
          rms[i] = Math.sqrt(sumSq / count);
          bassE[i] = Math.sqrt(bassSq / count);
          midE[i] = Math.sqrt(midSq / count);
          trebleE[i] = Math.sqrt(trebleSq / count);
        }

        setPeaks({
          peak, rms, bass: bassE, mid: midE, treble: trebleE,
        });
      })
      .catch(() => { /* waveform is decorative only - the timeline still works without it */ });
    return () => { cancelled = true; };
  }, [projectId, track]);

  return peaks;
}
