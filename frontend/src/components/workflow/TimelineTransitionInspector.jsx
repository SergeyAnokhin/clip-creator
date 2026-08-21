import { CopyCheck } from 'lucide-react';
import { DEFAULT_TRANSITION_MS, MIN_TRANSITION_MS, TRANSITION_GROUPS } from '../../lib/timeline.js';

/** Properties strip for the selected clip boundary - the type picker
 * (`none` sits among the real types on purpose: picking it *is* "remove the
 * transition", no separate delete button needed) plus a duration field once
 * a real type is picked. `clip` is the *later* clip of the pair, since
 * that's where `transition_in` lives (see useEditorStage.js).
 *
 * The types are laid out in labelled groups (`TRANSITION_GROUPS`) rather than
 * one flat row: the catalogue grew past a dozen entries, and both CapCut and
 * Movavi group their own transition browsers the same way. "Применить ко
 * всем" applies the current type+duration to every boundary at once, which is
 * the single most repeated action once a rough cut exists - doing it by hand
 * means clicking every marker on the timeline. */
export default function TimelineTransitionInspector({ L, clip, actions }) {
  if (!clip) return null;
  const transition = clip.transition_in;
  const type = transition?.type || 'none';
  const durationMs = transition?.duration_ms || DEFAULT_TRANSITION_MS;

  return (
    <div className="tl-inspector">
      <span className="tl-inspector-title">{L.transition_inspectorTitle}</span>

      {TRANSITION_GROUPS.map((group) => (
        <div key={group.key} className="tl-transition-group">
          <span className="tl-inspector-rowlabel">{L[`transition_group_${group.key}`]}</span>
          <div className="tl-inspector-row tl-transition-types">
            {group.types.map((t) => (
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
        </div>
      ))}

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

      <div className="tl-inspector-actions">
        <button
          className="icon-btn" title={L.transition_applyToAll}
          onClick={() => actions.setAllTransitions(type, durationMs)}
        >
          <CopyCheck size={14} />
        </button>
      </div>
    </div>
  );
}
