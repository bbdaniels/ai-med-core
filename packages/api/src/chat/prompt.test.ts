// Run: npm -w @ai-med/api test
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assemblePrompt, dateReferenceBlock, STRUCTURED_INSTRUCTION } from './prompt.js';

test('the date block names today and the recent past, six sentences', () => {
  assert.equal(dateReferenceBlock(new Date('2026-10-01T12:00:00Z')),
    'Today is Thursday, October 1, 2026. ' +
    'Yesterday was Wednesday, September 30, 2026. ' +
    'Two days ago was Tuesday, September 29, 2026. ' +
    'Three days ago was Monday, September 28, 2026. ' +
    'Four days ago was Sunday, September 27, 2026. ' +
    'One week ago was Thursday, September 24, 2026.');
});

const base = { systemPrompt: 'SYS', preamble: ['DATE'], documentContent: 'DOC' };

test('plain: system prompt, preamble, document', () => {
  assert.equal(assemblePrompt({ ...base, corpusGrounding: '', structured: false, language: null }),
    'SYS\n\nDATE\n\nDOC');
});

test('structured with a language: the JSON instruction, then the language directive', () => {
  assert.equal(assemblePrompt({ ...base, corpusGrounding: '', structured: true, language: 'Swahili' }),
    'SYS\n\nDATE\n\nDOC\n\n' + STRUCTURED_INSTRUCTION + '\n\nSPEAK ONLY IN Swahili');
});

test('grounding comes after the document and before the JSON instruction', () => {
  assert.equal(assemblePrompt({ ...base, corpusGrounding: 'GROUND', structured: true, language: null }),
    'SYS\n\nDATE\n\nDOC\n\nGROUND\n\n' + STRUCTURED_INSTRUCTION);
  assert.equal(assemblePrompt({ ...base, corpusGrounding: 'GROUND', structured: false, language: 'Tiếng Việt' }),
    'SYS\n\nDATE\n\nDOC\n\nGROUND\n\nSPEAK ONLY IN Tiếng Việt');
});

test('no system prompt and no preamble leave only the separators the document needs', () => {
  assert.equal(assemblePrompt({ systemPrompt: null, preamble: [], documentContent: 'DOC', corpusGrounding: '', structured: false, language: '' }),
    '\n\nDOC');
  assert.equal(assemblePrompt({ systemPrompt: 'S', preamble: ['A', 'B'], documentContent: 'D', corpusGrounding: '', structured: false, language: null }),
    'S\n\nA\n\nB\n\nD');
});

test('the JSON instruction names the three fields and forbids markdown', () => {
  assert.match(STRUCTURED_INSTRUCTION, /^You will respond as a JSON object with \{answer, followups, beyondScope\}\./);
  assert.match(STRUCTURED_INSTRUCTION, /no markdown/);
  assert.match(STRUCTURED_INSTRUCTION, /the interface discloses it\.$/);
});
