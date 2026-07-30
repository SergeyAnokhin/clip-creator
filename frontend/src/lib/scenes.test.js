import { describe, expect, it } from 'vitest';
import { pickMainByRating } from './scenes.js';

describe('pickMainByRating', () => {
  it('returns images unchanged when there are none', () => {
    expect(pickMainByRating([])).toEqual([]);
  });

  it('leaves selection untouched when every image is rated 0', () => {
    const images = [
      { rating: 0, is_selected: true },
      { rating: 0, is_selected: false },
    ];
    expect(pickMainByRating(images)).toEqual(images);
  });

  it('selects the single highest-rated image', () => {
    const images = [
      { rating: 3, is_selected: true },
      { rating: 5, is_selected: false },
      { rating: 2, is_selected: false },
    ];
    expect(pickMainByRating(images)).toEqual([
      { rating: 3, is_selected: false },
      { rating: 5, is_selected: true },
      { rating: 2, is_selected: false },
    ]);
  });

  it('keeps the currently-selected image on a tie for the top rating', () => {
    const images = [
      { rating: 5, is_selected: false },
      { rating: 5, is_selected: true },
      { rating: 1, is_selected: false },
    ];
    expect(pickMainByRating(images)).toEqual(images);
  });

  it('picks the first tied image when none of the tied images is currently selected', () => {
    const images = [
      { rating: 3, is_selected: true },
      { rating: 5, is_selected: false },
      { rating: 5, is_selected: false },
    ];
    expect(pickMainByRating(images)).toEqual([
      { rating: 3, is_selected: false },
      { rating: 5, is_selected: true },
      { rating: 5, is_selected: false },
    ]);
  });
});
