import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Crosshair, TrendingDown, TrendingUp, X } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';
import {
  applyManualAnchors, currentLineIndex, flattenLyricsLines, isBeyondKnownTiming, isTappableLine, lastKnownEnd,
} from '../../lib/lyricsTiming.js';
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

const EMPTY_SYNC = { anchors: {}, tempo_marks: [] };

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
 * anyone who wants to look.
 *
 * Manual sync correction: `lyrics_sections` timing has been confirmed to
 * drift from the track's true start by an amount that can't be derived from
 * the API response (see docs/data-model.md), so the "Моя" column lets the
 * user tap a sung line's actual start while listening (`track.karaoke_sync.
 * anchors`, `lib/lyricsTiming.js`'s `applyManualAnchors`) - not every line
 * needs a tap, just enough to bracket each verse/chorus; everything between
 * anchors is scaled from Mureka's own relative spacing, and this corrected
 * timeline (not the raw one) is what drives the "current line" highlight.
 * A separate, independent set of manual markers (`track.karaoke_sync.
 * tempo_marks`, ↑/↓ hotkeys) flags where the track's tempo audibly changes -
 * unrelated to line timing, just recorded alongside it for reference. Both
 * persist through `onSetKaraokeSync` (MurekaStage.jsx → useMurekaStage.js's
 * `setKaraokeSync`, the same generic whole-project-PATCH path as rating/tag
 * edits - no dedicated backend endpoint). */
export default function MurekaTrackDetailModal({
  L, projectId, projectTitle, projectAuthor, track, index, onClose, onSetKaraokeSync,
}) {
  const audioRef = useRef(null);
  const activeRowRef = useRef(null);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const rows = useMemo(() => flattenLyricsLines(track?.raw), [track]);
  const sync = track?.karaoke_sync || EMPTY_SYNC;
  const anchors = sync.anchors || {};
  const tempoMarks = sync.tempo_marks || [];
  const appliedRows = useMemo(() => applyManualAnchors(rows, anchors), [rows, anchors]);
  const effectiveRows = useMemo(
    () => appliedRows.map((r) => ({ ...r, start: r.adjustedStart, end: r.adjustedEnd })),
    [appliedRows],
  );
  const coverageEnd = lastKnownEnd(rows);

  const pastKnownTiming = isBeyondKnownTiming(effectiveRows, currentTimeMs);
  const activeIdx = pastKnownTiming ? -1 : currentLineIndex(effectiveRows, currentTimeMs);

  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeIdx]);

  function seekTo(ms) {
    if (audioRef.current && ms != null) audioRef.current.currentTime = ms / 1000;
  }

  // Functional updates (`(prevSync) => nextSync`) rather than building the
  // next `{anchors, tempo_marks}` object here from this render's `anchors`/
  // `tempoMarks` - see useMurekaStage.js's `setKaraokeSync` docstring: two
  // taps in the same batch (tapping several lines in a row while listening)
  // would otherwise have the second one silently discard the first.
  function tapAnchor(rowIndex) {
    if (!audioRef.current) return;
    const ms = Math.round(audioRef.current.currentTime * 1000);
    onSetKaraokeSync?.((prev) => ({ ...prev, anchors: { ...prev.anchors, [rowIndex]: ms } }));
  }
  function clearAnchor(rowIndex) {
    onSetKaraokeSync?.((prev) => {
      const next = { ...prev.anchors };
      delete next[rowIndex];
      return { ...prev, anchors: next };
    });
  }
  function addTempoMark(direction) {
    if (!audioRef.current) return;
    const ms = Math.round(audioRef.current.currentTime * 1000);
    const mark = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, time_ms: ms, direction };
    onSetKaraokeSync?.((prev) => ({ ...prev, tempo_marks: [...(prev.tempo_marks || []), mark] }));
  }
  function removeTempoMark(id) {
    onSetKaraokeSync?.((prev) => ({ ...prev, tempo_marks: (prev.tempo_marks || []).filter((m) => m.id !== id) }));
  }

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') { onClose(); return; }
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
      const audio = audioRef.current;
      if (!audio) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (audio.paused) audio.play(); else audio.pause();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        audio.currentTime = Math.max(0, audio.currentTime - 5);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        audio.currentTime = Math.min(audio.duration || audio.currentTime + 5, audio.currentTime + 5);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        addTempoMark('faster');
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        addTempoMark('slower');
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, addTempoMark]);

  if (!track) return null;

  const sortedMarks = [...tempoMarks].sort((a, b) => a.time_ms - b.time_ms);
  const grouped = [];
  let lastSectionType;
  let sawSectionHeader = false;
  appliedRows.forEach((row, i) => {
    if (row.sectionType !== lastSectionType || !sawSectionHeader) {
      grouped.push({ kind: 'header', sectionType: row.sectionType, key: `h${i}` });
      lastSectionType = row.sectionType;
      sawSectionHeader = true;
    }
    grouped.push({ kind: 'row', row, i, key: i });
  });

  // Tempo marks aren't lyric lines - they're merged into the same timeline
  // by their own (adjusted-if-anchored) playback position, purely so the
  // user can see roughly where each ↑/↓ press landed relative to the lyrics.
  const timeline = [];
  let markIdx = 0;
  grouped.forEach((item) => {
    if (item.kind === 'row') {
      const t = item.row.adjustedStart ?? item.row.start;
      while (markIdx < sortedMarks.length && t != null && sortedMarks[markIdx].time_ms <= t) {
        timeline.push({ kind: 'tempo', mark: sortedMarks[markIdx], key: `tempo-${sortedMarks[markIdx].id}` });
        markIdx++;
      }
    }
    timeline.push(item);
  });
  while (markIdx < sortedMarks.length) {
    timeline.push({ kind: 'tempo', mark: sortedMarks[markIdx], key: `tempo-${sortedMarks[markIdx].id}` });
    markIdx++;
  }

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card modal-card-lg mureka-detail-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="mureka-detail-header-text">
            <div className="mureka-detail-header-title">
              {projectTitle || L.mureka_tracksLabel}{projectAuthor ? ` — ${projectAuthor}` : ''}
            </div>
            <div className="mureka-detail-header-sub">
              {L.mureka_tracksLabel} {index + 1} · {formatMs(track.duration_ms)}
              {track.raw?.id ? ` · ID ${track.raw.id}` : ''}
            </div>
          </div>
          <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <audio
          ref={audioRef} className="mureka-track-audio" controls
          src={mediaUrl(`projects/${projectId}/${track.file_path}`)}
          onTimeUpdate={() => setCurrentTimeMs((audioRef.current?.currentTime || 0) * 1000)}
        />

        <div className="mureka-detail-hotkeys-hint">{L.mureka_detailHotkeysHint}</div>

        {coverageEnd != null && track.duration_ms > coverageEnd + 1000 && (
          <div className="mureka-detail-coverage-hint">
            ⚠ {L.mureka_detailPartialCoverage.replace('{time}', formatMs(coverageEnd))}
          </div>
        )}

        <div className="mureka-detail-body">
          <div className="mureka-detail-timeline">
            {!rows.length && <div className="mureka-detail-empty">{L.mureka_detailNoTiming}</div>}
            {!!rows.length && (
              <div className="mureka-detail-timeline-legend">
                <span className="mureka-detail-line-time">{L.mureka_detailOriginalColumn}</span>
                <span className="mureka-detail-line-text" />
                <span className="mureka-detail-line-adjusted">{L.mureka_detailAdjustedColumn}</span>
              </div>
            )}
            {timeline.map((item) => {
              if (item.kind === 'header') {
                return (
                  <div key={item.key} className="mureka-detail-section-header">
                    {item.sectionType || L.mureka_karaokeInstrumental}
                  </div>
                );
              }
              if (item.kind === 'tempo') {
                const faster = item.mark.direction === 'faster';
                return (
                  <div key={item.key} className="mureka-detail-tempo-row">
                    {faster ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                    <span>{faster ? L.mureka_detailTempoFaster : L.mureka_detailTempoSlower}</span>
                    <span className="mureka-detail-tempo-time">{formatMs(item.mark.time_ms)}</span>
                    <button
                      className="icon-btn mureka-detail-tempo-remove" title={L.mureka_detailRemoveTempoMark}
                      onClick={() => removeTempoMark(item.mark.id)}
                    >
                      <X size={10} />
                    </button>
                  </div>
                );
              }
              const tappable = isTappableLine(item.row);
              return (
                <div
                  key={item.key}
                  ref={item.i === activeIdx ? activeRowRef : undefined}
                  className={`mureka-detail-line${item.i === activeIdx ? ' is-current' : ''}${item.row.isSection ? ' is-instrumental' : ''}${item.row.static ? ' is-static' : ''}`}
                  onClick={() => seekTo(item.row.start)}
                >
                  <span className="mureka-detail-line-time">{formatMs(item.row.start)}</span>
                  <span className="mureka-detail-line-text">
                    {item.row.isSection ? `♪ ${item.row.sectionType || L.mureka_karaokeInstrumental}` : item.row.text}
                  </span>
                  {item.row.interpolated && <span className="mureka-detail-line-approx" title={L.mureka_detailInterpolatedHint}>~</span>}
                  {item.row.static && !item.row.isSection && (
                    <span className="mureka-detail-line-approx" title={L.mureka_detailStaticHint}>–</span>
                  )}
                  <span className="mureka-detail-line-adjusted">
                    {tappable && (
                      <>
                        <span className={`mureka-detail-adjusted-time${item.row.isAnchor ? ' is-anchor' : ''}`}>
                          {formatMs(item.row.adjustedStart)}
                        </span>
                        <button
                          className="icon-btn mureka-detail-tap-btn"
                          title={item.row.isAnchor ? L.mureka_detailRetapHint : L.mureka_detailTapHint}
                          onClick={(e) => { e.stopPropagation(); tapAnchor(item.i); }}
                        >
                          <Crosshair size={12} />
                        </button>
                        {item.row.isAnchor && (
                          <button
                            className="icon-btn mureka-detail-untap-btn" title={L.mureka_detailClearAnchorHint}
                            onClick={(e) => { e.stopPropagation(); clearAnchor(item.i); }}
                          >
                            <X size={10} />
                          </button>
                        )}
                      </>
                    )}
                  </span>
                </div>
              );
            })}
          </div>

          <div className="mureka-detail-meta">
            <div className="mureka-detail-meta-row"><b>{L.mureka_detailsModel}:</b> {track.model}</div>
            <div className="mureka-detail-meta-row"><b>{L.mureka_detailDuration}:</b> {formatMs(track.duration_ms)}</div>
            {track.raw?.id && <div className="mureka-detail-meta-row"><b>{L.mureka_detailSongId}:</b> {track.raw.id}</div>}
            {track.raw?.index != null && <div className="mureka-detail-meta-row"><b>{L.mureka_detailChoiceIndex}:</b> {track.raw.index}</div>}
            <details>
              <summary>{L.mureka_detailsStyle}</summary>
              <div className="mureka-detail-style-text">{track.style || '—'}</div>
            </details>
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
                <JsonTreeView L={L} data={track.raw} />
              </div>
            </details>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
