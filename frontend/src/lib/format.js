export function formatDate(iso, lang) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** `M:SS:FF` timecode (frames at `TIMELINE_FPS`) - the Editor timeline's own
 * display format, matching what a desktop NLE shows so the playhead can be
 * read (and typed) to the frame instead of only to the second. Shared by the
 * timeline toolbar, the program monitor's transport and the ruler helper
 * rather than being re-declared in each of them, which is how the three
 * previous copies of a `M:SS`-only formatter came about. */
export function formatTimecode(ms, fps = 30) {
  const total = Math.max(0, ms);
  const totalSeconds = Math.floor(total / 1000);
  const frames = Math.floor(((total % 1000) / 1000) * fps);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
}

/** `M:SS` - the compact form used for ruler tick labels, where a frame field
 * would just be noise. */
export function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Inverse of `formatTimecode`, forgiving about how much of it was typed:
 * `12` = 12s, `1:05` = 1m05s, `1:05:15` = 1m05s+15 frames. Returns `null`
 * for anything unparseable, so a caller can leave the field alone instead of
 * seeking to 0. */
export function parseTimecode(text, fps = 30) {
  const parts = String(text).trim().split(':');
  if (!parts.length || parts.length > 3 || parts.some((p) => p !== '' && !/^\d+$/.test(p))) return null;
  const nums = parts.map((p) => Number(p || 0));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  if (nums.length === 1) return nums[0] * 1000;
  if (nums.length === 2) return (nums[0] * 60 + nums[1]) * 1000;
  return (nums[0] * 60 + nums[1]) * 1000 + (nums[2] / fps) * 1000;
}
