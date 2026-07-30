import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { DICT } from '../i18n/dict.js';

const DEFAULT_SPECIAL_TAGS = ['[Vocal Interlude]', '[Female vocal interlude]'];
const DEFAULT_TEXT_MODELS = { favorites: [], default: 'google:gemini-2.5-flash' };
const DEFAULT_SIMPLE_MODELS = { favorites: [], default: '' };
const DEFAULT_IMAGE_MODELS = { favorites: [], default: '' };

/** App settings (language, API keys, default models, Suno meta-tags), loaded
 * from the backend on mount. Owns `lang`, and therefore the `L` dictionary
 * every other hook uses for toast copy. */
export function useSettings({ showToast }) {
  const [lang, setLang] = useState('ru');
  const [apiKeys, setApiKeys] = useState({ replicate: '', google: '', fal: '', openrouter: '', krea: '' });
  const [textModels, setTextModels] = useState(DEFAULT_TEXT_MODELS);
  const [simpleModels, setSimpleModels] = useState(DEFAULT_SIMPLE_MODELS);
  const [imageModels, setImageModels] = useState(DEFAULT_IMAGE_MODELS);
  const [specialTags, setSpecialTags] = useState(DEFAULT_SPECIAL_TAGS);
  const [sunoBasePrompt, setSunoBasePrompt] = useState('');
  const [referenceExamples, setReferenceExamples] = useState([]);
  const [wishLibrary, setWishLibrary] = useState([]);

  useEffect(() => {
    api.getSettings().then((s) => {
      setLang(s.lang || 'ru');
      setApiKeys(s.api_keys || {});
      setTextModels(s.text_models || DEFAULT_TEXT_MODELS);
      setSimpleModels(s.simple_models || DEFAULT_SIMPLE_MODELS);
      setImageModels(s.image_models || DEFAULT_IMAGE_MODELS);
      setSpecialTags(s.special_tags || DEFAULT_SPECIAL_TAGS);
      setSunoBasePrompt(s.suno_base_prompt || '');
      setReferenceExamples(s.suno_reference_examples || []);
      setWishLibrary(s.suno_wish_library || []);
    }).catch(() => {});
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
  function addReferenceExample(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setReferenceExamples((prev) => [...prev, trimmed]);
  }
  function removeReferenceExample(index) {
    setReferenceExamples((prev) => prev.filter((_, i) => i !== index));
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
      .catch(() => {});
  }
  async function saveSettings() {
    try {
      await api.putSettings({
        lang, api_keys: apiKeys, text_models: textModels, simple_models: simpleModels,
        image_models: imageModels, special_tags: specialTags, suno_base_prompt: sunoBasePrompt,
        suno_reference_examples: referenceExamples, suno_wish_library: wishLibrary,
      });
      showToast(L.toast_saved);
    } catch {
      showToast('Не удалось сохранить настройки');
    }
  }

  return {
    lang, L, langLabel: lang === 'ru' ? 'EN' : 'RU',
    apiKeys, textModels, simpleModels, imageModels, specialTags,
    sunoBasePrompt, referenceExamples, wishLibrary,
    toggleLang: () => setLang((l) => (l === 'ru' ? 'en' : 'ru')),
    actions: {
      setLangRu: () => setLang('ru'), setLangEn: () => setLang('en'),
      setApiKey, onSave: saveSettings,
      addSpecialTag, removeSpecialTag, setSunoBasePrompt,
      addReferenceExample, removeReferenceExample, saveWishToLibrary, removeWishSnippet,
      addTextModelFavorite, removeTextModelFavorite, setTextModelDefault,
      addSimpleModelFavorite, removeSimpleModelFavorite, setSimpleModelDefault,
      addImageModelFavorite, removeImageModelFavorite, setImageModelDefault,
    },
  };
}
