import { useRef, useState } from 'react';
import { mediaUrl } from '../api/client.js';

/** Global "now playing" track for generated music (Mureka stage). The
 * actual <audio> element is rendered once at the App.jsx composition root
 * (see audioProps below) so it is never unmounted by screen/stage
 * switching, letting playback survive navigating away from the Mureka
 * stage. Track selection happens via the play button on a generated track;
 * the header mini player only proxies play/pause to that same element. */
export function useMiniPlayer() {
  const audioRef = useRef(null);
  const [track, setTrack] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);

  function playTrack({ projectId, trackId, filePath, title, startAtMs }) {
    const audio = audioRef.current;
    if (!audio) return;
    if (track?.trackId !== trackId) {
      audio.src = mediaUrl(`projects/${projectId}/${filePath}`);
      audio.currentTime = (startAtMs || 0) / 1000;
      setCurrentTimeMs(startAtMs || 0);
    } else if (startAtMs != null) {
      audio.currentTime = startAtMs / 1000;
      setCurrentTimeMs(startAtMs);
    }
    setTrack({ projectId, trackId, filePath, title });
    audio.play().catch(() => {});
  }

  function toggle() {
    const audio = audioRef.current;
    if (!audio || !track) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }

  function seek(ms) {
    const audio = audioRef.current;
    if (!audio || !track) return;
    audio.currentTime = ms / 1000;
    setCurrentTimeMs(ms);
  }

  const audioProps = {
    ref: audioRef,
    onPlay: () => setIsPlaying(true),
    onPause: () => setIsPlaying(false),
    onEnded: () => setIsPlaying(false),
    onTimeUpdate: () => setCurrentTimeMs((audioRef.current?.currentTime || 0) * 1000),
  };

  return {
    state: { track, isPlaying, currentTimeMs },
    actions: { playTrack, toggle, seek },
    audioProps,
  };
}
