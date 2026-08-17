import { useEffect, useRef, useState } from 'react';
import { applyEdgeSpeed, applyEdgeTrim, dropIndexForStart } from '../lib/timeline.js';
import { applyOverlayEdgeResize, applyOverlayMove } from '../lib/overlays.js';

/** EditorTimeline.jsx's direct-manipulation gesture state machine - every
 * pointer drag on the timeline (reorder a clip, trim/speed-ramp its edges,
 * move/resize an overlay, scrub the playhead, marquee-select) funnels
 * through the one `drag`/`dragDx` state pair here, split out because it's
 * self-contained: nothing else in the timeline needs to know *how* a drag
 * resolves into an `actions` call, only the resulting `drag`/`dragDx` for
 * rendering the dragged block's live offset.
 *
 * Owns `contentRef` (attach to the `.tl-content` element) since `pointerToMs`
 * - used by scrub and marquee - needs its `getBoundingClientRect()`. `scale`
 * is read fresh on every render (not memoized), so an in-progress drag keeps
 * using up-to-date math if the timeline is zoomed mid-drag (the pointermove
 * effect's own `[drag, scale]` dependency array re-subscribes when it
 * changes, exactly as when this lived inline in EditorTimeline.jsx). */
export function useTimelineDrag({
  actions, scenes, clips, scale, onRangeSelected,
}) {
  const contentRef = useRef(null);
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const [drag, setDrag] = useState(null);
  const [dragDx, setDragDx] = useState(0);

  function pointerToMs(clientX) {
    const rect = contentRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return Math.max(0, (clientX - rect.left) / scale);
  }

  useEffect(() => {
    if (!drag) return undefined;

    function onMove(e) {
      if (drag.mode === 'scrub') {
        actions.seek(pointerToMs(e.clientX));
        return;
      }
      const dx = e.clientX - drag.startX;
      if (drag.mode === 'move' || drag.mode === 'marquee' || drag.mode === 'overlay-move' || drag.mode === 'range-select') {
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
      } else if (drag.mode === 'range-select') {
        const endMs = pointerToMs(e.clientX);
        const fromMs = Math.min(drag.startMs, endMs);
        const toMs = Math.max(drag.startMs, endMs);
        // A plain click (no real drag) would otherwise set a degenerate
        // zero-width range - only commit one past a small minimum width.
        if (toMs - fromMs >= 50) onRangeSelected?.(fromMs, toMs);
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
   * by design) there's rarely bare row space to start a marquee from, so
   * it's also reachable by holding Shift/Ctrl anywhere in the content area,
   * not just over genuinely empty track background (the freeze-tail pad, or
   * an empty timeline). */
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

  /** Drag on the timeline ruler defines an ephemeral test-render range
   * (`EditorTimeline.jsx`'s `testRange`, threaded up to `EditorStage.jsx`'s
   * "Собрать тестовое видео" button) - a dedicated gesture on `.tl-ruler`
   * rather than reusing `startContentPointerDown`'s scrub/marquee (the
   * ruler sits outside `.tl-track`, so it already falls through to that
   * handler's scrub-by-default path; this needs `stopPropagation` to take
   * priority there instead). */
  function startRangeSelect(e) {
    if (e.button !== 0) return;
    e.stopPropagation();
    setDrag({ mode: 'range-select', startX: e.clientX, startMs: pointerToMs(e.clientX) });
    setDragDx(0);
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

  return {
    contentRef, drag, dragDx,
    startScrub, startContentPointerDown, startClipDrag, onClipKeyDown,
    startTrimDrag, startOverlayDrag, startOverlayTrimDrag, onOverlayKeyDown,
    startRangeSelect,
  };
}
