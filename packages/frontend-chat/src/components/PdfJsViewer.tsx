import { useEffect, useRef, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
// Vite resolves ?url to the emitted asset path (respecting VITE_BASE_PATH), so the
// worker is served same-origin from our own bundle — no CDN, CSP-safe.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

interface PdfJsViewerProps {
  src: string;
  title?: string;
  openLabel?: string;
  // An imperative jump requested from outside: scroll to a 1-based page. Bump
  // `nonce` to re-trigger for the same page. Handled through the very same
  // goToDest path an in-document TOC link takes, so there is one implementation
  // of "move the viewport to page N" rather than two that can drift apart.
  jumpTarget?: { page: number; nonce: number } | null;
}

// The scrolling ancestor is the tab panel (overflow-y:auto), not the window — the
// same container DocumentPanel scrolls. Find it so lazy-render observers use the
// right root instead of a hardcoded selector that could silently break.
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement || null;
  while (node) {
    const oy = getComputedStyle(node).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
}

// Where an internal GoTo link lands: a page, and (when the destination carries one)
// a vertical position in that page's user space.
interface DestTarget { pageNumber: number; y: number | null }

interface LinkBox {
  left: number; top: number; width: number; height: number;
  url?: string;
  dest?: DestTarget;
}

// One page: a fixed-aspect placeholder until it nears the viewport, then a rendered
// canvas plus a link overlay. External links are real <a target="_blank"> elements —
// this is the whole point of bundling pdf.js: full control over link targets, which
// the browser's built-in PDF viewer never gives an embedder. Internal links become
// buttons that drive the viewer's own scroll.
function PdfPage({ pdf, pageNumber, scale, root, registerPage, resolveDest, onNavigate }: {
  pdf: pdfjsLib.PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  root: HTMLElement | null;
  registerPage: (pageNumber: number, el: HTMLDivElement | null) => void;
  resolveDest: (dest: unknown) => Promise<DestTarget | null>;
  onNavigate: (target: DestTarget) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [visible, setVisible] = useState(false);
  const [links, setLinks] = useState<LinkBox[]>([]);
  const renderedForRef = useRef<string>('');

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
      // Left the render window — drop the bitmap to reclaim memory.
      if (!visible && canvas) {
        canvas.width = 0; canvas.height = 0;
        renderedForRef.current = '';
        setLinks([]);
      }
      return;
    }
    const key = `${pageNumber}@${scale}`;
    if (renderedForRef.current === key) return;

    let cancelled = false;
    let task: pdfjsLib.RenderTask | null = null;
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

    return () => { cancelled = true; task?.cancel(); };
  }, [visible, pdf, pageNumber, scale, resolveDest]);

  // Placeholder keeps layout stable (and scrollbar honest) before the canvas exists.
  const ph = dims ? { width: dims.w * scale, height: dims.h * scale } : { width: '100%', height: 700 };

  return (
    <div ref={wrapRef} className="pdfjs-page" style={{ width: ph.width, height: ph.height }}>
      <canvas ref={canvasRef} className="pdfjs-page-canvas" />
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

export default function PdfJsViewer({ src, title, openLabel, jumpTarget }: PdfJsViewerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [scale, setScale] = useState(1);
  const [zoom, setZoom] = useState(1); // user zoom multiplier on top of fit-width
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);
  const baseWidthRef = useRef<number>(0);
  const pageElsRef = useRef(new Map<number, HTMLDivElement>());
  const destCacheRef = useRef(new Map<string, DestTarget | null>());

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
  // within it) comes into view. Falls back to scrollIntoView if the scroll ancestor
  // could not be resolved.
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
    const delta = el.getBoundingClientRect().top - scrollParent.getBoundingClientRect().top;
    scrollParent.scrollTo({ top: scrollParent.scrollTop + delta + offset - 8, behavior: 'smooth' });
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
    const task = pdfjsLib.getDocument({ url: src });
    task.promise
      .then((doc) => { if (!cancelled) { setPdf(doc); setNumPages(doc.numPages); setStatus('ready'); } })
      .catch(() => { if (!cancelled) setStatus('error'); });
    return () => { cancelled = true; task.destroy(); };
  }, [src]);

  // Resolve the scroll parent once mounted (for the pages' lazy-render observers).
  useEffect(() => { setScrollParent(findScrollParent(rootRef.current)); }, [status]);

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

      {status === 'loading' && <p className="pdfjs-note">Loading document…</p>}
      {status === 'error' && (
        <p className="pdfjs-note">
          Could not display the PDF here.{' '}
          <a href={src} target="_blank" rel="noopener noreferrer">Open it in a new tab ↗</a>
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
            />
          ))}
        </div>
      )}
    </div>
  );
}
