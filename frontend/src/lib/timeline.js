/**
 * Pure Editor-stage timeline math, kept out of components/hooks so it can be
 * unit tested without mounting React or touching <video>/<audio> elements.
 *
 * An `EditorClip` is `{clip_id, scene_index, video_id, trim_start_ms,
 * trim_end_ms, speed, reverse?, transition_in?, fade_in?, fade_out?}`
 * (`trim_end_ms: null` means "to the end of the source clip"; `reverse` -
 * absent/`false` by default - plays the trimmed content back to front,
 * resolved into a real ffmpeg `reverse` filter at render time
 * (`providers/editor.py`) and, like `transition_in`/fades, **not** simulated
 * by the in-browser preview: a native `<video>` element has no negative
 * `playbackRate`, so a reversed clip just plays forward here, same
 * "approximate, non-blocking" tolerance the rest of this preview already
 * has). All functions here work in
 * the *output* timeline's millisecond coordinate space (post-speed), not the
 * source clip's own.
 *
 * `transition_in` (`{type, duration_ms}` | absent = a hard cut) and
 * `fade_in`/`fade_out` (`{color, duration_ms}` | absent = no fade) are
 * resolved into a real ffmpeg `xfade`/`fade` filter at render time
 * (`providers/editor.py`) - deliberately **not** modeled in this file's
 * layout math. A transition overlaps its two clips' actual frames, which
 * genuinely shortens the real output vs. the naive sum of clip durations
 * this file computes, but the timeline already has an established, accepted
 * tolerance for the real render differing slightly from this approximate
 * layout (duration-mismatch warnings, the render's own `tpad` freeze-pad) -
 * a transition's overlap is just another source of that same gap, not a
 * reason to rework `computeTimelineClips` into a non-back-to-back layout.
 */

// A manually uploaded/imported video (`video.save_uploaded_video`/
// `import_video_batch` - a real, common case, not hypothetical) has no
// known `duration_seconds`. When that happens *and* the clip has no
// explicit `trim_end_ms` either, there is no real number to lay the clip
// out with - this stand-in (the app's own default generated-clip length,
// see `useVideoStage.js`'s `durationSeconds` default) just keeps the
// timeline/preview usable until the user sets a real trim end after seeing
// the clip play; the actual render never depends on this - ffmpeg reads
// the real file and runs the clip to its own EOF in this same case (see
// `providers/editor.py::build_render_plan`'s docstring).
export const UNKNOWN_DURATION_FALLBACK_MS = 5000;

/** `trim_end_ms: null` defaults to the source clip's own duration, or the
 * fallback above when that's unknown too - mirrors
 * `providers/editor.py`'s `build_render_plan` default server-side. */
export function resolveTrimEndMs(clip, sourceDurationMs) {
  if (clip.trim_end_ms != null) return clip.trim_end_ms;
  return sourceDurationMs || UNKNOWN_DURATION_FALLBACK_MS;
}

/** How long this clip plays for on the *output* timeline, after trim+speed. */
export function computeClipDurationMs(clip, sourceDurationMs) {
  const trimStartMs = clip.trim_start_ms || 0;
  const trimEndMs = resolveTrimEndMs(clip, sourceDurationMs);
  const speed = clip.speed || 1;
  return Math.max(0, (trimEndMs - trimStartMs) / speed);
}

/** Annotates each clip with its resolved trim bounds plus its
 * `startMs`/`endMs`/`durationMs` position on the output timeline, laid out
 * back-to-back in array order. `sourceDurationsById` maps `video_id` ->
 * the source clip's own duration in ms. */
export function computeTimelineClips(clips, sourceDurationsById) {
  let cursor = 0;
  return clips.map((clip) => {
    const sourceDurationMs = sourceDurationsById[clip.video_id] || 0;
    const trimStartMs = clip.trim_start_ms || 0;
    const trimEndMs = resolveTrimEndMs(clip, sourceDurationMs);
    const durationMs = computeClipDurationMs(clip, sourceDurationMs);
    const startMs = cursor;
    const endMs = cursor + durationMs;
    cursor = endMs;
    return { ...clip, startMs, endMs, durationMs, trimStartMs, trimEndMs };
  });
}

