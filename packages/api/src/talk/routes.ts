/**
 * Document chat's HTTP surface in the API: the public talk manifest and the
 * public-chat kill switch for projects that publish one.
 *
 * The manifest router must be mounted BEFORE the global allowlisted CORS
 * middleware (`app.use('/api', cors(corsOptions))` in server.ts): it is the one
 * route open to any origin and answers the request itself. The papers
 * characterization case `talk-manifest-cors` pins that order.
 */
import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fillTalkPublicUrl } from '@ai-med/chat-core/talk-url';
import { isPublicChatEnabled } from '../database.js';
import { REPO_ROOT } from '../repo-root.js';

export interface TalkRouteDeps {
  /** Whether this deployment serves the project (server.ts's slug allowlist). */
  isValidProject(slug: string): boolean;
  /** The project's project.json, parsed and cached by the server ({} when absent). */
  readProjectConfig(slug: string): Promise<Record<string, any>>;
  /** The project a request names in X-Project. */
  requestProjectSlug(req: express.Request): string;
}

export function talkRoutes(deps: TalkRouteDeps): {
  manifestRouter: express.Router;
  requirePublicChatIfDeclared: express.RequestHandler;
} {
  const router = express.Router();

  // Public talk manifest: which papers a talkManifest project offers, fetched by
  // third-party pages to decide whether to render "Talk to this paper" buttons.
  // It is the ONE route open to any origin, so it is registered before the global
  // allowlisted CORS middleware and answers the request itself; the global policy
  // is not widened. It carries no credentials and nothing a browser could abuse.
  const talkManifestCors = cors({ origin: '*', methods: ['GET', 'OPTIONS'], maxAge: 86400 });
  router.options('/api/talk-manifest/:slug', talkManifestCors);
  router.get('/api/talk-manifest/:slug', talkManifestCors, async (req, res) => {
    const slug = req.params.slug;
    if (!deps.isValidProject(slug)) return res.status(404).json({ error: 'Unknown project' });
    const config = await deps.readProjectConfig(slug);
    if (typeof config.talkManifest !== 'string' || !config.talkManifest) {
      return res.status(404).json({ error: 'Project has no talk manifest' });
    }
    let enabled = false;
    try {
      enabled = await isPublicChatEnabled(slug);
    } catch (err) {
      console.error(`[talk-manifest] could not read public_chat for ${slug}; treating as off:`, err);
    }
    if (!enabled) {
      res.set('Cache-Control', 'no-store');
      return res.json({ papers: [] });
    }
    const manifest = await readTalkManifest(slug, config.talkManifest);
    // talkPublicUrl projects: each paper also carries its canonical public link
    // (the author's page with that paper's popout open), filled server side.
    const template = typeof config.talkPublicUrl === 'string' ? config.talkPublicUrl : '';
    const papers = template
      ? manifest.papers.map(p => (p && typeof p === 'object'
        ? { ...p, publicUrl: fillTalkPublicUrl(template, (p as { doi?: string | null }).doi) }
        : p))
      : manifest.papers;
    res.set('Cache-Control', 'public, max-age=300');
    return res.json({ papers });
  });

  // ── Public-chat kill switch ──────────────────────────────────────────
  //
  // A project that declares `talkManifest` in project.json is reachable from
  // third-party pages ("Talk to this paper" buttons). Its `public_chat` project
  // setting (default off) turns it on and off from the global admin page with no
  // redeploy. Off empties the public manifest, so the external site renders no
  // buttons, AND closes every LLM-calling route, so bookmarked links stop working.
  // Projects without `talkManifest` never reach the setting lookup.

  const requirePublicChatIfDeclared: express.RequestHandler = async (req, res, next) => {
    const slug = deps.requestProjectSlug(req);
    const config = await deps.readProjectConfig(slug);
    if (!config.talkManifest) return next();
    let enabled = false;
    try {
      enabled = await isPublicChatEnabled(slug);
    } catch (err) {
      // Fail closed: a settings-read failure must not open a switched-off project.
      console.error(`[public-chat] could not read public_chat for ${slug}; treating as off:`, err);
    }
    if (enabled) return next();
    return res.status(503).json({
      error: 'This assistant is currently switched off.',
      code: 'public_chat_disabled',
    });
  };

  return { manifestRouter: router, requirePublicChatIfDeclared };
}

/**
 * The manifest a talkManifest project publishes: `{ papers: [{doi, title, vignette}] }`.
 * Never throws: a missing or malformed file is logged and read as no papers.
 */
export async function readTalkManifest(slug: string, relPath: string): Promise<{ papers: unknown[] }> {
  try {
    const resolved = path.resolve(REPO_ROOT, relPath);
    if (!resolved.startsWith(path.join(REPO_ROOT, 'projects') + path.sep)) {
      console.error(`[talk-manifest] ${slug}: talkManifest path escapes projects/: ${relPath}`);
      return { papers: [] };
    }
    const parsed = JSON.parse(await fs.readFile(resolved, 'utf-8'));
    if (!parsed || !Array.isArray(parsed.papers)) {
      console.error(`[talk-manifest] ${slug}: ${relPath} has no "papers" array`);
      return { papers: [] };
    }
    return { papers: parsed.papers };
  } catch (err) {
    console.error(`[talk-manifest] ${slug}: could not read ${relPath}:`, err);
    return { papers: [] };
  }
}
