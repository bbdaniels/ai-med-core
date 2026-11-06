/**
 * One page build served as a single-page app: the serving rule the talk pages
 * (talk/pages.ts) and the platform site (sim/site.ts) share, so the two cannot
 * drift.
 *
 * - Vite's content-hashed files under `assets/` are cached for a year,
 *   immutable; everything else, index.html first, is `no-cache` (revalidated by
 *   ETag every load), so a deploy shows up on the next page load.
 * - A path with no file and no extension is the page's own route: it gets
 *   index.html. A missing file with an extension is a 404, never HTML.
 * - `frameAncestors`, when set, is sent as the page's Content-Security-Policy
 *   (and taken back off a 404).
 */
import express from 'express';
import path from 'path';

export const ASSET_CACHE = 'public, max-age=31536000, immutable';
export const PAGE_CACHE = 'no-cache';

/** Serves one request inside a page: `rest` is the path below the page's root, split on `/`. */
export type PageHandler = (
  req: express.Request, res: express.Response, next: express.NextFunction,
  rest: string[], query: string,
) => void;

/** The handler for the build in `root`. */
export function spaPage(root: string, frameAncestors: string | null = null): PageHandler {
  // index.html is never served by the static handler (index: false): sendIndex
  // serves it with its own headers.
  const statics = express.static(root, {
    index: false,
    redirect: false,
    fallthrough: true,
    setHeaders(res, file) {
      const rel = path.relative(root, file).split(path.sep);
      res.setHeader('Cache-Control', rel[0] === 'assets' ? ASSET_CACHE : PAGE_CACHE);
    },
  });

  return (req, res, next, rest, query) => {
    if (frameAncestors) res.setHeader('Content-Security-Policy', frameAncestors);
    const sendIndex = () => {
      res.setHeader('Cache-Control', PAGE_CACHE);
      res.sendFile(path.join(root, 'index.html'));
    };
    const restPath = rest.length > 0 ? `/${rest.join('/')}` : '/';
    if (restPath === '/' || restPath === '/index.html') return sendIndex();

    // The static handler sees the path inside the page's root.
    const url = req.url;
    req.url = `${restPath}${query}`;
    statics(req, res, (err?: unknown) => {
      req.url = url;
      if (err) return next(err);
      const last = rest[rest.length - 1] ?? '';
      if (last.includes('.')) {
        res.removeHeader('Content-Security-Policy');
        return res.status(404).type('text/plain').send('Not found');
      }
      sendIndex();
    });
  };
}

/** The query string of a request, `?` included, or ''. */
export function queryOf(req: express.Request): string {
  return req.originalUrl.slice(req.originalUrl.split('?')[0].length);
}