export function getTotalDurationMs(clips, sourceDurationsById) {
  const timelineClips = computeTimelineClips(clips, sourceDurationsById);
  return timelineClips.length ? timelineClips[timelineClips.length - 1].endMs : 0;
}

/** Given clips already annotated by `computeTimelineClips` and a playhead
 * position (ms, output timeline), returns `{index, clip, localOffsetMs}` -
 * `localOffsetMs` is the position to seek the underlying source `<video>`
 * to. A playhead past the last clip's end pins to that clip's own trimmed
 * end (frozen-last-frame), mirroring the render's `tpad` padding policy so
 * preview and render agree conceptually. A negative playhead clamps to the
 * first clip's start. Returns `null` for an empty timeline. */
export function findActiveClip(timelineClips, playheadMs) {
  if (!timelineClips.length) return null;

  const first = timelineClips[0];
  if (playheadMs <= first.startMs) {
    return { index: 0, clip: first, localOffsetMs: first.trimStartMs };
  }

  const lastIndex = timelineClips.length - 1;
  const last = timelineClips[lastIndex];
  if (playheadMs >= last.endMs) {
    return { index: lastIndex, clip: last, localOffsetMs: last.trimEndMs };
  }

  const index = timelineClips.findIndex((c) => playheadMs >= c.startMs && playheadMs < c.endMs);
  const clip = timelineClips[index];
  const speed = clip.speed || 1;
  const localOffsetMs = clip.trimStartMs + (playheadMs - clip.startMs) * speed;
  return { index, clip, localOffsetMs };
}

/** Bounds-safe `{trimStartMs, trimEndMs}` pair within `[0, sourceDurationMs]`,
 * keeping at least 1ms between them. */
export function clampTrim(trimStartMs, trimEndMs, sourceDurationMs) {
  const start = Math.max(0, Math.min(trimStartMs, sourceDurationMs));
  const end = Math.min(sourceDurationMs, Math.max(trimEndMs, start + 1));
  return { trimStartMs: start, trimEndMs: end };
}

// Output frame rate the timeline's own frame-stepping/timecode math assumes -
// mirrors `providers/editor.py`'s `_FPS`. The render is the source of truth;
// this is only how far one arrow-key press moves the playhead and how the
// `M:SS:FF` timecode splits its last field.
export const TIMELINE_FPS = 30;
export const FRAME_MS = 1000 / TIMELINE_FPS;

// Shortest clip the direct-manipulation gestures below (edge drag, split)
// are allowed to leave behind, in source-clip milliseconds. Purely an
// ergonomics floor - it keeps a clip from collapsing into an unclickable
// sliver on the timeline.
export const MIN_CLIP_MS = 200;

/** Array move: the clip at `fromIndex` lands at `toIndex`, everything else
 * keeps its relative order. Out-of-range indices return `clips` unchanged. */
