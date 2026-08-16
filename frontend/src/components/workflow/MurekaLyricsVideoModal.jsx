import { createPortal } from 'react-dom';
import { Download, X } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';
import JsonTreeView from '../common/JsonTreeView.jsx';
import { onBackdropClick } from '../../lib/a11y.js';

/** Visualizes the result of `lyrics-video/generate` (a karaoke-style mp4 -
 * see providers/mureka.py) for one track: an embedded player for the newest
 * result (already downloaded to disk server-side, see data-model.md's
 * `lyrics_videos[]`), a download link, and the raw response. */
export default function MurekaLyricsVideoModal({ L, projectId, track, onClose }) {
  if (!track) return null;
  const entries = track.lyrics_videos || [];
  const latest = entries[entries.length - 1];
  const older = entries.slice(0, -1).reverse();

  return createPortal(
    <div className="modal-backdrop" role="presentation" onClick={onBackdropClick(onClose)}>
      <div className="modal-card" style={{ maxWidth: 420 }}>
        <div className="modal-header">
          <span>{L.mureka_lyricsVideoModalTitle}</span>
          <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        {!latest ? (
          <div className="mureka-detail-empty">{L.mureka_describeNoData}</div>
        ) : (
          <div className="mureka-insight-body">
            <video
              className="mureka-insight-video" controls
              src={mediaUrl(`projects/${projectId}/${latest.file_path}`)}
            />
            <a
              className="btn btn-accent-soft mureka-insight-download"
              href={mediaUrl(`projects/${projectId}/${latest.file_path}`)} target="_blank" rel="noreferrer"
            >
              <Download size={14} /> {L.mureka_lyricsVideoDownloadBtn}
            </a>

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
