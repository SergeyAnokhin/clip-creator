/**
 * Pure Editor-stage overlay-lane math, kept out of components/hooks so it can
 * be unit tested the same way `lib/timeline.js` is.
 *
 * An overlay is `{overlay_id, kind: 'title_card'|'logo'|'video', source_id,
 * start_ms, duration_ms, x_pct, y_pct, width_pct, height_pct, rotation_deg,
 * opacity}` - unlike a clip, overlays don't tile back to back: `start_ms`/
 * `duration_ms` are free-floating coordinates on the same output-timeline
 * millisecond axis `lib/timeline.js`'s `computeTimelineClips` uses, so an
 * overlay can sit anywhere, overlap another overlay, or leave gaps.
 * `x_pct`/`y_pct` place the overlay's own top-left corner as a percentage of
 * the render canvas (mirrors ffmpeg's own `overlay=x=:y=` convention -
 * `providers/editor.py`); `width_pct`/`height_pct` scale it independently
 * (no forced aspect lock); `rotation_deg` (0-360) rotates it about its own
 * center; `opacity` (0-1) multiplies whatever alpha the source already
 * carries. Positioning is edited by dragging/resizing/rotating the overlay
 * directly on the program monitor (`EditorPreview.jsx`, via the shared
 * `components/shared/CanvasLayer.jsx` primitive) - mirrors
 * `providers/editor.py`'s overlay compositing on the render side.
 */

export const DEFAULT_OVERLAY_DURATION_MS = 3000;
export const DEFAULT_OVERLAY_WIDTH_PCT = 20;
export const MIN_OVERLAY_WIDTH_PCT = 5;
export const MAX_OVERLAY_WIDTH_PCT = 60;
export const MIN_OVERLAY_MS = 200;

// Older saved overlays (before free x/y/w/h/rotation placement existed) used
// a 9-point grid instead: `position` (one of the keys below) pinned the
// overlay's own matching corner/edge/center to that point, `width_pct` alone
// scaled it (aspect preserved). Kept private, used only by `migrateOverlay`
// below to convert such an overlay the first time it's touched - mirrors
// `providers/editor.py`'s own `_migrate_overlay_position` on the render side.
const _LEGACY_POSITION_PCT = {
  'top-left': [0, 0], 'top-center': [50, 0], 'top-right': [100, 0],
  'center-left': [0, 50], center: [50, 50], 'center-right': [100, 50],
  'bottom-left': [0, 100], 'bottom-center': [50, 100], 'bottom-right': [100, 100],
};
const _LEGACY_DEFAULT_POSITION = 'bottom-right';

/** An overlay with free `x_pct`/`y_pct`/`width_pct`/`height_pct`/
 * `rotation_deg` fields - passes an already-migrated overlay through
 * unchanged, or derives them from an old-shape overlay's `position` (an
 * anchor point) + bare `width_pct` (no `height_pct` existed, so height
 * matches width - a square placeholder, immediately adjustable by dragging).
 * Called lazily wherever `video_edit.overlays` is read (`useEditorStage.js`),
 * so any later edit persists the migrated shape through the normal
 * `commitVideoEdit` autosave - no separate one-time migration pass needed. */
export function migrateOverlay(overlay) {
  if (overlay.x_pct != null && overlay.y_pct != null) return overlay;
  const [anchorXPct, anchorYPct] = _LEGACY_POSITION_PCT[overlay.position] || _LEGACY_POSITION_PCT[_LEGACY_DEFAULT_POSITION];
  const widthPct = overlay.width_pct || DEFAULT_OVERLAY_WIDTH_PCT;
  const heightPct = widthPct;
  // The legacy anchor pins the overlay's own matching corner/edge/center to
  // the point, not always its top-left - e.g. "bottom-right" pins the
  // overlay's bottom-right corner, so its top-left sits a full width/height
  // back from the point (same `translate(-100%, -100%)` logic
  // `overlayPositionStyle` used to apply in CSS).
  const txFrac = anchorXPct === 0 ? 0 : anchorXPct === 100 ? 1 : 0.5;
  const tyFrac = anchorYPct === 0 ? 0 : anchorYPct === 100 ? 1 : 0.5;
  return {
    ...overlay,
    x_pct: anchorXPct - widthPct * txFrac,
    y_pct: anchorYPct - heightPct * tyFrac,
    width_pct: widthPct,
    height_pct: heightPct,
    rotation_deg: overlay.rotation_deg || 0,
  };
}

