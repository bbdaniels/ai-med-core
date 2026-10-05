// Tabs in the second panel: where they come from, how a document's two
// editions fold into one tab, and the small UI maps the tab views use. Pure,
// so it can be checked without a browser (src/tabs.check.ts).

import type { LanguagesJson, TabDefinition, TabLabel } from './types';

// The two tab types that can be two views of one document.
const DUAL_VIEW_TYPES: ReadonlySet<string> = new Set(['pdf', 'document'])

/**
 * Fold tabs that declare the SAME id into one tab with two views.
 *
 * A reference document that ships both a PDF and an extracted text is one
 * document, and a project says so by declaring one tab id twice — once as `pdf`,
 * once as `document`, each with its own contentFile:
 *
 *   { "id": "eip-doc", "type": "pdf",      "contentFile": {...} }   <- default view
 *   { "id": "eip-doc", "type": "document", "contentFile": {...} }
 *
 * Declaration order decides which view opens first. The shared id is the point:
 * everything that addresses a tab — the doc-reference jump machinery, the PDF
 * page jumps, the active-tab reselect — keeps working on one stable id instead of
 * having to know which edition a citation happened to be aimed at.
 *
 * A project that declares each id once (every project but haivn_eip today) gets
 * its tab list back unchanged.
 */
export function mergeTabViews(tabs: TabDefinition[]): TabDefinition[] {
  const byId = new Map<string, TabDefinition>()
  const merged: TabDefinition[] = []
  for (const tab of tabs) {
    const primary = byId.get(tab.id)
    if (!primary) {
      const copy = { ...tab }
      byId.set(tab.id, copy)
      merged.push(copy)
      continue
    }
    // Only a genuine second EDITION folds in. Anything else is a config mistake
    // (two unrelated tabs sharing an id), and rendering it would put two panels
    // behind one tab button — so it is dropped loudly rather than shown.
    if (
      !primary.altView &&
      DUAL_VIEW_TYPES.has(primary.type) &&
      DUAL_VIEW_TYPES.has(tab.type) &&
      primary.type !== tab.type
    ) {
      primary.altView = tab
    } else {
      console.warn(`Duplicate tab id "${tab.id}" (type ${tab.type}) ignored: not a second view of the primary tab.`)
    }
  }
  return merged
}

// The markdown a document tab carries, whichever of its views holds it. Used to
// derive the valid anchor set for document references, which must not depend on
// the reader having opened the text view.
export function tabMarkdown(tab: TabDefinition | null | undefined): string | undefined {
  const own = (tab?.content as { markdown?: string } | null | undefined)?.markdown
  return own ?? (tab?.altView?.content as { markdown?: string } | null | undefined)?.markdown
}

// The PDF url a document tab carries, whichever of its views holds it.
export function tabPdfUrl(tab: TabDefinition | null | undefined): string | undefined {
  const own = (tab?.content as { pdfUrl?: string } | null | undefined)?.pdfUrl
  return own ?? (tab?.altView?.content as { pdfUrl?: string } | null | undefined)?.pdfUrl
}

// Whether a tab offers a PDF rendering at all — as its own type or as its alt view.
export function tabHasPdf(tab: TabDefinition | null | undefined): boolean {
  return !!tab && (tab.type === 'pdf' || tab.altView?.type === 'pdf')
}

// Resolves a language-keyed object string to the user's language, falling back to English.
// Pass-through for plain strings (legacy behavior).
export function resolveI18n(val: TabLabel | undefined, lang: string): string {
  if (!val) return ''
  if (typeof val === 'string') return val
  return val[lang] || val['en'] || ''
}

// UI strings for the pdf tab's "open in a new tab" affordance. Kept here rather than
// in each project's languages.json so a pdf tab works for any project with no extra
// i18n wiring — the same small-map convention DocumentPanel uses. Falls back to English.
export const PDF_TAB_UI: Record<string, { openInNewTab: string }> = {
  en: { openInNewTab: 'Open in new tab' },
  vi: { openInNewTab: 'Mở trong tab mới' },
  es: { openInNewTab: 'Abrir en una pestaña nueva' },
  fr: { openInNewTab: 'Ouvrir dans un nouvel onglet' },
  pt: { openInNewTab: 'Abrir em nova aba' },
  zh: { openInNewTab: '在新标签页中打开' },
  hi: { openInNewTab: 'नए टैब में खोलें' },
}

