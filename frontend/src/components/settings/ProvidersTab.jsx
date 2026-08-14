import { useRef } from 'react';
import { Download, Upload } from 'lucide-react';

const API_KEY_ROWS = [
  { key: 'replicate', name: 'Replicate' },
  { key: 'google', name: 'Google (Gemini)' },
  { key: 'google_free', name: 'Google (Gemini) Free' },
  { key: 'fal', name: 'FAL' },
  { key: 'openrouter', name: 'OpenRouter' },
  { key: 'deepseek', name: 'DeepSeek' },
  { key: 'krea', name: 'Krea AI' },
  { key: 'google_translate', name: 'Google Translate' },
  { key: 'mureka', name: 'Mureka' },
];

const BG_REMOVER_BACKGROUND_TYPES = ['rgba', 'white', 'green', 'blur', 'overlay', 'map'];

// Settings > "Providers": the API-key table (plus its own export/import), the
// three background-removal methods (see docs/architecture.md) and the
// outpaint quality mode.
export default function ProvidersTab({
  L, apiKeys, backgroundRemoverMethod, backgroundRemoverLocalParams, backgroundRemoverFalParams,
  backgroundRemoverParams, outpaintQualityMode, actions, onExportApiKeys, onImportApiKeysFile,
}) {
  const fileRef = useRef(null);

  return (
    <>
      <div className="settings-panel">
        <div className="settings-panel-label">{L.settings_apiKeys}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {API_KEY_ROWS.map((row) => (
            <div className="settings-row" key={row.key}>
              <span className="settings-row-name">{row.name}</span>
              <input
                className="field"
                style={{ fontFamily: 'monospace' }}
                value={apiKeys[row.key] || ''}
                onChange={(e) => actions.setApiKey(row.key, e.target.value)}
                placeholder="sk-..."
              />
            </div>
          ))}
          <div className="settings-row">
            <span className="settings-row-name" style={{ width: 'auto', flex: 1 }}>{L.settings_backupApiKeys}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-accent-soft" onClick={onExportApiKeys}>
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
                onChange={onImportApiKeysFile}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="settings-panel">
        <div className="settings-panel-label">{L.settings_bgRemover}</div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 }}>{L.settings_bgRemoverHint}</div>

        <div className="settings-row" style={{ marginBottom: 16 }}>
          <span className="settings-row-name">{L.settings_bgRemoverMethod}</span>
          <select
            className="field"
            value={backgroundRemoverMethod}
            onChange={(e) => actions.setBackgroundRemoverMethod(e.target.value)}
          >
            <option value="local">{L.settings_bgRemoverMethodLocal}</option>
            <option value="fal">{L.settings_bgRemoverMethodFal}</option>
            <option value="replicate">{L.settings_bgRemoverMethodReplicate}</option>
          </select>
        </div>

        <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-dim)', marginBottom: 6 }}>{L.settings_bgRemoverMethodLocal}</div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 }}>{L.settings_bgRemoverLocalHint}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
          <div className="settings-row">
            <span className="settings-row-name">{L.settings_bgRemoverLocalBg}</span>
            <select
              className="field"
              value={backgroundRemoverLocalParams.bg}
              onChange={(e) => actions.setBackgroundRemoverLocalParam('bg', e.target.value)}
            >
              <option value="black">black</option>
              <option value="white">white</option>
            </select>
          </div>
          <div className="settings-row">
            <span className="settings-row-name">{L.settings_bgRemoverLocalThreshold}</span>
            <input
              className="field" type="number" min="0" max="255" step="1"
              style={{ maxWidth: 120 }}
              value={backgroundRemoverLocalParams.threshold}
              onChange={(e) => actions.setBackgroundRemoverLocalParam('threshold', Number(e.target.value) || 0)}
            />
          </div>
        </div>

        <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-dim)', marginBottom: 6 }}>{L.settings_bgRemoverMethodFal}</div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 }}>{L.settings_bgRemoverFalHint}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
          <div className="settings-row">
            <span className="settings-row-name">{L.settings_bgRemoverFalModel}</span>
            <select
              className="field"
              value={backgroundRemoverFalParams.model}
              onChange={(e) => actions.setBackgroundRemoverFalParam('model', e.target.value)}
            >
              <option value="fal-ai/bria/background/remove">fal-ai/bria/background/remove</option>
              <option value="fal-ai/imageutils/rembg">fal-ai/imageutils/rembg</option>
            </select>
          </div>
        </div>

        <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-dim)', marginBottom: 6 }}>{L.settings_bgRemoverMethodReplicate}</div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 }}>{L.settings_bgRemoverReplicateHint}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="settings-row">
            <span className="settings-row-name">{L.settings_bgRemoverType}</span>
            <select
              className="field"
              value={backgroundRemoverParams.background_type}
              onChange={(e) => actions.setBackgroundRemoverParam('background_type', e.target.value)}
            >
              {BG_REMOVER_BACKGROUND_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="settings-row">
            <span className="settings-row-name">{L.settings_bgRemoverFormat}</span>
            <select
              className="field"
              value={backgroundRemoverParams.format}
              onChange={(e) => actions.setBackgroundRemoverParam('format', e.target.value)}
            >
              <option value="png">png</option>
              <option value="jpg">jpg</option>
            </select>
          </div>
          <div className="settings-row">
            <span className="settings-row-name">{L.settings_bgRemoverThreshold}</span>
            <input
              className="field" type="number" min="0" max="1" step="0.05"
              style={{ maxWidth: 120 }}
              value={backgroundRemoverParams.threshold}
              onChange={(e) => actions.setBackgroundRemoverParam('threshold', Number(e.target.value) || 0)}
            />
          </div>
          <div className="settings-row">
            <span className="settings-row-name" style={{ width: 'auto', flex: 1 }}>{L.settings_bgRemoverReverse}</span>
            <input
              type="checkbox"
              checked={!!backgroundRemoverParams.reverse}
              onChange={(e) => actions.setBackgroundRemoverParam('reverse', e.target.checked)}
            />
          </div>
        </div>
      </div>

      <div className="settings-panel">
        <div className="settings-panel-label">{L.settings_outpaint}</div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 }}>{L.settings_outpaintHint}</div>
        <div className="settings-row">
          <span className="settings-row-name">{L.settings_outpaintMode}</span>
          <select
            className="field"
            value={outpaintQualityMode}
            onChange={(e) => actions.setOutpaintQualityMode(e.target.value)}
          >
            <option value="fast">{L.settings_outpaintModeFast}</option>
            <option value="quality">{L.settings_outpaintModeQuality}</option>
          </select>
        </div>
      </div>
    </>
  );
}
