import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Keyboard, Maximize2, Plus, Redo2, Scissors, Undo2, ZoomIn, ZoomOut,
} from 'lucide-react';
import { mediaUrl } from '../../api/client.js';
import { applyEdgeSpeed, applyEdgeTrim, dropIndexForStart } from '../../lib/timeline.js';
import { applyOverlayEdgeResize, applyOverlayMove } from '../../lib/overlays.js';
import { resolveOverlaySource } from '../../lib/overlaySource.js';
import TimelineAudioTrack from './TimelineAudioTrack.jsx';
import TimelineClipInspector from './TimelineClipInspector.jsx';
import TimelineClipBlock from './TimelineClipBlock.jsx';
import TimelineOverlayBlock from './TimelineOverlayBlock.jsx';
import TimelineOverlayInspector from './TimelineOverlayInspector.jsx';
import TimelineTransitionMarker from './TimelineTransitionMarker.jsx';
import TimelineTransitionInspector from './TimelineTransitionInspector.jsx';
import { PickerRow, PickerThumb } from './PosterPanels.jsx';
import { sceneLabel } from '../../lib/editorClipLabel.js';

// A zoomed-in timeline is one very wide DOM element (and one equally wide
// waveform <canvas>) - this caps how wide it may get, both for the browser's
// own canvas size limit and to keep scrolling smooth.
const MAX_CONTENT_PX = 20000;
const MIN_CONTENT_MS = 5000;
const RULER_STEPS_MS = [200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000];
const MIN_TICK_GAP_PX = 66;
const ZOOM_FACTOR = 1.6;
const OVERLAY_TRACK_H = 24;
// A transition marker is a 16px circle centred on the boundary, so it
// visually eats into both neighbouring clips - below this width on either
// side it would cover most/all of the clip and block clicking it (confirmed
// by hand: a marker can otherwise sit squarely on top of a clip block
// that's narrower than the marker itself). Hidden below this width, same
// "too narrow to interact with, wait for more zoom" precedent as
// useClipThumbnails.js's MIN_SLOT_PX.
const MIN_CLIP_WIDTH_FOR_TRANSITION_PX = 28;
const VIDEO_TRACK_H = 66;
const AUDIO_TRACK_H = 42;
// Mirrors .tl-ruler's CSS height and .tl-track's margin-top - only needed so
// the marquee-select rectangle can span exactly the video row (not the
// overlay lane above it, which isn't marquee-selectable) without actually
// measuring the DOM.
const RULER_H = 20;
const TRACK_GAP = 6;
const VIDEO_TRACK_TOP = RULER_H + TRACK_GAP + OVERLAY_TRACK_H + TRACK_GAP;

function formatTimecode(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
}

function rulerStepMs(scale) {
  return RULER_STEPS_MS.find((step) => step * scale >= MIN_TICK_GAP_PX) || RULER_STEPS_MS[RULER_STEPS_MS.length - 1];
}

/** The Editor stage's timeline, laid out like a normal NLE (CapCut/Premiere):
 * a time ruler, an overlay lane, one video row of clip blocks drawn to
 * scale, the audio track's waveform under it on the same scale, and a
 * playhead across all of it. Everything is direct manipulation - drag a
 * block to reorder, drag its edges to trim, drag the ruler to scrub,
 * ctrl+wheel or the toolbar to zoom - with TimelineClipInspector.jsx
 * underneath for the exact values a drag can't set. A small
 * `TimelineTransitionMarker` sits on every boundary between two clips (click
 * to open `TimelineTransitionInspector.jsx`) - a transition is a property of
 * the boundary, not a resizable block, since it doesn't get its own
 * dedicated timeline space (see `lib/timeline.js`'s file-header comment for
 * why).
 *
 * Layout is purely a function of `scale` (px per output millisecond): the
 * clips arrive pre-annotated with `startMs`/`durationMs` from
 * `lib/timeline.js`, so nothing here recomputes timeline math, and every
 * gesture ends in one of the existing `useEditorStage` actions. The timeline
 * has no gaps by design - the render concatenates clips back to back - so a
 * horizontal drag means "change the order", not "move to this exact time". */
