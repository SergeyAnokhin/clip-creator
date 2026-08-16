import { Maximize2, Minimize2 } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';

/** Editor stage program monitor: a muted <video> (clip content) synced to a
 * hidden <audio> (the picked Mureka track, the sync source of truth - see
 * useEditorStage.js's `tick`). Playback transport and scrubbing live in the
 * side panel / the timeline's own ruler (EditorStage.jsx / EditorTimeline.jsx)
 * - this component is just the frame. The fullscreen toggle lives here too
 * (an overlay button in the frame's corner) since it's the one control worth
 * reaching before entering fullscreen as well as after. */
export default function EditorPreview({
  L, videoRef, audioRef, projectId, selectedTrack, isFullscreen, onToggleFullscreen,
}) {
  return (
    <div className="editor-preview">
      <div className="editor-preview-frame">
        <video ref={videoRef} muted playsInline />
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
