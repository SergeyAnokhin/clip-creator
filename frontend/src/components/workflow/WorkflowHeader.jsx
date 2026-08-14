import { useState } from 'react';
import { ArrowLeft, Menu, Settings } from 'lucide-react';
import UsagePill from '../UsagePill.jsx';
import MiniPlayerWidget from '../MiniPlayerWidget.jsx';

/** Click-to-edit span: shows plain text, swaps to an input on click, commits
 * on blur/Enter (Escape reverts). Used for the project title and author in
 * the workflow header, which are otherwise only ever set once at creation
 * (from URL parsing, or left as placeholders for manual text entry). */
function EditableField({ value, placeholder, onCommit }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  function startEdit() {
    setDraft(value);
    setEditing(true);
  }
  function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onCommit(trimmed);
  }

  if (editing) {
    return (
      <input
        autoFocus
        className="workflow-title-input"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') { setDraft(value); setEditing(false); }
        }}
      />
    );
  }
  return (
    <span className="workflow-title-editable" onClick={startEdit} title={placeholder}>
      {value || placeholder}
    </span>
  );
}

export default function WorkflowHeader({
  L, langLabel, title, author, onGoHome, onToggleSidebar, onToggleLang, onOpenSettings,
  onChangeTitle, onChangeAuthor, usageToday, usagePeriodTotals, onOpenUsage, onLoadUsagePeriodTotals,
  miniPlayerTrack, miniPlayerIsPlaying, onToggleMiniPlayer,
}) {
  return (
    <div className="workflow-header">
      <button className="icon-btn" style={{ width: 36, height: 36 }} onClick={onGoHome}>
        <ArrowLeft size={16} />
      </button>
      <button className="icon-btn" style={{ width: 36, height: 36 }} onClick={onToggleSidebar}>
        <Menu size={16} />
      </button>
      <div className="workflow-title">
        <EditableField value={title} placeholder={L.workflowTitlePlaceholder} onCommit={onChangeTitle} />
        <span className="workflow-title-author">
          {' — '}
          <EditableField value={author} placeholder={L.workflowAuthorPlaceholder} onCommit={onChangeAuthor} />
        </span>
      </div>
      <div style={{ flex: 1 }} />
      <MiniPlayerWidget L={L} track={miniPlayerTrack} isPlaying={miniPlayerIsPlaying} onToggle={onToggleMiniPlayer} />
      <UsagePill L={L} today={usageToday} periodTotals={usagePeriodTotals} onOpen={onOpenUsage} onLoadPeriodTotals={onLoadUsagePeriodTotals} />
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
