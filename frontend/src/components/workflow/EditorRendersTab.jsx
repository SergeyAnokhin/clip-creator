import { Download, Trash2 } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';

function formatSeconds(ms) {
  return (ms / 1000).toFixed(1);
}
function formatTime(ms) {
  const s = Math.max(0, ms / 1000);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

/** "Готовые видео" tab - the finished-renders list, moved verbatim out of
 * EditorStage.jsx. EditorSidePanel.jsx auto-switches here whenever
 * `videoEdit.renders` grows (a test or final render just finished). */
export default function EditorRendersTab({ L, projectId, renders, actions }) {
  const list = [...renders].reverse();
  return (
    <div className="editor-side-block editor-side-renders">
      {!list.length && <div className="editor-side-dim">{L.editor_renderEmpty}</div>}
      {list.map((r) => (
        <div key={r.render_id} className="editor-render-row">
          <video src={mediaUrl(`projects/${projectId}/${r.file_path}`)} controls />
          <div className="editor-render-meta">
            {r.kind === 'test' && <span className="editor-render-badge">{L.editor_testRenderBadge}</span>}
            {new Date(r.created_at).toLocaleString()} · {formatSeconds(r.duration_ms)}s · {r.clip_count} {L.editor_clipsCountLabel}
            {r.range && ` · ${formatTime(r.range.start_ms)}–${formatTime(r.range.end_ms)}`}
          </div>
          <div className="editor-render-actions">
            <button className="icon-btn" title={L.editor_renderDownload} onClick={() => actions.downloadRender(r)}>
              <Download size={14} />
            </button>
            <button className="icon-btn icon-btn-danger" title={L.editor_renderDelete} onClick={() => actions.deleteRender(r.render_id)}>
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
