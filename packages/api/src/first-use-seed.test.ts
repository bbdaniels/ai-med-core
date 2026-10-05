// Run: npm -w @ai-med/api test   (node:test under tsx)
//
// A project's first use on a fresh server: its tables are created and seeded
// from projects/<slug>/ (db/init.ts, ensureProjectTables). A page's first load
// sends several requests at once (/api/config, /api/languages, /api/vignettes),
// and every one of them must see the seeded content. Until 2026-10-05 only the
// first request waited for the seed: the others found the project already
// marked initialized and read empty tables, so /api/languages answered 404 and
// the talk page, without the languages file's openingMessage, asked the model
// for an opening instead. Nothing here reads a real project.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, type Harness } from '../test-support/server-harness.js';

const PROJECT = 'fixture_seed';
// Enough vignettes that seeding them takes longer than answering a request.
const VIGNETTES = 150;
const OPENING = 'FIXTURE opening, from the languages file.';

let h: Harness;
let tmp = '';

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'first-use-seed-'));
  const root = path.join(tmp, 'checkout');
  const dir = path.join(root, 'projects', PROJECT);
  fs.mkdirSync(path.join(dir, 'cases', 'doc'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'system-prompt.md'), 'FIXTURE prompt.\n');
  const vignettes = Array.from({ length: VIGNETTES }, (_, i) => {
    const key = `set--v${String(i).padStart(3, '0')}`;
    fs.writeFileSync(path.join(dir, 'cases', 'doc', `${key}.md`), `FIXTURE document ${i}. ${'x'.repeat(2000)}\n`);
    return { key, template: 'doc', title: `Document ${i}`, file: `projects/${PROJECT}/cases/doc/${key}.md` };
  });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    name: PROJECT, displayName: 'Fixture seed', frontend: 'chat', app: 'talk', chatOnly: true,
    cases: { systemPrompt: `projects/${PROJECT}/system-prompt.md`, vignettes },
    languages: ['en'], deployment: { tablePrefix: PROJECT },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'languages.json'), JSON.stringify({
    languages: [{ code: 'en', name: 'English' }],
    ui: { en: { welcome: { title: 'Fixture seed' }, chat: { openingMessage: OPENING } } },
  }));
  h = await startServer({ root });
});

after(async () => {
  await h?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('every request of a first page load sees the seeded project', async () => {
  const get = async (route: string) => {
    const res = await fetch(`${h.base}${route}`, { headers: { 'X-Project': PROJECT } });
    return { status: res.status, json: await res.json() as any };
  };
  // What a page sends on its first load, at once.
  const [config, languages, vignettes] = await Promise.all([
    get('/api/config'), get('/api/languages'), get('/api/vignettes'),
  ]);
  assert.equal(config.status, 200);
  assert.equal(languages.status, 200, JSON.stringify(languages.json));
  assert.equal(languages.json.ui?.en?.chat?.openingMessage, OPENING);
  assert.equal(vignettes.status, 200);
  assert.equal(vignettes.json.vignetteKeys.length, VIGNETTES);
  // Seeded once, not once per request.
  assert.equal(h.log().match(/Seeding project "fixture_seed"/g)?.length, 1);
});
