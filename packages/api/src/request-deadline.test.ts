// Run: npm -w @ai-med/api test
//
// The request deadline through the real server (chat-core deadline.ts,
// request-deadline.ts). The server runs with a 1.5 s deadline
// (REQUEST_DEADLINE_MS) in place of 85 s, and a slow or stalled upstream must
// get a 504 with a JSON message at the deadline, never a hang: the gateway
// holding an answer, the gateway asking the SDK to wait 50 s before a retry,
// and Kobo holding its answer to the grading route's search. Afterwards the
// work the routes gave up on finishes in the background, and the server must
// still be up and answering. It serves one invented fixture project with
// feedback on and one rubric, and reads no real project.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { startServer, CHAT_SPACING_MS, type Harness } from '../test-support/server-harness.js';

const DEADLINE_MS = 1_500;
/** How late after the deadline a 504 may arrive: the server's own scheduling, nothing more. */
const SLACK_MS = 1_000;
const HELD_MS = 4_000;
const FORM_UID = 'aFixtureFormUid';
const SLUG = 'deadline_fixture';
const TEMPLATE = 'fixture_case';

let h: Harness;
let tmp = '';
let kobo: http.Server;
let koboMode: 'answer' | 'hold' = 'answer';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function writeFixtureProject(root: string): void {
  const dir = path.join(root, 'projects', SLUG);
  fs.mkdirSync(path.join(dir, 'cases', TEMPLATE), { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    name: SLUG, displayName: 'Deadline fixture', frontend: 'chat', enableFeedback: true,
    cases: { systemPrompt: '', vignettes: [] }, languages: ['en'],
    deployment: { tablePrefix: SLUG },
  }));
  fs.writeFileSync(path.join(dir, 'cases', TEMPLATE, 'scoring_rubric.json'), JSON.stringify({
    name: 'Fixture rubric', version: '1', source: 'transcript',
    categories: [{ name: 'Asking', max_points: 1, items: [{
      id: 'ask', description: 'Asks what happened', scoring: '0 or 1', max_points: 1, grading_rubric: '1 if asked',
    }] }],
  }));
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'request-deadline-test-'));
  writeFixtureProject(tmp);
  // A fake Kobo kf API: the data search answers one submission of the
  // fixture case, or holds the request open.
  kobo = http.createServer((req, res) => {
    req.resume();
    if (koboMode === 'hold') return;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      count: 1,
      results: [{ _id: 1, chat_transcript: 'User: Hello\nAssistant:\nI fell last week.', vignette_id: 'fixture', case_template: TEMPLATE }],
    }));
  });
  await new Promise<void>(r => kobo.listen(0, '127.0.0.1', () => r()));
  const koboBase = `http://127.0.0.1:${(kobo.address() as AddressInfo).port}`;

  h = await startServer({
    root: tmp,
    env: { REQUEST_DEADLINE_MS: String(DEADLINE_MS), KOBO_API_TOKEN: 'fixture-kobo-token', KOBO_KF_BASE: koboBase },
  });
  await h.admin(SLUG).saveSystemPrompt('You are a fixture patient.');
  await h.admin(SLUG).saveVignette('deadline-fixture', 'FIXTURE: a patient who fell.');
  await h.admin(SLUG).saveKoboUid(FORM_UID);
});

after(async () => {
  await h?.stop();
  kobo.closeAllConnections();
  await new Promise<void>(r => kobo.close(() => r()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function post(route: string, body: object): Promise<{ status: number; json: any; ms: number }> {
  await sleep(CHAT_SPACING_MS); // /api/chat allows one request a second per client
  const t0 = Date.now();
  const res = await fetch(`${h.base}${route}`, {
    method: 'POST',
    headers: { 'X-Project': SLUG, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json, ms: Date.now() - t0 };
}

function assertCutAtDeadline(r: { status: number; json: any; ms: number }) {
  assert.equal(r.status, 504, JSON.stringify(r.json));
  assert.match(r.json.error, /took too long/);
  assert.ok(r.ms >= DEADLINE_MS - 100 && r.ms < DEADLINE_MS + SLACK_MS, `answered after ${r.ms} ms`);
}

const chatTurn = { vignetteKey: 'deadline-fixture', messages: [{ role: 'user', content: 'What happened?' }] };

test('the server reports the deadline it runs with', () => {
  assert.match(h.log(), /Request deadline: 1\.5s/);
});

test('a chat turn whose completion is held past the deadline is answered 504 at the deadline', async () => {
  h.fake.clearQueue();
  h.fake.enqueue({ content: 'too late', delayMs: HELD_MS });
  assertCutAtDeadline(await post('/api/chat', chatTurn));
});

test('a chat turn is answered at the deadline while the SDK sleeps on a 50 s Retry-After', async () => {
  h.fake.clearQueue();
  h.fake.rejectNext(429, undefined, { 'retry-after': '50' });
  assertCutAtDeadline(await post('/api/chat', chatTurn));
});

test('grading whose model calls are held past the deadline is answered 504 at the deadline', async () => {
  h.fake.clearQueue();
  koboMode = 'answer';
  h.fake.enqueue({ content: { total_score: 0 }, delayMs: HELD_MS });
  const sent = h.fake.requests.length;
  assertCutAtDeadline(await post('/api/grade-session', { tokens: ['t'.repeat(32)], language: 'en' }));
  // The grading call reached the gateway: the cut was the model's, not Kobo's.
  assert.equal(h.fake.requests.slice(sent).filter(r => r.path.endsWith('/chat/completions')).length, 1);
});

test('grading whose Kobo search is held past the deadline is answered 504 at the deadline', async () => {
  h.fake.clearQueue();
  koboMode = 'hold';
  assertCutAtDeadline(await post('/api/grade-session', { tokens: ['u'.repeat(32)], language: 'en' }));
});

test('after the abandoned work finishes, the server is up and a fast turn is answered', async () => {
  await sleep(HELD_MS);
  h.fake.clearQueue();
  const r = await post('/api/chat', chatTurn);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await fetch(`${h.base}/api/health`)).status, 200);
  assert.doesNotMatch(h.stderr(), /Unhandled|ERR_HTTP_HEADERS_SENT/);
});
