/**
 * The pass criterion of a grounding A/B (tools/ab-grounding.ts): arm B, the
 * candidate, against arm A, the deployed configuration, over the same
 * questions. All five must hold for B:
 *
 *   1. correct rate at least A's minus 5 points;
 *   2. zero wrong-paper attributions;
 *   3. beyondScope agreement with A on at least 85% of questions;
 *   4. mean estimated cost per turn at most 60% of A's;
 *   5. p95 latency at most A's plus 2 s.
 *
 * Pure, so the arithmetic is tested apart from any server or judge.
 */

export type Grade = 'correct' | 'partial' | 'incorrect' | 'declined';

export interface GradedTurn {
  /** The question id; A and B are paired on it. */
  id: string;
  /** HTTP status of the chat turn; anything but 200 is a failed turn. */
  status: number;
  beyondScope: boolean | null;
  latencyMs: number;
  /** The judge's grade; null when the turn was not judged. */
  grade: Grade | null;
  wrongPaper: boolean;
}

export interface CriterionResult {
  n: number;
  name: string;
  /** null when it cannot be evaluated (no cost reading, no questions). */
  pass: boolean | null;
  detail: string;
}

export interface CriteriaResult {
  questions: number;
  criteria: CriterionResult[];
  /** True only when every criterion passed. */
  pass: boolean;
}

/** Nearest-rank percentile (p in 0..100) of a non-empty list. */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) throw new Error('percentile of an empty list');
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

export function evaluateCriteria(a: GradedTurn[], b: GradedTurn[],
                                 cost: { a: number | null; b: number | null }): CriteriaResult {
  const byId = new Map(b.map(t => [t.id, t]));
  const pairs = a.filter(t => byId.has(t.id)).map(t => [t, byId.get(t.id)!] as const);
  const n = pairs.length;
  const criteria: CriterionResult[] = [];
  if (n === 0) {
    return { questions: 0, pass: false, criteria: [1, 2, 3, 4, 5].map(i => ({
      n: i, name: `criterion ${i}`, pass: null, detail: 'no paired questions' })) };
  }
  const A = pairs.map(p => p[0]);
  const B = pairs.map(p => p[1]);
  const count = (ts: GradedTurn[], g: Grade) => ts.filter(t => t.grade === g).length;

  // 1. Correct rate, and the "at most 2 more incorrect out of 40" reading of it.
  const rateA = count(A, 'correct') / n;
  const rateB = count(B, 'correct') / n;
  const extraIncorrect = count(B, 'incorrect') - count(A, 'incorrect');
  const allowedExtra = Math.floor(0.05 * n);
  criteria.push({
    n: 1, name: 'correct rate at least A\'s minus 5 points',
    pass: rateB >= rateA - 0.05 - 1e-9,
    detail: `A ${count(A, 'correct')}/${n} (${pct(rateA)}), B ${count(B, 'correct')}/${n} (${pct(rateB)}), ` +
            `difference ${((rateB - rateA) * 100).toFixed(1)} points; incorrect A ${count(A, 'incorrect')}, ` +
            `B ${count(B, 'incorrect')} (B has ${extraIncorrect} more; ${allowedExtra} allowed at this n)`,
  });

  // 2. Wrong-paper attributions in B.
  const wrong = B.filter(t => t.wrongPaper).length;
  criteria.push({
    n: 2, name: 'zero wrong-paper attributions',
    pass: wrong === 0,
    detail: `B ${wrong} (A ${A.filter(t => t.wrongPaper).length})`,
  });

  // 3. beyondScope agreement, over questions both arms answered.
  const both = pairs.filter(([x, y]) => x.beyondScope !== null && y.beyondScope !== null);
  const agree = both.filter(([x, y]) => x.beyondScope === y.beyondScope).length;
  criteria.push({
    n: 3, name: 'beyondScope agreement with A at least 85%',
    pass: both.length ? agree / both.length >= 0.85 - 1e-9 : null,
    detail: both.length
      ? `${agree}/${both.length} (${pct(agree / both.length)}); flagged A ${both.filter(p => p[0].beyondScope).length}, ` +
        `B ${both.filter(p => p[1].beyondScope).length}`
      : 'no question answered by both arms',
  });

  // 4. Mean estimated cost per turn.
  criteria.push({
    n: 4, name: 'mean estimated cost per turn at most 60% of A\'s',
    pass: cost.a !== null && cost.b !== null && cost.a > 0 ? cost.b <= 0.6 * cost.a + 1e-12 : null,
    detail: cost.a !== null && cost.b !== null
      ? `A $${cost.a.toFixed(6)}, B $${cost.b.toFixed(6)} per turn` +
        (cost.a > 0 ? ` (B is ${pct(cost.b / cost.a)} of A)` : '')
      : 'no cost reading',
  });

  // 5. p95 latency.
  const p95A = percentile(A.map(t => t.latencyMs), 95);
  const p95B = percentile(B.map(t => t.latencyMs), 95);
  criteria.push({
    n: 5, name: 'p95 latency at most A\'s plus 2 s',
    pass: p95B <= p95A + 2000,
    detail: `p95 A ${(p95A / 1000).toFixed(2)} s, B ${(p95B / 1000).toFixed(2)} s ` +
            `(median A ${(percentile(A.map(t => t.latencyMs), 50) / 1000).toFixed(2)} s, ` +
            `B ${(percentile(B.map(t => t.latencyMs), 50) / 1000).toFixed(2)} s)`,
  });

  return { questions: n, criteria, pass: criteria.every(c => c.pass === true) };
}
