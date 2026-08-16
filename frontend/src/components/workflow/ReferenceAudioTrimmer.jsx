import { useEffect, useRef, useState } from 'react';
import { Loader2, Pause, Play, X } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';
import { onBackdropClick } from '../../lib/a11y.js';

// Mureka's reference-upload hard-requires audio >= this long (confirmed
// live against the real API, 2026-08: "The audio duration should be at
// least 30 seconds") - the selection window can never go below it, but it
// *can* go wider (Mureka trims any excess itself on upload).
const MIN_SELECTION_S = 30;
const WAVEFORM_BUCKETS = 600;

function formatTime(s) {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

/** Fullscreen-ish modal: decode a just-uploaded reference-audio source with
 * the Web Audio API (no library - decodeAudioData + a canvas is enough for
 * a peak waveform), let the user drag a >=30s window over it while
 * auditioning playback, then hand {startMs, endMs} to the caller
 * (useMurekaStage.js's trimReferenceSource, which cuts it server-side via
 * ffmpeg and uploads only that clip to Mureka - the source file itself
 * never reaches Mureka as-is). */
export default function ReferenceAudioTrimmer({ L, projectId, source, uploading, onConfirm, onClose }) {
  const audioRef = useRef(null);
  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  const selRef = useRef({ start: 0, end: 0 });

  const [duration, setDuration] = useState(0);
  const [peaks, setPeaks] = useState(null);
  const [selStart, setSelStart] = useState(0);
  const [selEnd, setSelEnd] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [decodeError, setDecodeError] = useState(null);

  useEffect(() => { selRef.current = { start: selStart, end: selEnd }; }, [selStart, selEnd]);

  useEffect(() => {
    let cancelled = false;
    setPeaks(null);
    setDecodeError(null);
    fetch(mediaUrl(`projects/${projectId}/${source.file_path}`))
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioCtx();
        return ctx.decodeAudioData(buf).finally(() => ctx.close());
      })
      .then((audioBuffer) => {
        if (cancelled) return;
        const total = audioBuffer.duration;
        setDuration(total);
        setSelStart(0);
        setSelEnd(Math.min(MIN_SELECTION_S, total));
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
      .catch(() => {
        if (cancelled) return;
        setDecodeError(L.mureka_trimDecodeError);
        // Waveform preview only - the actual cut always happens server-side
        // via ffmpeg (see the module docstring), so a decode failure here
        // shouldn't block picking a window. Fall back to the plain <audio>
        // element's own (more lenient) duration so selection still works,
        // just without waveform bars.
        const applyNativeDuration = (total) => {
          if (cancelled || !Number.isFinite(total) || total <= 0) return;
          setDuration(total);
          setSelStart(0);
          setSelEnd(Math.min(MIN_SELECTION_S, total));
        };
        const el = audioRef.current;
        if (!el) return;
        if (Number.isFinite(el.duration) && el.duration > 0) applyNativeDuration(el.duration);
        else el.addEventListener('loadedmetadata', () => applyNativeDuration(el.duration), { once: true });
      });
    return () => { cancelled = true; };
  }, [source.file_path, L.mureka_trimDecodeError]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks) return;
    const { width, height } = canvas;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    const mid = height / 2;
    const barWidth = width / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const t = (i / peaks.length) * duration;
      const inSelection = t >= selStart && t <= selEnd;
      ctx.fillStyle = inSelection ? '#ff9d5c' : 'rgba(255,255,255,0.25)';
      const h = Math.max(1, peaks[i] * mid);
      ctx.fillRect(i * barWidth, mid - h, Math.max(1, barWidth - 1), h * 2);
    }
    if (duration > 0) {
      const x = (currentTime / duration) * width;
      ctx.fillStyle = '#fff';
      ctx.fillRect(x, 0, 2, height);
    }
  }, [peaks, selStart, selEnd, duration, currentTime]);

  function xToTime(clientX) {
    const rect = canvasRef.current.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * duration;
  }

  function handlePointerMove(e) {
    const drag = dragRef.current;
    if (!drag || !duration) return;
    const t = xToTime(e.clientX);
    if (drag.mode === 'start') {
      setSelStart(Math.max(0, Math.min(t, selRef.current.end - MIN_SELECTION_S)));
    } else if (drag.mode === 'end') {
      setSelEnd(Math.min(duration, Math.max(t, selRef.current.start + MIN_SELECTION_S)));
    } else if (drag.mode === 'move') {
      const width = drag.endAtDown - drag.startAtDown;
      const deltaT = t - drag.tAtDown;
      const newStart = Math.max(0, Math.min(drag.startAtDown + deltaT, duration - width));
      setSelStart(newStart);
      setSelEnd(newStart + width);
    }
  }
  function handlePointerUp() {
    dragRef.current = null;
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
  }
  function startDrag(mode) {
    return (e) => {
      e.preventDefault();
      dragRef.current = { mode, startAtDown: selRef.current.start, endAtDown: selRef.current.end, tAtDown: xToTime(e.clientX) };
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
    };
  }

  function seekTo(seconds) {
    if (audioRef.current) audioRef.current.currentTime = seconds;
    setCurrentTime(seconds);
  }
  function togglePlayFull() {
    const el = audioRef.current;
    if (!el) return;
    if (playing) { el.pause(); } else { el.play(); }
  }
  function playSelectionOnly() {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = selStart;
    el.play();
  }
  function onTimeUpdate() {
    const el = audioRef.current;
    if (!el) return;
    setCurrentTime(el.currentTime);
    if (el.currentTime >= selEnd) el.pause();
  }

  const tooShort = duration > 0 && duration < MIN_SELECTION_S;
  const canConfirm = !uploading && duration > 0 && !tooShort && (selEnd - selStart) >= MIN_SELECTION_S - 0.05;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onBackdropClick(onClose)}>
      <div className="modal-card modal-card-lg" style={{ maxWidth: 720 }}>
        <div className="modal-header">
          <span>{L.mureka_trimTitle}</span>
          <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 }}>{source.filename}</div>

        <audio
          ref={audioRef} src={mediaUrl(`projects/${projectId}/${source.file_path}`)} preload="metadata"
          onTimeUpdate={onTimeUpdate} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
          style={{ display: 'none' }}
        />

        {!duration && !decodeError && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '30px 0', justifyContent: 'center', color: 'var(--text-dim)' }}>
            <Loader2 size={16} className="spin" /> {L.mureka_trimDecoding}
          </div>
        )}
        {decodeError && (
          <div style={{ fontSize: 13, color: '#fca5a5', marginBottom: 8 }}>
            ⚠️ {decodeError}{duration ? ` — ${L.mureka_trimNoWaveform}` : ''}
          </div>
        )}

        {duration > 0 && (
          <>
            <div className="mureka-trimmer-waveform">
              <canvas ref={canvasRef} width={900} height={120} onClick={(e) => seekTo(xToTime(e.clientX))} />
              <div
                className="mureka-trimmer-selection"
                style={{ left: `${(selStart / duration) * 100}%`, width: `${((selEnd - selStart) / duration) * 100}%` }}
                onPointerDown={startDrag('move')}
              />
              <div className="mureka-trimmer-handle" style={{ left: `${(selStart / duration) * 100}%` }} onPointerDown={startDrag('start')} />
              <div className="mureka-trimmer-handle" style={{ left: `${(selEnd / duration) * 100}%` }} onPointerDown={startDrag('end')} />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-dim)', marginTop: 6 }}>
              <span>{formatTime(selStart)} → {formatTime(selEnd)} ({formatTime(selEnd - selStart)})</span>
              <span>{L.mureka_trimTotal}: {formatTime(duration)}</span>
            </div>

            {tooShort && (
              <div style={{ fontSize: 13, color: '#fca5a5', marginTop: 8 }}>⚠️ {L.mureka_trimTooShort}</div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
              <button className="btn-ghost" style={{ border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, padding: '8px 12px', cursor: 'pointer' }} onClick={togglePlayFull}>
                {playing ? <Pause size={14} /> : <Play size={14} />} {L.mureka_trimPlayFull}
              </button>
              <button className="btn-ghost" style={{ border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, padding: '8px 12px', cursor: 'pointer' }} onClick={playSelectionOnly}>
                <Play size={14} /> {L.mureka_trimPlaySelection}
              </button>
            </div>
          </>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 18, justifyContent: 'flex-end' }}>
          <button className="btn-ghost" style={{ padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer' }} onClick={onClose}>
            {L.cancel}
          </button>
          <button
            className="btn btn-gradient" style={{ padding: '8px 20px' }} disabled={!canConfirm}
            onClick={() => onConfirm(selStart * 1000, selEnd * 1000)}
          >
            {uploading ? <Loader2 size={14} className="spin" /> : null} {L.mureka_trimConfirm}
          </button>
        </div>
      </div>
    </div>
  );
}
