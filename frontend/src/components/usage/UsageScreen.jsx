import { useEffect } from 'react';
import { ArrowLeft } from 'lucide-react';
import UsageFilters from './UsageFilters.jsx';
import UsageSummary from './UsageSummary.jsx';
import UsageTable from './UsageTable.jsx';

/** "Расходы" screen: filterable/groupable AI-call ledger. Records and the
 * summary are loaded here (not by the hook on mount) so a user who never
 * opens this screen never pays for the request. */
export default function UsageScreen({ L, usage, onClose }) {
  const { records, total, summary, groupBy, filters, loading, hasMore, actions } = usage;
  const filtersKey = JSON.stringify(filters);

  useEffect(() => {
    actions.loadRecords(true);
    actions.loadSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey, groupBy]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <div className="home-header">
        <button className="icon-btn" style={{ width: 36, height: 36 }} onClick={onClose}>
          <ArrowLeft size={16} />
        </button>
        <div className="workflow-title">{L.usage_title}</div>
      </div>

      <div style={{ flex: 1, padding: '32px 24px' }}>
        <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <UsageFilters L={L} filters={filters} onChange={actions.setFilter} onReset={actions.resetFilters} />
          <UsageSummary L={L} summary={summary} groupBy={groupBy} onGroupByChange={actions.setGroupBy} />
          <UsageTable L={L} records={records} total={total} loading={loading} hasMore={hasMore} onLoadMore={actions.loadMore} />
        </div>
      </div>
    </div>
  );
}
