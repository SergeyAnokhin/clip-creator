import { describe, expect, it } from 'vitest';
import { pctTransformToPixels, pixelsToPctTransform } from './canvasLayer.js';

describe('pctTransformToPixels', () => {
  it('places top-left-anchored percentages at the matching pixel offset', () => {
    const px = pctTransformToPixels(
      { xPct: 25, yPct: 50, widthPct: 20, heightPct: 10, rotationDeg: 0 },
      1000, 800, 200, 80,
    );
    expect(px.x).toBe(250);
    expect(px.y).toBe(400);
  });

  it('derives scaleX/scaleY from the target pixel size over the natural size', () => {
    const px = pctTransformToPixels(
      { xPct: 0, yPct: 0, widthPct: 20, heightPct: 10, rotationDeg: 0 },
      1000, 800, 200, 80,
    );
    // target: 200x80 px, natural: 200x80 px -> scale 1
    expect(px.scaleX).toBeCloseTo(1);
    expect(px.scaleY).toBeCloseTo(1);
  });

  it('passes rotation through unchanged, defaulting to 0', () => {
    expect(pctTransformToPixels({ xPct: 0, yPct: 0, widthPct: 10, heightPct: 10, rotationDeg: 45 }, 100, 100, 10, 10).rotation).toBe(45);
    expect(pctTransformToPixels({ xPct: 0, yPct: 0, widthPct: 10, heightPct: 10 }, 100, 100, 10, 10).rotation).toBe(0);
  });
});

describe('pixelsToPctTransform', () => {
  it('is the exact inverse of pctTransformToPixels', () => {
    const original = { xPct: 33.5, yPct: 12, widthPct: 40, heightPct: 25, rotationDeg: 17 };
    const containerW = 1920;
    const containerH = 1080;
    const naturalW = 512;
    const naturalH = 256;
    const px = pctTransformToPixels(original, containerW, containerH, naturalW, naturalH);
    const back = pixelsToPctTransform(px, containerW, containerH, naturalW, naturalH);
    expect(back.xPct).toBeCloseTo(original.xPct);
    expect(back.yPct).toBeCloseTo(original.yPct);
    expect(back.widthPct).toBeCloseTo(original.widthPct);
    expect(back.heightPct).toBeCloseTo(original.heightPct);
    expect(back.rotationDeg).toBeCloseTo(original.rotationDeg);
  });

  it('returns 0 percentages for a zero-size container rather than dividing by zero', () => {
    const back = pixelsToPctTransform({ x: 10, y: 10, scaleX: 1, scaleY: 1, rotation: 0 }, 0, 0, 10, 10);
    expect(back).toEqual({ xPct: 0, yPct: 0, widthPct: 0, heightPct: 0, rotationDeg: 0 });
  });
});
