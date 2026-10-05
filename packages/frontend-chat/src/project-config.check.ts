// Standalone check: npx tsx packages/frontend-chat/src/project-config.check.ts
import assert from 'node:assert/strict';
import { DEFAULT_PROJECT_CONFIG, parseProjectConfig } from './chat/project-config.js';

let n = 0;
const check = (name: string, fn: () => void) => { fn(); n++; void name; };

check('an empty or unreadable body is the defaults', () => {
  assert.deepEqual(parseProjectConfig({}, 'slug'), DEFAULT_PROJECT_CONFIG);
  assert.deepEqual(parseProjectConfig(null, 'slug'), DEFAULT_PROJECT_CONFIG);
  assert.equal(DEFAULT_PROJECT_CONFIG.enableFeedback, true);
});

check('flags are on only when the body says so', () => {
  const c = parseProjectConfig({ formless: true, skipWelcome: 1, chatOnly: false, requireAccessCode: true, requireKnownVignette: true }, 'slug');
  assert.equal(c.formless, true);
  assert.equal(c.skipWelcome, true);
  assert.equal(c.chatOnly, false);
  assert.equal(c.requireAccessCode, true);
  assert.equal(c.requireKnownVignette, true);
  assert.equal(c.enableVoice, false);
});

check('enableFeedback is off only when the body says false', () => {
  assert.equal(parseProjectConfig({ enableFeedback: false }, 's').enableFeedback, false);
  assert.equal(parseProjectConfig({ enableFeedback: 0 }, 's').enableFeedback, true);
  assert.equal(parseProjectConfig({ enableFeedback: true }, 's').enableFeedback, true);
});

check('the manifest slug is the table prefix without trailing underscores, else the build slug', () => {
  assert.equal(parseProjectConfig({ talkManifest: 'x.json', tablePrefix: 'alpha__' }, 'beta').talkManifestSlug, 'alpha');
  assert.equal(parseProjectConfig({ talkManifest: 'x.json' }, 'beta').talkManifestSlug, 'beta');
  assert.equal(parseProjectConfig({ talkManifest: 'x.json' }, '').talkManifestSlug, null);
  assert.equal(parseProjectConfig({ tablePrefix: 'alpha' }, 'beta').talkManifestSlug, null);
});

check('talkPublicUrl is kept only as a string', () => {
  assert.equal(parseProjectConfig({ talkPublicUrl: 'https://example.org/#x-{slug}' }, 's').talkPublicUrl, 'https://example.org/#x-{slug}');
  assert.equal(parseProjectConfig({ talkPublicUrl: 3 }, 's').talkPublicUrl, '');
});

check('docRefs needs a tabId', () => {
  const refs = { tabId: 'doc', patterns: [] };
  assert.deepEqual(parseProjectConfig({ docRefs: refs }, 's').docRefs, refs);
  assert.equal(parseProjectConfig({ docRefs: { patterns: [] } }, 's').docRefs, null);
  assert.equal(parseProjectConfig({ docRefs: 'doc' }, 's').docRefs, null);
});

console.log(`project-config checks: ${n}/${n} passed`);
