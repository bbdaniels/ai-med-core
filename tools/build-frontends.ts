/**
 * Build the per-project frontends, one Vite build per project, from project.json.
 *
 *   npx tsx tools/build-frontends.ts --app talk --out packages/frontend-chat/dist-talk
 *   npx tsx tools/build-frontends.ts --app sim  --out _site --api-base https://api.example.com
 *
 * `--app` picks the projects: `talk` builds every project whose project.json
 * resolves to app "talk" (the talk page, src/talk-main.tsx); `sim` builds every
 * other project (the simulator page). Each lands in `<out>/<url-slug>/`, built
 * for the base path `/<url-slug>/`, where the URL slug is the directory name
 * with `_` written `-` (projectUrlSlug in @ai-med/chat-core).
 *
 * `--api-base` sets VITE_API_BASE_URL, for a page served from a host other than
 * the API's (GitHub Pages). Without it the variable is unset and the page calls
 * `/api` on its own origin, which is how the API server serves the talk pages
 * (railway.json builds them with no `--api-base`).
 *
 * A project's own static files ride along: `projects/<dir>/static/*` is copied
 * to the build's root and `projects/<dir>/images/*.png` to its `images/`.
 *
 * `--only a,b` limits the build to those project directories (each must belong
 * to the chosen app). AI_MED_REPO_ROOT, when set, names the checkout whose
 * projects/ are read, as in validate-projects.ts.
 *
 * This is the one build path for project frontends: the Pages workflow
 * (.github/workflows/deploy-pages.yml) and the API's Railway build
 * (railway.json) both call it, so the two cannot drift.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectUrlSlug, resolveProjectFlags } from '../packages/chat-core/src/project-config.js';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = process.env.AI_MED_REPO_ROOT?.trim() ? path.resolve(process.env.AI_MED_REPO_ROOT.trim()) : here;

type App = 'talk' | 'sim';

interface Args { app: App; out: string; apiBase: string | null; only: string[] | null }

function parseArgs(argv: string[]): Args {
  let app: string | null = null;
  let out: string | null = null;
  let apiBase: string | null = null;
  let only: string[] | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--app') app = value();
    else if (a === '--out') out = value();
    else if (a === '--api-base') apiBase = value().replace(/\/+$/, '');
    else if (a === '--only') only = value().split(',').map(s => s.trim()).filter(Boolean);
    else throw new Error(`unknown argument ${a}`);
  }
  if (app !== 'talk' && app !== 'sim') throw new Error('--app must be "talk" or "sim"');
  if (!out) throw new Error('--out is required');
  return { app, out: path.resolve(out), apiBase: apiBase || null, only };
}

/** The project directories that build as `app`, sorted. */
export function projectsFor(app: App, repoRoot = root): string[] {
  const dir = path.join(repoRoot, 'projects');
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'project.json')))
    .map(e => e.name)
    .filter(name => {
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, name, 'project.json'), 'utf8'));
      return (resolveProjectFlags(cfg).app === 'talk') === (app === 'talk');
    })
    .sort();
}

function copyProjectStatic(projectDir: string, dest: string): void {
  const staticDir = path.join(projectDir, 'static');
  if (fs.existsSync(staticDir)) fs.cpSync(staticDir, dest, { recursive: true });
  const images = path.join(projectDir, 'images');
  if (fs.existsSync(images)) {
    const pngs = fs.readdirSync(images).filter(f => f.endsWith('.png'));
    if (pngs.length > 0) {
      fs.mkdirSync(path.join(dest, 'images'), { recursive: true });
      for (const f of pngs) fs.copyFileSync(path.join(images, f), path.join(dest, 'images', f));
    }
  }
}

function buildOne(app: App, name: string, args: Args): void {
  const projectDir = path.join(root, 'projects', name);
  const cfg = JSON.parse(fs.readFileSync(path.join(projectDir, 'project.json'), 'utf8'));
  const slug = projectUrlSlug(name);
  const dest = path.join(args.out, slug);

  const env: NodeJS.ProcessEnv = { ...process.env };
  // Set or cleared explicitly: a value left in the caller's environment must
  // never reach a build that did not ask for it.
  delete env.VITE_API_BASE_URL;
  delete env.VITE_APP;
  if (args.apiBase) env.VITE_API_BASE_URL = args.apiBase;
  if (app === 'talk') env.VITE_APP = 'talk';
  env.VITE_PROJECT = name;
  env.VITE_BASE_PATH = `/${slug}/`;
  env.VITE_PROJECT_TITLE = typeof cfg.displayName === 'string' ? cfg.displayName : name;

  const shown = path.relative(here, dest);
  console.log(`--- ${app} ${name} -> ${shown.startsWith('..') ? dest : shown} (base /${slug}/, API ${args.apiBase ?? 'same origin'})`);
  const r = spawnSync('npm', ['-w', '@ai-med/frontend-chat', 'run', 'build', '--', '--outDir', dest, '--emptyOutDir'],
    { cwd: here, env, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`build failed for ${name} (exit ${r.status ?? r.signal})`);
  copyProjectStatic(projectDir, dest);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const all = projectsFor(args.app);
  let names = all;
  if (args.only) {
    const unknown = args.only.filter(n => !all.includes(n));
    if (unknown.length > 0) throw new Error(`not ${args.app} projects: ${unknown.join(', ')}`);
    names = args.only;
  }
  if (names.length === 0) throw new Error(`no ${args.app} projects to build`);
  fs.mkdirSync(args.out, { recursive: true });
  for (const name of names) buildOne(args.app, name, args);
  console.log(`Built ${names.length} ${args.app} frontend(s) into ${args.out}: ${names.map(projectUrlSlug).join(', ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`build-frontends: ${(e as Error).message}`);
    process.exit(1);
  }
}
