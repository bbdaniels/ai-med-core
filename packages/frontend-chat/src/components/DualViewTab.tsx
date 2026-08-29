import type React from 'react';
import { useCallback, useLayoutEffect, useRef } from 'react';
import { findScrollParent } from '../scroll-parent';

/**
 * One tab holding two renderings of the same document, with a segmented control
 * to move between them.
 *
 * A reference document that ships both a PDF and an extracted text has one
 * identity, not two: "the EIP". Giving it two tabs made the reader choose an
 * edition before they had a question, and made a citation land in whichever tab
 * the chip happened to point at. This is the Legal Library's Text/PDF switcher
 * lifted to the tab itself -- deliberately the same control (`legal-doc-view-*`)
 * so the two surfaces read as one tool.
 *
 * The PDF is the default view: it is the document as published, and the text is
 * our extraction of it.
 *
 * Both views live in the tab panel's single scroller, so this component also
 * remembers where the reader was in each one. Without that, flipping from page
 * 40 of the PDF to the text lands at whatever offset happens to be in range --
 * a different place in a different document every time.
 */

export type DualViewKind = 'pdf' | 'document';

interface DualViewTabProps {
  view: DualViewKind;
  onViewChange: (view: DualViewKind) => void;
  labels: { group: string; pdf: string; text: string };
  /** The PDF rendering. Null until the reader has opened that view at least once. */
  pdfView: React.ReactNode;
  /** The text rendering. Null until the reader has opened that view at least once. */
  textView: React.ReactNode;
  /**
   * The nonce of the most recent jump aimed at this tab (a citation clicked in
   * the chat). When it changes in the same commit as the view, the jump owns the
   * scroll and the remembered offset is not restored -- otherwise the reader
   * watches the panel land where they last were and then travel, slowly and
   * smoothly, to the cited passage.
   */
  jumpNonce?: number;
}

export default function DualViewTab({ view, onViewChange, labels, pdfView, textView, jumpNonce }: DualViewTabProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const offsetsRef = useRef<Partial<Record<DualViewKind, number>>>({});
  const prevViewRef = useRef<DualViewKind>(view);
  const prevJumpRef = useRef<number | undefined>(jumpNonce);
  // Mirrors `view` for the scroll listener, which is registered once and would
  // otherwise close over the view that was current when it was attached.
  const viewRef = useRef<DualViewKind>(view);

  const getScroller = useCallback(
    () => scrollerRef.current ?? (scrollerRef.current = findScrollParent(rootRef.current)),
    [],
  );

  // Remember where the reader is in the CURRENT view, continuously.
  //
  // Reading the offset at the moment of the switch is too late, and the reason is
  // worth writing down: React hides the outgoing view in the same commit, the
  // incoming one may not have laid itself out yet, and a scroller whose content
  // has just collapsed to less than its own height has had scrollTop forced to 0
  // by the browser before any effect of ours can read it. Every switch would
  // therefore save 0, and "go back to the PDF" always meant page 1.
  useLayoutEffect(() => {
    const scroller = getScroller();
    if (!scroller) return;
    const record = () => {
      // Skip the two states where scrollTop is 0 for reasons that have nothing to
      // do with the reader: the whole tab hidden (no layout at all), and the
      // transient mid-switch collapse described above.
      if (scroller.clientHeight === 0) return;
      if (scroller.scrollHeight <= scroller.clientHeight + 1) return;
      offsetsRef.current[viewRef.current] = scroller.scrollTop;
    };
    record();
    scroller.addEventListener('scroll', record, { passive: true });
    return () => scroller.removeEventListener('scroll', record);
  }, [getScroller]);

  // Put the reader back where they were in the view they are returning to. A
  // layout effect, so it lands before paint -- and before either panel's own jump
  // effect (a rAF in DocumentPanel, timed re-runs in PdfJsViewer), so a jump that
  // arrives with the switch still has the last word.
  useLayoutEffect(() => {
    const previous = prevViewRef.current;
    const jumped = jumpNonce !== prevJumpRef.current;
    prevJumpRef.current = jumpNonce;
    if (previous === view) return;
    prevViewRef.current = view;
    viewRef.current = view;
    if (jumped) return;
    const scroller = getScroller();
    if (scroller) scroller.scrollTop = offsetsRef.current[view] ?? 0;
  }, [view, jumpNonce, getScroller]);

  return (
    <div className="tab-dual-view" ref={rootRef}>
      <div className="tab-dual-view-switch">
        <div className="legal-doc-view-toggle" role="group" aria-label={labels.group}>
          <button
            type="button"
            className={`legal-doc-view-btn${view === 'pdf' ? ' is-active' : ''}`}
            aria-pressed={view === 'pdf'}
            onClick={() => onViewChange('pdf')}
          >
            {labels.pdf}
          </button>
          <button
            type="button"
            className={`legal-doc-view-btn${view === 'document' ? ' is-active' : ''}`}
            aria-pressed={view === 'document'}
            onClick={() => onViewChange('document')}
          >
            {labels.text}
          </button>
        </div>
      </div>
      {/* Both views stay mounted once opened and are hidden with display:none, so
          scroll offsets, a running search and the PDF's rendered pages all survive
          a flip. Each is rendered only after its first visit, which is what keeps
          pdf.js and a full markdown parse off the path of a reader who never asks
          for that edition. */}
      <div className="tab-dual-view-body" style={{ display: view === 'pdf' ? 'flex' : 'none' }}>
        {pdfView}
      </div>
      <div className="tab-dual-view-body" style={{ display: view === 'document' ? 'flex' : 'none' }}>
        {textView}
      </div>
    </div>
  );
}
