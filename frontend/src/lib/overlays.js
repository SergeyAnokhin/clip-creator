/**
 * Pure Editor-stage overlay-lane math, kept out of components/hooks so it can
 * be unit tested the same way `lib/timeline.js` is.
 *
 * An overlay is `{overlay_id, kind: 'title_card'|'logo', source_id, start_ms,
 * duration_ms, position, width_pct, opacity}` - unlike a clip, overlays don't
 * tile back to back: `start_ms`/`duration_ms` are free-floating coordinates
 * on the same output-timeline millisecond axis `lib/timeline.js`'s
 * `computeTimelineClips` uses, so an overlay can sit anywhere, overlap
 * another overlay, or leave gaps. `position` is one of the 9-point grid keys
 * below; `width_pct` scales it to that fraction of the render canvas's
 * width (aspect preserved); `opacity` (0-1) multiplies whatever alpha the
 * source image already carries. Mirrors `providers/editor.py`'s
 * `_OVERLAY_XY_EXPR`/`_resolve_overlays` on the render side.
 */

export const OVERLAY_POSITIONS = [
  'top-left', 'top-center', 'top-right',
  'center-left', 'center', 'center-right',
  'bottom-left', 'bottom-center', 'bottom-right',
];
export const DEFAULT_OVERLAY_POSITION = 'bottom-right';
export const DEFAULT_OVERLAY_DURATION_MS = 3000;
export const DEFAULT_OVERLAY_WIDTH_PCT = 20;
export const MIN_OVERLAY_WIDTH_PCT = 5;
export const MAX_OVERLAY_WIDTH_PCT = 60;
export const MIN_OVERLAY_MS = 200;

// `[xPct, yPct]` of the frame's own box for each grid key, mirroring
// `providers/editor.py`'s `_OVERLAY_XY_EXPR` (same 9 keys, same 3 buckets
// per axis) - the live preview and the timeline block both place an overlay
// with this, converted to a CSS `top`/`left`/`transform` below.
const _POSITION_PCT = {
  'top-left': [0, 0], 'top-center': [50, 0], 'top-right': [100, 0],
  'center-left': [0, 50], center: [50, 50], 'center-right': [100, 50],
  'bottom-left': [0, 100], 'bottom-center': [50, 100], 'bottom-right': [100, 100],
};

/** `{top, left, transform}` placing an overlay's own corresponding corner/
 * edge/center at its grid point - e.g. "top-right" pins the overlay's own
 * top-right corner there, not its top-left, hence the `translate` offset. */
export function overlayPositionStyle(position) {
  const [xPct, yPct] = _POSITION_PCT[position] || _POSITION_PCT[DEFAULT_OVERLAY_POSITION];
  const tx = xPct === 0 ? '0' : xPct === 100 ? '-100%' : '-50%';
  const ty = yPct === 0 ? '0' : yPct === 100 ? '-100%' : '-50%';
  return { top: `${yPct}%`, left: `${xPct}%`, transform: `translate(${tx}, ${ty})` };
}

/** Overlays whose `[start_ms, start_ms+duration_ms)` window contains
 * `playheadMs` - z-order (later = on top) preserved from array order, same
 * as the render's own compositing order. */
export function activeOverlaysAt(overlays, playheadMs) {
  return (overlays || []).filter(
    (o) => playheadMs >= o.start_ms && playheadMs < o.start_ms + o.duration_ms,
  );
}

/** New `start_ms` after dragging an overlay block horizontally by
 * `deltaOutputMs` - duration never changes, and it can't be dragged before
 * the timeline start. */
export function applyOverlayMove(overlay, deltaOutputMs) {
  return { startMs: Math.max(0, Math.round(overlay.start_ms + deltaOutputMs)) };
}

/** New `{startMs, durationMs}` after dragging one edge of an overlay block
 * by `deltaOutputMs` - unlike a clip's edge-trim, there's no source window
 * to stay inside, only a floor on how short the block can get
 * (`MIN_OVERLAY_MS`) and on `startMs` itself (can't go negative). Dragging
 * the start edge moves both `startMs` and `durationMs` (the end point stays
 * put); dragging the end edge only changes `durationMs`. */
export function applyOverlayEdgeResize(overlay, edge, deltaOutputMs) {
  if (edge === 'start') {
    const endMs = overlay.start_ms + overlay.duration_ms;
    const startMs = Math.min(Math.max(0, overlay.start_ms + deltaOutputMs), endMs - MIN_OVERLAY_MS);
    return { startMs: Math.round(startMs), durationMs: Math.round(endMs - startMs) };
  }
  const durationMs = Math.max(MIN_OVERLAY_MS, overlay.duration_ms + deltaOutputMs);
  return { startMs: overlay.start_ms, durationMs: Math.round(durationMs) };
}
