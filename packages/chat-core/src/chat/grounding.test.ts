// Run: npm -w @ai-med/chat-core test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { corpusGroundingFile, loadCorpusGrounding } from './grounding.js';
import type { ChatProjectConfig } from './types.js';

let root = '';

const cfg = (slug: string, groundingFile: string | null): ChatProjectConfig => ({
  slug, usageProject: `${slug}_`, app: 'talk', enableFollowups: true, logConversations: false,
  readingsIndexPath: null, readingsQueryLanguage: null, chatModel: 'gpt-4o-mini', groundingFile,
});

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
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

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
