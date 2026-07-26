import { Feather, Plus, Settings } from 'lucide-react';

export default function Header({ L, langLabel, onToggleLang, onOpenSettings, onNewWorkflow }) {
  return (
    <div className="home-header">
      <div className="home-logo">
        <span className="home-logo-mark">
          <Feather size={17} />
        </span>
        <span>{L.appName}</span>
      </div>
      <div className="pill pill-success">
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#4ade80', boxShadow: '0 0 6px #4ade80' }} />
        {L.apiConnected}
      </div>
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
