import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { foldQuery, foldWithMap } from '../text-search';
import { findScrollParent, scrollElementIntoScroller } from '../scroll-parent';

marked.setOptions({ breaks: true, gfm: true });

interface DocumentContent {
  markdown?: string;
}

interface DocumentPanelProps {
  content: DocumentContent | null;
  lang?: string;
  // When set (bumped `nonce`), scroll the named heading anchor into view. Driven
  // from the chat side, where a clicked document reference switches to this tab
  // and asks it to jump to the passage. The anchor ids are the same ones the
  // in-panel contents list uses (promoted from `{#...}` markers below).
  scrollTarget?: { anchor: string; nonce: number } | null;
}

const UI: Record<string, { placeholder: string; prev: string; next: string; clear: string; empty: string; noMatch: string; backToTop: string }> = {
  en: {
    placeholder: 'Search this document',
    prev: 'Previous match',
    next: 'Next match',
    clear: 'Clear search',
    empty: 'No document available.',
    noMatch: 'no matches',
    backToTop: 'Back to top',
  },
  vi: {
    placeholder: 'Tìm trong tài liệu',
    prev: 'Kết quả trước',
    next: 'Kết quả tiếp theo',
    clear: 'Xóa tìm kiếm',
    empty: 'Không có tài liệu.',
    noMatch: 'không có kết quả',
    backToTop: 'Về đầu trang',
  },
};

// The document scrolls inside an ancestor (the tab's `.tab-panel`, overflow-y:auto),
// not the window and not `.document-panel-body`; `findScrollParent` (shared with
// the PDF viewer) locates it by overflow behavior rather than a hardcoded class,
// so the back-to-top control keeps working if the surrounding markup is
// restructured.

// How far the reader must scroll before the back-to-top control appears (roughly a
// screenful), so it stays out of the way near the top of a document.
const BACK_TO_TOP_THRESHOLD = 320;

/**
 * Wrap every occurrence of `query` in the panel's text nodes with a <mark>.
 * Walks text nodes rather than string-replacing the HTML, so a match can never
 * land inside a tag name or an attribute and break the markup.
 *
 * Matching goes through the shared fold in `text-search.ts` -- the same one the
 * PDF find bar uses -- so `dieu tri` finds `điều trị` and the Text and PDF views
 * of one document report the same number of hits. The fold's index map is what
 * makes that safe here: a match is located in the folded form, then painted back
 * onto the ORIGINAL characters, so the <mark> still carries the document's own
 * accents, capitalization and spacing rather than a normalized copy of them.
 */
function highlightMatches(root: HTMLElement, query: string): HTMLElement[] {
  const needle = foldQuery(query);
  if (!needle) return [];

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.nodeValue && node.nodeValue.trim().length > 0
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) textNodes.push(node as Text);

  const marks: HTMLElement[] = [];
  for (const textNode of textNodes) {
    const text = textNode.nodeValue ?? '';
    const { folded, map } = foldWithMap(text);
    let idx = folded.indexOf(needle);
    if (idx === -1) continue;

    const frag = document.createDocumentFragment();
    let cursor = 0; // an index into `text`, not into `folded`
    while (idx !== -1) {
      // Map the folded span back to source offsets. `map[i]` is the source index
      // of the character that produced `folded[i]`; the end is one past the
      // source character behind the last folded character, which covers a source
      // character that folded to several (a ligature) as well as one that folded
      // to one.
      const start = map[idx];
      const end = map[idx + needle.length - 1] + 1;
      // A folded match can only start at or after the cursor, but guard anyway so
      // a pathological mapping can never emit overlapping marks.
      if (start >= cursor) {
        if (start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, start)));
        const mark = document.createElement('mark');
        mark.className = 'document-search-hit';
        mark.textContent = text.slice(start, end);
        frag.appendChild(mark);
        marks.push(mark);
        cursor = end;
      }
      idx = folded.indexOf(needle, idx + needle.length);
    }
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
    textNode.parentNode?.replaceChild(frag, textNode);
  }
  return marks;
}

