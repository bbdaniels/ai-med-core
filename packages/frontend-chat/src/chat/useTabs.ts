// The second panel's tabs: fetched from /api/tabs, resolved (see resolveTabs),
// which one is active, which have been opened, and which edition a merged
// document tab shows.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, apiFetch } from '../api-base';
import type { DualViewKind } from '../components/DualViewTab';
import { resolveTabs } from './tabs';
import type { LanguagesJson, TabDefinition } from './types';

export interface TabsOptions {
  /** The gated endpoints will answer (useAccessGate). */
  accessReady: boolean;
  languageCode: string;
  langs: LanguagesJson | null;
  vignetteKey: string | null;
  /** Add a form tab when the project declares none (the simulator's assessment). */
  addFormTab: boolean;
}

export function useTabs({ accessReady, languageCode, langs, vignetteKey, addFormTab }: TabsOptions) {
  // Tabs fetched from /api/tabs (new pattern: tab structure in project.json, content in separate files).
  // When null, falls back to legacy langs.tabs pattern.
  const [apiTabs, setApiTabs] = useState<TabDefinition[] | null>(null);
  const [activeTabId, setActiveTabId] = useState<string>('form');

  // Fetch tabs from /api/tabs (new pattern). Falls through to legacy langs.tabs if empty.
  // Re-fetched on language change: a tab's contentFile may be declared per language
  // (haivn_eip serves the EIP document and its text in both English and Vietnamese),
  // and the backend resolves which file to send from ?lang.
  useEffect(() => {
    if (!accessReady) return;
    let cancelled = false;
    apiFetch(api(`/api/tabs?lang=${encodeURIComponent(languageCode || 'en')}`))
      .then(res => res.json())
      .then(data => {
        if (!cancelled && Array.isArray(data.tabs) && data.tabs.length > 0) {
          setApiTabs(data.tabs);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [languageCode, accessReady]);

  const resolvedTabs = useMemo(
    () => resolveTabs(apiTabs, langs, { vignetteKey, addFormTab }),
    [langs, apiTabs, addFormTab, vignetteKey]);

  // Which tabs exist — not their contents. Switching vignette changes the set
  // (TEECH reveals its Physical Exams tab that way, and relies on the reselect
  // below to bring it forward); switching language only swaps each tab's content,
  // and must leave the reader where they were.
  const tabIdsKey = resolvedTabs?.map(t => t.id).join('|') ?? '';
  useEffect(() => {
    if (resolvedTabs && resolvedTabs.length > 0) {
      setActiveTabId(resolvedTabs[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabIdsKey]);
  // Mount a tab's content only after its tab has been activated once, then keep
  // it mounted (TabPanel hides inactive tabs with display:none, so scroll
  // position etc. survive tab switches exactly as before). Without this, every
  // hidden tab eagerly fetched its payload at startup — for haivn_eip that was
  // the 5 MB EIP PDF + pdf.js worker and the first legal document's full text.
  const [visitedTabIds, setVisitedTabIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    setVisitedTabIds(prev => (prev.has(activeTabId) ? prev : new Set(prev).add(activeTabId)));
  }, [activeTabId]);
  // Which view a merged document tab is showing (see mergeTabViews). Absent
  // means "the primary view", i.e. whichever edition the project declared first —
  // the PDF, for haivn_eip's EIP tab. Held here rather than inside the panel
  // because a clicked citation both selects the tab and chooses the edition.
  const [tabViews, setTabViews] = useState<Record<string, DualViewKind>>({});
  // The same defer-until-first-opened rule visitedTabIds applies to tabs, applied
  // to the second view of a merged tab: keyed `${tabId}:${view}`. The primary
  // view is always mounted with the tab, so only the alt view appears here.
  const [visitedViewKeys, setVisitedViewKeys] = useState<Set<string>>(new Set());
  const setTabView = useCallback((tabId: string, view: DualViewKind) => {
    setTabViews(prev => (prev[tabId] === view ? prev : { ...prev, [tabId]: view }));
    // Mounted in the SAME commit as the view change, deliberately: a citation
    // that opens the text edition needs the panel mounted with its scroll target
    // already in place, not one render later.
    setVisitedViewKeys(prev => {
      const key = `${tabId}:${view}`;
      return prev.has(key) ? prev : new Set(prev).add(key);
    });
  }, []);

  return {
    resolvedTabs, hasTabs: resolvedTabs !== null,
    activeTabId, setActiveTabId, visitedTabIds, tabViews, visitedViewKeys, setTabView,
  };
}

export type TabsState = ReturnType<typeof useTabs>;
