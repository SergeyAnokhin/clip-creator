/** Client-side mirror of `providers/editor.py`'s `build_render_plan` canvas
 * pick - display-only (same "preview is an approximation, the server does
 * the real math" convention as `useEditorPreview.js`), so
 * `EditorStage.jsx` can show the resolved canvas size next to the render
 * buttons without a round trip. Keep in sync with editor.py's
 * `_DEFAULT_CANVAS`/`_PORTRAIT_CANVAS`/`all_portrait` logic if that ever
 * changes. */

export const DEFAULT_CANVAS_SIZE = { width: 1920, height: 1080 };
export const PORTRAIT_CANVAS_SIZE = { width: 1080, height: 1920 };

/** `orientation` is `video_edit.canvas_orientation` ('auto'/'portrait'/
 * 'landscape'). In 'auto', a clip with no probed `aspect_ratio` (a manually
 * uploaded/imported video - never probed, see editor.py's own comment)
 * doesn't veto portrait; only a clip explicitly not '9:16' does. */
export function resolveCanvasSize(clips, scenes, orientation) {
  if (orientation === 'portrait') return PORTRAIT_CANVAS_SIZE;
  if (orientation === 'landscape') return DEFAULT_CANVAS_SIZE;
  const allPortrait = (clips || []).every((clip) => {
    const video = (scenes?.[clip.scene_index]?.videos || []).find((v) => v.video_id === clip.video_id);
    const aspectRatio = video?.aspect_ratio;
    return aspectRatio == null || aspectRatio === '9:16';
  });
  return allPortrait ? PORTRAIT_CANVAS_SIZE : DEFAULT_CANVAS_SIZE;
}
