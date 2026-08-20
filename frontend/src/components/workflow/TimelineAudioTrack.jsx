import { useEffect, useMemo, useRef, useState } from 'react';
import { mediaUrl } from '../../api/client.js';

// One peak per this many output pixels at the widest zoom - decoding is done
// once per track, the canvas is then redrawn from the same peak array at
// whatever width the current zoom asks for.
const PEAK_BUCKETS = 4000;

// Cutoffs (Hz) for the cheap one-pole band split used by the frequency-color
// mode: below BASS_CUTOFF_HZ = bass, between it and MID_CUTOFF_HZ = mid,
// above = treble. Not audio-grade filters, just enough separation to color
// a bar by "what kind of energy is here" (kick/bass-heavy vs bright/airy).
const BASS_CUTOFF_HZ = 200;
const MID_CUTOFF_HZ = 2000;

// dB scale mode's noise floor - amplitude at or below this maps to 0 height,
// 0dB (full-scale) maps to 1. -48dB keeps normal-level quiet passages
// readable without dragging real silence/hiss up with them.
const DB_FLOOR = -48;

// Adaptive scale mode's window, in buckets each side (PEAK_BUCKETS covers
// the whole track, so this is roughly +-3% of it) - each bucket is shown
// relative to the loudest nearby bucket rather than the whole track, so a
// quiet verse and a loud chorus can each use their own full height.
const ADAPTIVE_WINDOW = 60;

const ACCENT_RGB = [255, 157, 92];
// Frequency-color mode's three base colors, mixed per-bucket by that
// bucket's bass/mid/treble energy share.
const BAND_RGB = { bass: [255, 90, 90], mid: ACCENT_RGB, treble: [110, 180, 255] };

// One-pole low-pass filter, cheap enough to run over a whole decoded track
// twice (see below) purely for visual band-splitting - not meant to be an
// accurate crossover.
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

function ampToDb01(v) {
  if (v <= 0) return 0;
  const db = 20 * Math.log10(v);
  return Math.min(1, Math.max(0, (db - DB_FLOOR) / -DB_FLOOR));
}

// Reshapes a 0..1 amplitude array before it's drawn as a bar height.
// 'linear' draws it as-is. 'db' maps it through a dB/floor curve - a
// principled version of the old ad hoc log curve, with an actual noise
// floor instead of a magic constant. 'adaptive' ignores the whole-track
// scale entirely and shows each bucket relative to its own local
// neighborhood (see ADAPTIVE_WINDOW), so relative dynamics stay visible
// inside both quiet and loud sections instead of one global curve
// flattening everything toward the same height.
function applyScale(arr, mode) {
  const out = new Float32Array(arr.length);
  if (mode === 'db') {
    for (let i = 0; i < arr.length; i++) out[i] = ampToDb01(arr[i]);
    return out;
  }
  if (mode === 'adaptive') {
    for (let i = 0; i < arr.length; i++) {
      const lo = Math.max(0, i - ADAPTIVE_WINDOW);
      const hi = Math.min(arr.length - 1, i + ADAPTIVE_WINDOW);
      let localMax = 0;
      for (let j = lo; j <= hi; j++) if (arr[j] > localMax) localMax = arr[j];
      out[i] = localMax > 0.005 ? Math.min(1, arr[i] / localMax) : 0;
    }
    return out;
  }
  out.set(arr);
  return out;
}

/** The Editor timeline's audio row: the picked Mureka track drawn as a
 * waveform across the same millisecond->pixel scale the clip row uses, so a
 * cut visually lines up with the beat it sits on. Decoding is the same Web
 * Audio + <canvas> technique as ReferenceAudioTrimmer.jsx; the canvas is
 * deliberately *not* repainted per playhead frame (it can be tens of
 * thousands of pixels wide when zoomed in) - the playhead line on top of it
 * carries the position instead.
 *
 * Each bucket stores peak (max |amplitude|) *and* rms (its energy) - drawn
 * as two layers, a faint outer peak shape and a solid inner RMS shape
 * (the classic DAW look). Peak alone reacts to single transients and
 * doesn't read as "rhythm"; RMS is what the eye actually picks up as beat/
 * energy changes.
 *
 * `scaleMode` ('linear'/'db'/'adaptive', see EditorClipSettingsTab.jsx)
 * reshapes both layers' heights (`applyScale`) but never touches the
 * decode/bucket pipeline. `colorByFrequency` additionally tints every bar
 * by its bass/mid/treble energy share (see `onePoleLowPass` above) instead
 * of the flat accent color - bass-heavy vs bright passages become visually
 * distinct, which is a second, independent cue for "what kind of music is
 * this" beyond the height/rhythm cue. */
export default function TimelineAudioTrack({
  projectId, track, widthPx, heightPx, scaleMode = 'linear', colorByFrequency = false,
}) {
  const canvasRef = useRef(null);
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

        setPeaks({ peak, rms, bass: bassE, mid: midE, treble: trebleE });
      })
      .catch(() => { /* waveform is decorative only - the timeline still works without it */ });
    return () => { cancelled = true; };
  }, [projectId, track]);

  const envelope = useMemo(() => {
    if (!peaks) return null;
    return { peakH: applyScale(peaks.peak, scaleMode), rmsH: applyScale(peaks.rms, scaleMode) };
  }, [peaks, scaleMode]);

  // Per-bucket [r,g,b] mixed from that bucket's bass/mid/treble energy
  // share - only computed when the color toggle is on.
  const bandColors = useMemo(() => {
    if (!peaks || !colorByFrequency) return null;
    const { bass, mid, treble } = peaks;
    const out = new Array(bass.length);
    for (let i = 0; i < bass.length; i++) {
      const b = bass[i];
      const m = mid[i];
      const t = treble[i];
      const total = b + m + t;
      if (total < 1e-6) { out[i] = ACCENT_RGB; continue; }
      out[i] = [0, 1, 2].map((ch) => Math.round(
        (b * BAND_RGB.bass[ch] + m * BAND_RGB.mid[ch] + t * BAND_RGB.treble[ch]) / total,
      ));
    }
    return out;
  }, [peaks, colorByFrequency]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!envelope) return;
    const mid = canvas.height / 2;
    const n = envelope.peakH.length;
    const barWidth = canvas.width / n;
    const w = Math.max(1, barWidth - 0.5);
    for (let i = 0; i < n; i++) {
      const [r, g, b] = bandColors ? bandColors[i] : ACCENT_RGB;
      const x = i * barWidth;
      const peakH = Math.max(1, envelope.peakH[i] * (mid - 2));
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.3)`;
      ctx.fillRect(x, mid - peakH, w, peakH * 2);
      const rmsH = Math.max(1, envelope.rmsH[i] * (mid - 2));
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.75)`;
      ctx.fillRect(x, mid - rmsH, w, rmsH * 2);
    }
  }, [envelope, bandColors, widthPx, heightPx]);

  return (
    <canvas
      ref={canvasRef} width={Math.max(1, Math.round(widthPx))} height={heightPx}
      style={{ width: Math.max(1, widthPx), height: heightPx, display: 'block' }}
    />
  );
}
