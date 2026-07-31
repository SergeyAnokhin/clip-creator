import { Coins } from 'lucide-react';
import { formatCost } from '../lib/pricing.js';

/** Shared "spend today" indicator for the three screen headers (home,
 * workflow, settings). Clicking it opens the Usage screen. */
export default function UsagePill({ L, today, onOpen }) {
  return (
    <button
      className="pill pill-neutral"
      style={{ cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }}
      onClick={onOpen}
      title={L.usage_todayTitle}
    >
      <Coins size={12} />
      {formatCost(today?.cost)}
    </button>
  );
}
