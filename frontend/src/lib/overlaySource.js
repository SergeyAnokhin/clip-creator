import { mediaUrl } from '../api/client.js';

/** Resolves an overlay's own source (image or video) to a display URL +
 * short label - shared by the timeline block, the inspector, and the live
 * preview so all three agree on what a given overlay actually shows. A
 * title-card variant lives under the project (`projects/{id}/...`, same
 * convention as a scene video); a logo is global (`settings.logos[]`,
 * served from the data root directly - no project prefix, same as
 * `PosterConstructor.jsx`'s own logo lookup); a video-overlay source is
 * project-scoped like a title card (`video_edit.overlay_video_sources[]`,
 * not the global logo library - see `providers/editor.py`'s own docstring
 * on `kind: 'video'`). Returns `{src: string|null, label: string}` - `src`
 * is `null` (the caller falls back to a plain block, no thumbnail) if the
 * source no longer exists, e.g. a deleted variant/logo/video-source left a
 * dangling overlay. For `kind: 'video'`, `src` is the raw video file's own
 * URL - fine as a CSS `background-image` (the timeline block; a video URL
 * there just silently shows no image, same as `null`) or as the input to
 * `useVideoFirstFrame` (the live preview's Konva canvas, which needs an
 * actual still image, not a playable video - see `EditorPreview.jsx`). */
export function resolveOverlaySource(overlay, {
  projectId, titleCardVariants, logos, overlayVideoSources, L,
}) {
  if (overlay.kind === 'logo') {
    const logo = (logos || []).find((item) => item.id === overlay.source_id);
    return {
      src: logo ? mediaUrl(logo.file_path) : null,
      label: logo ? (logo.name || L.overlay_kindLogo) : L.overlay_sourceMissing,
    };
  }
  if (overlay.kind === 'video') {
    const source = (overlayVideoSources || []).find((item) => item.id === overlay.source_id);
    return {
      src: source ? mediaUrl(`projects/${projectId}/${source.file_path}`) : null,
      label: source ? source.file_path.split('/').pop() : L.overlay_sourceMissing,
    };
  }
  const variant = (titleCardVariants || []).find((v) => v.variant_id === overlay.source_id);
  return {
    src: variant ? mediaUrl(`projects/${projectId}/${variant.file_path}`) : null,
    label: variant ? L.overlay_kindTitleCard : L.overlay_sourceMissing,
  };
}
