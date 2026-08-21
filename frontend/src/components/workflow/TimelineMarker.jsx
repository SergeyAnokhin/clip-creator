import { Flag } from 'lucide-react';

/** One marker flag on the timeline ruler - a labelled moment the user pins
 * (`M`, or the "по битам" batch button) so cuts, trims and overlay edges can
 * snap to it (`lib/timelineSnap.js`). Markers are an editing aid only: the
 * renderer never reads `video_edit.markers`.
 *
 * Kept as its own component rather than inline in EditorTimeline.jsx's ruler
 * for the same reason `TimelineClipBlock`/`TimelineOverlayBlock` are - the
 * ruler's own JSX stays about ticks and the test-range band, and the flag
 * keeps its own hover/label/keyboard behaviour in one place. Drag to move
 * (snapped, via `useTimelineDrag`'s `startMarkerDrag`), double-click to
 * rename, right-click or Delete while focused to remove. */
export default function TimelineMarker({
  L, marker, left, isDragging, onPointerDown, onRemove, onRename,
}) {
  function promptRename() {
    // eslint-disable-next-line no-alert -- a one-field rename is exactly what
    // window.prompt is for; a full modal here would be more chrome than the
    // interaction is worth, and the poster/title-card stages set no
    // precedent for an inline-rename primitive to reuse.
    const next = window.prompt(L.editor_markerRenamePrompt, marker.label || '');
    if (next != null) onRename(next);
  }

  return (
    <div
      className={`tl-marker${isDragging ? ' is-dragging' : ''}`}
      style={{ left }}
      title={marker.label || L.editor_markerHint}
      role="button"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={promptRename}
      onContextMenu={(e) => { e.preventDefault(); onRemove(); }}
      onKeyDown={(e) => {
        if (e.code === 'Delete' || e.code === 'Backspace') {
          e.preventDefault();
          e.stopPropagation();
          onRemove();
        } else if (e.code === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          promptRename();
        }
      }}
    >
      <Flag size={10} />
      {!!marker.label && <span className="tl-marker-label">{marker.label}</span>}
    </div>
  );
}
