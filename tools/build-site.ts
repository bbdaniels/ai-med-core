/**
 * Build the platform site the API server serves (packages/api/src/sim/site.ts).
 *
 *   npx tsx tools/build-site.ts --out packages/frontend-chat/dist-site
 *
 * Writes, into `--out` (emptied first):
 * - every simulator frontend at `<url-slug>/` (tools/build-frontends.ts --app
 *   sim, with no `--api-base`: the pages call `/api` on their own origin);
 * - the landing files: `index.html`, `admin/index.html`, `npj26/index.html`,
 *   `favicon.svg`, `img/`, from landing/;
 * - `projects.json`, the landing and admin pages' project list, from every
 *   projects/<dir>/project.json.
 *
 * Evaluation results (projects/<slug>/eval/) hold participant transcripts and
 * never go into the site: the API serves them behind the admin login
 * (packages/api/src/sim/eval.ts). The build fails if any reach `--out`.
 *
 * `npm run build:server` runs this when the API image is built (Dockerfile).
 * It replaced the GitHub Pages build in .github/workflows/deploy-pages.yml on
 * 2026-11-06.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectUrlSlug } from '../packages/chat-core/src/project-config.js';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** The landing and admin pages' project list (was inline in deploy-pages.yml). */
export function projectsJson(repo: string): { projects: Record<string, unknown>[] } {
  const projectsDir = path.join(repo, 'projects');
  const dirs = fs.readdirSync(projectsDir)
    .filter(d => fs.existsSync(path.join(projectsDir, d, 'project.json')))
    .sort();
  const projects = dirs.map(name => {
    const p = readJson(path.join(projectsDir, name, 'project.json'));
    const profilesByTemplate: Record<string, any> = {};
    // Vignettes grouped by template (explicit field, else the file path).
    const grouped: Record<string, { template: string; templateTitle: string; variants: unknown[] }> = {};
    for (const v of (p.cases?.vignettes || [])) {
      const parts = String(v.file).split('/');
      const tmpl = v.template || (parts.length >= 4 ? parts[parts.length - 2] : '_manual');
      if (!grouped[tmpl]) {
        let title = tmpl;
        try { title = readJson(path.join(repo, 'cases', tmpl, 'meta.json')).title; } catch { /* no meta */ }
        try {
          for (const pr of readJson(path.join(projectsDir, name, 'cases', tmpl, 'profiles.json'))) profilesByTemplate[pr.id] = pr;
        } catch { /* no profiles */ }
        grouped[tmpl] = { template: tmpl, templateTitle: title, variants: [] };
      }
      const profile = v.profileId ? profilesByTemplate[v.profileId] || null : null;
      grouped[tmpl].variants.push({
        key: v.key, title: v.title, file: v.file, profileId: v.profileId || null,
        profile: profile ? Object.fromEntries(Object.entries(profile).filter(([k]) => k !== 'id')) : null,
      });
    }
    const hasEval = fs.existsSync(path.join(projectsDir, name, 'eval', 'index.json'));
    const hasRubrics = Object.keys(grouped).some(tmpl => {
      try {
        return fs.readdirSync(path.join(projectsDir, name, 'cases', tmpl))
          .some(f => f.endsWith('_rubric.json') || f.endsWith('_checklist.json'));
      } catch { return false; }
    });
    const slug = projectUrlSlug(name);
    return {
      name: p.name,
      slug,
      displayName: p.displayName,
      frontend: p.frontend,
      languages: p.languages,
      cases: Object.values(grouped),
      kobo: p.kobo ? { formUid: p.kobo.formUid, formUrl: p.kobo.formUrl } : null,
      adminUrl: slug + '/admin',
      hasEval,
      enableFeedback: !!p.enableFeedback,
      enableVoice: !!p.enableVoice,
      hasRubrics,
    };
  });
  return { projects };
}

/** Files under `dir` that look like evaluation data; none may be in the site. */
export function evalLeaks(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'eval' || e.name === 'submissions') found.push(p);
        else walk(p);
      } else if (e.name.endsWith('.json') && fs.readFileSync(p, 'utf8').includes('"transcript_file"')) {
        found.push(p);
      }
    }
  };
  walk(dir);
  return found;
}

function main(): void {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--out');
  if (i < 0 || !argv[i + 1] || argv.length !== 2) throw new Error('usage: build-site.ts --out <dir>');
  const out = path.resolve(argv[i + 1]);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const r = spawnSync('npx', ['tsx', path.join(here, 'tools/build-frontends.ts'), '--app', 'sim', '--out', out],
    { cwd: here, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`simulator builds failed (exit ${r.status ?? r.signal})`);

  const landing = path.join(here, 'landing');
  fs.copyFileSync(path.join(landing, 'index.html'), path.join(out, 'index.html'));
  fs.mkdirSync(path.join(out, 'admin'), { recursive: true });
  fs.copyFileSync(path.join(landing, 'admin.html'), path.join(out, 'admin', 'index.html'));
  fs.mkdirSync(path.join(out, 'npj26'), { recursive: true });
  fs.copyFileSync(path.join(landing, 'npj26', 'index.html'), path.join(out, 'npj26', 'index.html'));
  fs.copyFileSync(path.join(landing, 'favicon.svg'), path.join(out, 'favicon.svg'));
  fs.cpSync(path.join(landing, 'img'), path.join(out, 'img'), { recursive: true });
  fs.writeFileSync(path.join(out, 'projects.json'), JSON.stringify(projectsJson(here), null, 2));

  const leaks = evalLeaks(out);
  if (leaks.length > 0) throw new Error(`evaluation data reached the site: ${leaks.slice(0, 5).join(', ')}`);
  console.log(`Built the site into ${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`build-site: ${(e as Error).message}`);
    process.exit(1);
  }
}
