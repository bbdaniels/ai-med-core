// Run: npm -w @ai-med/api test   (node:test under tsx)
//
// The shared test harness (packages/api/test-support/) itself: the fixed clock
// shifts Date but keeps it ticking, a fixture readings index opens and searches
// through the real readings.ts, and the real server boots on throwaway SQLite
// with its gateway pointed at the fake, whose recorded prompt carries the fixed
// date.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, FIXED_CLOCK_URL, DEFAULT_TEST_NOW, type Harness } from '../test-support/server-harness.js';
import { buildFixtureIndex } from '../test-support/fixture-index.js';
import { openReadingsIndex, searchReadings } from './readings.js';

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
