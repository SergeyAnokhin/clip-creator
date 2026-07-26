import { describe, expect, it } from 'vitest';
import { compileLyrics, formatLyrics, moveBlock, splitBlockAtLine } from './lyrics.js';

const blocks = [
  { id: 'b1', type: 'intro', content: 'Intro text' },
  { id: 'b2', type: 'verse', content: 'Verse one' },
  { id: 'b3', type: 'chorus', content: 'Chorus text' },
  { id: 'b4', type: 'verse', content: 'Verse two' },
  { id: 'b5', type: 'bridge', content: 'Bridge text' },
  { id: 'b6', type: 'outro', content: 'Outro text' },
];

describe('compileLyrics', () => {
  it('keeps original order when auto-repeat is off', () => {
    expect(compileLyrics(blocks, false)).toEqual(
      blocks.map((b) => ({ type: b.type, content: b.content })),
    );
  });

  it('re-inserts the chorus after every verse when auto-repeat is on', () => {
    const result = compileLyrics(blocks, true);
    expect(result.map((s) => s.type)).toEqual([
      'intro', 'verse', 'chorus', 'verse', 'chorus', 'bridge', 'outro',
    ]);
    expect(result.filter((s) => s.type === 'chorus')).toHaveLength(2);
    expect(result.filter((s) => s.type === 'chorus').every((s) => s.content === 'Chorus text')).toBe(true);
  });

  it('is a no-op when there is no chorus block', () => {
    const noChorus = blocks.filter((b) => b.type !== 'chorus');
    expect(compileLyrics(noChorus, true)).toEqual(
      noChorus.map((b) => ({ type: b.type, content: b.content })),
    );
  });

  it('is a no-op when there are no verse blocks to attach to', () => {
    const noVerse = blocks.filter((b) => b.type !== 'verse');
    expect(compileLyrics(noVerse, true)).toEqual(
      noVerse.map((b) => ({ type: b.type, content: b.content })),
    );
  });
});

describe('formatLyrics', () => {
  it('brackets the type label and joins segments with a blank line', () => {
    const segments = [
      { type: 'intro', content: 'A' },
      { type: 'chorus', content: 'B' },
    ];
    expect(formatLyrics(segments, (t) => t.toUpperCase())).toBe('[INTRO]\nA\n\n[CHORUS]\nB');
  });
});

describe('moveBlock', () => {
  it('swaps with the previous block when moving up', () => {
    const result = moveBlock(blocks, 'b3', -1);
    expect(result.map((b) => b.id)).toEqual(['b1', 'b3', 'b2', 'b4', 'b5', 'b6']);
  });

  it('swaps with the next block when moving down', () => {
    const result = moveBlock(blocks, 'b1', 1);
    expect(result.map((b) => b.id)).toEqual(['b2', 'b1', 'b3', 'b4', 'b5', 'b6']);
  });

  it('clamps at the start of the array', () => {
    expect(moveBlock(blocks, 'b1', -1)).toEqual(blocks);
  });

  it('clamps at the end of the array', () => {
    expect(moveBlock(blocks, 'b6', 1)).toEqual(blocks);
  });

  it('returns the input unchanged for an unknown id', () => {
    expect(moveBlock(blocks, 'missing', 1)).toEqual(blocks);
  });
});

describe('splitBlockAtLine', () => {
  const multiline = [
    { id: 'b1', type: 'verse', importance: 4, content: 'Line one\nLine two\nLine three' },
    { id: 'b2', type: 'chorus', content: 'Other block' },
  ];

  it('splits a block into two at the given line, keeping type and importance', () => {
    const result = splitBlockAtLine(multiline, 'b1', 2, 'new-id');
    expect(result.map((b) => b.id)).toEqual(['b1', 'new-id', 'b2']);
    expect(result[0]).toMatchObject({ type: 'verse', importance: 4, content: 'Line one\nLine two' });
    expect(result[1]).toMatchObject({ type: 'verse', importance: 4, content: 'Line three' });
  });

  it('is a no-op for a line index at the start of the block', () => {
    expect(splitBlockAtLine(multiline, 'b1', 0, 'new-id')).toEqual(multiline);
  });

  it('is a no-op for a line index at or past the end of the block', () => {
    expect(splitBlockAtLine(multiline, 'b1', 3, 'new-id')).toEqual(multiline);
    expect(splitBlockAtLine(multiline, 'b1', 5, 'new-id')).toEqual(multiline);
  });

  it('returns the input unchanged for an unknown id', () => {
    expect(splitBlockAtLine(multiline, 'missing', 1, 'new-id')).toEqual(multiline);
  });
});
