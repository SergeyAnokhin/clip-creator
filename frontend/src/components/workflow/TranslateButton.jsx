import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Languages, Loader2, X } from 'lucide-react';
import { api } from '../../api/client.js';

/** Small "translate to Russian" affordance dropped next to a prompt label
 * (static/motion prompt, in either SceneTextCard.jsx or SceneCard.jsx). Owns
 * its own open/loading/result state - the translation is a one-off preview
 * for the user, never written back into the project, so there's no need to
 * lift it into useScenesStage.js/useImagesStage.js. */
export default function TranslateButton({ L, text }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  if (!text?.trim()) return null;

  async function handleOpen() {
    setOpen(true);
    if (result || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.translateText(text, 'ru');
      setResult(res.translated);
    } catch (err) {
      setError(err?.detail || L.translateFailed);
    } finally {
      setLoading(false);
    }
  }

  function handleClose() {
    setOpen(false);
    setResult(null);
    setError(null);
  }

  return (
    <>
      <button
        type="button"
        className="scene-translate-btn"
        title={L.translateButtonTitle}
        onClick={handleOpen}
      >
        <Languages size={12} />
      </button>
      {open && createPortal(
        <div className="modal-backdrop" onClick={handleClose}>
          <div className="modal-card modal-card-lg" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span>{L.translateModalTitle}</span>
              <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={handleClose}>
                <X size={15} />
              </button>
            </div>
            {loading && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-dim)' }}>
                <Loader2 size={14} className="spin" /> {L.translateLoading}
              </div>
            )}
            {!loading && error && (
              <div style={{ fontSize: 13, color: '#fca5a5' }}>⚠️ {error}</div>
            )}
            {!loading && !error && result && (
              <>
                <div style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{result}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 14 }}>
                  {result.length} {L.suno_previewCharsLabel.toLowerCase()}
                </div>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
