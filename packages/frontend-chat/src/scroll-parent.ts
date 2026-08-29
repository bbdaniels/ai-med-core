/**
 * One spelling of "which element actually scrolls this panel", shared by every
 * reader surface in the right-hand pane.
 *
 * None of these panels scroll themselves: the document, the PDF viewer and the
 * merged dual-view tab all sit inside the tab panel (`.tab-panel`,
 * `overflow-y: auto`), which is what scrolls and what a `position: sticky`
 * header sticks to. Three components needed that element and each had grown its
 * own copy of the walk; this is the one implementation they now share, so a
 * change to the surrounding markup can only break it in one place.
 */

/**
 * Walk up from `el` to the nearest ancestor that scrolls.
 *
 * `requireOverflow` is the one real difference between the two historical
 * copies, and it is deliberate. A find bar that only needs to know where to
 * scroll to wants the nearest declared scroller whether or not it currently
 * overflows (the content may be about to grow). A viewer that uses the result as
 * an IntersectionObserver root wants the element that is genuinely scrolling
 * right now -- an `overflow: auto` box that fits its content is not clipping
 * anything, and using it as a root would report every page as visible.
 */
export function findScrollParent(
  el: HTMLElement | null,
  options?: { requireOverflow?: boolean },
): HTMLElement | null {
  const requireOverflow = options?.requireOverflow ?? false;
  let node = el?.parentElement ?? null;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') {
      if (!requireOverflow || node.scrollHeight > node.clientHeight) return node;
    }
    node = node.parentElement;
  }
  return null;
}
