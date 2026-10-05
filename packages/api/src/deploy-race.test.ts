// Run: npm -w @ai-med/api test   (node:test under tsx)
//
// A merge to main restarts the API on Railway while the Pages workflow pushes
// content to it, so for a while the edge answers 502. Two rules cover that,
// both tested here against a fake server that plays the restart:
//
//   tools/lib/retry-fetch.ts (through AdminApiClient): a request answered 502,
//     503 or 504, or whose connection is refused, is sent again with a bounded
//     wait; any other answer (a 401, a 400, a 500) is final and sent once.
//   tools/lib/deploy-ready.ts: the workflow first waits until /api/health
//     answers and names the commit being deployed, or a later one that
//     contains it, and fails when that never happens.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AdminApiClient } from '../../../tools/lib/api-client.js';
import { fetchWithRetry, isTransientNetworkError } from '../../../tools/lib/retry-fetch.js';
import { sameCommit, unverifiedWarning, waitForDeploy } from '../../../tools/lib/deploy-ready.js';

interface Seen { method: string; path: string; body: string }
type Answer = (seen: Seen, nth: number) => { status: number; json?: unknown };

let server: http.Server;
let base = '';
let seen: Seen[] = [];
let answer: Answer = () => ({ status: 200, json: {} });
const FAST = [5, 5, 5];
const count = (method: string, path: string) => seen.filter(s => s.method === method && s.path === path).length;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const s = { method: req.method ?? '', path: req.url ?? '', body };
      seen.push(s);
      const a = answer(s, count(s.method, s.path));
      res.writeHead(a.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(a.json ?? {}));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => { seen = []; answer = () => ({ status: 200, json: {} }); });

const client = () => new AdminApiClient({ baseUrl: base, passphrase: 'fixture', project: 'demo', retryDelaysMs: FAST });
const silenced = async <T>(run: () => Promise<T>): Promise<T> => {
  const log = console.log;
  console.log = () => {};
  try { return await run(); } finally { console.log = log; }
};

test('a login answered 502 twice, then 200, succeeds on the third attempt', async () => {
  answer = (s, nth) => s.path === '/api/admin/login'
    ? (nth <= 2 ? { status: 502 } : { status: 200, json: { token: 't' } })
    : { status: 200, json: { systemPrompt: '', vignettes: [], koboFormUrl: '' } };
  const content = await silenced(() => client().getContent());
  assert.deepEqual(content.vignettes, []);
  assert.equal(count('POST', '/api/admin/login'), 3);
  assert.equal(count('GET', '/api/admin/content'), 1);
});

test('a save answered 502 twice, then 200, is sent three times with the same body', async () => {
  answer = (s, nth) => s.path === '/api/admin/login' ? { status: 200, json: { token: 't' } }
    : (nth <= 2 ? { status: [502, 503][nth - 1] } : { status: 200, json: { success: true } });
  await silenced(() => client().saveVignette('k', 'content'));
  const saves = seen.filter(s => s.path === '/api/admin/vignette');
  assert.equal(saves.length, 3);
  assert.equal(new Set(saves.map(s => s.body)).size, 1);
  assert.equal(count('POST', '/api/admin/login'), 1);
});

test('a 401 at login is final: one request, no retry', async () => {
  answer = () => ({ status: 401, json: { error: 'Invalid passphrase' } });
  await assert.rejects(silenced(() => client().getContent()), /Authentication failed: 401/);
  assert.equal(seen.length, 1);
});

test('a 400 and a 500 are the server\'s own answers and are sent once', async () => {
  for (const status of [400, 500]) {
    seen = [];
    answer = s => s.path === '/api/admin/login' ? { status: 200, json: { token: 't' } } : { status, json: { error: 'no' } };
    await assert.rejects(silenced(() => client().saveSystemPrompt('p')), new RegExp(`API request failed: ${status}`));
    assert.equal(count('POST', '/api/admin/system-prompt'), 1);
  }
});

test('a service that never comes back fails loudly after the bounded attempts', async () => {
  answer = () => ({ status: 502 });
  await assert.rejects(silenced(() => client().getContent()), /Authentication failed: 502/);
  assert.equal(seen.length, FAST.length + 1);
});

test('addAssignment, which the server refuses on a repeat, is sent exactly once on a 502', async () => {
  answer = s => s.path === '/api/admin/login' ? { status: 200, json: { token: 't' } } : { status: 502 };
  await assert.rejects(silenced(() => client().addAssignment('u1', 'k')), /API request failed: 502/);
  assert.equal(count('POST', '/api/admin/vignette-assignments'), 1);
});

test('a refused connection is retried the bounded number of times; other errors are not transient', async () => {
  // A port nothing listens on: bound, read, and closed again.
  const spare = http.createServer();
  await new Promise<void>(resolve => spare.listen(0, '127.0.0.1', resolve));
  const dead = `http://127.0.0.1:${(spare.address() as AddressInfo).port}`;
  await new Promise(resolve => spare.close(resolve));
  const retries: string[] = [];
  await assert.rejects(fetchWithRetry(`${dead}/api/x`, {}, { delaysMs: FAST, log: m => retries.push(m) }),
    e => isTransientNetworkError(e));
  assert.equal(retries.length, FAST.length);
  assert.match(retries[0], /GET \/api\/x failed \(ECONNREFUSED\)/);
  assert.equal(isTransientNetworkError(new TypeError('Invalid URL')), false);
});

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const LATER = 'c'.repeat(40);
const wait = (commit: string | null, extra: object = {}) =>
  waitForDeploy({
    baseUrl: base, commit, timeoutMs: 400, intervalMs: 10, stableAnswers: 3, stableIntervalMs: 5,
    log: () => {}, isDescendant: () => false, ...extra,
  });
