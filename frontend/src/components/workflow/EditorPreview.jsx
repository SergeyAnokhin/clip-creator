import { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { Image as KonvaImage, Layer, Stage } from 'react-konva';
import { mediaUrl } from '../../api/client.js';
import { activeOverlaysAt, overlayOpacityAt } from '../../lib/overlays.js';
import { resolveOverlaySource } from '../../lib/overlaySource.js';
import { computeContentRect } from '../../lib/videoFrameRect.js';
import { useHtmlImage } from '../../hooks/useHtmlImage.js';
import { useVideoFirstFrame } from '../../hooks/useClipThumbnails.js';
import CanvasLayer from '../shared/CanvasLayer.jsx';

/** One active overlay's Konva node - its own component (rather than inline
 * in the `.map` below) purely so each can call `useHtmlImage`/
 * `useVideoFirstFrame` for its own source file, the same reason
 * `MagicLayerNode` exists in `PosterCanvasLayers.jsx` (a hook can't be
 * called in a loop). Delegates all drag/resize/rotate wiring to the shared
 * `CanvasLayer` primitive - this is the actual free-placement UI the
 * overlay used to lack (a 9-point grid only, see `docs/architecture.md`'s
 * note on the old v1 scoping).
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
  overlay, src, containerW, containerH, playheadMs, isSelected, onSelect, onChange,
}) {
  const videoFrame = useVideoFirstFrame(overlay.kind === 'video' ? src : null);
  const imageSrc = overlay.kind === 'video' ? videoFrame : src;
  const { image, width: naturalW, height: naturalH } = useHtmlImage(imageSrc);
  if (!image) return null;
  return (
    <CanvasLayer
      xPct={overlay.x_pct} yPct={overlay.y_pct} widthPct={overlay.width_pct} heightPct={overlay.height_pct}
      rotationDeg={overlay.rotation_deg}
      naturalW={naturalW} naturalH={naturalH} containerW={containerW} containerH={containerH}
      isSelected={isSelected}
      onSelect={onSelect}
      onChange={onChange}
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
 * `react-konva` `Stage` sized and positioned to exactly `contentRect` - so
 * an overlay always sits on the real picture, never the letterbox padding -
 * each as an `OverlayCanvasNode`/`CanvasLayer` the user can drag/resize/
 * rotate directly here, the same interaction model
 * `PosterCanvasLayers.jsx`'s poster layers use. Position/timing edits still
 * commit through `useEditorStage.js`'s normal undo history; this preview
 * stays otherwise approximate (see `editor_previewDisclaimer`) - the real
 * render composites overlays with ffmpeg's `overlay` filter instead
 * (`providers/editor.py`). */
export default function EditorPreview({
  L, videoRef, audioRef, projectId, selectedTrack, overlays, playheadMs,
  titleCardVariants, logos, overlayVideoSources, isFullscreen, onToggleFullscreen,
  selectedOverlayId, actions,
}) {
  const frameRef = useRef(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [videoNaturalSize, setVideoNaturalSize] = useState({ width: 0, height: 0 });

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

  const contentRect = computeContentRect(
    containerSize.width, containerSize.height, videoNaturalSize.width, videoNaturalSize.height,
  );

  const activeOverlays = activeOverlaysAt(overlays, playheadMs);
  return (
    <div className="editor-preview">
      <div className="editor-preview-frame" ref={frameRef}>
        <video ref={videoRef} muted playsInline />
        {containerSize.width > 0 && <div className="editor-frame-bounds" style={contentRect} />}
        {containerSize.width > 0 && contentRect.width > 0 && (
          <Stage
            width={contentRect.width} height={contentRect.height}
            style={{ position: 'absolute', left: contentRect.x, top: contentRect.y }}
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
                    containerW={contentRect.width} containerH={contentRect.height}
                    isSelected={selectedOverlayId === overlay.overlay_id}
                    onSelect={() => actions.selectOverlay(overlay.overlay_id)}
                    onChange={(patch) => actions.setOverlayTransform(overlay.overlay_id, patch)}
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
      </div>
      <audio ref={audioRef} src={selectedTrack ? mediaUrl(`projects/${projectId}/${selectedTrack.file_path}`) : undefined} style={{ display: 'none' }} />
    </div>
  );
}
