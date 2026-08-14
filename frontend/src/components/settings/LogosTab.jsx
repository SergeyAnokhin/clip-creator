import { useRef, useState } from 'react';
import { Upload, X } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';

// Settings > "Logos": the global, cross-project logo library the Poster
// constructor picks from (files under app_data/logos/).
export default function LogosTab({ L, logos, actions }) {
  const fileRef = useRef(null);
  const [nameDraft, setNameDraft] = useState('');

  function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) {
      actions.uploadLogo(nameDraft, file);
      setNameDraft('');
    }
  }

  return (
    <div className="settings-panel">
      <div className="settings-panel-label">{L.settings_logosLabel}</div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>{L.settings_logosHint}</div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        {(logos || []).map((logo) => (
          <div key={logo.id} style={{ width: 84 }}>
            <div
              style={{
                position: 'relative', width: 84, height: 84, borderRadius: 8, overflow: 'hidden',
                background: 'repeating-conic-gradient(#2a2a2a 0% 25%, #363636 0% 50%) 50% / 12px 12px',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              <img src={mediaUrl(logo.file_path)} alt={logo.name} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              <button
                className="icon-btn" style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20 }}
                title={L.settings_logosDelete}
                onClick={() => actions.deleteLogo(logo.id)}
              >
                <X size={11} />
              </button>
            </div>
            {logo.name && (
              <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 4, textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {logo.name}
              </div>
            )}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          className="field" style={{ flex: 1 }}
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          placeholder={L.settings_logosNamePlaceholder}
        />
        <button className="btn btn-accent-soft" onClick={() => fileRef.current?.click()}>
          <Upload size={13} /> {L.settings_logosUpload}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/webp"
          style={{ display: 'none' }}
          onChange={handleFile}
        />
      </div>
    </div>
  );
}
