// Screen-px snap threshold for the Editor's overlay canvas - mirrors
// posterLayers.js's CENTER_SNAP_PX (same magnitude, same feel, kept as its
// own constant since the two canvases are independent).
export const CANVAS_SNAP_PX = 6;

/** Drag-time snap for the Editor's overlay canvas (EditorPreview.jsx) -
 * generalizes posterLayers.js's `snapGroupToCenter` to also snap against the
 * canvas's own edges, not just its center (the concrete ask: dragging an
 * overlay toward the edge of the canvas should snap flush to it instead of
 * requiring pixel-perfect placement). Same technique: reads the node's own
 * client rect, mutates `x()`/`y()` directly on a match (a cheap Konva-node
 * mutation, not a React state update, so it doesn't spam re-renders on every
 * drag frame), and returns where to draw a guide line for this frame.
 *
 * Returns `{ v, h }` - `v` is the x-coordinate (in the node's parent's local
 * space) of a vertical guide line, or `null`; `h` is the y-coordinate of a
 * horizontal guide line, or `null`. Unlike `snapGroupToCenter`'s boolean
 * `{v,h}` (always "at center"), these are real coordinates so the same
 * result can point at a center *or* an edge snap. */
export function snapNodeToCanvas(node, containerW, containerH, effectiveScale = 1) {
  const rect = node.getClientRect({ relativeTo: node.getParent() });
  const threshold = CANVAS_SNAP_PX / effectiveScale;

  function closest(candidates) {
    let best = null;
    candidates.forEach(({ at, from }) => {
      const d = at - from;
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) best = { at, d };
    });
    return best;
  }

  const xHit = closest([
    { at: containerW / 2, from: rect.x + rect.width / 2 },
    { at: 0, from: rect.x },
    { at: containerW, from: rect.x + rect.width },
  ]);
  const yHit = closest([
    { at: containerH / 2, from: rect.y + rect.height / 2 },
    { at: 0, from: rect.y },
    { at: containerH, from: rect.y + rect.height },
  ]);

  if (xHit) node.x(node.x() + xHit.d);
  if (yHit) node.y(node.y() + yHit.d);

  return { v: xHit ? xHit.at : null, h: yHit ? yHit.at : null };
}
