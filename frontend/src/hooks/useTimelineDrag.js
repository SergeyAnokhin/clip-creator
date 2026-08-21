import { useEffect, useRef, useState } from 'react';
import { applyEdgeSpeed, applyEdgeTrim, dropIndexForStart } from '../lib/timeline.js';
import { applyOverlayEdgeResize, applyOverlayMove } from '../lib/overlays.js';
import { buildSnapTargets, snapDelta, snapMs, SNAP_PX } from '../lib/timelineSnap.js';

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
 * changes, exactly as when this lived inline in EditorTimeline.jsx).
 *
 * Magnetic snapping (`lib/timelineSnap.js`, CapCut's Track Magnet) is applied
 * here rather than inside the gesture-specific `lib/` helpers, because it is
 * a property of the *interaction*, not of the math: `applyEdgeTrim` and
 * friends stay pure "apply this delta" functions, and this hook decides what
 * the delta actually was once the pointer has been pulled to a nearby clip
 * boundary / overlay edge / marker / the playhead. Holding Alt at any moment
 * during a drag bypasses it, so a frame-exact placement never needs the
 * global toggle turned off. `drag.snapMs` carries whichever target won, for
 * EditorTimeline.jsx to draw a guide line at. */
export function useTimelineDrag({
  actions, scenes, clips, overlays, markers, scale, playheadMs, totalDurationMs, snapEnabled,
}) {
  const contentRef = useRef(null);
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const [drag, setDrag] = useState(null);
  const [dragDx, setDragDx] = useState(0);

  const snapThresholdMs = SNAP_PX / scale;
  function targetsFor({ excludeOverlayId, excludeClipId, includePlayhead = true } = {}) {
    return buildSnapTargets({
      clips: clipsRef.current,
      overlays,
      markers,
      playheadMs: includePlayhead ? playheadMs : undefined,
      totalDurationMs,
      excludeOverlayId,
      excludeClipId,
    });
  }
  /** Whether snapping should run for this pointer event - the global toggle,
   * unless Alt is held right now. Checked per move rather than once per drag
   * so the user can reach for Alt mid-drag to place something exactly. */
  function snapActive(e) {
    return snapEnabled && !e.altKey;
  }
  function setSnapIndicator(snappedTo) {
    setDrag((current) => (current && current.snapMs !== snappedTo ? { ...current, snapMs: snappedTo } : current));
  }

  function pointerToMs(clientX) {
    const rect = contentRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return Math.max(0, (clientX - rect.left) / scale);
  }

  useEffect(() => {
    if (!drag) return undefined;

    function onMove(e) {
      if (drag.mode === 'scrub') {
        const raw = pointerToMs(e.clientX);
        const snapped = snapActive(e)
          ? snapMs(raw, targetsFor({ includePlayhead: false }), snapThresholdMs)
          : { ms: raw, snappedTo: null };
        setSnapIndicator(snapped.snappedTo);
        actions.seek(snapped.ms);
        return;
      }
      if (drag.mode === 'marker') {
        const raw = pointerToMs(e.clientX);
        const snapped = snapActive(e)
          ? snapMs(raw, targetsFor(), snapThresholdMs)
          : { ms: raw, snappedTo: null };
        setSnapIndicator(snapped.snappedTo);
        actions.moveMarker(drag.marker.marker_id, snapped.ms);
        return;
      }
      const dx = e.clientX - drag.startX;
      if (drag.mode === 'move' || drag.mode === 'marquee') {
        setDragDx(dx);
        return;
      }
      if (drag.mode === 'overlay-move') {
        // Both edges are snap candidates - whichever needs the smaller nudge
        // wins, so an overlay lines up by its end just as easily as by its
        // start (CapCut behaves the same way).
        const targets = targetsFor({ excludeOverlayId: drag.overlay.overlay_id });
        const rawDeltaMs = dx / scale;
        const endMs = drag.overlay.start_ms + drag.overlay.duration_ms;
        const byStart = snapDelta(drag.overlay.start_ms, rawDeltaMs, targets, snapThresholdMs, snapActive(e));
        const byEnd = snapDelta(endMs, rawDeltaMs, targets, snapThresholdMs, snapActive(e));
        const best = Math.abs(byStart.deltaMs - rawDeltaMs) <= Math.abs(byEnd.deltaMs - rawDeltaMs) ? byStart : byEnd;
        setSnapIndicator(best.snappedTo);
        setDragDx(best.deltaMs * scale);
        return;
      }
      if (drag.mode === 'overlay-trim-start' || drag.mode === 'overlay-trim-end') {
        const edge = drag.mode === 'overlay-trim-start' ? 'start' : 'end';
        const anchorMs = edge === 'start' ? drag.overlay.start_ms : drag.overlay.start_ms + drag.overlay.duration_ms;
        const snapped = snapDelta(
          anchorMs, dx / scale, targetsFor({ excludeOverlayId: drag.overlay.overlay_id }), snapThresholdMs, snapActive(e),
        );
        setSnapIndicator(snapped.snappedTo);
        const { startMs, durationMs } = applyOverlayEdgeResize(drag.overlay, edge, snapped.deltaMs);
        actions.setOverlayTiming(drag.overlay.overlay_id, startMs, durationMs);
        return;
      }
      const edge = (drag.mode === 'trim-start' || drag.mode === 'speed-start') ? 'start' : 'end';
      if (drag.mode === 'speed-start' || drag.mode === 'speed-end') {
        const { speed } = applyEdgeSpeed(drag.clip, drag.sourceDurationMs, edge, dx / scale);
        actions.setClipSpeed(drag.clip.clip_id, speed);
        return;
      }
      const anchorMs = edge === 'start' ? drag.clip.startMs : drag.clip.endMs;
      const snapped = snapDelta(
        anchorMs, dx / scale, targetsFor({ excludeClipId: drag.clip.clip_id }), snapThresholdMs, snapActive(e),
      );
      setSnapIndicator(snapped.snappedTo);
      const { trimStartMs, trimEndMs } = applyEdgeTrim(drag.clip, drag.sourceDurationMs, edge, snapped.deltaMs);
      actions.setClipTrim(drag.clip.clip_id, trimStartMs, trimEndMs);
    }

    function onUp(e) {
      if (drag.mode === 'move') {
        const newStartMs = drag.startMs + (e.clientX - drag.startX) / scale;
        const toIndex = dropIndexForStart(clipsRef.current, drag.index, newStartMs);
        if (toIndex !== drag.index) actions.reorderClip(drag.index, toIndex);
      } else if (drag.mode === 'overlay-move') {
        // `dragDx` is already the *snapped* offset the block was drawn at
        // (see onMove) - re-deriving it from the raw pointer here would drop
        // the snap on release, i.e. the "it looked aligned until I let go"
        // bug.
        const { startMs } = applyOverlayMove(drag.overlay, dragDx / scale);
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
  }, [drag, dragDx, scale, snapEnabled, playheadMs, overlays, markers, totalDurationMs]);

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

  /** Drag a ruler marker to a new moment - snapped like everything else, so
   * a beat marker nudged by hand still lands on a clip boundary if that is
   * what the user was aiming at. */
  function startMarkerDrag(e, marker) {
    if (e.button !== 0) return;
    e.stopPropagation();
    setDrag({ mode: 'marker', startX: e.clientX, marker });
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
    startTrimDrag, startOverlayDrag, startOverlayTrimDrag, onOverlayKeyDown, startMarkerDrag,
  };
}
