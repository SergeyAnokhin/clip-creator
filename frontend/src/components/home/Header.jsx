import { Feather, Plus, Settings } from 'lucide-react';
import ApiKeysPill from '../ApiKeysPill.jsx';
import UsagePill from '../UsagePill.jsx';
import MiniPlayerWidget from '../MiniPlayerWidget.jsx';
import JobsPill from '../JobsPill.jsx';

export default function Header({
  L, langLabel, apiKeys, onToggleLang, onOpenSettings, onNewWorkflow, usageToday, usagePeriodTotals, onOpenUsage, onLoadUsagePeriodTotals,
  miniPlayerTrack, miniPlayerIsPlaying, onToggleMiniPlayer, jobs,
}) {
  return (
    <div className="home-header">
      <div className="home-logo">
        <span className="home-logo-mark">
          <Feather size={17} />
        </span>
        <span>{L.appName}</span>
      </div>
      <ApiKeysPill L={L} apiKeys={apiKeys} onOpenSettings={onOpenSettings} />
      <JobsPill L={L} jobs={jobs} />
      <MiniPlayerWidget L={L} track={miniPlayerTrack} isPlaying={miniPlayerIsPlaying} onToggle={onToggleMiniPlayer} />
      <UsagePill L={L} today={usageToday} periodTotals={usagePeriodTotals} onOpen={onOpenUsage} onLoadPeriodTotals={onLoadUsagePeriodTotals} />
      <div style={{ flex: 1 }} />
      <button className="btn btn-gradient" onClick={onNewWorkflow}>
        <Plus size={15} />
        {L.newWorkflow}
      </button>
      <button className="btn-ghost" style={{ borderRadius: 20, padding: '8px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1px solid rgba(255,255,255,0.1)' }} onClick={onToggleLang}>
        {langLabel}
      </button>
      <button className="icon-btn" onClick={onOpenSettings}>
        <Settings size={16} />
      </button>
    </div>
  );
}
