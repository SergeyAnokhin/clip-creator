import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';

const WAVEFORM_BUCKETS = 400;

function formatTime(ms) {
  const s = Math.max(0, ms / 1000);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

/** Editor stage preview panel: a muted <video> (clip content) synced to a
 * hidden <audio> (the picked Mureka track, the sync source of truth - see
 * useEditorStage.js's `tick`), plus a waveform scrub bar decoded from that
 * same track with the Web Audio API + <canvas> - same technique as
 * ReferenceAudioTrimmer.jsx, without its drag-selection (this bar is just
 * for scrubbing/seeking, no window to pick). */
export default function EditorPreview({
  L, projectId, selectedTrack, videoRef, audioRef, playheadMs, isPlaying, onPlay, onPause, onSeek,
}) {
  const canvasRef = useRef(null);
  const [peaks, setPeaks] = useState(null);
  const durationMs = selectedTrack?.duration_ms || 0;

  useEffect(() => {
    let cancelled = false;
    setPeaks(null);
    if (!selectedTrack) return undefined;
    fetch(mediaUrl(`projects/${projectId}/${selectedTrack.file_path}`))
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioCtx();
        return ctx.decodeAudioData(buf).finally(() => ctx.close());
      })
      .then((audioBuffer) => {
        if (cancelled) return;
        const channel = audioBuffer.getChannelData(0);
        const bucketSize = Math.max(1, Math.floor(channel.length / WAVEFORM_BUCKETS));
        const arr = new Float32Array(WAVEFORM_BUCKETS);
        for (let i = 0; i < WAVEFORM_BUCKETS; i++) {
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
      .catch(() => { /* waveform is decorative only - scrubbing still works without it */ });
    return () => { cancelled = true; };
  }, [projectId, selectedTrack]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks) return;
    const { width, height } = canvas;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    const mid = height / 2;
    const barWidth = width / peaks.length;
    const playedRatio = durationMs > 0 ? playheadMs / durationMs : 0;
    for (let i = 0; i < peaks.length; i++) {
      const played = i / peaks.length <= playedRatio;
      ctx.fillStyle = played ? '#ff9d5c' : 'rgba(255,255,255,0.25)';
      const h = Math.max(1, peaks[i] * mid);
      ctx.fillRect(i * barWidth, mid - h, Math.max(1, barWidth - 1), h * 2);
    }
  }, [peaks, playheadMs, durationMs]);

  function xToMs(clientX) {
    const rect = canvasRef.current.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * durationMs;
  }

  return (
    <div className="glass-card" style={{ marginBottom: 16 }}>
      <div style={{ position: 'relative', background: '#000', borderRadius: 8, overflow: 'hidden', aspectRatio: '16 / 9', maxHeight: 360 }}>
        <video ref={videoRef} muted playsInline style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      </div>
      <audio ref={audioRef} src={selectedTrack ? mediaUrl(`projects/${projectId}/${selectedTrack.file_path}`) : undefined} style={{ display: 'none' }} />

      {selectedTrack ? (
        <div
          style={{ position: 'relative', marginTop: 10, cursor: 'pointer' }}
          onClick={(e) => onSeek(xToMs(e.clientX))}
        >
          <canvas ref={canvasRef} width={900} height={64} style={{ width: '100%', height: 64, display: 'block' }} />
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 10 }}>{L.editor_noAudioTrack}</div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
        <button
          className="btn-ghost" style={{ border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, padding: '8px 12px', cursor: 'pointer' }}
          onClick={isPlaying ? onPause : onPlay} disabled={!selectedTrack}
        >
          {isPlaying ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          {formatTime(playheadMs)} / {formatTime(durationMs)}
        </span>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 8 }}>{L.editor_previewDisclaimer}</div>
    </div>
  );
}
