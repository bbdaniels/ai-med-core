// Run: npm -w @ai-med/api test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost, KNOWN_CHAT_MODELS, logChatUsage, sumUsages, type TokenUsageEntry } from './usage.js';

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

test('each model is priced from the one table', () => {
  close(estimateCost('gpt-4o-mini', 1_000_000, 1_000_000), 0.15 + 0.60);
  close(estimateCost('gpt-4o', 1_000_000, 1_000_000), 2.50 + 10.00);
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
