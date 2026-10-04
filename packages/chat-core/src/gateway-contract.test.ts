// Run: npm -w @ai-med/chat-core test
//
// The gateway contract between the API (gateway.ts) and its Python twin, the
// corpus builders' tools/lib/openai_gateway.py. An index embedded by one side
// is queried by the other, so the variable names, the default host and the
// embedding model must be the same values; and the Python side's request
// headers are pinned, so a change to either side's header policy is visible.
// Skips when python3 is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_KEY_ENV, EMBEDDING_MODEL, GATEWAY_URL_ENV, OPENAI_DIRECT_URL } from './gateway.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PRELUDE = "import sys, json; sys.path.insert(0, 'tools'); from lib import openai_gateway as g";
const hasPython = spawnSync('python3', ['--version']).status === 0;
const skip = hasPython ? false : 'python3 is not installed';

function python(code: string, env: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // An empty environment apart from PATH, so the developer's own gateway
    // settings never reach the script under test.
    const child = spawn('python3', ['-c', `${PRELUDE}\n${code}`], {
      cwd: REPO, env: { PATH: process.env.PATH ?? '', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

test('the Python builders and the API name the same variables, host and model', { skip }, async () => {
  const r = await python(
    'print(json.dumps({"gateway": g.GATEWAY_URL_ENV, "key": g.API_KEY_ENV, "direct": g.OPENAI_DIRECT_URL, "model": g.EMBED_MODEL}))');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    gateway: GATEWAY_URL_ENV, key: API_KEY_ENV, direct: OPENAI_DIRECT_URL, model: EMBEDDING_MODEL,
  });
});

test('the Python side sends Bearer auth and its own User-Agent to the gateway path', { skip }, async () => {
  const seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ embedding: [0.5, 0.25] }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const r = await python(
      'print(json.dumps(g.embed_batch(g.load_env(), ["a question"], g.EMBED_MODEL)))',
      { [GATEWAY_URL_ENV]: `http://127.0.0.1:${port}/v1`, [API_KEY_ENV]: 'fixture-key-not-real' },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [[0.5, 0.25]]);
    assert.equal(seen.length, 1);
    const [req] = seen;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/embeddings');
    assert.equal(req.headers.authorization, 'Bearer fixture-key-not-real');
    assert.equal(req.headers['user-agent'], 'ai-med-corpus-builder/1.0');
    // Today's policy: no gateway `api-key` header from Python (the TS client sends one).
    assert.equal(req.headers['api-key'], undefined);
    assert.deepEqual(JSON.parse(req.body), { model: EMBEDDING_MODEL, input: ['a question'] });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
