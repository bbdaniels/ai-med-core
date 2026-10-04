/**
 * Which language a language NAME means.
 *
 * A chat request names its language as the page shows it, from the project's
 * languages list ("Tiếng Việt", "Español"); a project.json names a corpus
 * language in English ("Vietnamese"); either may arrive as a bare code. They
 * are compared by resolving each to a code through the project's own languages
 * list (languages.json, as /api/languages serves it): a name matches an entry
 * by its code, by the name the list gives it, or by the entry's English name
 * from the runtime's CLDR data (Intl.DisplayNames). No language is spelled out
 * here, so a project that adds a language needs no code change.
 */

/** One entry of a languages.json `languages` array. */
export interface LanguageEntry { code: string; name: string }

/** The `languages` array of a languages.json text; [] when absent or unreadable. */
export function parseLanguageList(json: string | null | undefined): LanguageEntry[] {
  if (!json) return [];
  try {
    const list = JSON.parse(json)?.languages;
    return Array.isArray(list)
      ? list.filter((l: any) => l && typeof l.code === 'string' && typeof l.name === 'string')
        .map((l: any) => ({ code: l.code, name: l.name }))
      : [];
  } catch {
    return [];
  }
}

/** Case, diacritics and spacing folded away: "Tiếng  Việt" and "tieng viet" compare equal. */
function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
}

const english = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }); } catch { return null; }
})();

function englishName(code: string): string | null {
  try { return english?.of(code) ?? null; } catch { return null; }
}

/** The code of the entry `name` means, or null when it is none of them. */
export function languageCode(name: string | null | undefined, languages: LanguageEntry[]): string | null {
  const wanted = fold(name ?? '');
  if (!wanted) return null;
  for (const l of languages) {
    for (const form of [l.code, l.name, englishName(l.code)]) {
      if (form && fold(form) === wanted) return l.code;
    }
  }
  return null;
}

/**
 * Whether two language names mean the same language. Names the list resolves
 * are compared by code; otherwise the folded names are compared, so two
 * spellings of a language the list does not hold still match themselves.
 */
export function sameLanguage(a: string | null | undefined, b: string | null | undefined,
                             languages: LanguageEntry[]): boolean {
  if (!a || !b) return false;
  const ca = languageCode(a, languages);
  const cb = languageCode(b, languages);
  if (ca && cb) return ca === cb;
  return fold(a) === fold(b);
}