const health = () => count('GET', '/api/health');

test('(a) no commit key is the old container: the wait goes on through the restart to the new commit', async () => {
  // The build before the key existed, a 502 while it is replaced, then the new one.
  answer = (_s, nth) => nth <= 3 ? { status: 200, json: { status: 'ok' } }
    : nth === 4 ? { status: 502 }
    : { status: 200, json: { status: 'ok', commit: NEW } };
  const ready = await wait(NEW);
  assert.deepEqual(ready, { commit: NEW, later: false, verified: true, attempts: 5 });
});

test('(a) no commit key, never replaced, fails at the deadline', async () => {
  answer = () => ({ status: 200, json: { status: 'ok' } });
  await assert.rejects(wait(NEW), /is not serving bbbbbbb after 0s: healthy, but \/api\/health has no commit field/);
  assert.ok(health() > 3, 'it kept asking; it did not settle for a stable old container');
});

test('(b) the expected commit is ready at once, after 502s and the old commit', async () => {
  answer = (_s, nth) => nth <= 2 ? { status: 502 }
    : { status: 200, json: { status: 'ok', commit: nth === 3 ? OLD : NEW } };
  const ready = await wait(NEW);
  assert.deepEqual(ready, { commit: NEW, later: false, verified: true, attempts: 4 });
});

test('(b) a later commit that contains the expected one is ready', async () => {
  answer = () => ({ status: 200, json: { commit: LATER } });
  const asked: string[][] = [];
  const ready = await wait(NEW, { isDescendant: (d: string, e: string) => { asked.push([d, e]); return true; } });
  assert.deepEqual(ready, { commit: LATER, later: true, verified: true, attempts: 1 });
  assert.deepEqual(asked, [[LATER, NEW]]);
});

test('(c) commit null falls back to a stable healthy service, unverified, with a warning that names the variable', async () => {
  answer = () => ({ status: 200, json: { status: 'ok', commit: null } });
  const ready = await wait(NEW);
  assert.deepEqual(ready, { commit: null, later: false, verified: false, attempts: 3 });
  const warning = unverifiedWarning(ready, NEW)!;
  assert.match(warning, /^::warning::/);
  assert.match(warning, /RAILWAY_GIT_COMMIT_SHA/);
  assert.match(warning, /bbbbbbb/);
  assert.equal(unverifiedWarning({ commit: NEW, later: false, verified: true, attempts: 1 }, NEW), null);
});

test('(c) stable means running: a 502 between healthy answers starts the count again', async () => {
  // healthy, healthy, 502, then healthy three times.
  answer = (_s, nth) => nth === 3 ? { status: 502 } : { status: 200, json: { commit: null } };
  const ready = await wait(NEW);
  assert.equal(ready.verified, false);
  assert.equal(ready.attempts, 6);
});

test('(c) a deployment that reports null and never stays healthy fails', async () => {
  answer = (_s, nth) => nth % 2 === 0 ? { status: 503 } : { status: 200, json: { commit: null } };
  await assert.rejects(wait(NEW), /is not serving bbbbbbb after 0s/);
});

test('(d) another commit that does not contain the expected one waits to the deadline and fails', async () => {
  answer = () => ({ status: 200, json: { commit: OLD } });
  const asked: string[] = [];
  await assert.rejects(wait(NEW, { isDescendant: (d: string) => { asked.push(d); return false; } }),
    /is not serving bbbbbbb after 0s: healthy, but serving aaaaaaa/);
  assert.ok(health() > 3, 'it kept asking');
  assert.deepEqual(asked, [OLD]);                       // git is asked once per deployed commit
});

test('no commit asked for (a manual run from a branch): stable and healthy is enough, whatever is deployed', async () => {
  for (const json of [{ commit: OLD }, { commit: null }, { status: 'ok' }]) {
    seen = [];
    answer = () => ({ status: 200, json });
    const ready = await wait(null);
    assert.equal(ready.verified, false);
    assert.equal(ready.attempts, 3);
    assert.match(unverifiedWarning(ready, null)!, /^::warning::.*not a push to main/);
  }
  answer = () => ({ status: 502 });
  await assert.rejects(wait(null), /is not serving a stable healthy service after 0s: \/api\/health answered 502/);
});

test('a service that never answers, and a commit that is not a SHA, fail with the reason', async () => {
  answer = () => ({ status: 502 });
  await assert.rejects(wait(NEW), /\/api\/health answered 502/);
  await assert.rejects(wait('not-a-sha'), /is not a commit SHA/);
});

test('commits match by prefix of seven or more characters', () => {
  assert.equal(sameCommit(NEW, NEW.slice(0, 7)), true);
  assert.equal(sameCommit(NEW.slice(0, 12), NEW), true);
  assert.equal(sameCommit(NEW, OLD), false);
  assert.equal(sameCommit(NEW, 'bbb'), false);
  assert.equal(sameCommit('', ''), false);
});
