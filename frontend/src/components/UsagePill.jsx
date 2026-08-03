import { useState } from 'react';
import { Coins } from 'lucide-react';
import { formatCost } from '../lib/pricing.js';

/** Shared "spend today" indicator for the three screen headers (home,
 * workflow, settings). Clicking it expands an in-place breakdown
 * (today/week/month/all-time); the Usage screen is only reachable from the
 * link inside that expanded view, not from the collapsed pill itself. */
export default function UsagePill({ L, today, periodTotals, onOpen, onLoadPeriodTotals }) {
  const [expanded, setExpanded] = useState(false);

  function toggle() {
    if (!expanded) onLoadPeriodTotals?.();
    setExpanded((e) => !e);
  }

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        className="pill pill-neutral"
        style={{ cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }}
        onClick={toggle}
        title={L.usage_todayTitle}
      >
        <Coins size={12} />
        {formatCost(today?.cost)}
      </button>
      {expanded && (
        <div
          className="glass-card"
          style={{
            position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 30,
            width: 200, padding: 12, fontSize: 12.5, display: 'flex', flexDirection: 'column', gap: 6,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-dim)' }}>
            <span>{L.usage_periodToday}</span>
            <span style={{ color: 'rgba(255,255,255,0.85)', fontWeight: 700 }}>{formatCost(periodTotals?.today?.cost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-dim)' }}>
            <span>{L.usage_periodWeek}</span>
            <span style={{ color: 'rgba(255,255,255,0.85)', fontWeight: 700 }}>{formatCost(periodTotals?.week?.cost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-dim)' }}>
            <span>{L.usage_periodMonth}</span>
            <span style={{ color: 'rgba(255,255,255,0.85)', fontWeight: 700 }}>{formatCost(periodTotals?.month?.cost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-dim)' }}>
            <span>{L.usage_periodTotal}</span>
            <span style={{ color: 'rgba(255,255,255,0.85)', fontWeight: 700 }}>{formatCost(periodTotals?.total?.cost)}</span>
          </div>
          <button className="btn btn-accent-soft" style={{ marginTop: 4, fontSize: 12 }} onClick={onOpen}>
            {L.usage_openScreen}
          </button>
        </div>
      )}
    </div>
  );
}
