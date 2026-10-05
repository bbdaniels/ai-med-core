// Run: npm -w @ai-med/chat-core test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { corpusGroundingFile, loadCorpusGrounding } from './grounding.js';
import type { ChatProjectConfig } from './types.js';

let root = '';

let store = '';

const cfg = (slug: string, groundingFile: string | null, groundingSets: string[] = []): ChatProjectConfig => ({
  slug, usageProject: `${slug}_`, app: 'talk', enableFollowups: true, logConversations: false,
  readingsIndexPath: null, readingsQueryLanguage: null, chatModel: 'gpt-4o-mini', groundingFile, groundingSets,
  retrievalScope: 'corpus', searchFirst: false, followHost: null,
});

/** Run fn with console.warn captured; returns what was warned. */
async function warnings(fn: () => Promise<void>): Promise<string[]> {
  const quiet = console.warn;
  const out: string[] = [];
  console.warn = (...a: unknown[]) => { out.push(a.join(' ')); };
  try { await fn(); } finally { console.warn = quiet; }
  return out;
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-test-'));
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('projects/declared/notes/index.md', 'DECLARED');
  write('projects/declared/content/readings/grounding.md', 'LEGACY-SHOULD-NOT-WIN');
  write('projects/legal/content/legal/grounding.md', 'LEGAL');
  write('projects/legal/content/readings/grounding.md', 'READINGS');
  write('projects/readings/content/readings/grounding.md', 'READINGS-ONLY');
  write('outside.md', 'OUTSIDE');
  // Grounding sets: set-a in the checkout, set-b only in the private store,
  // set-c declared with its file nowhere.
  write('projects/sets/notes/project.md', 'PROJECT');
  write('projects/sets/grounding/set-a.md', 'SET-A');
  store = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-store-'));
  fs.mkdirSync(path.join(store, 'projects/sets/grounding'), { recursive: true });
  fs.writeFileSync(path.join(store, 'projects/sets/grounding/set-b.md'), 'SET-B');
  fs.writeFileSync(path.join(store, 'projects/sets/grounding/set-a.md'), 'SET-A-IN-STORE-SHOULD-NOT-WIN');
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (store) fs.rmSync(store, { recursive: true, force: true });
});

test('a declared groundingFile is read, and wins over the legacy locations', async () => {
  assert.equal(await loadCorpusGrounding(root, cfg('declared', 'projects/declared/notes/index.md')), 'DECLARED');
  assert.equal(await corpusGroundingFile(root, cfg('declared', 'projects/declared/notes/index.md')),
    path.join(path.resolve(root), 'projects/declared/notes/index.md'));
});

test('without one, the legacy candidates in order: legal, then readings', async () => {
  assert.equal(await loadCorpusGrounding(root, cfg('legal', null)), 'LEGAL');
  assert.equal(await loadCorpusGrounding(root, cfg('readings', null)), 'READINGS-ONLY');
  assert.equal(await loadCorpusGrounding(root, cfg('none', null)), '');
  assert.equal(await corpusGroundingFile(root, cfg('none', null)), null);
});

test('a declared path must stay inside the repo root; a missing one grounds nothing', async () => {
  const quiet = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await loadCorpusGrounding(root, cfg('declared', '../outside.md')), '');
    assert.equal(await loadCorpusGrounding(path.join(root, 'projects'), cfg('declared', '../outside.md')), '');
    assert.equal(await loadCorpusGrounding(root, cfg('legal', 'projects/legal/missing.md')), '');
  } finally {
    console.warn = quiet;
  }
});

test('grounding sets: the current document\'s set file wins, the checkout before the private store', async () => {
  const sets = cfg('sets', 'projects/sets/notes/project.md', ['set-a', 'set-b', 'set-c']);
  const at = (documentKey: string | null, privateRoot: string | null = store) => loadCorpusGrounding(root, sets, { documentKey, privateRoot });
  assert.equal(await at('set-a--slide-1'), 'SET-A');
  assert.equal(await at('set-a--slide-2--part'), 'SET-A', 'the set is the part before the first "--"');
  assert.equal(await at('set-b--slide-1'), 'SET-B', 'a private set file is read from the store');
  assert.equal(await corpusGroundingFile(root, sets, { documentKey: 'set-b--x', privateRoot: store }),
    path.join(path.resolve(store), 'projects/sets/grounding/set-b.md'));
  // A document of an unlisted set, a key with no set, and no document: the project's grounding.
  assert.equal(await at('set-z--slide-1'), 'PROJECT');
  assert.equal(await at('set-a'), 'SET-A', 'a key without "--" is its own set');
  assert.equal(await at(null), 'PROJECT');
  assert.equal(await loadCorpusGrounding(root, sets), 'PROJECT');
});

test('grounding sets: a listed set whose file is nowhere falls back to the project\'s grounding, with a warning', async () => {
  const sets = cfg('sets', 'projects/sets/notes/project.md', ['set-a', 'set-b', 'set-c']);
  let text = '';
  const w = await warnings(async () => { text = await loadCorpusGrounding(root, sets, { documentKey: 'set-c--one', privateRoot: store }); });
  assert.equal(text, 'PROJECT');
  assert.match(w.join('\n'), /projects\/sets\/grounding\/set-c\.md is in neither the checkout nor the private store/);
  // Without a store, a private set file is not found either.
  const w2 = await warnings(async () => { text = await loadCorpusGrounding(root, sets, { documentKey: 'set-b--one', privateRoot: null }); });
  assert.equal(text, 'PROJECT');
  assert.equal(w2.length, 1);
  // With no groundingFile either, the legacy locations, then nothing.
  const bare = cfg('sets', null, ['set-c']);
  await warnings(async () => { text = await loadCorpusGrounding(root, bare, { documentKey: 'set-c--one' }); });
  assert.equal(text, '');
});

test('grounding sets: an unlisted set\'s file is never read, and a project without sets is unchanged', async () => {
  // set-a's file exists, but the project lists only set-b.
  assert.equal(await loadCorpusGrounding(root, cfg('sets', 'projects/sets/notes/project.md', ['set-b']), { documentKey: 'set-a--one', privateRoot: store }), 'PROJECT');
  assert.equal(await loadCorpusGrounding(root, cfg('sets', 'projects/sets/notes/project.md'), { documentKey: 'set-a--one', privateRoot: store }), 'PROJECT');
  assert.equal(await loadCorpusGrounding(root, cfg('legal', null), { documentKey: 'set-a--one', privateRoot: store }), 'LEGAL');
});
