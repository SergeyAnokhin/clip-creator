/** Fills in missing per-line `start`/`end` within one `lyrics_sections[]`
 * entry (see providers/mureka.py's module docstring / the confirmed
 * `Song`/`LyricsSection` schema, ms throughout - confirmed against
 * platform.mureka.ai's own schema browser, 2026-08: `duration` is
 * documented in ms, and every nested `start`/`end` - section, line, word -
 * follows the same unit with no separate scale). Mureka sometimes times a
 * section as a whole but skips a handful of its lines (short ad-libs,
 * doubled vocals); those lines' `start`/`end` are spread across the gap
 * between their nearest timed neighbours (section bounds if the run touches
 * either edge), weighted by text length, rather than being silently
 * dropped. Returns a new lines array; input is untouched. */
export function interpolateSectionLines(section) {
  const lines = section?.lines || [];
  if (!lines.length) return [];
  const out = lines.map((line) => ({ ...line }));

  let i = 0;
  while (i < out.length) {
    if (out[i].start != null && out[i].end != null) { i++; continue; }
    let j = i;
    while (j < out.length && (out[j].start == null || out[j].end == null)) j++;
    const rangeStart = i > 0 ? out[i - 1].end : section.start;
    const rangeEnd = j < out.length ? out[j].start : section.end;
    const run = out.slice(i, j).filter((line) => line.text);
    if (rangeStart != null && rangeEnd != null && rangeEnd > rangeStart && run.length) {
      const totalChars = run.reduce((sum, line) => sum + Math.max(1, line.text.length), 0);
      let cursor = rangeStart;
      for (const line of run) {
        const share = (Math.max(1, line.text.length) / totalChars) * (rangeEnd - rangeStart);
        line.start = Math.round(cursor);
        line.end = Math.round(cursor + share);
        line.interpolated = true;
        cursor += share;
      }
    }
    i = j;
  }
  return out;
}

/** Flattens a Mureka track's `raw.lyrics_sections` into one ordered list for
 * KaraokeLyrics.jsx / MurekaTrackDetailModal.jsx, ms timing throughout:
 * `{text, start, end, words, sectionType, isSection, interpolated}`.
 * A sung line missing timing even after `interpolateSectionLines` (no
 * neighbour to interpolate from) is dropped - nothing to highlight there.
 * A section with no lines at all (e.g. a purely instrumental intro) is
 * *not* dropped as long as Mureka gave it its own `start`/`end`: it becomes
 * one `isSection: true` marker row spanning that window, so a karaoke view
 * built from this list shows *something* through the intro instead of
 * jumping straight to the first sung line and looking like the intro was
 * skipped. */
export function flattenLyricsLines(raw) {
  const sections = raw?.lyrics_sections || [];
  const rows = [];
  for (const section of sections) {
    const lines = interpolateSectionLines(section);
    if (!lines.length) {
      if (section.start != null && section.end != null) {
        rows.push({
          text: null, start: section.start, end: section.end, words: [],
          sectionType: section.section_type || null, isSection: true, interpolated: false,
        });
      }
      continue;
    }
    for (const line of lines) {
      if (line.start == null || line.end == null || !line.text) continue;
      rows.push({
        text: line.text, start: line.start, end: line.end, words: line.words || [],
        sectionType: section.section_type || null, isSection: false, interpolated: !!line.interpolated,
      });
    }
  }
  return rows;
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

/** True once playback has moved past the last row `flattenLyricsLines`
 * could produce - confirmed against a real generated track (not a
 * hypothetical): Mureka's own `lyrics_sections` can simply stop over
 * halfway through the song (one real response timed lines up to ~100s of a
 * 232s track, nothing after - not an extend, not a parsing gap, just no
 * more section data in the response) rather than running out of gaps to
 * interpolate. `currentLineIndex`'s "hold the previous line" behaviour is
 * right for a genuine mid-song gap (an instrumental bridge before the next
 * verse) but wrong here - freezing on a stale line for the rest of the
 * track reads as broken, not as "no data". Callers should treat this as
 * "nothing to show" rather than keep highlighting the last known line. */
export function isBeyondKnownTiming(lines, currentMs) {
  if (!lines.length) return false;
  return currentMs > lines[lines.length - 1].end;
}
