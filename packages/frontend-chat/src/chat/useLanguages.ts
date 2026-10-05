// The project's languages file (GET /api/languages), the reader's language,
// and the t() lookup over it.
//
// The API is the ONLY source: the served copy lives in the database and the
// admin Translations tab edits it there, so a build-time static copy would be a
// second source that silently goes stale. (A fallback to
// `${BASE_URL}languages.json` used to sit here; no build ever published that
// file, so it 404'd on every project and only delayed setLangs(null).)

import { useEffect, useMemo, useState } from 'react';
import { api, apiFetch } from '../api-base';
import { resolveInitialLanguage } from '../lang-boot';
import type { LanguageDef, LanguageUISection, LanguagesJson } from './types';

export type UiSection = 'welcome' | 'chat' | 'feedback';
export type Translate = <S extends UiSection, K extends keyof NonNullable<LanguageUISection[S]>>(section: S, key: K) => string;

/**
 * `titlesUnlocked`: a gated project's per-vignette titles (vignetteInfo) are
 * withheld until the access token is held, so the file is fetched again when
 * this turns true.
 */
export function useLanguages(titlesUnlocked: boolean) {
  const [langs, setLangs] = useState<LanguagesJson | null>(null);
  const [selectedLanguageCode, setSelectedLanguageCode] = useState<string>(() => {
    try {
      return resolveInitialLanguage(
        window.location.search,
        localStorage.getItem('lang_code'),
        navigator.languages ?? [navigator.language],
      );
    } catch { return 'en' }
  });

  useEffect(() => {
    apiFetch(api('/api/languages'))
      .then(res => res.json())
      .then((data: LanguagesJson) => setLangs(data))
      .catch(() => setLangs(null));
  }, [titlesUnlocked]);

  // Once the project's languages load, validate the boot candidate against them.
  // An unoffered code is re-resolved through the same chain WITH the list
  // (?lang= > saved > browser > first language), so e.g. an unsupported ?lang=
  // still honors the saved choice instead of jumping straight to the first
  // language. Only a validated code is persisted: writing the raw boot
  // candidate would overwrite the saved choice before it could be consulted.
  useEffect(() => {
    if (!langs || !langs.languages || langs.languages.length === 0) return;
    const codes = langs.languages.map((l: LanguageDef) => l.code);
    if (codes.includes(selectedLanguageCode)) {
      try { localStorage.setItem('lang_code', selectedLanguageCode) } catch {}
      return;
    }
    let saved: string | null = null;
    try { saved = localStorage.getItem('lang_code') } catch {}
    const next = resolveInitialLanguage(
      window.location.search, saved, navigator.languages ?? [navigator.language], codes);
    console.log(`Language code '${selectedLanguageCode}' not offered, switching to '${next}'`);
    setSelectedLanguageCode(next);
  }, [langs, selectedLanguageCode]);

  const selectedLanguageName = useMemo(() => {
    const list = langs?.languages || [];
    const found = list.find((l: LanguageDef) => l.code === selectedLanguageCode);
    // If selected code not found, fall back to first language or 'English'
    return found?.name || list[0]?.name || 'English';
  }, [langs, selectedLanguageCode]);

  // Starter questions come from languages.json (chat.starterQuestions), so they
  // localize with everything else and need no extra endpoint.
  const starterQuestions = useMemo<string[]>(() => {
    const code = selectedLanguageCode || 'en';
    const raw = (langs?.ui?.[code]?.chat as { starterQuestions?: unknown } | undefined)?.starterQuestions
      ?? (langs?.ui?.['en']?.chat as { starterQuestions?: unknown } | undefined)?.starterQuestions;
    return Array.isArray(raw) ? raw.filter((q): q is string => typeof q === 'string') : [];
  }, [langs, selectedLanguageCode]);

  // Tiny translation helper: the selected language, then English, then ''.
  const t: Translate = (section, key) => {
    const code = selectedLanguageCode || 'en';
    // K is a key of the section S, but TypeScript cannot index the union of
    // section types with it, so read through a record view of the section.
    const localized = langs?.ui?.[code]?.[section] as Record<typeof key, unknown> | undefined;
    const fallback = langs?.ui?.['en']?.[section] as Record<typeof key, unknown> | undefined;
    const value = localized?.[key] ?? fallback?.[key];
    return typeof value === 'string' ? (value as string) : '';
  };

  return { langs, selectedLanguageCode, setSelectedLanguageCode, selectedLanguageName, starterQuestions, t };
}

/** The tab title: the project's welcome title, after the open paper's title when there is one. */
export function useDocumentTitle(langs: LanguagesJson | null, languageCode: string, paperTitle: string | undefined) {
  useEffect(() => {
    const title = langs?.ui?.[languageCode]?.welcome?.title
      || langs?.ui?.[langs.languages?.[0]?.code]?.welcome?.title;
    if (paperTitle) document.title = title ? `${paperTitle} | ${title}` : paperTitle;
    else if (title) document.title = title;
  }, [langs, languageCode, paperTitle]);
}
