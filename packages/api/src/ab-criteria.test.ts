// Run: npm -w @ai-med/api test   (node:test under tsx)
//
// The arithmetic of the grounding A/B pass criterion (tools/lib/ab-criteria.ts),
// apart from any server or judge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCriteria, percentile, type GradedTurn, type Grade } from '../../../tools/lib/ab-criteria.js';

const turn = (id: number, grade: Grade, o: Partial<GradedTurn> = {}): GradedTurn => ({
  id: `q${id}`, status: 200, beyondScope: false, latencyMs: 3000, grade, wrongPaper: false, ...o,
});
const arm = (grades: Grade[], o: (i: number) => Partial<GradedTurn> = () => ({})) =>
  grades.map((g, i) => turn(i, g, o(i)));
const forty = (correct: number, incorrect: number): Grade[] =>
  [...Array(correct).fill('correct'), ...Array(incorrect).fill('incorrect'),
   ...Array(40 - correct - incorrect).fill('partial')];

test('nearest-rank percentile', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile(Array.from({ length: 40 }, (_, i) => i + 1), 95), 38);
  assert.equal(percentile([7], 95), 7);
  assert.throws(() => percentile([], 95));
});

test('all five hold', () => {
  const r = evaluateCriteria(arm(forty(30, 4)), arm(forty(28, 6)), { a: 0.01, b: 0.006 });
  assert.equal(r.questions, 40);
  assert.deepEqual(r.criteria.map(c => c.pass), [true, true, true, true, true]);
  assert.equal(r.pass, true);
});

test('criterion 1: 5 points is the line', () => {
  // 30/40 = 75%; 28/40 = 70% passes, 27/40 = 67.5% fails.
  assert.equal(evaluateCriteria(arm(forty(30, 4)), arm(forty(28, 6)), { a: 1, b: 0.5 }).criteria[0].pass, true);
  assert.equal(evaluateCriteria(arm(forty(30, 4)), arm(forty(27, 7)), { a: 1, b: 0.5 }).criteria[0].pass, false);
});

test('criterion 2: one wrong-paper attribution in B fails, one in A does not', () => {
  const a = arm(forty(30, 4), i => ({ wrongPaper: i === 3 }));
  assert.equal(evaluateCriteria(a, arm(forty(30, 4)), { a: 1, b: 0.5 }).criteria[1].pass, true);
  const b = arm(forty(30, 4), i => ({ wrongPaper: i === 3 }));
  assert.equal(evaluateCriteria(arm(forty(30, 4)), b, { a: 1, b: 0.5 }).criteria[1].pass, false);
});

test('criterion 3: beyondScope agreement at 85%', () => {
  const a = arm(forty(30, 4));
  const six = arm(forty(30, 4), i => ({ beyondScope: i < 6 }));   // 34/40 = 85%
  const seven = arm(forty(30, 4), i => ({ beyondScope: i < 7 }));
  assert.equal(evaluateCriteria(a, six, { a: 1, b: 0.5 }).criteria[2].pass, true);
  assert.equal(evaluateCriteria(a, seven, { a: 1, b: 0.5 }).criteria[2].pass, false);
});

test('criterion 4: 60% of A\'s cost; no reading cannot pass', () => {
  const g = forty(30, 4);
  assert.equal(evaluateCriteria(arm(g), arm(g), { a: 0.01, b: 0.006 }).criteria[3].pass, true);
  assert.equal(evaluateCriteria(arm(g), arm(g), { a: 0.01, b: 0.0061 }).criteria[3].pass, false);
  const none = evaluateCriteria(arm(g), arm(g), { a: null, b: 0.001 });
  assert.equal(none.criteria[3].pass, null);
  assert.equal(none.pass, false);
});

test('criterion 5: p95 latency within 2 s of A\'s', () => {
  const g = forty(30, 4);
  const a = arm(g, i => ({ latencyMs: 1000 + i * 100 }));            // p95 = 4800
  const ok = arm(g, i => ({ latencyMs: 3000 + i * 100 }));           // p95 = 6800
  const slow = arm(g, i => ({ latencyMs: 3001 + i * 100 }));
  assert.equal(evaluateCriteria(a, ok, { a: 1, b: 0.5 }).criteria[4].pass, true);
  assert.equal(evaluateCriteria(a, slow, { a: 1, b: 0.5 }).criteria[4].pass, false);
});

test('questions are paired by id; none paired cannot pass', () => {
  const r = evaluateCriteria([turn(1, 'correct')], [turn(2, 'correct')], { a: 1, b: 0.5 });
  assert.equal(r.questions, 0);
  assert.equal(r.pass, false);
});
