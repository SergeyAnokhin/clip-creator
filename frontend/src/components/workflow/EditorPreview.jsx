import { Pause, Play, SkipBack } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';

function formatTime(ms) {
  const s = Math.max(0, ms / 1000);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

/** Editor stage program monitor: a muted <video> (clip content) synced to a
 * hidden <audio> (the picked Mureka track, the sync source of truth - see
 * useEditorStage.js's `tick`), plus the transport row under it. Scrubbing
 * lives on the timeline's own ruler (EditorTimeline.jsx), not here - same
 * split of duties as CapCut/Premiere. */
export default function EditorPreview({
  L, projectId, selectedTrack, videoRef, audioRef, playheadMs, totalMs, isPlaying, onPlay, onPause, onSeek,
}) {
  return (
    <div className="editor-preview">
      <div className="editor-preview-frame">
        <video ref={videoRef} muted playsInline />
      </div>
      <audio ref={audioRef} src={selectedTrack ? mediaUrl(`projects/${projectId}/${selectedTrack.file_path}`) : undefined} style={{ display: 'none' }} />

      <div className="editor-preview-transport">
        <button className="icon-btn" title={L.editor_toStart} onClick={() => onSeek(0)} disabled={!selectedTrack}>
          <SkipBack size={14} />
        </button>
        <button className="icon-btn" title={isPlaying ? L.editor_pause : L.editor_play} onClick={isPlaying ? onPause : onPlay} disabled={!selectedTrack}>
          {isPlaying ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <span className="editor-preview-time">
          {formatTime(playheadMs)} <span>/ {formatTime(totalMs)}</span>
        </span>
      </div>
      <div className="editor-preview-note">{L.editor_previewDisclaimer}</div>
    </div>
  );
}
