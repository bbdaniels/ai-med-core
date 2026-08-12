// Boot-time initial-language candidate: ?lang= URL param, then the saved
// choice, then the browser locale's primary subtag, then 'en'. Returns a
// CANDIDATE only — App.tsx's auto-correct effect validates it against the
// project's loaded language list and snaps unknown codes to the project's
// first language, so no list is needed (or available) this early in boot.
const CODE_RE = /^[a-z]{2,3}$/;

export function resolveInitialLanguage(
  search: string,
  saved: string | null,
  browserLangs: readonly string[],
): string {
  const urlLang = new URLSearchParams(search).get('lang')?.trim().toLowerCase();
  if (urlLang && CODE_RE.test(urlLang)) return urlLang;
  if (saved) return saved;
  for (const bl of browserLangs) {
    const primary = bl?.split('-')[0]?.trim().toLowerCase();
    if (primary && CODE_RE.test(primary)) return primary;
  }
  return 'en';
}
