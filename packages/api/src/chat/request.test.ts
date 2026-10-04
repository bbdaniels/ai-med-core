// Run: npm -w @ai-med/api test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatInputError } from './pipeline.js';
import { resolveDocumentKey } from './request.js';

const refused = (b: object, message: string) =>
  assert.throws(() => resolveDocumentKey(b), (e: unknown) =>
    e instanceof ChatInputError && e.status === 400 && e.message === message);

test('either name alone', () => {
  assert.equal(resolveDocumentKey({ documentKey: 'doc-a' }), 'doc-a');
  assert.equal(resolveDocumentKey({ vignetteKey: 'doc-a' }), 'doc-a');
});

test('both, agreeing', () => {
  assert.equal(resolveDocumentKey({ documentKey: 'doc-a', vignetteKey: 'doc-a' }), 'doc-a');
});

test('both, differing, is refused', () => {
  refused({ documentKey: 'doc-a', vignetteKey: 'doc-b' }, 'documentKey and vignetteKey differ');
});

test('neither keeps the old error', () => {
  refused({}, 'vignetteKey is required');
  refused({ documentKey: '', vignetteKey: '' }, 'vignetteKey is required');
});

test('an empty name does not count as given', () => {
  assert.equal(resolveDocumentKey({ documentKey: '', vignetteKey: 'doc-a' }), 'doc-a');
  assert.equal(resolveDocumentKey({ documentKey: 'doc-a', vignetteKey: '' }), 'doc-a');
});
