/**
 * The evaluation dashboards, behind the project admin login.
 *
 * The daily grader (.github/workflows/eval.yml, eval/scripts/grade.py) commits
 * each project's results to projects/<slug>/eval/: index.json (every graded
 * submission's scores) and submissions/*.json (each one's full transcript, the
 * grader's notes and evidence). That is participant data, so it is served only
 * here, to an admin of that project (or a global admin), and never from a
 * static site.
 *
 * - `GET /eval/<url-slug>/` is the dashboard page (eval/dashboard: HTML, JS and
 *   CSS, which hold no data), for a project that has eval/index.json, with the
 *   project named in a meta tag. `GET /eval/<url-slug>` answers 301 to it.
 *   The page is code only; everything it shows comes from the routes below.
 * - `GET /api/admin/eval`: whether the active project has results, and the
 *   dashboard's path. The project admin page asks this to show its link.
 * - `GET /api/admin/eval/index.json` and `GET /api/admin/eval/submissions/<file>.json`:
 *   the data, for the project in X-Project, behind authenticateAdmin (whose
 *   project-scoped tokens are refused for any other project).
 *
 * The page is served from the API's own origin, so its requests carry the admin
 * cookie the login set for that origin. Every data answer is `no-store`.
 */
import express from 'express';
import { existsSync, readFileSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { projectUrlSlug } from '@ai-med/chat-core';

export interface EvalRouteOptions {
  /** projects/ of the checkout the server reads. */
  projectsDir: string;
  /** Project directory names (the server's slug allowlist). */
  projects: Iterable<string>;
  /** eval/dashboard: the page's HTML, js/ and css/. */
  dashboardDir: string;
  /** The admin authentication every /api/admin route uses. */
  authenticateAdmin: express.RequestHandler;
  /** The project the request runs under (the X-Project context), '' when none. */
  activeProject(): string;
}

/** The page's path for a project directory name. */
export function evalDashboardPath(project: string): string {
  return `/eval/${projectUrlSlug(project)}/`;
}

/** A submission file name: one path segment, no traversal, .json. */
const SUBMISSION_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.json$/;

/** The dashboard's static files, by path under the page. Nothing else is served. */
const STATIC_FILES: Record<string, string> = {
  'js/app.js': 'application/javascript; charset=utf-8',
  'css/style.css': 'text/css; charset=utf-8',
};

const PROJECT_META = '<meta name="ai-med-project" content="">';

export function evalRoutes(o: EvalRouteOptions): express.Router {
  // strict: /eval/<slug> and /eval/<slug>/ are different routes (the first redirects to the second).
  const router = express.Router({ strict: true });
  const projects = new Set(o.projects);
  const evalDir = (project: string) => path.join(o.projectsDir, project, 'eval');
  const hasEval = (project: string) => existsSync(path.join(evalDir(project), 'index.json'));

  // URL slug -> directory name, for the projects that have results.
  const byUrlSlug = new Map<string, string>();
  for (const project of projects) {
    if (hasEval(project)) byUrlSlug.set(projectUrlSlug(project), project);
  }

  const template = readFileSync(path.join(o.dashboardDir, 'index.html'), 'utf-8');
  if (!template.includes(PROJECT_META)) {
    throw new Error(`eval dashboard index.html lacks ${PROJECT_META}; the page could not name its project`);
  }

  // ── The page ──
  router.get('/eval/:slug', (req, res, next) => {
    if (!byUrlSlug.has(req.params.slug)) return next();
    const query = req.originalUrl.slice(req.path.length);
    return res.redirect(301, `/eval/${req.params.slug}/${query}`);
  });
  router.get('/eval/:slug/*', (req, res, next) => {
    const project = byUrlSlug.get(req.params.slug);
    if (!project) return next();
    const rest = (req.params as Record<string, string>)[0] ?? '';
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Robots-Tag', 'noindex');
    if (rest === '' || rest === 'index.html') {
      res.type('html');
      return res.send(template.replace(PROJECT_META,
        `<meta name="ai-med-project" content="${project}">`));
    }
    const type = STATIC_FILES[rest];
    if (!type) return res.status(404).json({ error: 'Not found' });
    res.type(type);
    return res.sendFile(path.join(o.dashboardDir, rest));
  });

  // ── The data ──
  // The active project, which must be one this deployment serves. A global
  // token with no X-Project names none and gets 400, never a default project.
  const requireProject: express.RequestHandler = (req, res, next) => {
    const project = o.activeProject();
    if (!project || !projects.has(project)) {
      return res.status(400).json({ error: 'X-Project must name a project' });
    }
    (req as any).evalProject = project;
    res.setHeader('Cache-Control', 'no-store');
    next();
  };
  const guard = [o.authenticateAdmin, requireProject];

  router.get('/api/admin/eval', ...guard, (req, res) => {
    const project: string = (req as any).evalProject;
    if (!hasEval(project)) return res.json({ available: false });
    return res.json({ available: true, dashboardPath: evalDashboardPath(project) });
  });

  router.get('/api/admin/eval/index.json', ...guard, async (req, res) => {
    const project: string = (req as any).evalProject;
    try {
      res.type('json');
      return res.send(await fs.readFile(path.join(evalDir(project), 'index.json'), 'utf-8'));
    } catch {
      return res.status(404).json({ error: 'No evaluation results for this project' });
    }
  });

  router.get('/api/admin/eval/submissions/:file', ...guard, async (req, res) => {
    const project: string = (req as any).evalProject;
    const file = req.params.file;
    if (!SUBMISSION_FILE.test(file) || file.includes('..')) {
      return res.status(400).json({ error: 'Invalid submission file name' });
    }
    try {
      res.type('json');
      return res.send(await fs.readFile(path.join(evalDir(project), 'submissions', file), 'utf-8'));
    } catch {
      return res.status(404).json({ error: 'No such submission' });
    }
  });

  return router;
}
