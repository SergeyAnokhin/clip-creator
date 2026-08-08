import { useRef, useState } from 'react';
import {
  Check, ChevronDown, ChevronUp, Loader2, Maximize2, MoreVertical, Music4, Plus, RotateCcw,
  Scissors, Star, Trash2, Upload, Wand2, X, Zap,
} from 'lucide-react';
import { mediaUrl } from '../../api/client.js';
import { pickReadableTextColor } from '../../lib/musicTagColors.js';
import JsonTreeView from '../common/JsonTreeView.jsx';
import CopyButton from './CopyButton.jsx';
import KaraokeLyrics from './KaraokeLyrics.jsx';
import MurekaTrackDetailModal from './MurekaTrackDetailModal.jsx';
import ReferenceAudioTrimmer from './ReferenceAudioTrimmer.jsx';

const MODELS = ['auto', 'mureka-7.6', 'mureka-o2', 'mureka-8', 'mureka-9'];

/** `0:45` / `1:23` - track duration from Mureka's `choices[].duration` (ms). */
function formatTrackDuration(ms) {
  if (!ms && ms !== 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}

/** `12с` / `1м 05с` (or the EN `12s` / `1m 05s`) - mirrors SunoStage.jsx's
 * identically-named local helper, used for the "waiting for model" counter
 * (Mureka generation runs 30-90s, longer than image generation). */
function formatElapsed(totalSeconds, L) {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}${L.suno_unitSeconds}`;
  const m = Math.floor(s / 60);
  const rem = String(s % 60).padStart(2, '0');
  return `${m}${L.suno_unitMinutes} ${rem}${L.suno_unitSeconds}`;
}

function TrackCard({
  L, projectId, track, index, allTags, onRate, onSelectMain, onToggleTag, onDelete,
  onReuseSettings, onExtend, onStem, onOpenDetail, extending, stemming,
}) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [tagMenuOpen, setTagMenuOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [extendFormOpen, setExtendFormOpen] = useState(false);
  const [extendLyrics, setExtendLyrics] = useState('');

  const duration = formatTrackDuration(track.duration_ms);
  const addedTags = (allTags || []).filter((t) => (track.tag_ids || []).includes(t.id));
  const availableTags = (allTags || []).filter((t) => !(track.tag_ids || []).includes(t.id));

  function submitExtend() {
    if (!extendLyrics.trim()) return;
    onExtend(track.track_id, { lyrics: extendLyrics, extendAt: track.duration_ms });
    setExtendLyrics('');
    setExtendFormOpen(false);
    setActionsMenuOpen(false);
  }

  return (
    <div className={`mureka-track-row${track.is_selected ? ' is-main' : ''}`}>
      <div className="mureka-track-row-head">
        <span className="mureka-track-title">
          <Music4 size={13} /> {`${L.mureka_tracksLabel} ${index + 1}`}
          {duration && <span className="mureka-track-duration">{duration}</span>}
          {track.extended_from_track_id && <span className="mureka-track-extended-badge">{L.mureka_extendedBadge}</span>}
        </span>

        <div className="mureka-track-row-actions">
          <button
            className={`image-thumb-select${track.is_selected ? ' is-active' : ''}`}
            style={{ position: 'static' }} title={L.mureka_primaryTitle} onClick={() => onSelectMain(track.track_id)}
          >
            <Check size={12} />
          </button>
          <CopyButton L={L} text={mediaUrl(`projects/${projectId}/${track.file_path}`)} />
          <button className="icon-btn" style={{ width: 26, height: 26 }} title={L.mureka_openDetailBtn} onClick={() => onOpenDetail(track)}>
            <Maximize2 size={12} />
          </button>
          <div style={{ position: 'relative' }}>
            <button className="icon-btn" style={{ width: 26, height: 26 }} title={L.mureka_actionsTitle} onClick={() => setActionsMenuOpen((o) => !o)}>
              <MoreVertical size={13} />
            </button>
            {actionsMenuOpen && (
              <div className="mureka-reference-menu mureka-actions-menu">
                <button onClick={() => { onReuseSettings(track); setActionsMenuOpen(false); }}>
                  <RotateCcw size={12} /> {L.mureka_reuseSettingsBtn}
                </button>
                <button onClick={() => setExtendFormOpen((o) => !o)} disabled={!track.raw?.id} title={!track.raw?.id ? L.mureka_extendUnavailable : undefined}>
                  <Wand2 size={12} /> {L.mureka_extendBtn}
                </button>
                <button onClick={() => { onStem(track.track_id); setActionsMenuOpen(false); }} disabled={stemming}>
                  {stemming ? <Loader2 size={12} className="spin" /> : <Scissors size={12} />} {L.mureka_stemBtn}
                </button>
                <div className="mureka-menu-cost-hint">{L.mureka_costUnknownHint}</div>
              </div>
            )}
          </div>
          <button className="image-thumb-delete" style={{ position: 'static' }} title={L.mureka_deleteTrackTitle} onClick={() => onDelete(track.track_id)}>
            <Trash2 size={11} />
          </button>
        </div>
      </div>

      {extendFormOpen && (
        <div className="mureka-extend-form">
          <textarea
            className="suno-textarea" style={{ minHeight: 70 }} value={extendLyrics}
            onChange={(e) => setExtendLyrics(e.target.value)} placeholder={L.mureka_extendLyricsPlaceholder}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-accent-soft" disabled={extending} onClick={submitExtend}>
              {extending ? <Loader2 size={12} className="spin" /> : null} {L.mureka_extendSubmit}
            </button>
            <button className="btn-ghost" style={{ border: 'none', cursor: 'pointer' }} onClick={() => setExtendFormOpen(false)}>{L.cancel}</button>
          </div>
        </div>
      )}

      <audio
        ref={audioRef} className="mureka-track-audio" controls src={mediaUrl(`projects/${projectId}/${track.file_path}`)}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onTimeUpdate={() => setCurrentTimeMs((audioRef.current?.currentTime || 0) * 1000)}
      />

      {playing && <KaraokeLyrics L={L} raw={track.raw} currentTimeMs={currentTimeMs} />}

      <div className="mureka-track-row-footer">
        <div className="image-carousel-stars" style={{ position: 'static', transform: 'none' }}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} onClick={() => onRate(track.track_id, n)}>
              <Star size={12} color={n <= track.rating ? '#ff9d5c' : 'rgba(255,255,255,0.35)'} />
            </button>
          ))}
        </div>

        <div className="mureka-track-tags">
          {addedTags.map((tag) => (
            <span
              key={tag.id} className="chip mureka-tag-badge"
              style={{ background: tag.color, color: pickReadableTextColor(tag.color) }}
              onClick={() => onToggleTag(track.track_id, tag.id)}
              title={L.mureka_removeTagTitle}
            >
              {tag.label} <X size={10} />
            </span>
          ))}
          <div style={{ position: 'relative' }}>
            <button className="mureka-tag-add-btn" onClick={() => setTagMenuOpen((o) => !o)} title={L.mureka_addTagTitle}>
              <Plus size={12} />
            </button>
            {tagMenuOpen && (
              <div className="mureka-reference-menu">
                {availableTags.length
                  ? availableTags.map((tag) => (
                    <button key={tag.id} onClick={() => { onToggleTag(track.track_id, tag.id); setTagMenuOpen(false); }}>
                      <span className="mureka-tag-swatch" style={{ background: tag.color }} /> {tag.label}
                    </button>
                  ))
                  : <span className="mureka-reference-menu-empty">{L.mureka_noMoreTags}</span>}
              </div>
            )}
          </div>
        </div>

        <button className="mureka-details-toggle" onClick={() => setDetailsOpen((o) => !o)}>
          {detailsOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />} {L.mureka_detailsToggle}
        </button>
      </div>

      {detailsOpen && (
        <div className="mureka-track-details">
          <div><b>{L.mureka_detailsModel}:</b> {track.model}</div>
          <div><b>{L.mureka_detailsStyle}:</b> {track.style || '—'}</div>
          <details>
            <summary>{L.mureka_detailsLyrics}</summary>
            <pre>{track.lyrics}</pre>
          </details>
          {!!track.stems?.length && (
            <div>
              <b>{L.mureka_detailsStems}:</b>{' '}
              {track.stems.map((s) => (
                <a key={s.id} href={mediaUrl(`projects/${projectId}/${s.file_path}`)} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>
                  {L.mureka_downloadStemsLink} ({s.model || 'default'})
                </a>
              ))}
            </div>
          )}
          <details>
            <summary>{L.mureka_detailsRaw}</summary>
            <div className="json-tree-scroll">
              <JsonTreeView L={L} data={track.raw} />
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

export default function MurekaStage({
  L, project, isMobile, styleInput, lyricsInput, model, n, gender, referenceId, referenceAudio, referenceSources,
  tracks, generating, elapsedSeconds, jobStage, murekaError, uploadingReference, uploadingReferenceSource, trimmingReference,
  billing, extendingTrackIds, stemmingTrackIds, musicTags, actions,
}) {
  const [referenceMenuOpen, setReferenceMenuOpen] = useState(false);
  const [trimmingSource, setTrimmingSource] = useState(null);
  const [detailTrackId, setDetailTrackId] = useState(null);
  const fileInputRef = useRef(null);
  const detailIndex = (tracks || []).findIndex((t) => t.track_id === detailTrackId);
  const detailTrack = detailIndex >= 0 ? tracks[detailIndex] : null;

  async function handleReferenceFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const source = await actions.uploadReferenceSource(file);
    if (source) setTrimmingSource(source);
  }

  async function handleTrimConfirm(startMs, endMs) {
    if (!trimmingSource) return;
    // The source is kept regardless of outcome - it stays in referenceSources
    // so the same upload can be trimmed into another window later instead of
    // requiring a fresh upload each time (see ReferenceAudioTrimmer.jsx).
    const ok = await actions.trimReferenceSource(trimmingSource.id, startMs, endMs);
    if (ok) setTrimmingSource(null);
  }
  function handleTrimClose() {
    setTrimmingSource(null);
  }

  const selectedReference = (referenceAudio || []).find((r) => r.mureka_file_id === referenceId);
  const stageLabels = {
    preparing: L.mureka_stagePreparing, queued: L.mureka_stageQueued,
    running: L.mureka_stageRunning, streaming: L.mureka_stageStreaming,
  };

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
        <div>
          <div className="stage-heading-title">{L.murekaStageTitle}</div>
          <div className="stage-heading-subtitle">{L.murekaStageSubtitle}</div>
        </div>
        {billing && (
          <div className="mureka-balance-pill" title={L.mureka_balanceHint}>
            💰 {billing.balance} / {billing.total_recharge}
          </div>
        )}
      </div>
      <div style={{ marginBottom: 18 }} />

      <div style={{ display: 'flex', gap: 12, flexDirection: isMobile ? 'column' : 'row', marginBottom: 16 }}>
        <div className="glass-card" style={{ flex: 1, minWidth: 0 }}>
          <div className="suno-panel-title">{L.mureka_styleLabel}</div>
          <textarea
            className="suno-textarea"
            style={{ minHeight: 120 }}
            value={styleInput}
            onChange={(e) => actions.setStyleInput(e.target.value)}
          />
        </div>
        <div className="glass-card" style={{ flex: 1, minWidth: 0 }}>
          <div className="suno-panel-title">{L.mureka_lyricsLabel}</div>
          <textarea
            className="suno-textarea"
            style={{ minHeight: 120 }}
            value={lyricsInput}
            onChange={(e) => actions.setLyricsInput(e.target.value)}
          />
        </div>
      </div>

      <div className="glass-card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 6 }}>{L.mureka_modelLabel}</div>
            <select className="field" value={model} onChange={(e) => actions.setModel(e.target.value)}>
              {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 6 }}>{L.mureka_countLabel}</div>
            <input
              className="field" type="number" min="1" max="3" step="1" style={{ maxWidth: 80 }}
              value={n}
              onChange={(e) => actions.setN(Math.min(3, Math.max(1, Number(e.target.value) || 1)))}
            />
          </div>
          <div>
            <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 6 }}>{L.mureka_genderLabel}</div>
            <select className="field" value={gender} onChange={(e) => actions.setGender(e.target.value)}>
              <option value="">{L.mureka_genderAny}</option>
              <option value="male">{L.mureka_genderMale}</option>
              <option value="female">{L.mureka_genderFemale}</option>
            </select>
          </div>
          <div style={{ position: 'relative' }}>
            <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 6 }}>{L.mureka_referenceLabel}</div>
            <button className="field" style={{ cursor: 'pointer', textAlign: 'left', minWidth: 180 }} onClick={() => setReferenceMenuOpen((o) => !o)}>
              {selectedReference ? selectedReference.filename : L.mureka_referenceNone}
            </button>
            {referenceMenuOpen && (
              <div className="mureka-reference-menu">
                <button onClick={() => { actions.setReferenceId(''); setReferenceMenuOpen(false); }}>
                  {L.mureka_referenceNone}
                </button>
                {(referenceAudio || []).map((ref) => (
                  <span key={ref.id} className="mureka-reference-menu-row">
                    <button
                      className={ref.mureka_file_id === referenceId ? 'is-active' : ''}
                      onClick={() => { actions.setReferenceId(ref.mureka_file_id); setReferenceMenuOpen(false); }}
                    >
                      {ref.filename}
                    </button>
                    <button title={L.mureka_referenceDeleteTitle} onClick={() => actions.deleteReferenceAudio(ref.id)}>
                      <X size={11} />
                    </button>
                  </span>
                ))}
                {!!(referenceSources || []).length && (
                  <div className="mureka-reference-menu-divider">{L.mureka_referenceSourcesLabel}</div>
                )}
                {(referenceSources || []).map((source) => (
                  <span key={source.id} className="mureka-reference-menu-row">
                    <button onClick={() => { setTrimmingSource(source); setReferenceMenuOpen(false); }}>
                      <Scissors size={11} /> {source.filename}
                    </button>
                    <button title={L.mureka_referenceSourceDeleteTitle} onClick={() => actions.deleteReferenceSource(source.id)}>
                      <X size={11} />
                    </button>
                  </span>
                ))}
                <button onClick={() => { setReferenceMenuOpen(false); fileInputRef.current?.click(); }} disabled={uploadingReferenceSource || uploadingReference}>
                  {(uploadingReferenceSource || uploadingReference) ? <Loader2 size={12} className="spin" /> : <Upload size={12} />}
                  {(uploadingReferenceSource || uploadingReference) ? L.mureka_referenceUploading : L.mureka_referenceUpload}
                </button>
              </div>
            )}
            <input ref={fileInputRef} type="file" accept="audio/mpeg,audio/mp4,audio/wav,audio/ogg,audio/flac,.mp3,.m4a,.wav,.ogg,.flac" style={{ display: 'none' }} onChange={handleReferenceFile} />
          </div>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 10 }}>{L.mureka_referenceHint}</div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <button
          className="btn btn-gradient" style={{ padding: '12px 20px', fontSize: 14 }}
          onClick={actions.onGenerate} disabled={generating}
        >
          {generating ? <Loader2 size={16} className="spin" /> : <Zap size={16} />}
          {L.mureka_generateBtn}
        </button>
      </div>

      {generating && (
        <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 16 }}>
          ⏳ {L.mureka_generating}{jobStage && stageLabels[jobStage] ? ` (${stageLabels[jobStage]})` : ''} · {formatElapsed(elapsedSeconds, L)}
        </div>
      )}
      {!generating && murekaError && (
        <div style={{ fontSize: 13, color: '#fca5a5', marginBottom: 16 }}>⚠️ {murekaError}</div>
      )}

      <div className="suno-panel-title" style={{ marginTop: 8 }}>{L.mureka_tracksLabel}</div>
      {!tracks?.length ? (
        <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>{L.mureka_noTracksYet}</div>
      ) : (
        <div className="mureka-track-list">
          {tracks.map((track, i) => (
            <TrackCard
              key={track.track_id}
              L={L} projectId={project.id} track={track} index={i} allTags={musicTags || []}
              onRate={actions.onRate} onSelectMain={actions.onSelectMain}
              onToggleTag={actions.onToggleTag} onDelete={actions.onDelete}
              onReuseSettings={actions.reuseTrackSettings}
              onExtend={actions.extendTrack} onStem={actions.stemTrack}
              onOpenDetail={(t) => setDetailTrackId(t.track_id)}
              extending={(extendingTrackIds || []).includes(track.track_id)}
              stemming={(stemmingTrackIds || []).includes(track.track_id)}
            />
          ))}
        </div>
      )}
      {!musicTags?.length && (
        <button className="btn-ghost" style={{ marginTop: 10, border: 'none', cursor: 'pointer' }} onClick={actions.onOpenSettings}>
          {L.mureka_manageTagsLink}
        </button>
      )}

      {trimmingSource && (
        <ReferenceAudioTrimmer
          L={L} projectId={project.id} source={trimmingSource} uploading={trimmingReference}
          onConfirm={handleTrimConfirm} onClose={handleTrimClose}
        />
      )}

      {detailTrack && (
        <MurekaTrackDetailModal
          L={L} projectId={project.id} projectTitle={project.title} projectAuthor={project.author}
          track={detailTrack} index={detailIndex}
          onClose={() => setDetailTrackId(null)}
          onSetKaraokeSync={(sync) => actions.onSetKaraokeSync(detailTrack.track_id, sync)}
        />
      )}
    </>
  );
}
