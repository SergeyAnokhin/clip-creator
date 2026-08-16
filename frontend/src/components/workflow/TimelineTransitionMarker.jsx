import { Plus, Zap } from 'lucide-react';

/** A small clickable marker sitting exactly on the boundary between two
 * adjacent clips - the timeline's only affordance for transitions, since
 * (unlike a clip or overlay) a transition doesn't get its own resizable
 * block: it's a property of the *later* clip (`transition_in`), rendered
 * here as a point, not a span. `Plus` when no transition is set yet (matches
 * the "click to add" icon used elsewhere in this stage), a filled `Zap` once
 * one is - the exact type only shows once you open the inspector, keeping
 * the marker itself tiny. */
export default function TimelineTransitionMarker({ L, hasTransition, isSelected, left, onClick }) {
  return (
    <button
      type="button"
      className={`tl-transition-marker${hasTransition ? ' has-transition' : ''}${isSelected ? ' is-selected' : ''}`}
      style={{ left }}
      title={hasTransition ? L.transition_editTooltip : L.transition_addTooltip}
      onClick={onClick}
    >
      {hasTransition ? <Zap size={10} /> : <Plus size={10} />}
    </button>
  );
}
