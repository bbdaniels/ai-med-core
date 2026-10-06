// Run: npm -w @ai-med/api test   (node:test under tsx)
//
// Railway replaces a deployment by sending the old container SIGTERM. These
// tests run the production start path (`sh start.sh`, which execs node on the
// built dist/server.js) and send it the signal while a chat turn is waiting on
// the model:
//
//   - the turn in flight is answered, new connections are refused, the usage
//     row is written, and the process exits 0 with nothing on stderr;
//   - when the grace period runs out first, the open connection is cut, the
//     log says so, and the process still exits 0;
//   - a second signal exits 1 at once, with its own log line.
//
// The signal goes to the pid the harness spawned. That pid is the shell from
// start.sh, so an exit code of 0 also shows that `exec` made node that process:
// a shell left in between would die of the signal and report it.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { startServer, API_DIR, type Harness } from '../test-support/server-harness.js';
import { shutdownGraceSeconds, DEFAULT_GRACE_SECONDS } from './shutdown.js';

const PROJECT = 'demo';
const VIGNETTE = 'graceful-stop-fixture';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

before(() => {
  // The bundle the deployment runs; esbuild writes it in well under a second.
  execFileSync(process.execPath, ['build.mjs'], { cwd: API_DIR, stdio: 'pipe' });
});

/** Start a chat turn whose model answer is held for `delayMs`, and return once the model call is in flight. */
async function slowTurn(h: Harness, delayMs: number) {
  const admin = h.admin(PROJECT);
  await admin.saveSystemPrompt('You are a fixture patient.');
  await admin.saveVignette(VIGNETTE, 'FIXTURE VIGNETTE: a sore knee.');
  h.fake.enqueue({ content: 'Held answer from the fake gateway.', delayMs });
  const turn = h.chat(PROJECT, { vignetteKey: VIGNETTE, messages: [{ role: 'user', content: 'What brings you in today?' }] })
    .then(r => ({ ok: true as const, ...r }), (error: unknown) => ({ ok: false as const, error }));
  for (let i = 0; i < 100 && !h.fake.requests.some(r => r.path.endsWith('/chat/completions')); i++) await sleep(20);
  assert.ok(h.fake.requests.some(r => r.path.endsWith('/chat/completions')), 'the model call is in flight');
  // Wrapped: returning the bare promise would make the caller wait for the answer.
  return { turn };
}

const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => Promise.race([
  p,
  new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms).unref()),
]);

test('SIGTERM: the request in flight is answered, then the process exits 0 with a clean stderr', async () => {
  const h = await startServer({ built: true, env: { SHUTDOWN_GRACE_SECONDS: '8' } });
  try {
    const errBefore = h.stderr();
    const { turn } = await slowTurn(h, 1500);
    const sent = Date.now();
    h.signal('SIGTERM');
    await sleep(150);
    await assert.rejects(fetch(`${h.base}/api/health`), 'a new connection is refused while stopping');

    const res = await turn;
    assert.equal(res.ok, true, 'the turn was answered, not reset');
    assert.equal(res.ok && res.status, 200);
    assert.equal(res.ok && res.json.message, 'Held answer from the fake gateway.');

    const exit = await within(h.exited(), 8000, 'exit');
    assert.deepEqual(exit, { code: 0, signal: null });
    // The answer took 1.5 s; the keep-alive connection it came on did not hold the exit.
    assert.ok(Date.now() - sent < 4000, 'well inside the grace period');
    assert.match(h.log(), /Shutdown: SIGTERM received; no new connections, up to 8s for requests in flight/);
    assert.match(h.log(), /Shutdown: requests finished, closing the database/);
    assert.equal(h.stderr().slice(errBefore.length), '', 'nothing on stderr after the signal');
    assert.doesNotMatch(h.stderr(), /error|npm/i);
    // The ledger write that follows the answer landed before the database closed.
    assert.equal(h.tokenUsage(PROJECT).length, 1);
  } finally {
    await h.stop();
  }
});

test('SIGINT stops the same way', async () => {
  const h = await startServer({ built: true });
  try {
    h.signal('SIGINT');
    assert.deepEqual(await within(h.exited(), 5000, 'exit'), { code: 0, signal: null });
    assert.match(h.log(), /Shutdown: SIGINT received/);
  } finally {
    await h.stop();
  }
});

test('the grace period running out cuts the open request, says so, and exits 0', async () => {
  const h = await startServer({ built: true, env: { SHUTDOWN_GRACE_SECONDS: '1' } });
  try {
    const { turn } = await slowTurn(h, 20_000);
    h.signal('SIGTERM');
    const exit = await within(h.exited(), 5000, 'exit');
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.match(h.log(), /Shutdown: grace period of 1s ended with 1 connection\(s\) still open; closing them and exiting/);
    assert.doesNotMatch(h.log(), /requests finished/);
    assert.equal((await turn).ok, false, 'the client sees its connection closed');
  } finally {
    await h.stop();
  }
});

test('a second signal exits 1 at once', async () => {
  const h = await startServer({ built: true, env: { SHUTDOWN_GRACE_SECONDS: '30' } });
  try {
    const { turn } = await slowTurn(h, 20_000);
    h.signal('SIGTERM');
    await sleep(200);
    h.signal('SIGTERM');
    const exit = await within(h.exited(), 3000, 'exit');
    assert.deepEqual(exit, { code: 1, signal: null });
    assert.match(h.log(), /Shutdown: second signal \(SIGTERM\), exiting now without waiting for requests in flight/);
    assert.equal((await turn).ok, false);
  } finally {
    await h.stop();
  }
});

test('the grace period: its own variable, else five seconds inside Railway\'s draining time, else the default', () => {
  assert.equal(shutdownGraceSeconds({}), DEFAULT_GRACE_SECONDS);
  assert.equal(shutdownGraceSeconds({ RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '30' }), 25);
  assert.equal(shutdownGraceSeconds({ RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '3' }), 1);
  assert.equal(shutdownGraceSeconds({ RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '30', SHUTDOWN_GRACE_SECONDS: '12' }), 12);
  assert.equal(shutdownGraceSeconds({ RAILWAY_DEPLOYMENT_DRAINING_SECONDS: 'soon', SHUTDOWN_GRACE_SECONDS: '0' }), DEFAULT_GRACE_SECONDS);
});
