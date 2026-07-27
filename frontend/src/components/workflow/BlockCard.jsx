import {
  ChevronDown, ChevronsDown, ChevronsUp, ChevronUp, Copy, CopyPlus, Mic, Parentheses, Scissors, Tag, Tags, Trash2,
} from 'lucide-react';
import { TYPE_COLORS } from '../../i18n/dict.js';
import TypeMenu from './TypeMenu.jsx';
import TagMenu from './TagMenu.jsx';

export default function BlockCard({
  block, L, isEditing, draftContent, typeMenuOpen, cloneMenuOpen, tagMenuOpen, specialTags,
  isRecording, recordingSeconds,
  onMoveUp, onMoveDown, onMoveToStart, onMoveToEnd, onToggleTypeMenu, onSetType, onToggleCloneMenu, onCloneAsType,
  onToggleTagMenu, onInsertTag, onStartVoice,
  onDuplicate, onDelete, onStartEdit, onSaveEdit, onCancelEdit, onDraftChange, onSplitLine, onToggleLineBracket,
}) {
  const stripe = TYPE_COLORS[block.type];
  const lines = block.content.split('\n');

  function handleKeyDown(e) {
    if (isEditing) return;
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
    if (/^[1-9]$/.test(e.key)) {
      const tag = specialTags[Number(e.key) - 1];
      if (tag) {
        e.preventDefault();
        onInsertTag(tag, 'after');
      }
    }
  }

  return (
    <div className="block-card" style={{ '--stripe': stripe }} tabIndex={0} onKeyDown={handleKeyDown}>
      <div className="block-toolbar">
        <div className="block-move">
          <button title={L.moveToStart} onClick={onMoveToStart}><ChevronsUp size={13} /></button>
          <button onClick={onMoveUp}><ChevronUp size={13} /></button>
          <button onClick={onMoveDown}><ChevronDown size={13} /></button>
          <button title={L.moveToEnd} onClick={onMoveToEnd}><ChevronsDown size={13} /></button>
        </div>

        <div style={{ position: 'relative' }}>
          <button className="type-chip" style={{ '--stripe': stripe }} onClick={onToggleTypeMenu}>
            <Tag size={11} />
            {L[`type_${block.type}`]}
          </button>
          {typeMenuOpen && <TypeMenu L={L} onSelect={onSetType} />}
        </div>

        <div style={{ position: 'relative' }}>
          <button className="type-chip type-chip-clone" style={{ '--stripe': stripe }} title={L.cloneAsType} onClick={onToggleCloneMenu}>
            <CopyPlus size={11} />
          </button>
          {cloneMenuOpen && <TypeMenu L={L} onSelect={onCloneAsType} />}
        </div>

        <div style={{ flex: 1 }} />
        <div style={{ position: 'relative' }}>
          <button className="icon-btn" style={{ width: 30, height: 30, opacity: 0.75 }} title={L.specialTags} onClick={onToggleTagMenu}>
            <Tags size={13} />
          </button>
          {tagMenuOpen && <TagMenu L={L} tags={specialTags} onInsert={onInsertTag} />}
        </div>
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
            <div key={i} className="block-line-row">
              <div className="block-line-controls">
                {i < lines.length - 1 && (
                  <button
                    type="button"
                    className="line-icon-btn"
                    title={L.splitLineHint}
                    onClick={(e) => { e.stopPropagation(); onSplitLine(i + 1); }}
                  >
                    <Scissors size={11} />
                  </button>
                )}
                <button
                  type="button"
                  className="line-icon-btn"
                  title={L.toggleBrackets}
                  onClick={(e) => { e.stopPropagation(); onToggleLineBracket(i); }}
                >
                  <Parentheses size={11} />
                </button>
              </div>
              <p className="block-line" onClick={onStartEdit}>{line || ' '}</p>
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
