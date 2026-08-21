import { useCallback, useEffect, useRef, useState } from 'react';

const TOAST_MS = 2200;
const MAX_TOASTS = 3;

/** Levels that stay on screen until dismissed - an error the user never got to
 * read is the same as no error at all. */
const STICKY_LEVELS = new Set(['error', 'warning']);

/** Transient toast messages, newest last. Every other hook takes `showToast` as
 * a dependency, so this one must be created first in App.
 *
 * `showToast(message)` keeps the old single-argument call shape working; the
 * optional second argument is the level ('info' | 'success' | 'warning' |
 * 'error'). Sticky levels are only removed by the user. */
export function useToast() {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());
  const nextId = useRef(1);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((t) => clearTimeout(t));
      pending.clear();
    };
  }, []);

  const dismissToast = useCallback((id) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback((message, level = 'info') => {
    if (!message) return;
    const id = nextId.current++;
    setToasts((list) => {
      const next = [...list, { id, message: String(message), level }];
      // Oldest ones fall off the top; drop their timers with them.
      while (next.length > MAX_TOASTS) {
        const dropped = next.shift();
        clearTimeout(timers.current.get(dropped.id));
        timers.current.delete(dropped.id);
      }
      return next;
    });
    if (!STICKY_LEVELS.has(level)) {
      timers.current.set(id, setTimeout(() => {
        timers.current.delete(id);
        setToasts((list) => list.filter((t) => t.id !== id));
      }, TOAST_MS));
    }
  }, []);

  return { toasts, showToast, dismissToast };
}
