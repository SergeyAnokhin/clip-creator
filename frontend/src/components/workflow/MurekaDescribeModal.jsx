import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import JsonTreeView from '../common/JsonTreeView.jsx';
import { onBackdropClick } from '../../lib/a11y.js';

/** Visualizes the result of `song/describe` (genre/instruments/mood - see
 * providers/mureka.py) for one track. `track.descriptions[]` is append-only
 * (see data-model.md), so repeat calls build up a small history instead of
 * replacing the previous result - this modal always highlights the newest
 * entry and lists any earlier ones underneath. */
export default function MurekaDescribeModal({ L, track, onClose }) {
  if (!track) return null;
  const entries = track.descriptions || [];
  const latest = entries[entries.length - 1];
  const older = entries.slice(0, -1).reverse();

  return createPortal(
    <div className="modal-backdrop" role="presentation" onClick={onBackdropClick(onClose)}>
      <div className="modal-card" style={{ maxWidth: 560 }}>
        <div className="modal-header">
          <span>{L.mureka_describeModalTitle}</span>
          <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        {!latest ? (
          <div className="mureka-detail-empty">{L.mureka_describeNoData}</div>
        ) : (
          <div className="mureka-insight-body">
            {!!latest.genres?.length && (
              <div className="mureka-insight-chip-row">
                <div className="mureka-insight-chip-label">{L.mureka_describeGenres}</div>
                <div className="mureka-insight-chips">
                  {latest.genres.map((g) => <span key={g} className="chip">{g}</span>)}
                </div>
              </div>
            )}
            {!!latest.instrument?.length && (
              <div className="mureka-insight-chip-row">
                <div className="mureka-insight-chip-label">{L.mureka_describeInstruments}</div>
                <div className="mureka-insight-chips">
                  {latest.instrument.map((i) => <span key={i} className="chip">{i}</span>)}
                </div>
              </div>
            )}
            {!!latest.tags?.length && (
              <div className="mureka-insight-chip-row">
                <div className="mureka-insight-chip-label">{L.mureka_describeTags}</div>
                <div className="mureka-insight-chips">
                  {latest.tags.map((t) => <span key={t} className="chip">{t}</span>)}
                </div>
              </div>
            )}
            {latest.description && <p className="mureka-insight-description">{latest.description}</p>}

            {!!older.length && (
              <details>
                <summary>{L.mureka_historyLabel} ({older.length})</summary>
                {older.map((entry) => (
                  <p key={entry.id} className="mureka-insight-description" style={{ opacity: 0.7 }}>
                    {entry.description || [...(entry.genres || []), ...(entry.tags || [])].join(', ')}
                  </p>
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
