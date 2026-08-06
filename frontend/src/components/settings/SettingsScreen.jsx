import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, Mic, MicOff, Pencil, Trash2, Upload, X } from 'lucide-react';
import { api, mediaUrl } from '../../api/client.js';
import { modelPriceMap } from '../../lib/pricing.js';
import { downloadJSON } from '../../lib/download.js';
import { sortByUseCount } from '../../lib/wishes.js';
import { useFieldVoice } from '../../hooks/useVoice.js';
import { groupPresetsByService } from '../../lib/sunoPrompt.js';
import ModelFavorites from './ModelFavorites.jsx';
import PricingPanel from './PricingPanel.jsx';
import UsagePill from '../UsagePill.jsx';

const API_KEY_ROWS = [
  { key: 'replicate', name: 'Replicate' },
  { key: 'google', name: 'Google (Gemini)' },
  { key: 'google_free', name: 'Google (Gemini) Free' },
  { key: 'fal', name: 'FAL' },
  { key: 'openrouter', name: 'OpenRouter' },
  { key: 'deepseek', name: 'DeepSeek' },
  { key: 'krea', name: 'Krea AI' },
  { key: 'google_translate', name: 'Google Translate' },
];

const MODEL_PROVIDERS = [
  { id: 'google', name: 'Google (Gemini)' },
  { id: 'google_free', name: 'Google (Gemini) Free' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'replicate', name: 'Replicate' },
  { id: 'fal', name: 'FAL' },
];

// Krea (krea.ai) is image/video-only - it has no text/LLM models, so it's
// only offered for the image-model favorites panel, not text/simple ones.
const IMAGE_MODEL_PROVIDERS = [...MODEL_PROVIDERS, { id: 'krea', name: 'Krea AI' }];

const TABS = ['general', 'providers', 'models', 'prices', 'prompts', 'wishes', 'logos'];

const BG_REMOVER_BACKGROUND_TYPES = ['rgba', 'white', 'green', 'blur', 'overlay', 'map'];

