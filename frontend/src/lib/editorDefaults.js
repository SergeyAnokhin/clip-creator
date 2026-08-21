/**
 * Pure Editor-stage seeding logic, kept out of `useEditorStage.js` so the
 * "which scenes/videos/track get auto-picked the first time the stage
 * opens" rule is independently testable - mirrors `lib/scenes.js`'s
 * `resolveAnimateImage` / `lib/titleCard.js`'s `pickTopReferenceImages`.
 */

function randomId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

// The shape `video_edit` falls back to before the stage has ever seeded one
// (see `buildDefaultClips` below) or while `activeProject` itself is still
// loading - shared by `useEditorStage.js` and `useEditorRender.js` so both
// agree on it without one importing internals from the other.
export const EMPTY_VIDEO_EDIT = {
  mureka_track_id: null, clips: [], overlays: [], overlay_video_sources: [], renders: [], canvas_orientation: 'auto',
  markers: [], audio: null, export: null,
};

/** `video_edit.audio` - how the picked Mureka track is laid under the video.
 * Absent/`null` on an older document means exactly these values, which is
 * also what the renderer did before the field existed (full track, full
 * volume, from the very start), so nothing has to be migrated. */
export const DEFAULT_AUDIO_SETTINGS = {
  volume: 1, fade_in_ms: 0, fade_out_ms: 0, offset_ms: 0,
};

/** `video_edit.export` - the output file's own shape, independent of the
 * `canvas_orientation` heuristic (which decides portrait vs landscape; this
 * decides how many pixels and how many frames that canvas gets). `'source'`
 * keeps whatever the canvas heuristic resolved, i.e. today's behaviour. */
export const DEFAULT_EXPORT_SETTINGS = {
  resolution: 'source', fps: 30, quality: 'high',
};
export const EXPORT_RESOLUTIONS = ['source', '720p', '1080p', '4k'];
export const EXPORT_FPS_OPTIONS = [24, 30, 60];
export const EXPORT_QUALITIES = ['high', 'medium', 'low'];

/** One clip per scene that already has an `is_selected` video, in scene
 * order - scenes with no selected video are simply skipped (the user can
 * add them later via "add scene"). */
export function buildDefaultClips(scenes) {
  const clips = [];
  (scenes || []).forEach((scene, sceneIndex) => {
    const video = (scene.videos || []).find((v) => v.is_selected);
    if (!video) return;
    clips.push({
      clip_id: randomId('clip'),
      scene_index: sceneIndex,
      video_id: video.video_id,
      trim_start_ms: 0,
      trim_end_ms: null,
      speed: 1.0,
    });
  });
  return clips;
}

/** The Mureka stage's own `is_selected` track is the default audio base -
 * overridable afterward, this only picks the starting point. */
export function defaultMurekaTrackId(tracks) {
  const track = (tracks || []).find((t) => t.is_selected);
  return track ? track.track_id : null;
}
