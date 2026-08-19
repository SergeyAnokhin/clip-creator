import {
  FlaskConical, Loader2, Redo2, Scissors, Undo2, Wand2,
} from 'lucide-react';

/** Bottom row of the side panel: every "do something now" system action in
 * one place instead of split across the timeline toolbar and a separate
 * footer - split/undo/redo (timeline edits) plus test-render/final-render
 * (the render job), all icon-only with a `title` tooltip, matching this
 * app's existing icon-forward toolbar convention. */
export default function EditorBottomToolbar({
  L, actions, canUndo, canRedo, hasClips, renderLoading, renderError, elapsedSeconds, canRender,
  onOpenTestRangeModal,
}) {
  return (
    <div className="editor-bottom-toolbar">
      {!renderLoading && renderError && <div className="editor-side-error">⚠️ {renderError}</div>}
      <div className="editor-bottom-toolbar-row">
        <button className="icon-btn" title={L.editor_toolSplit} onClick={actions.splitAtPlayhead} disabled={!hasClips}>
          <Scissors size={14} />
        </button>
        <button className="icon-btn" title={L.editor_undo} onClick={actions.undo} disabled={!canUndo}>
          <Undo2 size={14} />
        </button>
        <button className="icon-btn" title={L.editor_redo} onClick={actions.redo} disabled={!canRedo}>
          <Redo2 size={14} />
        </button>
        <div className="tl-toolbar-spacer" />
        <button
          className="icon-btn"
          title={renderLoading ? L.editor_renderElapsed.replace('{s}', elapsedSeconds) : L.editor_testRenderButton}
          onClick={onOpenTestRangeModal} disabled={!canRender || renderLoading}
        >
          {renderLoading ? <Loader2 size={14} className="spin" /> : <FlaskConical size={14} />}
        </button>
        <button
          className="icon-btn icon-btn-accent"
          title={renderLoading ? L.editor_renderElapsed.replace('{s}', elapsedSeconds) : L.editor_renderButton}
          onClick={() => actions.startRender({})} disabled={!canRender || renderLoading}
        >
          {renderLoading ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />}
        </button>
      </div>
    </div>
  );
}
