import { formatCost } from '../../lib/pricing.js';

const GROUP_KEYS = ['day', 'project', 'task', 'model', 'provider'];

export default function UsageSummary({ L, summary, groupBy, onGroupByChange }) {
  const totals = summary?.totals;
  return (
    <div className="settings-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 10 }}>
        <div className="settings-panel-label" style={{ marginBottom: 0 }}>{L.usage_tab_summary}</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {GROUP_KEYS.map((g) => (
            <button key={g} className={`chip${groupBy === g ? ' is-active' : ''}`} onClick={() => onGroupByChange(g)}>
              {L[`usage_group_${g}`]}
            </button>
          ))}
        </div>
      </div>

      {totals && (
        <div style={{ display: 'flex', gap: 20, marginBottom: 14, fontSize: 13, flexWrap: 'wrap' }}>
          <div><span style={{ color: 'var(--text-dim)' }}>{L.usage_calls}: </span><strong>{totals.calls}</strong></div>
          <div><span style={{ color: 'var(--text-dim)' }}>{L.usage_errors}: </span><strong>{totals.errors}</strong></div>
          <div><span style={{ color: 'var(--text-dim)' }}>{L.usage_totalCost}: </span><strong>{formatCost(totals.cost)}</strong></div>
          {totals.unknown_cost_calls > 0 && (
            <div style={{ color: 'var(--text-faint)' }}>{L.usage_costAtLeast}: {totals.unknown_cost_calls}</div>
          )}
          {totals.saved_cost > 0 && (
            <div><span style={{ color: 'var(--text-dim)' }}>{L.usage_savedCost}: </span><strong style={{ color: '#7ee787' }}>{formatCost(totals.saved_cost)}</strong></div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {(summary?.groups || []).map((g) => (
          <div className="settings-row" key={g.key}>
            <span
              className="settings-row-name"
              style={{ width: 'auto', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={g.key || L.usage_noProject}
            >
              {g.key || L.usage_noProject}
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-dim)', flexShrink: 0 }}>{g.calls} {L.usage_calls}</span>
            <span style={{ fontSize: 12, fontWeight: 700, flexShrink: 0, minWidth: 60, textAlign: 'right' }}>{formatCost(g.cost)}</span>
          </div>
        ))}
        {!summary?.groups?.length && <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>{L.usage_empty}</div>}
      </div>
    </div>
  );
}
