import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { DICT } from '../i18n/dict.js';
import { readJSONFile } from '../lib/download.js';
import { debounce } from '../lib/debounce.js';

const DEFAULT_SPECIAL_TAGS = ['[Vocal Interlude]', '[Female vocal interlude]'];
const DEFAULT_TEXT_MODELS = { favorites: [], default: 'google:gemini-2.5-flash' };
const DEFAULT_SIMPLE_MODELS = { favorites: [], default: '' };
const DEFAULT_IMAGE_MODELS = { favorites: [], default: '' };
const DEFAULT_IMAGE_MODELS_SIMPLE = { favorites: [], default: '' };

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
  const [hideMotionPrompt, setHideMotionPromptState] = useState(false);

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
      setHideMotionPromptState(s.hide_motion_prompt || false);
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

  // Shared Scenes/Images-stage UI toggle (hide motion_prompt fields) -
  // persisted like updateSunoBasePrompt so it applies immediately and
  // survives a reload, but it's a single boolean flip, not a debounced text
  // field, so it saves right away instead of on a timer.
  function setHideMotionPrompt(value) {
    setHideMotionPromptState(value);
    api.putSettings({ hide_motion_prompt: value }).catch(() => {});
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
      await api.putSettings(next);
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
    toggleLang: () => setLang((l) => (l === 'ru' ? 'en' : 'ru')),
    actions: {
      setLangRu: () => setLang('ru'), setLangEn: () => setLang('en'), setRequestTimeoutSeconds,
      setApiKey, onSave: saveSettings, importApiKeys, importGeneralSettings, setHideMotionPrompt,
      addSpecialTag, removeSpecialTag, updateSpecialTag, setSunoBasePrompt, updateSunoBasePrompt,
      addReferenceExample, removeReferenceExample, updateReferenceExample, saveWishToLibrary, removeWishSnippet, updateWishSnippet, setWishLibrary,
      addTextModelFavorite, removeTextModelFavorite, setTextModelDefault,
      addSimpleModelFavorite, removeSimpleModelFavorite, setSimpleModelDefault,
      addImageModelFavorite, removeImageModelFavorite, setImageModelDefault,
      addImageModelSimpleFavorite, removeImageModelSimpleFavorite, setImageModelSimpleDefault,
      updateSceneBasePromptNarrative, updateSceneBasePromptAbstract,
      saveSceneWishToLibrary, removeSceneWishSnippet, updateSceneWishSnippet, setSceneWishLibrary,
    },
  };
}
