import { useEffect, useRef, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';

/** The ✨ "decompose into magic layers" button, shared by all three entry
 * points (Images stage, Title Card gallery, Poster constructor). Clicking it
 * opens a small popup with the layer count and the two provider methods, and
 * the pick is passed per call rather than read from settings - same shape as
 * the Title Card gallery's background-removal method menu, which this
 * deliberately mirrors so both buttons behave identically.
 *
 * `onPick(method, numLayers)` does the actual work; this component owns only
 * the popup's open/close state. */
const MAGIC_METHODS = ['fal', 'replicate'];
const LAYER_COUNTS = [2, 3, 4, 5, 6, 8, 10];

export default function MagicLayersButton({ L, busy, disabled, onPick, className, style, title }) {
  const [open, setOpen] = useState(false);
  const [numLayers, setNumLayers] = useState(4);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onDocClick(e) {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  function pick(method) {
    setOpen(false);
    onPick(method, numLayers);
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex', ...style }}>
      <button
        className={className || 'icon-btn'}
        disabled={busy || disabled}
        title={title || L.magic_button}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
      >
        {busy ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
      </button>
      {open && (
        <div className="magic-method-menu">
          <div className="magic-method-count">
            <span>{L.magic_layersCount}</span>
            <select className="field" value={numLayers} onChange={(e) => setNumLayers(Number(e.target.value))}>
              {LAYER_COUNTS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          {MAGIC_METHODS.map((method) => (
            <button key={method} onClick={(e) => { e.stopPropagation(); pick(method); }}>
              {method === 'fal' ? L.magic_methodFal : L.magic_methodReplicate}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
