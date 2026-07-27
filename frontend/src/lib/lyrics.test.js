import { describe, expect, it } from 'vitest';
import {
  cloneBlockWithType, compileLyrics, deleteLine, duplicateLine, formatLyrics, insertBlockAdjacent, moveBlock,
  moveBlockToEdge, moveToEdgeForType, repeatChorusAfterVerses, setLine, splitBlockAtLine, splitBlockEveryN,
  toggleLineBrackets,
} from './lyrics.js';

const blocks = [
  { id: 'b1', type: 'intro', importance: 3, content: 'Intro text' },
  { id: 'b2', type: 'verse', importance: 3, content: 'Verse one' },
  { id: 'b3', type: 'chorus', importance: 3, content: 'Chorus text' },
  { id: 'b4', type: 'verse', importance: 3, content: 'Verse two' },
  { id: 'b5', type: 'bridge', importance: 3, content: 'Bridge text' },
  { id: 'b6', type: 'outro', importance: 3, content: 'Outro text' },
];

describe('compileLyrics', () => {
  it('maps blocks to type/content segments in order', () => {
    expect(compileLyrics(blocks)).toEqual(
      blocks.map((b) => ({ type: b.type, content: b.content })),
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

describe('toggleLineBrackets', () => {
  const content = 'First line\nSecond line\nThird line';

  it('wraps an unwrapped line in round brackets', () => {
    expect(toggleLineBrackets(content, 1)).toBe('First line\n(Second line)\nThird line');
  });

  it('unwraps an already-wrapped line (round trip)', () => {
    const wrapped = toggleLineBrackets(content, 1);
    expect(toggleLineBrackets(wrapped, 1)).toBe(content);
  });

  it('leaves other lines untouched', () => {
    const result = toggleLineBrackets(content, 0);
    expect(result.split('\n')[1]).toBe('Second line');
    expect(result.split('\n')[2]).toBe('Third line');
  });

  it('is a no-op for an out-of-range line index', () => {
    expect(toggleLineBrackets(content, 5)).toBe(content);
    expect(toggleLineBrackets(content, -1)).toBe(content);
  });
});

describe('duplicateLine', () => {
  const content = 'First line\nSecond line\nThird line';

  it('inserts a copy of the line right after itself', () => {
    expect(duplicateLine(content, 1)).toBe('First line\nSecond line\nSecond line\nThird line');
  });

  it('duplicates the last line at the end', () => {
    expect(duplicateLine(content, 2)).toBe('First line\nSecond line\nThird line\nThird line');
  });

  it('is a no-op for an out-of-range line index', () => {
    expect(duplicateLine(content, 5)).toBe(content);
    expect(duplicateLine(content, -1)).toBe(content);
  });
});

describe('deleteLine', () => {
  const content = 'First line\nSecond line\nThird line';

  it('removes the line at the given index', () => {
    expect(deleteLine(content, 1)).toBe('First line\nThird line');
  });

  it('removes the last line', () => {
    expect(deleteLine(content, 2)).toBe('First line\nSecond line');
  });

  it('is a no-op for an out-of-range line index', () => {
    expect(deleteLine(content, 5)).toBe(content);
    expect(deleteLine(content, -1)).toBe(content);
  });
});

describe('setLine', () => {
  const content = 'First line\nSecond line\nThird line';

  it('replaces the text of the given line', () => {
    expect(setLine(content, 1, 'Changed')).toBe('First line\nChanged\nThird line');
  });

  it('is a no-op for an out-of-range line index', () => {
    expect(setLine(content, 5, 'x')).toBe(content);
    expect(setLine(content, -1, 'x')).toBe(content);
  });
});

describe('moveBlockToEdge', () => {
  it('moves the block to the start', () => {
    expect(moveBlockToEdge(blocks, 'b5', 'start').map((b) => b.id)).toEqual(
      ['b5', 'b1', 'b2', 'b3', 'b4', 'b6'],
    );
  });

  it('moves the block to the end', () => {
    expect(moveBlockToEdge(blocks, 'b2', 'end').map((b) => b.id)).toEqual(
      ['b1', 'b3', 'b4', 'b5', 'b6', 'b2'],
    );
  });

  it('is a no-op for an unrecognized edge', () => {
    expect(moveBlockToEdge(blocks, 'b2', 'middle')).toEqual(blocks);
  });

  it('returns the input unchanged for an unknown id', () => {
    expect(moveBlockToEdge(blocks, 'missing', 'start')).toEqual(blocks);
  });
});

describe('moveToEdgeForType', () => {
  it('moves the block to the start for intro', () => {
    expect(moveToEdgeForType(blocks, 'b5', 'intro').map((b) => b.id)).toEqual(
      ['b5', 'b1', 'b2', 'b3', 'b4', 'b6'],
    );
  });

  it('moves the block to the end for outro', () => {
    expect(moveToEdgeForType(blocks, 'b2', 'outro').map((b) => b.id)).toEqual(
      ['b1', 'b3', 'b4', 'b5', 'b6', 'b2'],
    );
  });

  it('is a no-op for any other type', () => {
    expect(moveToEdgeForType(blocks, 'b5', 'verse')).toEqual(blocks);
  });

  it('returns the input unchanged for an unknown id', () => {
    expect(moveToEdgeForType(blocks, 'missing', 'intro')).toEqual(blocks);
  });
});

describe('cloneBlockWithType', () => {
  it('inserts a clone right after the original with the new type, original unchanged', () => {
    const result = cloneBlockWithType(blocks, 'b2', 'bridge', 'new-id');
    expect(result.map((b) => b.id)).toEqual(['b1', 'b2', 'new-id', 'b3', 'b4', 'b5', 'b6']);
    expect(result.find((b) => b.id === 'b2').type).toBe('verse');
    expect(result.find((b) => b.id === 'new-id')).toMatchObject({ type: 'bridge', importance: 3, content: 'Verse one' });
  });

  it('jumps the clone to the start when cloned as intro', () => {
    const result = cloneBlockWithType(blocks, 'b4', 'intro', 'new-id');
    expect(result.map((b) => b.id)).toEqual(['new-id', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6']);
  });

  it('jumps the clone to the end when cloned as outro', () => {
    const result = cloneBlockWithType(blocks, 'b2', 'outro', 'new-id');
    expect(result.map((b) => b.id)).toEqual(['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'new-id']);
  });

  it('returns the input unchanged for an unknown id', () => {
    expect(cloneBlockWithType(blocks, 'missing', 'bridge', 'new-id')).toEqual(blocks);
  });
});

describe('repeatChorusAfterVerses', () => {
  it('inserts a chorus clone after every verse, leaving existing blocks in place', () => {
    let n = 0;
    const result = repeatChorusAfterVerses(blocks, () => `chorus-${n++}`);
    expect(result.map((b) => b.type)).toEqual([
      'intro', 'verse', 'chorus', 'chorus', 'verse', 'chorus', 'bridge', 'outro',
    ]);
    const clones = result.filter((b) => b.id.startsWith('chorus-'));
    expect(clones).toHaveLength(2);
    expect(clones.every((b) => b.content === 'Chorus text' && b.type === 'chorus')).toBe(true);
  });

  it('is a no-op when there is no chorus block', () => {
    const noChorus = blocks.filter((b) => b.type !== 'chorus');
    expect(repeatChorusAfterVerses(noChorus, () => 'x')).toEqual(noChorus);
  });

  it('is a no-op when there are no verse blocks', () => {
    const noVerse = blocks.filter((b) => b.type !== 'verse');
    expect(repeatChorusAfterVerses(noVerse, () => 'x')).toEqual(noVerse);
  });

  it('is not idempotent - calling twice inserts two sets of clones', () => {
    let n = 0;
    const once = repeatChorusAfterVerses(blocks, () => `c${n++}`);
    const twice = repeatChorusAfterVerses(once, () => `c${n++}`);
    expect(twice.filter((b) => b.type === 'chorus')).toHaveLength(5); // 1 original + 2 + 2
  });
});

describe('splitBlockEveryN', () => {
  const single = [
    { id: 'only', type: 'verse', importance: 4, content: 'L1\nL2\nL3\nL4\nL5\nL6' },
  ];

  it('splits into even groups, keeping the original id on the first group', () => {
    let n = 0;
    const result = splitBlockEveryN(single, 'only', 2, () => `new-${n++}`);
    expect(result.map((b) => b.id)).toEqual(['only', 'new-0', 'new-1']);
    expect(result.map((b) => b.content)).toEqual(['L1\nL2', 'L3\nL4', 'L5\nL6']);
    expect(result.every((b) => b.type === 'verse' && b.importance === 4)).toBe(true);
  });

  it('leaves a shorter remainder in the last group', () => {
    let n = 0;
    const result = splitBlockEveryN(single, 'only', 4, () => `new-${n++}`);
    expect(result.map((b) => b.content)).toEqual(['L1\nL2\nL3\nL4', 'L5\nL6']);
  });

  it('produces a single unchanged-content block when n is larger than the line count', () => {
    const result = splitBlockEveryN(single, 'only', 10, () => 'unused');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'only', content: single[0].content });
  });

  it('is a no-op when n is less than 2', () => {
    expect(splitBlockEveryN(single, 'only', 1, () => 'unused')).toEqual(single);
  });

  it('returns the input unchanged for an unknown id', () => {
    expect(splitBlockEveryN(single, 'missing', 2, () => 'unused')).toEqual(single);
  });
});

describe('insertBlockAdjacent', () => {
  it('inserts a new block immediately before the target', () => {
    const result = insertBlockAdjacent(blocks, 'b3', 'interlude', '[Vocal Interlude]', 'before', 'tag-id');
    expect(result.map((b) => b.id)).toEqual(['b1', 'b2', 'tag-id', 'b3', 'b4', 'b5', 'b6']);
    expect(result.find((b) => b.id === 'tag-id')).toMatchObject({ type: 'interlude', content: '[Vocal Interlude]' });
  });

  it('inserts a new block immediately after the target', () => {
    const result = insertBlockAdjacent(blocks, 'b3', 'interlude', '[Vocal Interlude]', 'after', 'tag-id');
    expect(result.map((b) => b.id)).toEqual(['b1', 'b2', 'b3', 'tag-id', 'b4', 'b5', 'b6']);
  });

  it('returns the input unchanged for an unknown id', () => {
    expect(insertBlockAdjacent(blocks, 'missing', 'interlude', 'x', 'after', 'tag-id')).toEqual(blocks);
  });
});
