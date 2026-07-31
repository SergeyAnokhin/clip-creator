/** Pure helpers for displaying and estimating AI call costs. Mirrors the
 * cost math in backend/app/pricing.py closely enough for ex-ante UI
 * estimates (model picker labels), but the backend's `usage.record()` is
 * always the source of truth for what a call actually cost. */

const TOKENS_PER_UNIT = 1_000_000;

/** `null`/`undefined` means "unknown cost" - never treated as free. */
export function formatCost(amount, { unknownLabel = '—' } = {}) {
  if (amount === null || amount === undefined) return unknownLabel;
  if (amount === 0) return '$0.00';
  if (Math.abs(amount) < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

export function formatTokens(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** `price` is one row from GET /api/usage/pricing's `models[]` (or null if
 * the model has no known price). Ex-ante only - always compare against the
 * ledger for actual spend. */
export function estimateCost(price, { inputTokens = 0, outputTokens = 0, images = 0 } = {}) {
  if (!price) return null;
  if (price.kind === 'text') {
    if (price.input == null || price.output == null) return null;
    return (inputTokens * price.input + outputTokens * price.output) / TOKENS_PER_UNIT;
  }
  if (price.kind === 'image') {
    if (price.per_image == null) return null;
    return images * price.per_image;
  }
  return null;
}

/** Short label for a model picker option / favorites row, e.g.
 * "$0.30 / $2.50 за 1M" or "$0.025 / изобр." Falls back to `L.price_unknown`
 * (e.g. "цена ?") when the model has no price entry. */
export function priceLabel(price, L) {
  if (!price) return L.price_unknown;
  if (price.kind === 'text') {
    if (price.input == null || price.output == null) return L.price_unknown;
    return `$${trimZeros(price.input)}/$${trimZeros(price.output)} ${L.price_per1M}`;
  }
  if (price.kind === 'image') {
    if (price.per_image == null) return L.price_unknown;
    return `$${trimZeros(price.per_image)} ${L.price_perImage}`;
  }
  return L.price_unknown;
}

function trimZeros(n) {
  return String(Number(n.toFixed(4)));
}

/** `models` is GET /api/usage/pricing's `models[]` array -> {composite: row}. */
export function modelPriceMap(models) {
  const map = {};
  for (const row of models || []) map[row.model] = row;
  return map;
}
