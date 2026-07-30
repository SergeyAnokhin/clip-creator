import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { DICT } from '../i18n/dict.js';

const DEFAULT_SPECIAL_TAGS = ['[Vocal Interlude]', '[Female vocal interlude]'];

/** App settings (language, API keys, default models, Suno meta-tags), loaded
 * from the backend on mount. Owns `lang`, and therefore the `L` dictionary
 * every other hook uses for toast copy. */
export function useSettings({ showToast }) {
  const [lang, setLang] = useState('ru');
  const [apiKeys, setApiKeys] = useState({ openai: '', anthropic: '', deepseek: '', replicate: '' });
  const [textModelDefault, setTextModelDefault] = useState('claude');
  const [imageModelDefault, setImageModelDefault] = useState('flux');
  const [specialTags, setSpecialTags] = useState(DEFAULT_SPECIAL_TAGS);

  useEffect(() => {
    api.getSettings().then((s) => {
      setLang(s.lang || 'ru');
      setApiKeys(s.api_keys || {});
      setTextModelDefault(s.text_model_default || 'claude');
      setImageModelDefault(s.image_model_default || 'flux');
      setSpecialTags(s.special_tags || DEFAULT_SPECIAL_TAGS);
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
  async function saveSettings() {
    try {
      await api.putSettings({
        lang, api_keys: apiKeys, text_model_default: textModelDefault, image_model_default: imageModelDefault,
        special_tags: specialTags,
      });
      showToast(L.toast_saved);
    } catch {
      showToast('Не удалось сохранить настройки');
    }
  }

  return {
    lang, L, langLabel: lang === 'ru' ? 'EN' : 'RU',
    apiKeys, textModelDefault, imageModelDefault, specialTags,
    toggleLang: () => setLang((l) => (l === 'ru' ? 'en' : 'ru')),
    actions: {
      setLangRu: () => setLang('ru'), setLangEn: () => setLang('en'),
      setApiKey, setTextModelDefault, setImageModelDefault, onSave: saveSettings,
      addSpecialTag, removeSpecialTag,
    },
  };
}