export function moveClip(clips, fromIndex, toIndex) {
  if (fromIndex === toIndex) return clips;
  if (fromIndex < 0 || fromIndex >= clips.length) return clips;
  if (toIndex < 0 || toIndex >= clips.length) return clips;
  const next = [...clips];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

/** Index the clip at `fromIndex` should land at when it is dragged so that
 * its own start sits at `newStartMs` on the output timeline. Compares the
 * dragged clip's new centre against the *original* layout centres of the
 * other clips - the sequential (gap-free) timeline re-lays itself out after
 * the drop anyway, so an exact post-drop layout isn't needed to pick the
 * slot. `timelineClips` must come from `computeTimelineClips`. */
export function dropIndexForStart(timelineClips, fromIndex, newStartMs) {
  const dragged = timelineClips[fromIndex];
  if (!dragged) return fromIndex;
  const draggedCentre = newStartMs + dragged.durationMs / 2;
  let index = 0;
  timelineClips.forEach((clip, i) => {
    if (i === fromIndex) return;
    if (clip.startMs + clip.durationMs / 2 < draggedCentre) index += 1;
  });
  return index;
}

// Bounds for `speed` - mirrors the numeric field in TimelineClipInspector.jsx
// and applies equally to the Ctrl+drag gesture in applyEdgeSpeed below.
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

// Quick-cycle presets for the program monitor's right-click context menu
// (EditorPreviewContextMenu.jsx) - the precise numeric field stays in
// TimelineClipInspector.jsx; this is just a fast way to try a common speed
// without leaving the preview.
const SPEED_PRESETS = [0.5, 1, 1.5, 2];

/** The next speed in `SPEED_PRESETS` after `currentSpeed`, wrapping back to
 * the first once past the last - the exact value if `currentSpeed` doesn't
 * match a preset (e.g. a custom value typed into the inspector) is treated
 * as sitting just before the smallest preset it's less than, or wraps to the
 * first preset if it's >= the largest. */
export function nextSpeedPreset(currentSpeed) {
  const next = SPEED_PRESETS.find((preset) => preset > (currentSpeed || 1) + 1e-9);
  return next ?? SPEED_PRESETS[0];
}

// `transition_in.type` - the set of boundary transitions the render can
// produce, mirroring `providers/editor.py`'s `_TRANSITION_XFADE_NAME` key for
// key. 'none' means "no transition_in object at all" on the clip, listed here
// only so the inspector has a "remove transition" option in the same button
// row as the real types.
//
// Grouped for the inspector's picker: a flat row of a dozen-plus chips is
// unreadable, and CapCut/Movavi both group their transition browsers the same
// way (dissolves / wipes / slides / shapes). The keys the first version
// shipped with ('dissolve', 'fadeblack', 'fadewhite') keep their exact names
// so no saved project's transitions change meaning.
export const TRANSITION_GROUPS = [
  { key: 'basic', types: ['none', 'dissolve', 'fadeblack', 'fadewhite'] },
  { key: 'wipe', types: ['wipeleft', 'wiperight', 'wipeup', 'wipedown'] },
  { key: 'slide', types: ['slideleft', 'slideright', 'slideup', 'slidedown'] },
  { key: 'shape', types: ['circleopen', 'circleclose', 'radial', 'pixelize'] },
];
export const TRANSITION_TYPES = TRANSITION_GROUPS.flatMap((group) => group.types);
export const DEFAULT_TRANSITION_MS = 500;
export const MIN_TRANSITION_MS = 50;

// `fade_in`/`fade_out.color` - a plain ffmpeg `fade` filter within the
// clip's own duration, no effect on neighbours.
export const FADE_COLORS = ['black', 'white'];
export const DEFAULT_FADE_MS = 500;

// Bounds for `clip.fit` (how a clip whose own aspect ratio doesn't match the
// canvas fills it) - mirrors `providers/editor.py`'s own clamps.
export const FIT_MODES = ['cover', 'contain'];
export const MIN_FIT_ZOOM = 1;
export const MAX_FIT_ZOOM = 4;
export const DEFAULT_FIT = { mode: 'cover', zoom: 1, offset_x_pct: 50, offset_y_pct: 50 };

// Bounds for `clip.adjust` (per-clip colour correction) - ffmpeg `eq`
// semantics, mirrored by `providers/editor.py`'s own `_resolve_adjust`.
// Absent/`null` means exactly these values, and the render then emits no
// `eq` filter at all rather than a no-op one.
export const DEFAULT_ADJUST = {
  brightness: 0, contrast: 1, saturation: 1, gamma: 1,
};

/** Whether a clip's `adjust` is (or is equivalent to) "no correction" - what
 * the inspector's "нет" preset highlights against, and the same test the
 * render uses to decide whether to emit the filter. */
export function isDefaultAdjust(adjust) {
  if (!adjust) return true;
  return Object.entries(DEFAULT_ADJUST).every(([key, value]) => (adjust[key] ?? value) === value);
}

/** New `speed` after Ctrl+dragging one edge of a clip by `deltaOutputMs` on
 * the output timeline - the CapCut-style "speed ramp" gesture. Unlike
 * `applyEdgeTrim`, the trim window itself never moves: only `speed` changes,
 * so the same source frames stretch or compress to fill more or less of the
 * output timeline (every later clip then re-flows against the new duration
 * via `computeTimelineClips`'s back-to-back layout - no separate "magnet"
 * logic needed). Dragging the end edge outward (positive delta) slows the
 * clip down; dragging the start edge outward (negative delta, since it moves
 * the boundary earlier) does the same - both read as "make the clip take up
 * more of the timeline". */
export function applyEdgeSpeed(clip, sourceDurationMs, edge, deltaOutputMs) {
  const trimStartMs = clip.trim_start_ms || 0;
  const trimEndMs = resolveTrimEndMs(clip, sourceDurationMs);
  const windowMs = Math.max(1, trimEndMs - trimStartMs);
  const oldSpeed = clip.speed || 1;
  const oldDurationMs = windowMs / oldSpeed;
  const sign = edge === 'end' ? 1 : -1;
  const newDurationMs = Math.max(MIN_CLIP_MS, oldDurationMs + sign * deltaOutputMs);
  const speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, windowMs / newDurationMs));
  return { speed: Math.round(speed * 100) / 100 };
}

