/**
 * The talk pages, served by the API server itself on one origin with `/api`.
 *
 * Every project whose project.json resolves to app "talk" is served at
 * `/<url-slug>/` (projectUrlSlug: the directory name with `_` written `-`) from
 * its Vite build in TALK_DIST_DIR/<url-slug>/, which `tools/build-frontends.ts
 * --app talk` writes (npm run build:server runs it at build time). A simulator project is
 * never served here, even if a build of it sits in that directory: simulators
 * are served by the platform site on its own host (../sim/site.ts).
 *
 * - `GET /<slug>` answers 301 to `/<slug>/`; a project's `urlAliases` answer 301
 *   to the same path under its slug.
 * - Each page is served by the rule in ../static-pages.ts (hashed assets cached
 *   for a year, everything else revalidated; a route inside the page gets
 *   index.html; a missing file is a 404).
 * - A project that declares `embedOrigins` may be framed only by its own origin
 *   and those: `Content-Security-Policy: frame-ancestors 'self' <origins>`. A
 *   project that declares none sends no frame-ancestors (an LMS, for one, frames
 *   it from an origin that cannot be listed).
 * - With a canonical host set, a talk path asked of any other host (the API's
 *   own domains, the platform domain) answers 301 to the same path and query on
 *   the canonical host, and `/` on the canonical host answers 302 to the home
 *   URL. The exception is `sitePages` on `siteHost`, served there too.
 *   Nothing outside the talk paths and `/` is touched, so `/api`, `/t` and
 *   `/npj26` answer on every host exactly as before.
 *
 * The router reads every project.json once, at startup, as the slug allowlist
 * in server.ts does; a new talk project needs a redeploy, which its build does
 * anyway. Settings come from the environment (talkPagesSettings).
 */
import express from 'express';
import { existsSync, readFileSync } from 'fs';
import { spaPage, queryOf, type PageHandler } from '../static-pages.js';
import path from 'path';
import { projectUrlSlug, resolveProjectFlags, urlAliases } from '@ai-med/chat-core';
import { DEFAULT_TALK_DIST_DIR } from '../repo-root.js';

/**
 * The serving settings, from the environment:
 * - TALK_DIST_DIR: the builds (default packages/frontend-chat/dist-talk);
 * - TALK_CANONICAL_HOST: the one host talk pages answer on. Unset or empty,
 *   there is none: pages answer on every host the server answers on, in any
 *   NODE_ENV. The engine names no deployment's host; a deployment sets its own;
 * - TALK_HOME_URL: where `/` on the canonical host goes. Unset or empty, `/` is
 *   left alone.
 */
export function talkPagesSettings(env: NodeJS.ProcessEnv): Pick<TalkPagesOptions, 'distDir' | 'canonicalHost' | 'homeUrl'> {
  return {
    distDir: env.TALK_DIST_DIR?.trim() ? path.resolve(env.TALK_DIST_DIR.trim()) : DEFAULT_TALK_DIST_DIR,
    canonicalHost: (env.TALK_CANONICAL_HOST ?? '').trim().toLowerCase(),
    homeUrl: (env.TALK_HOME_URL ?? '').trim(),
  };
}

/** The boot log line that says which host settings are in force. */
export function talkHostSummary(o: Pick<TalkPagesOptions, 'canonicalHost' | 'homeUrl'>): string {
  const canonical = o.canonicalHost.trim().toLowerCase();
  const homeUrl = o.homeUrl.trim();
  if (!canonical) {
    return `💬 Talk pages: no canonical host (TALK_CANONICAL_HOST unset), served on every host${homeUrl ? '; TALK_HOME_URL ignored without it' : ''}`;
  }
  return `💬 Talk pages: canonical host ${canonical} (TALK_CANONICAL_HOST); `
    + (homeUrl ? `/ there redirects to ${homeUrl} (TALK_HOME_URL)` : '/ there is left alone (TALK_HOME_URL unset)');
}

