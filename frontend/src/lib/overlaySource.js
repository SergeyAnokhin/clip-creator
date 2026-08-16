import { mediaUrl } from '../api/client.js';

/** Resolves an overlay's own source image to a display URL + short label -
 * shared by the timeline block, the inspector, and the live preview so all
 * three agree on what a given overlay actually shows. A title-card variant
 * lives under the project (`projects/{id}/...`, same convention as a scene
 * video); a logo is global (`settings.logos[]`, served from the data root
 * directly - no project prefix, same as `PosterConstructor.jsx`'s own logo
 * lookup). Returns `{src: string|null, label: string}` - `src` is `null`
 * (the caller falls back to a plain block, no thumbnail) if the source no
 * longer exists, e.g. a deleted variant/logo left a dangling overlay. */
export function resolveOverlaySource(overlay, { projectId, titleCardVariants, logos, L }) {
  if (overlay.kind === 'logo') {
    const logo = (logos || []).find((item) => item.id === overlay.source_id);
    return {
      src: logo ? mediaUrl(logo.file_path) : null,
      label: logo ? (logo.name || L.overlay_kindLogo) : L.overlay_sourceMissing,
    };
  }
  const variant = (titleCardVariants || []).find((v) => v.variant_id === overlay.source_id);
  return {
    src: variant ? mediaUrl(`projects/${projectId}/${variant.file_path}`) : null,
    label: variant ? L.overlay_kindTitleCard : L.overlay_sourceMissing,
  };
}
