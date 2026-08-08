import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';
import { currentLineIndex, flattenLyricsLines, isBeyondKnownTiming } from '../../lib/lyricsTiming.js';
import JsonTreeView from '../common/JsonTreeView.jsx';

/** `1:02.340` - line/word timestamps shown with millisecond precision (the
 * compact karaoke panel only needs whole lines, but this view is exactly
 * where "why did this line fire early/late" gets debugged, so the raw
 * number matters). */
function formatMs(ms) {
  if (ms == null) return '—';
  const totalMs = Math.max(0, Math.round(ms));
  const s = Math.floor(totalMs / 1000);
  const m = Math.floor(s / 60);
  const rem = String(s % 60).padStart(2, '0');
  const millis = String(totalMs % 1000).padStart(3, '0');
  return `${m}:${rem}.${millis}`;
}

/** Fullscreen-ish companion to KaraokeLyrics.jsx's compact panel - opened
 * from TrackCard's "expand" button (MurekaStage.jsx) for one track at a
 * time. Where the compact panel only ever shows a few lines of context,
 * this renders the *entire* `flattenLyricsLines` timeline (sections, every
 * line, including interpolated/instrumental placeholder rows - see
 * lib/lyricsTiming.js) alongside a synced player and the rest of the
 * track's raw Mureka metadata, so the underlying data - not just the
 * karaoke-relevant slice of it - can actually be inspected.
 *
 * Deliberately renders `line.text`, never `line.words[].text`: checked
 * against a real generated track's raw response and Mureka's per-line
 * `words[]` array is offset by one line from that line's own `text` (each
 * line's `words` actually spell out the *previous* line's text - a data
 * quality issue in what the API returns, not a parsing bug here). Only
 * `words[].start`/`.end` would be usable, and per-word highlighting isn't
 * worth the complexity without trustworthy word text to show alongside it -
 * the raw `words` arrays are still fully visible in the JSON tree below for
 * anyone who wants to look. */
export default function MurekaTrackDetailModal({ L, projectId, track, index, onClose }) {
  const audioRef = useRef(null);
  const activeRowRef = useRef(null);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const rows = useMemo(() => flattenLyricsLines(track?.raw), [track]);

  const pastKnownTiming = isBeyondKnownTiming(rows, currentTimeMs);
  const activeIdx = pastKnownTiming ? -1 : currentLineIndex(rows, currentTimeMs);

  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeIdx]);

  useEffect(() => {
    function onKeyDown(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  if (!track) return null;

  function seekTo(ms) {
    if (audioRef.current && ms != null) audioRef.current.currentTime = ms / 1000;
  }

  const grouped = [];
  let lastSectionType;
  let sawSectionHeader = false;
  rows.forEach((row, i) => {
    if (row.sectionType !== lastSectionType || !sawSectionHeader) {
      grouped.push({ kind: 'header', sectionType: row.sectionType, key: `h${i}` });
      lastSectionType = row.sectionType;
      sawSectionHeader = true;
    }
    grouped.push({ kind: 'row', row, i, key: i });
  });

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card modal-card-lg mureka-detail-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{L.mureka_tracksLabel} {index + 1}{track.style ? ` — ${track.style}` : ''}</span>
          <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <audio
          ref={audioRef} className="mureka-track-audio" controls
          src={mediaUrl(`projects/${projectId}/${track.file_path}`)}
          onTimeUpdate={() => setCurrentTimeMs((audioRef.current?.currentTime || 0) * 1000)}
        />

        {!!rows.length && track.duration_ms > rows[rows.length - 1].end + 1000 && (
          <div className="mureka-detail-coverage-hint">
            ⚠ {L.mureka_detailPartialCoverage.replace('{time}', formatMs(rows[rows.length - 1].end))}
          </div>
        )}

        <div className="mureka-detail-body">
          <div className="mureka-detail-timeline">
            {!rows.length && <div className="mureka-detail-empty">{L.mureka_detailNoTiming}</div>}
            {grouped.map((item) => (item.kind === 'header' ? (
              <div key={item.key} className="mureka-detail-section-header">
                {item.sectionType || L.mureka_karaokeInstrumental}
              </div>
            ) : (
              <div
                key={item.key}
                ref={item.i === activeIdx ? activeRowRef : undefined}
                className={`mureka-detail-line${item.i === activeIdx ? ' is-current' : ''}${item.row.isSection ? ' is-instrumental' : ''}`}
                onClick={() => seekTo(item.row.start)}
              >
                <span className="mureka-detail-line-time">{formatMs(item.row.start)}</span>
                <span className="mureka-detail-line-text">
                  {item.row.isSection ? `♪ ${item.row.sectionType || L.mureka_karaokeInstrumental}` : item.row.text}
                </span>
                {item.row.interpolated && <span className="mureka-detail-line-approx" title={L.mureka_detailInterpolatedHint}>~</span>}
              </div>
            )))}
          </div>

          <div className="mureka-detail-meta">
            <div className="mureka-detail-meta-row"><b>{L.mureka_detailsModel}:</b> {track.model}</div>
            <div className="mureka-detail-meta-row"><b>{L.mureka_detailDuration}:</b> {formatMs(track.duration_ms)}</div>
            {track.raw?.id && <div className="mureka-detail-meta-row"><b>{L.mureka_detailSongId}:</b> {track.raw.id}</div>}
            {track.raw?.index != null && <div className="mureka-detail-meta-row"><b>{L.mureka_detailChoiceIndex}:</b> {track.raw.index}</div>}
            <div className="mureka-detail-meta-row"><b>{L.mureka_detailsStyle}:</b> {track.style || '—'}</div>
            {!!track.stems?.length && (
              <div className="mureka-detail-meta-row">
                <b>{L.mureka_detailsStems}:</b>{' '}
                {track.stems.map((s) => (
                  <a key={s.id} href={mediaUrl(`projects/${projectId}/${s.file_path}`)} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>
                    {L.mureka_downloadStemsLink} ({s.model || 'default'})
                  </a>
                ))}
              </div>
            )}
            <details open>
              <summary>{L.mureka_detailsLyrics}</summary>
              <pre className="mureka-detail-lyrics-pre">{track.lyrics}</pre>
            </details>
            <details>
              <summary>{L.mureka_detailsRaw}</summary>
              <div className="json-tree-scroll">
                <JsonTreeView data={track.raw} />
              </div>
            </details>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
