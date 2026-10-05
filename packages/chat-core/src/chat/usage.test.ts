// Run: npm -w @ai-med/chat-core test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAT_MODEL_PRICES, cachedTokens, estimateCost, KNOWN_CHAT_MODELS, logChatUsage, sumUsages, type TokenUsageEntry } from './usage.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

test('each model is priced from the one table', () => {
  close(estimateCost('gpt-4o-mini', 1_000_000, 1_000_000), 0.15 + 0.60);
  close(estimateCost('gpt-4o', 1_000_000, 1_000_000), 2.50 + 10.00);
  close(estimateCost('gpt-4.1-mini', 1_000_000, 1_000_000), 0.40 + 1.60);
  close(estimateCost('gpt-4.1', 1_000_000, 1_000_000), 2.00 + 8.00);
  close(estimateCost('gpt-4o-mini-tts', 1_000_000, 0), 12.00);
  close(estimateCost('tts-1', 1_000_000, 0), 15.00);
  close(estimateCost('tts-1-hd', 1_000_000, 0), 30.00);
});

test('an unknown model costs 0', () => {
  assert.equal(estimateCost('gpt-9', 1000, 1000), 0);
});

test('every selectable chat model has a price', () => {
  for (const m of KNOWN_CHAT_MODELS) assert.ok(estimateCost(m, 1, 1) > 0, m);
});

test('the schema allows exactly the priced chat models', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(REPO, 'projects/project-schema.json'), 'utf8'));
  assert.deepEqual([...schema.properties.chatModel.enum].sort(), Object.keys(CHAT_MODEL_PRICES).sort());
});

test('usage is summed over hops; no hops, no usage', () => {
  assert.deepEqual(sumUsages([{ prompt_tokens: 10, completion_tokens: 5 }, { prompt_tokens: 7 }]),
    { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 });
  assert.equal(sumUsages([]), undefined);
});

test('one row per hop, under the usage project string and the chat model', () => {
  const rows: TokenUsageEntry[] = [];
  const store = { logTokenUsage: async (e: TokenUsageEntry) => { rows.push(e); } };
  logChatUsage(store, { usageProject: 'ppol5013_', chatModel: 'gpt-4o' },
    [{ prompt_tokens: 100, completion_tokens: 10 }, { prompt_tokens: 50 }]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => [r.project, r.endpoint, r.model, r.prompt_tokens, r.completion_tokens]),
    [['ppol5013_', '/api/chat', 'gpt-4o', 100, 10], ['ppol5013_', '/api/chat', 'gpt-4o', 50, 0]]);
  close(rows[0].estimated_cost, estimateCost('gpt-4o', 100, 10));
});

test('cached prompt tokens are billed at the cached rate', () => {
  // 1M prompt tokens of which 600k were cache hits, 1M completion tokens.
  close(estimateCost('gpt-4.1-mini', 1_000_000, 1_000_000, 600_000), 0.4 * 0.40 + 0.6 * 0.10 + 1.60);
  close(estimateCost('gpt-4o-mini', 1_000_000, 0, 1_000_000), 0.075);
  close(estimateCost('gpt-4o', 1_000_000, 0, 1_000_000), 1.25);
  close(estimateCost('gpt-4.1', 1_000_000, 0, 1_000_000), 0.50);
  // No cache report, no discount; a report larger than the prompt is clamped to it.
  close(estimateCost('gpt-4o', 1000, 0), estimateCost('gpt-4o', 1000, 0, 0));
  close(estimateCost('gpt-4o', 1000, 0, 5000), estimateCost('gpt-4o', 1000, 0, 1000));
  // TTS has no cached rate.
  close(estimateCost('tts-1', 1_000_000, 0, 1_000_000), 15.00);
});

test('cached tokens are read off the usage object the API returns', () => {
  assert.equal(cachedTokens({ prompt_tokens: 2000, prompt_tokens_details: { cached_tokens: 1536 } }), 1536);
  assert.equal(cachedTokens({ prompt_tokens: 2000, prompt_tokens_details: {} }), 0);
  assert.equal(cachedTokens({ prompt_tokens: 2000, prompt_tokens_details: null }), 0);
  assert.equal(cachedTokens({ prompt_tokens: 2000 }), 0);
  assert.equal(cachedTokens(undefined), 0);
});

test('a hop with cache hits is logged at the cached rate', () => {
  const rows: TokenUsageEntry[] = [];
  const store = { logTokenUsage: async (e: TokenUsageEntry) => { rows.push(e); } };
  logChatUsage(store, { usageProject: 'papers_', chatModel: 'gpt-4.1-mini' },
    [{ prompt_tokens: 3000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 2048 } }]);
  assert.equal(rows[0].prompt_tokens, 3000);
  close(rows[0].estimated_cost, (952 * 0.40 + 2048 * 0.10 + 200 * 1.60) / 1_000_000);
});
