/** Flattens a Mureka track's `raw.lyrics_sections` (see providers/mureka.py's
 * module docstring / the confirmed `Song`/`LyricsSection` schema) into one
 * ordered list of sung lines with millisecond timing, for
 * KaraokeLyrics.jsx. Sections/lines without timing (e.g. an instrumental
 * intro) are dropped - nothing to highlight there. */
export function flattenLyricsLines(raw) {
  const sections = raw?.lyrics_sections || [];
  const lines = [];
  for (const section of sections) {
    for (const line of section.lines || []) {
      if (line.start == null || line.end == null || !line.text) continue;
      lines.push({ text: line.text, start: line.start, end: line.end, words: line.words || [] });
    }
  }
  return lines;
}

/** Index of the line active at `currentMs` - the last line whose `start` is
 * at or before `currentMs`, so a gap between two lines (an instrumental
 * break) still shows the most recent one instead of blanking the panel. -1
 * before the first line starts. */
export function currentLineIndex(lines, currentMs) {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].start <= currentMs) idx = i;
    else break;
  }
  return idx;
}
