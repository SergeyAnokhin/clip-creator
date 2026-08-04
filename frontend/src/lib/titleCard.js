/**
 * Pure Title Card stage logic, kept out of components so it can be unit
 * tested without rendering React.
 */

/**
 * Picks the `count` best style-reference candidates across every scene's
 * generated images - rating (highest first) breaks ties by `generated_at`
 * (earliest first), and unrated images fall back to scene/generation order.
 * Used to auto-populate the 4 reference slots when the Title Card stage is
 * opened with none picked yet.
 */
export function pickTopReferenceImages(scenes, count) {
  const all = (scenes || []).flatMap((scene) => scene.images || []);
  const sorted = [...all].sort((a, b) => {
    if (b.rating !== a.rating) return b.rating - a.rating;
    return (a.generated_at || '').localeCompare(b.generated_at || '');
  });
  return sorted.slice(0, count).map((img) => img.file_path);
}
