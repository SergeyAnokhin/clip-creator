import { Link as LinkIcon, X } from 'lucide-react';

export default function NewProjectModal({ L, url, rawText, loading, onUrlChange, onRawTextChange, onSubmit, onClose }) {
  const canSubmit = rawText.trim() || url.trim();

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{L.modalTitle}</span>
          <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginBottom: 6, fontWeight: 600 }}>
          {L.modalRawTextLabel}
        </div>
        <textarea
          className="block-textarea"
          style={{ minHeight: 140, marginBottom: 14 }}
          value={rawText}
          onChange={(e) => onRawTextChange(e.target.value)}
          placeholder={L.modalRawTextPlaceholder}
          autoFocus
        />

        <div style={{ fontSize: 11.5, color: 'var(--text-dim)', textAlign: 'center', margin: '2px 0 14px' }}>
          {L.modalOr}
        </div>

        <div className="search-box" style={{ marginBottom: 14, maxWidth: 'none' }}>
          <LinkIcon size={15} />
          <input
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
            placeholder={L.modalUrlPlaceholder}
          />
        </div>
        {loading && (
          <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 14 }}>
            ⏳ {L.modalParsing}
          </div>
        )}
        <button className="btn btn-gradient" style={{ width: '100%', justifyContent: 'center' }} onClick={onSubmit} disabled={loading || !canSubmit}>
          {L.modalSubmit}
        </button>
      </div>
    </div>
  );
}
