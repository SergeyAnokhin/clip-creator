import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { DICT } from '../i18n/dict.js';
import { readJSONFile } from '../lib/download.js';
import { debounce } from '../lib/debounce.js';
import { nextMusicTagColor } from '../lib/musicTagColors.js';

const DEFAULT_SPECIAL_TAGS = ['[Vocal Interlude]', '[Female vocal interlude]'];
const DEFAULT_TEXT_MODELS = { favorites: [], default: 'google:gemini-2.5-flash' };
const DEFAULT_SIMPLE_MODELS = { favorites: [], default: '' };
const DEFAULT_IMAGE_MODELS = { favorites: [], default: '' };
const DEFAULT_IMAGE_MODELS_SIMPLE = { favorites: [], default: '' };
const DEFAULT_BG_REMOVER_PARAMS = { background_type: 'rgba', format: 'png', threshold: 0, reverse: false };
const DEFAULT_BG_REMOVER_METHOD = 'replicate';
const DEFAULT_BG_REMOVER_LOCAL_PARAMS = { bg: 'black', threshold: 40 };
const DEFAULT_BG_REMOVER_FAL_PARAMS = { model: 'fal-ai/bria/background/remove' };
const DEFAULT_OUTPAINT_QUALITY_MODE = 'fast';

/** App settings (language, API keys, default models, Suno meta-tags), loaded
 * from the backend on mount. Owns `lang`, and therefore the `L` dictionary
 * every other hook uses for toast copy. */
