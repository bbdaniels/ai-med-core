import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * Close an open popover on an outside pointer press or Escape.
 *
 * One implementation for every popover in the chat UI (the notice bar, the
 * language switcher): the listeners are attached only while `open` is true and
 * are torn down together, so there is no way for one call site to forget the
 * touch listener or the keydown listener the way parallel copies drift into.
 */
export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onDismiss: () => void,
): void {
  // Held in a ref so an inline arrow at the call site does not re-subscribe the
  // listeners on every render.
  const handler = useRef(onDismiss);
  handler.current = onDismiss;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) handler.current();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handler.current(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, open]);
}
