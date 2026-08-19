import { useEffect, useRef, useState } from 'react';
import { mediaUrl } from '../../api/client.js';

// One peak per this many output pixels at the widest zoom - decoding is done
// once per track, the canvas is then redrawn from the same peak array at
// whatever width the current zoom asks for.
const PEAK_BUCKETS = 4000;

// Reshapes a 0..1 peak amplitude before it's drawn as a bar height - 'log'/
// 'sqrt' both raise quiet sections relative to loud ones (compressing the
// loud end), which is the point: it's easier to see where a quiet passage
// ends and a loud one begins when picking a cut point, at the cost of
// exaggerating background noise. 'linear' (the old, only behavior) draws the
// peak as-is.
function scalePeak(v, mode) {
  if (mode === 'log') return Math.log1p(v * 9) / Math.log1p(9);
  if (mode === 'sqrt') return Math.sqrt(v);
  return v;
}

/** The Editor timeline's audio row: the picked Mureka track drawn as a
 * waveform across the same millisecond->pixel scale the clip row uses, so a
 * cut visually lines up with the beat it sits on. Decoding is the same Web
 * Audio + <canvas> technique as ReferenceAudioTrimmer.jsx; the canvas is
 * deliberately *not* repainted per playhead frame (it can be tens of
 * thousands of pixels wide when zoomed in) - the playhead line on top of it
 * carries the position instead. `scaleMode` ('linear'/'log'/'sqrt', see
 * EditorClipSettingsTab.jsx) only changes the bar-height formula, not the
 * decode/bucket pipeline above. */
export default function TimelineAudioTrack({ projectId, track, widthPx, heightPx, scaleMode = 'linear' }) {
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
        const bucketSize = Math.max(1, Math.floor(channel.length / PEAK_BUCKETS));
        const arr = new Float32Array(PEAK_BUCKETS);
        for (let i = 0; i < PEAK_BUCKETS; i++) {
          const start = i * bucketSize;
          const end = Math.min(channel.length, start + bucketSize);
          let max = 0;
          for (let j = start; j < end; j++) {
            const v = Math.abs(channel[j]);
            if (v > max) max = v;
          }
          arr[i] = max;
        }
        setPeaks(arr);
      })
      .catch(() => { /* waveform is decorative only - the timeline still works without it */ });
    return () => { cancelled = true; };
  }, [projectId, track]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!peaks) return;
    const mid = canvas.height / 2;
    const barWidth = canvas.width / peaks.length;
    ctx.fillStyle = 'rgba(255, 157, 92, 0.65)';
    for (let i = 0; i < peaks.length; i++) {
      const h = Math.max(1, scalePeak(peaks[i], scaleMode) * (mid - 2));
      ctx.fillRect(i * barWidth, mid - h, Math.max(1, barWidth - 0.5), h * 2);
    }
  }, [peaks, widthPx, heightPx, scaleMode]);

  return (
    <canvas
      ref={canvasRef} width={Math.max(1, Math.round(widthPx))} height={heightPx}
      style={{ width: Math.max(1, widthPx), height: heightPx, display: 'block' }}
    />
  );
}
