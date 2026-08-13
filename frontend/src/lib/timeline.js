/**
 * Pure Editor-stage timeline math, kept out of components/hooks so it can be
 * unit tested without mounting React or touching <video>/<audio> elements.
 *
 * An `EditorClip` is `{clip_id, scene_index, video_id, trim_start_ms,
 * trim_end_ms, speed}` (`trim_end_ms: null` means "to the end of the
 * source clip"). All functions here work in the *output* timeline's
 * millisecond coordinate space (post-speed), not the source clip's own.
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
