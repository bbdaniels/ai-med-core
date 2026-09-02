/**
 * One spelling of "back to top" for the two reader surfaces that offer it.
 *
 * The Text edition (`DocumentPanel`) and the PDF edition (`PdfJsViewer`) are two
 * views of the same tab, so the control has to appear at the same point, look the
 * same and read the same in both. When the threshold and the icon lived as
 * literals in both files they were kept in step only by a comment asking the next
 * editor to keep them in step, which is not a mechanism. They live here now, so
 * the two editions cannot drift.
 */
import { useEffect } from 'react';

/**
 * How far the reader must scroll before back-to-top becomes available -- roughly
 * a screenful, so the control stays out of the way near the top of a document.
 */
export const BACK_TO_TOP_THRESHOLD = 320;

/** The up-arrow drawn in both editions' find bars. */
export function BackToTopIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 3.5v9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M4 7l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Watch `scroller` and report whether the reader is far enough down for
 * back-to-top to be worth offering.
 *
 * Sampling is rAF-coalesced, so a fling costs one measurement per frame rather
 * than one per scroll event, and it samples once on attach in case the reader is
 * already scrolled down when the effect runs.
 *
 * Two hooks exist for the PDF edition's extra needs, and neither changes what the
 * Text edition does. `shouldSample` lets a caller skip a sample entirely: inside a
 * merged tab both editions share one scroller, so the hidden one still receives
 * the events and must not claim the offset as its reader's. `onSample` hands the
 * caller the offset that was just measured, which is how that edition remembers
 * where the reader was the last time it was on screen.
 *
 * `deps` re-attaches the listener -- pass whatever changes the scroller or the
 * content under it (a language switch, a scale change, a load completing).
 */
export function useScrolledPastThreshold(
  getScroller: () => HTMLElement | null,
  setPast: (past: boolean) => void,
  deps: unknown[],
  options?: { shouldSample?: () => boolean; onSample?: (scrollTop: number) => void },
): void {
  const shouldSample = options?.shouldSample;
  const onSample = options?.onSample;
  useEffect(() => {
    const scroller = getScroller();
    if (!scroller) return;
    let frame = 0;
    const sample = () => {
      frame = 0;
      if (shouldSample && !shouldSample()) return;
      const top = scroller.scrollTop;
      onSample?.(top);
      setPast(top > BACK_TO_TOP_THRESHOLD);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(sample); };
    sample(); // sync now in case the reader is already scrolled down
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
