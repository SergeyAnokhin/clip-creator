import { describe, expect, it } from 'vitest';
import { estimateCost, estimateTokensFromChars, estimateVideoCost, formatCost, formatTokens, modelPriceMap, priceLabel } from './pricing.js';

const L = { price_perImage: 'изобр.', price_perSecond: 'сек.', price_unknown: 'цена ?' };

describe('formatCost', () => {
  it('renders the unknown label for null/undefined', () => {
    expect(formatCost(null)).toBe('—');
    expect(formatCost(undefined)).toBe('—');
    expect(formatCost(null, { unknownLabel: 'n/a' })).toBe('n/a');
  });

  it('renders zero explicitly', () => {
    expect(formatCost(0)).toBe('$0.00');
  });

  it('uses 4 decimals for sub-cent amounts', () => {
    expect(formatCost(0.00042)).toBe('$0.0004');
  });

  it('uses 2 decimals for amounts a cent or larger', () => {
    expect(formatCost(1.5)).toBe('$1.50');
    expect(formatCost(0.3)).toBe('$0.30');
  });
});

describe('formatTokens', () => {
  it('passes small numbers through', () => {
    expect(formatTokens(42)).toBe('42');
  });

  it('abbreviates thousands and millions', () => {
    expect(formatTokens(1500)).toBe('1.5K');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });

  it('renders unknown for null', () => {
    expect(formatTokens(null)).toBe('—');
  });
});

describe('estimateCost', () => {
  it('computes text cost from input/output tokens', () => {
    const price = { kind: 'text', input: 0.3, output: 2.5 };
    expect(estimateCost(price, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(2.8);
  });

  it('computes image cost from count', () => {
    const price = { kind: 'image', per_image: 0.025 };
    expect(estimateCost(price, { images: 4 })).toBeCloseTo(0.1);
  });

  it('returns null for missing price', () => {
    expect(estimateCost(null, { inputTokens: 100 })).toBeNull();
  });

  it('returns null when price fields are incomplete', () => {
    expect(estimateCost({ kind: 'text', input: 0.3 }, { inputTokens: 100 })).toBeNull();
  });
});

describe('priceLabel', () => {
  it('formats a text price', () => {
    expect(priceLabel({ kind: 'text', input: 0.3, output: 2.5 }, L)).toBe('$0.3/$2.5');
  });

  it('formats an image price', () => {
    expect(priceLabel({ kind: 'image', per_image: 0.025 }, L)).toBe('$0.025 изобр.');
  });

  it('formats a video price', () => {
    expect(priceLabel({ kind: 'video', per_second: 0.4 }, L)).toBe('$0.4 сек.');
  });

  it('falls back to the unknown label when price is missing', () => {
    expect(priceLabel(null, L)).toBe('цена ?');
    expect(priceLabel({ kind: 'text', input: 0.3 }, L)).toBe('цена ?');
    expect(priceLabel({ kind: 'video' }, L)).toBe('цена ?');
  });
});

describe('estimateVideoCost', () => {
  it('multiplies seconds by the per-second price', () => {
    expect(estimateVideoCost({ kind: 'video', per_second: 0.4 }, 6)).toBeCloseTo(2.4);
  });

  it('returns null for a missing or non-video price', () => {
    expect(estimateVideoCost(null, 6)).toBeNull();
    expect(estimateVideoCost({ kind: 'image', per_image: 0.02 }, 6)).toBeNull();
    expect(estimateVideoCost({ kind: 'video' }, 6)).toBeNull();
  });
});

describe('estimateTokensFromChars', () => {
  it('divides length by 4, rounding up', () => {
    expect(estimateTokensFromChars('12345678')).toBe(2);
    expect(estimateTokensFromChars('123456789')).toBe(3);
  });

  it('returns 0 for empty/missing text', () => {
    expect(estimateTokensFromChars('')).toBe(0);
    expect(estimateTokensFromChars(undefined)).toBe(0);
  });
});

describe('modelPriceMap', () => {
  it('keys rows by their composite model id', () => {
    const models = [
      { model: 'google:gemini-2.5-flash', kind: 'text', input: 0.3, output: 2.5 },
      { model: 'fal:fal-ai/flux/dev', kind: 'image', per_image: 0.025 },
    ];
    const map = modelPriceMap(models);
    expect(map['google:gemini-2.5-flash'].input).toBe(0.3);
    expect(map['fal:fal-ai/flux/dev'].per_image).toBe(0.025);
  });

  it('returns an empty object for no models', () => {
    expect(modelPriceMap(undefined)).toEqual({});
  });
});
