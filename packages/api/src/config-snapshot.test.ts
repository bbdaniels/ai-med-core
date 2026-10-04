// Run: npm -w @ai-med/api test
//      UPDATE_SNAPSHOTS=1 npx tsx --test src/config-snapshot.test.ts   (rewrite; a deliberate change only)
//
// Pins GET /api/config, the one call every page makes first, for every project
// in projects/. The expected answers live in projects/config-snapshot.json,
// which is private (it lists the project roster and their form URLs), so where
// that file is absent (the public mirror) this test skips.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, REPO_ROOT, type Harness } from '../test-support/server-harness.js';

const SNAPSHOT = path.join(REPO_ROOT, 'projects', 'config-snapshot.json');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';

const slugs = fs.readdirSync(path.join(REPO_ROOT, 'projects'), { withFileTypes: true })
  .filter(e => e.isDirectory() && fs.existsSync(path.join(REPO_ROOT, 'projects', e.name, 'project.json')))
  .map(e => e.name)
  .sort();

const active = UPDATE || fs.existsSync(SNAPSHOT);
let h: Harness | null = null;

before(async () => {
  if (active) h = await startServer({});
});

after(async () => {
  await h?.stop();
});

test('GET /api/config for every project', { skip: active ? false : 'no projects/config-snapshot.json (public mirror?)' }, async () => {
  const actual: Record<string, { status: number; body: unknown }> = {};
  for (const slug of slugs) {
    const res = await fetch(`${h!.base}/api/config`, { headers: { 'X-Project': slug } });
    actual[slug] = { status: res.status, body: await res.json() };
  }
  if (UPDATE) {
    fs.writeFileSync(SNAPSHOT, JSON.stringify(actual, null, 2) + '\n');
    return;
  }
  const expected = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  // A project added or removed shows up as a key difference, not a silent pass.
  assert.deepStrictEqual(Object.keys(actual), Object.keys(expected),
    'the project roster changed; if intended, record it with UPDATE_SNAPSHOTS=1');
  assert.deepStrictEqual(actual, expected);
});
