/** Music-tag badge colors - assigned automatically (index-based, cycling),
 * never hand-picked by the user, so two tags are never visually identical
 * and every tag stays readable at a glance. Mirrors
 * backend/app/routers/settings.py's MUSIC_TAG_COLORS verbatim (the backend
 * seeds/normalizes colors for tags loaded from settings.json; this is only
 * needed client-side when useSettings.js's addMusicTag creates a brand new
 * tag before the next save round-trip) - keep both in sync. */
export const MUSIC_TAG_COLORS = [
  '#ff9d5c', '#7dd3fc', '#c4b5fd', '#86efac', '#fda4af',
  '#fbbf24', '#38bdf8', '#f472b6', '#a3e635', '#2dd4bf',
];

/** Next color to assign a new tag, cycling through MUSIC_TAG_COLORS by how
 * many tags already exist. */
export function nextMusicTagColor(existingCount) {
  return MUSIC_TAG_COLORS[(existingCount || 0) % MUSIC_TAG_COLORS.length];
}

/** Picks black or white text for readability against an arbitrary hex
 * background (relative-luminance heuristic, WCAG-ish threshold) - the tag
 * palette above is fixed but still spans light and dark hues, so the badge
 * text color can't be a single constant. */
export function pickReadableTextColor(hex) {
  const clean = (hex || '').replace('#', '');
  if (clean.length !== 6) return '#111';
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#111' : '#fff';
}