// The Text/PDF control on a merged document tab. Same wording as the Legal
// Library's own switcher (LegalLibraryPanel's UI map) so one vocabulary covers
// both surfaces; kept here rather than in each project's languages.json for the
// same reason PDF_TAB_UI is — a merged tab needs no per-project i18n wiring.
export const DUAL_VIEW_UI: Record<string, { group: string; pdf: string; text: string }> = {
  en: { group: 'View', pdf: 'PDF', text: 'Text' },
  vi: { group: 'Xem', pdf: 'PDF', text: 'Văn bản' },
  es: { group: 'Ver', pdf: 'PDF', text: 'Texto' },
  fr: { group: 'Affichage', pdf: 'PDF', text: 'Texte' },
  pt: { group: 'Ver', pdf: 'PDF', text: 'Texto' },
  zh: { group: '查看', pdf: 'PDF', text: '文本' },
  hi: { group: 'देखें', pdf: 'PDF', text: 'पाठ' },
}

// The secondary affordance on a document-reference chip. The chip itself opens
// the PDF at the cited page; this is the way back to the text edition.
export const DOC_REF_UI: Record<string, { text: string; openPdf: string; openText: string }> = {
  en: { text: 'Text', openPdf: 'Open in the PDF', openText: 'Open in the text' },
  vi: { text: 'Văn bản', openPdf: 'Mở trong bản PDF', openText: 'Mở trong toàn văn' },
  es: { text: 'Texto', openPdf: 'Abrir en el PDF', openText: 'Abrir en el texto' },
  fr: { text: 'Texte', openPdf: 'Ouvrir dans le PDF', openText: 'Ouvrir dans le texte' },
  pt: { text: 'Texto', openPdf: 'Abrir no PDF', openText: 'Abrir no texto' },
  zh: { text: '文本', openPdf: '在 PDF 中打开', openText: '在文本中打开' },
  hi: { text: 'पाठ', openPdf: 'PDF में खोलें', openText: 'पाठ में खोलें' },
}

// A PDF tab's page map lives beside the PDF it maps, under the same base name:
//   .../eip-en.pdf  ->  .../eip-map.en.json
// Derived rather than configured so no project.json change is needed, and a
// project with no such file simply gets a 404 and keeps today's behavior.
export function pdfPageMapUrl(pdfUrl: string): string | null {
  const m = /^(.*\/)([^/]+)-([A-Za-z]{2}(?:-[A-Za-z0-9]+)?)\.pdf$/.exec(pdfUrl)
  return m ? `${m[1]}${m[2]}-map.${m[3]}.json` : null
}

/**
 * The tabs a page shows: /api/tabs when it returned any, else the legacy
 * languages-file tabs; only those meant for the open vignette; a form tab
 * added when `addFormTab` and none is declared; editions folded; sorted by
 * `order`. Null when the project declares no tabs at all.
 */
export function resolveTabs(
  apiTabs: TabDefinition[] | null,
  langs: LanguagesJson | null,
  o: { vignetteKey: string | null; addFormTab: boolean },
): TabDefinition[] | null {
  // Prefer tabs from /api/tabs (new pattern); fall back to legacy langs.tabs (CBS pattern).
  const source = (apiTabs && apiTabs.length > 0) ? apiTabs : (langs?.tabs ?? null);
  if (!source) return null;
  // Per-vignette visibility: hide tabs whose showForVignetteKeys doesn't include the current vignette.
  const tabs = source.filter(tab => {
    if (!tab.showForVignetteKeys || tab.showForVignetteKeys.length === 0) return true;
    return !!o.vignetteKey && tab.showForVignetteKeys.includes(o.vignetteKey);
  });
  // Auto-add a form tab unless the project declares formless mode or already has one.
  if (o.addFormTab && !tabs.some(t => t.type === 'form')) {
    tabs.push({ id: 'form', label: 'Assessment', type: 'form', pinned: true, order: 999 });
  }
  // Fold any id declared twice into one tab with two views (see mergeTabViews)
  // BEFORE sorting, so declaration order — not the two entries' `order` values —
  // is what decides which view a merged tab opens on.
  return mergeTabViews(tabs).sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
}
