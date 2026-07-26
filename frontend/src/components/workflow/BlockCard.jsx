import { ChevronDown, ChevronUp, Copy, Mic, Scissors, Star, Tag, Trash2 } from 'lucide-react';
import { TYPE_COLORS } from '../../i18n/dict.js';
import TypeMenu from './TypeMenu.jsx';

function starColor(importance) {
  if (importance <= 2) return 'rgba(255,255,255,0.4)';
  if (importance === 3) return '#fbbf24';
  if (importance === 4) return '#fb923c';
  return '#f87171';
}

export default function BlockCard({
  block, L, isEditing, draftContent, typeMenuOpen, isRecording, recordingSeconds,
  onMoveUp, onMoveDown, onToggleTypeMenu, onSetType, onCycleImportance, onStartVoice,
  onDuplicate, onDelete, onStartEdit, onSaveEdit, onCancelEdit, onDraftChange, onSplitLine,
}) {
  const stripe = TYPE_COLORS[block.type];
  const lines = block.content.split('\n');

  return (
    <div className="block-card" style={{ '--stripe': stripe }}>
      <div className="block-toolbar">
        <div className="block-move">
          <button onClick={onMoveUp}><ChevronUp size={13} /></button>
          <button onClick={onMoveDown}><ChevronDown size={13} /></button>
        </div>

        <div style={{ position: 'relative' }}>
          <button className="type-chip" style={{ '--stripe': stripe }} onClick={onToggleTypeMenu}>
            <Tag size={11} />
            {L[`type_${block.type}`]}
          </button>
          {typeMenuOpen && <TypeMenu L={L} onSelect={onSetType} />}
        </div>

        <button className="importance-btn" style={{ color: starColor(block.importance) }} onClick={onCycleImportance}>
          {L.importance} {block.importance}
          <Star size={12} />
        </button>

        <div style={{ flex: 1 }} />
        <button className="icon-btn" style={{ width: 30, height: 30, opacity: 0.75 }} title={L.voiceEdit} onClick={onStartVoice}>
          <Mic size={13} />
        </button>
        <button className="icon-btn" style={{ width: 30, height: 30, opacity: 0.75 }} title={L.duplicate} onClick={onDuplicate}>
          <Copy size={13} />
        </button>
        <button className="icon-btn icon-btn-danger" style={{ width: 30, height: 30, opacity: 0.75 }} title={L.delete} onClick={onDelete}>
          <Trash2 size={13} />
        </button>
      </div>

      {isEditing ? (
        <>
          <textarea
            className="block-textarea"
            value={draftContent}
            onChange={(e) => onDraftChange(e.target.value)}
            autoFocus
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn btn-gradient" style={{ padding: '6px 16px' }} onClick={onSaveEdit}>{L.save}</button>
            <button className="btn-ghost" style={{ padding: '6px 16px', borderRadius: 8, border: 'none', cursor: 'pointer' }} onClick={onCancelEdit}>{L.cancel}</button>
          </div>
        </>
      ) : (
        <div className="block-lines">
          {lines.map((line, i) => (
            <div key={i}>
              <p className="block-line" onClick={onStartEdit}>{line || ' '}</p>
              {i < lines.length - 1 && (
                <button
                  type="button"
                  className="line-split-btn"
                  title={L.splitLineHint}
                  onClick={(e) => { e.stopPropagation(); onSplitLine(i + 1); }}
                >
                  <Scissors size={10} />
                  {L.splitLineHint}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {isRecording && (
        <div className="recording-banner">
          <span className="recording-dot" />
          {L.recording} · {recordingSeconds}s
        </div>
      )}
    </div>
  );
}