export default function EditorTimeline({
  L, projectId, scenes, clips, overlays, totalDurationMs, selectedTrack, playheadMs, isPlaying,
  selectedClipIds, selectedOverlayId, selectedTransitionClipId, titleCardVariants, logos,
  actions, toolsSlotNode, onOpenShortcuts, canUndo, canRedo,
}) {
  const scrollRef = useRef(null);
  const contentRef = useRef(null);
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const clipNodesRef = useRef({});
  const pendingScrollRef = useRef(null);
  const [viewportWidth, setViewportWidth] = useState(900);
  const [zoomPxPerMs, setZoomPxPerMs] = useState(null); // null = fit the whole timeline
  const [drag, setDrag] = useState(null);
  const [dragDx, setDragDx] = useState(0);

  const audioDurationMs = selectedTrack?.duration_ms || 0;
  const contentDurationMs = Math.max(totalDurationMs, audioDurationMs, MIN_CONTENT_MS);
  const fitScale = viewportWidth / contentDurationMs;
  const maxScale = Math.max(fitScale, MAX_CONTENT_PX / contentDurationMs);
  const scale = Math.min(Math.max(zoomPxPerMs ?? fitScale, fitScale), maxScale);
  const contentWidth = contentDurationMs * scale;
  const stepMs = rulerStepMs(scale);
  const tickCount = Math.floor(contentDurationMs / stepMs) + 1;
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
  // The render freeze-frames the last clip over whatever audio is left - show
  // that tail on the timeline instead of letting the row just stop short.
  const padWidth = Math.max(0, audioDurationMs - totalDurationMs) * scale;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    setViewportWidth(el.clientWidth || 900);
    const observer = new ResizeObserver(([entry]) => setViewportWidth(entry.contentRect.width || 900));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  function pointerToMs(clientX) {
    const rect = contentRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return Math.max(0, (clientX - rect.left) / scale);
  }

  // ---------- gestures ----------
  useEffect(() => {
    if (!drag) return undefined;

    function onMove(e) {
      if (drag.mode === 'scrub') {
        actions.seek(pointerToMs(e.clientX));
        return;
      }
      const dx = e.clientX - drag.startX;
      if (drag.mode === 'move' || drag.mode === 'marquee' || drag.mode === 'overlay-move') {
        setDragDx(dx);
        return;
      }
      if (drag.mode === 'overlay-trim-start' || drag.mode === 'overlay-trim-end') {
        const edge = drag.mode === 'overlay-trim-start' ? 'start' : 'end';
        const { startMs, durationMs } = applyOverlayEdgeResize(drag.overlay, edge, dx / scale);
        actions.setOverlayTiming(drag.overlay.overlay_id, startMs, durationMs);
        return;
      }
      const edge = (drag.mode === 'trim-start' || drag.mode === 'speed-start') ? 'start' : 'end';
      if (drag.mode === 'speed-start' || drag.mode === 'speed-end') {
        const { speed } = applyEdgeSpeed(drag.clip, drag.sourceDurationMs, edge, dx / scale);
        actions.setClipSpeed(drag.clip.clip_id, speed);
        return;
      }
      const { trimStartMs, trimEndMs } = applyEdgeTrim(drag.clip, drag.sourceDurationMs, edge, dx / scale);
      actions.setClipTrim(drag.clip.clip_id, trimStartMs, trimEndMs);
    }

    function onUp(e) {
      if (drag.mode === 'move') {
        const newStartMs = drag.startMs + (e.clientX - drag.startX) / scale;
        const toIndex = dropIndexForStart(clipsRef.current, drag.index, newStartMs);
        if (toIndex !== drag.index) actions.reorderClip(drag.index, toIndex);
      } else if (drag.mode === 'overlay-move') {
        const { startMs } = applyOverlayMove(drag.overlay, (e.clientX - drag.startX) / scale);
        actions.setOverlayTiming(drag.overlay.overlay_id, startMs, drag.overlay.duration_ms);
      } else if (drag.mode === 'marquee') {
        const endMs = pointerToMs(e.clientX);
        const fromMs = Math.min(drag.startMs, endMs);
        const toMs = Math.max(drag.startMs, endMs);
        const ids = clipsRef.current
          .filter((c) => c.startMs < toMs && c.startMs + c.durationMs > fromMs)
          .map((c) => c.clip_id);
        actions.setSelection(ids);
      }
      setDrag(null);
      setDragDx(0);
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, scale]);

  function startScrub(e) {
    if (e.button !== 0) return;
    actions.seek(pointerToMs(e.clientX));
    setDrag({ mode: 'scrub' });
  }

  /** Dispatches a background pointerdown on `.tl-content` to either a scrub
   * (the default - drag the ruler/track to move the playhead) or a marquee
   * rectangle select. Since clips tile the video row edge to edge (no gaps
   * by design - see the file header comment) there's rarely bare row space
   * to start a marquee from, so it's also reachable by holding Shift/Ctrl
   * anywhere in the content area, not just over genuinely empty track
   * background (the freeze-tail pad, or an empty timeline). */
  function startContentPointerDown(e) {
    if (e.button !== 0) return;
    const overTrackBg = e.target.closest('.tl-track')
      && !e.target.closest('.tl-track-audio') && !e.target.closest('.tl-track-overlay');
    if (overTrackBg || e.shiftKey || e.ctrlKey || e.metaKey) {
      setDrag({ mode: 'marquee', startX: e.clientX, startMs: pointerToMs(e.clientX) });
      setDragDx(0);
      return;
    }
    actions.selectClip(null);
    startScrub(e);
  }

  function startClipDrag(e, clip, index) {
    if (e.button !== 0) return;
    e.stopPropagation();
    // A modifier click builds/extends the selection - it must not also drag
    // the one clip that happened to be under the pointer.
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      actions.selectClip(clip.clip_id, { additive: e.ctrlKey || e.metaKey, range: e.shiftKey });
      return;
    }
    actions.selectClip(clip.clip_id);
    setDrag({ mode: 'move', index, startX: e.clientX, startMs: clip.startMs });
  }

  function onClipKeyDown(e, clip) {
    if (e.code === 'Enter' || e.code === 'Space') {
      e.preventDefault();
      e.stopPropagation();
      actions.selectClip(clip.clip_id);
    }
  }

  /** Edge-drag: plain drag trims (moves that edge's cut point), Ctrl/Cmd+drag
   * instead ramps `speed` and leaves the trim window untouched (see
   * applyEdgeSpeed's docstring). Whichever modifier was held at drag *start*
   * decides the gesture for the whole drag, even if released mid-drag - the
   * same convention `startClipDrag`'s modifier check uses. */
  function startTrimDrag(e, clip, edge) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const video = (scenes?.[clip.scene_index]?.videos || []).find((v) => v.video_id === clip.video_id);
    actions.selectClip(clip.clip_id);
    const speedMode = e.ctrlKey || e.metaKey;
    setDrag({
      mode: speedMode ? (edge === 'start' ? 'speed-start' : 'speed-end') : (edge === 'start' ? 'trim-start' : 'trim-end'),
      startX: e.clientX,
      clip,
      sourceDurationMs: (video?.duration_seconds || 0) * 1000,
    });
  }

  function startOverlayDrag(e, overlay) {
    if (e.button !== 0) return;
    e.stopPropagation();
    actions.selectOverlay(overlay.overlay_id);
    setDrag({ mode: 'overlay-move', startX: e.clientX, overlay });
  }

  function startOverlayTrimDrag(e, overlay, edge) {
    if (e.button !== 0) return;
    e.stopPropagation();
    actions.selectOverlay(overlay.overlay_id);
    setDrag({ mode: edge === 'start' ? 'overlay-trim-start' : 'overlay-trim-end', startX: e.clientX, overlay });
  }

  function onOverlayKeyDown(e, overlay) {
    if (e.code === 'Enter' || e.code === 'Space') {
      e.preventDefault();
      e.stopPropagation();
      actions.selectOverlay(overlay.overlay_id);
    }
  }

  // ---------- zoom ----------
  function applyZoom(nextScaleRaw) {
    const el = scrollRef.current;
    const nextScale = Math.min(Math.max(nextScaleRaw, fitScale), maxScale);
    // Keep whatever is under the playhead (or the viewport centre when the
    // playhead is off screen) pinned in place while the scale changes.
    const scrollLeft = el?.scrollLeft || 0;
    const width = el?.clientWidth || viewportWidth;
    const playheadPx = playheadMs * scale;
    const anchorMs = playheadPx >= scrollLeft && playheadPx <= scrollLeft + width
      ? playheadMs
      : (scrollLeft + width / 2) / scale;
    const anchorOffsetPx = anchorMs * scale - scrollLeft;
    // Applied in the layout effect below, not here: the scroll offset only
    // exists once the re-render has actually widened the content, otherwise
    // the browser clamps it to the old (narrower) scroll range.
    pendingScrollRef.current = Math.max(0, anchorMs * nextScale - anchorOffsetPx);
    setZoomPxPerMs(nextScale);
  }

  useLayoutEffect(() => {
    if (pendingScrollRef.current == null) return;
    const el = scrollRef.current;
    if (el) el.scrollLeft = pendingScrollRef.current;
    pendingScrollRef.current = null;
  }, [scale]);

  // Ctrl+wheel zoom has to be a native, explicitly non-passive listener:
  // React registers its own `wheel` handlers as passive, where
  // `preventDefault()` is ignored and the browser zooms the whole page
  // instead. Kept subscribed once, driving through refs, so a playing
  // playhead doesn't re-subscribe it 60 times a second.
  const zoomRef = useRef(null);
  zoomRef.current = (factor) => applyZoom(scale * factor);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    function onWheel(e) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomRef.current(e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR);
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Follow the playhead while playing, but never fight a zoom/scroll the user
  // is doing by hand mid-playback (hence the generous margins).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isPlaying || drag) return;
    const x = playheadMs * scale;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 40) {
      el.scrollLeft = Math.max(0, x - el.clientWidth * 0.3);
    }
  }, [playheadMs, isPlaying, scale, drag]);

  function onKeyDown(e) {
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      if (!clips.length) return;
      e.preventDefault();
      // With a multi-selection, continue from its far edge in the arrow's
      // direction (rightmost clip for ArrowRight, leftmost for ArrowLeft) -
      // matches the single-select case exactly when only one is selected.
      const selectedIndices = clips.reduce((acc, c, i) => {
        if (selectedClipIds.has(c.clip_id)) acc.push(i);
        return acc;
      }, []);
      const currentIndex = selectedIndices.length
        ? (e.code === 'ArrowRight' ? Math.max(...selectedIndices) : Math.min(...selectedIndices))
        : -1;
      const nextIndex = e.code === 'ArrowLeft'
        ? Math.max(0, (currentIndex === -1 ? clips.length : currentIndex) - 1)
        : Math.min(clips.length - 1, currentIndex + 1);
      const nextClip = clips[nextIndex];
      actions.selectClip(nextClip.clip_id);
      clipNodesRef.current[nextClip.clip_id]?.focus();
      return;
    }
    if (e.target !== e.currentTarget) return;
    const withMod = e.ctrlKey || e.metaKey;
    if (e.code === 'Space') {
      e.preventDefault();
      (isPlaying ? actions.pause : actions.play)();
    } else if (e.code === 'KeyS') {
      actions.splitAtPlayhead();
    } else if (withMod && e.code === 'KeyA') {
      e.preventDefault();
      actions.selectAll();
    } else if (withMod && e.code === 'KeyD' && selectedClipIds.size) {
      e.preventDefault();
      actions.duplicateClips(Array.from(selectedClipIds));
    } else if (withMod && e.code === 'KeyC' && selectedClipIds.size) {
      e.preventDefault();
      actions.copyClips(Array.from(selectedClipIds));
    } else if (withMod && e.code === 'KeyV') {
      e.preventDefault();
      actions.pasteClips();
    } else if ((e.code === 'Delete' || e.code === 'Backspace') && selectedClipIds.size) {
      e.preventDefault();
      actions.removeClips(Array.from(selectedClipIds));
    } else if ((e.code === 'Delete' || e.code === 'Backspace') && selectedOverlayId) {
      e.preventDefault();
      actions.removeOverlay(selectedOverlayId);
    } else if ((e.code === 'Delete' || e.code === 'Backspace') && selectedTransitionClipId) {
      e.preventDefault();
      actions.setClipTransition(selectedTransitionClipId, 'none', 0);
    }
  }

  const usedSceneIndices = new Set(clips.map((c) => c.scene_index));
  const addableScenes = (scenes || [])
    .map((scene, sceneIndex) => ({ scene, sceneIndex }))
    .filter(({ scene, sceneIndex }) => !usedSceneIndices.has(sceneIndex) && (scene.videos || []).length > 0);

  const toolsContent = (
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
        <button className="icon-btn" title={L.editor_toolZoomOut} onClick={() => applyZoom(scale / ZOOM_FACTOR)} disabled={scale <= fitScale}>
          <ZoomOut size={14} />
        </button>
        <button className="icon-btn" title={L.editor_toolZoomFit} onClick={() => setZoomPxPerMs(null)}>
          <Maximize2 size={14} />
        </button>
        <button className="icon-btn" title={L.editor_toolZoomIn} onClick={() => applyZoom(scale * ZOOM_FACTOR)} disabled={scale >= maxScale}>
          <ZoomIn size={14} />
        </button>
        <button className="icon-btn" title={L.editor_shortcutsButton} onClick={onOpenShortcuts}>
          <Keyboard size={14} />
        </button>
      </div>
      <span className="tl-hint">{L.editor_timelineHint}</span>

      {selectedOverlayId ? (
        <TimelineOverlayInspector
          L={L} overlay={selectedOverlay} projectId={projectId}
          titleCardVariants={titleCardVariants} logos={logos} actions={actions}
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

      {(!!titleCardVariants?.length || !!logos?.length) && (
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
        </PickerRow>
      )}
    </>
  );

  const timelineJsx = (
    <div className="tl-panel">
      {/* The scroll box is the timeline's own keyboard surface (arrows move
          between clips, Space/S/Delete act on them), so it has to be
          focusable and listen for keys while staying a container rather than
          a control - the two rules below assume that combination is a
          mistake. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions */}
      <div className="tl-scroll" ref={scrollRef} role="application" aria-label={L.editor_timelineLabel} onKeyDown={onKeyDown} tabIndex={0}>
        <div
          className="tl-content" ref={contentRef} style={{ width: contentWidth }}
          onPointerDown={startContentPointerDown}
        >
          <div className="tl-ruler">
            {Array.from({ length: tickCount }, (_, i) => (
              <div key={i} className="tl-tick" style={{ left: i * stepMs * scale }}>
                <span>{formatTimecode(i * stepMs)}</span>
              </div>
            ))}
          </div>

          <div className="tl-track tl-track-overlay" style={{ height: OVERLAY_TRACK_H }}>
            {(overlays || []).map((overlay) => {
              const isDragging = drag?.mode === 'overlay-move' && drag.overlay.overlay_id === overlay.overlay_id;
              const width = Math.max(8, overlay.duration_ms * scale);
              const { src, label } = resolveOverlaySource(overlay, { projectId, titleCardVariants, logos, L });
              return (
                <TimelineOverlayBlock
                  key={overlay.overlay_id}
                  src={src}
                  label={label}
                  isSelected={selectedOverlayId === overlay.overlay_id}
                  left={overlay.start_ms * scale + (isDragging ? dragDx : 0)}
                  width={width}
                  onBlockPointerDown={(e) => startOverlayDrag(e, overlay)}
                  onKeyDown={(e) => onOverlayKeyDown(e, overlay)}
                  onTrimStartPointerDown={(e) => startOverlayTrimDrag(e, overlay, 'start')}
                  onTrimEndPointerDown={(e) => startOverlayTrimDrag(e, overlay, 'end')}
                />
              );
            })}
          </div>

          <div className="tl-track" style={{ height: VIDEO_TRACK_H }}>
            {!clips.length && <div className="tl-track-empty">{L.editor_timelineEmpty}</div>}
            {clips.map((clip, index) => {
              const scene = scenes?.[clip.scene_index];
              const isDragging = drag?.mode === 'move' && drag.index === index;
              const width = Math.max(8, clip.durationMs * scale);
              return (
                <TimelineClipBlock
                  key={clip.clip_id}
                  clip={clip}
                  scene={scene}
                  projectId={projectId}
                  selectedClipIds={selectedClipIds}
                  isDragging={isDragging}
                  left={clip.startMs * scale + (isDragging ? dragDx : 0)}
                  width={width}
                  nodeRef={(el) => { if (el) clipNodesRef.current[clip.clip_id] = el; else delete clipNodesRef.current[clip.clip_id]; }}
                  onBlockPointerDown={(e) => startClipDrag(e, clip, index)}
                  onKeyDown={(e) => onClipKeyDown(e, clip)}
                  onTrimStartPointerDown={(e) => startTrimDrag(e, clip, 'start')}
                  onTrimEndPointerDown={(e) => startTrimDrag(e, clip, 'end')}
                />
              );
            })}
            {padWidth > 2 && (
              <div className="tl-clip-pad" style={{ left: totalDurationMs * scale, width: padWidth }} title={L.editor_freezeTailHint}>
                <span>{L.editor_freezeTail}</span>
              </div>
            )}
            {clips.slice(1).map((clip, i) => {
              const prevWidth = Math.max(8, clips[i].durationMs * scale);
              const thisWidth = Math.max(8, clip.durationMs * scale);
              if (prevWidth < MIN_CLIP_WIDTH_FOR_TRANSITION_PX || thisWidth < MIN_CLIP_WIDTH_FOR_TRANSITION_PX) return null;
              return (
                <TimelineTransitionMarker
                  key={clip.clip_id}
                  L={L}
                  hasTransition={!!clip.transition_in}
                  isSelected={selectedTransitionClipId === clip.clip_id}
                  left={clip.startMs * scale}
                  onClick={(e) => { e.stopPropagation(); actions.selectTransition(clip.clip_id); }}
                />
              );
            })}
          </div>

          <div className="tl-track tl-track-audio" style={{ height: AUDIO_TRACK_H }}>
            {selectedTrack ? (
              <TimelineAudioTrack
                projectId={projectId} track={selectedTrack}
                widthPx={audioDurationMs * scale} heightPx={AUDIO_TRACK_H}
              />
            ) : (
              <div className="tl-track-empty">{L.editor_noAudioTrack}</div>
            )}
          </div>

          <div className="tl-playhead" style={{ left: playheadMs * scale }}><span /></div>

          {drag?.mode === 'marquee' && (() => {
            const startPx = drag.startMs * scale;
            const currentPx = startPx + dragDx;
            return (
              <div
                className="tl-marquee"
                style={{
                  left: Math.min(startPx, currentPx), width: Math.abs(currentPx - startPx),
                  top: VIDEO_TRACK_TOP, height: VIDEO_TRACK_H,
                }}
              />
            );
          })()}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {timelineJsx}
      {toolsSlotNode ? createPortal(toolsContent, toolsSlotNode) : <div className="tl-panel tl-tools-fallback">{toolsContent}</div>}
    </>
  );
}
