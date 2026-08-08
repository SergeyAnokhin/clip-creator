import { describe, expect, it } from 'vitest';
import { currentLineIndex, flattenLyricsLines, interpolateSectionLines, isBeyondKnownTiming } from './lyricsTiming.js';

const RAW = {
  lyrics_sections: [
    { section_type: 'intro' }, // no `lines`, no `start`/`end` at all - nothing to show
    {
      section_type: 'verse',
      lines: [
        { start: 600, end: 13360, text: 'Line one', words: [] },
        { start: 13640, end: 20360, text: 'Line two', words: [] },
      ],
    },
  ],
};

describe('interpolateSectionLines', () => {
  it('leaves fully-timed lines untouched', () => {
    const section = { start: 0, end: 20000, lines: [{ start: 100, end: 200, text: 'a' }] };
    expect(interpolateSectionLines(section)).toEqual([{ start: 100, end: 200, text: 'a' }]);
  });

  it('spreads an untimed run across the gap between its timed neighbours, weighted by length', () => {
    const section = {
      start: 0, end: 1000,
      lines: [
        { start: 0, end: 100, text: 'first' },
        { text: 'ab' }, // 2 chars
        { text: 'abcd' }, // 4 chars -> gets 2x the share of 'ab'
        { start: 900, end: 1000, text: 'last' },
      ],
    };
    const result = interpolateSectionLines(section);
    expect(result[1]).toMatchObject({ text: 'ab', start: 100, interpolated: true });
    expect(result[2]).toMatchObject({ text: 'abcd', interpolated: true });
    expect(result[2].start).toBe(result[1].end);
    expect(result[2].end).toBe(900);
    // 'abcd' (4 chars) should span twice as long as 'ab' (2 chars)
    expect(result[2].end - result[2].start).toBeCloseTo(2 * (result[1].end - result[1].start), -1);
  });

  it('interpolates a leading run against the section start when there is no earlier line', () => {
    const section = { start: 500, end: 1000, lines: [{ text: 'lead-in' }, { start: 800, end: 1000, text: 'anchor' }] };
    const [lead] = interpolateSectionLines(section);
    expect(lead.start).toBe(500);
    expect(lead.end).toBe(800);
  });

  it('cannot interpolate without any bounds and leaves the line untimed', () => {
    const section = { lines: [{ text: 'no bounds anywhere' }] };
    expect(interpolateSectionLines(section)).toEqual([{ text: 'no bounds anywhere' }]);
  });

  it('handles a section with no lines', () => {
    expect(interpolateSectionLines({})).toEqual([]);
  });
});

describe('flattenLyricsLines', () => {
  it('keeps timed lines in order, dropping a section with no timing at all', () => {
    expect(flattenLyricsLines(RAW)).toEqual([
      { text: 'Line one', start: 600, end: 13360, words: [], sectionType: 'verse', isSection: false, interpolated: false },
      { text: 'Line two', start: 13640, end: 20360, words: [], sectionType: 'verse', isSection: false, interpolated: false },
    ]);
  });

  it('handles a track with no lyrics_sections', () => {
    expect(flattenLyricsLines({})).toEqual([]);
    expect(flattenLyricsLines(undefined)).toEqual([]);
  });

  it('surfaces a lines-less but timed section (e.g. an instrumental intro) as a marker row', () => {
    const raw = {
      lyrics_sections: [
        { section_type: 'intro', start: 0, end: 8000 },
        { section_type: 'verse', lines: [{ start: 8000, end: 12000, text: 'First verse line', words: [] }] },
      ],
    };
    expect(flattenLyricsLines(raw)).toEqual([
      { text: null, start: 0, end: 8000, words: [], sectionType: 'intro', isSection: true, interpolated: false },
      { text: 'First verse line', start: 8000, end: 12000, words: [], sectionType: 'verse', isSection: false, interpolated: false },
    ]);
  });

  it('fills in a partially-timed section instead of dropping the untimed lines', () => {
    const raw = {
      lyrics_sections: [{
        section_type: 'verse', start: 0, end: 1000,
        lines: [{ text: 'untimed opener' }, { start: 500, end: 1000, text: 'timed closer' }],
      }],
    };
    const rows = flattenLyricsLines(raw);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ text: 'untimed opener', start: 0, end: 500, interpolated: true });
    expect(rows[1]).toMatchObject({ text: 'timed closer', start: 500, end: 1000, interpolated: false });
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

describe('isBeyondKnownTiming', () => {
  const lines = flattenLyricsLines(RAW);

  it('is false with no lines at all', () => {
    expect(isBeyondKnownTiming([], 999999)).toBe(false);
  });

  it('is false while still within or before the last known line', () => {
    expect(isBeyondKnownTiming(lines, 0)).toBe(false);
    expect(isBeyondKnownTiming(lines, 20360)).toBe(false);
  });

  it('is true once playback passes the last known line\'s end - Mureka can stop timing well before the track actually ends', () => {
    expect(isBeyondKnownTiming(lines, 20361)).toBe(true);
  });
});
