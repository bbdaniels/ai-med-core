// Run: npm -w @ai-med/api test   (node:test under tsx)
//
// tools/push-content.ts deletes every deployed vignette that the checked-out
// project.json no longer names, and CI runs it on every merge to main. These
// tests pin the guard that keeps one uncommitted or half-synced project.json
// from wiping a deployment: removals are refused, unless --prune is given,
// when the local list is empty, when the project refuses unknown vignettes
// (its keys are deep links someone holds), or when they are a mass deletion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planStaleRemoval } from '../../../tools/lib/stale-removal.js';

const keys = (n: number, prefix = 'k') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
const plain = { prune: false, requireKnownVignette: false };

test('a normal single stale key is removed', () => {
  const remote = keys(10);
  const local = remote.filter(k => k !== 'k4');
  assert.deepEqual(planStaleRemoval(local, remote, plain), { remove: ['k4'], refused: [] });
});

test('nothing stale, nothing removed or refused', () => {
  assert.deepEqual(planStaleRemoval(keys(5), keys(5), plain), { remove: [], refused: [] });
  assert.deepEqual(planStaleRemoval(keys(5), keys(3), { prune: false, requireKnownVignette: true }),
                   { remove: [], refused: [] });
});

test('an empty local list refuses every removal', () => {
  const remote = keys(2);
  assert.deepEqual(planStaleRemoval([], remote, plain), { remove: [], refused: remote });
});

test('a project that refuses unknown vignettes keeps its deployed keys', () => {
  const remote = ['deck-a--s1', 'deck-a--s2', 'deck-a--s3'];
  const local = ['deck-a--s1', 'deck-a--s2'];
  assert.deepEqual(planStaleRemoval(local, remote, { prune: false, requireKnownVignette: true }),
                   { remove: [], refused: ['deck-a--s3'] });
  // The empty-list case for the same project, which is what a CI push of an
  // uncommitted sync looks like.
  assert.deepEqual(planStaleRemoval([], remote, { prune: false, requireKnownVignette: true }),
                   { remove: [], refused: remote });
});

test('a mass removal is refused: more than max(3, 25% of remote)', () => {
  // 20 remote: the limit is 5. Five go; six are refused.
  const remote = keys(20);
  assert.deepEqual(planStaleRemoval(remote.slice(5), remote, plain).remove, keys(5));
  const six = planStaleRemoval(remote.slice(6), remote, plain);
  assert.deepEqual(six, { remove: [], refused: keys(6) });
  // 4 remote: the floor of 3 applies. Three go; four are refused.
  const small = keys(4);
  assert.deepEqual(planStaleRemoval(['k4'], small, plain).remove, ['k1', 'k2', 'k3']);
  assert.deepEqual(planStaleRemoval(['x'], small, plain).refused, small);
});

test('--prune removes whatever is stale', () => {
  const remote = keys(20);
  const prune = { prune: true, requireKnownVignette: true };
  assert.deepEqual(planStaleRemoval([], remote, prune), { remove: remote, refused: [] });
  assert.deepEqual(planStaleRemoval(['k1'], remote, prune).remove, remote.slice(1));
});
