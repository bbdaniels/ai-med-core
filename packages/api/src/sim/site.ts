/**
 * The platform site, served by the API server itself: the simulator pages, the
 * landing page, the global admin page and the npj26 review page. It replaced
 * the GitHub Pages site on 2026-11-06.
 *
 * Every project that is not a talk project (resolveProjectFlags) is served at
 * `/<url-slug>/` from its Vite build in SITE_DIST_DIR/<url-slug>/, by the rule
 * in ../static-pages.ts. tools/build-site.ts writes that directory (npm run
 * build:server runs it when the image is built): the simulator builds, which
 * call `/api` on their own origin, and the landing files at its root.
 *
 * On the site host (SITE_HOST; unset or empty, every host):
 * - `/` is the landing page, `/admin/` the global admin page, `/npj26/` and
 *   `/npj26/<code>` the npj26 page; `/projects.json`, `/favicon.svg` and
 *   `/img/*` are the landing's files. All revalidate on every load.
 * - `/<slug>` answers 301 to `/<slug>/`; a slug written with `_` and a
 *   project's `urlAliases` answer 301 to the same path under the slug.
 * - Any other path with no extension answers 302 to `/`, as the Pages site's
 *   404 page did; a missing file with an extension is a 404.
 * On any other host a simulator path answers 301 to the same path and query on
 * the site host, and nothing else is touched.
 *
 * Talk paths are answered before this router (../talk/pages.ts): on the site
 * host they redirect to the talk host, except the talk pages it is told to
 * serve here too. `/api`, `/t`, `/eval` and the npj26 API routes are matched
 * before this router, which server.ts mounts last.
 */
import express from 'express';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { projectUrlSlug, resolveProjectFlags, urlAliases } from '@ai-med/chat-core';
import { DEFAULT_SITE_DIST_DIR } from '../repo-root.js';
import { PAGE_CACHE, queryOf, spaPage, type PageHandler } from '../static-pages.js';

/**
 * The talk pages the site host serves as well as the talk host. decks: the
 * published India deck frames ai-med.live/decks/, until it is republished
 * against the talk host (vault AI-MED/Tasks.md, "ai-med.live decks cutover").
 */
export const SITE_TALK_PAGES: readonly string[] = ['decks'];

export interface SiteOptions {
  /** projects/ of the checkout the server reads. */
  projectsDir: string;
  /** Project directory names (validProjectSlugs). */
  projects: Iterable<string>;
  /** The site build: landing files at its root, one `<url-slug>/` per simulator. */
  distDir: string;
  /** The host the site is served on, lower case; '' serves it on every host. */
  host: string;
}

/** The serving settings, from the environment: SITE_DIST_DIR and SITE_HOST. */
export function siteSettings(env: NodeJS.ProcessEnv): Pick<SiteOptions, 'distDir' | 'host'> {
  return {
    distDir: env.SITE_DIST_DIR?.trim() ? path.resolve(env.SITE_DIST_DIR.trim()) : DEFAULT_SITE_DIST_DIR,
    host: (env.SITE_HOST ?? '').trim().toLowerCase(),
  };
}

/** The simulator projects' url slugs and the names that redirect to them. */
export function sitePages(o: Pick<SiteOptions, 'projectsDir' | 'projects'>): {
  slugs: Set<string>;
  aliases: Map<string, string>;
} {
  const slugs = new Set<string>();
  const aliases = new Map<string, string>();
  for (const dir of [...o.projects].sort()) {
    let cfg: Record<string, any>;
    try {
      cfg = JSON.parse(readFileSync(path.join(o.projectsDir, dir, 'project.json'), 'utf-8'));
    } catch {
      continue;
    }
    if (resolveProjectFlags(cfg).app === 'talk') continue;
    const slug = projectUrlSlug(dir);
    slugs.add(slug);
    if (dir !== slug) aliases.set(dir, slug);
    for (const alias of urlAliases(cfg)) aliases.set(alias, slug);
  }
  for (const slug of slugs) aliases.delete(slug);
  return { slugs, aliases };
}

/** Names the site serves itself, never a simulator slug. */
const RESERVED = new Set(['api', 'admin', 'npj26', 'img', 't', 'eval']);
/** First path segments other routers own: the site never answers them. */
const ROUTED = new Set(['api', 't', 'eval']);

export function siteRouter(o: SiteOptions): express.Router {
  const { slugs, aliases } = sitePages(o);
  const host = o.host.trim().toLowerCase();
  const root = o.distDir;
  const router = express.Router();

  const built = [...slugs].filter(s => !RESERVED.has(s)).map(s => ({ slug: s, built: existsSync(path.join(root, s, 'index.html')) }));
  console.log(`🩺 Site${host ? ` on ${host} (SITE_HOST)` : ' on every host (SITE_HOST unset)'}: `
    + (existsSync(path.join(root, 'index.html')) ? 'landing, ' : 'no landing build, ')
    + built.map(b => b.built ? b.slug : `${b.slug} (not built)`).join(', '));

  const pages = new Map<string, PageHandler>();
  for (const b of built) if (b.built) pages.set(b.slug, spaPage(path.join(root, b.slug)));
  const admin = spaPage(path.join(root, 'admin'));
  const files = express.static(root, {
    index: false,
    redirect: false,
    fallthrough: true,
    setHeaders(res) { res.setHeader('Cache-Control', PAGE_CACHE); },
  });
  const sendFile = (res: express.Response, rel: string, next: express.NextFunction) => {
    const file = path.join(root, rel);
    if (!existsSync(file)) return next();
    res.setHeader('Cache-Control', PAGE_CACHE);
    res.sendFile(file);
  };

  router.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const onSite = !host || (req.hostname || '').toLowerCase() === host;
    const query = queryOf(req);
    const [, first = '', ...rest] = req.path.split('/');

    const slug = slugs.has(first) && !RESERVED.has(first) ? first : aliases.get(first);
    if (slug) {
      // A simulator with no build in this image is not served, nor redirected to.
      const page = pages.get(slug);
      if (!page) return next();
      const restPath = rest.length > 0 ? `/${rest.join('/')}` : '/';
      const wanted = `/${slug}${restPath}`;
      if (!onSite) return res.redirect(301, `https://${host}${wanted}${query}`);
      if (first !== slug || req.path === `/${slug}`) return res.redirect(301, `${wanted}${query}`);
      return page(req, res, next, rest, query);
    }
    if (!onSite || ROUTED.has(first)) return next();

    if (req.path === '/') return sendFile(res, 'index.html', next);
    if (first === 'admin') {
      if (req.path === '/admin') return res.redirect(301, `/admin/${query}`);
      return admin(req, res, next, rest, query);
    }
    if (first === 'npj26') {
      if (req.path === '/npj26') return res.redirect(301, `/npj26/${query}`);
      // The page reads its code from the path: /npj26/<code>.
      if (rest.length === 1 || (rest.length === 2 && rest[1] === '')) return sendFile(res, 'npj26/index.html', next);
    }

    files(req, res, (err?: unknown) => {
      if (err) return next(err);
      const last = req.path.split('/').pop() ?? '';
      if (last.includes('.')) return res.status(404).type('text/plain').send('Not found');
      res.redirect(302, '/');
    });
  });

  return router;
}
