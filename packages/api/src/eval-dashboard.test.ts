// Run: npm -w @ai-med/api test   (node:test under tsx)
//
// The evaluation dashboards (sim/eval.ts) against the real server.ts. The
// grader's results hold participant transcripts, so the data is served only to
// an admin of that project or a global admin: never without a login, never to
// another project's admin, and never as a static file. The page (code only) is
// served on the API's own origin. The server runs on a fixture checkout this
// test writes, with invented results; no real project is read.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, TEST_PASSPHRASE, type Harness } from '../test-support/server-harness.js';

const GRADED = 'fixture_graded';     // has projects/<slug>/eval/
const OTHER = 'fixture_other';       // has none
const GRADED_URL = 'fixture-graded';
const OTHER_PASS = 'fixture-other-pass';
const GRADED_PASS = 'fixture-graded-pass';
const SUBMISSION = 'fixture_uid_20261001_120000.json';

const INDEX = {
  generated_at: '2026-10-01T12:00:00',
  project_name: 'Fixture graded',
  total_submissions: 1,
  rubrics: {},
  submissions: [{ uid: 'fixture_uid', scenario: 'fixture', transcript_file: 'fixture_uid_20261001_120000.txt' }],
};
const DETAIL = { uid: 'fixture_uid', transcript: 'User:\nFIXTURE invented question\n\nAssistant:\nFIXTURE invented answer' };

let h: Harness;
let tmp = '';
const tokens: Record<'global' | 'graded' | 'other', string> = { global: '', graded: '', other: '' };
let globalCookie = '';

function writeProject(root: string, slug: string): string {
  const dir = path.join(root, 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    name: slug, displayName: slug, frontend: 'chat',
    cases: { systemPrompt: '', vignettes: [] }, languages: ['en'],
    deployment: { tablePrefix: slug },
  }, null, 2));
  return dir;
}

async function login(project: string, passphrase: string): Promise<Response> {
  return fetch(`${h.base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Project': project },
    body: JSON.stringify({ passphrase }),
  });
}

async function get(route: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${h.base}${route}`, { headers, redirect: 'manual' });
}

const bearer = (token: string, project: string) => ({ Authorization: `Bearer ${token}`, 'X-Project': project });

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-dashboard-test-'));
  const root = path.join(tmp, 'checkout');
  const graded = writeProject(root, GRADED);
  writeProject(root, OTHER);
  fs.mkdirSync(path.join(graded, 'eval', 'submissions'), { recursive: true });
  fs.writeFileSync(path.join(graded, 'eval', 'index.json'), JSON.stringify(INDEX));
  fs.writeFileSync(path.join(graded, 'eval', 'submissions', SUBMISSION), JSON.stringify(DETAIL));
  // A file beside the results that no route may reach.
  fs.writeFileSync(path.join(graded, 'eval', 'secret.json'), '{"not":"served"}');

  h = await startServer({ root });
  h.setProjectSetting(OTHER, 'admin_passphrase', OTHER_PASS);
  h.setProjectSetting(GRADED, 'admin_passphrase', GRADED_PASS);

  const g = await login(GRADED, TEST_PASSPHRASE);
  tokens.global = ((await g.json()) as any).token;
  globalCookie = (g.headers.get('set-cookie') ?? '').split(';')[0];
  const a = await login(GRADED, GRADED_PASS);
  const aj = (await a.json()) as any;
  assert.equal(aj.scope, 'project');
  tokens.graded = aj.token;
  const o = await login(OTHER, OTHER_PASS);
  const oj = (await o.json()) as any;
  assert.equal(oj.scope, 'project');
  tokens.other = oj.token;
  assert.ok(tokens.global && tokens.graded && tokens.other && globalCookie.startsWith('admin_token='));
});