export function useSettings({ showToast, onAiCall }) {
  const [lang, setLang] = useState('ru');
  const [apiKeys, setApiKeys] = useState({ replicate: '', google: '', fal: '', openrouter: '', deepseek: '', krea: '', google_translate: '' });
  const [textModels, setTextModels] = useState(DEFAULT_TEXT_MODELS);
  const [simpleModels, setSimpleModels] = useState(DEFAULT_SIMPLE_MODELS);
  const [imageModels, setImageModels] = useState(DEFAULT_IMAGE_MODELS);
  const [imageModelsSimple, setImageModelsSimple] = useState(DEFAULT_IMAGE_MODELS_SIMPLE);
  const [specialTags, setSpecialTags] = useState(DEFAULT_SPECIAL_TAGS);
  const [sunoBasePrompt, setSunoBasePrompt] = useState('');
  const [referenceExamples, setReferenceExamples] = useState([]);
  const [wishLibrary, setWishLibrary] = useState([]);
  const [sunoPromptPresets, setSunoPromptPresets] = useState([]);
  const [requestTimeoutSeconds, setRequestTimeoutSeconds] = useState(60);
  const [sceneBasePromptNarrative, setSceneBasePromptNarrative] = useState('');
  const [sceneBasePromptAbstract, setSceneBasePromptAbstract] = useState('');
  const [sceneWishLibrary, setSceneWishLibrary] = useState([]);
  const [titleCardWishLibrary, setTitleCardWishLibrary] = useState([]);
  const [hideMotionPrompt, setHideMotionPromptState] = useState(false);
  const [titleCardBasePrompt, setTitleCardBasePrompt] = useState('');
  const [titleCardBasePromptPresets, setTitleCardBasePromptPresets] = useState([]);
  const [backgroundRemoverParams, setBackgroundRemoverParams] = useState(DEFAULT_BG_REMOVER_PARAMS);
  const [backgroundRemoverMethod, setBackgroundRemoverMethodState] = useState(DEFAULT_BG_REMOVER_METHOD);
  const [backgroundRemoverLocalParams, setBackgroundRemoverLocalParams] = useState(DEFAULT_BG_REMOVER_LOCAL_PARAMS);
  const [backgroundRemoverFalParams, setBackgroundRemoverFalParams] = useState(DEFAULT_BG_REMOVER_FAL_PARAMS);
  const [outpaintQualityMode, setOutpaintQualityModeState] = useState(DEFAULT_OUTPAINT_QUALITY_MODE);
  const [logos, setLogos] = useState([]);
  const [posterTemplates, setPosterTemplates] = useState([]);
  const [musicTags, setMusicTags] = useState([]);
  const [sunoBasePromptUserPresets, setSunoBasePromptUserPresets] = useState([]);
  const [murekaBasePromptUserPresets, setMurekaBasePromptUserPresets] = useState([]);

  useEffect(() => {
    api.getSettings().then((s) => {
      setLang(s.lang || 'ru');
      setApiKeys(s.api_keys || {});
      setTextModels(s.text_models || DEFAULT_TEXT_MODELS);
      setSimpleModels(s.simple_models || DEFAULT_SIMPLE_MODELS);
      setImageModels(s.image_models || DEFAULT_IMAGE_MODELS);
      setImageModelsSimple(s.image_models_simple || DEFAULT_IMAGE_MODELS_SIMPLE);
      setSpecialTags(s.special_tags || DEFAULT_SPECIAL_TAGS);
      setSunoBasePrompt(s.suno_base_prompt || '');
      setReferenceExamples(s.suno_reference_examples || []);
      setWishLibrary(s.suno_wish_library || []);
      setRequestTimeoutSeconds(s.request_timeout_seconds || 60);
      setSceneBasePromptNarrative(s.scene_base_prompt_narrative || '');
      setSceneBasePromptAbstract(s.scene_base_prompt_abstract || '');
      setSceneWishLibrary(s.scene_wish_library || []);
      setTitleCardWishLibrary(s.title_card_wish_library || []);
      setHideMotionPromptState(s.hide_motion_prompt || false);
      setTitleCardBasePrompt(s.title_card_base_prompt || '');
      setTitleCardBasePromptPresets(s.title_card_base_prompt_presets || []);
      setBackgroundRemoverParams(s.background_remover_params || DEFAULT_BG_REMOVER_PARAMS);
      setBackgroundRemoverMethodState(s.background_remover_method || DEFAULT_BG_REMOVER_METHOD);
      setBackgroundRemoverLocalParams(s.background_remover_local_params || DEFAULT_BG_REMOVER_LOCAL_PARAMS);
      setBackgroundRemoverFalParams(s.background_remover_fal_params || DEFAULT_BG_REMOVER_FAL_PARAMS);
      setOutpaintQualityModeState(s.outpaint_quality_mode || DEFAULT_OUTPAINT_QUALITY_MODE);
      setLogos(s.logos || []);
      setPosterTemplates(s.poster_templates || []);
      setMusicTags(s.music_tags || []);
      setSunoBasePromptUserPresets(s.suno_base_prompt_user_presets || []);
      setMurekaBasePromptUserPresets(s.mureka_base_prompt_user_presets || []);
    }).catch(() => {});
    api.getSunoPromptPresets().then(setSunoPromptPresets).catch(() => {});
  }, []);

  const L = DICT[lang];

  function setApiKey(key, value) { setApiKeys((prev) => ({ ...prev, [key]: value })); }
  function addSpecialTag(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSpecialTags((prev) => [...prev, trimmed]);
  }
  function removeSpecialTag(index) {
    setSpecialTags((prev) => prev.filter((_, i) => i !== index));
  }
  function updateSpecialTag(index, text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSpecialTags((prev) => prev.map((t, i) => (i === index ? trimmed : t)));
  }
  function addMusicTag(label) {
    const trimmed = label.trim();
    if (!trimmed) return;
    setMusicTags((prev) => [
      ...prev,
      { id: `mtag_${Math.random().toString(36).slice(2, 10)}`, label: trimmed, color: nextMusicTagColor(prev.length) },
    ]);
  }
  function removeMusicTag(id) {
    setMusicTags((prev) => prev.filter((t) => t.id !== id));
  }
  function updateMusicTag(id, label) {
    const trimmed = label.trim();
    if (!trimmed) return;
    setMusicTags((prev) => prev.map((t) => (t.id === id ? { ...t, label: trimmed } : t)));
  }
  function addReferenceExample(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setReferenceExamples((prev) => [...prev, trimmed]);
  }
  function removeReferenceExample(index) {
    setReferenceExamples((prev) => prev.filter((_, i) => i !== index));
  }
  function updateReferenceExample(index, text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setReferenceExamples((prev) => prev.map((t, i) => (i === index ? trimmed : t)));
  }

  function addTextModelFavorite(entry) {
    setTextModels((prev) => {
      const key = `${entry.provider}:${entry.id}`;
      if (prev.favorites.some((f) => `${f.provider}:${f.id}` === key)) return prev;
      return { ...prev, favorites: [...prev.favorites, entry] };
    });
  }
  function removeTextModelFavorite(provider, id) {
    setTextModels((prev) => ({
      ...prev,
      favorites: prev.favorites.filter((f) => !(f.provider === provider && f.id === id)),
    }));
  }
  function setTextModelDefault(composite) {
    setTextModels((prev) => ({ ...prev, default: composite }));
  }

  function addSimpleModelFavorite(entry) {
    setSimpleModels((prev) => {
      const key = `${entry.provider}:${entry.id}`;
      if (prev.favorites.some((f) => `${f.provider}:${f.id}` === key)) return prev;
      return { ...prev, favorites: [...prev.favorites, entry] };
    });
  }
  function removeSimpleModelFavorite(provider, id) {
    setSimpleModels((prev) => ({
      ...prev,
      favorites: prev.favorites.filter((f) => !(f.provider === provider && f.id === id)),
    }));
  }
  function setSimpleModelDefault(composite) {
    setSimpleModels((prev) => ({ ...prev, default: composite }));
  }

  function addImageModelFavorite(entry) {
    setImageModels((prev) => {
      const key = `${entry.provider}:${entry.id}`;
      if (prev.favorites.some((f) => `${f.provider}:${f.id}` === key)) return prev;
      return { ...prev, favorites: [...prev.favorites, entry] };
    });
  }
  function removeImageModelFavorite(provider, id) {
    setImageModels((prev) => ({
      ...prev,
      favorites: prev.favorites.filter((f) => !(f.provider === provider && f.id === id)),
    }));
  }
  function setImageModelDefault(composite) {
    setImageModels((prev) => ({ ...prev, default: composite }));
  }

  // Cheap/preview tier for image generation - mirrors text_models/simple_models'
  // quality/cheap split (see ImagesStage.jsx's tier toggle).
  function addImageModelSimpleFavorite(entry) {
    setImageModelsSimple((prev) => {
      const key = `${entry.provider}:${entry.id}`;
      if (prev.favorites.some((f) => `${f.provider}:${f.id}` === key)) return prev;
      return { ...prev, favorites: [...prev.favorites, entry] };
    });
  }
  function removeImageModelSimpleFavorite(provider, id) {
    setImageModelsSimple((prev) => ({
      ...prev,
      favorites: prev.favorites.filter((f) => !(f.provider === provider && f.id === id)),
    }));
  }
  function setImageModelSimpleDefault(composite) {
    setImageModelsSimple((prev) => ({ ...prev, default: composite }));
  }

  // Separate from setSunoBasePrompt (used by the Settings screen field, which
  // only persists via the big "Сохранить" button at the bottom) - this one
  // backs the compact base-prompt panel on the Suno stage, which has no such
  // button, so it autosaves on its own, debounced like project text fields.
  const debouncedSaveBasePrompt = useMemo(
    () => debounce((value) => { api.putSettings({ suno_base_prompt: value }).catch(() => {}); }, 400),
    [],
  );
  function updateSunoBasePrompt(value) {
    setSunoBasePrompt(value);
    debouncedSaveBasePrompt(value);
  }

  // Same autosave-on-the-stage pattern as updateSunoBasePrompt, one debounced
  // saver per scene mode so switching between narrative/abstract on the
  // Scenes stage doesn't fight over a single pending save.
  const debouncedSaveSceneBaseNarrative = useMemo(
    () => debounce((value) => { api.putSettings({ scene_base_prompt_narrative: value }).catch(() => {}); }, 400),
    [],
  );
  const debouncedSaveSceneBaseAbstract = useMemo(
    () => debounce((value) => { api.putSettings({ scene_base_prompt_abstract: value }).catch(() => {}); }, 400),
    [],
  );
  function updateSceneBasePromptNarrative(value) {
    setSceneBasePromptNarrative(value);
    debouncedSaveSceneBaseNarrative(value);
  }
  function updateSceneBasePromptAbstract(value) {
    setSceneBasePromptAbstract(value);
    debouncedSaveSceneBaseAbstract(value);
  }

  // Same autosave-on-the-stage pattern as updateSunoBasePrompt, for the
  // Title Card stage's base-prompt panel.
  const debouncedSaveTitleCardBasePrompt = useMemo(
    () => debounce((value) => { api.putSettings({ title_card_base_prompt: value }).catch(() => {}); }, 400),
    [],
  );
  function updateTitleCardBasePrompt(value) {
    setTitleCardBasePrompt(value);
    debouncedSaveTitleCardBasePrompt(value);
  }
  // User-managed named variants of the base prompt (unlike Suno's read-only
  // suno-prompt-presets endpoint) - plain array CRUD persisted via the
  // regular partial-merge PUT, same as scene_wish_library above.
  function saveTitleCardBasePromptPreset(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) return;
    const preset = { id: crypto.randomUUID(), name: trimmed, prompt: titleCardBasePrompt };
    const next = [...titleCardBasePromptPresets, preset];
    setTitleCardBasePromptPresets(next);
    api.putSettings({ title_card_base_prompt_presets: next }).catch(() => {});
  }
  function loadTitleCardBasePromptPreset(id) {
    const preset = titleCardBasePromptPresets.find((p) => p.id === id);
    if (!preset) return;
    updateTitleCardBasePrompt(preset.prompt);
  }
  function deleteTitleCardBasePromptPreset(id) {
    const next = titleCardBasePromptPresets.filter((p) => p.id !== id);
    setTitleCardBasePromptPresets(next);
    api.putSettings({ title_card_base_prompt_presets: next }).catch(() => {});
  }

  // User-managed base-prompt presets for the Suno/Mureka "Музыкальные
  // промпты" settings tab - unlike SUNO_BASE_PROMPT_PRESETS/
  // MUREKA_BASE_PROMPT_PRESETS (built-in, read-only, served by
  // GET /suno-prompt-presets), these are freely added/renamed/deleted from
  // Settings, same plain-array-CRUD-via-partial-PUT pattern as the title-card
  // presets above. Also spliced into `sunoPromptPresets` optimistically (same
  // {id, service, name, description, prompt} shape the backend merges them
  // into) so they show up immediately in the Suno stage's existing
  // groupPresetsByService picker without a refetch.
  function saveSunoBasePromptUserPreset(name, prompt) {
    const trimmedName = (name || '').trim();
    const trimmedPrompt = (prompt || '').trim();
    if (!trimmedName || !trimmedPrompt) return;
    const preset = { id: crypto.randomUUID(), name: trimmedName, prompt: trimmedPrompt };
    const next = [...sunoBasePromptUserPresets, preset];
    setSunoBasePromptUserPresets(next);
    setSunoPromptPresets((prev) => [...prev, { id: preset.id, service: 'Suno', name: trimmedName, description: '', prompt: trimmedPrompt }]);
    api.putSettings({ suno_base_prompt_user_presets: next }).catch(() => {});
  }
  function updateSunoBasePromptUserPreset(id, { name, prompt }) {
    const trimmedName = (name || '').trim();
    const trimmedPrompt = (prompt || '').trim();
    if (!trimmedName || !trimmedPrompt) return;
    const next = sunoBasePromptUserPresets.map((p) => (p.id === id ? { ...p, name: trimmedName, prompt: trimmedPrompt } : p));
    setSunoBasePromptUserPresets(next);
    setSunoPromptPresets((prev) => prev.map((p) => (p.id === id ? { ...p, name: trimmedName, prompt: trimmedPrompt } : p)));
    api.putSettings({ suno_base_prompt_user_presets: next }).catch(() => {});
  }
  function deleteSunoBasePromptUserPreset(id) {
    const next = sunoBasePromptUserPresets.filter((p) => p.id !== id);
    setSunoBasePromptUserPresets(next);
    setSunoPromptPresets((prev) => prev.filter((p) => p.id !== id));
    api.putSettings({ suno_base_prompt_user_presets: next }).catch(() => {});
  }

  function saveMurekaBasePromptUserPreset(name, prompt) {
    const trimmedName = (name || '').trim();
    const trimmedPrompt = (prompt || '').trim();
    if (!trimmedName || !trimmedPrompt) return;
    const preset = { id: crypto.randomUUID(), name: trimmedName, prompt: trimmedPrompt };
    const next = [...murekaBasePromptUserPresets, preset];
    setMurekaBasePromptUserPresets(next);
    setSunoPromptPresets((prev) => [...prev, { id: preset.id, service: 'Mureka', name: trimmedName, description: '', prompt: trimmedPrompt }]);
    api.putSettings({ mureka_base_prompt_user_presets: next }).catch(() => {});
  }
  function updateMurekaBasePromptUserPreset(id, { name, prompt }) {
    const trimmedName = (name || '').trim();
    const trimmedPrompt = (prompt || '').trim();
    if (!trimmedName || !trimmedPrompt) return;
    const next = murekaBasePromptUserPresets.map((p) => (p.id === id ? { ...p, name: trimmedName, prompt: trimmedPrompt } : p));
    setMurekaBasePromptUserPresets(next);
    setSunoPromptPresets((prev) => prev.map((p) => (p.id === id ? { ...p, name: trimmedName, prompt: trimmedPrompt } : p)));
    api.putSettings({ mureka_base_prompt_user_presets: next }).catch(() => {});
  }
  function deleteMurekaBasePromptUserPreset(id) {
    const next = murekaBasePromptUserPresets.filter((p) => p.id !== id);
    setMurekaBasePromptUserPresets(next);
    setSunoPromptPresets((prev) => prev.filter((p) => p.id !== id));
    api.putSettings({ mureka_base_prompt_user_presets: next }).catch(() => {});
  }

  // Poster constructor "save as template" (logo/glass/text layout, reusable
  // across every poem/project) - same plain-array-CRUD-via-partial-PUT
  // pattern as the title-card base-prompt presets above.
  function savePosterTemplate(name, layers) {
    const trimmed = (name || '').trim();
    if (!trimmed) return;
    const template = { id: crypto.randomUUID(), name: trimmed, layers, created_at: new Date().toISOString() };
    const next = [...posterTemplates, template];
    setPosterTemplates(next);
    api.putSettings({ poster_templates: next }).catch(() => {});
  }
  function deletePosterTemplate(id) {
    const next = posterTemplates.filter((t) => t.id !== id);
    setPosterTemplates(next);
    api.putSettings({ poster_templates: next }).catch(() => {});
  }

  // Shared Scenes/Images-stage UI toggle (hide motion_prompt fields) -
  // persisted like updateSunoBasePrompt so it applies immediately and
  // survives a reload, but it's a single boolean flip, not a debounced text
  // field, so it saves right away instead of on a timer.
  function setHideMotionPrompt(value) {
    setHideMotionPromptState(value);
    api.putSettings({ hide_motion_prompt: value }).catch(() => {});
  }

  function setBackgroundRemoverParam(key, value) {
    setBackgroundRemoverParams((prev) => ({ ...prev, [key]: value }));
  }
  function setBackgroundRemoverMethod(value) {
    setBackgroundRemoverMethodState(value);
  }
  function setBackgroundRemoverLocalParam(key, value) {
    setBackgroundRemoverLocalParams((prev) => ({ ...prev, [key]: value }));
  }
  function setBackgroundRemoverFalParam(key, value) {
    setBackgroundRemoverFalParams((prev) => ({ ...prev, [key]: value }));
  }
  function setOutpaintQualityMode(value) {
    setOutpaintQualityModeState(value);
  }

  async function uploadLogo(name, file) {
    try {
      const result = await api.uploadLogo(name, file);
      setLogos(result.logos);
      showToast(L.toast_saved);
    } catch {
      showToast(L.toast_saveFailed);
    }
  }
  async function deleteLogo(id) {
    try {
      const result = await api.deleteLogo(id);
      setLogos(result.logos);
    } catch {
      showToast(L.toast_saveFailed);
    }
  }

  function removeWishSnippet(id) {
    const next = wishLibrary.filter((w) => w.id !== id);
    setWishLibrary(next);
    api.putSettings({ suno_wish_library: next }).catch(() => {});
  }
  function saveWishToLibrary(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return;
    api.saveWishToLibrary(trimmed)
      .then((res) => { setWishLibrary(res.suno_wish_library); showToast(L.toast_saved); })
      .catch(() => {})
      .finally(() => onAiCall?.());
  }
  function updateWishSnippet(id, patch) {
    api.updateWishSnippet(id, patch)
      .then((res) => { setWishLibrary(res.suno_wish_library); showToast(L.toast_saved); })
      .catch(() => showToast(L.toast_saveFailed));
  }

  function removeSceneWishSnippet(id) {
    const next = sceneWishLibrary.filter((w) => w.id !== id);
    setSceneWishLibrary(next);
    api.putSettings({ scene_wish_library: next }).catch(() => {});
  }
  function saveSceneWishToLibrary(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return;
    api.saveSceneWishToLibrary(trimmed)
      .then((res) => { setSceneWishLibrary(res.scene_wish_library); showToast(L.toast_saved); })
      .catch(() => {})
      .finally(() => onAiCall?.());
  }
  function updateSceneWishSnippet(id, patch) {
    api.updateSceneWishSnippet(id, patch)
      .then((res) => { setSceneWishLibrary(res.scene_wish_library); showToast(L.toast_saved); })
      .catch(() => showToast(L.toast_saveFailed));
  }

  function removeTitleCardWishSnippet(id) {
    const next = titleCardWishLibrary.filter((w) => w.id !== id);
    setTitleCardWishLibrary(next);
    api.putSettings({ title_card_wish_library: next }).catch(() => {});
  }

  // Bumps a wish's `use_count` (shown-chip sort order, most-used first) each
  // time it's toggled *on* - see useSunoStage.js/useScenesStage.js/
  // useTitleCardStage.js's toggleWish/toggleSceneWish/toggleTitleCardWish.
  // Same persistence pattern as removeWishSnippet - a partial `PUT
  // /api/settings` body, fire-and-forget.
  function bumpWishUse(id) {
    const next = wishLibrary.map((w) => (w.id === id ? { ...w, use_count: (w.use_count || 0) + 1 } : w));
    setWishLibrary(next);
    api.putSettings({ suno_wish_library: next }).catch(() => {});
  }
  function bumpSceneWishUse(id) {
    const next = sceneWishLibrary.map((w) => (w.id === id ? { ...w, use_count: (w.use_count || 0) + 1 } : w));
    setSceneWishLibrary(next);
    api.putSettings({ scene_wish_library: next }).catch(() => {});
  }
  function bumpTitleCardWishUse(id) {
    const next = titleCardWishLibrary.map((w) => (w.id === id ? { ...w, use_count: (w.use_count || 0) + 1 } : w));
    setTitleCardWishLibrary(next);
    api.putSettings({ title_card_wish_library: next }).catch(() => {});
  }

  async function importApiKeys(file) {
    try {
      const data = await readJSONFile(file);
      const keys = (data && data.api_keys) || data || {};
      setApiKeys((prev) => ({ ...prev, ...keys }));
      await api.putSettings({ api_keys: { ...apiKeys, ...keys } });
      showToast(L.toast_imported);
    } catch {
      showToast(L.toast_importFailed);
    }
  }

  async function importGeneralSettings(file) {
    try {
      const src = await readJSONFile(file);
      const next = {
        lang: src.lang ?? lang,
        text_models: src.text_models ?? textModels,
        simple_models: src.simple_models ?? simpleModels,
        image_models: src.image_models ?? imageModels,
        image_models_simple: src.image_models_simple ?? imageModelsSimple,
        special_tags: src.special_tags ?? specialTags,
        suno_base_prompt: src.suno_base_prompt ?? sunoBasePrompt,
        suno_reference_examples: src.suno_reference_examples ?? referenceExamples,
        suno_wish_library: src.suno_wish_library ?? wishLibrary,
        request_timeout_seconds: src.request_timeout_seconds ?? requestTimeoutSeconds,
        scene_base_prompt_narrative: src.scene_base_prompt_narrative ?? sceneBasePromptNarrative,
        scene_base_prompt_abstract: src.scene_base_prompt_abstract ?? sceneBasePromptAbstract,
        scene_wish_library: src.scene_wish_library ?? sceneWishLibrary,
        hide_motion_prompt: src.hide_motion_prompt ?? hideMotionPrompt,
        title_card_base_prompt: src.title_card_base_prompt ?? titleCardBasePrompt,
        title_card_base_prompt_presets: src.title_card_base_prompt_presets ?? titleCardBasePromptPresets,
        background_remover_params: src.background_remover_params ?? backgroundRemoverParams,
        background_remover_method: src.background_remover_method ?? backgroundRemoverMethod,
        background_remover_local_params: src.background_remover_local_params ?? backgroundRemoverLocalParams,
        background_remover_fal_params: src.background_remover_fal_params ?? backgroundRemoverFalParams,
        outpaint_quality_mode: src.outpaint_quality_mode ?? outpaintQualityMode,
        music_tags: src.music_tags ?? musicTags,
        suno_base_prompt_user_presets: src.suno_base_prompt_user_presets ?? sunoBasePromptUserPresets,
        mureka_base_prompt_user_presets: src.mureka_base_prompt_user_presets ?? murekaBasePromptUserPresets,
      };
      setLang(next.lang);
      setTextModels(next.text_models);
      setSimpleModels(next.simple_models);
      setImageModels(next.image_models);
      setImageModelsSimple(next.image_models_simple);
      setSpecialTags(next.special_tags);
      setSunoBasePrompt(next.suno_base_prompt);
      setReferenceExamples(next.suno_reference_examples);
      setWishLibrary(next.suno_wish_library);
      setRequestTimeoutSeconds(next.request_timeout_seconds);
      setSceneBasePromptNarrative(next.scene_base_prompt_narrative);
      setSceneBasePromptAbstract(next.scene_base_prompt_abstract);
      setSceneWishLibrary(next.scene_wish_library);
      setHideMotionPromptState(next.hide_motion_prompt);
      setTitleCardBasePrompt(next.title_card_base_prompt);
      setTitleCardBasePromptPresets(next.title_card_base_prompt_presets);
      setBackgroundRemoverParams(next.background_remover_params);
      setBackgroundRemoverMethodState(next.background_remover_method);
      setBackgroundRemoverLocalParams(next.background_remover_local_params);
      setBackgroundRemoverFalParams(next.background_remover_fal_params);
      setOutpaintQualityModeState(next.outpaint_quality_mode);
      setMusicTags(next.music_tags);
      setSunoBasePromptUserPresets(next.suno_base_prompt_user_presets);
      setMurekaBasePromptUserPresets(next.mureka_base_prompt_user_presets);
      await api.putSettings(next);
      api.getSunoPromptPresets().then(setSunoPromptPresets).catch(() => {});
      showToast(L.toast_imported);
    } catch {
      showToast(L.toast_importFailed);
    }
  }

  async function saveSettings() {
    try {
      await api.putSettings({
        lang, api_keys: apiKeys, text_models: textModels, simple_models: simpleModels,
        image_models: imageModels, image_models_simple: imageModelsSimple, special_tags: specialTags,
        suno_base_prompt: sunoBasePrompt, suno_reference_examples: referenceExamples, suno_wish_library: wishLibrary,
        request_timeout_seconds: requestTimeoutSeconds,
        scene_base_prompt_narrative: sceneBasePromptNarrative, scene_base_prompt_abstract: sceneBasePromptAbstract,
        scene_wish_library: sceneWishLibrary, hide_motion_prompt: hideMotionPrompt,
        title_card_base_prompt: titleCardBasePrompt, title_card_base_prompt_presets: titleCardBasePromptPresets,
        background_remover_params: backgroundRemoverParams, background_remover_method: backgroundRemoverMethod,
        background_remover_local_params: backgroundRemoverLocalParams, background_remover_fal_params: backgroundRemoverFalParams,
        outpaint_quality_mode: outpaintQualityMode, music_tags: musicTags,
        suno_base_prompt_user_presets: sunoBasePromptUserPresets, mureka_base_prompt_user_presets: murekaBasePromptUserPresets,
      });
      showToast(L.toast_saved);
    } catch {
      showToast('Не удалось сохранить настройки');
    }
  }

  return {
    lang, L, langLabel: lang === 'ru' ? 'EN' : 'RU',
    apiKeys, textModels, simpleModels, imageModels, imageModelsSimple, specialTags,
    sunoBasePrompt, referenceExamples, wishLibrary, sunoPromptPresets, requestTimeoutSeconds,
    sceneBasePromptNarrative, sceneBasePromptAbstract, sceneWishLibrary, hideMotionPrompt,
    titleCardBasePrompt, titleCardBasePromptPresets, titleCardWishLibrary,
    backgroundRemoverParams, backgroundRemoverMethod, backgroundRemoverLocalParams, backgroundRemoverFalParams,
    outpaintQualityMode,
    logos, setLogos, posterTemplates, musicTags,
    sunoBasePromptUserPresets, murekaBasePromptUserPresets,
    toggleLang: () => setLang((l) => (l === 'ru' ? 'en' : 'ru')),
    actions: {
      setLangRu: () => setLang('ru'), setLangEn: () => setLang('en'), setRequestTimeoutSeconds,
      setBackgroundRemoverParam, setBackgroundRemoverMethod, setBackgroundRemoverLocalParam, setBackgroundRemoverFalParam,
      setOutpaintQualityMode,
      uploadLogo, deleteLogo,
      setApiKey, onSave: saveSettings, importApiKeys, importGeneralSettings, setHideMotionPrompt,
      addSpecialTag, removeSpecialTag, updateSpecialTag, setSunoBasePrompt, updateSunoBasePrompt,
      addReferenceExample, removeReferenceExample, updateReferenceExample, saveWishToLibrary, removeWishSnippet, updateWishSnippet, setWishLibrary,
      addTextModelFavorite, removeTextModelFavorite, setTextModelDefault,
      addSimpleModelFavorite, removeSimpleModelFavorite, setSimpleModelDefault,
      addImageModelFavorite, removeImageModelFavorite, setImageModelDefault,
      addImageModelSimpleFavorite, removeImageModelSimpleFavorite, setImageModelSimpleDefault,
      updateSceneBasePromptNarrative, updateSceneBasePromptAbstract,
      saveSceneWishToLibrary, removeSceneWishSnippet, updateSceneWishSnippet, setSceneWishLibrary,
      updateTitleCardBasePrompt, saveTitleCardBasePromptPreset, loadTitleCardBasePromptPreset, deleteTitleCardBasePromptPreset,
      setTitleCardWishLibrary, removeTitleCardWishSnippet,
      bumpWishUse, bumpSceneWishUse, bumpTitleCardWishUse,
      savePosterTemplate, deletePosterTemplate,
      addMusicTag, removeMusicTag, updateMusicTag,
      saveSunoBasePromptUserPreset, updateSunoBasePromptUserPreset, deleteSunoBasePromptUserPreset,
      saveMurekaBasePromptUserPreset, updateMurekaBasePromptUserPreset, deleteMurekaBasePromptUserPreset,
    },
  };
}
