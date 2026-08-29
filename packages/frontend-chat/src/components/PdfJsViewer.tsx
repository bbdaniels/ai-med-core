import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
// Vite resolves ?url to the emitted asset path (respecting VITE_BASE_PATH), so the
// worker is served same-origin from our own bundle — no CDN, CSP-safe.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { foldQuery, foldWithMap } from '../text-search';
import { findScrollParent, scrollElementIntoScroller } from '../scroll-parent';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

interface PdfJsViewerProps {
  src: string;
  title?: string;
  openLabel?: string;
  // ISO 639-1 code for the find bar and status labels. Defaults to English.
  lang?: string;
  // An imperative jump requested from outside: scroll to a 1-based page. Bump
  // `nonce` to re-trigger for the same page. Handled through the very same
  // goToDest path an in-document TOC link takes, so there is one implementation
  // of "move the viewport to page N" rather than two that can drift apart.
  jumpTarget?: { page: number; nonce: number } | null;
}

const FIND_UI: Record<string, {
  placeholder: string; prev: string; next: string; clear: string;
  noMatch: string; reading: string; noText: string;
  loading: string; failed: string; openNewTab: string;
}> = {
  en: {
    placeholder: 'Search this PDF',
    prev: 'Previous match',
    next: 'Next match',
    clear: 'Clear search',
    noMatch: 'no matches',
    reading: 'Reading the document…',
    noText: 'This scanned document has no searchable text.',
    loading: 'Loading document…',
    failed: 'Could not display the PDF here.',
    openNewTab: 'Open it in a new tab ↗',
  },
  vi: {
    placeholder: 'Tìm trong tệp PDF',
    prev: 'Kết quả trước',
    next: 'Kết quả tiếp theo',
    clear: 'Xóa tìm kiếm',
    noMatch: 'không có kết quả',
    reading: 'Đang đọc tài liệu…',
    noText: 'Tài liệu quét này không có chữ để tìm kiếm.',
    loading: 'Đang tải tài liệu…',
    failed: 'Không hiển thị được tệp PDF ở đây.',
    openNewTab: 'Mở trong tab mới ↗',
  },
};

// A search that matches thousands of places is useless to cycle through and
// expensive to paint, so the scan stops once it has found more than a reader
// could plausibly step through.
const MAX_MATCHES = 1000;

// The scrolling ancestor is the tab panel (overflow-y:auto), not the window — the
// same container DocumentPanel scrolls, and `findScrollParent` is shared with it.
// `requireOverflow` matters here and only here: the result is an
// IntersectionObserver root, so it must be the element that is actually
// clipping, not merely one declared `overflow: auto` while it still fits.

// Where an internal GoTo link lands: a page, and (when the destination carries one)
// a vertical position in that page's user space.
interface DestTarget { pageNumber: number; y: number | null }

interface LinkBox {
  left: number; top: number; width: number; height: number;
  url?: string;
  dest?: DestTarget;
}

// ---------------------------------------------------------------------------
// Find: the searchable index of a page, and matches against it
// ---------------------------------------------------------------------------

/**
 * One page's text, in the two forms the find bar needs: the raw characters (what
 * gets painted, and what the text layer's spans actually contain) and the folded
 * comparison form (what a query is matched against), plus the bookkeeping that
 * turns an offset in one into an offset in the other.
 *
 * `itemStrings` is deliberately built the same way pdf.js's own TextLayer builds
 * `textContentItemsStr` — every item that carries a `str`, in order — so index i
 * here is the same text item as `textDivs[i]` on screen. That correspondence is
 * what lets a match found in this index be highlighted on the rendered page.
 */
interface PageTextIndex {
  itemStrings: string[];
  itemStarts: number[];   // each item's offset into the page's concatenated text
  itemEnds: number[];
  // Each item's TOP edge in PDF user space (baseline plus glyph height), which is
  // the point a scroll should land on: aiming at the baseline puts the glyphs
  // themselves above the target, and on this viewer that means behind the sticky
  // header.
  itemTop: number[];
  folded: string;
  map: Int32Array;
}

interface MatchRange { item: number; from: number; to: number }
interface Match { page: number; y: number | null; ranges: MatchRange[] }

