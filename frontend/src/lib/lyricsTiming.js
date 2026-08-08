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
 * `{text, start, end, words, sectionType, isSection, interpolated, static}`.
 * Nothing with actual content is ever silently dropped, even when Mureka
 * gave it no timing at all - confirmed against a real generated track
 * (2026-08): a leading run of sections (there, an `intro` and the following
 * `verse` - Mureka's own `section_type`, not ours) can carry no `start`/`end`
 * whatsoever on the section *or* any of its lines, which used to mean the
 * whole thing vanished from the karaoke view (looked like the intro was
 * skipped). Such lines now come through with `start: null, end: null,
 * static: true` - `formatMs`/`seekTo` in both consumers already render `null`
 * as "-"/no-op, so they show up as always-visible, never-highlighted text.
 * A section with no lines at all (instrumental, or simply untimed) becomes
 * one `isSection: true` marker row the same way, `static: true` when it has
 * no `start`/`end` either (rendered as "♪ {sectionType}" with no timestamp). */
export function flattenLyricsLines(raw) {
  const sections = raw?.lyrics_sections || [];
  const rows = [];
  for (const section of sections) {
    const lines = interpolateSectionLines(section);
    if (!lines.length) {
      rows.push({
        text: null, start: section.start ?? null, end: section.end ?? null, words: [],
        sectionType: section.section_type || null, isSection: true, interpolated: false,
        static: section.start == null || section.end == null,
      });
      continue;
    }
    for (const line of lines) {
      if (!line.text) continue;
      const timed = line.start != null && line.end != null;
      rows.push({
        text: line.text, start: timed ? line.start : null, end: timed ? line.end : null,
        words: line.words || [], sectionType: section.section_type || null,
        isSection: false, interpolated: !!line.interpolated, static: !timed,
      });
    }
  }
  return rows;
}

/** Index of the line active at `currentMs` - the last *timed* line whose
 * `start` is at or before `currentMs`, so a gap between two lines (an
 * instrumental break) still shows the most recent one instead of blanking
 * the panel. `static: true` rows (see `flattenLyricsLines`) have no `start`
 * to compare and are skipped rather than breaking the scan - they're shown
 * unconditionally by the consumer, never as "current". -1 before the first
 * timed line starts. */
export function currentLineIndex(lines, currentMs) {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].start == null) continue;
    if (lines[i].start <= currentMs) idx = i;
    else break;
  }
  return idx;
}

/** The last non-null `end` in `lines` (walking backward past any trailing
 * `static` rows, which have no `end` to compare), or `null` if none of them
 * carry timing at all. Shared by `isBeyondKnownTiming` and by callers that
 * show "Mureka only timed lines up to {time}" (e.g.
 * MurekaTrackDetailModal.jsx's coverage hint). */
export function lastKnownEnd(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].end != null) return lines[i].end;
  }
  return null;
}

/** True for a row a human actually sings at some instant - everything except
 * section marker rows and lines that are nothing but Mureka's own bracketed
 * production tags (`[Instrument: ...]`, `[Female_Vocal]`, etc., each their
 * own row in `flattenLyricsLines`'s output). Only these get a manual
 * "tap to mark this line's start" button in MurekaTrackDetailModal.jsx - a
 * tag-only row has no moment to tap. A line that's mostly tag but *also*
 * carries real text (rare, but Mureka does mix them, e.g. a bracketed
 * ad-lib inline with lyrics) still counts as tappable. */
export function isTappableLine(row) {
  if (!row || row.isSection || !row.text) return false;
  return !/^(\s*\[[^\]]*\]\s*)+$/.test(row.text);
}

/** Rebuilds each row's effective timing from the user's manual anchor taps
 * (MurekaTrackDetailModal.jsx's "моя"/adjusted column) - the only way to
 * correct `lyrics_sections` timing, since the offset documented in
 * docs/data-model.md (Mureka's alignment appears to measure from wherever
 * it first locked on, not the track's true start) can't be derived from the
 * API response alone. `anchors` is `{[rowIndex]: userTappedMs}`, `rowIndex`
 * matching this same `rows` array's indices.
 *
 * Between two anchors, every other row in the run is mapped through the
 * *local* linear scaling from Mureka's own original timestamps, so relative
 * spacing Mureka got right within that stretch is preserved and only the
 * drift is corrected; a row (or an anchor's own row) with no usable
 * original `start` falls back to interpolating by row position instead.
 * Before the first anchor or after the last, rows are shifted by that
 * anchor's constant offset (nothing on the other side to scale against) -
 * and if the row itself has no original `start` to shift, its adjusted
 * timing is left unresolved (`null`) rather than guessed. With no anchors
 * at all, every row's original timing passes through unchanged - "if I
 * haven't tapped anything, fall back to Mureka's data" per the user's own
 * framing of this feature. Returns a new array (`{...row, adjustedStart,
 * adjustedEnd, isAnchor}`); input `rows` is untouched. */
export function applyManualAnchors(rows, anchors) {
  const anchorList = Object.keys(anchors || {})
    .map((key) => ({ index: Number(key), ms: anchors[key] }))
    .filter((a) => Number.isInteger(a.index) && a.index >= 0 && a.index < rows.length && a.ms != null)
    .sort((a, b) => a.index - b.index);

  return rows.map((row, i) => {
    const exact = anchorList.find((a) => a.index === i);
    if (exact) {
      const adjustedEnd = row.start != null && row.end != null ? exact.ms + (row.end - row.start) : null;
      return { ...row, adjustedStart: exact.ms, adjustedEnd, isAnchor: true };
    }
    if (!anchorList.length) {
      return { ...row, adjustedStart: row.start, adjustedEnd: row.end, isAnchor: false };
    }

    let left = null;
    let right = null;
    for (const a of anchorList) {
      if (a.index < i) left = a;
      else if (a.index > i && !right) right = a;
    }

    let adjustedStart = null;
    if (left && right) {
      const leftRow = rows[left.index];
      const rightRow = rows[right.index];
      let t;
      if (row.start != null && leftRow.start != null && rightRow.start != null && rightRow.start > leftRow.start) {
        t = Math.min(1, Math.max(0, (row.start - leftRow.start) / (rightRow.start - leftRow.start)));
      } else {
        t = (i - left.index) / (right.index - left.index);
      }
      adjustedStart = Math.round(left.ms + t * (right.ms - left.ms));
    } else {
      const anchor = left || right;
      const anchorRow = rows[anchor.index];
      if (row.start != null && anchorRow.start != null) {
        adjustedStart = row.start + (anchor.ms - anchorRow.start);
      }
    }

    const adjustedEnd = adjustedStart != null && row.start != null && row.end != null
      ? adjustedStart + (row.end - row.start) : null;
    return { ...row, adjustedStart, adjustedEnd, isAnchor: false };
  });
}

/** True once playback has moved past the last *timed* row `flattenLyricsLines`
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
  const end = lastKnownEnd(lines);
  return end != null && currentMs > end;
}
