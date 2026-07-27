import { useState } from 'react';
import { ArrowLeft, Trash2 } from 'lucide-react';

const API_KEY_ROWS = [
  { key: 'openai', name: 'OpenAI' },
  { key: 'anthropic', name: 'Anthropic' },
  { key: 'deepseek', name: 'DeepSeek' },
  { key: 'replicate', name: 'Replicate' },
];

const TEXT_MODELS = [
  { id: 'claude', label: 'Claude 3.5 Sonnet' },
  { id: 'gpt', label: 'GPT-4o' },
  { id: 'deepseek', label: 'DeepSeek V3' },
];

const IMAGE_MODELS = [
  { id: 'flux', label: 'FLUX 1.1 Pro' },
  { id: 'dalle', label: 'DALL-E 3' },
  { id: 'midjourney', label: 'Midjourney' },
  { id: 'sdxl', label: 'SDXL' },
];

export default function SettingsScreen({ L, lang, apiKeys, textModelDefault, imageModelDefault, specialTags, onClose, actions }) {
  const [newTagDraft, setNewTagDraft] = useState('');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <div className="home-header">
        <button className="icon-btn" style={{ width: 36, height: 36 }} onClick={onClose}>
          <ArrowLeft size={16} />
        </button>
        <div className="workflow-title">{L.settingsTitle}</div>
      </div>

      <div style={{ flex: 1, padding: '32px 24px' }}>
        <div style={{ maxWidth: 600, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
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
            </div>
          </div>

          <div className="settings-panel">
            <div className="settings-panel-label">{L.settings_textModels}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {TEXT_MODELS.map((m) => (
                <button
                  key={m.id}
                  className={`chip${textModelDefault === m.id ? ' is-active' : ''}`}
                  onClick={() => actions.setTextModelDefault(m.id)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-panel">
            <div className="settings-panel-label">{L.settings_imageModels}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {IMAGE_MODELS.map((m) => (
                <button
                  key={m.id}
                  className={`chip${imageModelDefault === m.id ? ' is-active' : ''}`}
                  onClick={() => actions.setImageModelDefault(m.id)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-panel">
            <div className="settings-panel-label">{L.settings_specialTags}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {specialTags.map((tag, i) => (
                <div className="settings-row" key={i}>
                  <span className="settings-row-name">{tag}</span>
                  <button className="icon-btn icon-btn-danger" onClick={() => actions.removeSpecialTag(i)}>
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <input
                className="field"
                value={newTagDraft}
                onChange={(e) => setNewTagDraft(e.target.value)}
                placeholder={L.settings_specialTagsPlaceholder}
              />
              <button
                className="btn btn-accent-soft"
                onClick={() => { actions.addSpecialTag(newTagDraft); setNewTagDraft(''); }}
              >
                {L.add}
              </button>
            </div>
          </div>

          <button className="btn btn-gradient" style={{ justifyContent: 'center', padding: 12, fontSize: 14 }} onClick={actions.onSave}>
            {L.save}
          </button>
        </div>
      </div>
    </div>
  );
}
