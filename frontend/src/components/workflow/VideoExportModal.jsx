import { useState } from 'react';
import { CheckSquare, Download, Square, X } from 'lucide-react';
import { mediaUrl, api } from '../../api/client.js';

/** Scene picker for the Video stage's bulk export (VideoStage.jsx's "export"
 * button): lets the user pick all/some scenes, then downloads a zip built by
 * `GET .../video-export` (`export_video_stage` in `routers/generation_export.py`) -
 * each scene's animate-source picture named `{scene:03d}_{prompt-slug}.ext`
 * plus one `prompts.txt` of every included scene's `motion_prompt`, blank-
 * line separated, in the same order as the images. A scene with no picture
 * at all is flagged inline (still selectable - the server just skips it from
 * the zip) since there's nothing this modal can do about it besides warn. */
export default function VideoExportModal({ L, project, onClose }) {
  const scenes = project.scenes || [];
  const [selected, setSelected] = useState(() => new Set(scenes.map((_, i) => i)));

  const allSelected = selected.size === scenes.length;

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(scenes.map((_, i) => i)));
  }
  function toggleOne(i) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }

  function doExport() {
    const indices = [...selected].sort((a, b) => a - b);
    if (!indices.length) return;
    const url = api.videoExportUrl(project.id, indices);
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{L.video_exportModalTitle}</span>
          <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginBottom: 12 }}>
          {L.video_exportModalSubtitle}
        </div>

        <button
          className="btn btn-accent-soft"
          style={{ padding: '6px 11px', fontSize: 12.5, marginBottom: 10 }}
          onClick={toggleAll}
        >
          {allSelected ? <CheckSquare size={14} /> : <Square size={14} />}
          {L.video_exportSelectAll}
        </button>

        <div style={{ maxHeight: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {scenes.map((s, i) => {
            const thumb = (s.images || []).find((img) => img.is_selected) || s.images?.[0];
            const label = s.scene_description || s.lyric_segment || s.motion_prompt || '';
            const isSelected = selected.has(i);
            return (
              <div
                key={i}
                onClick={() => toggleOne(i)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 8,
                  cursor: 'pointer', background: isSelected ? 'rgba(255,255,255,0.06)' : 'transparent',
                }}
              >
                {isSelected ? <CheckSquare size={16} color="#ff9d5c" /> : <Square size={16} color="var(--text-faint)" />}
                <div style={{ width: 30, height: 30, borderRadius: 6, overflow: 'hidden', flexShrink: 0, background: 'rgba(255,255,255,0.05)' }}>
                  {thumb && (
                    <img src={mediaUrl(`projects/${project.id}/${thumb.file_path}`)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  )}
                </div>
                <span style={{ fontSize: 12.5, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {i + 1}. {label}
                </span>
                {!thumb && <span title={L.video_exportNoImageWarning} style={{ fontSize: 12 }}>⚠️</span>}
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn btn-accent-soft" onClick={onClose}>{L.cancel}</button>
          <button className="btn btn-gradient" onClick={doExport} disabled={!selected.size}>
            <Download size={14} />
            {L.video_exportConfirm.replace('{n}', selected.size)}
          </button>
        </div>
      </div>
    </div>
  );
}
