/**
 * Redirect a static site's talk paths to the host that serves the talk pages.
 *
 *   npx tsx tools/build-talk-redirects.ts --out _site --to https://chat.example.com \
 *     --page-404 landing/404.html [--keep a,b]
 *
 * The API server serves every talk project's page itself, on one host
 * (packages/api/src/talk/pages.ts). A static site that used to carry copies of
 * those pages (GitHub Pages, for one) keeps its old links working with this:
 *
 * - `<out>/<url-slug>/index.html` for every talk project, a stub that replaces
 *   the location with the same path, query and fragment on `--to`, with a
 *   noscript link for a browser without JavaScript;
 * - `<out>/404.html`, written from the `--page-404` template with the talk
 *   slugs and every project's `urlAliases` filled in at its TALK_REDIRECTS
 *   marker, so a deeper path (`/<slug>/anything`) and an alias go the same way.
 *   The alias goes straight to its project's slug.
 *
 * `--keep` names talk project directories the site still builds itself; they
 * get no stub and are left out of the 404 map, and each must be a talk project
 * whose build is already in `<out>/<url-slug>/`.
 *
 * The tool names no host: `--to` is required. Project URL slugs and aliases are
 * read from projects/<dir>/project.json, as everywhere else (projectUrlSlug,
 * urlAliases in @ai-med/chat-core). AI_MED_REPO_ROOT, when set, names the
 * checkout whose projects/ are read, as in build-frontends.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectUrlSlug, resolveProjectFlags, urlAliases } from '../packages/chat-core/src/project-config.js';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = process.env.AI_MED_REPO_ROOT?.trim() ? path.resolve(process.env.AI_MED_REPO_ROOT.trim()) : here;

/** The marker in the 404 template that the map replaces, with its inert default. */
export const TALK_REDIRECTS_MARKER = /\/\*TALK_REDIRECTS\*\/\s*\{[^\n]*\}/;

export interface TalkRedirects {
  /** The origin talk paths go to, e.g. https://chat.example.com (no trailing slash). */
  to: string;
  /** First path segment (a URL slug or an alias) -> the URL slug it lands on. */
  slugs: Record<string, string>;
}

/** The talk projects (directory names, sorted) under projects/. */
export function talkProjects(repoRoot = root): string[] {
  const dir = path.join(repoRoot, 'projects');
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'project.json')))
    .map(e => e.name)
    .filter(name => resolveProjectFlags(readConfig(repoRoot, name)).app === 'talk')
    .sort();
}

function readConfig(repoRoot: string, name: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'projects', name, 'project.json'), 'utf8'));
}

/** The redirect map for every talk project not kept: its slug and its aliases. */
export function talkRedirects(to: string, keep: readonly string[], repoRoot = root): TalkRedirects {
  const origin = new URL(to);
  if (origin.protocol !== 'https:' && origin.protocol !== 'http:') throw new Error(`--to must be an http(s) origin: ${to}`);
  if (origin.pathname !== '/' || origin.search || origin.hash) throw new Error(`--to must be an origin with no path: ${to}`);
  const talk = talkProjects(repoRoot);
  const notTalk = keep.filter(k => !talk.includes(k));
  if (notTalk.length > 0) throw new Error(`--keep names projects that are not talk projects: ${notTalk.join(', ')}`);
  const slugs: Record<string, string> = {};
  for (const name of talk) {
    if (keep.includes(name)) continue;
    const slug = projectUrlSlug(name);
    slugs[slug] = slug;
    for (const alias of urlAliases(readConfig(repoRoot, name))) slugs[alias] = slug;
  }
  return { to: origin.origin, slugs };
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The stub served at `/<slug>/` and `/<slug>/index.html`. */
export function stubHtml(to: string, slug: string): string {
  const target = `${to}/${slug}/`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="robots" content="noindex">
  <title>Moved</title>
  <link rel="canonical" href="${escapeHtml(target)}">
  <script>
    // This page moved to ${to}. The same path, query and fragment, so a
    // deep link (?paper=, #code=, ?lang=) arrives intact.
    location.replace(${JSON.stringify(to)} + location.pathname + location.search + location.hash);
  </script>
</head>
<body>
  <noscript><p>This page has moved to <a href="${escapeHtml(target)}">${escapeHtml(target)}</a>.</p></noscript>
</body>
</html>
`;
}

/** The 404 template with the map in place of its marker. */
export function page404(template: string, map: TalkRedirects): string {
  if (!TALK_REDIRECTS_MARKER.test(template)) throw new Error('the 404 template has no /*TALK_REDIRECTS*/ {...} marker');
  return template.replace(TALK_REDIRECTS_MARKER, () => `/*TALK_REDIRECTS*/ ${JSON.stringify(map)}`);
}

interface Args { out: string; to: string; page404: string; keep: string[] }

function parseArgs(argv: string[]): Args {
  const o: Partial<Args> = { keep: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--out') o.out = path.resolve(value());
    else if (a === '--to') o.to = value();
    else if (a === '--page-404') o.page404 = path.resolve(value());
    else if (a === '--keep') o.keep = value().split(',').map(s => s.trim()).filter(Boolean);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.out || !o.to || !o.page404) {
    throw new Error('usage: build-talk-redirects.ts --out <dir> --to <origin> --page-404 <template> [--keep a,b]');
  }
  return o as Args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const map = talkRedirects(args.to, args.keep);
  for (const name of args.keep) {
    const built = path.join(args.out, projectUrlSlug(name), 'index.html');
    if (!fs.existsSync(built)) throw new Error(`--keep ${name}: no build at ${built}; build it before this step`);
  }
  const slugs = [...new Set(Object.values(map.slugs))].sort();
  for (const slug of slugs) {
    const dir = path.join(args.out, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), stubHtml(map.to, slug));
  }
  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(path.join(args.out, '404.html'), page404(fs.readFileSync(args.page404, 'utf8'), map));
  const aliases = Object.entries(map.slugs).filter(([k, v]) => k !== v).map(([k, v]) => `${k} -> ${v}`);
  console.log(`Talk redirects to ${map.to}: ${slugs.join(', ')}${aliases.length ? `; aliases ${aliases.join(', ')}` : ''}`
    + `${args.keep.length ? `; kept on this site: ${args.keep.map(projectUrlSlug).join(', ')}` : ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`build-talk-redirects: ${(e as Error).message}`);
    process.exit(1);
  }
}
