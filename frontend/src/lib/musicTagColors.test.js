import { describe, expect, it } from 'vitest';
import { MUSIC_TAG_COLORS, nextMusicTagColor, pickReadableTextColor } from './musicTagColors.js';

describe('nextMusicTagColor', () => {
  it('cycles through the palette by count', () => {
    expect(nextMusicTagColor(0)).toBe(MUSIC_TAG_COLORS[0]);
    expect(nextMusicTagColor(1)).toBe(MUSIC_TAG_COLORS[1]);
    expect(nextMusicTagColor(MUSIC_TAG_COLORS.length)).toBe(MUSIC_TAG_COLORS[0]);
  });

  it('treats missing count as 0', () => {
    expect(nextMusicTagColor()).toBe(MUSIC_TAG_COLORS[0]);
  });
});

describe('pickReadableTextColor', () => {
  it('picks dark text on light backgrounds', () => {
    expect(pickReadableTextColor('#fbbf24')).toBe('#111');
  });

  it('picks light text on dark backgrounds', () => {
    expect(pickReadableTextColor('#1e293b')).toBe('#fff');
  });

  it('falls back safely on a malformed hex', () => {
    expect(pickReadableTextColor('')).toBe('#111');
    expect(pickReadableTextColor('not-a-color')).toBe('#111');
  });
});
