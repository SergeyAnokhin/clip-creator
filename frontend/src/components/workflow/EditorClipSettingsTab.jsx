import { Clapperboard } from 'lucide-react';

const DURATION_MISMATCH_THRESHOLD_MS = 1000;

function formatSeconds(ms) {
  return (ms / 1000).toFixed(1);
}

export const WAVEFORM_SCALE_MODES = ['linear', 'log', 'sqrt'];

/** "Клип" tab: project-wide settings that used to be two separate
 * always-visible blocks (audio track picker, canvas size) - grouped
 * together per the redesign since neither is "this selected object's
 * properties", they're both project-level. Also owns the waveform
 * display-scale picker, a pure viewing preference for
 * TimelineAudioTrack.jsx (state lives in EditorStage.jsx, see
 * `waveformScale`).
 *
 * Also hosts `onToolsSlotRef` - the portal target `EditorTimeline.jsx`
 * portals `EditorTimelineTools.jsx`'s toolbar (zoom, shortcuts, test-range
 * chip, add-scene chips, add-overlay picker) into. That content used to sit
 * in its own strip between the program monitor and the timeline; moved here
 * instead so nothing but the timeline itself ever sits directly under the
 * monitor. EditorSidePanel.jsx keeps this tab's body permanently mounted
 * (hidden via CSS, not unmounted, when another tab is active) specifically
 * so this ref target never disappears out from under the portal. */
export default function EditorClipSettingsTab({
  L, videoEdit, tracks, selectedTrack, totalDurationMs, canvasOrientation, canvasSize, actions,
  waveformScale, onSetWaveformScale, onToolsSlotRef,
}) {
  const mismatchMs = selectedTrack ? totalDurationMs - selectedTrack.duration_ms : 0;
  const showMismatch = selectedTrack && Math.abs(mismatchMs) > DURATION_MISMATCH_THRESHOLD_MS;

  return (
    <>
      <div className="editor-side-block editor-side-tools" ref={onToolsSlotRef} />

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
        <span className="tl-inspector-label tl-inspector-row" style={{ marginTop: 10 }}>
          <span className="tl-inspector-rowlabel">{L.editor_waveformScaleLabel}</span>
        </span>
        <div className="tl-inspector-row tl-transition-types">
          {WAVEFORM_SCALE_MODES.map((mode) => (
            <button
              key={mode} type="button" className={`tl-transition-chip${waveformScale === mode ? ' is-selected' : ''}`}
              onClick={() => onSetWaveformScale(mode)}
            >
              {L[`editor_waveformScale${mode[0].toUpperCase()}${mode.slice(1)}`]}
            </button>
          ))}
        </div>
      </div>

      <div className="editor-side-block">
        <span className="tl-inspector-label tl-inspector-row">
          <span className="tl-inspector-rowlabel">{L.editor_canvasSizeLabel}</span>
          <span className="tl-timecode">{canvasSize.width}×{canvasSize.height}</span>
        </span>
        <div className="tl-inspector-row tl-transition-types">
          <button
            type="button" className={`tl-transition-chip${canvasOrientation === 'auto' ? ' is-selected' : ''}`}
            onClick={() => actions.setCanvasOrientation('auto')}
          >
            {L.editor_canvasOrientationAuto}
          </button>
          <button
            type="button" className={`tl-transition-chip${canvasOrientation === 'portrait' ? ' is-selected' : ''}`}
            onClick={() => actions.setCanvasOrientation('portrait')}
          >
            {L.editor_canvasOrientationPortrait}
          </button>
          <button
            type="button" className={`tl-transition-chip${canvasOrientation === 'landscape' ? ' is-selected' : ''}`}
            onClick={() => actions.setCanvasOrientation('landscape')}
          >
            {L.editor_canvasOrientationLandscape}
          </button>
        </div>
      </div>
    </>
  );
}
