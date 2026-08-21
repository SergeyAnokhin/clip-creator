import { useEffect, useMemo, useRef, useState } from 'react';
import { Magnet, Maximize2, Minimize2 } from 'lucide-react';
import Konva from 'konva';
import {
  Image as KonvaImage, Layer, Line, Stage, Text as KonvaText,
} from 'react-konva';
import { mediaUrl } from '../../api/client.js';
import {
  activeOverlaysAt, canvasLayerHeightPct, DEFAULT_TEXT_OVERLAY, overlayOpacityAt, overlayPatchFromCanvasLayer,
  TEXT_RASTER_FONT_SIZE,
} from '../../lib/overlays.js';
import { isDefaultAdjust } from '../../lib/timeline.js';
import { resolveOverlaySource } from '../../lib/overlaySource.js';
import { computeContentRect } from '../../lib/videoFrameRect.js';
import { findActiveClip } from '../../lib/timeline.js';
import { snapNodeToCanvas } from '../../lib/snapping.js';
import { useHtmlImage } from '../../hooks/useHtmlImage.js';
import { useVideoFirstFrame } from '../../hooks/useClipThumbnails.js';
import CanvasLayer from '../shared/CanvasLayer.jsx';
import EditorPreviewContextMenu from './EditorPreviewContextMenu.jsx';
import EditorFloatingTransport from './EditorFloatingTransport.jsx';

/** One active overlay's Konva node - its own component (rather than inline
 * in the `.map` below) purely so each can call `useHtmlImage`/
 * `useVideoFirstFrame` for its own source file, the same reason
 * `MagicLayerNode` exists in `PosterCanvasLayers.jsx` (a hook can't be
 * called in a loop). Delegates all drag/resize/rotate wiring to the shared
 * `CanvasLayer` primitive - this is the actual free-placement UI the
 * overlay used to lack (a 9-point grid only, see `docs/architecture.md`'s
 * note on the old v1 scoping). `CanvasLayer`'s own `onChange` reports
 * camelCase pct fields (shared with `PosterCanvasLayers.jsx`, whose
 * poster-layer model uses that casing natively) - `lib/overlays.js`'s
 * `overlayPatchFromCanvasLayer` converts them to this overlay model's
 * snake_case fields right here at the boundary, not passed through as-is.
 *
 * A `kind: 'video'` overlay shows a static first-frame thumbnail here, not
 * live playback - `useVideoFirstFrame` grabs one frame as a data URL, which
 * `useHtmlImage` then loads exactly like any other image source. Dragging/
 * resizing it is just "where/how big", so a still is enough; the real
 * render is what actually composites the video (`providers/editor.py`).
 *
 * Opacity is `overlayOpacityAt(overlay, playheadMs)`, not the overlay's flat
 * `opacity` - live-previews its fade-in/fade-out ramp (if any) as the
 * playhead moves through its window, matching the same ramp
 * `providers/editor.py`'s conditional `colorchannelmixer` expression
 * produces in the real render. */
function OverlayCanvasNode({
  overlay, src, containerW, containerH, playheadMs, isSelected, isPlaying, onSelect, onChange, onNaturalSize,
  snapEnabled, setGuides,
}) {
  const videoFrame = useVideoFirstFrame(overlay.kind === 'video' ? src : null);
  const imageSrc = overlay.kind === 'video' ? videoFrame : src;
  const { image, width: naturalW, height: naturalH } = useHtmlImage(imageSrc);
  // Reports the source's real pixel size up to useEditorStage.js's
  // resolveOverlayNaturalAspect, which corrects a freshly-created overlay's
  // square placeholder box to this aspect ratio - see that function's own
  // comment. A no-op for any overlay that isn't the one just created.
  useEffect(() => {
    if (naturalW && naturalH) onNaturalSize(overlay.overlay_id, naturalW, naturalH);
  }, [overlay.overlay_id, naturalW, naturalH, onNaturalSize]);
  if (!image) return null;
  return (
    <CanvasLayer
      xPct={overlay.x_pct} yPct={overlay.y_pct} widthPct={overlay.width_pct}
      heightPct={canvasLayerHeightPct(overlay, containerW, containerH)}
      rotationDeg={overlay.rotation_deg}
      naturalW={naturalW} naturalH={naturalH} containerW={containerW} containerH={containerH}
      isSelected={isSelected} showOutline={!isPlaying}
      onSelect={onSelect}
      onDragMove={(e) => { if (snapEnabled) setGuides(snapNodeToCanvas(e.target, containerW, containerH)); }}
      onChange={(patch) => {
        setGuides({ v: null, h: null });
        onChange(overlayPatchFromCanvasLayer(patch, containerW, containerH));
      }}
    >
      <KonvaImage image={image} width={naturalW} height={naturalH} opacity={overlayOpacityAt(overlay, playheadMs)} />
    </CanvasLayer>
  );
}

