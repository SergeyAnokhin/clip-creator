import { useEffect, useRef, useState } from 'react';
import { Check, Download, Pencil, Plus, RotateCcw, Upload } from 'lucide-react';
import { downloadJSON, readJSONFile } from '../../lib/download.js';

function toNum(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Compact colored icon + tooltip telling where a price came from - kept out
 * of the row's text flow so it doesn't compete for space with the price
 * inputs themselves (see the user request that drove this: a short/iconic
 * marker instead of a text badge). No icon for 'catalog' (no price yet). */
const SOURCE_BADGES = {
  builtin: { Icon: Check, color: '#4ade80' },
  manual: { Icon: Pencil, color: '#60a5fa' },
  import: { Icon: Upload, color: '#c084fc' },
};

function SourceBadge({ source, L }) {
  const meta = SOURCE_BADGES[source];
  if (!meta) return null;
  const { Icon, color } = meta;
  return (
    <span
      title={L[`settings_pricingSource_${source}`]}
      style={{ marginLeft: 8, display: 'inline-flex', alignItems: 'center', color, flex: '0 0 auto' }}
    >
      <Icon size={13} />
    </span>
  );
}

/** One catalog row: editable price fields (input/output per 1M tokens, or
 * per-image), committed on blur into the panel's pending `drafts`. */
function PricingRow({ L, row, isOverride, pendingReset, onChange, onReset }) {
  const [input, setInput] = useState(row.input ?? '');
  const [output, setOutput] = useState(row.output ?? '');
  const [perImage, setPerImage] = useState(row.per_image ?? '');
  const [perSecond, setPerSecond] = useState(row.per_second ?? '');

  useEffect(() => {
    setInput(row.input ?? '');
    setOutput(row.output ?? '');
    setPerImage(row.per_image ?? '');
    setPerSecond(row.per_second ?? '');
  }, [row.input, row.output, row.per_image, row.per_second]);

  function commit() {
    if (row.kind === 'text') {
      const i = toNum(input);
      const o = toNum(output);
      if (i === undefined || o === undefined) return;
      onChange(row.model, { kind: 'text', input: i, output: o, source: 'manual' });
    } else if (row.kind === 'video') {
      const p = toNum(perSecond);
      if (p === undefined) return;
      onChange(row.model, { kind: 'video', per_second: p, source: 'manual' });
    } else {
      const p = toNum(perImage);
      if (p === undefined) return;
      onChange(row.model, { kind: 'image', per_image: p, source: 'manual' });
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
        {!pendingReset && <SourceBadge source={row.source} L={L} />}
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
      ) : row.kind === 'video' ? (
        <input
          className="field" style={{ width: 100, flex: '0 0 auto' }} value={perSecond} disabled={pendingReset}
          onChange={(e) => setPerSecond(e.target.value)} onBlur={commit} placeholder={L.settings_pricingPerSecond}
        />
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
  const [perSecond, setPerSecond] = useState('');

  function submit() {
    const composite = model.trim();
    if (!composite.includes(':')) return;
    if (kind === 'text') {
      const i = toNum(input);
      const o = toNum(output);
      if (i === undefined || o === undefined) return;
      onAdd(composite, { kind: 'text', input: i, output: o, source: 'manual' });
    } else if (kind === 'video') {
      const p = toNum(perSecond);
      if (p === undefined) return;
      onAdd(composite, { kind: 'video', per_second: p, source: 'manual' });
    } else {
      const p = toNum(perImage);
      if (p === undefined) return;
      onAdd(composite, { kind: 'image', per_image: p, source: 'manual' });
    }
    setModel(''); setInput(''); setOutput(''); setPerImage(''); setPerSecond('');
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
        <option value="video">{L.settings_pricingKindVideo}</option>
      </select>
      {kind === 'text' ? (
        <>
          <input className="field" style={{ width: 88, flex: '0 0 auto' }} value={input} onChange={(e) => setInput(e.target.value)} placeholder={L.settings_pricingInput} />
          <input className="field" style={{ width: 88, flex: '0 0 auto' }} value={output} onChange={(e) => setOutput(e.target.value)} placeholder={L.settings_pricingOutput} />
        </>
      ) : kind === 'video' ? (
        <input className="field" style={{ width: 100, flex: '0 0 auto' }} value={perSecond} onChange={(e) => setPerSecond(e.target.value)} placeholder={L.settings_pricingPerSecond} />
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
  const [kindFilter, setKindFilter] = useState('');
  const [onlyUnpriced, setOnlyUnpriced] = useState(false);
  const [query, setQuery] = useState('');
  const [importStatus, setImportStatus] = useState('');
  const importFileRef = useRef(null);

  const allRows = pricing?.models || [];
  const overrides = pricing?.overrides || {};
  const dirty = Object.keys(drafts).length > 0;

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = allRows.filter((row) => {
    if (providerFilter && row.provider !== providerFilter) return false;
    if (kindFilter && row.kind !== kindFilter) return false;
    if (onlyUnpriced && row.source !== 'catalog') return false;
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

  /** Exports the full saved catalog (every model the app has ever seen, priced
   * or not) so it can be handed to external research and re-imported once
   * the gaps are filled. Unsaved edits in `drafts` are not included - save
   * first if they should be part of the export. */
  function exportPrices() {
    const models = {};
    for (const row of allRows) {
      const base = row.kind === 'text'
        ? { kind: 'text', input: row.input, output: row.output, ...(row.cached_input != null ? { cached_input: row.cached_input } : {}) }
        : row.kind === 'video'
        ? { kind: 'video', per_second: row.per_second }
        : { kind: 'image', per_image: row.per_image };
      models[row.model] = { ...base, source: row.source };
    }
    downloadJSON('versecraft-model-prices.json', {
      pricing_version: pricing?.pricing_version,
      currency: pricing?.currency,
      exported_at: new Date().toISOString(),
      models,
    });
  }

  /** Imports a `{models: {composite: {kind, input, output, per_image}}}` file
   * (the shape `exportPrices` produces) as pending overrides - staged into
   * `drafts` like any manual edit, so they still need "Save" to persist.
   * Rows with a missing/invalid price (e.g. still-unresearched placeholders)
   * are counted but left unset rather than guessed. */
  async function handleImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = await readJSONFile(file);
      const models = (data && typeof data === 'object' && data.models) || data || {};
      const patches = {};
      let applied = 0;
      let skipped = 0;
      for (const [model, row] of Object.entries(models)) {
        if (!model.includes(':') || !row || typeof row !== 'object') { skipped++; continue; }
        const source = typeof row.source === 'string' && row.source.trim() ? row.source.trim() : 'import';
        if (row.kind === 'text') {
          const input = toNum(row.input);
          const output = toNum(row.output);
          if (input === undefined || output === undefined) { skipped++; continue; }
          const cached = toNum(row.cached_input);
          patches[model] = { kind: 'text', input, output, ...(cached !== undefined ? { cached_input: cached } : {}), source };
          applied++;
        } else if (row.kind === 'image') {
          const perImage = toNum(row.per_image);
          if (perImage === undefined) { skipped++; continue; }
          patches[model] = { kind: 'image', per_image: perImage, source };
          applied++;
        } else if (row.kind === 'video') {
          const perSecond = toNum(row.per_second);
          if (perSecond === undefined) { skipped++; continue; }
          patches[model] = { kind: 'video', per_second: perSecond, source };
          applied++;
        } else {
          skipped++;
        }
      }
      setDrafts((prev) => ({ ...prev, ...patches }));
      setImportStatus(`${L.settings_pricingImportApplied}: ${applied}, ${L.settings_pricingImportSkipped}: ${skipped}`);
    } catch {
      setImportStatus(L.toast_importFailed);
    }
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

  const addedRows = onlyUnpriced ? [] : Object.entries(drafts)
    .filter(([model, patch]) => patch !== null && !allRows.some((r) => r.model === model))
    .map(([model, patch]) => ({ model, provider: model.split(':')[0], ...patch }))
    .filter((row) => {
      if (providerFilter && row.provider !== providerFilter) return false;
      if (kindFilter && row.kind !== kindFilter) return false;
      return terms.every((t) => row.model.toLowerCase().includes(t));
    });

  return (
    <div className="settings-panel">
      <div className="settings-panel-label">{L.settings_pricing}</div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>
        {L.settings_pricingVerifyWarning} ({pricing?.pricing_version})
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <button className="btn btn-accent-soft" onClick={exportPrices}>
          <Download size={13} /> {L.settings_exportBtn}
        </button>
        <button className="btn btn-accent-soft" onClick={() => importFileRef.current?.click()}>
          <Upload size={13} /> {L.settings_importBtn}
        </button>
        <input
          ref={importFileRef}
          type="file"
          accept="application/json"
          style={{ display: 'none' }}
          onChange={handleImportFile}
        />
        {importStatus && <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{importStatus}</span>}
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
      <div className="settings-tabs" style={{ marginBottom: 10 }}>
        <button className={`chip${!kindFilter ? ' is-active' : ''}`} onClick={() => setKindFilter('')}>
          {L.settings_pricingAllKinds}
        </button>
        <button className={`chip${kindFilter === 'text' ? ' is-active' : ''}`} onClick={() => setKindFilter('text')}>
          {L.settings_pricingKindText}
        </button>
        <button className={`chip${kindFilter === 'image' ? ' is-active' : ''}`} onClick={() => setKindFilter('image')}>
          {L.settings_pricingKindImage}
        </button>
        <button className={`chip${kindFilter === 'video' ? ' is-active' : ''}`} onClick={() => setKindFilter('video')}>
          {L.settings_pricingKindVideo}
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 10, flexWrap: 'wrap' }}>
        <input
          className="field"
          style={{ flex: '1 1 220px', marginBottom: 0 }}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={L.settings_pricingSearchPlaceholder}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-dim)', cursor: 'pointer', flex: '0 0 auto' }}>
          <input type="checkbox" checked={onlyUnpriced} onChange={(e) => setOnlyUnpriced(e.target.checked)} />
          {L.settings_pricingOnlyUnpriced}
        </label>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.map((row) => {
          const draft = drafts[row.model];
          const pendingReset = draft === null;
          const effectiveRow = draft && draft !== null ? { ...row, ...draft } : row;
          const isOverride = draft === undefined ? row.source === 'manual' || row.source === 'import' : draft !== null;
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
