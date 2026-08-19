import { Pause, Play, SkipBack } from 'lucide-react';

function formatTime(ms) {
  const s = Math.max(0, ms / 1000);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

/** Playback transport for the program monitor - an overlay centered over the
 * video, hidden until the frame is hovered/focused (CSS-only reveal, see
 * `.editor-floating-transport` in theme.css), the classic video-player
 * pattern instead of a permanently-visible block in the side panel. */
export default function EditorFloatingTransport({ L, playheadMs, timelineMs, isPlaying, selectedTrack, actions }) {
  return (
    <div className="editor-floating-transport">
      <button className="icon-btn" title={L.editor_toStart} onClick={() => actions.seek(0)} disabled={!selectedTrack}>
        <SkipBack size={16} />
      </button>
      <button
        className="icon-btn" title={isPlaying ? L.editor_pause : L.editor_play}
        onClick={isPlaying ? actions.pause : actions.play} disabled={!selectedTrack}
      >
        {isPlaying ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <span className="editor-preview-time">
        {formatTime(playheadMs)} <span>/ {formatTime(timelineMs)}</span>
      </span>
    </div>
  );
}
