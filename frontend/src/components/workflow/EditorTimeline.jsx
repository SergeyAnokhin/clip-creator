import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { assignOverlayLanes } from '../../lib/overlays.js';
import { resolveOverlaySource } from '../../lib/overlaySource.js';
import { formatClock } from '../../lib/format.js';
import { FRAME_MS } from '../../lib/timeline.js';
import { useTimelineDrag } from '../../hooks/useTimelineDrag.js';
import TimelineAudioTrack from './TimelineAudioTrack.jsx';
import TimelineClipBlock from './TimelineClipBlock.jsx';
import TimelineMarker from './TimelineMarker.jsx';
import TimelineOverlayBlock from './TimelineOverlayBlock.jsx';
import TimelineTransitionMarker from './TimelineTransitionMarker.jsx';
import EditorTimelineTools from './EditorTimelineTools.jsx';
import EditorPreviewContextMenu from './EditorPreviewContextMenu.jsx';

// A zoomed-in timeline is one very wide DOM element (and one equally wide
// waveform <canvas>) - this caps how wide it may get, both for the browser's
// own canvas size limit and to keep scrolling smooth.
const MAX_CONTENT_PX = 20000;
const MIN_CONTENT_MS = 5000;
const RULER_STEPS_MS = [200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000];
const MIN_TICK_GAP_PX = 66;
const ZOOM_FACTOR = 1.6;
// Height of one overlay lane (row) on the overlay track - the track itself
// grows to `laneCount * LANE_H` (see `assignOverlayLanes`) so time-
// overlapping overlays get their own row instead of stacking illegibly;
// close to the old fixed single-lane height (24px) for continuity.
const LANE_H = 22;
// A transition marker is a 16px circle centred on the boundary, so it
// visually eats into both neighbouring clips - below this width on either
// side it would cover most/all of the clip and block clicking it (confirmed
// by hand: a marker can otherwise sit squarely on top of a clip block
// that's narrower than the marker itself). Hidden below this width, same
// "too narrow to interact with, wait for more zoom" precedent as
// useClipThumbnails.js's MIN_SLOT_PX.
const MIN_CLIP_WIDTH_FOR_TRANSITION_PX = 28;
// How far one arrow-key press moves the playhead. CapCut steps a single
// frame, and Shift multiplies it - the point is that the playhead can be put
// exactly where a cut belongs, which "jump to the next clip" (what the arrows
// used to do, now on the up/down arrows) can never do.
const SHIFT_FRAME_STEP = 10;

const VIDEO_TRACK_H = 66;
const AUDIO_TRACK_H = 42;
// Mirrors .tl-ruler's CSS height and .tl-track's margin-top - only needed so
// the marquee-select rectangle can span exactly the video row (not the
// overlay lane(s) above it, which aren't marquee-selectable) without
// actually measuring the DOM. The overlay track's own height is dynamic
// (lane count), so the video row's top offset is computed per-render in the
// component body below, not as a module constant.
const RULER_H = 20;
const TRACK_GAP = 6;

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
 * horizontal drag means "change the order", not "move to this exact time".
 *
 * This component owns the DOM/scroll/zoom state and lays out the timeline's
 * own rows; the direct-manipulation gesture state machine (drag/trim/
 * marquee/scrub) is `useTimelineDrag.js`, and the portaled toolbar/inspector/
 * pickers content is `EditorTimelineTools.jsx` - both split out purely to
 * keep this file to "timeline layout" rather than growing to also own every
 * gesture and every side-panel control. */
