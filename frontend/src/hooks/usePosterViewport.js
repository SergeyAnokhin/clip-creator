import { useEffect, useState } from 'react';

const MAX_DISPLAY_W = 760;
const MAX_DISPLAY_H = 520;
// Reserve (viewport px) subtracted from the fullscreen picture budget for
// the panel + gaps + the (edge-to-edge, fullscreen-only) modal-card's own
// small horizontal padding - see the fullscreen branch of modal-card's
// inline style in PosterConstructor.jsx.
const SIDE_PANEL_RESERVE = 360;
// In fullscreen the header bar is removed entirely so the picture can span
// the full viewport height - only a thin bottom padding is reserved, no room
// for a title bar.
const FULLSCREEN_V_RESERVE = 24;

/** Extra canvas room (screen px) kept around the poster's visible bounds so
 * overlay objects (e.g. the glass panel) can be dragged past the poster edge
 * and still be seen while editing - purely an editor convenience. Cropped
 * back out at export time, so the saved poster is always exactly
 * `canvasSize`. */
const OVERFLOW_MARGIN = 40;
const OVERFLOW_MARGIN_FULLSCREEN = 100;

/** The Poster constructor's view transform, split out of
 * `PosterConstructor.jsx`: how big the picture is allowed to be (windowed vs
 * fullscreen), the fit scale onto the background's natural size, the user's
 * own zoom/pan on top, and the overflow margin the Konva stage is padded
 * with. Pure view state - it never touches the poster document itself, which
 * is why it can live apart from the layer editing.
 *
 * `resetKey` is whatever invalidates a zoom/pan (the background path today):
 * a zoom applied under one background or one screen size doesn't mean
 * anything once either changes, so the view starts fresh rather than being
 * left panned off into empty space. */
export function usePosterViewport({ fullscreen, resetKey, naturalWidth, naturalHeight }) {
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [zoom, setZoom] = useState(1);
  const [stagePos, setStagePos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!fullscreen) return undefined;
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [fullscreen]);

  useEffect(() => {
    setZoom(1);
    setStagePos({ x: 0, y: 0 });
  }, [fullscreen, resetKey]);

  // In fullscreen, the picture area grows to fill essentially the whole
  // viewport (the side panel itself stays a fixed width - see
  // PosterConstructor.jsx's SIDE_PANEL_WIDTH - rather than also growing and
  // eating the extra space).
  const maxDisplayW = fullscreen ? Math.max(320, viewport.w - SIDE_PANEL_RESERVE) : MAX_DISPLAY_W;
  const maxDisplayH = fullscreen ? Math.max(240, viewport.h - FULLSCREEN_V_RESERVE) : MAX_DISPLAY_H;
  const scale = naturalWidth ? Math.min(1, maxDisplayW / naturalWidth, maxDisplayH / naturalHeight) : 1;
  const displayW = Math.round((naturalWidth || maxDisplayW) * scale);
  const displayH = Math.round((naturalHeight || maxDisplayH) * scale);
  const overflowMargin = fullscreen ? OVERFLOW_MARGIN_FULLSCREEN : OVERFLOW_MARGIN;

  return {
    viewport,
    zoom,
    setZoom,
    stagePos,
    setStagePos,
    scale,
    displayW,
    displayH,
    overflowMargin,
    marginLocal: scale ? overflowMargin / scale : 0,
    effectiveScale: scale * zoom,
    stageW: displayW + overflowMargin * 2,
    stageH: displayH + overflowMargin * 2,
  };
}