export default function SettingsScreen({
  L, lang, showToast, apiKeys, textModels, simpleModels, imageModels, imageModelsSimple, specialTags,
  sunoBasePrompt, sunoPromptPresets, referenceExamples, wishLibrary, requestTimeoutSeconds,
  sceneBasePromptNarrative, sceneBasePromptAbstract, sceneWishLibrary,
  backgroundRemoverParams, logos,
  pricing, usageToday, usagePeriodTotals,
  onClose, onOpenUsage, onLoadUsagePeriodTotals, actions,
}) {
  const [activeTab, setActiveTab] = useState('general');
  const [newTagDraft, setNewTagDraft] = useState('');
  const [editingTagIndex, setEditingTagIndex] = useState(null);
  const [newExampleDraft, setNewExampleDraft] = useState('');
  const [editingExampleIndex, setEditingExampleIndex] = useState(null);
  const [newWishDraft, setNewWishDraft] = useState('');
  const [editingWishId, setEditingWishId] = useState(null);
  const [editWishTitle, setEditWishTitle] = useState('');
  const [editWishText, setEditWishText] = useState('');
  const [newSceneWishDraft, setNewSceneWishDraft] = useState('');
  const [editingSceneWishId, setEditingSceneWishId] = useState(null);
  const [editSceneWishTitle, setEditSceneWishTitle] = useState('');
  const [editSceneWishText, setEditSceneWishText] = useState('');
  const wishVoice = useFieldVoice({ showToast, L, lang });
  const [catalog, setCatalog] = useState({});
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [imageCatalog, setImageCatalog] = useState({});
  const [refreshingImageModels, setRefreshingImageModels] = useState(false);
  const apiKeysFileRef = useRef(null);
  const generalFileRef = useRef(null);
  const priceMap = modelPriceMap(pricing?.models);

  // Load the last-known-good model catalog on mount, so the favorites
  // search and the Prices tab have something to show before anyone presses
  // "Refresh models" in this session.
  useEffect(() => {
    api.getModelsCatalog().then((res) => {
      setCatalog(res.text || {});
      setImageCatalog(res.image || {});
    }).catch(() => {});
  }, []);

  function exportApiKeysFile() {
    downloadJSON('versecraft-api-keys.json', { api_keys: apiKeys });
  }
  function exportGeneralFile() {
    downloadJSON('versecraft-settings.json', {
      lang, text_models: textModels, simple_models: simpleModels, image_models: imageModels,
      image_models_simple: imageModelsSimple,
      special_tags: specialTags, suno_base_prompt: sunoBasePrompt,
      suno_reference_examples: referenceExamples, suno_wish_library: wishLibrary,
      request_timeout_seconds: requestTimeoutSeconds,
      scene_base_prompt_narrative: sceneBasePromptNarrative, scene_base_prompt_abstract: sceneBasePromptAbstract,
      scene_wish_library: sceneWishLibrary, background_remover_params: backgroundRemoverParams,
    });
  }
  function handleApiKeysFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) actions.importApiKeys(file);
  }
  function handleGeneralFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) actions.importGeneralSettings(file);
  }

  function startEditTag(index) {
    setEditingTagIndex(index);
    setNewTagDraft(specialTags[index]);
  }
  function cancelEditTag() {
    setEditingTagIndex(null);
    setNewTagDraft('');
  }
  function submitTagDraft() {
    if (editingTagIndex !== null) {
      actions.updateSpecialTag(editingTagIndex, newTagDraft);
    } else {
      actions.addSpecialTag(newTagDraft);
    }
    setEditingTagIndex(null);
    setNewTagDraft('');
  }

  function startEditExample(index) {
    setEditingExampleIndex(index);
    setNewExampleDraft(referenceExamples[index]);
  }
  function cancelEditExample() {
    setEditingExampleIndex(null);
    setNewExampleDraft('');
  }
  function submitExampleDraft() {
    if (editingExampleIndex !== null) {
      actions.updateReferenceExample(editingExampleIndex, newExampleDraft);
    } else {
      actions.addReferenceExample(newExampleDraft);
    }
    setEditingExampleIndex(null);
    setNewExampleDraft('');
  }

  function startEditWish(wish) {
    setEditingWishId(wish.id);
    setEditWishTitle(wish.title);
    setEditWishText(wish.text);
  }
  function cancelEditWish() {
    setEditingWishId(null);
  }
  function saveEditWish() {
    const title = editWishTitle.trim();
    const text = editWishText.trim();
    if (!title || !text) return;
    actions.updateWishSnippet(editingWishId, { title, text });
    setEditingWishId(null);
  }

  function startEditSceneWish(wish) {
    setEditingSceneWishId(wish.id);
    setEditSceneWishTitle(wish.title);
    setEditSceneWishText(wish.text);
  }
  function cancelEditSceneWish() {
    setEditingSceneWishId(null);
  }
  function saveEditSceneWish() {
    const title = editSceneWishTitle.trim();
    const text = editSceneWishText.trim();
    if (!title || !text) return;
    actions.updateSceneWishSnippet(editingSceneWishId, { title, text });
    setEditingSceneWishId(null);
  }

  const tabLabels = {
    general: L.settings_tab_general, providers: L.settings_tab_providers, models: L.settings_tab_models,
    prices: L.settings_tab_prices, prompts: L.settings_tab_prompts, wishes: L.settings_tab_wishes,
    logos: L.settings_tab_logos,
  };

  const logoFileRef = useRef(null);
  const [logoNameDraft, setLogoNameDraft] = useState('');
  function handleLogoFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) {
      actions.uploadLogo(logoNameDraft, file);
      setLogoNameDraft('');
    }
  }

  async function refreshModels() {
    setRefreshingModels(true);
    try {
      const entries = await Promise.all(
        MODEL_PROVIDERS.map((p) => api.listModels(p.id).catch(() => ({ provider: p.id, source: 'error', models: [], error: 'failed' }))),
      );
      const next = {};
      entries.forEach((entry) => { next[entry.provider] = entry; });
      setCatalog((prev) => ({ ...prev, ...next }));
      actions.refreshPricing?.();
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
      setImageCatalog((prev) => ({ ...prev, ...next }));
      actions.refreshPricing?.();
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
        <div style={{ flex: 1 }} />
        <UsagePill L={L} today={usageToday} periodTotals={usagePeriodTotals} onOpen={onOpenUsage} onLoadPeriodTotals={onLoadUsagePeriodTotals} />
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

          {activeTab === 'general' && (
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
          )}

          {activeTab === 'general' && (
            <div className="settings-panel">
              <div className="settings-panel-label">{L.settings_backup}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="settings-row">
                  <span className="settings-row-name" style={{ width: 'auto', flex: 1 }}>{L.settings_backupOther}</span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-accent-soft" onClick={exportGeneralFile}>
                      <Download size={13} /> {L.settings_exportBtn}
                    </button>
                    <button className="btn btn-accent-soft" onClick={() => generalFileRef.current?.click()}>
                      <Upload size={13} /> {L.settings_importBtn}
                    </button>
                    <input
                      ref={generalFileRef}
                      type="file"
                      accept="application/json"
                      style={{ display: 'none' }}
                      onChange={handleGeneralFile}
                    />
                  </div>
                </div>
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
                <div className="settings-row">
                  <span className="settings-row-name" style={{ width: 'auto', flex: 1 }}>{L.settings_backupApiKeys}</span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-accent-soft" onClick={exportApiKeysFile}>
                      <Download size={13} /> {L.settings_exportBtn}
                    </button>
                    <button className="btn btn-accent-soft" onClick={() => apiKeysFileRef.current?.click()}>
                      <Upload size={13} /> {L.settings_importBtn}
                    </button>
                    <input
                      ref={apiKeysFileRef}
                      type="file"
                      accept="application/json"
                      style={{ display: 'none' }}
                      onChange={handleApiKeysFile}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'providers' && (
            <div className="settings-panel">
              <div className="settings-panel-label">{L.settings_bgRemover}</div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 }}>{L.settings_bgRemoverHint}</div>
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
          )}

          {activeTab === 'models' && (
            <>
              <div className="settings-panel">
                <div className="settings-panel-label">{L.settings_textModels}</div>
                <ModelFavorites
                  L={L} providers={MODEL_PROVIDERS}
                  favorites={textModels.favorites} defaultValue={textModels.default}
                  catalog={catalog} refreshing={refreshingModels} onRefresh={refreshModels}
                  prices={priceMap}
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
                  prices={priceMap}
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
                  prices={priceMap}
                  onAddFavorite={actions.addImageModelFavorite}
                  onRemoveFavorite={actions.removeImageModelFavorite}
                  onSetDefault={actions.setImageModelDefault}
                />
              </div>

              <div className="settings-panel">
                <div className="settings-panel-label">{L.settings_imageModelsSimple}</div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>{L.settings_imageModelsSimpleHint}</div>
                <ModelFavorites
                  L={L} providers={IMAGE_MODEL_PROVIDERS}
                  favorites={imageModelsSimple.favorites} defaultValue={imageModelsSimple.default}
                  catalog={imageCatalog} refreshing={refreshingImageModels} onRefresh={refreshImageModels}
                  prices={priceMap}
                  onAddFavorite={actions.addImageModelSimpleFavorite}
                  onRemoveFavorite={actions.removeImageModelSimpleFavorite}
                  onSetDefault={actions.setImageModelSimpleDefault}
                />
              </div>
            </>
          )}

          {activeTab === 'prices' && (
            <PricingPanel L={L} pricing={pricing} providers={IMAGE_MODEL_PROVIDERS} onSave={actions.savePricingOverrides} />
          )}

          {activeTab === 'prompts' && (
            <>
              <div className="settings-panel">
                <div className="settings-panel-label">{L.settings_specialTags}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {specialTags.map((tag, i) => (
                    <div
                      className="settings-row"
                      key={i}
                      style={i === editingTagIndex ? { background: 'rgba(255,255,255,0.06)', borderRadius: 8, margin: '0 -6px', padding: '4px 6px' } : undefined}
                    >
                      <span
                        className="settings-row-name"
                        style={{ width: 'auto', flex: 1, cursor: 'pointer' }}
                        title={L.settings_clickToEdit}
                        onClick={() => startEditTag(i)}
                      >
                        {tag}
                      </span>
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
                  <button className="btn btn-accent-soft" onClick={submitTagDraft}>
                    {editingTagIndex !== null ? L.save : L.add}
                  </button>
                  {editingTagIndex !== null && (
                    <button className="btn-ghost" style={{ padding: '6px 16px', borderRadius: 8, border: 'none', cursor: 'pointer' }} onClick={cancelEditTag}>
                      {L.cancel}
                    </button>
                  )}
                </div>
              </div>

              {sunoPromptPresets.length > 0 && (
                <div className="settings-panel">
                  <div className="settings-panel-label">{L.settings_sunoPromptPresets}</div>
                  <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>{L.settings_sunoPromptPresetsHint}</div>
                  {groupPresetsByService(sunoPromptPresets).map(([service, presets]) => (
                    <div key={service} style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: 11.5, opacity: 0.6, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.4 }}>{service}</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {presets.map((preset) => {
                          const isActive = sunoBasePrompt === preset.prompt;
                          return (
                            <div className="settings-row" key={preset.id} style={{ alignItems: 'flex-start' }}>
                              <div>
                                <div className="settings-row-name">{preset.name}</div>
                                <div style={{ fontSize: 12, opacity: 0.7 }}>{preset.description}</div>
                              </div>
                              <button
                                className={`btn btn-accent-soft${isActive ? ' is-active' : ''}`}
                                style={{ flexShrink: 0 }}
                                onClick={() => actions.setSunoBasePrompt(preset.prompt)}
                              >
                                {isActive ? L.settings_presetLoaded : L.settings_loadPreset}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}

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
                <div className="settings-panel-label">{L.settings_sceneBasePromptNarrative}</div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8 }}>{L.settings_sceneBasePromptNarrativeHint}</div>
                <textarea
                  className="suno-textarea"
                  style={{ minHeight: 180 }}
                  value={sceneBasePromptNarrative}
                  onChange={(e) => actions.updateSceneBasePromptNarrative(e.target.value)}
                />
              </div>

              <div className="settings-panel">
                <div className="settings-panel-label">{L.settings_sceneBasePromptAbstract}</div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8 }}>{L.settings_sceneBasePromptAbstractHint}</div>
                <textarea
                  className="suno-textarea"
                  style={{ minHeight: 180 }}
                  value={sceneBasePromptAbstract}
                  onChange={(e) => actions.updateSceneBasePromptAbstract(e.target.value)}
                />
              </div>

              <div className="settings-panel">
                <div className="settings-panel-label">{L.settings_referenceExamples}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {referenceExamples.map((example, i) => (
                    <div
                      className="settings-row"
                      key={i}
                      style={i === editingExampleIndex ? { background: 'rgba(255,255,255,0.06)', borderRadius: 8, margin: '0 -6px', padding: '4px 6px' } : undefined}
                    >
                      <span
                        className="settings-row-name"
                        style={{ width: 'auto', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}
                        title={L.settings_clickToEdit}
                        onClick={() => startEditExample(i)}
                      >
                        {example}
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
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-accent-soft" style={{ alignSelf: 'flex-start' }} onClick={submitExampleDraft}>
                      {editingExampleIndex !== null ? L.save : L.add}
                    </button>
                    {editingExampleIndex !== null && (
                      <button className="btn-ghost" style={{ padding: '6px 16px', borderRadius: 8, border: 'none', cursor: 'pointer' }} onClick={cancelEditExample}>
                        {L.cancel}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}

          {activeTab === 'wishes' && (
            <>
            <div className="settings-panel">
              <div className="settings-panel-label">{L.settings_wishLibrary}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {sortByUseCount(wishLibrary).map((wish) => (
                  editingWishId === wish.id ? (
                    <div className="settings-panel" style={{ padding: 12 }} key={wish.id}>
                      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                        <input
                          className="field"
                          value={editWishTitle}
                          onChange={(e) => setEditWishTitle(e.target.value)}
                          placeholder={L.settings_wishLibraryTitleLabel}
                          autoFocus
                        />
                        {wishVoice.isSupported && (
                          <button
                            className={`icon-btn${wishVoice.recordingField === `wish-title-${wish.id}` ? ' icon-btn-recording' : ''}`}
                            style={{ width: 38, height: 38, flexShrink: 0 }}
                            title={L.voiceEdit}
                            onClick={() => wishVoice.startFieldVoice(`wish-title-${wish.id}`, (t) => setEditWishTitle(t))}
                          >
                            {wishVoice.recordingField === `wish-title-${wish.id}` ? <MicOff size={15} /> : <Mic size={15} />}
                          </button>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                        <textarea
                          className="suno-textarea"
                          style={{ minHeight: 70, flex: 1 }}
                          value={editWishText}
                          onChange={(e) => setEditWishText(e.target.value)}
                          placeholder={L.settings_wishLibraryTextLabel}
                        />
                        {wishVoice.isSupported && (
                          <button
                            className={`icon-btn${wishVoice.recordingField === `wish-text-${wish.id}` ? ' icon-btn-recording' : ''}`}
                            style={{ width: 38, height: 38, flexShrink: 0 }}
                            title={L.voiceEdit}
                            onClick={() => wishVoice.startFieldVoice(`wish-text-${wish.id}`, (t) => setEditWishText((prev) => (prev ? `${prev}\n${t}` : t)))}
                          >
                            {wishVoice.recordingField === `wish-text-${wish.id}` ? <MicOff size={15} /> : <Mic size={15} />}
                          </button>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <button className="btn btn-gradient" style={{ padding: '6px 16px' }} onClick={saveEditWish}>{L.save}</button>
                        <button className="btn-ghost" style={{ padding: '6px 16px', borderRadius: 8, border: 'none', cursor: 'pointer' }} onClick={cancelEditWish}>{L.cancel}</button>
                      </div>
                    </div>
                  ) : (
                    <div className="settings-row" key={wish.id} title={wish.text}>
                      <span className="settings-row-name" style={{ width: 'auto', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {wish.title}
                      </span>
                      <button className="icon-btn" style={{ width: 30, height: 30, opacity: 0.75 }} title={L.settings_wishLibraryEdit} onClick={() => startEditWish(wish)}>
                        <Pencil size={13} />
                      </button>
                      <button className="icon-btn icon-btn-danger" onClick={() => actions.removeWishSnippet(wish.id)}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input
                  className="field"
                  value={newWishDraft}
                  onChange={(e) => setNewWishDraft(e.target.value)}
                  placeholder={wishVoice.recordingField === 'wish-draft' ? L.listening : L.settings_wishLibraryPlaceholder}
                />
                {wishVoice.isSupported && (
                  <button
                    className={`icon-btn${wishVoice.recordingField === 'wish-draft' ? ' icon-btn-recording' : ''}`}
                    style={{ width: 38, height: 38, flexShrink: 0 }}
                    title={L.voiceEdit}
                    onClick={() => wishVoice.startFieldVoice('wish-draft', (t) => setNewWishDraft((prev) => (prev ? `${prev} ${t}` : t)))}
                  >
                    {wishVoice.recordingField === 'wish-draft' ? <MicOff size={15} /> : <Mic size={15} />}
                  </button>
                )}
                <button
                  className="btn btn-accent-soft"
                  onClick={() => { actions.saveWishToLibrary(newWishDraft); setNewWishDraft(''); }}
                >
                  {L.add}
                </button>
              </div>
            </div>

            <div className="settings-panel">
              <div className="settings-panel-label">{L.scene_wishesTitle}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {sortByUseCount(sceneWishLibrary).map((wish) => (
                  editingSceneWishId === wish.id ? (
                    <div className="settings-panel" style={{ padding: 12 }} key={wish.id}>
                      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                        <input
                          className="field"
                          value={editSceneWishTitle}
                          onChange={(e) => setEditSceneWishTitle(e.target.value)}
                          placeholder={L.settings_wishLibraryTitleLabel}
                          autoFocus
                        />
                      </div>
                      <textarea
                        className="suno-textarea"
                        style={{ minHeight: 70 }}
                        value={editSceneWishText}
                        onChange={(e) => setEditSceneWishText(e.target.value)}
                        placeholder={L.settings_wishLibraryTextLabel}
                      />
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <button className="btn btn-gradient" style={{ padding: '6px 16px' }} onClick={saveEditSceneWish}>{L.save}</button>
                        <button className="btn-ghost" style={{ padding: '6px 16px', borderRadius: 8, border: 'none', cursor: 'pointer' }} onClick={cancelEditSceneWish}>{L.cancel}</button>
                      </div>
                    </div>
                  ) : (
                    <div className="settings-row" key={wish.id} title={wish.text}>
                      <span className="settings-row-name" style={{ width: 'auto', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {wish.title}
                      </span>
                      <button className="icon-btn" style={{ width: 30, height: 30, opacity: 0.75 }} title={L.settings_wishLibraryEdit} onClick={() => startEditSceneWish(wish)}>
                        <Pencil size={13} />
                      </button>
                      <button className="icon-btn icon-btn-danger" onClick={() => actions.removeSceneWishSnippet(wish.id)}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input
                  className="field"
                  value={newSceneWishDraft}
                  onChange={(e) => setNewSceneWishDraft(e.target.value)}
                  placeholder={L.scene_wishPlaceholder}
                />
                <button
                  className="btn btn-accent-soft"
                  onClick={() => { actions.saveSceneWishToLibrary(newSceneWishDraft); setNewSceneWishDraft(''); }}
                >
                  {L.add}
                </button>
              </div>
            </div>
            </>
          )}

          {activeTab === 'logos' && (
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
                  value={logoNameDraft}
                  onChange={(e) => setLogoNameDraft(e.target.value)}
                  placeholder={L.settings_logosNamePlaceholder}
                />
                <button className="btn btn-accent-soft" onClick={() => logoFileRef.current?.click()}>
                  <Upload size={13} /> {L.settings_logosUpload}
                </button>
                <input
                  ref={logoFileRef}
                  type="file"
                  accept="image/png,image/webp"
                  style={{ display: 'none' }}
                  onChange={handleLogoFile}
                />
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
