// Run: npm -w @ai-med/chat-core test   (node:test under tsx)
//
// The request deadline (deadline.ts): what it is, that an outbound fetch and an
// OpenAI client call stop at it, and that untilDeadline settles at it even
// while the OpenAI SDK sleeps on a Retry-After before its retry.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CLOUDFLARE_ORIGIN_TIMEOUT_MS, REQUEST_DEADLINE_MS, DeadlineExceededError,
  deadlineFetch, requestDeadlineMs, requestSignal, untilDeadline, withRequestDeadline,
} from './deadline.js';
import { buildOpenAIClients, OPENAI_MAX_RETRIES, OPENAI_TIMEOUT_MS } from './openai-clients.js';

let server: http.Server;
let base = '';
let hits = 0;

// /slow never answers within a test; /retry-later answers 429 with a
// Retry-After of 5 s, which the SDK sleeps on before retrying.
before(async () => {
  server = http.createServer((req, res) => {
    hits++;
    req.resume();
    if (req.url?.startsWith('/slow')) return; // left open; closed in after()
    res.statusCode = 429;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('retry-after', '5');
    res.end(JSON.stringify({ error: { message: 'slow down', type: 'rate_limit' } }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>(r => server.close(() => r()));
});

const elapsed = async (fn: () => Promise<unknown>): Promise<{ ms: number; error: unknown }> => {
  const t0 = Date.now();
  try { await fn(); return { ms: Date.now() - t0, error: null }; } catch (error) { return { ms: Date.now() - t0, error }; }
};

test('the deadline is under Cloudflare\'s cutoff, and one OpenAI attempt fits inside it', () => {
  assert.equal(REQUEST_DEADLINE_MS, 85_000);
  assert.ok(REQUEST_DEADLINE_MS < CLOUDFLARE_ORIGIN_TIMEOUT_MS);
  assert.ok(OPENAI_TIMEOUT_MS < REQUEST_DEADLINE_MS);
  assert.ok(OPENAI_MAX_RETRIES >= 0 && OPENAI_MAX_RETRIES < 2, 'fewer retries than the SDK default of 2');
});

test('REQUEST_DEADLINE_MS in the environment may shorten it; a value at or past the cutoff is refused', () => {
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  assert.equal(requestDeadlineMs({}, warn), REQUEST_DEADLINE_MS);
  assert.equal(requestDeadlineMs({ REQUEST_DEADLINE_MS: ' 1500 ' }, warn), 1500);
  assert.equal(warnings.length, 0);
  for (const bad of ['100000', '0', '-5', '1.5', 'soon']) {
    assert.equal(requestDeadlineMs({ REQUEST_DEADLINE_MS: bad }, warn), REQUEST_DEADLINE_MS, bad);
  }
  assert.equal(warnings.length, 5);
});

test('outside a request there is no deadline in context', () => {
  assert.equal(requestSignal(), undefined);
});

test('a fetch in flight stops at the deadline with DeadlineExceededError', async () => {
  const r = await withRequestDeadline(300, () => elapsed(() => deadlineFetch(`${base}/slow`)));
  assert.ok(r.error instanceof DeadlineExceededError, String(r.error));
  assert.ok(r.ms >= 250 && r.ms < 2_000, `stopped after ${r.ms} ms`);
});

test('a fetch begun after the deadline fails at once, without reaching the network', async () => {
  await withRequestDeadline(50, async () => {
    await new Promise(r => setTimeout(r, 120));
    const before = hits;
    const r = await elapsed(() => deadlineFetch(`${base}/slow`));
    assert.ok(r.error instanceof DeadlineExceededError);
    assert.equal(hits, before);
  });
});

test('the caller\'s own signal still applies inside the deadline', async () => {
  const r = await withRequestDeadline(5_000, () =>
    elapsed(() => deadlineFetch(`${base}/slow`, { signal: AbortSignal.timeout(200) })));
  assert.ok(r.error && !(r.error instanceof DeadlineExceededError), 'the caller\'s timeout, not the deadline');
  assert.ok(r.ms < 2_000);
});

test('an OpenAI client call stops at the deadline, even while the SDK sleeps on Retry-After', async () => {
  const { gateway } = buildOpenAIClients({ OPENAI_API_KEY: 'k', HARVARD_GATEWAY_URL: `${base}/retry-later` });
  const r = await withRequestDeadline(400, () => elapsed(() =>
    untilDeadline(gateway.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }))));
  assert.ok(r.error instanceof DeadlineExceededError, String(r.error));
  assert.ok(r.ms >= 350 && r.ms < 2_000, `answered after ${r.ms} ms, not after the 5 s Retry-After`);
});

test('an OpenAI client call in flight is aborted at the deadline', async () => {
  const { gateway } = buildOpenAIClients({ OPENAI_API_KEY: 'k', HARVARD_GATEWAY_URL: `${base}/slow` });
  const r = await withRequestDeadline(300, () => elapsed(() =>
    untilDeadline(gateway.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }))));
  assert.ok(r.error instanceof DeadlineExceededError, String(r.error));
  assert.ok(r.ms < 2_000, `stopped after ${r.ms} ms`);
});

test('untilDeadline passes a result or an error through, and outside a request is the work itself', async () => {
  assert.equal(await withRequestDeadline(1_000, () => untilDeadline(Promise.resolve(7))), 7);
  await assert.rejects(withRequestDeadline(1_000, () => untilDeadline(Promise.reject(new Error('own')))), /own/);
  const work = Promise.resolve('x');
  assert.equal(untilDeadline(work), work);
});
