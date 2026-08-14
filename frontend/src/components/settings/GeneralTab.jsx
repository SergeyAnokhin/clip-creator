import { useRef } from 'react';
import { Download, Upload } from 'lucide-react';

// Settings > "General": UI language, the shared request timeout, and the
// export/import of everything except API keys (those live in ProvidersTab).
export default function GeneralTab({ L, lang, requestTimeoutSeconds, actions, onExport, onImportFile }) {
  const fileRef = useRef(null);

  return (
    <>
      <div className="settings-panel">
        <div className="settings-panel-label">{L.settings_language}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className={`chip${lang === 'ru' ? ' is-active' : ''}`}
            style={{ flex: 1, textAlign: 'center', justifyContent: 'center', padding: 10 }}
            onClick={actions.setLangRu}
          >
            Русский
          </button>
          <button
            className={`chip${lang === 'en' ? ' is-active' : ''}`}
            style={{ flex: 1, textAlign: 'center', justifyContent: 'center', padding: 10 }}
            onClick={actions.setLangEn}
          >
            English
          </button>
        </div>
      </div>

      <div className="settings-panel">
        <div className="settings-panel-label">{L.settings_requestTimeout}</div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 }}>{L.settings_requestTimeoutHint}</div>
        <input
          className="field"
          type="number"
          min="5"
          style={{ maxWidth: 120 }}
          value={requestTimeoutSeconds}
          onChange={(e) => actions.setRequestTimeoutSeconds(Math.max(5, Number(e.target.value) || 60))}
        />
      </div>

      <div className="settings-panel">
        <div className="settings-panel-label">{L.settings_backup}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="settings-row">
            <span className="settings-row-name" style={{ width: 'auto', flex: 1 }}>{L.settings_backupOther}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-accent-soft" onClick={onExport}>
                <Download size={13} /> {L.settings_exportBtn}
              </button>
              <button className="btn btn-accent-soft" onClick={() => fileRef.current?.click()}>
                <Upload size={13} /> {L.settings_importBtn}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json"
                style={{ display: 'none' }}
                onChange={onImportFile}
              />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
