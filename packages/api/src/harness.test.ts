// Run: npm -w @ai-med/api test   (node:test under tsx)
//
// The shared test harness (packages/api/test-support/) itself: the fixed clock
// shifts Date but keeps it ticking, a fixture readings index opens and searches
// through the real readings.ts, and the real server boots on throwaway SQLite
// with its gateway pointed at the fake, whose recorded prompt carries the fixed
// date. The server reads a view of the checkout that holds what a clean clone
// holds and no gitignored file, so a working copy with private content and CI
// see the same answers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, FIXED_CLOCK_URL, DEFAULT_TEST_NOW, REPO_ROOT, type Harness } from '../test-support/server-harness.js';
import { buildTrackedView } from '../test-support/tracked-view.js';
import { waitForDeploy } from '../../../tools/lib/deploy-ready.js';
import { buildFixtureIndex } from '@ai-med/chat-core/test-support/fixture-index';
import { openReadingsIndex, searchReadings } from '@ai-med/chat-core';

let h: Harness;
let tmp = '';

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
  h = await startServer({});
});

after(async () => {
  await h?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the fixed clock starts at AI_MED_TEST_NOW, keeps ticking, and leaves explicit dates alone', () => {
  const out = execFileSync(process.execPath, ['--import', FIXED_CLOCK_URL, '-e', `
    const a = Date.now(); const s = new Date().toISOString();
    const t0 = Date.now(); while (Date.now() - t0 < 20) {}
    console.log(JSON.stringify({ s, ticked: Date.now() > a, explicit: new Date(0).toISOString(),
                                 parsed: Date.parse('2000-01-01T00:00:00Z'), utc: Date.UTC(2000, 0, 1),
                                 inst: new Date() instanceof Date }));
  `], { env: { ...process.env, AI_MED_TEST_NOW: DEFAULT_TEST_NOW, TZ: 'UTC' } }).toString();
  const r = JSON.parse(out);
  assert.match(r.s, /^2026-10-01T12:00:0/);
  assert.equal(r.ticked, true);
  assert.equal(r.explicit, '1970-01-01T00:00:00.000Z');
  assert.equal(r.parsed, 946684800000);
  assert.equal(r.utc, 946684800000);
  assert.equal(r.inst, true);
});

test('a fixture index opens through readings.ts and searches by BM25 alone', () => {
  const dest = path.join(tmp, 'fixture.db');
  buildFixtureIndex(dest, {
    documents: [{ id: 'doc-one', authors: 'Fixture, A.', author_short: 'Fixture', year: 2026, title: 'A fixture document' }],
    chunks: [
      { doc_id: 'doc-one', header: 'Fixture | Methods', text: 'The zebrafish protocol ran for twelve weeks.', page_start: 1, page_end: 1 },
      { doc_id: 'doc-one', header: 'Fixture | Results', text: 'Attendance rose by a third.', page_start: 2, page_end: 2 },
    ],
  });
  process.env.READINGS_INDEX_HARNESS_FIXTURE = dest;
  const index = openReadingsIndex(tmp, 'harness_fixture', 'unused.db');
  assert.ok(index, 'index opens');
  assert.equal(index!.hasVectors, false);
  assert.equal(index!.hasWeeks, false);
  const hits = searchReadings(index!, 'zebrafish protocol', null, {});
  assert.equal(hits.length >= 1, true);
  assert.match(JSON.stringify(hits[0]), /zebrafish/);
});

test('the server boots and the fake gateway receives the fixed date', async () => {
  const health = await fetch(`${h.base}/api/health`);
  assert.equal(health.status, 200);
  // The key is always there, null without Railway's variable: the wait reads
  // an absent key as an older build, and null as "reports no commit".
  const body = (await health.json()) as Record<string, unknown>;
  assert.ok('commit' in body);
  assert.equal(body.commit, null);

  const admin = h.admin('demo');
  await admin.saveSystemPrompt('You are a fixture patient.');
  await admin.saveVignette('harness-fixture', 'FIXTURE VIGNETTE: a sore knee.');

  const before = h.fake.requests.length;
  const res = await h.chat('demo', { vignetteKey: 'harness-fixture', messages: [{ role: 'user', content: 'Hello' }] });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const sent = h.fake.requests.slice(before);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].path, '/v1/chat/completions');
  const system: string = sent[0].body.messages[0].content;
  assert.match(system, /Today is Thursday, October 1, 2026\./);
  assert.match(system, /FIXTURE VIGNETTE/);

  const usage = h.tokenUsage('demo');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].endpoint, '/api/chat');
});

