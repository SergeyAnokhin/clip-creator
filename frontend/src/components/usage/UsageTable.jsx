import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatCost, formatTokens } from '../../lib/pricing.js';

function statusColor(status) {
  return status === 'error' ? 'var(--danger)' : 'var(--success)';
}

function UsageTableRow({ L, rec }) {
  const [open, setOpen] = useState(false);
  const units = rec.units || {};
  const costUnknown = rec.cost?.amount === null || rec.cost?.amount === undefined;

  return (
    <div className="settings-panel usage-row" style={{ padding: 12 }}>
      <div className="usage-row-head" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={14} style={{ flexShrink: 0 }} /> : <ChevronRight size={14} style={{ flexShrink: 0 }} />}
        <span className="usage-row-time">{(rec.ts || '').slice(0, 16).replace('T', ' ')}</span>
        <span className="usage-row-project" title={rec.project_id || ''}>{rec.project_id || L.usage_noProject}</span>
        <span className="chip" style={{ padding: '3px 9px', fontSize: 10.5, cursor: 'default' }}>
          {L[`task_${rec.task}`] || rec.task}
        </span>
        <span className="usage-row-model" title={rec.model}>{rec.model}</span>
        <span className="usage-row-units">
          {units.kind === 'image'
            ? `${units.images ?? 0} ${L.usage_col_images}`
            : `${formatTokens(units.input_tokens)} / ${formatTokens(units.output_tokens)}`}
        </span>
        <span className={`usage-row-cost${costUnknown ? ' usage-cost-unknown' : ''}`}>
          {costUnknown ? L.usage_costUnknown : formatCost(rec.cost?.amount)}
        </span>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor(rec.status), flexShrink: 0 }} title={rec.status} />
      </div>
      {open && (
        <div className="usage-row-expand">
          <div><strong>{L.usage_prompt}:</strong> {rec.prompt_preview || '—'}</div>
          <div><strong>{L.usage_response}:</strong> {rec.response_preview || '—'}</div>
          {rec.error && <div style={{ color: 'var(--danger)' }}>{rec.error}</div>}
          <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
            {L.usage_col_duration}: {rec.duration_ms} ms
          </div>
        </div>
      )}
    </div>
  );
}

export default function UsageTable({ L, records, total, loading, hasMore, onLoadMore }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{L.usage_tab_records} ({total})</div>
      {records.map((rec) => <UsageTableRow key={rec.id} L={L} rec={rec} />)}
      {!records.length && !loading && <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>{L.usage_empty}</div>}
      {hasMore && (
        <button className="btn btn-accent-soft" style={{ alignSelf: 'center' }} onClick={onLoadMore} disabled={loading}>
          {L.usage_loadMore}
        </button>
      )}
    </div>
  );
}
