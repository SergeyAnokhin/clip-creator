/** Per-stage completion/readiness for the workflow sidebar and the stage
 * footer's "next step" hint.
 *
 * Previously this lived inline in `Sidebar.jsx` and was optimistic to the
 * point of being wrong: `lyrics` was hardcoded 'completed' and `suno` reported
 * 'processing' the moment a project had any blocks, so a brand-new project
 * showed one finished and one in-progress stage before the user had done
 * anything. Statuses here are derived only from data that really exists, plus
 * a `blocked` state for a stage whose *inputs* are missing - which is what the
 * footer turns into "you need N scenes first".
 *
 * `running` is not derivable from the project at all (a job is in-flight
 * state, see `hooks/useJobs.js`) and is layered on by the caller. */

export const STAGE_KEYS = ['lyrics', 'suno', 'mureka', 'scenes', 'images', 'title_card', 'video', 'export', 'editor'];

/** Stage key -> its `i18n/dict.js` name key. Not derivable: `title_card` is
 * `stage_titleCard`, so string-building the key silently falls through. */
const STAGE_NAME_KEY = {
  lyrics: 'stage_lyrics', suno: 'stage_suno', mureka: 'stage_mureka', scenes: 'stage_scenes',
  images: 'stage_images', title_card: 'stage_titleCard', video: 'stage_video',
  export: 'stage_export', editor: 'stage_editor',
};

export function stageName(L, key) {
  return L[STAGE_NAME_KEY[key]] || key;
}

function counts(project) {
  const scenes = project?.scenes || [];
  return {
    blocks: (project?.blocks || []).length,
    scenes: scenes.length,
    withImages: scenes.filter((s) => (s.images || []).length > 0).length,
    withVideos: scenes.filter((s) => (s.videos || []).length > 0).length,
    tracks: (project?.mureka?.tracks || []).length,
    selectedTrack: (project?.mureka?.tracks || []).some((t) => t.is_selected),
    variants: (project?.title_card?.variants || []).length,
    clips: (project?.video_edit?.clips || []).length,
    renders: (project?.video_edit?.renders || []).length,
  };
}

/** Ratio of finished sub-items, or `null` when the stage isn't a per-scene one.
 * Rendered next to the stage name instead of the old fake sub-navigation. */
function ratio(ready, total) {
  return total > 0 ? `${ready}/${total}` : null;
}

/** `{ status, counter, blockedBy }` for one stage.
 * `status` is 'blocked' | 'pending' | 'processing' | 'completed'.
 * `blockedBy` names the stage that has to happen first. */
export function stageProgress(key, project) {
  const c = counts(project);
  const done = (counter = null) => ({ status: 'completed', counter, blockedBy: null });
  const partial = (counter = null) => ({ status: 'processing', counter, blockedBy: null });
  const todo = (counter = null) => ({ status: 'pending', counter, blockedBy: null });
  const blocked = (by) => ({ status: 'blocked', counter: null, blockedBy: by });

  switch (key) {
    case 'lyrics':
      return c.blocks > 0 ? done(String(c.blocks)) : todo();
    case 'suno':
      if (c.blocks === 0) return blocked('lyrics');
      return project?.style ? done() : todo();
    case 'mureka':
      if (c.blocks === 0) return blocked('lyrics');
      return c.tracks > 0 ? done(String(c.tracks)) : todo();
    case 'scenes':
      if (c.blocks === 0) return blocked('lyrics');
      return c.scenes > 0 ? done(String(c.scenes)) : todo();
    case 'images':
      if (c.scenes === 0) return blocked('scenes');
      if (c.withImages === c.scenes) return done(ratio(c.withImages, c.scenes));
      return c.withImages > 0 ? partial(ratio(c.withImages, c.scenes)) : todo(ratio(0, c.scenes));
    case 'title_card':
      // Output already exists (hand-built or imported), so the stage is not
      // waiting on its normal input any more.
      if (c.variants > 0) return done(String(c.variants));
      return c.withImages === 0 ? blocked('images') : todo();
    case 'video':
      if (c.withVideos === 0) return c.withImages === 0 ? blocked('images') : todo(ratio(0, c.scenes));
      if (c.withVideos === c.scenes) return done(ratio(c.withVideos, c.scenes));
      return partial(ratio(c.withVideos, c.scenes));
    case 'export':
      if (c.withVideos === 0 && !c.selectedTrack) return blocked('video');
      return c.withVideos > 0 && c.selectedTrack ? done() : partial();
    case 'editor':
      if (c.renders > 0) return done(String(c.renders));
      if (c.withVideos === 0) return blocked('video');
      return c.clips > 0 ? partial() : todo();
    default:
      return todo();
  }
}

/** The first stage that isn't finished - what "continue where I left off"
 * means. Falls back to the last stage once everything is done. */
export function nextIncompleteStage(project) {
  const found = STAGE_KEYS.find((key) => stageProgress(key, project).status !== 'completed');
  return found || STAGE_KEYS[STAGE_KEYS.length - 1];
}