test('the checkout view holds tracked and new files, never ignored ones', () => {
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'projects/p/cases'), { recursive: true });
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'projects/p/cases/*.md\n!projects/p/cases/README.md\n');
  fs.writeFileSync(path.join(repo, 'projects/p/project.json'), '{}');
  fs.writeFileSync(path.join(repo, 'projects/p/cases/README.md'), 'tracked');
  fs.writeFileSync(path.join(repo, 'projects/p/cases/private.md'), 'PRIVATE');
  git('add', '.');
  fs.writeFileSync(path.join(repo, 'projects/p/new.json'), 'not added yet');
  fs.writeFileSync(path.join(repo, 'outside.txt'), 'not under projects/');

  const view = buildTrackedView(repo, path.join(tmp, 'view'));
  const has = (rel: string) => fs.existsSync(path.join(view, rel));
  assert.ok(has('projects/p/project.json'));
  assert.ok(has('projects/p/cases/README.md'));
  assert.ok(has('projects/p/new.json'));
  assert.ok(!has('projects/p/cases/private.md'), 'an ignored file is not in the view');
  assert.ok(!has('outside.txt'));
  assert.deepEqual(fs.readdirSync(path.join(view, 'transcripts')), []);
  // A link, not a copy: an edit in the working copy shows at once.
  fs.writeFileSync(path.join(repo, 'projects/p/project.json'), '{"edited":true}');
  assert.equal(fs.readFileSync(path.join(view, 'projects/p/project.json'), 'utf8'), '{"edited":true}');
});

test('the server reads the view, with a transcripts directory of its own', () => {
  assert.notEqual(path.resolve(h.root), path.resolve(REPO_ROOT));
  assert.ok(fs.existsSync(path.join(h.root, 'projects/demo/project.json')));
  assert.ok(fs.existsSync(path.join(h.root, 'transcripts')));
});

test('a project whose private vignettes are absent is still seeded with its languages', async () => {
  // papers names its paper texts in project.json, and they are gitignored, so
  // the view never has them. The seed skips them and still loads languages.json.
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'projects/papers/project.json'), 'utf8'));
  const absent = (cfg.cases?.vignettes ?? []).filter((v: any) => !fs.existsSync(path.join(h.root, v.file)));
  const langs = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'projects/papers/languages.json'), 'utf8'));
  const res = await fetch(`${h.base}/api/config`, { headers: { 'X-Project': 'papers' } });
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.deepEqual(body.languages, langs.languages);
  if (absent.length > 0) assert.match(h.log(), /skipped: .* is not in this checkout/);
  assert.doesNotMatch(h.log(), /Could not seed project "papers"/);
});

test('the server admits exactly the projects of the checkout it reads', async () => {
  // A fixture tree with one project that no real checkout has. The X-Project
  // allowlist comes from the checkout the server reads (AI_MED_REPO_ROOT), so
  // the fixture slug is admitted and a slug of the real checkout is not.
  const root = fs.mkdtempSync(path.join(tmp, 'fixture-root-'));
  const dir = path.join(root, 'projects', 'fixture_only');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    name: 'fixture_only', displayName: 'Fixture', frontend: 'chat',
    cases: { systemPrompt: '', vignettes: [] }, languages: ['en'],
    deployment: { tablePrefix: 'fixture_only' },
  }));
  const own = await startServer({ root, env: { RAILWAY_GIT_COMMIT_SHA: 'c0ffee1234567890c0ffee1234567890c0ffee12' } });
  try {
    // /api/health names the commit the deployment was built from, and
    // tools/lib/deploy-ready.ts accepts it as the commit being waited for.
    const ready = await waitForDeploy({ baseUrl: own.base, commit: 'c0ffee1', timeoutMs: 5_000, intervalMs: 100, log: () => {} });
    assert.deepEqual(ready, { commit: 'c0ffee1234567890c0ffee1234567890c0ffee12', later: false, verified: true, attempts: 1 });
    const prefix = async (project: string) =>
      ((await (await fetch(`${own.base}/api/health`, { headers: { 'X-Project': project } })).json()) as any).tablePrefix;
    assert.equal(await prefix('fixture_only'), 'fixture_only_');
    assert.equal(await prefix('demo'), 'not set');      // in the real checkout, not in this one
    assert.match(own.log(), /Valid project slugs: fixture_only\b/);
    assert.equal(own.root, root);
  } finally {
    await own.stop();
  }
});
