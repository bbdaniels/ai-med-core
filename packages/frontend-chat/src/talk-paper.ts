/**
 * "Talk to this paper" deep links.
 *
 * An external page (the author's publication list) links each paper to
 *   ai-med.live/papers/?paper=<url-encoded DOI>
 * and the project's public talk manifest (/api/talk-manifest/<slug>) maps each
 * DOI to a vignette key. A direct ?vignette=<key> also works and wins over
 * ?paper=, the same precedence the LTI launch branch (lti-1.3-mvp) gives its
 * instructor override.
 */

export interface TalkPaper {
  doi: string | null;
  title: string;
  vignette: string;
  year?: number | null;
  venue?: string;
  servable?: boolean;
}

/** Lower-cased bare DOI: strips a doi.org / dx.doi.org URL or a "doi:" prefix. */
export function normalizeDoi(raw: string | null | undefined): string {
  if (!raw) return '';
  let doi = raw.trim();
  try { doi = decodeURIComponent(doi); } catch { /* already decoded */ }
  doi = doi.replace(/^(https?:\/\/)?(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  return doi.trim().toLowerCase();
}

/** A ?vignette= value, or null when absent or not a plausible key. */
export function readVignetteParam(search: string): string | null {
  const key = new URLSearchParams(search).get('vignette');
  return key && /^[A-Za-z0-9_-]{1,100}$/.test(key) ? key : null;
}

/** The ?paper= value, or null. */
export function readPaperParam(search: string): string | null {
  const paper = new URLSearchParams(search).get('paper');
  return paper && paper.trim() ? paper.trim() : null;
}

/**
 * The vignette a deep link asks for: ?vignette= first, then ?paper= looked up
 * in the manifest. Null when the link names nothing, or nothing known.
 */
export function requestedVignette(search: string, papers: TalkPaper[]): string | null {
  const direct = readVignetteParam(search);
  if (direct) return direct;
  const wanted = normalizeDoi(readPaperParam(search));
  if (!wanted) return null;
  return papers.find(p => p.doi && normalizeDoi(p.doi) === wanted)?.vignette ?? null;
}
