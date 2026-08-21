import { useEffect, useMemo, useRef } from 'react';

// dB scale mode's noise floor - amplitude at or below this maps to 0 height,
// 0dB (full-scale) maps to 1. -48dB keeps normal-level quiet passages
// readable without dragging real silence/hiss up with them.
const DB_FLOOR = -48;

// Adaptive scale mode's window, in buckets each side (a decode covers the
// whole track in PEAK_BUCKETS buckets, so this is roughly +-3% of it) - each
// bucket is shown relative to the loudest nearby bucket rather than the whole
// track, so a quiet verse and a loud chorus can each use their own full
// height.
const ADAPTIVE_WINDOW = 60;

const ACCENT_RGB = [255, 157, 92];
// Frequency-color mode's three base colors, mixed per-bucket by that
// bucket's bass/mid/treble energy share.
const BAND_RGB = { bass: [255, 90, 90], mid: ACCENT_RGB, treble: [110, 180, 255] };

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
 * cut visually lines up with the beat it sits on. The decode itself lives in
 * `hooks/useAudioPeaks.js` (same Web Audio technique as
 * ReferenceAudioTrimmer.jsx) and arrives here as the `peaks` prop - it moved
 * out once `lib/beats.js`'s marker detection became a second consumer of the
 * same bass envelope. The canvas is deliberately *not* repainted per playhead
 * frame (it can be tens of thousands of pixels wide when zoomed in) - the
 * playhead line on top of it carries the position instead.
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
 * by its bass/mid/treble energy share (see `useAudioPeaks`) instead
 * of the flat accent color - bass-heavy vs bright passages become visually
 * distinct, which is a second, independent cue for "what kind of music is
 * this" beyond the height/rhythm cue. */
export default function TimelineAudioTrack({
  peaks, widthPx, heightPx, scaleMode = 'linear', colorByFrequency = false,
}) {
  const canvasRef = useRef(null);

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
