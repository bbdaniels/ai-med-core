// The second panel: its tab bars (desktop and the mobile strip) and the views
// of every tab type both pages share — suggestions, PDF, document, a merged
// PDF+text document, the legal library and content sections. A form tab is the
// simulator's own and is rendered by App.tsx through `renderTab`.

import type React from 'react';
import { Suspense, lazy } from 'react';
import TabBar from '../components/TabBar';
import TabPanel from '../components/TabPanel';
import ContentPanel from '../components/ContentPanel';
import SuggestedQuestions, { type SuggestionsContent } from '../components/SuggestedQuestions';
import DocumentPanel from '../components/DocumentPanel';
import LegalLibraryPanel, { type LegalLibraryContent } from '../components/LegalLibraryPanel';
import DualViewTab, { type DualViewKind } from '../components/DualViewTab';
import LanguageSwitcher from '../LanguageSwitcher';
import { DUAL_VIEW_UI, PDF_TAB_UI, resolveI18n } from './tabs';
import type { ContentSection, LanguagesJson, TabDefinition, VignetteInfo } from './types';
import type { TabsState } from './useTabs';
import type { DocRefsState } from './useDocRefs';

// pdfjs-dist is code-split: only a PDF tab that is opened fetches it.
const PdfJsViewer = lazy(() => import('../components/PdfJsViewer'));

export type MobilePanel = 'chat' | 'form';

export interface TabViewContext {
  lang: string;
  /** Shown while a lazy view loads. */
  loadingLabel: string;
  tabs: TabsState;
  refs: DocRefsState;
  /** A clicked suggested question. */
  onQuestionClick: (question: string) => void;
  /** The open vignette's own sections for content tabs. */
  vignetteInfo?: VignetteInfo;
}

// The two renderings of a document tab. Factored out because a merged tab
// shows both behind one switcher and a plain tab shows one; two copies of
// either panel's wiring is exactly how the PDF and text editions would drift
// apart. `tabId` is the id the jump machinery addresses — on a merged tab both
// views answer to the tab's own id, which is the point of merging them.
//
// Rendered with bundled pdf.js (not the browser's built-in viewer) so we
// control link targets: every in-PDF external link becomes a real
// <a target="_blank">, and there is no outline sidebar eating panel width.
function renderPdfView(view: TabDefinition, tabId: string, label: string, c: TabViewContext) {
  const pdfUrl = (view.content as { pdfUrl?: string } | null)?.pdfUrl;
  const pdfSrc = pdfUrl ? `${import.meta.env.VITE_API_BASE_URL || ''}${pdfUrl}` : '';
  if (!pdfSrc) return <p style={{ padding: '1rem' }}>PDF not available.</p>;
  const { pdfScrollTarget } = c.refs;
  return (
    <Suspense fallback={
      <div className="loading-form-wrapper">
        <p>{c.loadingLabel}</p>
      </div>
    }>
      <PdfJsViewer
        src={pdfSrc}
        title={label}
        openLabel={(PDF_TAB_UI[c.lang] ?? PDF_TAB_UI.en).openInNewTab}
        lang={c.lang}
        jumpTarget={pdfScrollTarget?.tabId === tabId ? pdfScrollTarget : null}
      />
    </Suspense>
  );
}

function renderDocumentView(view: TabDefinition, tabId: string, c: TabViewContext) {
  const { docScrollTarget } = c.refs;
  return (
    <DocumentPanel
      content={(view.content as { markdown?: string } | null) ?? null}
      lang={c.lang}
      scrollTarget={docScrollTarget?.tabId === tabId ? docScrollTarget : null}
    />
  );
}

