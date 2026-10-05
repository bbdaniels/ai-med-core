/**
 * Validate every projects/<slug>/project.json against projects/project-schema.json.
 *
 *   npx tsx tools/validate-projects.ts            # all projects
 *   npx tsx tools/validate-projects.ts haivn_eip  # one project
 *
 * Runs as the first step of `npm run build` and of the deploy workflow, so a
 * field that is not declared in the schema fails the build instead of being
 * silently ignored by the API. Beyond the JSON Schema it checks the things a
 * schema cannot: the slug matches its directory, every repo-relative path the
 * file names exists (or is private, i.e. gitignored: see lib/private-files.ts),
 * a talk project sets no flag that contradicts `app: "talk"`, a followHost
 * project has what following a host needs (followHostContradictions), and only
 * a talk project remembers a conversation (rememberConversationContradictions),
 * a project's grounding sets are document sets of its vignettes and its
 * grounding/ directory holds only their files (groundingSetsContradictions),
 * and a talk page's urlAliases (urlAliasContradictions) are no other project's
 * URL slug or alias, since the server would serve only one of them.
 *
 * AI_MED_REPO_ROOT, when set, names the checkout whose projects/ are validated
 * (the schema is always this repository's); the tests use it on a temp tree.
 */
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isPrivateFile } from './lib/private-files.js';
import {
  followHostContradictions, GROUNDING_SET_DIR, groundingSetFiles, groundingSetsContradictions, projectUrlSlug,
  rememberConversationContradictions, tabContentFiles, talkContradictions,
  urlAliasContradictions, urlAliases,
} from '../packages/chat-core/src/project-config.js';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = process.env.AI_MED_REPO_ROOT?.trim() ? path.resolve(process.env.AI_MED_REPO_ROOT.trim()) : here;
const schema = JSON.parse(fs.readFileSync(path.join(here, 'projects/project-schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

const only = process.argv[2];
const allDirs = fs.readdirSync(path.join(root, 'projects'), { withFileTypes: true })
  .filter(d => d.isDirectory() && fs.existsSync(path.join(root, 'projects', d.name, 'project.json')))
  .map(d => d.name);
const dirs = allDirs.filter(d => !only || d === only);

/** Every URL path segment a project claims (its URL slug, then its aliases), by directory, read from every project. */
const claims = new Map<string, string[]>();
for (const dir of allDirs) {
  let aliases: string[] = [];
  try {
    aliases = urlAliases(JSON.parse(fs.readFileSync(path.join(root, 'projects', dir, 'project.json'), 'utf8')));
  } catch { /* reported below as invalid JSON */ }
  claims.set(dir, [projectUrlSlug(dir), ...aliases]);
}

/** The aliases of `dir` that another project also claims. */
function aliasClashes(dir: string): string[] {
  const [, ...aliases] = claims.get(dir) ?? [];
  const out: string[] = [];
  for (const alias of aliases) {
    for (const [other, segs] of claims) {
      if (other !== dir && segs.includes(alias)) out.push(`urlAliases: "${alias}" is also claimed by ${other}`);
    }
  }
  return out;
}

if (dirs.length === 0) {
  console.error(only ? `No project named ${only}` : 'No projects found');
  process.exit(1);
}

function pathFields(p: any, slug: string): string[] {
  const out: string[] = [];
  out.push(p.cases?.systemPrompt);
  for (const v of p.cases?.vignettes ?? []) out.push(v.file);
  out.push(...tabContentFiles(p));
  if (p.kobo?.template) out.push(p.kobo.template);
  if (p.talkManifest) out.push(p.talkManifest);
  if (p.groundingFile) out.push(p.groundingFile);
  out.push(...groundingSetFiles(slug, p));
  // readingsIndex is deliberately excluded: gitignored, uploaded to Railway out of band.
  return out.filter(Boolean);
}

/** The file names in projects/<slug>/grounding/ in this checkout; [] when there is no such directory. */
function groundingDirFiles(slug: string): string[] {
  try {
    return fs.readdirSync(path.join(root, 'projects', slug, GROUNDING_SET_DIR), { withFileTypes: true })
      .filter(e => e.isFile() && e.name !== '.DS_Store').map(e => e.name);
  } catch {
    return [];
  }
}

let failed = 0;
for (const slug of dirs) {
  const file = path.join(root, 'projects', slug, 'project.json');
  const errors: string[] = [];
  let p: any;
  try {
    p = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    errors.push(`invalid JSON: ${(e as Error).message}`);
  }
  if (p) {
    if (!validate(p)) {
      for (const err of validate.errors ?? []) {
        errors.push(`${err.instancePath || '/'} ${err.message}${err.params?.additionalProperty ? ` (${err.params.additionalProperty})` : ''}`);
      }
    }
    errors.push(...talkContradictions(p));
    errors.push(...followHostContradictions(p));
    errors.push(...rememberConversationContradictions(p));
    errors.push(...urlAliasContradictions(p));
    errors.push(...groundingSetsContradictions(p, groundingDirFiles(slug)));
    errors.push(...aliasClashes(slug));
    if (p.name !== slug) errors.push(`name "${p.name}" does not match directory "${slug}"`);
    if (!fs.existsSync(path.join(root, 'projects', slug, 'languages.json'))) errors.push('languages.json missing');
    let privateAbsent = 0;
    for (const rel of pathFields(p, slug)) {
      if (fs.existsSync(path.join(root, rel))) continue;
      // A gitignored file is absent from any checkout but the author's, by
      // design (see tools/lib/private-files.ts); anything else missing is a bug.
      if (isPrivateFile(rel)) privateAbsent++;
      else errors.push(`missing file: ${rel}`);
    }
    if (privateAbsent) {
      console.log(`  ${slug}: ${privateAbsent} private (gitignored) file(s) not in this checkout; ` +
                  'they reach the deployment through push-content.ts from a checkout that has them');
    }
    const keys = (p.cases?.vignettes ?? []).map((v: any) => v.key);
    const dup = keys.filter((k: string, i: number) => keys.indexOf(k) !== i);
    if (dup.length) errors.push(`duplicate vignette keys: ${[...new Set(dup)].join(', ')}`);
  }
  if (errors.length) {
    failed++;
    console.error(`✗ ${slug}`);
    for (const e of errors) console.error(`    ${e}`);
  } else {
    console.log(`✓ ${slug}`);
  }
}
if (failed) {
  console.error(`\n${failed} project(s) failed validation`);
  process.exit(1);
}
