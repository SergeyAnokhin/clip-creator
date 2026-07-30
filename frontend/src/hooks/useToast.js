import { useEffect, useRef, useState } from 'react';

const TOAST_MS = 2200;

/** Single transient toast message. Every other hook takes `showToast` as a
 * dependency, so this one must be created first in App. */
export function useToast() {
  const [toast, setToast] = useState(null);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  function showToast(message) {
    clearTimeout(timer.current);
    setToast(message);
    timer.current = setTimeout(() => setToast(null), TOAST_MS);
  }

  return { toast, showToast };
}
