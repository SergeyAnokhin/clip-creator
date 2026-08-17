import { useEffect, useRef } from 'react';
import {
  ClipboardCopy, ClipboardPaste, Copy, Gauge, RotateCcw, Rewind, Scissors,
} from 'lucide-react';
import { nextSpeedPreset } from '../../lib/timeline.js';

/** One row - a plain action, or (`checked` passed) a checkbox-style toggle
 * that shows its own on/off state instead of just firing once. */
function MenuItem({
  icon: Icon, label, checked, disabled, onClick,
}) {
  return (
    <button
      type="button"
      className={`editor-ctxmenu-item${checked ? ' is-active' : ''}`}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={14} />
      <span>{label}</span>
    </button>
  );
}

/** Right-click menu for the program monitor (`EditorPreview.jsx`) - a
 * shortcut to actions that already exist elsewhere (the toolbar, the clip
 * inspector, keyboard shortcuts) for whichever clip sits under the playhead,
 * without making the user go find the timeline block first. `clip` is
 * already the resolved target (see EditorPreview.jsx's own comment on how
 * it's picked - the single selected clip if there is exactly one, else
 * whatever's under the playhead) - this component only renders, it doesn't
 * decide who the target is.
 *
 * `Paste` is the one row not gated on `clip` - `actions.pasteClips` always
 * appends to the *end* of the timeline regardless of where the user right-
 * clicked (see useEditorStage.js), and silently no-ops on an empty
 * clipboard, so there's nothing meaningful to disable it against. */
export default function EditorPreviewContextMenu({
  L, x, y, clip, actions, onClose,
}) {
  const menuRef = useRef(null);

  useEffect(() => {
    function onPointerDown(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose();
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const isDefault = !clip || (
    (clip.trim_start_ms || 0) === 0 && clip.trim_end_ms == null && (clip.speed || 1) === 1 && !clip.reverse
  );

  function run(fn) {
    fn();
    onClose();
  }

  return (
    <div
      ref={menuRef}
      className="editor-ctxmenu"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuItem
        icon={Scissors} label={L.editor_ctxMenuSplit} disabled={!clip}
        onClick={() => run(actions.splitAtPlayhead)}
      />
      <div className="editor-ctxmenu-sep" />
      <MenuItem
        icon={ClipboardCopy} label={L.editor_ctxMenuCopy} disabled={!clip}
        onClick={() => run(() => actions.copyClips([clip.clip_id]))}
      />
      <MenuItem
        icon={ClipboardPaste} label={L.editor_ctxMenuPaste}
        onClick={() => run(actions.pasteClips)}
      />
      <MenuItem
        icon={Copy} label={L.editor_ctxMenuDuplicate} disabled={!clip}
        onClick={() => run(() => actions.duplicateClips([clip.clip_id]))}
      />
      <div className="editor-ctxmenu-sep" />
      <MenuItem
        icon={Gauge} label={`${L.editor_ctxMenuSpeed}: ${clip ? clip.speed || 1 : 1}×`} disabled={!clip}
        onClick={() => run(() => actions.setClipSpeed(clip.clip_id, nextSpeedPreset(clip.speed)))}
      />
      <MenuItem
        icon={Rewind} label={L.editor_ctxMenuReverse} disabled={!clip} checked={!!clip?.reverse}
        onClick={() => run(() => actions.setClipReverse(clip.clip_id, !clip.reverse))}
      />
      <div className="editor-ctxmenu-sep" />
      <MenuItem
        icon={RotateCcw} label={L.editor_ctxMenuReset} disabled={!clip || isDefault}
        onClick={() => run(() => actions.resetClip(clip.clip_id))}
      />
      {!clip && <div className="editor-ctxmenu-hint">{L.editor_ctxMenuNoClip}</div>}
    </div>
  );
}