export default function DocumentPanel({ content, lang, scrollTarget }: DocumentPanelProps) {
  const t = UI[lang || 'en'] ?? UI.en;
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollParentRef = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [activeMatch, setActiveMatch] = useState(0);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const marksRef = useRef<HTMLElement[]>([]);

  const html = useMemo(() => {
    const md = content?.markdown;
    if (!md) return '';
    let raw = marked.parse(md) as string;
    // Pandoc-style heading anchors (`{#anchor-id}`) arrive as literal text inside
    // the heading. Promote them to real ids so the contents list can scroll to them.
    raw = raw.replace(
      /<(h[1-6])>(.*?)\s*\{#([^}]+)\}\s*<\/\1>/g,
      '<$1 id="$3">$2</$1>'
    );
    return DOMPurify.sanitize(raw);
  }, [content]);

  // Typing re-renders a large document, so settle before doing the work.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 150);
    return () => clearTimeout(timer);
  }, [query]);

  // Re-render the document, then mark the hits. Rebuilding from `html` each time
  // is what clears the previous search's marks.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.innerHTML = html;
    // External links (the EIP's citations to legal documents, Drive files, etc.)
    // open in a new tab — following one in place would navigate the whole SPA away.
    // In-document `#anchor` links are left to handleClick, which scrolls in-panel.
    el.querySelectorAll('a[href]').forEach((a) => {
      if (/^https?:/i.test(a.getAttribute('href') || '')) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      }
    });
    marksRef.current = debouncedQuery ? highlightMatches(el, debouncedQuery) : [];
    setMatchCount(marksRef.current.length);
    setActiveMatch(0);
  }, [html, debouncedQuery]);

  // The single way anything in this panel moves the reader: scroll the panel's
  // own scroller, never `el.scrollIntoView()`, which would also scroll the
  // window. See `scrollElementIntoScroller` for why that matters here.
  //
  // The scroller is resolved lazily rather than read from `scrollParentRef`,
  // whose effect is keyed on `html` and so has not necessarily run for the
  // document being scrolled.
  const scrollPanelTo = useCallback((target: HTMLElement, block: 'start' | 'center') => {
    const scroller = scrollParentRef.current ?? findScrollParent(panelRef.current);
    scrollParentRef.current = scroller;
    // No scrolling ancestor at all: nothing to move but the window, so let the
    // browser do it.
    if (!scroller) { target.scrollIntoView({ behavior: 'smooth', block }); return; }
    scrollElementIntoScroller(target, scroller, { block });
  }, []);

  // The single way this panel moves to an anchor — used both by a link inside the
  // document and by a reference clicked in the chat. Resolution is scoped to this
  // panel's own body rather than the whole document: more than one DocumentPanel
  // can be mounted at once (the legal library renders one too, hidden with
  // display:none rather than unmounted), so a global lookup could land on a
  // heading in a panel nobody is looking at.
  const scrollToAnchor = useCallback((anchor: string) => {
    // A bare `href="#"` yields an empty anchor, and `querySelector('#')` throws.
    if (!anchor) return;
    const target = bodyRef.current?.querySelector<HTMLElement>(`#${CSS.escape(anchor)}`);
    if (target) scrollPanelTo(target, 'start');
  }, [scrollPanelTo]);

  // Jump to a heading anchor asked for from outside (a document reference clicked
  // in the chat). The anchor ids are laid down by the render effect above, so they
  // are present even while this tab is hidden; the switch that reveals the tab and
  // this scroll land in the same commit, so a rAF lets the panel become visible
  // before the scroll runs. Keyed on `nonce` so re-clicking the same reference
  // scrolls again.
  useEffect(() => {
    if (!scrollTarget) return;
    const { anchor } = scrollTarget;
    const raf = requestAnimationFrame(() => scrollToAnchor(anchor));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTarget?.nonce]);

  // Move the viewport to the current hit and make it the one that stands out.
  useEffect(() => {
    const marks = marksRef.current;
    marks.forEach((m, i) => m.classList.toggle('is-active', i === activeMatch));
    const current = marks[activeMatch];
    if (current) scrollPanelTo(current, 'center');
  }, [activeMatch, matchCount, scrollPanelTo]);

  // Track scroll on the real scrolling ancestor so a back-to-top control can appear
  // once the reader has moved a meaningful distance down a long document. Re-run when
  // `html` changes so a language switch (which swaps the document) re-syncs visibility.
  useEffect(() => {
    const scroller = findScrollParent(panelRef.current);
    scrollParentRef.current = scroller;
    if (!scroller) return;
    const onScroll = () => setShowBackToTop(scroller.scrollTop > BACK_TO_TOP_THRESHOLD);
    onScroll(); // sync now in case the reader is already scrolled down
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [html]);

  const scrollToTop = () => {
    scrollParentRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const step = (delta: number) => {
    if (matchCount === 0) return;
    setActiveMatch((prev) => (prev + delta + matchCount) % matchCount);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setQuery('');
    }
  };

  // In-document links scroll within the panel instead of navigating away.
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const link = target.closest('a') as HTMLAnchorElement | null;
    if (!link) return;
    const href = link.getAttribute('href');
    if (!href || !href.startsWith('#')) return;
    // Always swallow the click: a bare fragment would otherwise be pushed onto the
    // SPA's own URL, which navigates nothing and survives in the address bar even
    // when the anchor does not exist in the document.
    e.preventDefault();
    scrollToAnchor(decodeURIComponent(href.slice(1)));
  };

  if (!html) {
    return (
      <div className="document-panel-empty">
        <p>{t.empty}</p>
      </div>
    );
  }

  return (
    <div className="document-panel" ref={panelRef}>
      <div className="document-search">
        <svg className="document-search-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <line x1="10.4" y1="10.4" x2="14" y2="14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <input
          type="search"
          className="document-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t.placeholder}
          aria-label={t.placeholder}
        />
        {debouncedQuery && (
          <span className="document-search-count" aria-live="polite">
            {matchCount > 0 ? `${activeMatch + 1}/${matchCount}` : t.noMatch}
          </span>
        )}
        <button
          type="button"
          className="document-search-nav"
          onClick={() => step(-1)}
          disabled={matchCount === 0}
          aria-label={t.prev}
          title={t.prev}
        >‹</button>
        <button
          type="button"
          className="document-search-nav"
          onClick={() => step(1)}
          disabled={matchCount === 0}
          aria-label={t.next}
          title={t.next}
        >›</button>
        {/* Jump to the top of the document. Lives in the always-visible find bar so
            it is reachable without a floating control; disabled when already at top. */}
        <button
          type="button"
          className="document-search-nav document-search-top"
          onClick={scrollToTop}
          disabled={!showBackToTop}
          aria-label={t.backToTop}
          title={t.backToTop}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M8 3.5v9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M4 7l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <div
        ref={bodyRef}
        className="document-panel-body"
        onClick={handleClick}
      />
    </div>
  );
}