export default function EditorTimeline({
  L, projectId, scenes, clips, overlays, markers, totalDurationMs, selectedTrack, playheadMs, isPlaying,
  selectedClipIds, selectedOverlayId, selectedTransitionClipId, isAudioSelected,
  titleCardVariants, logos, overlayVideoSources,
  actions, toolsSlotNode, testRange, onClearTestRange, onOpenShortcuts, waveformScale, colorByFrequency,
  audioPeaks, snapEnabled, onToggleSnap, heightPx,
}) {
  const scrollRef = useRef(null);
  const clipNodesRef = useRef({});
  const pendingScrollRef = useRef(null);
  const [viewportWidth, setViewportWidth] = useState(900);
  const [zoomPxPerMs, setZoomPxPerMs] = useState(null); // null = fit the whole timeline
  // Right-click menu on a clip block - the same component the program monitor
  // uses (EditorPreviewContextMenu.jsx), just with the clicked block as the
  // target instead of whatever sits under the playhead.
  const [clipMenu, setClipMenu] = useState(null);

  const audioDurationMs = selectedTrack?.duration_ms || 0;
  const contentDurationMs = Math.max(totalDurationMs, audioDurationMs, MIN_CONTENT_MS);
  const fitScale = viewportWidth / contentDurationMs;
  const maxScale = Math.max(fitScale, MAX_CONTENT_PX / contentDurationMs);
  const scale = Math.min(Math.max(zoomPxPerMs ?? fitScale, fitScale), maxScale);
  const contentWidth = contentDurationMs * scale;
  const stepMs = rulerStepMs(scale);
  const tickCount = Math.floor(contentDurationMs / stepMs) + 1;
  // The render freeze-frames the last clip over whatever audio is left - show
  // that tail on the timeline instead of letting the row just stop short.
  const padWidth = Math.max(0, audioDurationMs - totalDurationMs) * scale;

  const {
    contentRef, drag, dragDx, startContentPointerDown, startClipDrag, onClipKeyDown,
    startTrimDrag, startOverlayDrag, startOverlayTrimDrag, onOverlayKeyDown, startMarkerDrag,
  } = useTimelineDrag({
    actions, scenes, clips, overlays, markers, scale, playheadMs, totalDurationMs, snapEnabled,
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    setViewportWidth(el.clientWidth || 900);
    const observer = new ResizeObserver(([entry]) => setViewportWidth(entry.contentRect.width || 900));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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
  function zoomIn() { applyZoom(scale * ZOOM_FACTOR); }
  function zoomOut() { applyZoom(scale / ZOOM_FACTOR); }
  function zoomFit() { setZoomPxPerMs(null); }

  useLayoutEffect(() => {
    if (pendingScrollRef.current == null) return;
    const el = scrollRef.current;
    if (el) el.scrollLeft = pendingScrollRef.current;
    pendingScrollRef.current = null;
  }, [scale]);

  // Wheel handling has to be a native, explicitly non-passive listener:
  // React registers its own `wheel` handlers as passive, where
  // `preventDefault()` is ignored and the browser zooms/scrolls the whole page
  // instead. Kept subscribed once, driving through refs, so a playing
  // playhead doesn't re-subscribe it 60 times a second.
  //
  // Ctrl+wheel zooms (unchanged); a bare wheel scrolls the timeline
  // horizontally and Shift+wheel does the same but faster. A vertical wheel
  // over a horizontally-scrolling box otherwise does nothing at all in most
  // browsers, which made the zoomed-in timeline reachable only by dragging
  // its scrollbar - every desktop NLE scrolls it with the wheel instead.
  const zoomRef = useRef(null);
  zoomRef.current = (factor) => applyZoom(scale * factor);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    function onWheel(e) {
      if (e.ctrlKey) {
        e.preventDefault();
        zoomRef.current(e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR);
        return;
      }
      // `deltaX` first so a trackpad's own horizontal gesture keeps working.
      const delta = e.deltaX || e.deltaY;
      if (!delta) return;
      e.preventDefault();
      el.scrollLeft += delta * (e.shiftKey ? 3 : 1);
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

  /** The timeline's own keyboard surface. Everything here is bound to match
   * a desktop NLE (CapCut's set, see KeyboardShortcutsModal.jsx which lists
   * exactly these): left/right step the playhead by a *frame*, up/down walk
   * between clips (what left/right used to do - a clip jump can never put the
   * playhead where a cut belongs, which is what the frame step is for),
   * Home/End go to the ends, Q/W trim the selected clip up to the playhead,
   * S / Ctrl+B split, M drops a marker.
   *
   * The old guard here was `if (e.target !== e.currentTarget) return`, which
   * silently killed every one of these the moment focus sat on a clip block -
   * and arrow navigation *focuses a clip block by design*, so "walk to a clip
   * with the arrows, press Delete" did nothing at all. Guarding against text
   * fields instead (the same check EditorStage.jsx's undo listener uses) is
   * what actually needs excluding. */
  function onKeyDown(e) {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
    const withMod = e.ctrlKey || e.metaKey;

    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      e.preventDefault();
      const frames = e.shiftKey ? SHIFT_FRAME_STEP : 1;
      const direction = e.code === 'ArrowLeft' ? -1 : 1;
      actions.seek(playheadMs + direction * frames * FRAME_MS);
      return;
    }
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      if (!clips.length) return;
      e.preventDefault();
      // With a multi-selection, continue from its far edge in the arrow's
      // direction (rightmost clip for ArrowDown, leftmost for ArrowUp) -
      // matches the single-select case exactly when only one is selected.
      const selectedIndices = clips.reduce((acc, c, i) => {
        if (selectedClipIds.has(c.clip_id)) acc.push(i);
        return acc;
      }, []);
      const currentIndex = selectedIndices.length
        ? (e.code === 'ArrowDown' ? Math.max(...selectedIndices) : Math.min(...selectedIndices))
        : -1;
      const nextIndex = e.code === 'ArrowUp'
        ? Math.max(0, (currentIndex === -1 ? clips.length : currentIndex) - 1)
        : Math.min(clips.length - 1, currentIndex + 1);
      const nextClip = clips[nextIndex];
      actions.selectClip(nextClip.clip_id);
      clipNodesRef.current[nextClip.clip_id]?.focus();
      return;
    }
    if (e.code === 'Home') {
      e.preventDefault();
      actions.seek(0);
      return;
    }
    if (e.code === 'End') {
      e.preventDefault();
      actions.seek(contentDurationMs);
      return;
    }

    if (withMod && (e.code === 'Equal' || e.code === 'NumpadAdd')) {
      e.preventDefault();
      zoomIn();
    } else if (withMod && (e.code === 'Minus' || e.code === 'NumpadSubtract')) {
      e.preventDefault();
      zoomOut();
    } else if (withMod && (e.code === 'Digit0' || e.code === 'Numpad0')) {
      e.preventDefault();
      zoomFit();
    } else if (e.code === 'Space') {
      e.preventDefault();
      (isPlaying ? actions.pause : actions.play)();
    } else if (e.code === 'KeyM' && !withMod) {
      e.preventDefault();
      actions.addMarker();
    } else if (withMod && e.code === 'KeyT') {
      e.preventDefault();
      actions.addTextOverlay();
    } else if (e.code === 'KeyS' && !withMod) {
      actions.splitAtPlayhead();
    } else if (withMod && e.code === 'KeyB') {
      e.preventDefault();
      actions.splitAtPlayhead();
    } else if ((e.code === 'KeyQ' || e.code === 'KeyW') && !withMod && selectedClipIds.size === 1) {
      e.preventDefault();
      actions.trimClipToPlayhead(Array.from(selectedClipIds)[0], e.code === 'KeyQ' ? 'start' : 'end');
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

  // Overlap de-collision for the overlay track: which lane (row) each
  // overlay renders on, and how many lanes tall the track needs to be as a
  // result (at least 1, so an empty track still reserves its usual space).
  const overlayLanes = assignOverlayLanes(overlays);
  const laneCount = overlayLanes.size ? Math.max(...overlayLanes.values()) + 1 : 1;
  const overlayTrackHeight = laneCount * LANE_H;
  const videoTrackTop = RULER_H + TRACK_GAP + overlayTrackHeight + TRACK_GAP;

  const toolsContent = (
    <EditorTimelineTools
      L={L} projectId={projectId} scenes={scenes} clips={clips}
      titleCardVariants={titleCardVariants} logos={logos} overlayVideoSources={overlayVideoSources} actions={actions}
      playheadMs={playheadMs} contentDurationMs={contentDurationMs}
      scale={scale} fitScale={fitScale} maxScale={maxScale}
      onZoomIn={zoomIn} onZoomOut={zoomOut} onZoomFit={zoomFit} onZoomTo={applyZoom}
      testRange={testRange} onClearTestRange={onClearTestRange}
      onOpenShortcuts={onOpenShortcuts}
      snapEnabled={snapEnabled} onToggleSnap={onToggleSnap}
      audioPeaks={audioPeaks} audioDurationMs={audioDurationMs} markerCount={(markers || []).length}
      onSeek={actions.seek}
    />
  );

  const timelineJsx = (
    <div className="tl-panel" style={heightPx ? { height: heightPx } : undefined}>
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
                <span>{formatClock(i * stepMs)}</span>
              </div>
            ))}
            {testRange && (
              <div
                className="tl-test-range-tick"
                style={{ left: testRange.startMs * scale, width: (testRange.endMs - testRange.startMs) * scale }}
                title={`${L.editor_testRangeLabel}: ${formatClock(testRange.startMs)} → ${formatClock(testRange.endMs)}`}
              />
            )}
            {(markers || []).map((marker) => (
              <TimelineMarker
                key={marker.marker_id}
                L={L}
                marker={marker}
                left={marker.at_ms * scale}
                isDragging={drag?.mode === 'marker' && drag.marker.marker_id === marker.marker_id}
                onPointerDown={(e) => startMarkerDrag(e, marker)}
                onRemove={() => actions.removeMarker(marker.marker_id)}
                onRename={(label) => actions.renameMarker(marker.marker_id, label)}
              />
            ))}
          </div>

          <div className="tl-track tl-track-overlay" style={{ height: overlayTrackHeight }}>
            {(overlays || []).map((overlay) => {
              const isDragging = drag?.mode === 'overlay-move' && drag.overlay.overlay_id === overlay.overlay_id;
              const width = Math.max(8, overlay.duration_ms * scale);
              const { src, label } = resolveOverlaySource(overlay, {
                projectId, titleCardVariants, logos, overlayVideoSources, L,
              });
              return (
                <TimelineOverlayBlock
                  key={overlay.overlay_id}
                  src={src}
                  label={label}
                  isSelected={selectedOverlayId === overlay.overlay_id}
                  left={overlay.start_ms * scale + (isDragging ? dragDx : 0)}
                  width={width}
                  top={(overlayLanes.get(overlay.overlay_id) || 0) * LANE_H}
                  height={LANE_H}
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
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    actions.selectClip(clip.clip_id);
                    setClipMenu({ x: e.clientX, y: e.clientY, clip });
                  }}
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

          {/* The audio row is a selectable object of its own (volume/fades/
              offset live in TimelineAudioInspector.jsx), so clicking it must
              select rather than fall through to the background scrub -
              `stopPropagation` on pointerdown is what keeps
              `startContentPointerDown` from also grabbing the playhead. */}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
          <div
            className={`tl-track tl-track-audio${isAudioSelected ? ' is-selected' : ''}`}
            style={{ height: AUDIO_TRACK_H }}
            role="button"
            tabIndex={selectedTrack ? 0 : -1}
            aria-label={L.editor_audioTrackLabel}
            onPointerDown={(e) => {
              if (!selectedTrack || e.button !== 0) return;
              e.stopPropagation();
              actions.selectAudio();
            }}
            onKeyDown={(e) => {
              if (e.code === 'Enter' && selectedTrack) {
                e.preventDefault();
                e.stopPropagation();
                actions.selectAudio();
              }
            }}
          >
            {selectedTrack ? (
              <TimelineAudioTrack
                peaks={audioPeaks} scaleMode={waveformScale}
                colorByFrequency={colorByFrequency}
                widthPx={audioDurationMs * scale} heightPx={AUDIO_TRACK_H}
              />
            ) : (
              <div className="tl-track-empty">{L.editor_noAudioTrack}</div>
            )}
          </div>

          <div className="tl-playhead" style={{ left: playheadMs * scale }}><span /></div>

          {drag?.snapMs != null && (
            <div className="tl-snap-guide" style={{ left: drag.snapMs * scale }} />
          )}

          {drag?.mode === 'marquee' && (() => {
            const startPx = drag.startMs * scale;
            const currentPx = startPx + dragDx;
            return (
              <div
                className="tl-marquee"
                style={{
                  left: Math.min(startPx, currentPx), width: Math.abs(currentPx - startPx),
                  top: videoTrackTop, height: VIDEO_TRACK_H,
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
      {clipMenu && (
        <EditorPreviewContextMenu
          L={L} x={clipMenu.x} y={clipMenu.y} clip={clipMenu.clip} actions={actions}
          onClose={() => setClipMenu(null)}
        />
      )}
    </>
  );
}
