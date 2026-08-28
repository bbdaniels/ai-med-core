/**
 * Keep a message list pinned to its newest entry, without scrolling anything else.
 *
 * The obvious implementation, `sentinel.scrollIntoView()`, is wrong inside an
 * iframe. scrollIntoView does not scroll one element: it scrolls every
 * scrollable ancestor until the target is visible, and an iframe's ancestors
 * include the embedding document. So each reply arriving in the Canvas embed
 * scrolled the course page itself, dragging the reader away from the thing they
 * were reading. Setting scrollTop on the one container that should move has no
 * way to propagate outward.
 *
 * The container is found by walking up from the sentinel rather than being
 * passed in, so the two call sites (the text chat's .conversation-display and
 * the voice panel's .messages-container) share one implementation instead of
 * each growing its own ref and its own copy of this fix.
 */

function scrollParentOf(node: HTMLElement | null): HTMLElement | null {
  let el = node?.parentElement ?? null;
  while (el) {
    const overflowY = getComputedStyle(el).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * Scroll the list containing `sentinel` to the bottom. A no-op when the sentinel
 * is not mounted or nothing above it actually scrolls — which is the correct
 * behaviour for a conversation short enough to fit.
 */
export function scrollListToBottom(sentinel: HTMLElement | null): void {
  const container = scrollParentOf(sentinel);
  if (!container) return;
  container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
}
