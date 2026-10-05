// Document references in assistant answers ("Section 4.1", "Phụ lục 7.1",
// "96/2023/NĐ-CP, Điều 40"): the matcher built from the anchors and legal
// instruments the project's tabs actually carry, the lazily loaded page maps
// that let a citation open the PDF at the right page, and the jump requests a
// click sends to the document, PDF and library tabs. See doc-refs.ts and
// legal-map.ts; the rendering is in AssistantContent.tsx.

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, apiFetch } from '../api-base';
import type { DualViewKind } from '../components/DualViewTab';
import { type DocRefsConfig, buildDocRefMatcher, extractAnchorIds } from '../doc-refs';
import { type LegalDocMap, sectionPageIndex } from '../legal-map';
import { pdfPageMapUrl, tabHasPdf, tabMarkdown, tabPdfUrl } from './tabs';
import type { Message, TabDefinition } from './types';

export interface DocRefsOptions {
  /** The project's docRefs config; null switches the feature off. */
  docRefs: DocRefsConfig | null;
  resolvedTabs: TabDefinition[] | null;
  messages: Message[];
  setTabView: (tabId: string, view: DualViewKind) => void;
  /** Bring a tab forward (desktop tab and mobile panel) for a clicked reference. */
  reveal: (tabId: string) => void;
}