after(async () => {
  await h?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const DATA_ROUTES = ['/api/admin/eval', '/api/admin/eval/index.json', `/api/admin/eval/submissions/${SUBMISSION}`];

test('without a login every data route answers 401 and carries no data', async () => {
  for (const route of DATA_ROUTES) {
    const r = await get(route, { 'X-Project': GRADED });
    assert.equal(r.status, 401, route);
    assert.doesNotMatch(await r.text(), /FIXTURE|fixture_uid/, route);
  }
});

test('a forged or expired token answers 401', async () => {
  const r = await get('/api/admin/eval/index.json', bearer('not-a-token', GRADED));
  assert.equal(r.status, 401);
});

test("another project's admin cannot read this project's results (403)", async () => {
  for (const route of DATA_ROUTES) {
    const r = await get(route, bearer(tokens.other, GRADED));
    assert.equal(r.status, 403, route);
    assert.doesNotMatch(await r.text(), /FIXTURE|fixture_uid/, route);
  }
  // Naming its own project instead gets it nothing of this one.
  const own = await get('/api/admin/eval', bearer(tokens.other, OTHER));
  assert.equal(own.status, 200);
  assert.deepEqual(await own.json(), { available: false });
  const ownIndex = await get('/api/admin/eval/index.json', bearer(tokens.other, OTHER));
  assert.equal(ownIndex.status, 404);
});

test("the project's own admin reads its results, uncached", async () => {
  const status = await get('/api/admin/eval', bearer(tokens.graded, GRADED));
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { available: true, dashboardPath: `/eval/${GRADED_URL}/` });

  const index = await get('/api/admin/eval/index.json', bearer(tokens.graded, GRADED));
  assert.equal(index.status, 200);
  assert.equal(index.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await index.json(), INDEX);

  const detail = await get(`/api/admin/eval/submissions/${SUBMISSION}`, bearer(tokens.graded, GRADED));
  assert.equal(detail.status, 200);
  assert.equal(detail.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await detail.json(), DETAIL);
});

test('a global admin reads them through the login cookie, as the page does', async () => {
  const r = await get('/api/admin/eval/index.json', { Cookie: globalCookie, 'X-Project': GRADED });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), INDEX);
});

test('a global admin naming no project gets 400, never a default project', async () => {
  for (const headers of [{ Authorization: `Bearer ${tokens.global}` }, bearer(tokens.global, 'no_such_project')]) {
    const r = await get('/api/admin/eval/index.json', headers);
    assert.equal(r.status, 400);
  }
});

test('a submission name cannot leave the submissions directory', async () => {
  for (const name of ['..%2Findex.json', '..%2Fsecret.json', '.hidden.json', 'secret', '%2E%2E%2F%2E%2E%2Fproject.json']) {
    const r = await get(`/api/admin/eval/submissions/${name}`, bearer(tokens.global, GRADED));
    assert.ok(r.status === 400 || r.status === 404, `${name}: ${r.status}`);
    assert.doesNotMatch(await r.text(), /not.*served|FIXTURE|tablePrefix/, name);
  }
  const missing = await get('/api/admin/eval/submissions/nobody.json', bearer(tokens.global, GRADED));
  assert.equal(missing.status, 404);
});

test('the page is served on the API origin, names its project, and holds no data', async () => {
  const bare = await get(`/eval/${GRADED_URL}`);
  assert.equal(bare.status, 301);
  assert.equal(bare.headers.get('location'), `/eval/${GRADED_URL}/`);

  const page = await get(`/eval/${GRADED_URL}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  const html = await page.text();
  assert.match(html, new RegExp(`<meta name="ai-med-project" content="${GRADED}">`));
  assert.doesNotMatch(html, /FIXTURE|fixture_uid/);

  const js = await get(`/eval/${GRADED_URL}/js/app.js`);
  assert.equal(js.status, 200);
  assert.match(await js.text(), /\/api\/admin\/eval\//);
  assert.equal((await get(`/eval/${GRADED_URL}/css/style.css`)).status, 200);

  // The old static layout serves nothing, and only the page's own files are served.
  for (const route of [`/eval/${GRADED_URL}/data/index.json`, `/eval/${GRADED_URL}/data/submissions/${SUBMISSION}`,
    `/eval/${GRADED_URL}/index.json`, `/eval/${GRADED_URL}/secret.json`, `/eval/${GRADED_URL}/../index.json`]) {
    const r = await get(route);
    assert.notEqual(r.status, 200, route);
    assert.doesNotMatch(await r.text(), /FIXTURE|fixture_uid|not.*served/, route);
  }
});

test('a project without results has no page', async () => {
  const r = await get('/eval/fixture-other/');
  assert.equal(r.status, 404);
});
