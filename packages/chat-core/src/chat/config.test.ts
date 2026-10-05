// Run: npm -w @ai-med/chat-core test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadChatProjectConfig } from './config.js';

async function withProject(cfg: object, fn: (root: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-config-'));
  try {
    fs.mkdirSync(path.join(root, 'projects', 'fixture'), { recursive: true });
    fs.writeFileSync(path.join(root, 'projects', 'fixture', 'project.json'), JSON.stringify(cfg));
    await fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('retrieval scope and search-first default off', async () => {
  await withProject({ app: 'talk' }, async root => {
    const c = await loadChatProjectConfig(root, 'fixture', 'fixture');
    assert.equal(c.retrievalScope, 'corpus');
    assert.equal(c.searchFirst, false);
  });
  const c = await loadChatProjectConfig('/no/such/root', 'fixture', 'fixture');
  assert.equal(c.retrievalScope, 'corpus');
  assert.equal(c.searchFirst, false);
});

test('a document-scoped, search-first project', async () => {
  await withProject({ app: 'talk', retrievalScope: 'document', searchFirst: true }, async root => {
    const c = await loadChatProjectConfig(root, 'fixture', 'fixture');
    assert.equal(c.retrievalScope, 'document');
    assert.equal(c.searchFirst, true);
  });
});

test('an unknown scope searches the corpus; a truthy non-boolean is not search-first', async () => {
  const quiet = console.warn;
  console.warn = () => {};
  try {
    await withProject({ retrievalScope: 'paragraph', searchFirst: 'yes' }, async root => {
      const c = await loadChatProjectConfig(root, 'fixture', 'fixture');
      assert.equal(c.retrievalScope, 'corpus');
      assert.equal(c.searchFirst, false);
    });
  } finally {
    console.warn = quiet;
  }
});
