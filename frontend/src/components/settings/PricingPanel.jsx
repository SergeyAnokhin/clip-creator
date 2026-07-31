import { useEffect, useState } from 'react';
import { Plus, RotateCcw } from 'lucide-react';

function toNum(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

/** One catalog row: editable price fields (input/output per 1M tokens, or
 * per-image), committed on blur into the panel's pending `drafts`. */
function PricingRow({ L, row, isOverride, pendingReset, onChange, onReset }) {
  const [input, setInput] = useState(row.input ?? '');
  const [output, setOutput] = useState(row.output ?? '');
  const [perImage, setPerImage] = useState(row.per_image ?? '');

  useEffect(() => {
    setInput(row.input ?? '');
    setOutput(row.output ?? '');
    setPerImage(row.per_image ?? '');
  }, [row.input, row.output, row.per_image]);

  function commit() {
    if (row.kind === 'text') {
      const i = toNum(input);
      const o = toNum(output);
      if (i === undefined || o === undefined) return;
      onChange(row.model, { kind: 'text', input: i, output: o });
    } else {
      const p = toNum(perImage);
      if (p === undefined) return;
      onChange(row.model, { kind: 'image', per_image: p });
    }
  }

  return (
    <div className="settings-row" style={{ alignItems: 'center', opacity: pendingReset ? 0.5 : 1 }}>
      <span
        className="settings-row-name"
        style={{ width: 'auto', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={row.model}
      >
        {row.model}
        {isOverride && !pendingReset && (
          <span className="chip is-active" style={{ marginLeft: 8, padding: '2px 8px', fontSize: 10 }}>
            {L.settings_pricingOverride}
          </span>
        )}
      </span>
      {row.kind === 'text' ? (
        <>
          <input
            className="field" style={{ width: 88, flex: '0 0 auto' }} value={input} disabled={pendingReset}
            onChange={(e) => setInput(e.target.value)} onBlur={commit} placeholder={L.settings_pricingInput}
          />
          <input
            className="field" style={{ width: 88, flex: '0 0 auto' }} value={output} disabled={pendingReset}
            onChange={(e) => setOutput(e.target.value)} onBlur={commit} placeholder={L.settings_pricingOutput}
          />
        </>
      ) : (
        <input
          className="field" style={{ width: 100, flex: '0 0 auto' }} value={perImage} disabled={pendingReset}
          onChange={(e) => setPerImage(e.target.value)} onBlur={commit} placeholder={L.settings_pricingPerImage}
        />
      )}
      {(isOverride || pendingReset) && (
        <button className="icon-btn" title={L.settings_pricingReset} onClick={() => onReset(row.model)}>
          <RotateCcw size={13} />
        </button>
      )}
    </div>
  );
}

/** Form for pricing a model not yet in the catalog (a custom/manual model id
 * added in the model favorites panel). */
function AddPriceRow({ L, onAdd }) {
  const [model, setModel] = useState('');
  const [kind, setKind] = useState('text');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [perImage, setPerImage] = useState('');

  function submit() {
    const composite = model.trim();
    if (!composite.includes(':')) return;
    if (kind === 'text') {
      const i = toNum(input);
      const o = toNum(output);
      if (i === undefined || o === undefined) return;
      onAdd(composite, { kind: 'text', input: i, output: o });
    } else {
      const p = toNum(perImage);
      if (p === undefined) return;
      onAdd(composite, { kind: 'image', per_image: p });
    }
    setModel(''); setInput(''); setOutput(''); setPerImage('');
  }

  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
      <input
        className="field" style={{ flex: '1 1 200px' }} value={model}
        onChange={(e) => setModel(e.target.value)} placeholder="provider:model_id"
      />
      <select className="field" style={{ flex: '0 0 auto', width: 'auto' }} value={kind} onChange={(e) => setKind(e.target.value)}>
        <option value="text">{L.settings_pricingKindText}</option>
        <option value="image">{L.settings_pricingKindImage}</option>
      </select>
      {kind === 'text' ? (
        <>
          <input className="field" style={{ width: 88, flex: '0 0 auto' }} value={input} onChange={(e) => setInput(e.target.value)} placeholder={L.settings_pricingInput} />
          <input className="field" style={{ width: 88, flex: '0 0 auto' }} value={output} onChange={(e) => setOutput(e.target.value)} placeholder={L.settings_pricingOutput} />
        </>
      ) : (
        <input className="field" style={{ width: 100, flex: '0 0 auto' }} value={perImage} onChange={(e) => setPerImage(e.target.value)} placeholder={L.settings_pricingPerImage} />
      )}
      <button className="btn btn-accent-soft" onClick={submit}>
        <Plus size={13} /> {L.add}
      </button>
    </div>
  );
}

/** Built-in price catalog + user overrides. Edits are staged locally and
 * committed together via `onSave` (PUT /api/usage/pricing), separate from
 * the rest of Settings' single "Save" button - pricing_overrides is not
 * mirrored into useSettings state. */
export default function PricingPanel({ L, pricing, providers, onSave }) {
  const [drafts, setDrafts] = useState({});
  const [saving, setSaving] = useState(false);
  const [providerFilter, setProviderFilter] = useState('');
  const [query, setQuery] = useState('');

  const allRows = pricing?.models || [];
  const overrides = pricing?.overrides || {};
  const dirty = Object.keys(drafts).length > 0;

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = allRows.filter((row) => {
    if (providerFilter && row.provider !== providerFilter) return false;
    if (!terms.length) return true;
    const haystack = row.model.toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });

  function applyPatch(model, patch) {
    setDrafts((prev) => ({ ...prev, [model]: patch }));
  }
  function resetRow(model) {
    setDrafts((prev) => ({ ...prev, [model]: null }));
  }
  function addRow(model, patch) {
    setDrafts((prev) => ({ ...prev, [model]: patch }));
  }

  async function save() {
    setSaving(true);
    try {
      const next = { ...overrides };
      for (const [model, patch] of Object.entries(drafts)) {
        if (patch === null) delete next[model];
        else next[model] = patch;
      }
      await onSave(next);
      setDrafts({});
    } finally {
      setSaving(false);
    }
  }

  const addedRows = Object.entries(drafts)
    .filter(([model, patch]) => patch !== null && !allRows.some((r) => r.model === model))
    .map(([model, patch]) => ({ model, provider: model.split(':')[0], ...patch }))
    .filter((row) => {
      if (providerFilter && row.provider !== providerFilter) return false;
      return terms.every((t) => row.model.toLowerCase().includes(t));
    });

  return (
    <div className="settings-panel">
      <div className="settings-panel-label">{L.settings_pricing}</div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>
        {L.settings_pricingVerifyWarning} ({pricing?.pricing_version})
      </div>

      {!!providers?.length && (
        <div className="settings-tabs" style={{ marginBottom: 10 }}>
          <button
            className={`chip${!providerFilter ? ' is-active' : ''}`}
            onClick={() => setProviderFilter('')}
          >
            {L.settings_pricingAllProviders}
          </button>
          {providers.map((p) => (
            <button
              key={p.id}
              className={`chip${providerFilter === p.id ? ' is-active' : ''}`}
              onClick={() => setProviderFilter(p.id)}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
      <input
        className="field"
        style={{ marginBottom: 10 }}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={L.settings_pricingSearchPlaceholder}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.map((row) => {
          const draft = drafts[row.model];
          const pendingReset = draft === null;
          const effectiveRow = draft && draft !== null ? { ...row, ...draft } : row;
          const isOverride = draft === undefined ? row.source === 'override' : draft !== null;
          return (
            <PricingRow
              key={row.model} L={L} row={effectiveRow} isOverride={isOverride} pendingReset={pendingReset}
              onChange={applyPatch} onReset={resetRow}
            />
          );
        })}
        {addedRows.map((row) => (
          <PricingRow key={row.model} L={L} row={row} isOverride pendingReset={false} onChange={applyPatch} onReset={resetRow} />
        ))}
      </div>

      <AddPriceRow L={L} onAdd={addRow} />

      <button className="btn btn-gradient" style={{ marginTop: 14 }} disabled={!dirty || saving} onClick={save}>
        {saving ? L.settings_pricingSaving : L.settings_pricingSave}
      </button>
    </div>
  );
}