export function useDocRefs({ docRefs, resolvedTabs, messages, setTabView, reveal }: DocRefsOptions) {
  // A clicked reference asks the target document tab to scroll; the bumped nonce
  // re-triggers the jump even when the same anchor is clicked twice.
  const [docScrollTarget, setDocScrollTarget] = useState<{ tabId: string; anchor: string; nonce: number } | null>(null);
  // The same click, aimed at the PDF edition instead: which pdf tab, which
  // 1-based page, and a nonce so the same page can be re-requested.
  const [pdfScrollTarget, setPdfScrollTarget] = useState<{ tabId: string; page: number; nonce: number } | null>(null);
  // anchor -> 1-based PDF page, from the PDF tab's page map. Null until the map
  // has loaded (or if it never does), and the chips render exactly as they did
  // before it arrived — so a jump is never delayed waiting on this.
  const [pdfAnchorPages, setPdfAnchorPages] = useState<Record<string, number> | null>(null);
  const pdfMapRequestedRef = useRef<string | null>(null);
  // A clicked legal-document reference asks the legal-library tab to select that
  // document; the bumped nonce re-triggers even for the same document. An
  // article-level citation carries the PDF page as well.
  const [legalSelectTarget, setLegalSelectTarget] = useState<{ docId: string; page?: number; nonce: number } | null>(null);
  // docId -> (section key -> 1-based PDF page), from each cited legal document's
  // own section map. Populated lazily, one document at a time, and only for
  // documents an answer actually cites an article of; a document with no map (or
  // a map that fails to load) simply never appears here and its citations keep
  // today's whole-document link.
  const [legalSectionPages, setLegalSectionPages] = useState<Record<string, Record<string, number>>>({});
  const legalMapRequestedRef = useRef<Set<string>>(new Set());
  // Build the document-reference matcher from the anchors actually present in the
  // target document tab. Deriving the valid-anchor set from the loaded markdown
  // (rather than a hardcoded list) means a link can only point at a passage that
  // exists, and the set is identical across languages for numbered sections — so
  // a Vietnamese answer's "Mục 4.1" resolves to the same anchor as "Section 4.1".
  // The legal-library tab (if any) and a map of its document numbers -> ids, so a
  // legal instrument the advisor names ("Quyết định 1740/QĐ-BYT") becomes a link
  // that opens that document in the library. Only numbers actually in the registry
  // resolve, so an invented citation stays plain text.
  const legalTab = useMemo(() => resolvedTabs?.find(t => t.type === 'library') ?? null, [resolvedTabs]);
  const legalNumberToId = useMemo(() => {
    const map = new Map<string, string>();
    const docs = (legalTab?.content as { documents?: Array<{ id: string; number?: string }> } | null | undefined)?.documents;
    // Only real instrument numbers (they contain a "/", e.g. 1740/QĐ-BYT) — skips
    // the WHO reports whose "number" is a descriptive title, not a citable number.
    if (docs) for (const d of docs) if (d.number && d.number.includes('/')) map.set(d.number, d.id);
    return map;
  }, [legalTab]);
  // What each library document ships, for resolving an article citation to a page:
  // the section map to read, whether a canonical text exists (which decides how
  // strictly the map is filtered), and whether there is a PDF to jump into at all.
  const legalDocFiles = useMemo(() => {
    const map = new Map<string, { mapFile?: string | null; textFile?: string | null; pdfFile?: string | null }>();
    const docs = (legalTab?.content as {
      documents?: Array<{ id: string; mapFile?: string | null; textFile?: string | null; pdfFile?: string | null }>;
    } | null | undefined)?.documents;
    if (docs) for (const d of docs) map.set(d.id, { mapFile: d.mapFile, textFile: d.textFile, pdfFile: d.pdfFile });
    return map;
  }, [legalTab]);
  const docRefMatcher = useMemo(() => {
    if (!docRefs) return null;
    const tab = resolvedTabs?.find(t => t.id === docRefs.tabId);
    // The markdown may sit on the tab itself or on its alt view (a merged
    // PDF+text tab), and the anchors must be known either way: they are what
    // decides whether a citation becomes a link at all, long before the reader
    // has opened — or even seen — the text edition.
    const markdown = tabMarkdown(tab);
    const anchors = markdown ? extractAnchorIds(markdown) : new Set<string>();
    return buildDocRefMatcher(docRefs, anchors, legalNumberToId);
  }, [docRefs, resolvedTabs, legalNumberToId]);
  // The PDF edition of the same document, and the page map beside it. Both are
  // optional: with no pdf tab, or no map file, document references behave
  // exactly as they did before this feature existed.
  // `tabHasPdf`, not `type === 'pdf'`: on a merged tab the PDF may be the alt
  // view, and a citation must still be able to open it.
  const pdfTab = useMemo(() => resolvedTabs?.find(tabHasPdf) ?? null, [resolvedTabs]);
  const pdfTabMapUrl = useMemo(() => {
    const url = tabPdfUrl(pdfTab);
    const rel = url ? pdfPageMapUrl(url) : null;
    return rel ? `${import.meta.env.VITE_API_BASE_URL || ''}${rel}` : null;
  }, [pdfTab]);
  // Load the map lazily — on the first answer that actually cites a passage,
  // not at startup — and only once per PDF edition. Until it lands (or if it
  // never does) the chips keep today's text-tab behavior, so nothing waits on
  // this fetch and nothing flashes when it fails.
  useEffect(() => {
    if (!pdfTabMapUrl || !docRefMatcher) return;
    if (pdfMapRequestedRef.current === pdfTabMapUrl) return;
    const cites = messages.some(m => m.role === 'assistant' && docRefMatcher(m.content).some(s => !!s.anchor));
    if (!cites) return;
    pdfMapRequestedRef.current = pdfTabMapUrl;
    let cancelled = false;
    apiFetch(pdfTabMapUrl)
      .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
      .then((json: { anchors?: Record<string, number> }) => {
        const anchors = json && typeof json === 'object' ? json.anchors : null;
        if (!cancelled && anchors && typeof anchors === 'object') setPdfAnchorPages(anchors);
      })
      .catch(() => { /* no map: text-tab jumps, as before */ });
    return () => { cancelled = true; };
  }, [pdfTabMapUrl, docRefMatcher, messages]);
  // A language switch swaps the PDF edition, and with it the page map.
  useEffect(() => { setPdfAnchorPages(null); }, [pdfTabMapUrl]);
  // The same lazy pattern for legal instruments, per document: when an answer
  // cites an article of a document the library carries, fetch that document's
  // section map once and remember its section->page index. Nothing waits on the
  // fetch — until it lands (or if it never does) the citation renders as today's
  // whole-document link, and the failure is swallowed.
  useEffect(() => {
    if (!docRefMatcher || legalDocFiles.size === 0) return;
    const wanted = new Set<string>();
    for (const m of messages) {
      if (m.role !== 'assistant') continue;
      for (const seg of docRefMatcher(m.content)) {
        if (seg.legalId && seg.sectionKey && !legalMapRequestedRef.current.has(seg.legalId)) wanted.add(seg.legalId);
      }
    }
    if (wanted.size === 0) return;
    let cancelled = false;
    for (const docId of wanted) {
      const files = legalDocFiles.get(docId);
      if (!files?.mapFile || !files.pdfFile) continue;
      legalMapRequestedRef.current.add(docId);
      apiFetch(api(`/api/project-content/${files.mapFile}`))
        .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
        .then((json: LegalDocMap) => {
          if (cancelled || !json || typeof json !== 'object') return;
          const index = sectionPageIndex(json, !!files.textFile);
          if (Object.keys(index).length === 0) return;
          setLegalSectionPages(prev => ({ ...prev, [docId]: index }));
        })
        .catch(() => { /* no map: whole-document link, as before */ });
    }
    return () => { cancelled = true; };
  }, [docRefMatcher, legalDocFiles, messages]);
  // Clicked document reference in an assistant answer: reveal the document tab
  // (desktop tab + mobile right panel) and ask it to scroll the passage in.
  const openDocRef = (anchor: string) => {
    if (!docRefs) return;
    reveal(docRefs.tabId);
    // On a merged tab this also flips the edition: the anchor lives in the text.
    setTabView(docRefs.tabId, 'document');
    setDocScrollTarget({ tabId: docRefs.tabId, anchor, nonce: Date.now() });
  };

  // The same reference, opened in the PDF edition at the mapped page. This is
  // the primary action wherever the map knows the anchor.
  const openDocRefPdf = (page: number) => {
    if (!pdfTab) return;
    reveal(pdfTab.id);
    setTabView(pdfTab.id, 'pdf');
    setPdfScrollTarget({ tabId: pdfTab.id, page, nonce: Date.now() });
  };

  // A legal-document reference: open the legal-library tab and select that
  // document. With a page (an article citation whose page the section map knows)
  // the library also switches to the PDF view and jumps there; without one this
  // is the whole-document open it has always been.
  const openLegalRef = (docId: string, page?: number) => {
    if (!legalTab) return;
    reveal(legalTab.id);
    setLegalSelectTarget({ docId, page, nonce: Date.now() });
  };

  return {
    docRefMatcher, legalDocFiles, legalSectionPages, pdfTab, pdfAnchorPages,
    docScrollTarget, pdfScrollTarget, legalSelectTarget,
    openDocRef, openDocRefPdf, openLegalRef,
  };
}

export type DocRefsState = ReturnType<typeof useDocRefs>;
