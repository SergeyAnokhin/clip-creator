import { useState } from 'react';
import { ChevronDown, ChevronRight, SlidersHorizontal } from 'lucide-react';
import { onActivateKey } from '../../lib/a11y.js';

/** Collapsible "everything else" strip for a generating stage.
 *
 * The generating stages each grew three to six always-open rows of controls
 * above their first result - aspect ratio, reference uploads, wish lists,
 * display toggles - all of which are set once and then left alone. Only the
 * handful of settings that change per run stay in the row above this; the rest
 * moves in here. Open/closed is remembered per stage in `localStorage`, so a
 * user who does want them open keeps them open. */
export default function StageMoreOptions({ L, storageKey, children }) {
  const lsKey = `versecraft.stageOptions.${storageKey}`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(lsKey) === '1';
    } catch {
      return false;
    }
  });

  function toggle() {
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(lsKey, next ? '1' : '0');
      } catch {
        // A view preference is not worth failing over.
      }
      return next;
    });
  }

  return (
    <div style={{ marginBottom: 18 }}>
      <div
        className="stage-more-toggle"
        role="button" tabIndex={0} aria-expanded={open}
        onClick={toggle}
        onKeyDown={onActivateKey(toggle)}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <SlidersHorizontal size={13} />
        {L.stageOptions_more}
      </div>
      {open && <div style={{ marginTop: 12 }}>{children}</div>}
    </div>
  );
}
