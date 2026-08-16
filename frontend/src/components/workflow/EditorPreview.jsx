import { mediaUrl } from '../../api/client.js';

/** Editor stage program monitor: a muted <video> (clip content) synced to a
 * hidden <audio> (the picked Mureka track, the sync source of truth - see
 * useEditorStage.js's `tick`). Playback transport and scrubbing live in the
 * side panel / the timeline's own ruler (EditorStage.jsx / EditorTimeline.jsx)
 * - this component is just the frame. */
export default function EditorPreview({ videoRef, audioRef, projectId, selectedTrack }) {
  return (
    <div className="editor-preview">
      <div className="editor-preview-frame">
        <video ref={videoRef} muted playsInline />
      </div>
      <audio ref={audioRef} src={selectedTrack ? mediaUrl(`projects/${projectId}/${selectedTrack.file_path}`) : undefined} style={{ display: 'none' }} />
    </div>
  );
}
