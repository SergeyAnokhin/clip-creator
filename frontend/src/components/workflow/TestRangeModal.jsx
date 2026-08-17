import { useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { onBackdropClick } from '../../lib/a11y.js';

function msToParts(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return { min: Math.floor(total / 60), sec: total % 60 };
}
function partsToMs(min, sec) {
  return (Math.max(0, min || 0) * 60 + Math.max(0, Math.min(59, sec || 0))) * 1000;
}

/** Picks the `{startMs, endMs}` window `EditorStage.jsx`'s "Собрать тестовое
 * видео" hands to `actions.startRender` - replaces the old drag-a-range-on-
 * the-ruler gesture (which hijacked every ruler click/drag, so the ruler
 * couldn't scrub at all - see EditorTimeline.jsx). Same `modal-backdrop`/
 * `modal-card` shell as `ReferenceAudioTrimmer.jsx`/`KeyboardShortcutsModal.jsx`.
 * Minutes+seconds fields rather than one seconds field
 * (`TimelineOverlayInspector.jsx`'s style) - this picks a window over a
 * potentially multi-minute track, where mm:ss reads far easier than raw
 * seconds. */
export default function TestRangeModal({
  L, initialStartMs, initialEndMs, maxMs, onConfirm, onClose,
}) {
  const [from, setFrom] = useState(msToParts(initialStartMs));
  const [to, setTo] = useState(msToParts(initialEndMs));

  const startMs = Math.min(maxMs, partsToMs(from.min, from.sec));
  const endMs = Math.min(maxMs, partsToMs(to.min, to.sec));
  const valid = endMs > startMs;

  function submit() {
    if (!valid) return;
    onConfirm({ startMs, endMs });
  }

  return createPortal(
    <div className="modal-backdrop" role="presentation" onClick={onBackdropClick(onClose)}>
      <div className="modal-card" style={{ maxWidth: 360 }}>
        <div className="modal-header">
          <span>{L.editor_testRangeModalTitle}</span>
          <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div style={{ display: 'flex', gap: 16 }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 6 }}>{L.editor_testRangeModalFrom}</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="number" min={0} className="field tl-inspector-num" style={{ width: 52 }}
                aria-label={`${L.editor_testRangeModalFrom} ${L.editor_testRangeModalMin}`}
                value={from.min} onChange={(e) => setFrom({ ...from, min: Number(e.target.value) })}
              />
              <span>:</span>
              <input
                type="number" min={0} max={59} className="field tl-inspector-num" style={{ width: 52 }}
                aria-label={`${L.editor_testRangeModalFrom} ${L.editor_testRangeModalSec}`}
                value={from.sec} onChange={(e) => setFrom({ ...from, sec: Number(e.target.value) })}
              />
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 6 }}>{L.editor_testRangeModalTo}</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="number" min={0} className="field tl-inspector-num" style={{ width: 52 }}
                aria-label={`${L.editor_testRangeModalTo} ${L.editor_testRangeModalMin}`}
                value={to.min} onChange={(e) => setTo({ ...to, min: Number(e.target.value) })}
              />
              <span>:</span>
              <input
                type="number" min={0} max={59} className="field tl-inspector-num" style={{ width: 52 }}
                aria-label={`${L.editor_testRangeModalTo} ${L.editor_testRangeModalSec}`}
                value={to.sec} onChange={(e) => setTo({ ...to, sec: Number(e.target.value) })}
              />
            </div>
          </div>
        </div>

        {!valid && <div style={{ fontSize: 13, color: '#fca5a5', marginTop: 10 }}>⚠️ {L.editor_testRangeModalInvalid}</div>}

        <div style={{ display: 'flex', gap: 10, marginTop: 18, justifyContent: 'flex-end' }}>
          <button className="btn-ghost" style={{ padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer' }} onClick={onClose}>
            {L.cancel}
          </button>
          <button className="btn btn-gradient" style={{ padding: '8px 20px' }} disabled={!valid} onClick={submit}>
            {L.editor_testRangeModalConfirm}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
