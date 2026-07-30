import {
  ChevronDown, ChevronsDown, ChevronsUp, ChevronUp, Copy, CopyPlus, Mic, MicOff, Parentheses, Pencil, Scissors, Tag,
  Tags, Trash2, X,
} from 'lucide-react';
import { TYPE_COLORS } from '../../i18n/dict.js';
import TypeMenu from './TypeMenu.jsx';
import TagMenu from './TagMenu.jsx';

export default function BlockCard({
  block, L, isEditing, draftContent, editingLineIndex, lineDraft, typeMenuOpen, cloneMenuOpen, tagMenuOpen, specialTags,
  isRecording, recordingSeconds, voiceSupported,
  onMoveUp, onMoveDown, onMoveToStart, onMoveToEnd, onToggleTypeMenu, onSetType, onToggleCloneMenu, onCloneAsType,
  onToggleTagMenu, onInsertTag, onStartVoice,
  onDuplicate, onDelete, onStartBlockEdit, onSaveEdit, onCancelEdit, onDraftChange, onSplitLine, onToggleLineBracket,
  onStartLineEdit, onSaveLineEdit, onCancelLineEdit, onLineDraftChange, onDuplicateLine, onDeleteLine,
}) {
  const stripe = TYPE_COLORS[block.type];
  const lines = block.content.split('\n');
  const isInterlude = block.type === 'interlude';
  const anyMenuOpen = typeMenuOpen || cloneMenuOpen || tagMenuOpen;
  const chipLabel = isInterlude ? block.content.replace(/^\[|\]$/g, '') : L[`type_${block.type}`];

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

  function handleLineInputKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSaveLineEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancelLineEdit();
    }
  }

  return (
    <div className={`block-card${isInterlude ? ' block-card-tag' : ''}${anyMenuOpen ? ' block-card-menu-open' : ''}`} style={{ '--stripe': stripe }} tabIndex={0} onKeyDown={handleKeyDown}>
      <div className={`block-move${isInterlude ? ' block-move-compact' : ''}`}>
        {!isInterlude && <button title={L.moveToStart} onClick={onMoveToStart}><ChevronsUp size={13} /></button>}
        <button onClick={onMoveUp}><ChevronUp size={13} /></button>
        <button onClick={onMoveDown}><ChevronDown size={13} /></button>
        {!isInterlude && <button title={L.moveToEnd} onClick={onMoveToEnd}><ChevronsDown size={13} /></button>}
      </div>

      <div className="block-body">
        <div className="block-toolbar">
          <div style={{ position: 'relative' }}>
            <button className="type-chip" style={{ '--stripe': stripe }} onClick={onToggleTypeMenu}>
              <Tag size={11} />
              {chipLabel}
            </button>
            {typeMenuOpen && <TypeMenu L={L} onSelect={onSetType} />}
          </div>

          {!isInterlude && (
            <div style={{ position: 'relative' }}>
              <button className="type-chip type-chip-clone" style={{ '--stripe': stripe }} title={L.cloneAsType} onClick={onToggleCloneMenu}>
                <CopyPlus size={11} />
              </button>
              {cloneMenuOpen && <TypeMenu L={L} onSelect={onCloneAsType} />}
            </div>
          )}

          <div style={{ flex: 1 }} />
          <div style={{ position: 'relative' }}>
            <button className="icon-btn" style={{ width: 30, height: 30, opacity: 0.75 }} title={L.specialTags} onClick={onToggleTagMenu}>
              <Tags size={13} />
            </button>
            {tagMenuOpen && <TagMenu L={L} tags={specialTags} onInsert={onInsertTag} />}
          </div>
          {!isInterlude && voiceSupported && (
            <button
              className={`icon-btn${isRecording ? ' icon-btn-recording' : ''}`}
              style={{ width: 30, height: 30, opacity: isRecording ? 1 : 0.75 }}
              title={L.voiceEdit}
              onClick={onStartVoice}
            >
              {isRecording ? <MicOff size={13} /> : <Mic size={13} />}
            </button>
          )}
          {!isInterlude && (
            <button className="icon-btn" style={{ width: 30, height: 30, opacity: 0.75 }} title={L.editWholeBlock} onClick={onStartBlockEdit}>
              <Pencil size={13} />
            </button>
          )}
          <button className="icon-btn" style={{ width: 30, height: 30, opacity: 0.75 }} title={L.duplicate} onClick={onDuplicate}>
            <Copy size={13} />
          </button>
          <button className="icon-btn icon-btn-danger" style={{ width: 30, height: 30, opacity: 0.75 }} title={L.delete} onClick={onDelete}>
            <Trash2 size={13} />
          </button>
        </div>

        {isInterlude ? null : isEditing ? (
          <>
            <textarea
              className="block-textarea"
              value={draftContent}
              onChange={(e) => onDraftChange(e.target.value)}
              rows={Math.max(draftContent.split('\n').length, 2)}
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
                  <button
                    type="button"
                    className="line-icon-btn"
                    style={{ visibility: i < lines.length - 1 ? 'visible' : 'hidden' }}
                    title={L.splitLineHint}
                    onClick={(e) => { e.stopPropagation(); onSplitLine(i + 1); }}
                  >
                    <Scissors size={11} />
                  </button>
                  <button
                    type="button"
                    className="line-icon-btn"
                    title={L.duplicateLineHint}
                    onClick={(e) => { e.stopPropagation(); onDuplicateLine(i); }}
                  >
                    <Copy size={11} />
                  </button>
                  <button
                    type="button"
                    className="line-icon-btn"
                    title={L.toggleBrackets}
                    onClick={(e) => { e.stopPropagation(); onToggleLineBracket(i); }}
                  >
                    <Parentheses size={11} />
                  </button>
                </div>
                {editingLineIndex === i ? (
                  <input
                    type="text"
                    className="block-line-input"
                    value={lineDraft}
                    autoFocus
                    onChange={(e) => onLineDraftChange(e.target.value)}
                    onKeyDown={handleLineInputKeyDown}
                    onBlur={onSaveLineEdit}
                  />
                ) : (
                  <p className="block-line" onClick={() => onStartLineEdit(i, line)}>{line || ' '}</p>
                )}
                <button
                  type="button"
                  className="line-icon-btn line-icon-btn-danger"
                  title={L.deleteLineHint}
                  onClick={(e) => { e.stopPropagation(); onDeleteLine(i); }}
                >
                  <X size={12} />
                </button>
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
    </div>
  );
}
