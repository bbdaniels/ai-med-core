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

/**
 * Bring `el` into view by scrolling `scroller` -- and ONLY `scroller`.
 *
 * `el.scrollIntoView()` is the obvious call and the wrong one here, for the
 * reason already written up in `scroll-list.ts`: it does not scroll one element,
 * it scrolls every scrollable ancestor, the window included. This app's layout
 * fills the viewport exactly, so for a long time the window had nothing to
 * scroll and the difference never showed. pdf.js then broke that assumption --
 * it appends a hidden measuring `<canvas class="hiddenCanvasElement">` to
 * `<body>`, which without pdf.js's own stylesheet keeps a canvas's intrinsic
 * 300x150 box and makes the document ~150px taller than the viewport. From the
 * first PDF render on, every `scrollIntoView` in the right-hand pane also
 * dragged the WINDOW down ~48px, taking the tab bar off screen with it. The
 * stylesheet now carries pdf.js's rule so that document never grows; asking only
 * the scroller to move is the other half, and the half that holds even if some
 * future dependency does the same thing again.
 *
 * `headroom` is the unusable strip at the top of the scrollport -- a sticky
 * header, plus whatever it sticks below. It defaults to the target's own
 * `scroll-margin-top`, which is exactly what `scrollIntoView` would have
 * honoured, so CSS stays the single place that offset is declared. Callers whose
 * targets carry no scroll-margin (a PDF page canvas) pass a measured value
 * instead. `offset` is an extra distance INTO the target -- the y of a line
 * within a page.
 */
export function scrollElementIntoScroller(
  el: HTMLElement,
  scroller: HTMLElement,
  options?: {
    block?: 'start' | 'center';
    headroom?: number;
    offset?: number;
    behavior?: ScrollBehavior;
  },
): void {
  const block = options?.block ?? 'start';
  const offset = options?.offset ?? 0;
  const behavior = options?.behavior ?? 'smooth';

  const style = getComputedStyle(el);
  const marginTop = parseFloat(style.scrollMarginTop) || 0;
  const marginBottom = parseFloat(style.scrollMarginBottom) || 0;
  const headroom = options?.headroom ?? marginTop;

  // Where the target sits inside the scroller's content, in the scroller's own
  // scroll coordinates. Both rects are viewport-relative, so their difference is
  // independent of how far either has already been scrolled.
  const delta = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  const top =
    block === 'center'
      ? // Same landing as scrollIntoView's `block: 'center'`: the centre of the
        // target's scroll-margin box aligned with the centre of the scrollport.
        scroller.scrollTop + delta + offset - marginTop +
        (el.offsetHeight + marginTop + marginBottom) / 2 -
        scroller.clientHeight / 2
      : scroller.scrollTop + delta + offset - headroom;

  // scrollTo clamps to the scrollable range on its own, so a target near either
  // end needs no special case.
  scroller.scrollTo({ top, behavior });
}
