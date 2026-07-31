import { describe, expect, it } from 'vitest';
import { estimateCost, formatCost, formatTokens, modelPriceMap, priceLabel } from './pricing.js';

const L = { price_per1M: 'за 1M', price_perImage: 'изобр.', price_unknown: 'цена ?' };

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
    expect(priceLabel({ kind: 'text', input: 0.3, output: 2.5 }, L)).toBe('$0.3/$2.5 за 1M');
  });

  it('formats an image price', () => {
    expect(priceLabel({ kind: 'image', per_image: 0.025 }, L)).toBe('$0.025 изобр.');
  });

  it('falls back to the unknown label when price is missing', () => {
    expect(priceLabel(null, L)).toBe('цена ?');
    expect(priceLabel({ kind: 'text', input: 0.3 }, L)).toBe('цена ?');
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
