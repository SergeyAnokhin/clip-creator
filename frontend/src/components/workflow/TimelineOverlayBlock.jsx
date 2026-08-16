/** One block on the timeline's overlay lane - a title-card variant or logo
 * placed over the video for a `[start_ms, start_ms+duration_ms)` window.
 * Unlike `TimelineClipBlock.jsx` there's no frame sampling: the overlay's
 * own source image (already static) is the block's background as-is. Drag
 * to move in time, drag an edge to resize - both free-floating (no
 * back-to-back layout, no source-window trim) since overlays live on their
 * own lane and can overlap each other or leave gaps. */
export default function TimelineOverlayBlock({
  src, label, isSelected, left, width,
  onBlockPointerDown, onTrimStartPointerDown, onTrimEndPointerDown, onKeyDown, nodeRef,
}) {
  return (
    <div
      ref={nodeRef}
      className={`tl-overlay${isSelected ? ' is-selected' : ''}`}
      style={{ left, width, backgroundImage: src ? `url(${src})` : undefined }}
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
