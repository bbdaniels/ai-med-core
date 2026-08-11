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

interface LinkBox { left: number; top: number; width: number; height: number; url: string }

// One page: a fixed-aspect placeholder until it nears the viewport, then a rendered
// canvas plus a link overlay. External links are real <a target="_blank"> elements —
// this is the whole point of bundling pdf.js: full control over link targets, which
// the browser's built-in PDF viewer never gives an embedder.
function PdfPage({ pdf, pageNumber, scale, root }: {
  pdf: pdfjsLib.PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  root: HTMLElement | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [visible, setVisible] = useState(false);
  const [links, setLinks] = useState<LinkBox[]>([]);
  const renderedForRef = useRef<string>('');

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
          // Only external URL links get an overlay anchor. Internal goto-links (the
          // document's own table of contents) have no `.url` and are skipped.
          if (a.subtype !== 'Link' || !a.url || !a.rect) continue;
          const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(a.rect);
          boxes.push({
            left: Math.min(x1, x2),
            top: Math.min(y1, y2),
            width: Math.abs(x2 - x1),
            height: Math.abs(y2 - y1),
            url: a.url,
          });
        }
        if (!cancelled) setLinks(boxes);
      }).catch(() => { /* render cancelled */ });
    }).catch(() => {});

    return () => { cancelled = true; task?.cancel(); };
  }, [visible, pdf, pageNumber, scale]);

  // Placeholder keeps layout stable (and scrollbar honest) before the canvas exists.
  const ph = dims ? { width: dims.w * scale, height: dims.h * scale } : { width: '100%', height: 700 };

  return (
    <div ref={wrapRef} className="pdfjs-page" style={{ width: ph.width, height: ph.height }}>
      <canvas ref={canvasRef} className="pdfjs-page-canvas" />
      <div className="pdfjs-link-layer">
        {links.map((l, i) => (
          <a
            key={i}
            href={l.url}
            target="_blank"
            rel="noopener noreferrer"
            className="pdfjs-link"
            style={{ left: l.left, top: l.top, width: l.width, height: l.height }}
            aria-label={l.url}
          />
        ))}
      </div>
    </div>
  );
}

export default function PdfJsViewer({ src, title, openLabel }: PdfJsViewerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [scale, setScale] = useState(1);
  const [zoom, setZoom] = useState(1); // user zoom multiplier on top of fit-width
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);
  const baseWidthRef = useRef<number>(0);

  // Load the document.
  useEffect(() => {
    let cancelled = false;
    setStatus('loading'); setPdf(null); setNumPages(0);
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
            <PdfPage key={i} pdf={pdf} pageNumber={i + 1} scale={scale} root={scrollParent} />
          ))}
        </div>
      )}
    </div>
  );
}
