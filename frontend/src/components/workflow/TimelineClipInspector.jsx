import { Trash2 } from 'lucide-react';
import { clampTrim } from '../../lib/timeline.js';

/** Properties strip for the clip currently selected on the timeline - the
 * numeric counterpart to the direct-manipulation gestures in
 * EditorTimeline.jsx (drag = reorder, edge drag = trim). Everything here is
 * exact-value editing that a drag can't do well: which generated video
 * variant the clip uses, the trim window to a tenth of a second, and speed. */
export default function TimelineClipInspector({ L, clip, scene, sourceDurationMs, actions }) {
  if (!clip) {
    return <div className="tl-inspector tl-inspector-empty">{L.editor_clipSelectHint}</div>;
  }

  const videos = scene?.videos || [];

  function commitTrim(nextStartMs, nextEndMs) {
    // Nothing to clamp *against* for an imported/uploaded clip with no known
    // duration (sourceDurationMs 0) - just keep start >= 0 and end > start,
    // same floor clampTrim uses.
    if (sourceDurationMs > 0) {
      const { trimStartMs, trimEndMs } = clampTrim(nextStartMs, nextEndMs, sourceDurationMs);
      actions.setClipTrim(clip.clip_id, trimStartMs, trimEndMs);
    } else {
      const start = Math.max(0, nextStartMs);
      actions.setClipTrim(clip.clip_id, start, Math.max(start + 100, nextEndMs));
    }
  }

  return (
    <div className="tl-inspector">
      <span className="tl-inspector-title">{L.editor_clipInspectorTitle}</span>

      <select
        className="field tl-inspector-field" value={clip.video_id}
        onChange={(e) => actions.changeClipVideo(clip.clip_id, e.target.value)}
      >
        {videos.map((v, i) => (
          <option key={v.video_id} value={v.video_id}>{`${L.editor_clipVideoOption} ${i + 1} (${v.duration_seconds || '?'}s)`}</option>
        ))}
      </select>

      <span className="tl-inspector-label">
        {L.editor_clipTrimLabel}
        <input
          type="number" step="0.1" min={0} {...(sourceDurationMs > 0 ? { max: (sourceDurationMs / 1000).toFixed(1) } : {})}
          className="field tl-inspector-num" value={(clip.trimStartMs / 1000).toFixed(1)}
          aria-label={L.editor_clipTrimStartLabel}
          onChange={(e) => commitTrim(Number(e.target.value) * 1000, clip.trimEndMs)}
        />
        →
        <input
          type="number" step="0.1" min={0} {...(sourceDurationMs > 0 ? { max: (sourceDurationMs / 1000).toFixed(1) } : {})}
          className="field tl-inspector-num" value={(clip.trimEndMs / 1000).toFixed(1)}
          aria-label={L.editor_clipTrimEndLabel}
          onChange={(e) => commitTrim(clip.trimStartMs, Number(e.target.value) * 1000)}
        />
      </span>

      <label className="tl-inspector-label">
        {L.editor_clipSpeedLabel}
        <input
          type="number" step="0.25" min="0.25" max="4"
          className="field tl-inspector-num" value={clip.speed || 1}
          onChange={(e) => actions.setClipSpeed(clip.clip_id, Math.max(0.25, Number(e.target.value) || 1))}
        />×
      </label>

      {!sourceDurationMs && <span className="tl-inspector-warn">⚠ {L.editor_unknownDuration}</span>}

      <button className="icon-btn icon-btn-danger tl-inspector-remove" title={L.editor_clipRemove} onClick={() => actions.removeClip(clip.clip_id)}>
        <Trash2 size={14} />
      </button>
    </div>
  );
}