async function buildPageIndex(
  pdf: pdfjsLib.PDFDocumentProxy,
  pageNumber: number,
): Promise<PageTextIndex> {
  const page = await pdf.getPage(pageNumber);
  const tc = await page.getTextContent();
  const itemStrings: string[] = [];
  const itemStarts: number[] = [];
  const itemEnds: number[] = [];
  const itemTop: number[] = [];
  let raw = '';
  for (const entry of tc.items as Array<{ str?: string; transform?: number[]; height?: number; hasEOL?: boolean }>) {
    if (typeof entry.str !== 'string') continue; // marked-content markers carry no text
    itemStarts.push(raw.length);
    itemStrings.push(entry.str);
    itemEnds.push(raw.length + entry.str.length);
    const baseline = Array.isArray(entry.transform) ? entry.transform[5] : 0;
    itemTop.push(baseline + (typeof entry.height === 'number' ? entry.height : 0));
    raw += entry.str;
    // A line break is a word boundary for search purposes; folding collapses it
    // to a single space, so a phrase split across two lines still matches.
    if (entry.hasEOL) raw += '\n';
  }
  const { folded, map } = foldWithMap(raw);
  return { itemStrings, itemStarts, itemEnds, itemTop, folded, map };
}

/** The text item containing a given offset — the first whose end is past it. */
function itemAt(idx: PageTextIndex, offset: number): number {
  let lo = 0;
  let hi = idx.itemEnds.length - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (idx.itemEnds[mid] > offset) { hit = mid; hi = mid - 1; } else { lo = mid + 1; }
  }
  return hit;
}

/** Split a match's raw span into per-item ranges — a phrase can cross items. */
function rangesFor(idx: PageTextIndex, rawStart: number, rawEnd: number): MatchRange[] {
  const out: MatchRange[] = [];
  let i = itemAt(idx, rawStart);
  if (i < 0) return out;
  for (; i < idx.itemStrings.length; i++) {
    const start = idx.itemStarts[i];
    if (start >= rawEnd) break;
    const from = Math.max(rawStart, start) - start;
    const to = Math.min(rawEnd, idx.itemEnds[i]) - start;
    if (to > from) out.push({ item: i, from, to });
    if (idx.itemEnds[i] >= rawEnd) break;
  }
  return out;
}

function findMatches(index: PageTextIndex[], folded: string): Match[] {
  const list: Match[] = [];
  if (!folded) return list;
  for (let p = 0; p < index.length; p++) {
    const idx = index[p];
    if (!idx || !idx.folded) continue;
    let at = idx.folded.indexOf(folded);
    while (at !== -1) {
      const rawStart = idx.map[at];
      const rawEnd = idx.map[at + folded.length - 1] + 1;
      const ranges = rangesFor(idx, rawStart, rawEnd);
      list.push({ page: p + 1, y: ranges.length ? idx.itemTop[ranges[0].item] : null, ranges });
      if (list.length >= MAX_MATCHES) return list;
      at = idx.folded.indexOf(folded, at + folded.length);
    }
  }
  return list;
}

interface PageMatch { globalIndex: number; ranges: MatchRange[] }
const NO_MATCHES: PageMatch[] = [];

