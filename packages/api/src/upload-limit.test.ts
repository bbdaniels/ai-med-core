// Run: npm -w @ai-med/api test
//
// The admin upload routes (a readings index, a private content file) refuse a
// body Cloudflare would refuse anyway (Cloudflare Free's request limit is
// 100 MB), so an upload that is too large fails here with a clear 413 in local
// tests as it would behind the proxy, and accept a body the size of today's
// largest index (26 MB).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, TEST_PASSPHRASE, type Harness } from '../test-support/server-harness.js';

const CLOUDFLARE_FREE_BODY_LIMIT = 100_000_000;
const LARGEST_INDEX_TODAY = 26_000_000;

let h: Harness;
let token = '';

before(async () => {
  h = await startServer({});
  const login = await fetch(`${h.base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Project': 'demo' },
    body: JSON.stringify({ passphrase: TEST_PASSPHRASE }),
  });
  token = ((await login.json()) as any).token;
  assert.ok(token);
});

after(async () => { await h?.stop(); });

async function upload(method: 'POST' | 'PUT', route: string, bytes: number): Promise<number> {
  const res = await fetch(`${h.base}${route}`, {
    method,
    headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${token}`, 'X-Project': 'demo' },
    body: Buffer.alloc(bytes, 1),
  });
  await res.arrayBuffer();
  return res.status;
}

for (const [method, route] of [['POST', '/api/admin/readings-index'], ['PUT', '/api/admin/private-content/projects/demo/content/x.md']] as const) {
  test(`${method} ${route}: a body at Cloudflare's limit is refused 413, today's largest index is not`, async () => {
    assert.equal(await upload(method, route, CLOUDFLARE_FREE_BODY_LIMIT), 413);
    // Past the body parser: whatever the route then answers, it is not the size.
    assert.notEqual(await upload(method, route, LARGEST_INDEX_TODAY), 413);
  });
}