/** A `kind: 'text'` overlay's Konva node. Drawn live here with the same
 * font/colour/outline values `providers/editor.py` later rasterizes with
 * Pillow, so what the monitor shows is what the render composites (the two
 * text engines' metrics differ slightly - that is covered by the preview's
 * existing "приблизительный" disclaimer, same as everything else here).
 *
 * The text is laid out at a fixed `TEXT_RASTER_FONT_SIZE` and then *scaled*
 * by `CanvasLayer` like any image overlay, rather than having its own
 * font-size field: the overlay model already has exactly one notion of "how
 * big is this on the canvas" (`width_pct`/`height_pct`), and a second one
 * would fight it. The measured natural size goes to
 * `resolveOverlayNaturalAspect` for the same reason an image's does - so a
 * freshly added text block takes on its real aspect ratio instead of the
 * square placeholder every new overlay starts as.
 *
 * Measuring happens on a detached probe node, not on the rendered one: the
 * rendered `Text` is given an explicit `width` so `align` works, and Konva
 * then splits lines against that width, so measuring it would echo back
 * whatever width it already has. Same technique (and same reason) as
 * `PosterCanvasLayers.jsx`'s text layer. */
function OverlayTextNode({
  overlay, containerW, containerH, playheadMs, isSelected, isPlaying, onSelect, onChange, onNaturalSize,
  snapEnabled, setGuides,
}) {
  const text = { ...DEFAULT_TEXT_OVERLAY, ...(overlay.text || {}) };
  const [box, setBox] = useState({ w: 1, h: 1 });

  useEffect(() => {
    function measure() {
      const probe = new Konva.Text({
        text: text.content || ' ',
        fontFamily: text.font,
        fontSize: TEXT_RASTER_FONT_SIZE,
        lineHeight: text.line_spacing,
        wrap: 'none',
      });
      setBox({ w: Math.max(1, probe.getTextWidth()), h: Math.max(1, probe.height()) });
      probe.destroy();
    }
    measure();
    // Web fonts (and, on a cold load, even locally installed ones) may not be
    // ready on the first paint - remeasure once they are, or the block keeps
    // whatever size the fallback face happened to produce.
    if (document.fonts?.ready) document.fonts.ready.then(measure).catch(() => {});
  }, [text.content, text.font, text.line_spacing]);

  useEffect(() => {
    if (box.w > 1 && box.h > 1) onNaturalSize(overlay.overlay_id, box.w, box.h);
  }, [overlay.overlay_id, box.w, box.h, onNaturalSize]);

  return (
    <CanvasLayer
      xPct={overlay.x_pct} yPct={overlay.y_pct} widthPct={overlay.width_pct}
      heightPct={canvasLayerHeightPct(overlay, containerW, containerH)}
      rotationDeg={overlay.rotation_deg}
      naturalW={box.w} naturalH={box.h} containerW={containerW} containerH={containerH}
      isSelected={isSelected} showOutline={!isPlaying}
      onSelect={onSelect}
      onDragMove={(e) => { if (snapEnabled) setGuides(snapNodeToCanvas(e.target, containerW, containerH)); }}
      onChange={(patch) => {
        setGuides({ v: null, h: null });
        onChange(overlayPatchFromCanvasLayer(patch, containerW, containerH));
      }}
    >
      <KonvaText
        text={text.content}
        width={box.w}
        wrap="none"
        align={text.align}
        fontFamily={text.font}
        fontSize={TEXT_RASTER_FONT_SIZE}
        lineHeight={text.line_spacing}
        fill={text.color}
        stroke={text.outline_width > 0 ? text.outline_color : undefined}
        strokeWidth={text.outline_width}
        fillAfterStrokeEnabled
        opacity={overlayOpacityAt(overlay, playheadMs)}
      />
    </CanvasLayer>
  );
}

