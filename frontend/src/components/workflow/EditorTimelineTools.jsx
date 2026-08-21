import { useEffect, useRef, useState } from 'react';
import {
  Film, Flag, FlagOff, Keyboard, Magnet, Maximize2, Plus, Type, Upload, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import { mediaUrl } from '../../api/client.js';
import { sceneLabel } from '../../lib/editorClipLabel.js';
import { formatTimecode, parseTimecode } from '../../lib/format.js';
import { TIMELINE_FPS } from '../../lib/timeline.js';
import { detectBeats } from '../../lib/beats.js';
import { PickerRow, PickerThumb } from './PosterPanels.jsx';

/** The playhead position as an editable `M:SS:FF` field - readable *and*
 * typeable to the frame, the way a desktop NLE's timecode box works. Local
 * `draft` state exists only while the field has focus, so the value keeps
 * following the playhead during playback but doesn't fight what is being
 * typed. An unparseable entry is simply discarded on blur (`parseTimecode`
 * returns null) rather than seeking to 0. */
function TimecodeField({ L, playheadMs, onSeek }) {
  const [draft, setDraft] = useState(null);
  const value = draft ?? formatTimecode(playheadMs, TIMELINE_FPS);

  function commit() {
    const ms = draft == null ? null : parseTimecode(draft, TIMELINE_FPS);
    if (ms != null) onSeek(ms);
    setDraft(null);
  }

  return (
    <input
      className="field tl-timecode-input"
      value={value}
      aria-label={L.editor_timecodeLabel}
      title={L.editor_timecodeLabel}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setDraft(formatTimecode(playheadMs, TIMELINE_FPS))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/** The Editor timeline's portaled toolbar-strip content: the editable
 * timecode, the snap (magnet) toggle, zoom (buttons + slider), the beat/clear
 * marker buttons, the test-range chip, and the add-scene/add-overlay pickers -
 * what's left here after the
 * split/undo/redo buttons and the object inspector moved into
 * EditorBottomToolbar.jsx/EditorObjectPropertiesTab.jsx (EditorSidePanel.jsx's
 * tab shell). Split out of EditorTimeline.jsx, which still owns the
 * timeline's own DOM/gesture state and just portals this above it via
 * `toolsSlotNode`; purely presentational here - every value is a prop, every
 * edit goes through `actions`. Zoom is exposed as
 * `onZoomIn`/`onZoomOut`/`onZoomFit` callbacks (not `applyZoom` + a zoom
 * factor) so this component doesn't need to know `ZOOM_FACTOR`. */
export default function EditorTimelineTools({
  L, projectId, scenes, clips, titleCardVariants, logos, overlayVideoSources, actions,
  playheadMs, contentDurationMs, scale, fitScale, maxScale,
  testRange, onClearTestRange, onZoomIn, onZoomOut, onZoomFit, onZoomTo, onOpenShortcuts,
  snapEnabled, onToggleSnap, audioPeaks, audioDurationMs, markerCount, onSeek,
}) {
  const overlayVideoInputRef = useRef(null);
  // Beat detection runs over the decoded bass envelope the waveform already
  // produced (hooks/useAudioPeaks.js) - nothing is decoded a second time, so
  // this is a cheap synchronous pass, but it still only runs on demand rather
  // than on every render.
  const [beatsBusy, setBeatsBusy] = useState(false);
  useEffect(() => { setBeatsBusy(false); }, [audioPeaks]);

  function placeBeatMarkers() {
    if (!audioPeaks || !audioDurationMs) return;
    setBeatsBusy(true);
    const beats = detectBeats(audioPeaks.bass, audioDurationMs);
    actions.setBeatMarkers(beats);
    setBeatsBusy(false);
  }
  async function handleOverlayVideoFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const source = await actions.uploadOverlayVideo(file);
    if (source) actions.addOverlay('video', source.id);
  }

  const usedSceneIndices = new Set(clips.map((c) => c.scene_index));
  const addableScenes = (scenes || [])
    .map((scene, sceneIndex) => ({ scene, sceneIndex }))
    .filter(({ scene, sceneIndex }) => !usedSceneIndices.has(sceneIndex) && (scene.videos || []).length > 0);
  const usedVideoIds = new Set(clips.map((c) => c.video_id));
  const hasAddableVariants = (scenes || [])
    .some((scene) => (scene.videos || []).some((v) => !usedVideoIds.has(v.video_id)));

  return (
    <>
      <div className="tl-toolbar">
        <TimecodeField L={L} playheadMs={playheadMs} onSeek={onSeek} />
        <span className="tl-timecode-total">/ {formatTimecode(contentDurationMs, TIMELINE_FPS)}</span>
        <div className="tl-toolbar-spacer" />
        <button
          className={`icon-btn${snapEnabled ? ' is-active' : ''}`}
          title={snapEnabled ? L.editor_timelineSnapOn : L.editor_timelineSnapOff}
          aria-pressed={!!snapEnabled}
          onClick={() => onToggleSnap(!snapEnabled)}
        >
          <Magnet size={14} />
        </button>
        <button className="icon-btn" title={L.editor_toolZoomOut} onClick={onZoomOut} disabled={scale <= fitScale}>
          <ZoomOut size={14} />
        </button>
        <button className="icon-btn" title={L.editor_toolZoomFit} onClick={onZoomFit}>
          <Maximize2 size={14} />
        </button>
        <button className="icon-btn" title={L.editor_toolZoomIn} onClick={onZoomIn} disabled={scale >= maxScale}>
          <ZoomIn size={14} />
        </button>
        <button className="icon-btn" title={L.editor_shortcutsButton} onClick={onOpenShortcuts}>
          <Keyboard size={14} />
        </button>
      </div>

      {/* Zoom as a continuous slider as well as +/- steps - dragging straight
          to a rough zoom level is how CapCut/Movavi's own timeline zoom
          works, and the stepped buttons alone need many clicks to cross the
          fit..max range. Exponential, so each half of the travel doubles/
          halves the same way the buttons' own ZOOM_FACTOR does. */}
      <div className="tl-toolbar tl-zoom-row">
        <input
          type="range" className="tl-zoom-slider"
          min={0} max={1000} step={1}
          value={Math.round(
            maxScale > fitScale ? (Math.log(scale / fitScale) / Math.log(maxScale / fitScale)) * 1000 : 0,
          )}
          aria-label={L.editor_zoomSliderLabel}
          title={L.editor_zoomSliderLabel}
          onChange={(e) => {
            if (!(maxScale > fitScale)) return;
            const t = Number(e.target.value) / 1000;
            onZoomTo(fitScale * ((maxScale / fitScale) ** t));
          }}
        />
        <button
          className="icon-btn" title={L.editor_beatMarkers}
          onClick={placeBeatMarkers} disabled={!audioPeaks || beatsBusy}
        >
          <Flag size={14} />
        </button>
        <button
          className="icon-btn" title={L.editor_markersClear}
          onClick={() => actions.clearMarkers()} disabled={!markerCount}
        >
          <FlagOff size={14} />
        </button>
      </div>

      <span className="tl-hint">{L.editor_timelineHint}</span>

      {testRange && (
        <span className="tl-inspector-label tl-inspector-row">
          <span className="tl-inspector-rowlabel">{L.editor_testRangeLabel}</span>
          <span className="tl-timecode">
            {formatTimecode(testRange.startMs, TIMELINE_FPS)} → {formatTimecode(testRange.endMs, TIMELINE_FPS)}
          </span>
          <button className="icon-btn" title={L.editor_testRangeClear} onClick={onClearTestRange}>
            <X size={13} />
          </button>
        </span>
      )}

      {(!!addableScenes.length || hasAddableVariants) && (
        <div className="tl-add-row">
          <span className="tl-hint">{L.editor_addSceneLabel}</span>
          {hasAddableVariants && (
            <button
              className="btn-ghost tl-add-chip"
              onClick={() => actions.addAllSceneClips()}
            >
              <Plus size={12} /> {L.editor_addAllScenesLabel}
            </button>
          )}
          {addableScenes.map(({ scene, sceneIndex }) => (
            <button
              key={sceneIndex} className="btn-ghost tl-add-chip"
              onClick={() => {
                const video = (scene.videos || []).find((v) => v.is_selected) || scene.videos[0];
                actions.addSceneClip(sceneIndex, video.video_id);
              }}
            >
              <Plus size={12} /> {sceneLabel(scene, sceneIndex)}
            </button>
          ))}
        </div>
      )}

      <PickerRow label={L.overlay_addLabel} collapsible defaultOpen={false} scrollable>
        {(titleCardVariants || []).map((variant) => (
          <PickerThumb
            key={variant.variant_id} title={L.overlay_kindTitleCard}
            onClick={() => actions.addOverlay('title_card', variant.variant_id)}
          >
            <img
              src={mediaUrl(`projects/${projectId}/${variant.file_path}`)} alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 5 }}
            />
          </PickerThumb>
        ))}
        {(logos || []).map((logo) => (
          <PickerThumb
            key={logo.id} title={logo.name || L.overlay_kindLogo}
            onClick={() => actions.addOverlay('logo', logo.id)}
          >
            <img
              src={mediaUrl(logo.file_path)} alt=""
              style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 5 }}
            />
          </PickerThumb>
        ))}
        {(overlayVideoSources || []).map((source) => (
          <PickerThumb
            key={source.id} title={source.file_path.split('/').pop()}
            onClick={() => actions.addOverlay('video', source.id)}
          >
            <span style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
              <Film size={20} color="var(--text-dim)" />
            </span>
          </PickerThumb>
        ))}
        <PickerThumb title={`${L.overlay_kindText} (Ctrl+T)`} onClick={() => actions.addTextOverlay()}>
          <span style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
            <Type size={20} color="var(--text-dim)" />
          </span>
        </PickerThumb>
        <PickerThumb title={L.overlay_kindVideoUpload} onClick={() => overlayVideoInputRef.current?.click()}>
          <span style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
            <Upload size={18} color="var(--text-dim)" />
          </span>
        </PickerThumb>
        <input
          ref={overlayVideoInputRef} type="file" accept="video/*" style={{ display: 'none' }}
          onChange={handleOverlayVideoFile}
        />
      </PickerRow>
    </>
  );
}
