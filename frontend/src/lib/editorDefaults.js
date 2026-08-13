/**
 * Pure Editor-stage seeding logic, kept out of `useEditorStage.js` so the
 * "which scenes/videos/track get auto-picked the first time the stage
 * opens" rule is independently testable - mirrors `lib/scenes.js`'s
 * `resolveAnimateImage` / `lib/titleCard.js`'s `pickTopReferenceImages`.
 */

function randomId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

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
