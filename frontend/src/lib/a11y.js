/** Keyboard twin of an `onClick` handler, for elements that have to stay a
 * `<div>`/`<span>` instead of becoming a real `<button>` (absolutely
 * positioned overlays, cards that already wrap their own buttons, rows whose
 * layout depends on the tag). Use it together with `role="button"` and
 * `tabIndex={0}` so Enter/Space activate the element exactly like a pointer
 * click - which is what jsx-a11y's `click-events-have-key-events` /
 * `no-static-element-interactions` rules ask for.
 *
 *   <div role="button" tabIndex={0} onClick={open} onKeyDown={onActivateKey(open)}>
 *
 * The `target !== currentTarget` guard matters: `keydown` bubbles, so without
 * it pressing Enter on a nested button would also fire the wrapper's action. */
export function onActivateKey(handler) {
  return (e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    handler(e);
  };
}

/** Callback ref that moves focus onto the node when it mounts - the
 * `autoFocus`-free way to focus the field of an inline editor that just
 * opened (jsx-a11y's `no-autofocus`). Declared once at module scope on
 * purpose: React only re-runs a callback ref when its identity changes, so a
 * stable function focuses on mount and never steals focus back on later
 * re-renders the way an inline `ref={(el) => el?.focus()}` would.
 *
 *   <input ref={focusOnMount} ... />
 */
export function focusOnMount(el) {
  el?.focus();
}

/** `onClick` for a `.modal-backdrop`: closes only when the backdrop itself was
 * the click target, so the `.modal-card` inside no longer needs its own
 * `onClick={(e) => e.stopPropagation()}` (a click handler on a static element,
 * which jsx-a11y flags). Backdrops carry `role="presentation"`: closing by
 * backdrop click is a pointer convenience, and every modal here also has a
 * real close button that keyboard users reach normally. */
export function onBackdropClick(onClose) {
  return (e) => {
    if (e.target === e.currentTarget) onClose();
  };
}