export interface TalkPagesOptions {
  /** projects/ of the checkout the server reads. */
  projectsDir: string;
  /** Project directory names (validProjectSlugs). */
  projects: Iterable<string>;
  /** Where the talk builds are: one `<url-slug>/` per project. */
  distDir: string;
  /** The host talk pages are served on, lower case; '' serves them on every host. */
  canonicalHost: string;
  /** Where `/` on the canonical host goes; '' leaves `/` alone. */
  homeUrl: string;
  /**
   * The platform site's host (sim/site.ts, SITE_HOST) and the talk pages
   * served there as well as on the canonical host (url slugs): a page framed
   * at a site address that cannot change yet. Every other talk path on the
   * site host redirects to the canonical host as on any other host.
   */
  siteHost?: string;
  sitePages?: Iterable<string>;
}

interface TalkPage {
  dir: string;
  slug: string;
  root: string;
  built: boolean;
  frameAncestors: string | null;
}

/** The talk projects and the aliases that point at them, read from project.json. */
export function talkPages(o: Pick<TalkPagesOptions, 'projectsDir' | 'projects' | 'distDir'>): {
  pages: Map<string, TalkPage>;
  aliases: Map<string, string>;
} {
  const pages = new Map<string, TalkPage>();
  const aliasesWanted: [string, string][] = [];
  for (const dir of [...o.projects].sort()) {
    let cfg: Record<string, any>;
    try {
      cfg = JSON.parse(readFileSync(path.join(o.projectsDir, dir, 'project.json'), 'utf-8'));
    } catch {
      continue;
    }
    const flags = resolveProjectFlags(cfg);
    if (flags.app !== 'talk') continue;
    const slug = projectUrlSlug(dir);
    const root = path.join(o.distDir, slug);
    pages.set(slug, {
      dir,
      slug,
      root,
      built: existsSync(path.join(root, 'index.html')),
      frameAncestors: flags.embedOrigins.length > 0 ? `frame-ancestors 'self' ${flags.embedOrigins.join(' ')}` : null,
    });
    for (const alias of urlAliases(cfg)) aliasesWanted.push([alias, slug]);
  }
  const aliases = new Map<string, string>();
  for (const [alias, slug] of aliasesWanted) {
    // validate-projects refuses a clash; a server never lets one shadow a page.
    if (pages.has(alias) || aliases.has(alias)) {
      console.warn(`⚠️ Talk URL alias ${alias} ignored: it is taken`);
      continue;
    }
    aliases.set(alias, slug);
  }
  return { pages, aliases };
}

export function talkPagesRouter(o: TalkPagesOptions): express.Router {
  const { pages, aliases } = talkPages(o);
  const canonical = o.canonicalHost.trim().toLowerCase();
  const homeUrl = o.homeUrl.trim();
  const router = express.Router();

  console.log(talkHostSummary(o));
  if (pages.size > 0) {
    const listed = [...pages.values()].map(p => p.built ? p.slug : `${p.slug} (not built)`);
    console.log(`💬 Talk pages${canonical ? ` on ${canonical}` : ''}: ${listed.join(', ')}`);
  }

  const handlers = new Map<string, PageHandler>();
  for (const page of pages.values()) handlers.set(page.slug, spaPage(page.root, page.frameAncestors));
  const siteHost = (o.siteHost ?? '').trim().toLowerCase();
  const sitePages = new Set(o.sitePages ?? []);

  router.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const host = (req.hostname || '').toLowerCase();

    if (req.path === '/') {
      if (canonical && host === canonical && homeUrl) return res.redirect(302, homeUrl);
      return next();
    }

    const [, first = '', ...rest] = req.path.split('/');
    const slug = pages.has(first) ? first : aliases.get(first);
    if (!slug) return next();
    const page = pages.get(slug)!;
    const onCanonical = !canonical || host === canonical
      || (siteHost !== '' && host === siteHost && sitePages.has(slug));

    const query = queryOf(req);
    const restPath = rest.length > 0 ? `/${rest.join('/')}` : '/';
    const wanted = `/${slug}${restPath}`;
    if (!onCanonical) return res.redirect(301, `https://${canonical}${wanted}${query}`);
    if (first !== slug || req.path === `/${slug}`) return res.redirect(301, `${wanted}${query}`);
    if (!page.built) return next();
    handlers.get(slug)!(req, res, next, rest, query);
  });

  return router;
}
