// A legal document's section->page map (`content/legal/maps/<id>.json`), and the
// one rule for deciding which of its sections may be offered as a jump.
//
// Two callers need both, and they must agree: the Legal Library panel (which
// lists the sections of the document on screen) and the chat (which decides
// whether a cited "96/2023/NĐ-CP, Điều 40" can become a page jump). Keeping the
// filter in one place is what stops a chip in the chat from claiming a page the
// panel beside it refuses to offer.

/**
 * A section of a legal document and the PDF page it starts on (1-based).
 * `confidence` records how the page was established: "confirmed" means an exact
 * normalized match of the canonical heading text against exactly one page;
 * "structural" means the heading was only detected in the page's own (possibly
 * OCR'd) text, with no canonical text to check it against.
 */
export interface LegalMapSection {
  key: string;
  label: string;
  page: number;
  confidence?: 'confirmed' | 'structural';
}

export interface LegalDocMap {
  docId?: string;
  source?: 'native' | 'ocr';
  sections?: LegalMapSection[];
}

/**
 * Which sections of a map may be jumped to. Where a canonical text is on screen,
 * only pages CONFIRMED by exact match are offered -- a structural guess must
 * never send a reader to a page that the text beside it contradicts. A pdf-only
 * document has nothing to confirm against, so its structural list is all there
 * is, and all it claims to be.
 */
export function jumpableSections(map: LegalDocMap | null | undefined, hasText: boolean): LegalMapSection[] {
  const all = (map?.sections ?? []).filter(
    (s): s is LegalMapSection =>
      !!s && typeof s.key === 'string' && typeof s.page === 'number' && s.page > 0,
  );
  return hasText ? all.filter(s => s.confidence === 'confirmed') : all;
}

/** The same list as a `key -> page` lookup, for resolving a cited section. */
export function sectionPageIndex(map: LegalDocMap | null | undefined, hasText: boolean): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of jumpableSections(map, hasText)) if (!(s.key in out)) out[s.key] = s.page;
  return out;
}
