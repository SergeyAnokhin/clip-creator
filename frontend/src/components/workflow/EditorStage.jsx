import { Clapperboard, Download, Loader2, Trash2, Wand2 } from 'lucide-react';
import EditorPreview from './EditorPreview.jsx';
import EditorTimeline from './EditorTimeline.jsx';
import { mediaUrl } from '../../api/client.js';

const DURATION_MISMATCH_THRESHOLD_MS = 1000;

function formatSeconds(ms) {
  return (ms / 1000).toFixed(1);
}

/** Editor stage - the final step: assembles the project's picked scene
 * video clips into one rendered file, synced to the project's selected
 * Mureka track. See useEditorStage.js for the state/preview-engine design;
 * this component is layout only. */
export default function EditorStage({
  L, project, isMobile, videoEdit, clips, totalDurationMs, selectedTrack, tracks,
  playheadMs, isPlaying, renderLoading, renderError, elapsedSeconds, videoRef, audioRef, actions,
}) {
  const scenes = project.scenes || [];
  const renders = [...(videoEdit.renders || [])].reverse();
  const mismatchMs = selectedTrack ? totalDurationMs - selectedTrack.duration_ms : 0;
  const showMismatch = selectedTrack && Math.abs(mismatchMs) > DURATION_MISMATCH_THRESHOLD_MS;
  const canRender = clips.length > 0 && !!selectedTrack;

  return (
    <>
      <div className="stage-heading">
        <div>
          <div className="stage-heading-title">{L.editorStageTitle}</div>
          <div className="stage-heading-subtitle">{L.editorStageSubtitle}</div>
        </div>
      </div>

      <div className="glass-card" style={{ marginBottom: 16 }}>
        <div className="suno-panel-title"><Clapperboard size={16} color="#ff9d5c" />{L.editor_audioTrackLabel}</div>
        {tracks.length ? (
          <select
            className="field" value={videoEdit.mureka_track_id || ''}
            onChange={(e) => actions.setMurekaTrackId(e.target.value || null)}
          >
            <option value="">{L.editor_noAudioTrack}</option>
            {tracks.map((t, i) => (
              <option key={t.track_id} value={t.track_id}>
                {`${i + 1}. ${(t.file_path || '').split('/').pop()} (${formatSeconds(t.duration_ms || 0)}s)`}
              </option>
            ))}
          </select>
        ) : (
          <div style={{ fontSize: 12.5, color: '#fbbf24' }}>⚠️ {L.editor_noAudioTrack}</div>
        )}
      </div>

      {showMismatch && (
        <div style={{ fontSize: 12.5, color: '#fbbf24', marginBottom: 16 }}>
          ⚠️ {mismatchMs > 0 ? L.editor_durationMismatchLong : L.editor_durationMismatchShort}
          {' '}({formatSeconds(totalDurationMs)}s {L.editor_vsAudio} {formatSeconds(selectedTrack.duration_ms)}s)
        </div>
      )}

      <EditorPreview
        L={L} projectId={project.id} selectedTrack={selectedTrack} videoRef={videoRef} audioRef={audioRef}
        playheadMs={playheadMs} isPlaying={isPlaying} onPlay={actions.play} onPause={actions.pause} onSeek={actions.seek}
      />

      <EditorTimeline L={L} projectId={project.id} scenes={scenes} clips={clips} actions={actions} />

      <div className="glass-card" style={{ marginBottom: 16 }}>
        <button className="btn btn-gradient" style={{ padding: '12px 20px', fontSize: 14 }} onClick={actions.startRender} disabled={!canRender || renderLoading}>
          {renderLoading ? <Loader2 size={16} className="spin" /> : <Wand2 size={16} />}
          {L.editor_renderButton}
        </button>
        {renderLoading && (
          <div style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 10 }}>
            ⏳ {L.editor_renderElapsed.replace('{s}', elapsedSeconds)}
          </div>
        )}
        {!renderLoading && renderError && (
          <div style={{ fontSize: 13, color: '#fca5a5', marginTop: 10 }}>⚠️ {renderError}</div>
        )}

        <div style={{ marginTop: 16 }}>
          <div className="suno-panel-title" style={{ marginBottom: 8 }}>{L.editor_rendersTitle}</div>
          {!renders.length && <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>{L.editor_renderEmpty}</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {renders.map((r) => (
              <div key={r.render_id} style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
                <video
                  src={mediaUrl(`projects/${project.id}/${r.file_path}`)} controls
                  style={{ width: 220, maxWidth: '100%', borderRadius: 6, background: '#000' }}
                />
                <div style={{ fontSize: 12, color: 'var(--text-dim)', flex: 1 }}>
                  {new Date(r.created_at).toLocaleString()} · {formatSeconds(r.duration_ms)}s · {r.clip_count} {L.editor_clipsCountLabel}
                </div>
                <button className="btn-ghost" style={{ border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, padding: '6px 10px', cursor: 'pointer' }} onClick={() => actions.downloadRender(r)}>
                  <Download size={14} /> {L.editor_renderDownload}
                </button>
                <button className="icon-btn" title={L.editor_renderDelete} onClick={() => actions.deleteRender(r.render_id)}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
