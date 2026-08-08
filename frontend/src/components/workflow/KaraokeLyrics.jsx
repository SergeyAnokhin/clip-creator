import { useState } from 'react';
import { currentLineIndex, flattenLyricsLines } from '../../lib/lyricsTiming.js';

/** Small "karaoke" panel synced to a playing track's <audio> element via its
 * currentTime - shows a couple of previous lines, the current one
 * highlighted, and a couple of upcoming ones, using the word/line timing
 * Mureka already returns in `track.raw.lyrics_sections` (see
 * lib/lyricsTiming.js - nothing new fetched, just surfaced). Rendered only
 * while the track's audio is actually playing (MurekaStage.jsx's TrackCard
 * controls that via the <audio> element's play/pause events). */
export default function KaraokeLyrics({ raw, currentTimeMs }) {
  const [lines] = useState(() => flattenLyricsLines(raw));
  if (!lines.length) return null;

  const idx = currentLineIndex(lines, currentTimeMs);
  const from = Math.max(0, idx - 2);
  const visible = lines.slice(from, from + 6);

  return (
    <div className="mureka-karaoke">
      {visible.map((line, i) => {
        const globalIdx = from + i;
        return (
          <div key={globalIdx} className={`mureka-karaoke-line${globalIdx === idx ? ' is-current' : ''}`}>
            {line.text}
          </div>
        );
      })}
    </div>
  );
}
