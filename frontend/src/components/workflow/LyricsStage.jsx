import { Plus } from 'lucide-react';
import BlockCard from './BlockCard.jsx';
import { compileLyrics, formatLyrics } from '../../lib/lyrics.js';

export default function LyricsStage({
  L, project, viewport, editingBlockId, draftContent,
  openMenuTypeBlockId, openMenuCloneBlockId, openTagMenuBlockId, specialTags, splitGroupSize,
  editingLineBlockId, editingLineIndex, lineDraft,
  recordingBlockId, recordingSeconds, voiceSupported, actions,
}) {
  const preview = formatLyrics(
    compileLyrics(project.blocks),
    (type) => L[`type_${type}`],
  );
  const isDesktop = viewport === 'desktop';
  const hasChorus = project.blocks.some((b) => b.type === 'chorus');
  const isSingleBlock = project.blocks.length === 1;

  const blockList = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: isDesktop ? '1 1 55%' : undefined }}>
      {isSingleBlock && (
        <div className="split-groups-row">
          <span>{L.splitIntoGroupsLabel}</span>
          <select
            className="field"
            style={{ width: 70 }}
            value={splitGroupSize}
            onChange={(e) => actions.setSplitGroupSize(Number(e.target.value))}
          >
            {Array.from({ length: 9 }, (_, i) => i + 2).map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <button
            className="btn btn-accent-soft"
            onClick={() => actions.splitIntoGroups(project.blocks[0].id, splitGroupSize)}
          >
            {L.splitIntoGroupsAction}
          </button>
        </div>
      )}

      {project.blocks.map((block) => (
        <BlockCard
          key={block.id}
          block={block}
          L={L}
          isEditing={editingBlockId === block.id}
          draftContent={draftContent}
          editingLineIndex={editingLineBlockId === block.id ? editingLineIndex : null}
          lineDraft={lineDraft}
          typeMenuOpen={openMenuTypeBlockId === block.id}
          cloneMenuOpen={openMenuCloneBlockId === block.id}
          tagMenuOpen={openTagMenuBlockId === block.id}
          specialTags={specialTags}
          isRecording={recordingBlockId === block.id}
          recordingSeconds={recordingSeconds}
          voiceSupported={voiceSupported}
          onMoveUp={() => actions.moveBlock(block.id, -1)}
          onMoveDown={() => actions.moveBlock(block.id, 1)}
          onMoveToStart={() => actions.moveBlockToEdge(block.id, 'start')}
          onMoveToEnd={() => actions.moveBlockToEdge(block.id, 'end')}
          onToggleTypeMenu={() => actions.toggleTypeMenu(block.id)}
          onSetType={(type) => actions.setBlockType(block.id, type)}
          onToggleCloneMenu={() => actions.toggleCloneMenu(block.id)}
          onCloneAsType={(type) => actions.cloneBlockAsType(block.id, type)}
          onToggleTagMenu={() => actions.toggleTagMenu(block.id)}
          onInsertTag={(tagText, position) => actions.insertTagBlock(block.id, tagText, position)}
          onStartVoice={() => actions.startVoice('block', block.id)}
          onDuplicate={() => actions.duplicateBlock(block.id)}
          onDelete={() => actions.deleteBlock(block.id)}
          onStartBlockEdit={() => actions.startEditBlock(block.id, block.content)}
          onSaveEdit={actions.saveEditBlock}
          onCancelEdit={actions.cancelEditBlock}
          onDraftChange={actions.setDraftContent}
          onSplitLine={(lineIndex) => actions.splitBlock(block.id, lineIndex)}
          onToggleLineBracket={(lineIndex) => actions.toggleLineBracket(block.id, lineIndex)}
          onStartLineEdit={(lineIndex, content) => actions.startEditLine(block.id, lineIndex, content)}
          onSaveLineEdit={actions.saveEditLine}
          onCancelLineEdit={actions.cancelEditLine}
          onLineDraftChange={actions.setLineDraft}
          onDuplicateLine={(lineIndex) => actions.duplicateLine(block.id, lineIndex)}
          onDeleteLine={(lineIndex) => actions.deleteLine(block.id, lineIndex)}
        />
      ))}
    </div>
  );

  const previewPanel = (
    <div className={`compiled-preview${isDesktop ? ' compiled-preview-inline' : ''}`} style={isDesktop ? { flex: '1 1 45%' } : undefined}>
      <div className="compiled-preview-label">{L.compiledPreview}</div>
      <pre>{preview}</pre>
    </div>
  );

  return (
    <>
      <div className="stage-heading">
        <div>
          <div className="stage-heading-title">{L.lyricsStageTitle}</div>
          <div className="stage-heading-subtitle">{L.lyricsStageSubtitle}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {hasChorus && (
            <button className="btn btn-accent-soft" onClick={actions.repeatChorus}>
              {L.repeatChorusAction}
            </button>
          )}
          <button className="btn btn-accent-soft" onClick={actions.addBlock}>
            <Plus size={14} />
            {L.addBlock}
          </button>
        </div>
      </div>

      {isDesktop ? (
        <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
          {blockList}
          {previewPanel}
        </div>
      ) : (
        <>
          {blockList}
          {previewPanel}
        </>
      )}
    </>
  );
}