/** One tab's view, for every tab type but `form`. */
export function renderTabView(tab: TabDefinition, c: TabViewContext): React.ReactElement {
  const { tabViews, visitedViewKeys, setTabView, setActiveTabId, resolvedTabs } = c.tabs;
  if (tab.type === 'suggestions') {
    return (
      <div key={tab.id} data-tab-id={tab.id}>
        <SuggestedQuestions
          content={(tab.content as SuggestionsContent | null) ?? null}
          lang={c.lang}
          onQuestionClick={c.onQuestionClick}
        />
      </div>
    );
  }
  if (tab.type === 'pdf' || tab.type === 'document') {
    const tabLabel = typeof tab.label === 'string' ? tab.label : resolveI18n(tab.label, c.lang || 'en');
    const renderView = (view: TabDefinition) =>
      view.type === 'pdf' ? renderPdfView(view, tab.id, tabLabel, c) : renderDocumentView(view, tab.id, c);

    // A tab with only one edition renders exactly as it always did.
    if (!tab.altView) {
      const style = tab.type === 'pdf'
        ? { flex: 1, display: 'flex', flexDirection: 'column' as const, minHeight: 0 }
        : undefined;
      return (
        <div key={tab.id} data-tab-id={tab.id} style={style}>
          {renderView(tab)}
        </div>
      );
    }

    // Two editions of one document behind one tab. The primary (the
    // edition declared first — the PDF) is mounted with the tab; the
    // alt view waits until the reader asks for it, the same way a tab
    // itself waits for its first visit.
    const primary = tab;
    const alt = tab.altView;
    const currentView = tabViews[tab.id] ?? primary.type as DualViewKind;
    const altMounted = visitedViewKeys.has(`${tab.id}:${alt.type}`);
    const pdfSide = primary.type === 'pdf' ? primary : alt;
    const textSide = primary.type === 'pdf' ? alt : primary;
    const isMounted = (view: TabDefinition) => view === primary || altMounted;
    // The latest jump aimed at this tab, in either edition — it
    // tells the panel not to restore a remembered offset on top of
    // a destination the reader just asked for.
    const { docScrollTarget, pdfScrollTarget } = c.refs;
    const jumpNonce = Math.max(
      docScrollTarget?.tabId === tab.id ? docScrollTarget.nonce : 0,
      pdfScrollTarget?.tabId === tab.id ? pdfScrollTarget.nonce : 0,
    );
    return (
      <div key={tab.id} data-tab-id={tab.id} style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <DualViewTab
          view={currentView}
          onViewChange={(next) => setTabView(tab.id, next)}
          labels={DUAL_VIEW_UI[c.lang] ?? DUAL_VIEW_UI.en}
          jumpNonce={jumpNonce}
          pdfView={isMounted(pdfSide) ? renderView(pdfSide) : null}
          textView={isMounted(textSide) ? renderView(textSide) : null}
        />
      </div>
    );
  }
  if (tab.type === 'library') {
    return (
      <div key={tab.id} data-tab-id={tab.id}>
        <LegalLibraryPanel
          content={(tab.content as LegalLibraryContent | null) ?? null}
          lang={c.lang}
          selectTarget={c.refs.legalSelectTarget}
        />
      </div>
    );
  }
  // content tabs — sections can come from (a) legacy tab.globalSections
  // inside langs.tabs, or (b) the new pattern where tab.content (loaded
  // from a contentFile via /api/tabs) has a sections/globalSections field.
  const sceneSections = c.vignetteInfo?.tabSections?.[tab.id];
  const formTabId = !tab.hideAction ? resolvedTabs?.find(t => t.type === 'form')?.id : undefined;
  const contentFromFile = tab.content as { sections?: ContentSection[]; globalSections?: ContentSection[] } | null;
  const globalSections = tab.globalSections
    || contentFromFile?.globalSections
    || contentFromFile?.sections;
  return (
    <div key={tab.id} data-tab-id={tab.id}>
      <ContentPanel
        globalSections={globalSections}
        sceneSections={sceneSections}
        basePath={import.meta.env.BASE_URL}
        actionLabel={formTabId ? 'Submit Your Response →' : undefined}
        onAction={formTabId ? () => setActiveTabId(formTabId) : undefined}
      />
    </div>
  );
}

/** The desktop tab bar and the tab views. Each tab's view mounts on its first visit. */
export function TabbedPanel({ tabs, lang, renderTab }: {
  tabs: TabsState;
  lang: string;
  renderTab: (tab: TabDefinition) => React.ReactElement;
}) {
  const { resolvedTabs, activeTabId, setActiveTabId, visitedTabIds } = tabs;
  if (!resolvedTabs) return null;
  return (
    <>
      <TabBar
        tabs={resolvedTabs.map(tab => ({ id: tab.id, label: resolveI18n(tab.label, lang), icon: tab.icon }))}
        activeTabId={activeTabId}
        onTabChange={setActiveTabId}
        className="desktop-tab-bar"
      />
      <TabPanel activeTabId={activeTabId}>
        {resolvedTabs.map(tab => {
          // Defer panel content until the tab is first opened (see
          // visitedTabIds in useTabs). The placeholder keeps TabPanel's
          // data-tab-id contract so tab switching is unaffected.
          if (!visitedTabIds.has(tab.id)) {
            return <div key={tab.id} data-tab-id={tab.id} />;
          }
          return renderTab(tab);
        })}
      </TabPanel>
    </>
  );
}

/**
 * The tab strip on screens under 768px: the chat, then every tab. A project
 * without the welcome page also gets its language switcher here, because the
 * strip is fixed to the top of the viewport and stays reachable while the
 * reader is in the document or library panel. Desktop hides the whole strip.
 */
export function MobileTabStrip({ tabs, lang, chatLabel, mobilePanel, onMobilePanel, languageSwitcher }: {
  tabs: TabsState;
  lang: string;
  chatLabel: string;
  mobilePanel: MobilePanel;
  onMobilePanel: (panel: MobilePanel) => void;
  languageSwitcher?: { langs: LanguagesJson | null; onSelect: (code: string) => void; label: string } | null;
}) {
  const { resolvedTabs, activeTabId, setActiveTabId } = tabs;
  if (!resolvedTabs) return null;
  return (
    <div className="mobile-tab-strip">
      <TabBar
        tabs={[
          { id: 'chat', label: chatLabel, icon: '💬' },
          ...resolvedTabs.map(tab => ({ id: tab.id, label: resolveI18n(tab.label, lang), icon: tab.icon }))
        ]}
        activeTabId={mobilePanel === 'chat' ? 'chat' : activeTabId}
        onTabChange={(id) => {
          if (id === 'chat') {
            onMobilePanel('chat');
          } else {
            onMobilePanel('form');
            setActiveTabId(id);
          }
        }}
        scrollable
      />
      {languageSwitcher && (languageSwitcher.langs?.languages?.length ?? 0) > 1 && (
        <LanguageSwitcher
          languages={languageSwitcher.langs?.languages || []}
          selectedCode={lang || 'en'}
          onSelect={languageSwitcher.onSelect}
          label={languageSwitcher.label}
          className="lang-switcher-strip"
        />
      )}
    </div>
  );
}
