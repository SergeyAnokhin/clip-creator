import { describe, expect, it } from 'vitest';
import { computeContentRect } from './videoFrameRect.js';

describe('computeContentRect', () => {
  it('letterboxes (top/bottom bars) a 16:9 video in a taller container', () => {
    // container 1000x1000 (square), video 1600x900 (16:9)
    const rect = computeContentRect(1000, 1000, 1600, 900);
    expect(rect.width).toBeCloseTo(1000);
    expect(rect.height).toBeCloseTo(562.5);
    expect(rect.x).toBeCloseTo(0);
    expect(rect.y).toBeCloseTo((1000 - 562.5) / 2);
  });

  it('pillarboxes (left/right bars) a portrait video in a wider container', () => {
    // container 1000x1000 (square), video 900x1600 (9:16)
    const rect = computeContentRect(1000, 1000, 900, 1600);
    expect(rect.height).toBeCloseTo(1000);
    expect(rect.width).toBeCloseTo(562.5);
    expect(rect.y).toBeCloseTo(0);
    expect(rect.x).toBeCloseTo((1000 - 562.5) / 2);
  });

  it('fills the container exactly when aspect ratios match', () => {
    const rect = computeContentRect(1920, 1080, 1280, 720);
    expect(rect).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it('falls back to the full container box when a size is unknown (0)', () => {
    expect(computeContentRect(1920, 1080, 0, 0)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });
});
