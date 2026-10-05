// An assistant answer with its document references linked (useDocRefs). When
// the feature is off or nothing resolves, the answer is returned as the plain
// string it always was.

import type React from 'react';
import { DOC_REF_UI } from './tabs';
import type { DocRefsState } from './useDocRefs';

// Render an assistant message, linking any recognized document references.
// When the feature is off (no matcher) or nothing resolves, the raw string is
// returned untouched, preserving the deliberate plain-text chat rendering — no
// markdown. Segments are plain strings and <a> nodes built by React (never
// innerHTML), so the model's text can't inject markup; the href is a validated
// anchor id from doc-refs.ts.
export function renderAssistantContent(text: string, refs: DocRefsState, lang: string): React.ReactNode {
  const { docRefMatcher, pdfTab, pdfAnchorPages, legalSectionPages, legalDocFiles } = refs;
  if (!docRefMatcher) return text;
  const refUi = DOC_REF_UI[lang] ?? DOC_REF_UI.en;
  const segments = docRefMatcher(text);
  // Nothing resolved at all — return the original string untouched. (A lone
  // legal reference counts as resolved: it is a link too.)
  if (segments.length === 1 && !segments[0].anchor && !segments[0].legalId) return text;
  return segments.map((seg, i) => {
    if (seg.anchor) {
      const anchor = seg.anchor;
      const page = pdfTab && pdfAnchorPages ? pdfAnchorPages[anchor] : undefined;
      // With a mapped page, the PDF is the jump and the text edition is the
      // secondary affordance. Without one — no map, map not loaded yet, or an
      // anchor the map does not carry — this is exactly the old link.
      if (typeof page === 'number' && page > 0) {
        return (
          <span key={i} className="doc-ref-chip">
            <a
              href={`#${anchor}`}
              className="doc-ref-link"
              title={refUi.openPdf}
              onClick={(e) => { e.preventDefault(); refs.openDocRefPdf(page); }}
            >
              {seg.text}
            </a>
            <button
              type="button"
              className="doc-ref-alt"
              title={refUi.openText}
              onClick={() => refs.openDocRef(anchor)}
            >
              {refUi.text}
            </button>
          </span>
        );
      }
      return (
        <a
          key={i}
          href={`#${anchor}`}
          className="doc-ref-link"
          onClick={(e) => { e.preventDefault(); refs.openDocRef(anchor); }}
        >
          {seg.text}
        </a>
      );
    }
    if (seg.legalId) {
      const legalId = seg.legalId;
      // An article citation whose page this document's section map confirms
      // gets the same chip a document-tab citation gets: the reference itself
      // opens the library's PDF view at that page, with the text edition of the
      // document one click away. Everything else — a citation with no article,
      // an article the map does not carry, a document with no map or no PDF, a
      // map still in flight — falls through to the whole-document link that has
      // always been there, so a reference is never a chip that goes nowhere.
      const page = seg.sectionKey ? legalSectionPages[legalId]?.[seg.sectionKey] : undefined;
      if (typeof page === 'number' && page > 0) {
        return (
          <span key={i} className="doc-ref-chip">
            <a
              href="#legal"
              className="doc-ref-link"
              title={refUi.openPdf}
              onClick={(e) => { e.preventDefault(); refs.openLegalRef(legalId, page); }}
            >
              {seg.text}
            </a>
            {/* Only where a text edition exists to open; a PDF-only document
                has nothing behind this button but the page already on screen. */}
            {legalDocFiles.get(legalId)?.textFile && (
              <button
                type="button"
                className="doc-ref-alt"
                title={refUi.openText}
                onClick={() => refs.openLegalRef(legalId)}
              >
                {refUi.text}
              </button>
            )}
          </span>
        );
      }
      return (
        <a
          key={i}
          href="#legal"
          className="doc-ref-link"
          onClick={(e) => { e.preventDefault(); refs.openLegalRef(legalId); }}
        >
          {seg.text}
        </a>
      );
    }
    return seg.text;
  });
}
