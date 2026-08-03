import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { modelPriceMap } from '../lib/pricing.js';

const TZ_OFFSET = -new Date().getTimezoneOffset(); // minutes east of UTC, matches backend's tz_offset param
const PAGE_SIZE = 50;

const EMPTY_FILTERS = { project_id: '', task: '', provider: '', model: '', status: '', date_from: '', date_to: '' };
const EMPTY_PRICING = { models: [], overrides: {}, pricing_version: '', currency: 'USD' };

/** AI usage ledger: today's spend (for the header pill), the pricing catalog
 * (for model-picker labels and the Settings "Prices" tab), and the filtered
 * records/summary shown on the Usage screen. Only `today`/`pricing` load on
 * mount - records/summary are loaded explicitly by the Usage screen so a
 * user who never opens it never pays for that request. */
export function useUsage() {
  const [today, setToday] = useState(null);
  const [periodTotals, setPeriodTotals] = useState(null);
  const [pricing, setPricing] = useState(EMPTY_PRICING);
  const [records, setRecords] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [summary, setSummary] = useState(null);
  const [groupBy, setGroupBy] = useState('day');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [loading, setLoading] = useState(false);

  function refreshToday() {
    api.usageToday(TZ_OFFSET).then(setToday).catch(() => {});
  }
  // Lazy - only fetched when the header cost pill is first expanded, so a
  // user who never opens it never pays for the extra request.
  function loadPeriodTotals() {
    api.usagePeriodTotals(TZ_OFFSET).then(setPeriodTotals).catch(() => {});
  }
  function refreshPricing() {
    api.getPricing().then(setPricing).catch(() => {});
  }

  useEffect(() => { refreshToday(); refreshPricing(); }, []);

  function loadRecords(reset = true) {
    setLoading(true);
    const nextOffset = reset ? 0 : offset;
    api.listUsage({ ...filters, limit: PAGE_SIZE, offset: nextOffset })
      .then((res) => {
        setRecords((prev) => (reset ? res.records : [...prev, ...res.records]));
        setTotal(res.total);
        setOffset(nextOffset + res.records.length);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }
  function loadSummary() {
    api.usageSummary({ ...filters, group_by: groupBy, tz_offset: TZ_OFFSET }).then(setSummary).catch(() => {});
  }
  function setFilter(key, value) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }
  function resetFilters() {
    setFilters(EMPTY_FILTERS);
  }
  async function savePricingOverrides(overrides) {
    const res = await api.putPricingOverrides(overrides);
    setPricing(res);
  }

  return {
    today, periodTotals, pricing, priceMap: modelPriceMap(pricing.models),
    records, total, offset, limit: PAGE_SIZE, hasMore: records.length < total,
    summary, groupBy, filters, loading,
    actions: {
      refreshToday, loadPeriodTotals, refreshPricing, loadRecords, loadMore: () => loadRecords(false),
      loadSummary, setFilter, resetFilters, setGroupBy, savePricingOverrides,
    },
  };
}