/** Editor stage program monitor: a muted <video> (clip content) synced to a
 * hidden <audio> (the picked Mureka track, the sync source of truth - see
 * useEditorStage.js's `tick`). Playback transport and scrubbing live in the
 * side panel / the timeline's own ruler (EditorStage.jsx / EditorTimeline.jsx)
 * - this component is just the frame. The fullscreen toggle lives here too
 * (an overlay button in the frame's corner) since it's the one control worth
 * reaching before entering fullscreen as well as after.
 *
 * `contentRect` tracks exactly where the <video>'s own real (non-
 * letterboxed) picture sits inside `.editor-preview-frame` (see
 * `lib/videoFrameRect.js`) - a `ResizeObserver` on the frame plus the
 * video's own `loadedmetadata` keep it current across window resizes,
 * fullscreen toggles, and clip changes. Drawn as a dashed `.editor-frame-
 * bounds` outline so the actual video bounds are visible even when they
 * don't match the frame's own box (a mixed-aspect-ratio timeline).
 *
 * Whichever overlay(s) are active at the current playhead are drawn on a
 * `react-konva` `Stage` sized and positioned to exactly `canvasFitRect` -
 * the render's actual output canvas (`canvasSize`, from `EditorStage.jsx`'s
 * `resolveCanvasSize`) letterboxed to fit the frame - **not** the currently
 * playing clip's own content rect. `providers/editor.py` always scales an
 * overlay's `width_pct`/`height_pct` against the fixed output canvas
 * (`build_ffmpeg_command`'s `w`/`h`), so anchoring the live Stage to the
 * clip's own (per-clip, letterboxing-dependent) content rect instead used to
 * store percentages in the wrong coordinate space - harmless while the
 * currently-viewed clip's own aspect ratio happened to match the canvas, but
 * a visibly squished/stretched overlay in the real render whenever it
 * didn't (e.g. a landscape-sourced clip pillarboxed inside a portrait
 * canvas). `contentRect` (the clip's own real, non-letterboxed picture -
 * still shown as the dashed `.editor-frame-bounds` outline) is now computed
 * *inside* `canvasFitRect`'s own box for the same reason - it's purely
 * informational, not what overlays are placed against. Each overlay is an
 * `OverlayCanvasNode`/`CanvasLayer` the user can drag/resize/rotate directly
 * here, the same interaction model `PosterCanvasLayers.jsx`'s poster layers
 * use. Position/timing edits still commit through `useEditorStage.js`'s
 * normal undo history; this preview stays otherwise approximate (see
 * `editor_previewDisclaimer` - it doesn't replicate a clip's own `fit`/zoom/
 * crop, or a `reverse`d clip's actual reversed playback - see lib/timeline.js's
 * own docstring on why) - the real render composites overlays with ffmpeg's
 * `overlay` filter instead (`providers/editor.py`).
 *
 * Right-clicking the frame opens `EditorPreviewContextMenu.jsx`, a shortcut
 * to clip actions that already exist elsewhere (the toolbar, the clip
 * inspector) for whichever clip the menu should act on: the single selected
 * clip if there's exactly one (`selectedClipIds`, matching what the side
 * panel's own inspector already shows), else whichever clip sits under the
 * current playhead (`findActiveClip`) - so right-clicking the monitor "just
 * works" without the user having to go select the clip on the timeline
 * first. */
