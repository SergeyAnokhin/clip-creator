/** Pure `object-fit: contain` math, used by `EditorPreview.jsx` to find
 * exactly where the video's real (non-letterboxed) picture sits inside its
 * container box - the browser applies this same math internally to the
 * `<video>` element itself (`.editor-preview-frame video { object-fit:
 * contain }`), but never exposes the resulting content rect to JS, so
 * anything positioned against the container (an overlay, a bounds outline)
 * has no way to know where the real picture actually is without
 * recomputing it here. Kept pure/dependency-free so it's unit tested the
 * same way `lib/overlays.js`/`lib/canvasLayer.js` are. */
export function computeContentRect(containerW, containerH, videoNaturalW, videoNaturalH) {
  if (containerW <= 0 || containerH <= 0 || videoNaturalW <= 0 || videoNaturalH <= 0) {
    return { x: 0, y: 0, width: containerW, height: containerH };
  }
  const scale = Math.min(containerW / videoNaturalW, containerH / videoNaturalH);
  const width = videoNaturalW * scale;
  const height = videoNaturalH * scale;
  return {
    x: (containerW - width) / 2,
    y: (containerH - height) / 2,
    width,
    height,
  };
}
