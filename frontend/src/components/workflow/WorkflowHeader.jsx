import { ArrowLeft, Menu, Settings } from 'lucide-react';

export default function WorkflowHeader({ L, langLabel, title, author, onGoHome, onToggleSidebar, onToggleLang, onOpenSettings }) {
  return (
    <div className="workflow-header">
      <button className="icon-btn" style={{ width: 36, height: 36 }} onClick={onGoHome}>
        <ArrowLeft size={16} />
      </button>
      <button className="icon-btn" style={{ width: 36, height: 36 }} onClick={onToggleSidebar}>
        <Menu size={16} />
      </button>
      <div className="workflow-title">
        {title}
        <span className="workflow-title-author"> — {author}</span>
      </div>
      <div style={{ flex: 1 }} />
      <button
        className="btn-ghost"
        style={{ borderRadius: 20, padding: '7px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1px solid rgba(255,255,255,0.1)', flexShrink: 0 }}
        onClick={onToggleLang}
      >
        {langLabel}
      </button>
      <button className="icon-btn" style={{ width: 36, height: 36 }} onClick={onOpenSettings}>
        <Settings size={16} />
      </button>
    </div>
  );
}
