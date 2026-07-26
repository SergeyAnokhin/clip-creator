import { Plus } from 'lucide-react';
import BlockCard from './BlockCard.jsx';
import { compileLyrics, formatLyrics } from '../../lib/lyrics.js';

export default function LyricsStage({
  L, project, editingBlockId, draftContent, openMenuTypeBlockId,
  recordingBlockId, recordingSeconds, actions,
}) {
  const preview = formatLyrics(
    compileLyrics(project.blocks, project.auto_repeat_chorus),
    (type) => L[`type_${type}`],
  );

  return (
    <>
      <div className="stage-heading">
        <div>
          <div className="stage-heading-title">{L.lyricsStageTitle}</div>
          <div className="stage-heading-subtitle">{L.lyricsStageSubtitle}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>{L.autoRepeatChorus}</span>
            <div className={`toggle${project.auto_repeat_chorus ? ' is-on' : ''}`} onClick={actions.toggleAutoRepeat}>
              <div className="toggle-knob" />
            </div>
          </div>
          <button className="btn btn-accent-soft" onClick={actions.addBlock}>
            <Plus size={14} />
            {L.addBlock}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {project.blocks.map((block) => (
          <BlockCard
            key={block.id}
            block={block}
            L={L}
            isEditing={editingBlockId === block.id}
            draftContent={draftContent}
            typeMenuOpen={openMenuTypeBlockId === block.id}
            isRecording={recordingBlockId === block.id}
            recordingSeconds={recordingSeconds}
            onMoveUp={() => actions.moveBlock(block.id, -1)}
            onMoveDown={() => actions.moveBlock(block.id, 1)}
            onToggleTypeMenu={() => actions.toggleTypeMenu(block.id)}
            onSetType={(type) => actions.setBlockType(block.id, type)}
            onCycleImportance={() => actions.cycleImportance(block.id)}
            onStartVoice={() => actions.startVoice('block', block.id)}
            onDuplicate={() => actions.duplicateBlock(block.id)}
            onDelete={() => actions.deleteBlock(block.id)}
            onStartEdit={() => actions.startEditBlock(block.id, block.content)}
            onSaveEdit={actions.saveEditBlock}
            onCancelEdit={actions.cancelEditBlock}
            onDraftChange={actions.setDraftContent}
            onSplitLine={(lineIndex) => actions.splitBlock(block.id, lineIndex)}
          />
        ))}
      </div>

      <div className="compiled-preview">
        <div className="compiled-preview-label">{L.compiledPreview}</div>
        <pre>{preview}</pre>
      </div>
    </>
  );
}
