// Run: npm -w @ai-med/api test   (node:test under tsx)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpenAI } from 'openai';
import {
  buildOpenAIClients, clientForPaymentSource, DirectKeyMissingError, OPENAI_DIRECT_URL,
} from './openai-clients.js';

const GATEWAY = 'https://gateway.example.test/v1';
const DECOY = 'https://decoy.example.invalid/v1';

// The SDK fills baseURL, organization and project from these when a client
// leaves them undefined. Set all of them to decoys for every test in this file.
process.env.OPENAI_BASE_URL = DECOY;
process.env.OPENAI_ORG_ID = 'org-decoy';
process.env.OPENAI_PROJECT_ID = 'proj-decoy';

function target(client: OpenAI): { host: string; org: unknown; project: unknown } {
  // buildURL is the SDK's own request-URL builder, the same one every call uses.
  const url = new URL((client as any).buildURL('/chat/completions', undefined));
  return { host: url.origin + url.pathname, org: client.organization, project: client.project };
}

test('with a gateway configured, each client targets its own host despite OPENAI_BASE_URL', () => {
  const c = buildOpenAIClients({
    OPENAI_API_KEY: 'k-gateway', OPENAI_TTS_KEY: 'k-direct', HARVARD_GATEWAY_URL: GATEWAY,
    OPENAI_BASE_URL: DECOY,
  });
  assert.equal(c.usesGateway, true);
  assert.deepEqual(target(c.gateway), { host: `${GATEWAY}/chat/completions`, org: null, project: null });
  assert.ok(c.direct);
  assert.deepEqual(target(c.direct), { host: `${OPENAI_DIRECT_URL}/chat/completions`, org: null, project: null });
  assert.equal((c.gateway as any)._options.defaultHeaders['api-key'], 'k-gateway');
  assert.equal(c.direct.apiKey, 'k-direct');
  assert.equal(c.realtimeKey, 'k-direct');
});

test('without a gateway, the gateway client is api.openai.com, not OPENAI_BASE_URL', () => {
  const c = buildOpenAIClients({ OPENAI_API_KEY: 'k-main', OPENAI_BASE_URL: DECOY });
  assert.equal(c.usesGateway, false);
  assert.equal(target(c.gateway).host, `${OPENAI_DIRECT_URL}/chat/completions`);
  assert.equal((c.gateway as any)._options.defaultHeaders, undefined);
  // OPENAI_API_KEY is itself a direct key here, so direct features keep working.
  assert.ok(c.direct);
  assert.equal(target(c.direct).host, `${OPENAI_DIRECT_URL}/chat/completions`);
  assert.equal(c.direct.apiKey, 'k-main');
});

test('a gateway with no direct key leaves direct-only features without a client, never the gateway', () => {
  const c = buildOpenAIClients({ OPENAI_API_KEY: 'k-gateway', HARVARD_GATEWAY_URL: GATEWAY });
  assert.equal(c.direct, null);
  assert.equal(c.realtimeKey, '');
  assert.equal(clientForPaymentSource('harvard', c), c.gateway);
  assert.equal(clientForPaymentSource(null, c), c.gateway);
  assert.throws(() => clientForPaymentSource('direct', c), DirectKeyMissingError);
});

test('OPENAI_REALTIME_KEY overrides the direct key for realtime only', () => {
  const c = buildOpenAIClients({
    OPENAI_API_KEY: 'k-gateway', HARVARD_GATEWAY_URL: GATEWAY, OPENAI_REALTIME_KEY: 'k-rt',
  });
  assert.equal(c.realtimeKey, 'k-rt');
  assert.equal(c.direct, null);
});

test('a missing OPENAI_API_KEY fails loudly', () => {
  assert.throws(() => buildOpenAIClients({ OPENAI_BASE_URL: DECOY }), /OPENAI_API_KEY is not set/);
});

test('openai-clients.ts is the only place `new OpenAI(` appears', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '../../..');
  const roots = [path.join(repoRoot, 'packages/api/src'), path.join(repoRoot, 'tools')];
  const allowed = path.join(repoRoot, 'packages/api/src/openai-clients.ts');
  const self = fileURLToPath(import.meta.url);
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx|js|mjs)$/.test(name) || p === allowed || p === self) continue;
      if (/new\s+(OpenAI|AzureOpenAI)\s*\(/.test(readFileSync(p, 'utf8'))) offenders.push(path.relative(repoRoot, p));
    }
  };
  roots.forEach(walk);
  assert.deepEqual(offenders, []);
});
