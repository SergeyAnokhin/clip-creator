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
 * Mureka track. Laid out like a normal video editor: program monitor top
 * left, project/render panel on the right, timeline docked underneath
 * (EditorTimeline.jsx). See useEditorStage.js for the state/preview-engine
 * design; this component is layout only. */
export default function EditorStage({
  L, project, isMobile, videoEdit, clips, totalDurationMs, selectedTrack, tracks,
  playheadMs, isPlaying, renderLoading, renderError, elapsedSeconds, selectedClipId,
  videoRef, audioRef, actions,
}) {
  const scenes = project.scenes || [];
  const renders = [...(videoEdit.renders || [])].reverse();
  const mismatchMs = selectedTrack ? totalDurationMs - selectedTrack.duration_ms : 0;
  const showMismatch = selectedTrack && Math.abs(mismatchMs) > DURATION_MISMATCH_THRESHOLD_MS;
  const canRender = clips.length > 0 && !!selectedTrack;
  const timelineMs = Math.max(totalDurationMs, selectedTrack?.duration_ms || 0);

  return (
    <>
      <div className="stage-heading">
        <div>
          <div className="stage-heading-title">{L.editorStageTitle}</div>
          <div className="stage-heading-subtitle">{L.editorStageSubtitle}</div>
        </div>
        <button className="btn btn-gradient" onClick={actions.startRender} disabled={!canRender || renderLoading}>
          {renderLoading ? <Loader2 size={16} className="spin" /> : <Wand2 size={16} />}
          {renderLoading ? L.editor_renderElapsed.replace('{s}', elapsedSeconds) : L.editor_renderButton}
        </button>
      </div>

      <div className={`editor-layout${isMobile ? ' is-mobile' : ''}`}>
        <EditorPreview
          L={L} projectId={project.id} selectedTrack={selectedTrack} videoRef={videoRef} audioRef={audioRef}
          playheadMs={playheadMs} totalMs={timelineMs} isPlaying={isPlaying}
          onPlay={actions.play} onPause={actions.pause} onSeek={actions.seek}
        />

        <div className="editor-side">
          <div className="editor-side-block">
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
              <div className="editor-side-warn">⚠️ {L.editor_noAudioTrack}</div>
            )}
            {showMismatch && (
              <div className="editor-side-warn">
                ⚠️ {mismatchMs > 0 ? L.editor_durationMismatchLong : L.editor_durationMismatchShort}
                {' '}({formatSeconds(totalDurationMs)}s {L.editor_vsAudio} {formatSeconds(selectedTrack.duration_ms)}s)
              </div>
            )}
            {!renderLoading && renderError && <div className="editor-side-error">⚠️ {renderError}</div>}
          </div>

          <div className="editor-side-block editor-side-renders">
            <div className="suno-panel-title" style={{ marginBottom: 8 }}>{L.editor_rendersTitle}</div>
            {!renders.length && <div className="editor-side-dim">{L.editor_renderEmpty}</div>}
            {renders.map((r) => (
              <div key={r.render_id} className="editor-render-row">
                <video src={mediaUrl(`projects/${project.id}/${r.file_path}`)} controls />
                <div className="editor-render-meta">
                  {new Date(r.created_at).toLocaleString()} · {formatSeconds(r.duration_ms)}s · {r.clip_count} {L.editor_clipsCountLabel}
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
        </div>
      </div>

      <EditorTimeline
        L={L} projectId={project.id} scenes={scenes} clips={clips} totalDurationMs={totalDurationMs}
        selectedTrack={selectedTrack} playheadMs={playheadMs} isPlaying={isPlaying}
        selectedClipId={selectedClipId} actions={actions}
      />
    </>
  );
}