/** The free-positioning shape a freshly placed overlay starts in - reuses
 * `migrateOverlay`'s legacy-anchor math against the old bottom-right default
 * so a new overlay starts in the same visual spot the old grid default did,
 * without duplicating the anchor->top-left conversion. */
export function defaultOverlayTransform() {
  const { x_pct, y_pct, width_pct, height_pct, rotation_deg } = migrateOverlay({
    position: _LEGACY_DEFAULT_POSITION, width_pct: DEFAULT_OVERLAY_WIDTH_PCT,
  });
  return {
    x_pct, y_pct, width_pct, height_pct, rotation_deg,
  };
}

/** Overlays whose `[start_ms, start_ms+duration_ms)` window contains
 * `playheadMs` - z-order (later = on top) preserved from array order, same
 * as the render's own compositing order. */
export function activeOverlaysAt(overlays, playheadMs) {
  return (overlays || []).filter(
    (o) => playheadMs >= o.start_ms && playheadMs < o.start_ms + o.duration_ms,
  );
}

/** The overlay's `opacity` scaled by a linear fade-in/fade-out ramp at
 * `playheadMs` - `0 -> opacity` over `[start_ms, start_ms+fade_in_ms)`, flat
 * `opacity` in the steady middle, `opacity -> 0` over `[end_ms-fade_out_ms,
 * end_ms)`. If `fade_in_ms + fade_out_ms` would outlast the overlay's own
 * `duration_ms`, both are scaled down proportionally first so they never
 * overlap past the midpoint - same clamp spirit as `providers/editor.py`'s
 * `_resolve_fade` clamping a clip fade to its own content length. Assumes
 * `playheadMs` is already within the overlay's active window (pair with
 * `activeOverlaysAt`, which only returns overlays where that's true) -
 * outside it the ramp math still runs but the result isn't meaningful. */
export function overlayOpacityAt(overlay, playheadMs) {
  const opacity = overlay.opacity ?? 1;
  const durationMs = overlay.duration_ms;
  let fadeInMs = Math.max(0, overlay.fade_in_ms || 0);
  let fadeOutMs = Math.max(0, overlay.fade_out_ms || 0);
  if (fadeInMs + fadeOutMs > durationMs) {
    const scale = durationMs / (fadeInMs + fadeOutMs);
    fadeInMs *= scale;
    fadeOutMs *= scale;
  }
  const startMs = overlay.start_ms;
  const endMs = startMs + durationMs;
  const elapsedMs = playheadMs - startMs;
  let mult = 1;
  if (fadeInMs > 0 && elapsedMs < fadeInMs) {
    mult = elapsedMs / fadeInMs;
  } else if (fadeOutMs > 0 && playheadMs > endMs - fadeOutMs) {
    mult = (endMs - playheadMs) / fadeOutMs;
  }
  return opacity * Math.min(1, Math.max(0, mult));
}

/** New `start_ms` after dragging an overlay block horizontally by
 * `deltaOutputMs` - duration never changes, and it can't be dragged before
 * the timeline start. */
export function applyOverlayMove(overlay, deltaOutputMs) {
  return { startMs: Math.max(0, Math.round(overlay.start_ms + deltaOutputMs)) };
}

/** Assigns each overlay a display-only lane (row) on the timeline's overlay
 * track, so time-overlapping overlays render on separate rows instead of
 * stacking on top of each other and becoming hard to grab - classic
 * interval-graph greedy coloring ("minimum meeting rooms"): sort by
 * `start_ms`, put each overlay in the first lane whose last-placed overlay
 * has already ended by this one's start, else open a new lane. Purely
 * derived/display state - never stored on the overlay itself, so it doesn't
 * affect `applyOverlayMove`/`applyOverlayEdgeResize`'s time-only math or need
 * any change to `useTimelineDrag.js`'s drag handling. Returns
 * `Map<overlay_id, laneIndex>` (0-based). */
export function assignOverlayLanes(overlays) {
  const laneEndMs = []; // laneEndMs[i] = end time of the last overlay placed in lane i
  const result = new Map();
  const sorted = [...(overlays || [])].sort((a, b) => a.start_ms - b.start_ms);
  sorted.forEach((overlay) => {
    const endMs = overlay.start_ms + overlay.duration_ms;
    let laneIndex = laneEndMs.findIndex((end) => end <= overlay.start_ms);
    if (laneIndex === -1) {
      laneIndex = laneEndMs.length;
      laneEndMs.push(endMs);
    } else {
      laneEndMs[laneIndex] = endMs;
    }
    result.set(overlay.overlay_id, laneIndex);
  });
  return result;
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
