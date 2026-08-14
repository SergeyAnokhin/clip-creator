import { Music4, Pause, Play } from 'lucide-react';

/** Compact "now playing" pill for the header (home/workflow/settings
 * screens) - shows the track handed off by useMiniPlayer.js and lets
 * play/pause be toggled without leaving the current screen. Renders
 * nothing until a track has been started at least once. */
export default function MiniPlayerWidget({ L, track, isPlaying, onToggle }) {
  if (!track) return null;

  return (
    <button
      className="pill pill-neutral"
      style={{ cursor: 'pointer', fontFamily: 'inherit', flexShrink: 1, minWidth: 0, maxWidth: 200 }}
      onClick={onToggle}
      title={track.title}
    >
      {isPlaying ? <Pause size={12} /> : <Play size={12} />}
      <Music4 size={12} style={{ opacity: 0.6, flexShrink: 0 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{track.title}</span>
    </button>
  );
}
