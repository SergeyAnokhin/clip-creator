import { Maximize2, Minimize2 } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';
import { activeOverlaysAt, overlayPositionStyle } from '../../lib/overlays.js';
import { resolveOverlaySource } from '../../lib/overlaySource.js';

/** Editor stage program monitor: a muted <video> (clip content) synced to a
 * hidden <audio> (the picked Mureka track, the sync source of truth - see
 * useEditorStage.js's `tick`). Playback transport and scrubbing live in the
 * side panel / the timeline's own ruler (EditorStage.jsx / EditorTimeline.jsx)
 * - this component is just the frame. The fullscreen toggle lives here too
 * (an overlay button in the frame's corner) since it's the one control worth
 * reaching before entering fullscreen as well as after.
 *
 * Whichever overlay(s) are active at the current playhead are drawn as plain
 * absolutely-positioned <img>s on top of the <video> - approximate like the
 * rest of this preview (sized against the frame's own box, not accounting
 * for the <video>'s own letterboxing), non-interactive (position is set via
 * the inspector's 9-point grid, not by dragging here - see the plan's v1
 * scoping note). The real render composites them with ffmpeg's `overlay`
 * filter instead (`providers/editor.py`). */
export default function EditorPreview({
  L, videoRef, audioRef, projectId, selectedTrack, overlays, playheadMs,
  titleCardVariants, logos, isFullscreen, onToggleFullscreen,
}) {
  const activeOverlays = activeOverlaysAt(overlays, playheadMs);
  return (
    <div className="editor-preview">
      <div className="editor-preview-frame">
        <video ref={videoRef} muted playsInline />
        {activeOverlays.map((overlay) => {
          const { src } = resolveOverlaySource(overlay, { projectId, titleCardVariants, logos, L });
          if (!src) return null;
          return (
            <img
              key={overlay.overlay_id} src={src} alt="" className="editor-overlay-preview"
              style={{
                ...overlayPositionStyle(overlay.position),
                width: `${overlay.width_pct}%`,
                opacity: overlay.opacity,
              }}
            />
          );
        })}
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
