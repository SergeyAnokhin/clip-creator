import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { onBackdropClick } from '../../lib/a11y.js';

const GROUPS = [
  {
    titleKey: 'editor_shortcutsGroupPlayback',
    items: [
      { keys: ['Space'], labelKey: 'editor_kbd_playPause' },
      { keys: ['←', '→'], labelKey: 'editor_kbd_navigate' },
      { keys: ['Ctrl', 'Wheel'], labelKey: 'editor_kbd_zoom' },
      { keys: ['Esc'], labelKey: 'editor_kbd_fullscreenExit' },
    ],
  },
  {
    titleKey: 'editor_shortcutsGroupSelection',
    items: [
      { keys: ['Drag'], labelKey: 'editor_kbd_marquee' },
      { keys: ['Shift', 'Click'], labelKey: 'editor_kbd_rangeSelect' },
      { keys: ['Ctrl', 'Click'], labelKey: 'editor_kbd_toggleSelect' },
      { keys: ['Ctrl', 'A'], labelKey: 'editor_kbd_selectAll' },
      { keys: ['S'], labelKey: 'editor_kbd_split' },
      { keys: ['Delete'], labelKey: 'editor_kbd_delete' },
      { keys: ['Ctrl', 'D'], labelKey: 'editor_kbd_duplicate' },
      { keys: ['Ctrl', 'C'], labelKey: 'editor_kbd_copy' },
      { keys: ['Ctrl', 'V'], labelKey: 'editor_kbd_paste' },
      { keys: ['Ctrl', 'Edge drag'], labelKey: 'editor_kbd_ctrlEdge' },
    ],
  },
  {
    titleKey: 'editor_shortcutsGroupHistory',
    items: [
      { keys: ['Ctrl', 'Z'], labelKey: 'editor_kbd_undo' },
      { keys: ['Ctrl', 'Y'], labelKey: 'editor_kbd_redo' },
    ],
  },
  {
    titleKey: 'editor_shortcutsGroupOverlays',
    items: [
      { keys: ['Drag'], labelKey: 'editor_kbd_overlayMove' },
      { keys: ['Edge drag'], labelKey: 'editor_kbd_overlayResize' },
      { keys: ['Delete'], labelKey: 'editor_kbd_overlayDelete' },
    ],
  },
  {
    titleKey: 'editor_shortcutsGroupTransitions',
    items: [
      { keys: ['Click'], labelKey: 'editor_kbd_transitionEdit' },
      { keys: ['Delete'], labelKey: 'editor_kbd_transitionDelete' },
    ],
  },
];

/** Static reference for every keyboard/pointer interaction the Editor stage's
 * timeline (EditorTimeline.jsx) and fullscreen toggle (EditorStage.jsx)
 * actually bind - kept as one small data table here rather than scattered
 * tooltips, so it can't drift from the real bindings without someone noticing
 * this file too. No state beyond open/close, same modal-backdrop/modal-card
 * shell as MurekaTrackDetailModal.jsx and friends. */
export default function KeyboardShortcutsModal({ L, onClose }) {
  return createPortal(
    <div className="modal-backdrop" role="presentation" onClick={onBackdropClick(onClose)}>
      <div className="modal-card">
        <div className="modal-header">
          {L.editor_shortcutsTitle}
          <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        {GROUPS.map((group) => (
          <div key={group.titleKey} className="kbd-group">
            <div className="kbd-group-title">{L[group.titleKey]}</div>
            {group.items.map((item) => (
              <div key={item.labelKey} className="kbd-row">
                <span className="kbd-keys">
                  {item.keys.map((k, i) => (
                    // eslint-disable-next-line react/no-array-index-key -- key chips are a fixed, order-significant tuple, not a list of entities
                    <span key={i} className="kbd-key">{k}</span>
                  ))}
                </span>
                <span className="kbd-label">{L[item.labelKey]}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