// One page: a fixed-aspect placeholder until it nears the viewport, then a rendered
// canvas, a selectable text layer, and a link overlay. External links are real
// <a target="_blank"> elements — this is the whole point of bundling pdf.js: full
// control over link targets, which the browser's built-in PDF viewer never gives an
// embedder. Internal links become buttons that drive the viewer's own scroll.
function PdfPage({ pdf, pageNumber, scale, root, registerPage, resolveDest, onNavigate, pageMatches, activeMatch }: {
  pdf: pdfjsLib.PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  root: HTMLElement | null;
  registerPage: (pageNumber: number, el: HTMLDivElement | null) => void;
  resolveDest: (dest: unknown) => Promise<DestTarget | null>;
  onNavigate: (target: DestTarget) => void;
  pageMatches: PageMatch[];
  activeMatch: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [visible, setVisible] = useState(false);
  const [links, setLinks] = useState<LinkBox[]>([]);
  const renderedForRef = useRef<string>('');
  // The rendered text layer's spans and their original strings, so a search hit
  // can be painted onto the very same DOM the reader selects and copies from.
  const textDivsRef = useRef<HTMLElement[]>([]);
  const itemStringsRef = useRef<string[]>([]);
  const paintedRef = useRef<Set<number>>(new Set());
  const [layerVersion, setLayerVersion] = useState(0);

  // Let the viewer address this page by number so a link can scroll to it.
  useEffect(() => {
    registerPage(pageNumber, wrapRef.current);
    return () => registerPage(pageNumber, null);
  }, [registerPage, pageNumber]);

  // Page dimensions (for the placeholder height) — cheap metadata, fetched once.
  useEffect(() => {
    let cancelled = false;
    pdf.getPage(pageNumber).then((page) => {
      if (cancelled) return;
      const vp = page.getViewport({ scale: 1 });
      setDims({ w: vp.width, h: vp.height });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [pdf, pageNumber]);

  // Render only while near the viewport; free the canvas when far so a long
  // document does not hold every page's bitmap in memory at once.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => setVisible(entries[0].isIntersecting),
      { root: root ?? null, rootMargin: '800px 0px' }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [root]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!visible || !canvas) {
      // Left the render window — drop the bitmap and the text spans to reclaim memory.
      if (!visible && canvas) {
        canvas.width = 0; canvas.height = 0;
        renderedForRef.current = '';
        setLinks([]);
        if (textLayerRef.current) textLayerRef.current.textContent = '';
        textDivsRef.current = [];
        itemStringsRef.current = [];
        paintedRef.current.clear();
      }
      return;
    }
    const key = `${pageNumber}@${scale}`;
    if (renderedForRef.current === key) return;

    let cancelled = false;
    let task: pdfjsLib.RenderTask | null = null;
    let textLayer: pdfjsLib.TextLayer | null = null;
    pdf.getPage(pageNumber).then((page) => {
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      task = page.render({
        canvasContext: ctx,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      task.promise.then(async () => {
        if (cancelled) return;
        renderedForRef.current = key;

        // The text layer: pdf.js's own transparent spans, positioned over the
        // canvas glyphs. It is what makes the text selectable and copyable —
        // a canvas alone is a picture — and it is also where search hits are
        // painted, so there is one text surface rather than two. A page with no
        // extractable text (a scan that was never given a text layer) simply
        // yields no spans, and everything else behaves as before.
        const layerEl = textLayerRef.current;
        if (layerEl) {
          layerEl.textContent = '';
          textDivsRef.current = [];
          itemStringsRef.current = [];
          paintedRef.current.clear();
          try {
            const textContent = await page.getTextContent();
            if (cancelled) return;
            textLayer = new pdfjsLib.TextLayer({ textContentSource: textContent, container: layerEl, viewport });
            await textLayer.render();
            if (cancelled) return;
            textDivsRef.current = textLayer.textDivs;
            itemStringsRef.current = textLayer.textContentItemsStr;
            setLayerVersion((v) => v + 1);
          } catch {
            // No text layer is a degraded reading experience, never a broken page.
          }
        }

        // Build the link overlay from the page's link annotations.
        const annots = await page.getAnnotations();
        const boxes: LinkBox[] = [];
        for (const a of annots) {
          if (a.subtype !== 'Link' || !a.rect) continue;
          // External URL links become anchors; internal goto-links (the document's own
          // table of contents, the per-page mark) are resolved to a page here so a dead
          // destination — one the file references but never defines — leaves no hit-target.
          let dest: DestTarget | undefined;
          if (!a.url) {
            if (a.dest == null) continue;
            const resolved = await resolveDest(a.dest);
            if (!resolved) continue;
            dest = resolved;
          }
          const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(a.rect);
          boxes.push({
            left: Math.min(x1, x2),
            top: Math.min(y1, y2),
            width: Math.abs(x2 - x1),
            height: Math.abs(y2 - y1),
            url: a.url || undefined,
            dest,
          });
        }
        if (!cancelled) setLinks(boxes);
      }).catch(() => { /* render cancelled */ });
    }).catch(() => {});

    return () => { cancelled = true; task?.cancel(); textLayer?.cancel(); };
  }, [visible, pdf, pageNumber, scale, resolveDest]);

  // Paint the current search hits onto this page's text spans. Runs whenever the
  // hits change or the text layer is rebuilt (a zoom), and restores every span it
  // previously touched first, so clearing the query clears the highlights.
  useEffect(() => {
    const divs = textDivsRef.current;
    const strings = itemStringsRef.current;
    if (!divs.length) return;
    for (const i of paintedRef.current) {
      const div = divs[i];
      if (div) div.textContent = strings[i] ?? '';
    }
    paintedRef.current.clear();
    if (!pageMatches.length) return;

    const byItem = new Map<number, { from: number; to: number; active: boolean }[]>();
    for (const m of pageMatches) {
      for (const r of m.ranges) {
        if (r.item < 0 || r.item >= divs.length) continue;
        const segs = byItem.get(r.item) ?? [];
        segs.push({ from: r.from, to: r.to, active: m.globalIndex === activeMatch });
        byItem.set(r.item, segs);
      }
    }
    for (const [i, segs] of byItem) {
      const div = divs[i];
      const raw = strings[i];
      if (!div || typeof raw !== 'string') continue;
      segs.sort((a, b) => a.from - b.from);
      const frag = document.createDocumentFragment();
      let cursor = 0;
      for (const seg of segs) {
        const from = Math.max(cursor, Math.min(seg.from, raw.length));
        const to = Math.max(from, Math.min(seg.to, raw.length));
        if (to <= from) continue;
        if (from > cursor) frag.appendChild(document.createTextNode(raw.slice(cursor, from)));
        const hit = document.createElement('span');
        hit.className = seg.active ? 'pdfjs-find-hit is-active' : 'pdfjs-find-hit';
        hit.textContent = raw.slice(from, to);
        frag.appendChild(hit);
        cursor = to;
      }
      if (cursor < raw.length) frag.appendChild(document.createTextNode(raw.slice(cursor)));
      div.textContent = '';
      div.appendChild(frag);
      paintedRef.current.add(i);
    }
  }, [pageMatches, activeMatch, layerVersion]);

  // Placeholder keeps layout stable (and scrollbar honest) before the canvas exists.
  const ph = dims ? { width: dims.w * scale, height: dims.h * scale } : { width: '100%', height: 700 };
  // pdf.js positions text spans with calc(var(--scale-factor) * …), so the page
  // wrapper carries the current scale and the spans track zoom and resize for free.
  const pageStyle = { width: ph.width, height: ph.height, '--scale-factor': String(scale) } as CSSProperties;

  return (
    <div ref={wrapRef} className="pdfjs-page" style={pageStyle}>
      <canvas ref={canvasRef} className="pdfjs-page-canvas" />
      <div ref={textLayerRef} className="pdfjs-text-layer" />
      <div className="pdfjs-link-layer">
        {links.map((l, i) => (
          l.url ? (
            <a
              key={i}
              href={l.url}
              target="_blank"
              rel="noopener noreferrer"
              className="pdfjs-link"
              style={{ left: l.left, top: l.top, width: l.width, height: l.height }}
              aria-label={l.url}
            />
          ) : (
            <button
              key={i}
              type="button"
              className="pdfjs-link"
              style={{ left: l.left, top: l.top, width: l.width, height: l.height }}
              onClick={() => l.dest && onNavigate(l.dest)}
              aria-label={`Go to page ${l.dest?.pageNumber}`}
            />
          )
        ))}
      </div>
    </div>
  );
}

export default function PdfJsViewer({ src, title, openLabel, lang, jumpTarget }: PdfJsViewerProps) {
  const t = FIND_UI[lang || 'en'] ?? FIND_UI.en;
  const rootRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [scale, setScale] = useState(1);
  const [zoom, setZoom] = useState(1); // user zoom multiplier on top of fit-width
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);
  const baseWidthRef = useRef<number>(0);
  const pageElsRef = useRef(new Map<number, HTMLDivElement>());
  const destCacheRef = useRef(new Map<string, DestTarget | null>());

  // Find state. The index is built once per document (never per keystroke) and
  // discarded when the document changes.
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [wantIndex, setWantIndex] = useState(false);
  const [index, setIndex] = useState<PageTextIndex[] | null>(null);
  const [indexState, setIndexState] = useState<'idle' | 'building' | 'ready'>('idle');
  const [activeMatch, setActiveMatch] = useState(0);
  const indexStartedForRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);

  const registerPage = useCallback((pageNumber: number, el: HTMLDivElement | null) => {
    if (el) pageElsRef.current.set(pageNumber, el);
    else pageElsRef.current.delete(pageNumber);
  }, []);

  // A link's destination is either a named one (looked up in the document's name tree)
  // or an explicit array. Either way it resolves to a page reference plus, for the
  // position-carrying destination types, a y coordinate in that page's user space.
  const resolveDest = useCallback(async (dest: unknown): Promise<DestTarget | null> => {
    if (!pdf || dest == null) return null;
    const key = typeof dest === 'string' ? dest : null;
    if (key !== null && destCacheRef.current.has(key)) return destCacheRef.current.get(key) ?? null;

    let target: DestTarget | null = null;
    try {
      const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
      if (Array.isArray(explicit) && explicit.length) {
        const ref = explicit[0];
        const pageIndex = typeof ref === 'number'
          ? ref
          : await pdf.getPageIndex(ref as { num: number; gen: number });
        const kind = (explicit[1] as { name?: string } | undefined)?.name;
        const y = kind === 'XYZ' ? explicit[3]
          : (kind === 'FitH' || kind === 'FitBH') ? explicit[2]
          : null;
        target = { pageNumber: pageIndex + 1, y: typeof y === 'number' ? y : null };
      }
    } catch {
      // A destination the document references but never defines — treat as no target.
      target = null;
    }
    if (key !== null) destCacheRef.current.set(key, target);
    return target;
  }, [pdf]);

  // Scroll the tab panel so the destination's page (and, where known, the exact line
  // within it) comes into view, clearing the sticky toolbar and find bar — landing a
  // target underneath them is the same as not landing on it. Falls back to
  // scrollIntoView if the scroll ancestor could not be resolved.
  const goToDest = useCallback(async (target: DestTarget) => {
    const el = pageElsRef.current.get(target.pageNumber);
    if (!el) return;
    let offset = 0;
    if (pdf && target.y != null) {
      try {
        const page = await pdf.getPage(target.pageNumber);
        offset = page.getViewport({ scale }).convertToViewportPoint(0, target.y)[1];
      } catch { /* keep the page top */ }
    }
    if (!scrollParent) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    // Unusable space at the top of the scrollport: our own sticky header, plus
    // whatever it sticks BELOW. Reading the header's computed `top` rather than
    // assuming zero is what keeps a jump landing correctly when this viewer is
    // one of two editions under a merged tab's switcher — the switcher owns the
    // first 2.6rem there, and a jump that ignored it would land behind it. A page
    // canvas carries no `scroll-margin-top` to read it off, unlike a heading in
    // the text edition, so it is measured and passed in.
    const head = headRef.current;
    const stickyTop = head ? parseFloat(getComputedStyle(head).top) || 0 : 0;
    const headroom = (head?.offsetHeight ?? 0) + stickyTop + 8;
    scrollElementIntoScroller(el, scrollParent, { block: 'start', headroom, offset });
  }, [pdf, scale, scrollParent]);

  // An outside jump must survive the document still loading and the page
  // placeholders still being estimated 700px tall, so it is re-run once the
  // real page heights have landed. Held in a ref so a scale change (which
  // rebuilds goToDest) cannot cancel a jump that is still settling.
  const goToDestRef = useRef(goToDest);
  goToDestRef.current = goToDest;
  const jumpNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!jumpTarget || status !== 'ready' || numPages === 0) return;
    if (jumpNonceRef.current === jumpTarget.nonce) return;
    jumpNonceRef.current = jumpTarget.nonce;
    const page = Math.min(Math.max(1, Math.round(jumpTarget.page)), numPages);
    let cancelled = false;
    const run = () => { if (!cancelled) void goToDestRef.current({ pageNumber: page, y: null }); };
    run();
    const t1 = setTimeout(run, 300);
    const t2 = setTimeout(run, 900);
    return () => { cancelled = true; clearTimeout(t1); clearTimeout(t2); };
  }, [jumpTarget, status, numPages]);

  // Load the document.
  useEffect(() => {
    let cancelled = false;
    setStatus('loading'); setPdf(null); setNumPages(0);
    destCacheRef.current.clear();
    // A different document invalidates everything the find bar knows.
    setQuery(''); setDebouncedQuery(''); setIndex(null); setIndexState('idle');
    setWantIndex(false); setActiveMatch(0); indexStartedForRef.current = null;
    const task = pdfjsLib.getDocument({ url: src });
    task.promise
      .then((doc) => { if (!cancelled) { setPdf(doc); setNumPages(doc.numPages); setStatus('ready'); } })
      .catch(() => { if (!cancelled) setStatus('error'); });
    return () => { cancelled = true; task.destroy(); };
  }, [src]);

  // Resolve the scroll parent once mounted (for the pages' lazy-render observers).
  useEffect(() => {
    setScrollParent(findScrollParent(rootRef.current, { requireOverflow: true }));
  }, [status]);

  // Typing settles before anything is searched.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 180);
    return () => clearTimeout(timer);
  }, [query]);

  // Reading every page's text costs a pass over the whole document, so it is not
  // paid by readers who never search: the first touch of the find bar asks for it,
  // and the result is kept for as long as this document is open.
  //
  // The "already started" guard is a ref, not `indexState`. As state it would be an
  // effect dependency, so setting it to 'building' would re-run the effect, whose
  // cleanup would cancel the very pass it had just started — the index would never
  // arrive and the bar would sit on "Reading the document…" forever.
  useEffect(() => {
    if (!wantIndex || !pdf || status !== 'ready') return;
    if (indexStartedForRef.current === pdf) return;
    indexStartedForRef.current = pdf;
    let cancelled = false;
    setIndexState('building');
    (async () => {
      const pages: PageTextIndex[] = [];
      for (let p = 1; p <= pdf.numPages; p++) {
        if (cancelled) return;
        try {
          pages.push(await buildPageIndex(pdf, p));
        } catch {
          // A page that will not yield text is an empty page for search purposes.
          pages.push({ itemStrings: [], itemStarts: [], itemEnds: [], itemTop: [], folded: '', map: new Int32Array(0) });
        }
      }
      if (!cancelled) { setIndex(pages); setIndexState('ready'); }
    })();
    return () => { cancelled = true; };
  }, [wantIndex, pdf, status]);

  const foldedQuery = useMemo(() => foldQuery(debouncedQuery), [debouncedQuery]);
  const matches = useMemo(
    () => (index ? findMatches(index, foldedQuery) : []),
    [index, foldedQuery],
  );
  const matchesByPage = useMemo(() => {
    const byPage = new Map<number, PageMatch[]>();
    matches.forEach((m, i) => {
      const list = byPage.get(m.page) ?? [];
      list.push({ globalIndex: i, ranges: m.ranges });
      byPage.set(m.page, list);
    });
    return byPage;
  }, [matches]);

  // A new query starts at its first hit.
  useEffect(() => { setActiveMatch(0); }, [foldedQuery]);

  // Move the viewport to the current hit. Re-run shortly after in case the target
  // page was still a placeholder when the first scroll was computed.
  useEffect(() => {
    const match = matches[activeMatch];
    if (!match) return;
    let cancelled = false;
    const run = () => { if (!cancelled) void goToDestRef.current({ pageNumber: match.page, y: match.y }); };
    run();
    const timer = setTimeout(run, 260);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [matches, activeMatch]);

  // The document has been read end to end and holds no text at all — a scan with
  // no text layer. Say so, rather than reporting an honest-looking zero.
  const hasNoText = indexState === 'ready' && !!index && index.every((p) => !p.folded.trim());

  const stepMatch = (delta: number) => {
    if (matches.length === 0) return;
    setActiveMatch((prev) => (prev + delta + matches.length) % matches.length);
  };

  const handleFindKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      stepMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setQuery('');
    }
  };

  // Fit-to-width: measure the container and the first page, derive a base scale,
  // and keep it in sync on resize. User zoom multiplies it.
  const recomputeScale = useCallback(async () => {
    if (!pdf || !rootRef.current) return;
    const avail = rootRef.current.clientWidth - 24; // page gutter
    if (avail <= 0) return;
    if (!baseWidthRef.current) {
      const page = await pdf.getPage(1);
      baseWidthRef.current = page.getViewport({ scale: 1 }).width;
    }
    const fit = avail / baseWidthRef.current;
    setScale(Math.max(0.3, fit) * zoom);
  }, [pdf, zoom]);

  useEffect(() => { recomputeScale(); }, [recomputeScale]);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => recomputeScale());
    ro.observe(el);
    return () => ro.disconnect();
  }, [recomputeScale]);

  return (
    <div className="pdfjs-viewer" ref={rootRef}>
      {/* Toolbar and find bar travel together as one sticky header, so the find
          bar is always reachable however far down the document the reader is. */}
      <div className="pdfjs-headbar" ref={headRef}>
        <div className="pdfjs-toolbar">
          <div className="pdfjs-toolbar-group">
            <button type="button" className="pdfjs-btn" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.15).toFixed(2)))} aria-label="Zoom out">−</button>
            <span className="pdfjs-zoom">{Math.round(zoom * 100)}%</span>
            <button type="button" className="pdfjs-btn" onClick={() => setZoom((z) => Math.min(3, +(z + 0.15).toFixed(2)))} aria-label="Zoom in">+</button>
          </div>
          <div className="pdfjs-toolbar-group">
            {numPages > 0 && <span className="pdfjs-pagecount">{numPages} pages</span>}
            <a className="pdfjs-open-external" href={src} target="_blank" rel="noopener noreferrer">
              {openLabel || 'Open in new tab'}<span aria-hidden="true"> ↗</span>
            </a>
          </div>
        </div>

        {status === 'ready' && (
          <div className="pdfjs-find">
            <svg className="pdfjs-find-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <line x1="10.4" y1="10.4" x2="14" y2="14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              className="pdfjs-find-input"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setWantIndex(true); }}
              onFocus={() => setWantIndex(true)}
              onKeyDown={handleFindKeyDown}
              placeholder={t.placeholder}
              aria-label={t.placeholder}
            />
            {debouncedQuery && (
              <span className="pdfjs-find-count" aria-live="polite">
                {indexState === 'building'
                  ? '…'
                  : matches.length > 0
                    ? `${activeMatch + 1}/${matches.length}${matches.length >= MAX_MATCHES ? '+' : ''}`
                    : hasNoText ? '' : t.noMatch}
              </span>
            )}
            <button
              type="button"
              className="pdfjs-find-nav"
              onClick={() => stepMatch(-1)}
              disabled={matches.length === 0}
              aria-label={t.prev}
              title={t.prev}
            >‹</button>
            <button
              type="button"
              className="pdfjs-find-nav"
              onClick={() => stepMatch(1)}
              disabled={matches.length === 0}
              aria-label={t.next}
              title={t.next}
            >›</button>
            {/* A scan with no text layer cannot be searched at all; saying so beats
                a zero that looks like an answer. */}
            {hasNoText && <p className="pdfjs-find-note">{t.noText}</p>}
            {indexState === 'building' && <p className="pdfjs-find-note">{t.reading}</p>}
          </div>
        )}
      </div>

      {status === 'loading' && <p className="pdfjs-note">{t.loading}</p>}
      {status === 'error' && (
        <p className="pdfjs-note">
          {t.failed}{' '}
          <a href={src} target="_blank" rel="noopener noreferrer">{t.openNewTab}</a>
        </p>
      )}

      {status === 'ready' && pdf && (
        <div className="pdfjs-pages" title={title}>
          {Array.from({ length: numPages }, (_, i) => (
            <PdfPage
              key={i}
              pdf={pdf}
              pageNumber={i + 1}
              scale={scale}
              root={scrollParent}
              registerPage={registerPage}
              resolveDest={resolveDest}
              onNavigate={goToDest}
              pageMatches={matchesByPage.get(i + 1) ?? NO_MATCHES}
              activeMatch={activeMatch}
            />
          ))}
        </div>
      )}
    </div>
  );
}