export default function EditorPreview({
  L, videoRef, audioRef, projectId, selectedTrack, overlays, playheadMs, timelineMs, isPlaying,
  titleCardVariants, logos, overlayVideoSources, canvasSize, isFullscreen, onToggleFullscreen,
  selectedOverlayId, actions, clips, selectedClipIds,
}) {
  const frameRef = useRef(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [videoNaturalSize, setVideoNaturalSize] = useState({ width: 0, height: 0 });
  const [contextMenu, setContextMenu] = useState(null);
  // A per-session UI preference (not part of the EDL, see setOverlayTransform
  // in useEditorStage.js) - whether dragging an overlay snaps to the
  // canvas's center/edges (lib/snapping.js). `guides` is the line(s) to draw
  // for the current drag frame, reset on drag end/change-commit.
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [guides, setGuides] = useState({ v: null, h: null });

  function openContextMenu(e) {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }
  const contextMenuClip = contextMenu
    ? (
      (selectedClipIds && selectedClipIds.size === 1
        ? (clips || []).find((c) => selectedClipIds.has(c.clip_id))
        : null)
      || findActiveClip(clips || [], playheadMs)?.clip
      || null
    )
    : null;

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setContainerSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    function onLoadedMetadata() {
      setVideoNaturalSize({ width: video.videoWidth, height: video.videoHeight });
    }
    video.addEventListener('loadedmetadata', onLoadedMetadata);
    if (video.videoWidth) onLoadedMetadata();
    return () => video.removeEventListener('loadedmetadata', onLoadedMetadata);
  }, [videoRef]);

  // The output canvas, letterboxed to fit the frame - the stable coordinate
  // space overlays are positioned/scaled against (matches providers/
  // editor.py, unlike the per-clip contentRect below).
  const canvasFitRect = computeContentRect(
    containerSize.width, containerSize.height, canvasSize.width, canvasSize.height,
  );
  // The clip's own real (non-letterboxed) picture, inside canvasFitRect -
  // informational only (the dashed outline), not an overlay coordinate space.
  const localContentRect = computeContentRect(
    canvasFitRect.width, canvasFitRect.height, videoNaturalSize.width, videoNaturalSize.height,
  );
  const contentRect = {
    x: canvasFitRect.x + localContentRect.x,
    y: canvasFitRect.y + localContentRect.y,
    width: localContentRect.width,
    height: localContentRect.height,
  };

  // Live (approximate) preview of the active clip's own colour correction -
  // CSS `filter` on the <video> maps closely enough onto ffmpeg `eq`'s
  // brightness/contrast/saturation for "does this look right", which is all
  // the monitor claims to answer. `gamma` has no CSS equivalent and is simply
  // not previewed, the same way `fit`/`reverse` aren't (see the disclaimer).
  const activeClipAdjust = useMemo(() => {
    const active = findActiveClip(clips || [], playheadMs);
    const adjust = active?.clip?.adjust;
    if (isDefaultAdjust(adjust)) return undefined;
    const brightness = 1 + (adjust.brightness ?? 0);
    return `brightness(${brightness}) contrast(${adjust.contrast ?? 1}) saturate(${adjust.saturation ?? 1})`;
  }, [clips, playheadMs]);

  const activeOverlays = activeOverlaysAt(overlays, playheadMs);
  return (
    <div className="editor-preview">
      <div className="editor-preview-frame" ref={frameRef} onContextMenu={openContextMenu}>
        <video
          ref={videoRef} muted playsInline
          style={containerSize.width > 0 ? {
            position: 'absolute', left: canvasFitRect.x, top: canvasFitRect.y,
            width: canvasFitRect.width, height: canvasFitRect.height,
            filter: activeClipAdjust,
          } : { filter: activeClipAdjust }}
        />
        {containerSize.width > 0 && (
          <div
            className="editor-frame-bounds"
            style={{ left: contentRect.x, top: contentRect.y, width: contentRect.width, height: contentRect.height }}
          />
        )}
        {containerSize.width > 0 && canvasFitRect.width > 0 && (
          <Stage
            width={canvasFitRect.width} height={canvasFitRect.height}
            style={{ position: 'absolute', left: canvasFitRect.x, top: canvasFitRect.y }}
          >
            <Layer>
              {activeOverlays.map((overlay) => {
                if (overlay.kind === 'text') {
                  return (
                    <OverlayTextNode
                      key={overlay.overlay_id}
                      overlay={overlay} playheadMs={playheadMs}
                      containerW={canvasFitRect.width} containerH={canvasFitRect.height}
                      isSelected={selectedOverlayId === overlay.overlay_id} isPlaying={isPlaying}
                      onSelect={() => actions.selectOverlay(overlay.overlay_id)}
                      onChange={(patch) => actions.setOverlayTransform(overlay.overlay_id, patch)}
                      onNaturalSize={actions.resolveOverlayNaturalAspect}
                      snapEnabled={snapEnabled} setGuides={setGuides}
                    />
                  );
                }
                const { src } = resolveOverlaySource(overlay, {
                  projectId, titleCardVariants, logos, overlayVideoSources, L,
                });
                if (!src) return null;
                return (
                  <OverlayCanvasNode
                    key={overlay.overlay_id}
                    overlay={overlay} src={src} playheadMs={playheadMs}
                    containerW={canvasFitRect.width} containerH={canvasFitRect.height}
                    isSelected={selectedOverlayId === overlay.overlay_id} isPlaying={isPlaying}
                    onSelect={() => actions.selectOverlay(overlay.overlay_id)}
                    onChange={(patch) => actions.setOverlayTransform(overlay.overlay_id, patch)}
                    onNaturalSize={actions.resolveOverlayNaturalAspect}
                    snapEnabled={snapEnabled} setGuides={setGuides}
                  />
                );
              })}
              {guides.v != null && (
                <Line
                  points={[guides.v, 0, guides.v, canvasFitRect.height]}
                  stroke="#ff3b6f" strokeWidth={1.5} dash={[8, 6]} listening={false}
                />
              )}
              {guides.h != null && (
                <Line
                  points={[0, guides.h, canvasFitRect.width, guides.h]}
                  stroke="#ff3b6f" strokeWidth={1.5} dash={[8, 6]} listening={false}
                />
              )}
            </Layer>
          </Stage>
        )}
        <EditorFloatingTransport
          L={L} playheadMs={playheadMs} timelineMs={timelineMs} isPlaying={isPlaying}
          selectedTrack={selectedTrack} actions={actions}
        />
        <div className="editor-preview-disclaimer">{L.editor_previewDisclaimer}</div>
        <button
          type="button"
          className={`icon-btn editor-snap-toggle${snapEnabled ? ' is-active' : ''}`}
          title={snapEnabled ? L.editor_snapToggleOn : L.editor_snapToggleOff}
          onClick={() => setSnapEnabled((v) => !v)}
        >
          <Magnet size={14} />
        </button>
        <button
          type="button"
          className="icon-btn editor-fullscreen-btn"
          title={isFullscreen ? L.editor_fullscreenExit : L.editor_fullscreenEnter}
          onClick={onToggleFullscreen}
        >
          {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        {contextMenu && (
          <EditorPreviewContextMenu
            L={L} x={contextMenu.x} y={contextMenu.y} clip={contextMenuClip} actions={actions}
            onClose={() => setContextMenu(null)}
          />
        )}
      </div>
      <audio ref={audioRef} src={selectedTrack ? mediaUrl(`projects/${projectId}/${selectedTrack.file_path}`) : undefined} style={{ display: 'none' }} />
    </div>
  );
}
