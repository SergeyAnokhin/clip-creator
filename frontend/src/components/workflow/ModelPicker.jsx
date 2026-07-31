import { priceLabel } from '../../lib/pricing.js';

/** Compact dropdown over a settings favorites list ({provider, id, label}[]),
 * used to pick which of the user's favorited models a specific generation
 * call should use, instead of always silently falling back to the settings
 * default. `value`/`onChange` deal in the same "{provider}:{id}" composite
 * as the settings default. `prices` (composite -> pricing row) and `L` are
 * optional - when given, each option's label gets a " · $x/$y за 1M"-style
 * price suffix so models can be compared before picking one. */
export default function ModelPicker({ favorites, value, onChange, emptyLabel, prices, L }) {
  if (!favorites?.length) {
    return emptyLabel ? <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{emptyLabel}</span> : null;
  }
  return (
    <select
      className="field"
      style={{ flex: '0 0 auto', width: 'auto' }}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {favorites.map((f) => {
        const composite = `${f.provider}:${f.id}`;
        const suffix = prices && L ? ` · ${priceLabel(prices[composite], L)}` : '';
        return <option key={composite} value={composite}>{f.label}{suffix}</option>;
      })}
    </select>
  );
}
