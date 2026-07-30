import { useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';

/** Favorites list + default picker for a "which model" setting (text models,
 * simple models). `catalog` is `{provider: {source, models, error}}` fetched
 * once at the SettingsScreen level and shared between both instances. */
export default function ModelFavorites({
  L, providers, favorites, defaultValue, catalog, refreshing,
  onRefresh, onAddFavorite, onRemoveFavorite, onSetDefault,
}) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [manualProvider, setManualProvider] = useState(providers[0]?.id || '');
  const inputRef = useRef(null);

  const providerLabel = (id) => providers.find((p) => p.id === id)?.name || id;

  const q = query.trim().toLowerCase();
  const matchingModels = providers.flatMap((p) => {
    const entry = catalog[p.id];
    if (!entry) return [];
    return entry.models
      .filter((m) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
      .map((m) => ({ provider: p.id, id: m.id, name: m.name }));
  }).slice(0, 20);
  const suggestions = focused ? matchingModels : [];

  function addSuggestion(s) {
    onAddFavorite({ provider: s.provider, id: s.id, label: s.name });
    setQuery('');
    inputRef.current?.blur();
  }
  function addManual() {
    const trimmed = query.trim();
    if (!trimmed) return;
    onAddFavorite({ provider: manualProvider, id: trimmed, label: trimmed });
    setQuery('');
  }

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
        {favorites.map((f) => {
          const composite = `${f.provider}:${f.id}`;
          const isDefault = composite === defaultValue;
          return (
            <div
              className="settings-row"
              key={composite}
              style={{ cursor: 'pointer' }}
              onClick={() => onSetDefault(composite)}
            >
              <span className={`chip${isDefault ? ' is-active' : ''}`} style={{ flexShrink: 0 }}>
                {isDefault ? L.settings_default : L.settings_setDefault}
              </span>
              <span className="settings-row-name" style={{ width: 'auto', flex: 1 }}>
                {providerLabel(f.provider)} · {f.label}
              </span>
              <button
                className="icon-btn icon-btn-danger"
                onClick={(e) => { e.stopPropagation(); onRemoveFavorite(f.provider, f.id); }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
        {!favorites.length && (
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>{L.settings_noFavorites}</div>
        )}
      </div>

      <button className="btn btn-accent-soft" style={{ marginBottom: 10 }} onClick={onRefresh} disabled={refreshing}>
        {refreshing ? L.settings_refreshingModels : L.settings_refreshModels}
      </button>

      <div style={{ position: 'relative' }}>
        <input
          ref={inputRef}
          className="field"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={L.settings_modelSearchPlaceholder}
        />
        {suggestions.length > 0 && (
          <div className="settings-suggestions">
            {suggestions.map((s) => (
              <div
                key={`${s.provider}:${s.id}`}
                className="settings-suggestion-item"
                onClick={() => addSuggestion(s)}
              >
                <span className="settings-suggestion-provider">{providerLabel(s.provider)}</span>
                {s.name}
              </div>
            ))}
          </div>
        )}
      </div>

      {query.trim() && matchingModels.length === 0 && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <select
            className="field"
            style={{ flex: '0 0 auto', width: 'auto' }}
            value={manualProvider}
            onChange={(e) => setManualProvider(e.target.value)}
            title={L.settings_manualProvider}
          >
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button className="btn btn-accent-soft" onClick={addManual}>{L.settings_addModel}</button>
        </div>
      )}
    </div>
  );
}
