// Initial-language resolution: ?lang= URL param, then the saved choice, then
// the browser's preferred locales (primary subtag), then the project's first
// language. Called twice. At boot the project's language list has not loaded,
// so `available` is omitted and the result is only a CANDIDATE (the first
// well-formed code in that order, else 'en'). Once /api/languages answers,
// App.tsx calls it again WITH the list, and every step is checked against it:
// a ?lang= the project does not offer falls through to the saved choice, a
// saved code from another project on the same origin falls through to the
// browser, and a browser locale counts only if the project offers it.
const CODE_RE = /^[a-z]{2,3}$/;

export function resolveInitialLanguage(
  search: string,
  saved: string | null,
  browserLangs: readonly string[],
  available?: readonly string[],
): string {
  const ok = (code: string | null | undefined): code is string =>
    !!code && CODE_RE.test(code) && (!available || available.includes(code));
  const urlLang = new URLSearchParams(search).get('lang')?.trim().toLowerCase();
  if (ok(urlLang)) return urlLang;
  const savedLang = saved?.trim().toLowerCase();
  if (ok(savedLang)) return savedLang;
  for (const bl of browserLangs) {
    const primary = bl?.split('-')[0]?.trim().toLowerCase();
    if (ok(primary)) return primary;
  }
  return available?.[0] ?? 'en';
}
