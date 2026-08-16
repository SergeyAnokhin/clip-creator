import { DEFAULT_TRANSITION_MS, MIN_TRANSITION_MS, TRANSITION_TYPES } from '../../lib/timeline.js';

/** Properties strip for the selected clip boundary - a type chip row
 * (`none` sits among the real types on purpose: picking it *is* "remove the
 * transition", no separate delete button needed) plus a duration field once
 * a real type is picked. `clip` is the *later* clip of the pair, since
 * that's where `transition_in` lives (see useEditorStage.js). */
export default function TimelineTransitionInspector({ L, clip, actions }) {
  if (!clip) return null;
  const transition = clip.transition_in;
  const type = transition?.type || 'none';
  const durationMs = transition?.duration_ms || DEFAULT_TRANSITION_MS;

  return (
    <div className="tl-inspector">
      <span className="tl-inspector-title">{L.transition_inspectorTitle}</span>

      <div className="tl-inspector-row tl-transition-types">
        {TRANSITION_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            className={`tl-transition-chip${type === t ? ' is-selected' : ''}`}
            onClick={() => actions.setClipTransition(clip.clip_id, t, durationMs)}
          >
            {L[`transition_type_${t}`]}
          </button>
        ))}
      </div>

      {type !== 'none' && (
        <label className="tl-inspector-label tl-inspector-row">
          <span className="tl-inspector-rowlabel">{L.transition_durationLabel}</span>
          <input
            type="number" step="0.1" min={MIN_TRANSITION_MS / 1000}
            className="field tl-inspector-num" value={(durationMs / 1000).toFixed(1)}
            onChange={(e) => {
              const ms = Math.max(MIN_TRANSITION_MS, Number(e.target.value) * 1000);
              actions.setClipTransition(clip.clip_id, type, ms);
            }}
          />
        </label>
      )}
    </div>
  );
}
