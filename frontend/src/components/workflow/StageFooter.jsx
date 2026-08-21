import { useEffect } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { STAGE_KEYS, stageName, stageProgress } from '../../lib/stageStatus.js';

/** "Where am I / what is next" strip at the bottom of every stage except the
 * Editor (whose layout is a fixed-height NLE, not a scrolling page).
 *
 * Before this the only way forward was finding the right row in a sidebar that
 * collapses to zero width, with no step count and no notion of a next step -
 * so a nine-stage pipeline had no visible route through it. The next button is
 * never disabled: it says what the next stage still needs and lets the user go
 * look anyway. */
export default function StageFooter({ L, project, activeStage, onSelectStage }) {
  const index = STAGE_KEYS.indexOf(activeStage);
  const prev = index > 0 ? STAGE_KEYS[index - 1] : null;
  const next = index >= 0 && index < STAGE_KEYS.length - 1 ? STAGE_KEYS[index + 1] : null;
  const nextProgress = next ? stageProgress(next, project) : null;

  useEffect(() => {
    function onKeyDown(e) {
      if (!e.ctrlKey && !e.metaKey) return;
      if (e.altKey || e.shiftKey) return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
      if (e.key === 'ArrowRight' && next) { e.preventDefault(); onSelectStage(next); }
      if (e.key === 'ArrowLeft' && prev) { e.preventDefault(); onSelectStage(prev); }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [next, prev, onSelectStage]);

  if (index < 0) return null;

  return (
    <div className="stage-footer">
      {prev ? (
        <button className="btn btn-ghost" onClick={() => onSelectStage(prev)} title="Ctrl+←">
          <ArrowLeft size={14} />
          {stageName(L, prev)}
        </button>
      ) : <span />}
      <span className="stage-footer-step">
        {L.stageNav_step} {index + 1} {L.stageNav_of} {STAGE_KEYS.length}
      </span>
      <div style={{ flex: 1 }} />
      {nextProgress?.status === 'blocked' && (
        <span className="stage-footer-needs">
          {/* Usually the next stage is waiting on the one you are standing in,
              in which case naming it back at the user reads as a riddle. */}
          {nextProgress.blockedBy === activeStage
            ? L.stageNav_finishThis
            : `${L.stageNav_needs} ${stageName(L, nextProgress.blockedBy)}`}
        </span>
      )}
      {next && (
        <button className="btn btn-accent-soft" onClick={() => onSelectStage(next)} title="Ctrl+→">
          {stageName(L, next)}
          <ArrowRight size={14} />
        </button>
      )}
    </div>
  );
}
