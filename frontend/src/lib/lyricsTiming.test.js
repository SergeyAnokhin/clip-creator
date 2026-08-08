import { describe, expect, it } from 'vitest';
import { currentLineIndex, flattenLyricsLines } from './lyricsTiming.js';

const RAW = {
  lyrics_sections: [
    { section_type: 'intro' }, // no `lines` at all - dropped
    {
      section_type: 'verse',
      lines: [
        { start: 600, end: 13360, text: 'Line one', words: [] },
        { text: 'No timing - dropped' },
        { start: 13640, end: 20360, text: 'Line two', words: [] },
      ],
    },
  ],
};

describe('flattenLyricsLines', () => {
  it('keeps only timed lines, in order', () => {
    expect(flattenLyricsLines(RAW)).toEqual([
      { text: 'Line one', start: 600, end: 13360, words: [] },
      { text: 'Line two', start: 13640, end: 20360, words: [] },
    ]);
  });

  it('handles a track with no lyrics_sections', () => {
    expect(flattenLyricsLines({})).toEqual([]);
    expect(flattenLyricsLines(undefined)).toEqual([]);
  });
});

describe('currentLineIndex', () => {
  const lines = flattenLyricsLines(RAW);

  it('is -1 before the first line starts', () => {
    expect(currentLineIndex(lines, 0)).toBe(-1);
  });

  it('picks the active line', () => {
    expect(currentLineIndex(lines, 700)).toBe(0);
  });

  it('holds the previous line during a gap between lines', () => {
    expect(currentLineIndex(lines, 13500)).toBe(0);
  });

  it('picks the last line once it starts', () => {
    expect(currentLineIndex(lines, 999999)).toBe(1);
  });
});
