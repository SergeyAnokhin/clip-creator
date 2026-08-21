/**
 * Magnetic snapping for the Editor's *timeline* (`useTimelineDrag.js`) - the
 * horizontal, time-axis counterpart to `lib/snapping.js`, which does the same
 * job for the program monitor's 2D overlay canvas. Kept as its own pure
 * module (no DOM, no Konva) so the target-picking rules are unit testable the
 * way `lib/timeline.js`'s layout math already is.
 *
 * This is CapCut's "Auto Snapping"/Track Magnet: while dragging an overlay,
 * trimming a clip edge, or moving a marker, the value being dragged jumps to
 * a nearby *meaningful* moment - a clip boundary, another overlay's edge, a
 * marker, the playhead, or either end of the timeline - instead of landing on
 * whatever millisecond the pointer happened to be over. Holding Alt bypasses
 * it entirely (same convention CapCut uses), which is why every caller passes
 * `enabled` rather than this module reading a setting itself.
 *
 * The threshold is expressed in *screen pixels* and converted to ms by the
 * caller's current `scale` (px per output ms) - same technique
 * `lib/snapping.js` uses with `CANVAS_SNAP_PX / effectiveScale`, so the snap
 * feels equally "sticky" at every zoom level rather than covering a wildly
 * different slice of time when zoomed in.
 */

export const SNAP_PX = 8;

/** Every moment worth snapping to, de-duplicated and sorted ascending.
 * `excludeOverlayId` drops the overlay currently being dragged (an overlay
 * must not snap to its own edges), and `excludeClipId` does the same for a
 * clip edge being trimmed. Marker/overlay/clip inputs are all optional, so a
 * caller that has no markers yet doesn't have to pass an empty array. */
export function buildSnapTargets({
  clips, overlays, markers, playheadMs, totalDurationMs, excludeOverlayId, excludeClipId,
} = {}) {
  const out = [0];
  if (Number.isFinite(playheadMs)) out.push(playheadMs);
  if (Number.isFinite(totalDurationMs)) out.push(totalDurationMs);
  (clips || []).forEach((clip) => {
    if (excludeClipId && clip.clip_id === excludeClipId) return;
    out.push(clip.startMs, clip.endMs);
  });
  (overlays || []).forEach((overlay) => {
    if (excludeOverlayId && overlay.overlay_id === excludeOverlayId) return;
    out.push(overlay.start_ms, overlay.start_ms + overlay.duration_ms);
  });
  (markers || []).forEach((marker) => out.push(marker.at_ms));
  return [...new Set(out.filter((ms) => Number.isFinite(ms) && ms >= 0))].sort((a, b) => a - b);
}

/** The nearest target within `thresholdMs` of `valueMs`, or `valueMs`
 * untouched. Returns `{ms, snappedTo}` - `snappedTo` is the target that won
 * (so the caller can draw a guide line there) or `null` when nothing was
 * close enough. Ties go to the smaller target, which only matters for exactly
 * equidistant duplicates and keeps the result deterministic. */
export function snapMs(valueMs, targets, thresholdMs) {
  let best = null;
  let bestDistance = Infinity;
  (targets || []).forEach((target) => {
    const distance = Math.abs(target - valueMs);
    if (distance <= thresholdMs && distance < bestDistance) {
      bestDistance = distance;
      best = target;
    }
  });
  return best == null ? { ms: valueMs, snappedTo: null } : { ms: best, snappedTo: best };
}

/** Convenience wrapper for the drag handlers: converts a *delta* in ms into a
 * snapped delta by snapping the resulting absolute position instead. `anchorMs`
 * is where the dragged edge/block starts out, so `anchorMs + deltaMs` is where
 * the pointer wants it. Returns `{deltaMs, snappedTo}` - the caller keeps
 * working in deltas (which is what `applyOverlayMove`/`applyEdgeTrim` take)
 * without having to redo the snap arithmetic itself. */
export function snapDelta(anchorMs, deltaMs, targets, thresholdMs, enabled = true) {
  if (!enabled) return { deltaMs, snappedTo: null };
  const { ms, snappedTo } = snapMs(anchorMs + deltaMs, targets, thresholdMs);
  return { deltaMs: ms - anchorMs, snappedTo };
}
