import { describe, expect, it } from 'vitest';
import { pickMainByRating, resolveAnimateImage } from './scenes.js';

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

describe('resolveAnimateImage', () => {
  it('returns null when the scene has no images', () => {
    expect(resolveAnimateImage({ images: [] })).toBeNull();
    expect(resolveAnimateImage({})).toBeNull();
  });

  it('falls back to the is_selected image when there is no override', () => {
    const images = [
      { image_id: 'a', is_selected: false },
      { image_id: 'b', is_selected: true },
    ];
    expect(resolveAnimateImage({ images })).toBe(images[1]);
  });

  it('falls back to the first image when nothing is selected', () => {
    const images = [{ image_id: 'a', is_selected: false }, { image_id: 'b', is_selected: false }];
    expect(resolveAnimateImage({ images })).toBe(images[0]);
  });

  it('prefers the animate_image_id override over is_selected', () => {
    const images = [
      { image_id: 'a', is_selected: true },
      { image_id: 'b', is_selected: false },
    ];
    expect(resolveAnimateImage({ images, animate_image_id: 'b' })).toBe(images[1]);
  });

  it('ignores a stale override that no longer matches any image', () => {
    const images = [{ image_id: 'a', is_selected: true }];
    expect(resolveAnimateImage({ images, animate_image_id: 'deleted' })).toBe(images[0]);
  });
});
