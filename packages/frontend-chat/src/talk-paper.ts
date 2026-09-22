/**
 * "Talk to this paper" deep links.
 *
 * The author's publication list opens each paper's popout on an iframe of
 *   ai-med.live/papers/?paper=<url-encoded DOI>
 * and the project's public talk manifest (/api/talk-manifest/<slug>) maps each
 * DOI to a vignette key. A direct ?vignette=<key> also works and wins over
 * ?paper=, the same precedence the LTI launch branch (lti-1.3-mvp) gives its
 * instructor override.
 *
 * A project may also declare talkPublicUrl: the author's own page is the public
 * front door, and this app is only the backend behind its popout iframe. Opened
 * top-level (not in a frame), the app then leaves for that page at once; see
 * publicRedirectUrl().
 */

import { normalizeDoi, fillTalkPublicUrl } from '../../shared/src/talk-url';

export { normalizeDoi, doiSlug, fillTalkPublicUrl } from '../../shared/src/talk-url';

export interface TalkPaper {
  doi: string | null;
  title: string;
  vignette: string;
  year?: number | null;
  venue?: string;
  servable?: boolean;
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

/** The manifest paper a deep link asks for, by the same precedence as requestedVignette(). */
export function requestedPaper(search: string, papers: TalkPaper[]): TalkPaper | null {
  const key = requestedVignette(search, papers);
  return key ? papers.find(p => p.vignette === key) ?? null : null;
}

/**
 * Where a top-level (unframed) visit to a talkPublicUrl project goes: the
 * template filled for the paper the link names, or, when it names none or one
 * the manifest does not know (or one with no DOI), the template with its
 * fragment stripped.
 */
export function publicRedirectUrl(template: string, search: string, papers: TalkPaper[]): string {
  return fillTalkPublicUrl(template, requestedPaper(search, papers)?.doi);
}
