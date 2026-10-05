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
 * a talk project remembers a conversation (rememberConversationContradictions).
 *
 * AI_MED_REPO_ROOT, when set, names the checkout whose projects/ are validated
 * (the schema is always this repository's); the tests use it on a temp tree.
 */
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isPrivateFile, tabContentFiles } from './lib/private-files.js';
import { followHostContradictions, rememberConversationContradictions, talkContradictions } from '../packages/chat-core/src/project-config.js';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = process.env.AI_MED_REPO_ROOT?.trim() ? path.resolve(process.env.AI_MED_REPO_ROOT.trim()) : here;
const schema = JSON.parse(fs.readFileSync(path.join(here, 'projects/project-schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

const only = process.argv[2];
const dirs = fs.readdirSync(path.join(root, 'projects'), { withFileTypes: true })
  .filter(d => d.isDirectory() && fs.existsSync(path.join(root, 'projects', d.name, 'project.json')))
  .map(d => d.name)
  .filter(d => !only || d === only);

if (dirs.length === 0) {
  console.error(only ? `No project named ${only}` : 'No projects found');
  process.exit(1);
}

function pathFields(p: any): string[] {
  const out: string[] = [];
  out.push(p.cases?.systemPrompt);
  for (const v of p.cases?.vignettes ?? []) out.push(v.file);
  out.push(...tabContentFiles(p));
  if (p.kobo?.template) out.push(p.kobo.template);
  if (p.talkManifest) out.push(p.talkManifest);
  if (p.groundingFile) out.push(p.groundingFile);
  // readingsIndex is deliberately excluded: gitignored, uploaded to Railway out of band.
  return out.filter(Boolean);
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
    if (p.name !== slug) errors.push(`name "${p.name}" does not match directory "${slug}"`);
    if (!fs.existsSync(path.join(root, 'projects', slug, 'languages.json'))) errors.push('languages.json missing');
    let privateAbsent = 0;
    for (const rel of pathFields(p)) {
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
