import { compileLyrics, formatLyrics } from './lyrics.js';

/** Mirrors backend/app/providers/suno.py's _TYPE_LABELS - the labels the
 * server actually sends are fixed English strings regardless of UI language,
 * so this must not read from the i18n dict. Keep in sync if suno.py changes. */
const TYPE_LABELS = { intro: 'Intro', verse: 'Verse', chorus: 'Chorus', bridge: 'Bridge', outro: 'Outro' };
function typeLabel(type) {
  if (TYPE_LABELS[type]) return TYPE_LABELS[type];
  return type ? type.charAt(0).toUpperCase() + type.slice(1) : '';
}

const STYLE_MARKER = '===STYLE===';
const LYRICS_MARKER = '===LYRICS===';

/** Client-side mirror of backend/app/providers/suno.py's _format_lyrics() +
 * _build_gemini_prompt() - used only to show the user what the next
 * "Сгенерировать для Suno" call will actually send. The backend always
 * re-assembles the real prompt itself from persisted settings/project state
 * at request time; this preview can drift from it if either side changes
 * without updating the other. */
export function buildSunoPromptPreview({ basePrompt, examples, skillPrompt, blocks, activeWishes }) {
  const rawLyrics = formatLyrics(compileLyrics(blocks || []), typeLabel);

  let examplesBlock = '';
  if (examples?.length) {
    const labeled = examples.map((ex, i) => `Пример ${i + 1}:\n${ex}`);
    examplesBlock = 'Эталонные примеры адаптации (ориентир по тону и формату, не копировать дословно):\n\n'
      + labeled.join('\n\n---\n\n');
  }

  let wishesBlock = '';
  if (activeWishes?.length) {
    const items = activeWishes.map((w, i) => `${i + 1}. ${w}`).join('\n');
    wishesBlock = 'ВАЖНЫЕ ТРЕБОВАНИЯ ПОЛЬЗОВАТЕЛЯ — обязательно учесть:\n' + items;
  }

  const instructions = [basePrompt, wishesBlock, examplesBlock, skillPrompt]
    .filter((part) => (part || '').trim())
    .join('\n\n');

  return `${instructions}\n\n---\n`
    + `Исходная структурированная лирика для адаптации:\n${rawLyrics}\n\n`
    + 'Ответь СТРОГО в этом формате, без какого-либо текста до или после:\n'
    + `${STYLE_MARKER}\n<style-block здесь>\n${LYRICS_MARKER}\n<lyrics-markup здесь>`;
}

/** Groups base-prompt presets (from GET /api/settings/suno-prompt-presets) by
 * their `service` field (e.g. "Suno", "Mureka") for display, preserving the
 * order services first appear in. */
export function groupPresetsByService(presets) {
  const groups = new Map();
  for (const preset of presets) {
    const service = preset.service || '';
    if (!groups.has(service)) groups.set(service, []);
    groups.get(service).push(preset);
  }
  return [...groups.entries()];
}
