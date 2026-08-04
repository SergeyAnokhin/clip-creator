import { priceLabel } from '../../lib/pricing.js';

/** Short provider tag shown in front of each option's label, so models from
 * different providers (and critically, free vs. paid Google Gemini) can be
 * told apart at a glance - native <option> text can't be partially colored
 * or sized, so a plain-text bracket prefix is the only thing that actually
 * renders inside a <select> popup. Mirrors the provider names
 * SettingsScreen.jsx's MODEL_PROVIDERS list uses, just shortened. */
const _PROVIDER_TAG = {
  google: 'Google', google_free: 'Google Free', openrouter: 'OpenRouter',
  deepseek: 'DeepSeek', replicate: 'Replicate', fal: 'FAL', krea: 'Krea',
};

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
        const tag = _PROVIDER_TAG[f.provider] || f.provider;
        const suffix = prices && L ? ` · ${priceLabel(prices[composite], L)}` : '';
        return <option key={composite} value={composite}>[{tag}] {f.label}{suffix}</option>;
      })}
    </select>
  );
}
