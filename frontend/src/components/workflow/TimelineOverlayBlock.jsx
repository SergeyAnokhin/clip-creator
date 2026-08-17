/** One block on the timeline's overlay track - a title-card variant, logo,
 * or video placed over the video for a `[start_ms, start_ms+duration_ms)`
 * window. Unlike `TimelineClipBlock.jsx` there's no frame sampling: the
 * overlay's own source image (already static, or - for a video overlay - a
 * broken/absent `background-image`, which just renders as no image, same as
 * a dangling source) is the block's background as-is. Drag to move in time,
 * drag an edge to resize - both free-floating (no back-to-back layout, no
 * source-window trim) since overlays live on the same track and can overlap
 * each other or leave gaps. `top`/`height` place it on its own lane
 * (row) when it time-overlaps another overlay - purely a display concern
 * computed by `lib/overlays.js`'s `assignOverlayLanes`, not stored state. */
export default function TimelineOverlayBlock({
  src, label, isSelected, left, width, top, height,
  onBlockPointerDown, onTrimStartPointerDown, onTrimEndPointerDown, onKeyDown, nodeRef,
}) {
  return (
    <div
      ref={nodeRef}
      className={`tl-overlay${isSelected ? ' is-selected' : ''}`}
      style={{
        left, width, top, height, backgroundImage: src ? `url(${src})` : undefined,
      }}
      onPointerDown={onBlockPointerDown}
      onKeyDown={onKeyDown}
      title={label}
      role="button"
      tabIndex={0}
    >
      <span className="tl-overlay-handle tl-overlay-handle-start" onPointerDown={onTrimStartPointerDown} />
      <span className="tl-overlay-label">{label}</span>
      <span className="tl-overlay-handle tl-overlay-handle-end" onPointerDown={onTrimEndPointerDown} />
    </div>
  );
}
