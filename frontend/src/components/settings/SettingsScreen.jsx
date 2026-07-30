import { useState } from 'react';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { api } from '../../api/client.js';
import ModelFavorites from './ModelFavorites.jsx';

const API_KEY_ROWS = [
  { key: 'replicate', name: 'Replicate' },
  { key: 'google', name: 'Google (Gemini)' },
  { key: 'fal', name: 'FAL' },
  { key: 'openrouter', name: 'OpenRouter' },
  { key: 'krea', name: 'Krea AI' },
];

const MODEL_PROVIDERS = [
  { id: 'google', name: 'Google (Gemini)' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'replicate', name: 'Replicate' },
  { id: 'fal', name: 'FAL' },
];

// Krea (krea.ai) is image/video-only - it has no text/LLM models, so it's
// only offered for the image-model favorites panel, not text/simple ones.
const IMAGE_MODEL_PROVIDERS = [...MODEL_PROVIDERS, { id: 'krea', name: 'Krea AI' }];

const TABS = ['general', 'providers', 'models', 'prompts', 'wishes'];

export default function SettingsScreen({
  L, lang, apiKeys, textModels, simpleModels, imageModels, specialTags,
  sunoBasePrompt, referenceExamples, wishLibrary,
  onClose, actions,
}) {
  const [activeTab, setActiveTab] = useState('general');
  const [newTagDraft, setNewTagDraft] = useState('');
  const [newExampleDraft, setNewExampleDraft] = useState('');
  const [newWishDraft, setNewWishDraft] = useState('');
  const [catalog, setCatalog] = useState({});
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [imageCatalog, setImageCatalog] = useState({});
  const [refreshingImageModels, setRefreshingImageModels] = useState(false);

  const tabLabels = {
    general: L.settings_tab_general, providers: L.settings_tab_providers, models: L.settings_tab_models,
    prompts: L.settings_tab_prompts, wishes: L.settings_tab_wishes,
  };

  async function refreshModels() {
    setRefreshingModels(true);
    try {
      const entries = await Promise.all(
        MODEL_PROVIDERS.map((p) => api.listModels(p.id).catch(() => ({ provider: p.id, source: 'error', models: [], error: 'failed' }))),
      );
      const next = {};
      entries.forEach((entry) => { next[entry.provider] = entry; });
      setCatalog(next);
    } finally {
      setRefreshingModels(false);
    }
  }

  async function refreshImageModels() {
    setRefreshingImageModels(true);
    try {
      const entries = await Promise.all(
        IMAGE_MODEL_PROVIDERS.map((p) => api.listImageModels(p.id).catch(() => ({ provider: p.id, source: 'error', models: [], error: 'failed' }))),
      );
      const next = {};
      entries.forEach((entry) => { next[entry.provider] = entry; });
      setImageCatalog(next);
    } finally {
      setRefreshingImageModels(false);
    }
  }

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
          <div className="settings-tabs">
            {TABS.map((tab) => (
              <button
                key={tab}
                className={`chip${activeTab === tab ? ' is-active' : ''}`}
                onClick={() => setActiveTab(tab)}
              >
                {tabLabels[tab]}
              </button>
            ))}
          </div>

          {activeTab === 'general' && (
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
          )}

          {activeTab === 'providers' && (
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
          )}

          {activeTab === 'models' && (
            <>
              <div className="settings-panel">
                <div className="settings-panel-label">{L.settings_textModels}</div>
                <ModelFavorites
                  L={L} providers={MODEL_PROVIDERS}
                  favorites={textModels.favorites} defaultValue={textModels.default}
                  catalog={catalog} refreshing={refreshingModels} onRefresh={refreshModels}
                  onAddFavorite={actions.addTextModelFavorite}
                  onRemoveFavorite={actions.removeTextModelFavorite}
                  onSetDefault={actions.setTextModelDefault}
                />
              </div>

              <div className="settings-panel">
                <div className="settings-panel-label">{L.settings_simpleModels}</div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>{L.settings_simpleModelsHint}</div>
                <ModelFavorites
                  L={L} providers={MODEL_PROVIDERS}
                  favorites={simpleModels.favorites} defaultValue={simpleModels.default}
                  catalog={catalog} refreshing={refreshingModels} onRefresh={refreshModels}
                  onAddFavorite={actions.addSimpleModelFavorite}
                  onRemoveFavorite={actions.removeSimpleModelFavorite}
                  onSetDefault={actions.setSimpleModelDefault}
                />
              </div>

              <div className="settings-panel">
                <div className="settings-panel-label">{L.settings_imageModels}</div>
                <ModelFavorites
                  L={L} providers={IMAGE_MODEL_PROVIDERS}
                  favorites={imageModels.favorites} defaultValue={imageModels.default}
                  catalog={imageCatalog} refreshing={refreshingImageModels} onRefresh={refreshImageModels}
                  onAddFavorite={actions.addImageModelFavorite}
                  onRemoveFavorite={actions.removeImageModelFavorite}
                  onSetDefault={actions.setImageModelDefault}
                />
              </div>
            </>
          )}

          {activeTab === 'prompts' && (
            <>
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

              <div className="settings-panel">
                <div className="settings-panel-label">{L.settings_sunoBasePrompt}</div>
                <textarea
                  className="suno-textarea"
                  style={{ minHeight: 180 }}
                  value={sunoBasePrompt}
                  onChange={(e) => actions.setSunoBasePrompt(e.target.value)}
                />
              </div>

              <div className="settings-panel">
                <div className="settings-panel-label">{L.settings_referenceExamples}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {referenceExamples.map((example, i) => (
                    <div className="settings-row" key={i}>
                      <span className="settings-row-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {example.slice(0, 80)}{example.length > 80 ? '…' : ''}
                      </span>
                      <button className="icon-btn icon-btn-danger" onClick={() => actions.removeReferenceExample(i)}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
                  <textarea
                    className="suno-textarea"
                    style={{ minHeight: 80 }}
                    value={newExampleDraft}
                    onChange={(e) => setNewExampleDraft(e.target.value)}
                    placeholder={L.settings_referenceExamplesPlaceholder}
                  />
                  <button
                    className="btn btn-accent-soft"
                    style={{ alignSelf: 'flex-start' }}
                    onClick={() => { actions.addReferenceExample(newExampleDraft); setNewExampleDraft(''); }}
                  >
                    {L.add}
                  </button>
                </div>
              </div>
            </>
          )}

          {activeTab === 'wishes' && (
            <div className="settings-panel">
              <div className="settings-panel-label">{L.settings_wishLibrary}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {wishLibrary.map((wish) => (
                  <div className="settings-row" key={wish.id} title={wish.text}>
                    <span className="settings-row-name" style={{ width: 'auto', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {wish.title}
                    </span>
                    <button className="icon-btn icon-btn-danger" onClick={() => actions.removeWishSnippet(wish.id)}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input
                  className="field"
                  value={newWishDraft}
                  onChange={(e) => setNewWishDraft(e.target.value)}
                  placeholder={L.settings_wishLibraryPlaceholder}
                />
                <button
                  className="btn btn-accent-soft"
                  onClick={() => { actions.saveWishToLibrary(newWishDraft); setNewWishDraft(''); }}
                >
                  {L.add}
                </button>
              </div>
            </div>
          )}

          <button className="btn btn-gradient" style={{ justifyContent: 'center', padding: 12, fontSize: 14 }} onClick={actions.onSave}>
            {L.save}
          </button>
        </div>
      </div>
    </div>
  );
}
