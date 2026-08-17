import { useRef } from 'react';
import {
  Film, Keyboard, Maximize2, Plus, Redo2, Scissors, Undo2, Upload, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import { mediaUrl } from '../../api/client.js';
import { sceneLabel } from '../../lib/editorClipLabel.js';
import TimelineClipInspector from './TimelineClipInspector.jsx';
import TimelineOverlayInspector from './TimelineOverlayInspector.jsx';
import TimelineTransitionInspector from './TimelineTransitionInspector.jsx';
import { PickerRow, PickerThumb } from './PosterPanels.jsx';

function formatTimecode(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
}

/** The Editor timeline's portaled side-panel content - toolbar, the
 * three-way inspector switch (overlay / transition / clip), and the
 * add-scene/add-overlay pickers. Split out of EditorTimeline.jsx, which
 * still owns the timeline's own DOM/gesture state and just portals this into
 * EditorStage.jsx's side panel via `toolsSlotNode`; purely presentational
 * here - every value is a prop, every edit goes through `actions`. Zoom is
 * exposed as `onZoomIn`/`onZoomOut`/`onZoomFit` callbacks (not `applyZoom`
 * + a zoom factor) so this component doesn't need to know `ZOOM_FACTOR`. */
export default function EditorTimelineTools({
  L, projectId, scenes, clips, overlays, selectedClipIds, selectedOverlayId, selectedTransitionClipId,
  titleCardVariants, logos, overlayVideoSources, actions, playheadMs, contentDurationMs, scale, fitScale, maxScale,
  testRange, onClearTestRange, onZoomIn, onZoomOut, onZoomFit, onOpenShortcuts, canUndo, canRedo,
}) {
  const overlayVideoInputRef = useRef(null);
  async function handleOverlayVideoFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const source = await actions.uploadOverlayVideo(file);
    if (source) actions.addOverlay('video', source.id);
  }
  // The inspector only shows editable fields for an exact single selection -
  // 0 or 2+ selected clips get their own summary states there instead.
  const selectedClip = selectedClipIds.size === 1
    ? clips.find((c) => selectedClipIds.has(c.clip_id)) || null
    : null;
  const selectedScene = selectedClip ? scenes?.[selectedClip.scene_index] : null;
  const selectedSourceMs = selectedClip
    ? ((selectedScene?.videos || []).find((v) => v.video_id === selectedClip.video_id)?.duration_seconds || 0) * 1000
    : 0;
  const selectedOverlay = selectedOverlayId
    ? (overlays || []).find((o) => o.overlay_id === selectedOverlayId) || null
    : null;
  const selectedTransitionClip = selectedTransitionClipId
    ? clips.find((c) => c.clip_id === selectedTransitionClipId) || null
    : null;

  const usedSceneIndices = new Set(clips.map((c) => c.scene_index));
  const addableScenes = (scenes || [])
    .map((scene, sceneIndex) => ({ scene, sceneIndex }))
    .filter(({ scene, sceneIndex }) => !usedSceneIndices.has(sceneIndex) && (scene.videos || []).length > 0);

  return (
    <>
      <div className="tl-toolbar">
        <span className="tl-timecode">{formatTimecode(playheadMs)}<span className="tl-timecode-total"> / {formatTimecode(contentDurationMs)}</span></span>
        <button className="icon-btn" title={L.editor_toolSplit} onClick={actions.splitAtPlayhead} disabled={!clips.length}>
          <Scissors size={14} />
        </button>
        <button className="icon-btn" title={L.editor_undo} onClick={actions.undo} disabled={!canUndo}>
          <Undo2 size={14} />
        </button>
        <button className="icon-btn" title={L.editor_redo} onClick={actions.redo} disabled={!canRedo}>
          <Redo2 size={14} />
        </button>
        <div className="tl-toolbar-spacer" />
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
      <span className="tl-hint">{L.editor_timelineHint}</span>

      {testRange && (
        <span className="tl-inspector-label tl-inspector-row">
          <span className="tl-inspector-rowlabel">{L.editor_testRangeLabel}</span>
          <span className="tl-timecode">{formatTimecode(testRange.startMs)} → {formatTimecode(testRange.endMs)}</span>
          <button className="icon-btn" title={L.editor_testRangeClear} onClick={onClearTestRange}>
            <X size={13} />
          </button>
        </span>
      )}

      {selectedOverlayId ? (
        <TimelineOverlayInspector
          L={L} overlay={selectedOverlay} projectId={projectId}
          titleCardVariants={titleCardVariants} logos={logos} overlayVideoSources={overlayVideoSources} actions={actions}
        />
      ) : selectedTransitionClipId ? (
        <TimelineTransitionInspector L={L} clip={selectedTransitionClip} actions={actions} />
      ) : (
        <TimelineClipInspector
          L={L} clip={selectedClip} scene={selectedScene} sourceDurationMs={selectedSourceMs}
          selectedCount={selectedClipIds.size} selectedClipIds={selectedClipIds} actions={actions}
        />
      )}

      {!!addableScenes.length && (
        <div className="tl-add-row">
          <span className="tl-hint">{L.editor_addSceneLabel}</span>
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
