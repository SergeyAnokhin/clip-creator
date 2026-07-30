/** Compact dropdown over a settings favorites list ({provider, id, label}[]),
 * used to pick which of the user's favorited models a specific generation
 * call should use, instead of always silently falling back to the settings
 * default. `value`/`onChange` deal in the same "{provider}:{id}" composite
 * as the settings default. */
export default function ModelPicker({ favorites, value, onChange, emptyLabel }) {
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
        return <option key={composite} value={composite}>{f.label}</option>;
      })}
    </select>
  );
}
