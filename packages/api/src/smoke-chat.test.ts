// Run: npm -w @ai-med/api test
//
// tools/smoke-chat.ts, the post-deploy smoke, run against the test server: it
// passes on a deployment that answers, and fails (exit 1) when a turn cannot
// be answered. The questions it asks come from a projects tree it is pointed
// at, so this test builds a throwaway one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, REPO_ROOT, TEST_PASSPHRASE, type Harness } from '../test-support/server-harness.js';

let h: Harness;
let tmp = '';
const SMOKE_TOOL = path.join(REPO_ROOT, 'tools', 'smoke-chat.ts');

function smokeTree(slug: string, smoke: object): string {
  const root = fs.mkdtempSync(path.join(tmp, 'tree-'));
  fs.mkdirSync(path.join(root, 'projects', slug, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', slug, 'tests', 'smoke.json'), JSON.stringify(smoke));
  return root;
}

// Asynchronous on purpose: the fake gateway answers from this process, so a
// synchronous spawn would block the very server the tool's turn is waiting on.
function runSmoke(root: string, env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--import', 'tsx', SMOKE_TOOL, '--url', h.base, '--repo', root], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('close', code => { clearTimeout(timer); resolve({ code, out }); });
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-chat-test-'));
  h = await startServer({});
  await h.admin('demo').saveSystemPrompt('You are a fixture patient.');
  await h.admin('demo').saveVignette('smoke-fixture', 'FIXTURE: a patient with a cough.');
});

after(async () => {
  await h?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a deployment that answers passes, and the cost comes from the server when the passphrase is given', async () => {
  const root = smokeTree('demo', { vignetteKey: 'smoke-fixture', question: 'Hello, what brings you in?' });
  const r = await runSmoke(root, { ADMIN_PASSPHRASE: TEST_PASSPHRASE });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS demo/);
  assert.match(r.out, /\$0\.0000/);                     // the server's own estimate, 15 fake tokens
  const sent = h.fake.requests.at(-1)!.body;
  assert.equal(sent.messages.at(-1).content, 'Hello, what brings you in?');
});

test('a turn that cannot be answered fails the run', async () => {
  const root = smokeTree('demo', { vignetteKey: 'no-such-vignette', question: 'Hello?' });
  const r = await runSmoke(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL demo/);
  assert.match(r.out, /chat/);
});

test('no smoke questions at all is a failure, not a silent pass', async () => {
  const root = fs.mkdtempSync(path.join(tmp, 'empty-'));
  fs.mkdirSync(path.join(root, 'projects'));
  const r = await runSmoke(root);
  assert.equal(r.code, 1, r.out);
});
