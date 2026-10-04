// Run: npm -w @ai-med/api test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonObject, parseStructuredAnswer } from './answer.js';

const S = { structured: true };

test('a JSON answer followed by whitespace padding parses', () => {
  const raw = JSON.stringify({ answer: 'Yes.', followups: ['a?', 'b?'], beyondScope: false }) + '\n\n   \n';
  assert.deepEqual(parseStructuredAnswer(raw, S), { message: 'Yes.', followups: ['a?', 'b?'], beyondScope: false });
});

test('the object is brace-matched, strings and escapes included', () => {
  assert.equal(extractJsonObject('pre {"a":"}{\\"","b":{"c":1}} post {"d":2}'), '{"a":"}{\\"","b":{"c":1}}');
  assert.equal(extractJsonObject('no object'), null);
  assert.equal(extractJsonObject('{"open": 1'), null);
});

test('prose with no JSON is returned as it came', () => {
  assert.deepEqual(parseStructuredAnswer('Just prose.', S), { message: 'Just prose.', followups: [], beyondScope: false });
});

test('an empty answer field keeps the raw text; an empty completion apologizes', () => {
  const raw = JSON.stringify({ answer: '   ', followups: ['a?'], beyondScope: true });
  assert.deepEqual(parseStructuredAnswer(raw, S), { message: raw, followups: ['a?'], beyondScope: true });
  assert.deepEqual(parseStructuredAnswer('', S), { message: 'No response generated', followups: [], beyondScope: false });
  assert.deepEqual(parseStructuredAnswer('   ', S), {
    message: 'Sorry, I had trouble generating a response. Please try rephrasing your question.',
    followups: [], beyondScope: false,
  });
});

test('at most three followups, blank ones dropped', () => {
  const raw = JSON.stringify({ answer: 'A.', followups: ['1?', '', '2?', 7, '3?', '4?', '5?'], beyondScope: false });
  assert.deepEqual(parseStructuredAnswer(raw, S).followups, ['1?', '2?', '3?']);
});

test('beyondScope accepts true and "true", and nothing else', () => {
  const at = (v: unknown) => parseStructuredAnswer(JSON.stringify({ answer: 'A.', followups: [], beyondScope: v }), S).beyondScope;
  assert.equal(at(true), true);
  assert.equal(at('true'), true);
  assert.equal(at('yes'), false);
  assert.equal(at(1), false);
});

test('an unstructured project gets the text untouched, even if it looks like JSON', () => {
  const raw = '{"answer": "x"}';
  assert.deepEqual(parseStructuredAnswer(raw, { structured: false }), { message: raw, followups: [], beyondScope: false });
  assert.deepEqual(parseStructuredAnswer(null, { structured: false }), { message: 'No response generated', followups: [], beyondScope: false });
  assert.deepEqual(parseStructuredAnswer('   ', { structured: false }), { message: '   ', followups: [], beyondScope: false });
});
