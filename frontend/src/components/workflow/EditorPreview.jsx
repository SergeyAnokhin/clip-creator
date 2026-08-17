import { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { Image as KonvaImage, Layer, Stage } from 'react-konva';
import { mediaUrl } from '../../api/client.js';
import {
  activeOverlaysAt, canvasLayerHeightPct, overlayOpacityAt, overlayPatchFromCanvasLayer,
} from '../../lib/overlays.js';
import { resolveOverlaySource } from '../../lib/overlaySource.js';
import { computeContentRect } from '../../lib/videoFrameRect.js';
import { findActiveClip } from '../../lib/timeline.js';
import { useHtmlImage } from '../../hooks/useHtmlImage.js';
import { useVideoFirstFrame } from '../../hooks/useClipThumbnails.js';
import CanvasLayer from '../shared/CanvasLayer.jsx';
import EditorPreviewContextMenu from './EditorPreviewContextMenu.jsx';

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
      onChange={(patch) => onChange(overlayPatchFromCanvasLayer(patch, containerW, containerH))}
    >
      <KonvaImage image={image} width={naturalW} height={naturalH} opacity={overlayOpacityAt(overlay, playheadMs)} />
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
  L, videoRef, audioRef, projectId, selectedTrack, overlays, playheadMs, isPlaying,
  titleCardVariants, logos, overlayVideoSources, canvasSize, isFullscreen, onToggleFullscreen,
  selectedOverlayId, actions, clips, selectedClipIds,
}) {
  const frameRef = useRef(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [videoNaturalSize, setVideoNaturalSize] = useState({ width: 0, height: 0 });
  const [contextMenu, setContextMenu] = useState(null);

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

  const activeOverlays = activeOverlaysAt(overlays, playheadMs);
  return (
    <div className="editor-preview">
      <div className="editor-preview-frame" ref={frameRef} onContextMenu={openContextMenu}>
        <video
          ref={videoRef} muted playsInline
          style={containerSize.width > 0 ? {
            position: 'absolute', left: canvasFitRect.x, top: canvasFitRect.y,
            width: canvasFitRect.width, height: canvasFitRect.height,
          } : undefined}
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
                  />
                );
              })}
            </Layer>
          </Stage>
        )}
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
