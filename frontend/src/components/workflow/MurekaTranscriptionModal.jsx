import { createPortal } from 'react-dom';
import { Download, X } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';
import JsonTreeView from '../common/JsonTreeView.jsx';
import { onBackdropClick } from '../../lib/a11y.js';

/** Visualizes the result of `song/transcribe` (MusicXML + PDF, zipped - see
 * providers/mureka.py) for one track. There's no in-app notation renderer,
 * so the "visualization" here is a direct download link to the zip Mureka
 * generated (already downloaded to disk server-side, see data-model.md's
 * `transcriptions[]`) plus the raw response for anyone who wants to look. */
export default function MurekaTranscriptionModal({ L, projectId, track, onClose }) {
  if (!track) return null;
  const entries = track.transcriptions || [];
  const latest = entries[entries.length - 1];
  const older = entries.slice(0, -1).reverse();

  return createPortal(
    <div className="modal-backdrop" role="presentation" onClick={onBackdropClick(onClose)}>
      <div className="modal-card" style={{ maxWidth: 480 }}>
        <div className="modal-header">
          <span>{L.mureka_transcribeModalTitle}</span>
          <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        {!latest ? (
          <div className="mureka-detail-empty">{L.mureka_describeNoData}</div>
        ) : (
          <div className="mureka-insight-body">
            <a
              className="btn btn-accent-soft mureka-insight-download"
              href={mediaUrl(`projects/${projectId}/${latest.file_path}`)} target="_blank" rel="noreferrer"
            >
              <Download size={14} /> {L.mureka_transcribeDownloadBtn}
            </a>
            <div className="mureka-insight-hint">{L.mureka_transcribeHint}</div>

            {!!older.length && (
              <details>
                <summary>{L.mureka_historyLabel} ({older.length})</summary>
                {older.map((entry) => (
                  <a
                    key={entry.id} className="mureka-insight-history-link"
                    href={mediaUrl(`projects/${projectId}/${entry.file_path}`)} target="_blank" rel="noreferrer"
                  >
                    {entry.created_at?.slice(0, 16).replace('T', ' ') || entry.id}
                  </a>
                ))}
              </details>
            )}

            <details>
              <summary>{L.mureka_detailsRaw}</summary>
              <div className="json-tree-scroll">
                <JsonTreeView L={L} data={entries} />
              </div>
            </details>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
