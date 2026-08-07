import { useRef, useState } from 'react';
import { Check, Loader2, Music4, Star, Trash2, Upload, X, Zap } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';

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

function TrackCard({ L, projectId, track, index, tagsById, onRate, onSelectMain, onToggleTag, onDelete }) {
  const duration = formatTrackDuration(track.duration_ms);
  return (
    <div className={`mureka-track-card${track.is_selected ? ' is-main' : ''}`}>
      <div className="mureka-track-header">
        <span className="mureka-track-title">
          <Music4 size={13} /> {`${L.mureka_tracksLabel} ${index + 1}`}
          {duration && <span className="mureka-track-duration">{duration}</span>}
        </span>
        <div className="mureka-track-header-actions">
          <button
            className={`image-thumb-select${track.is_selected ? ' is-active' : ''}`}
            style={{ position: 'static' }}
            title={L.mureka_primaryTitle}
            onClick={() => onSelectMain(track.track_id)}
          >
            <Check size={12} />
          </button>
          <button
            className="image-thumb-delete"
            style={{ position: 'static' }}
            title={L.mureka_deleteTrackTitle}
            onClick={() => onDelete(track.track_id)}
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>

      <audio className="mureka-track-audio" controls src={mediaUrl(`projects/${projectId}/${track.file_path}`)} />

      <div className="image-carousel-stars" style={{ position: 'static', transform: 'none', alignSelf: 'flex-start' }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} onClick={() => onRate(track.track_id, n)}>
            <Star size={12} color={n <= track.rating ? '#ff9d5c' : 'rgba(255,255,255,0.35)'} />
          </button>
        ))}
      </div>

      {!!tagsById.length && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {tagsById.map((tag) => (
            <button
              key={tag.id}
              className={`chip${(track.tag_ids || []).includes(tag.id) ? ' is-active' : ''}`}
              style={{ padding: '4px 10px', fontSize: 11 }}
              onClick={() => onToggleTag(track.track_id, tag.id)}
            >
              {tag.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MurekaStage({
  L, project, isMobile, styleInput, lyricsInput, model, n, gender, referenceId, referenceAudio, tracks,
  generating, elapsedSeconds, murekaError, uploadingReference, musicTags, actions,
}) {
  const [referenceMenuOpen, setReferenceMenuOpen] = useState(false);
  const fileInputRef = useRef(null);

  function handleReferenceFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) actions.uploadReferenceAudio(file);
  }

  const selectedReference = (referenceAudio || []).find((r) => r.mureka_file_id === referenceId);

  return (
    <>
      <div className="stage-heading-title" style={{ marginBottom: 4 }}>{L.murekaStageTitle}</div>
      <div className="stage-heading-subtitle" style={{ marginBottom: 18 }}>{L.murekaStageSubtitle}</div>

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
                <button onClick={() => { setReferenceMenuOpen(false); fileInputRef.current?.click(); }} disabled={uploadingReference}>
                  {uploadingReference ? <Loader2 size={12} className="spin" /> : <Upload size={12} />}
                  {uploadingReference ? L.mureka_referenceUploading : L.mureka_referenceUpload}
                </button>
              </div>
            )}
            <input ref={fileInputRef} type="file" accept="audio/mpeg,audio/mp4,.mp3,.m4a" style={{ display: 'none' }} onChange={handleReferenceFile} />
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
          ⏳ {L.mureka_generating} · {formatElapsed(elapsedSeconds, L)}
        </div>
      )}
      {!generating && murekaError && (
        <div style={{ fontSize: 13, color: '#fca5a5', marginBottom: 16 }}>⚠️ {murekaError}</div>
      )}

      <div className="suno-panel-title" style={{ marginTop: 8 }}>{L.mureka_tracksLabel}</div>
      {!tracks?.length ? (
        <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>{L.mureka_noTracksYet}</div>
      ) : (
        <div className="mureka-gallery">
          {tracks.map((track, i) => (
            <TrackCard
              key={track.track_id}
              L={L} projectId={project.id} track={track} index={i} tagsById={musicTags || []}
              onRate={actions.onRate} onSelectMain={actions.onSelectMain}
              onToggleTag={actions.onToggleTag} onDelete={actions.onDelete}
            />
          ))}
        </div>
      )}
      {!musicTags?.length && (
        <button className="btn-ghost" style={{ marginTop: 10, border: 'none', cursor: 'pointer' }} onClick={actions.onOpenSettings}>
          {L.mureka_manageTagsLink}
        </button>
      )}
    </>
  );
}
