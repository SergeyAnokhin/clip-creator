import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { api } from '../../api/client.js';
import { modelPriceMap } from '../../lib/pricing.js';
import { downloadJSON } from '../../lib/download.js';
import PricingPanel from './PricingPanel.jsx';
import UsagePill from '../UsagePill.jsx';
import MiniPlayerWidget from '../MiniPlayerWidget.jsx';
import GeneralTab from './GeneralTab.jsx';
import ProvidersTab from './ProvidersTab.jsx';
import ModelsTab from './ModelsTab.jsx';
import PromptsTab from './PromptsTab.jsx';
import WishesTab from './WishesTab.jsx';
import LogosTab from './LogosTab.jsx';
import { IMAGE_MODEL_PROVIDERS, MODEL_PROVIDERS, VIDEO_MODEL_PROVIDERS } from './modelProviders.js';

const TABS = ['general', 'providers', 'models', 'prices', 'prompts', 'wishes', 'logos'];

// Shell only: header, tab bar, save button, and the model catalogs the
// Models tab renders. Each tab's own UI and draft state lives in its
// `*Tab.jsx` sibling.
export default function SettingsScreen({
  L, lang, showToast, apiKeys, textModels, simpleModels, imageModels, imageModelsSimple, specialTags,
  videoModels, videoWishLibrary,
  sunoBasePrompt, sunoPromptPresets, referenceExamples, wishLibrary, requestTimeoutSeconds,
  sceneBasePromptNarrative, sceneBasePromptAbstract, sceneWishLibrary,
  backgroundRemoverParams, backgroundRemoverMethod, backgroundRemoverLocalParams, backgroundRemoverFalParams, logos,
  outpaintQualityMode, musicTags, sunoBasePromptUserPresets, murekaBasePromptUserPresets,
  pricing, usageToday, usagePeriodTotals,
  miniPlayerTrack, miniPlayerIsPlaying, onToggleMiniPlayer,
  onClose, onOpenUsage, onLoadUsagePeriodTotals, actions,
}) {
  const [activeTab, setActiveTab] = useState('general');
  const [catalog, setCatalog] = useState({});
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [imageCatalog, setImageCatalog] = useState({});
  const [refreshingImageModels, setRefreshingImageModels] = useState(false);
  const [videoCatalog, setVideoCatalog] = useState({});
  const [refreshingVideoModels, setRefreshingVideoModels] = useState(false);
  const priceMap = modelPriceMap(pricing?.models);

  // Load the last-known-good model catalog on mount, so the favorites
  // search has something to show before anyone presses "Refresh models" in
  // this session.
  useEffect(() => {
    api.getModelsCatalog().then((res) => {
      setCatalog(res.text || {});
      setImageCatalog(res.image || {});
      setVideoCatalog(res.video || {});
    }).catch(() => {});
  }, []);

  function exportApiKeysFile() {
    downloadJSON('versecraft-api-keys.json', { api_keys: apiKeys });
  }
  function exportGeneralFile() {
    downloadJSON('versecraft-settings.json', {
      lang, text_models: textModels, simple_models: simpleModels, image_models: imageModels,
      image_models_simple: imageModelsSimple, video_models: videoModels, video_wish_library: videoWishLibrary,
      special_tags: specialTags, suno_base_prompt: sunoBasePrompt,
      suno_reference_examples: referenceExamples, suno_wish_library: wishLibrary,
      request_timeout_seconds: requestTimeoutSeconds,
      scene_base_prompt_narrative: sceneBasePromptNarrative, scene_base_prompt_abstract: sceneBasePromptAbstract,
      scene_wish_library: sceneWishLibrary, background_remover_params: backgroundRemoverParams,
      background_remover_method: backgroundRemoverMethod, background_remover_local_params: backgroundRemoverLocalParams,
      background_remover_fal_params: backgroundRemoverFalParams,
      outpaint_quality_mode: outpaintQualityMode, music_tags: musicTags,
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

  async function refreshVideoModels() {
    setRefreshingVideoModels(true);
    try {
      const entries = await Promise.all(
        VIDEO_MODEL_PROVIDERS.map((p) => api.listVideoModels(p.id).catch(() => ({ provider: p.id, source: 'error', models: [], error: 'failed' }))),
      );
      const next = {};
      entries.forEach((entry) => { next[entry.provider] = entry; });
      setVideoCatalog((prev) => ({ ...prev, ...next }));
      actions.refreshPricing?.();
    } finally {
      setRefreshingVideoModels(false);
    }
  }

  const tabLabels = {
    general: L.settings_tab_general, providers: L.settings_tab_providers, models: L.settings_tab_models,
    prices: L.settings_tab_prices, prompts: L.settings_tab_prompts, wishes: L.settings_tab_wishes,
    logos: L.settings_tab_logos,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <div className="home-header">
        <button className="icon-btn" style={{ width: 36, height: 36 }} onClick={onClose}>
          <ArrowLeft size={16} />
        </button>
        <div className="workflow-title">{L.settingsTitle}</div>
        <div style={{ flex: 1 }} />
        <MiniPlayerWidget L={L} track={miniPlayerTrack} isPlaying={miniPlayerIsPlaying} onToggle={onToggleMiniPlayer} />
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
            <GeneralTab
              L={L} lang={lang} requestTimeoutSeconds={requestTimeoutSeconds} actions={actions}
              onExport={exportGeneralFile} onImportFile={handleGeneralFile}
            />
          )}

          {activeTab === 'providers' && (
            <ProvidersTab
              L={L} apiKeys={apiKeys}
              backgroundRemoverMethod={backgroundRemoverMethod}
              backgroundRemoverLocalParams={backgroundRemoverLocalParams}
              backgroundRemoverFalParams={backgroundRemoverFalParams}
              backgroundRemoverParams={backgroundRemoverParams}
              outpaintQualityMode={outpaintQualityMode}
              actions={actions}
              onExportApiKeys={exportApiKeysFile} onImportApiKeysFile={handleApiKeysFile}
            />
          )}

          {activeTab === 'models' && (
            <ModelsTab
              L={L}
              textModels={textModels} simpleModels={simpleModels}
              imageModels={imageModels} imageModelsSimple={imageModelsSimple} videoModels={videoModels}
              catalog={catalog} imageCatalog={imageCatalog} videoCatalog={videoCatalog}
              refreshingModels={refreshingModels}
              refreshingImageModels={refreshingImageModels}
              refreshingVideoModels={refreshingVideoModels}
              onRefreshModels={refreshModels}
              onRefreshImageModels={refreshImageModels}
              onRefreshVideoModels={refreshVideoModels}
              priceMap={priceMap} actions={actions}
            />
          )}

          {activeTab === 'prices' && (
            <PricingPanel L={L} pricing={pricing} providers={IMAGE_MODEL_PROVIDERS} onSave={actions.savePricingOverrides} />
          )}

          {activeTab === 'prompts' && (
            <PromptsTab
              L={L} specialTags={specialTags} musicTags={musicTags}
              sunoPromptPresets={sunoPromptPresets} sunoBasePrompt={sunoBasePrompt}
              sunoBasePromptUserPresets={sunoBasePromptUserPresets}
              murekaBasePromptUserPresets={murekaBasePromptUserPresets}
              sceneBasePromptNarrative={sceneBasePromptNarrative}
              sceneBasePromptAbstract={sceneBasePromptAbstract}
              referenceExamples={referenceExamples} actions={actions}
            />
          )}

          {activeTab === 'wishes' && (
            <WishesTab
              L={L} lang={lang} showToast={showToast}
              wishLibrary={wishLibrary} sceneWishLibrary={sceneWishLibrary} videoWishLibrary={videoWishLibrary}
              actions={actions}
            />
          )}

          {activeTab === 'logos' && <LogosTab L={L} logos={logos} actions={actions} />}

          <button className="btn btn-gradient" style={{ justifyContent: 'center', padding: 12, fontSize: 14 }} onClick={actions.onSave}>
            {L.save}
          </button>
        </div>
      </div>
    </div>
  );
}
