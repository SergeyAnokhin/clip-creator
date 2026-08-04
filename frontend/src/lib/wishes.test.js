import { describe, expect, it } from 'vitest';
import { sortByUseCount } from './wishes.js';

describe('sortByUseCount', () => {
  it('orders most-used first', () => {
    const wishes = [
      { id: 'a', use_count: 1 },
      { id: 'b', use_count: 5 },
      { id: 'c', use_count: 2 },
    ];
    expect(sortByUseCount(wishes).map((w) => w.id)).toEqual(['b', 'c', 'a']);
  });

  it('treats missing use_count as 0 and keeps a stable order for ties', () => {
    const wishes = [
      { id: 'a' },
      { id: 'b', use_count: 0 },
      { id: 'c', use_count: 3 },
    ];
    expect(sortByUseCount(wishes).map((w) => w.id)).toEqual(['c', 'a', 'b']);
  });

  it('does not mutate the input array', () => {
    const wishes = [{ id: 'a', use_count: 1 }, { id: 'b', use_count: 2 }];
    const sorted = sortByUseCount(wishes);
    expect(sorted).not.toBe(wishes);
    expect(wishes.map((w) => w.id)).toEqual(['a', 'b']);
  });

  it('handles null/undefined input', () => {
    expect(sortByUseCount(null)).toEqual([]);
    expect(sortByUseCount(undefined)).toEqual([]);
  });
});
