// Run: npm -w @ai-med/api test
//
// What differs between the simulator's hooks and document chat's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { talkHooks } from '@ai-med/chat-core';
import { simulationHooks, type HookDeps } from './hooks.js';

const deps: HookDeps = {
  getCaseTemplate: async () => JSON.stringify({ vignetteTemplates: { 'doc-a': 'fixture_template' } }),
  transcriptsDir: '/nonexistent/transcripts',
};

test('the simulator names the case template; talk never does', async () => {
  const quiet = console.log;
  console.log = () => {};
  try {
    assert.equal(await simulationHooks(deps).caseTemplateFor('doc-a'), 'fixture_template');
    assert.equal(await talkHooks().caseTemplateFor('doc-a'), null);
  } finally {
    console.log = quiet;
  }
});

test('only the simulator keeps a first-turn prompt snapshot', () => {
  assert.equal(typeof simulationHooks(deps).onFirstTurn, 'function');
  assert.equal(talkHooks().onFirstTurn, undefined);
});

test('both put the date block before the document', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  const cfg = {} as any;
  assert.deepEqual(talkHooks().promptPreamble({ now, config: cfg }), simulationHooks(deps).promptPreamble({ now, config: cfg }));
});