/** New `{trimStartMs, trimEndMs}` after dragging one edge of a clip by
 * `deltaOutputMs` on the output timeline. Output-space deltas are converted
 * to source-space by the clip's own speed. The opposite edge never moves,
 * and the window stays inside `[0, sourceDurationMs]` (unbounded above when
 * the source duration is unknown - an imported clip, see
 * `UNKNOWN_DURATION_FALLBACK_MS`). */
export function applyEdgeTrim(clip, sourceDurationMs, edge, deltaOutputMs) {
  const speed = clip.speed || 1;
  const deltaSourceMs = deltaOutputMs * speed;
  const trimStartMs = clip.trim_start_ms || 0;
  const trimEndMs = resolveTrimEndMs(clip, sourceDurationMs);
  const maxEnd = sourceDurationMs > 0 ? sourceDurationMs : Infinity;
  if (edge === 'start') {
    const start = Math.min(Math.max(0, trimStartMs + deltaSourceMs), trimEndMs - MIN_CLIP_MS);
    return { trimStartMs: Math.round(start), trimEndMs: Math.round(trimEndMs) };
  }
  const end = Math.max(Math.min(maxEnd, trimEndMs + deltaSourceMs), trimStartMs + MIN_CLIP_MS);
  return { trimStartMs: Math.round(trimStartMs), trimEndMs: Math.round(end) };
}

/** New `{trimStartMs, trimEndMs}` after "trim this edge up to the playhead"
 * (CapCut's Q/W): the clip keeps the side of itself the playhead leaves
 * intact and gives up the rest, without moving anything else - the
 * back-to-back layout re-flows on its own afterwards. `timelineClip` must be
 * annotated by `computeTimelineClips` (it needs `startMs`/`trimStartMs`/
 * `trimEndMs`). Returns `null` when the playhead isn't strictly inside the
 * clip, or when the cut would leave less than `MIN_CLIP_MS` behind - same
 * refusal `splitClipsAt` makes, so a no-op keystroke never silently
 * collapses a clip into a sliver. */
export function trimEdgeToPlayhead(timelineClip, playheadMs, edge) {
  if (!timelineClip) return null;
  if (playheadMs <= timelineClip.startMs || playheadMs >= timelineClip.endMs) return null;
  const speed = timelineClip.speed || 1;
  const cutSourceMs = Math.round(timelineClip.trimStartMs + (playheadMs - timelineClip.startMs) * speed);
  if (edge === 'start') {
    if (timelineClip.trimEndMs - cutSourceMs < MIN_CLIP_MS) return null;
    return { trimStartMs: cutSourceMs, trimEndMs: Math.round(timelineClip.trimEndMs) };
  }
  if (cutSourceMs - timelineClip.trimStartMs < MIN_CLIP_MS) return null;
  return { trimStartMs: Math.round(timelineClip.trimStartMs), trimEndMs: cutSourceMs };
}

