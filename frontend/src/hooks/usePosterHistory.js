import { useEffect, useRef, useState } from 'react';

/** Undo/redo history depth (oldest snapshots drop off past this) - mirrors
 * useEditorStage.js's MAX_HISTORY. */
const MAX_HISTORY = 50;

/** Rapid edits within this window (a slider/colour/text-field drag that
 * re-fires `commit` on every tick) coalesce into the one snapshot taken
 * before the gesture started, instead of flooding the history with one entry
 * per pixel or keystroke. */
const COALESCE_MS = 400;

/** Undo/redo for the Poster constructor's document, split out of
 * `PosterConstructor.jsx`: it owns the `past`/`future` stacks and the
 * Ctrl/Cmd+Z / Ctrl/Cmd+Y binding, and knows nothing about what a document
 * contains - the caller supplies `currentDoc` (snapshot the editable state)
 * and `applyDoc` (write a snapshot back). `onRestore` runs after an
 * undo/redo for whatever isn't part of the document but can't survive one
 * (the current selection, an open crop editor).
 *
 * `commit` is the single choke point every document mutation runs through:
 * it snapshots the pre-mutation document into `past` (clearing `future`,
 * since a fresh edit invalidates any redo branch) before applying `mutate`. */
export function usePosterHistory({ currentDoc, applyDoc, onRestore }) {
  const [past, setPast] = useState([]);
  const [future, setFuture] = useState([]);
  const lastCommitAt = useRef(0);

  function commit(mutate) {
    const now = Date.now();
    if (now - lastCommitAt.current > COALESCE_MS) {
      setPast((p) => [...p, currentDoc()].slice(-MAX_HISTORY));
      setFuture([]);
    }
    lastCommitAt.current = now;
    mutate();
  }

  function undo() {
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    setFuture((f) => [currentDoc(), ...f]);
    setPast((p) => p.slice(0, -1));
    applyDoc(prev);
    lastCommitAt.current = 0;
    onRestore();
  }

  function redo() {
    if (future.length === 0) return;
    const next = future[0];
    setPast((p) => [...p, currentDoc()]);
    setFuture((f) => f.slice(1));
    applyDoc(next);
    lastCommitAt.current = 0;
    onRestore();
  }

  useEffect(() => {
    function onKeyDown(e) {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        redo();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // undo/redo intentionally omitted: they're recreated every render but only
    // *do* anything different once past/future change, so resubscribing on
    // those two (rather than every render - e.g. every drag-guide update) is
    // the actual intent, not an oversight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [past, future]);

  return { commit, undo, redo, canUndo: past.length > 0, canRedo: future.length > 0 };
}
