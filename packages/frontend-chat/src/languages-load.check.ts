// Standalone check: npx tsx packages/frontend-chat/src/languages-load.check.ts
import assert from 'node:assert/strict';
import { FALLBACK_LANGUAGES, loadLanguages } from './chat/languages-load.js';

const FILE = { languages: [{ code: 'en', name: 'English' }], ui: { en: { chat: { openingMessage: 'Hi.' } } } };
const respond = (status: number, body: unknown) => async () =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let n = 0;
const check = async (name: string, fn: () => Promise<void>) => { await fn(); n++; void name; };

await check('a 200 languages object is the file', async () => {
  const r = await loadLanguages(respond(200, FILE));
  assert.equal(r.status, 'ready');
  assert.ok(r.status === 'ready' && r.source === 'file');
  assert.deepEqual(r.status === 'ready' && r.langs, FILE);
});

await check('a 404 is a project with no languages file: the fallback, with a fixed opening (no model call)', async () => {
  const r = await loadLanguages(respond(404, { error: 'Languages configuration not found' }));
  assert.ok(r.status === 'ready' && r.source === 'fallback');
  assert.equal(r.status === 'ready' && r.langs, FALLBACK_LANGUAGES);
  const opening = (FALLBACK_LANGUAGES.ui.en.chat as { openingMessage?: unknown }).openingMessage;
  assert.ok(typeof opening === 'string' && opening.trim() !== '', 'the fallback has an opening message');
  assert.deepEqual(FALLBACK_LANGUAGES.languages.map(l => l.code), ['en']);
});

await check('any other non-OK status is an error, never a languages file', async () => {
  for (const status of [400, 401, 403, 429, 500, 502, 503]) {
    const r = await loadLanguages(respond(status, { error: 'x' }));
    assert.equal(r.status, 'error', String(status));
    assert.match(r.status === 'error' ? r.message : '', new RegExp(`HTTP ${status}`));
  }
});

await check('a 200 whose body is not a languages object is an error', async () => {
  for (const body of [{ error: 'x' }, [], null, { ui: [] }, { ui: {}, languages: 'en' }]) {
    assert.equal((await loadLanguages(respond(200, body))).status, 'error', JSON.stringify(body));
  }
  assert.equal((await loadLanguages(respond(200, '<html>not json'))).status, 'error');
});

await check('a network failure is an error, not an endless load', async () => {
  const r = await loadLanguages(async () => { throw new TypeError('Failed to fetch'); });
  assert.equal(r.status, 'error');
  assert.match(r.status === 'error' ? r.message : '', /Failed to fetch/);
});

console.log(`languages-load checks: ${n}/${n} passed`);
