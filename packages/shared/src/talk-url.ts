/**
 * DOI normalization and "Talk to this paper" public-URL templates.
 *
 * One implementation for both the frontend (manifest matching, the top-level
 * redirect in talk-paper.ts) and the API (the per-paper publicUrl it adds to
 * GET /api/talk-manifest/:slug). Both import this file by relative path: the
 * API bundle treats package imports as external, and a runtime import of a
 * .ts package would fail under plain node.
 *
 * The slug must match orcid-display's slugForWork() character for character,
 * because the author's publications page opens a paper's popout from
 * #talk-doi-<slug>.
 */

/** Lower-cased bare DOI: strips a doi.org / dx.doi.org URL or a "doi:" prefix. */
export function normalizeDoi(raw: string | null | undefined): string {
  if (!raw) return '';
  let doi = raw.trim();
  try { doi = decodeURIComponent(doi); } catch { /* already decoded */ }
  doi = doi.replace(/^(https?:\/\/)?(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  return doi.trim().toLowerCase();
}

/** orcid-display's slug: the normalized DOI with every run outside [a-z0-9] collapsed to '-', trimmed. */
export function doiSlug(raw: string | null | undefined): string {
  return normalizeDoi(raw).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Fill a project's talkPublicUrl template for one paper: {slug} → doiSlug(doi),
 * {doi} → the URL-encoded normalized DOI. With no usable DOI the result is the
 * template with its fragment stripped (the public page with no popout open).
 */
export function fillTalkPublicUrl(template: string, doi: string | null | undefined): string {
  const bare = normalizeDoi(doi);
  const slug = doiSlug(bare);
  if (!bare || !slug) return template.split('#')[0];
  return template.replace(/\{slug\}/g, slug).replace(/\{doi\}/g, encodeURIComponent(bare));
}
