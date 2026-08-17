/** Pure pixel<->percentage math behind `components/shared/CanvasLayer.jsx`,
 * the drag/resize/rotate primitive shared by the Poster constructor
 * (`PosterCanvasLayers.jsx`'s `OverlayImage`) and the Editor stage's overlay
 * canvas (`EditorPreview.jsx`). No React, no Konva - kept pure so it's unit
 * tested the same way `lib/overlays.js`/`lib/posterLayers.js` are.
 *
 * A layer's *stored* transform is `{xPct, yPct, widthPct, heightPct,
 * rotationDeg}` - top-left-anchored fractions (0-100) of whatever container
 * box the caller is placing it in (a poster's background image in natural
 * pixels, or the Editor's live video content rect). Percentages, not pixels,
 * because the two callers' containers behave differently: a poster's
 * background is a static, known-at-edit-time size, but the Editor's video
 * content rect changes on window resize/fullscreen - storing percentages
 * means both callers persist the *same* shape, and only convert to Konva's
 * own pixel-space props at render time via the functions below. */

/** `{xPct,yPct,widthPct,heightPct,rotationDeg}` (fractions of the container)
 * -> the Konva `Group` pixel props that place+scale `naturalW`x`naturalH`
 * content (the layer's own unscaled render size, e.g. a cropped image's box)
 * to match. */
export function pctTransformToPixels(transform, containerW, containerH, naturalW, naturalH) {
  const { xPct, yPct, widthPct, heightPct, rotationDeg } = transform;
  const targetW = (widthPct / 100) * containerW;
  const targetH = (heightPct / 100) * containerH;
  return {
    x: (xPct / 100) * containerW,
    y: (yPct / 100) * containerH,
    scaleX: naturalW > 0 ? targetW / naturalW : 1,
    scaleY: naturalH > 0 ? targetH / naturalH : 1,
    rotation: rotationDeg || 0,
  };
}

/** Inverse of `pctTransformToPixels` - reads a Konva `Group`'s live pixel
 * transform (as a plain `{x,y,scaleX,scaleY,rotation}`, not the Konva node
 * itself, so this stays dependency-free) back into stored percentages. */
export function pixelsToPctTransform(pixelTransform, containerW, containerH, naturalW, naturalH) {
  const { x, y, scaleX, scaleY, rotation } = pixelTransform;
  return {
    xPct: containerW > 0 ? (x / containerW) * 100 : 0,
    yPct: containerH > 0 ? (y / containerH) * 100 : 0,
    widthPct: containerW > 0 ? ((naturalW * scaleX) / containerW) * 100 : 0,
    heightPct: containerH > 0 ? ((naturalH * scaleY) / containerH) * 100 : 0,
    rotationDeg: rotation || 0,
  };
}
