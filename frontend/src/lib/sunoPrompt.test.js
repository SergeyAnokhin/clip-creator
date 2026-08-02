import { describe, expect, it } from 'vitest';
import { buildSunoPromptPreview } from './sunoPrompt.js';

const blocks = [
  { id: 'b1', type: 'intro', importance: 3, content: 'Line one' },
  { id: 'b2', type: 'interlude', importance: 3, content: '[Vocal Interlude]' },
  { id: 'b3', type: 'verse', importance: 3, content: 'Line two' },
];

describe('buildSunoPromptPreview', () => {
  it('joins base prompt, examples and skill prompt, then appends lyrics and the response-format footer', () => {
    const text = buildSunoPromptPreview({
      basePrompt: 'BASE', examples: ['Example one'], skillPrompt: 'SKILL', blocks,
    });

    expect(text).toBe(
      'BASE\n\n'
      + 'Эталонные примеры адаптации (ориентир по тону и формату, не копировать дословно):\n\nПример 1:\nExample one\n\n'
      + 'SKILL\n\n---\n'
      + 'Исходная структурированная лирика для адаптации:\n[Intro]\nLine one\n\n[Vocal Interlude]\n\n[Verse]\nLine two\n\n'
      + 'Ответь СТРОГО в этом формате, без какого-либо текста до или после:\n'
      + '===STYLE===\n<style-block здесь>\n===LYRICS===\n<lyrics-markup здесь>',
    );
  });

  it('skips empty parts instead of leaving blank lines', () => {
    const text = buildSunoPromptPreview({ basePrompt: 'BASE', examples: [], skillPrompt: '', blocks: [] });
    expect(text.startsWith('BASE\n\n---\n')).toBe(true);
  });

  it('title-cases unknown block types not in the fixed label map', () => {
    const text = buildSunoPromptPreview({
      basePrompt: '', examples: [], skillPrompt: '',
      blocks: [{ id: 'b1', type: 'prechorus', importance: 3, content: 'X' }],
    });
    expect(text).toContain('[Prechorus]\nX');
  });

  it('places active wishes in a marked block right after the base prompt', () => {
    const text = buildSunoPromptPreview({
      basePrompt: 'BASE', examples: ['Example one'], skillPrompt: 'SKILL', blocks: [],
      activeWishes: ['Больше саксофона', 'Женский бэк-вокал'],
    });

    expect(text).toContain('ВАЖНЫЕ ТРЕБОВАНИЯ ПОЛЬЗОВАТЕЛЯ');
    expect(text).toContain('1. Больше саксофона');
    expect(text).toContain('2. Женский бэк-вокал');
    expect(text.indexOf('BASE')).toBeLessThan(text.indexOf('ВАЖНЫЕ ТРЕБОВАНИЯ'));
    expect(text.indexOf('ВАЖНЫЕ ТРЕБОВАНИЯ')).toBeLessThan(text.indexOf('Пример 1'));
  });

  it('omits the wishes block when no wish is active', () => {
    const text = buildSunoPromptPreview({ basePrompt: 'BASE', examples: [], skillPrompt: '', blocks: [], activeWishes: [] });
    expect(text).not.toContain('ВАЖНЫЕ ТРЕБОВАНИЯ');
  });
});
