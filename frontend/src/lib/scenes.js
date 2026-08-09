/**
 * Pure scenes-stage logic, kept out of components so it can be unit tested
 * without rendering React.
 */

/**
 * Returns a copy of `images` with `is_selected` set only on the top-rated
 * image (spec 4.4: the highest-rated variant automatically becomes the
 * scene's main frame). Ties keep the currently-selected image if it's among
 * the tied top rating, otherwise the first tied image wins. A scene with no
 * images, or where every image is still rated 0, is left untouched - there
 * is no "best" yet, so any existing manual selection is preserved.
 */
export function pickMainByRating(images) {
  if (images.length === 0) return images;

  const maxRating = Math.max(...images.map((img) => img.rating));
  if (maxRating <= 0) return images;

  const currentlySelected = images.find((img) => img.is_selected);
  const keepCurrent = currentlySelected && currentlySelected.rating === maxRating;
  const winnerIndex = keepCurrent
    ? images.indexOf(currentlySelected)
    : images.findIndex((img) => img.rating === maxRating);

  return images.map((img, i) => ({ ...img, is_selected: i === winnerIndex }));
}

/**
 * Picks which of a scene's images the Video stage should animate: an
 * explicit per-scene override (`scene.animate_image_id`, set by clicking a
 * thumbnail in VideoStage.jsx - independent of the Images stage's
 * `is_selected` "main image" flag, spec: picking an image to animate must
 * not affect which image is the scene's main picture elsewhere) wins over
 * the Images stage's `is_selected` pick, which wins over just using the
 * first image. Returns `null` for a scene with no images at all.
 */
export function resolveAnimateImage(scene) {
  const images = scene?.images || [];
  if (!images.length) return null;
  const overridden = scene.animate_image_id && images.find((img) => img.image_id === scene.animate_image_id);
  return overridden || images.find((img) => img.is_selected) || images[0];
}