// Default length of the still a "freeze frame" insert produces, in output ms
// - CapCut inserts a fixed-length still at the playhead rather than asking
// first, and the block is trimmable like any other afterwards.
export const DEFAULT_FREEZE_MS = 2000;

/** Splits the clip under the playhead and inserts a `freeze: true` clip
 * (`DEFAULT_FREEZE_MS` long) between the halves - the still is just another
 * clip over the same source whose `trim_start_ms` is the frozen instant, so
 * every existing per-clip control (fades, fit, transitions, reorder) keeps
 * working on it. `providers/editor.py` renders it by holding that one frame
 * (`tpad`) instead of playing the window. Returns `clips` unchanged when the
 * playhead sits outside the timeline or on a cut. `makeId` supplies the new
 * clip ids. */
export function freezeClipsAt(clips, sourceDurationsById, playheadMs, makeId) {
  const timelineClips = computeTimelineClips(clips, sourceDurationsById);
  const index = timelineClips.findIndex((c) => playheadMs > c.startMs && playheadMs < c.endMs);
  if (index === -1) return clips;
  const target = timelineClips[index];
  const speed = target.speed || 1;
  const cutSourceMs = Math.round(target.trimStartMs + (playheadMs - target.startMs) * speed);
  const original = clips[index];
  const left = { ...original, trim_start_ms: target.trimStartMs, trim_end_ms: cutSourceMs };
  const still = {
    ...original,
    clip_id: makeId(),
    trim_start_ms: cutSourceMs,
    // The window's length *is* the still's output length, so speed must be 1
    // and no transition should be inherited onto the frozen block.
    trim_end_ms: cutSourceMs + DEFAULT_FREEZE_MS,
    speed: 1,
    reverse: false,
    freeze: true,
    transition_in: null,
  };
  const right = { ...original, clip_id: makeId(), trim_start_ms: cutSourceMs, trim_end_ms: target.trimEndMs, transition_in: null };
  return [...clips.slice(0, index), left, still, right, ...clips.slice(index + 1)];
}

/** Splits whichever clip the playhead is inside into two clips that play
 * back-to-back exactly like the original did (razor tool). The right half is
 * a second clip over the *same* source video with a later trim window, which
 * the renderer already supports - `build_render_plan` resolves every clip
 * independently and never assumes a video is used once. Returns `clips`
 * unchanged when the playhead sits outside the timeline, on a cut, or too
 * close to either edge to leave `MIN_CLIP_MS` on both sides. `makeId`
 * supplies the new clip's `clip_id`. */
export function splitClipsAt(clips, sourceDurationsById, playheadMs, makeId) {
  const timelineClips = computeTimelineClips(clips, sourceDurationsById);
  const index = timelineClips.findIndex((c) => playheadMs > c.startMs && playheadMs < c.endMs);
  if (index === -1) return clips;
  const target = timelineClips[index];
  const speed = target.speed || 1;
  const cutSourceMs = Math.round(target.trimStartMs + (playheadMs - target.startMs) * speed);
  if (cutSourceMs - target.trimStartMs < MIN_CLIP_MS) return clips;
  if (target.trimEndMs - cutSourceMs < MIN_CLIP_MS) return clips;
  const original = clips[index];
  const left = { ...original, trim_start_ms: target.trimStartMs, trim_end_ms: cutSourceMs };
  const right = { ...original, clip_id: makeId(), trim_start_ms: cutSourceMs, trim_end_ms: target.trimEndMs };
  return [...clips.slice(0, index), left, right, ...clips.slice(index + 1)];
}
