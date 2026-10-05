#!/usr/bin/env npx tsx
/**
 * ab-grounding.ts: an A/B of two grounding configurations of one document
 * chat, over a frozen question set, judged blind against gold answers.
 *
 * Arm A is the deployed configuration and arm B the candidate; both are
 * projects on the same deployment (for example a project and a copy of it
 * that grounds differently). The pass criterion is in lib/ab-criteria.ts.
 *
 *   npx tsx tools/ab-grounding.ts gold  --questions Q.jsonl --texts DIR [--out GOLD.jsonl]
 *   npx tsx tools/ab-grounding.ts run   --url API --arms A,B --questions Q.jsonl --gold GOLD.jsonl [--out DIR] [--seed N]
 *   npx tsx tools/ab-grounding.ts judge --dir DIR [--seed N]       # re-judge and re-report saved turns
 *   npx tsx tools/ab-grounding.ts report --dir DIR [--questions SUBSET.jsonl --out DIR2]
 *                                   # re-report saved judgements, optionally on a subset of the questions
 *
 * Inputs:
 *   Q.jsonl     one question per line: {id, documentKey, language, question, source}
 *   DIR (gold)  the full text of each document, as <documentKey>.md
 *   GOLD.jsonl  {id, answer, support, inDocument, documentTitle}, written by `gold`:
 *               gpt-4o answers from the document's full text alone and quotes
 *               the sentence that supports the answer. Check some by hand.
 *
 * `run`:
 *   - one fresh turn per question and arm, each with its own session token
 *     ("ab-grounding-..."), arms in a seeded random order per question, 1.2 s
 *     apart (the chat route allows one request a second per client);
 *   - records the answer, beyondScope, latency (wall clock) and usage;
 *   - cost: the deployment's own estimate, GET /api/admin/token-usage?days=1
 *     per arm before and after the run, divided by the arm's turns (needs
 *     ADMIN_PASSPHRASE; a gated arm needs ACCESS_CODE_<SLUG>);
 *   - then `judge` and the report.
 * `judge`: gpt-4o, blind to the arm, both arms' answers to a question in one
 * call in a seeded random order, each graded correct, partial, incorrect or
 * declined against the gold answer, with a flag for wrong-paper attribution.
 *
 * Gold answers and the judge use the direct OpenAI key (OPENAI_TTS_KEY, or
 * OPENAI_API_KEY with no gateway configured), through the one client module.
 * Output (default exports/ab-<date>/, gitignored): turns.jsonl, judge.jsonl,
 * results.json, report.md. They hold the questions and answers; keep them out
 * of the repository. Stdout carries counts and the criteria only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenAIClients, clientForPaymentSource } from '../packages/chat-core/src/openai-clients.js';
import { AdminApiClient } from './lib/api-client.js';
import { evaluateCriteria, type Grade, type GradedTurn } from './lib/ab-criteria.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JUDGE_MODEL = 'gpt-4o';
const CHAT_SPACING_MS = 1200;

interface Question { id: string; documentKey: string; language: string | null; question: string; source?: string }
interface Gold { id: string; answer: string; support: string; inDocument: boolean; documentTitle: string }
interface Turn {
  id: string; arm: string; status: number; latencyMs: number;
  message: string; followups: string[]; beyondScope: boolean | null;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  error?: string;
}
interface Judgement { id: string; arm: string; grade: Grade; wrongPaper: boolean; reason: string }

// ── small helpers ────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
function need(name: string): string {
  const v = arg(name);
  if (!v) { console.error(`missing ${name}`); process.exit(2); }
  return v;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const readJsonl = <T>(file: string): T[] =>
  fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as T);
const writeJsonl = (file: string, rows: unknown[]) =>
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
const envSlug = (slug: string) => slug.toUpperCase().replace(/[^A-Z0-9]/g, '_');

/** A seeded PRNG (mulberry32), so an order can be reproduced. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled<T>(xs: T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function loadDotEnv(): void {
  const file = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

/** The direct client: gold answers and the judge are never billed to a gateway. */
function directClient() {
  loadDotEnv();
  return clientForPaymentSource('direct', buildOpenAIClients(process.env));
}

async function completeJson(system: string, user: string): Promise<{ json: any; usage: any }> {
  const client = directClient();
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await client.chat.completions.create({
        model: JUDGE_MODEL, temperature: 0, max_tokens: 1200,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      });
      return { json: JSON.parse(r.choices[0]?.message?.content || '{}'), usage: r.usage };
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(3000 * attempt);
    }
  }
}

// ── gold ─────────────────────────────────────────────────────────────────

const GOLD_SYSTEM = [
  'You write reference answers for evaluating a chat assistant that answers questions about one document.',
  'Answer the question from the document below and nothing else: no outside knowledge.',
  'Return JSON: {"answer": string, "support": string, "inDocument": boolean}.',
  '- answer: a short, complete, correct answer in English (one to three sentences), with the exact numbers the document gives.',
  '- support: the sentence or sentences of the document that support the answer, quoted verbatim (at most three sentences).',
  '- inDocument: false when the document does not answer the question; then answer says so in one sentence',
  '  ("The document does not address ...") and support is "".',
  'If the question is not in English, still answer in English.',
].join('\n');

function documentTitle(text: string, key: string): string {
  return text.match(/^Title:\s*(.+)$/m)?.[1]?.trim() || key;
}

async function gold(): Promise<void> {
  const questions = readJsonl<Question>(need('--questions'));
  const texts = need('--texts');
  const out = arg('--out') ?? path.join(path.dirname(need('--questions')), 'gold.jsonl');
  const rows: Gold[] = [];
  let tokens = 0;
  for (const q of questions) {
    const file = path.join(texts, `${q.documentKey}.md`);
    if (!fs.existsSync(file)) throw new Error(`no text for ${q.documentKey} in ${texts}`);
    const text = fs.readFileSync(file, 'utf8');
    const { json, usage } = await completeJson(GOLD_SYSTEM,
      `DOCUMENT\n${text}\n\nQUESTION\n${q.question}`);
    tokens += (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0);
    rows.push({
      id: q.id,
      answer: String(json.answer ?? ''),
      support: String(json.support ?? ''),
      inDocument: json.inDocument !== false,
      documentTitle: documentTitle(text, q.documentKey),
    });
    process.stdout.write('.');
  }
  writeJsonl(out, rows);
  console.log(`\n${rows.length} gold answers (${rows.filter(r => !r.inDocument).length} not in the document), ` +
              `${tokens} tokens -> ${path.relative(process.cwd(), out)}`);
}

// ── run ──────────────────────────────────────────────────────────────────

async function postJson(url: string, headers: Record<string, string>, body: unknown) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body), signal: AbortSignal.timeout(180_000),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json };
}

async function accessToken(base: string, slug: string): Promise<string | undefined> {
  const code = process.env[`ACCESS_CODE_${envSlug(slug)}`];
  if (!code) return undefined;
  const r = await postJson(`${base}/api/access`, { 'X-Project': slug }, { code });
  if (r.status !== 200 || typeof r.json?.token !== 'string') throw new Error(`${slug}: /api/access answered ${r.status}`);
  return r.json.token;
}

async function usageCost(admin: AdminApiClient | null): Promise<number | null> {
  if (!admin) return null;
  try { return Number((await admin.getTokenUsage(1))?.totals?.estimated_cost ?? 0); } catch { return null; }
}

async function chatTurn(base: string, arm: string, token: string | undefined, q: Question, n: number): Promise<Turn> {
  const headers: Record<string, string> = { 'X-Project': arm, ...(token ? { 'X-Access-Token': token } : {}) };
  const body = {
    documentKey: q.documentKey, vignetteKey: q.documentKey,
    language: q.language || 'English',
    sessionToken: `ab-grounding-${n.toString().padStart(4, '0')}-${Math.random().toString(16).slice(2, 10)}`,
    messages: [{ role: 'user', content: q.question }],
  };
  for (let attempt = 1; ; attempt++) {
    const t0 = performance.now();
    let r: { status: number; json: any };
    try {
      r = await postJson(`${base}/api/chat`, headers, body);
    } catch (e) {
      r = { status: 0, json: { error: e instanceof Error ? e.message : String(e) } };
    }
    const latencyMs = Math.round(performance.now() - t0);
    if ((r.status === 429 || r.status >= 500 || r.status === 0) && attempt < 3) {
      await sleep(5000 * attempt);
      continue;
    }
    return {
      id: q.id, arm, status: r.status, latencyMs,
      message: typeof r.json?.message === 'string' ? r.json.message : '',
      followups: Array.isArray(r.json?.followups) ? r.json.followups : [],
      beyondScope: typeof r.json?.beyondScope === 'boolean' ? r.json.beyondScope : null,
      usage: r.json?.usage ?? null,
      ...(r.status === 200 ? {} : { error: JSON.stringify(r.json).slice(0, 300) }),
    };
  }
}

async function run(): Promise<void> {
  const base = need('--url').replace(/\/$/, '');
  const arms = need('--arms').split(',').map(s => s.trim()).filter(Boolean);
  if (arms.length !== 2) { console.error('--arms takes exactly two projects: A (deployed),B (candidate)'); process.exit(2); }
  const questionsFile = need('--questions');
  const goldFile = need('--gold');
  const dir = arg('--out') ?? path.join(REPO_ROOT, 'exports', `ab-${new Date().toISOString().slice(0, 10)}`);
  const seed = Number(arg('--seed') ?? 1);
  fs.mkdirSync(dir, { recursive: true });
  const questions = readJsonl<Question>(questionsFile);
  const golds = new Map(readJsonl<Gold>(goldFile).map(g => [g.id, g]));
  for (const q of questions) if (!golds.has(q.id)) throw new Error(`no gold answer for ${q.id}`);
  fs.copyFileSync(questionsFile, path.join(dir, 'questions.jsonl'));
  fs.copyFileSync(goldFile, path.join(dir, 'gold.jsonl'));

  const passphrase = process.env.ADMIN_PASSPHRASE;
  const admins = Object.fromEntries(arms.map(a => [a,
    passphrase ? new AdminApiClient({ baseUrl: base, passphrase, project: a }) : null]));
  const tokens = Object.fromEntries(await Promise.all(arms.map(async a => [a, await accessToken(base, a)] as const)));
  const before = Object.fromEntries(await Promise.all(arms.map(async a => [a, await usageCost(admins[a])] as const)));

  const rand = rng(seed);
  const turns: Turn[] = [];
  let n = 0;
  for (const q of questions) {
    for (const a of shuffled(arms, rand)) {
      const t = await chatTurn(base, a, tokens[a], q, ++n);
      turns.push(t);
      writeJsonl(path.join(dir, 'turns.jsonl'), turns);
      process.stdout.write(t.status === 200 ? '.' : `[${t.status}]`);
      await sleep(CHAT_SPACING_MS);
    }
  }
  await sleep(1000);                         // usage rows are written after the reply
  const after = Object.fromEntries(await Promise.all(arms.map(async a => [a, await usageCost(admins[a])] as const)));
  const cost = Object.fromEntries(arms.map(a => {
    const k = turns.filter(t => t.arm === a).length;
    return [a, before[a] !== null && after[a] !== null && k ? (after[a]! - before[a]!) / k : null];
  }));
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({
    url: base, arms, seed, questions: questions.length, costPerTurn: cost,
    startedFrom: { before, after }, finishedAt: new Date().toISOString(),
  }, null, 2) + '\n');
  console.log(`\n${turns.length} turns, ${turns.filter(t => t.status !== 200).length} failed`);
  await judge(dir, seed);
}

// ── judge and report ─────────────────────────────────────────────────────

const JUDGE_SYSTEM = [
  'You grade answers from a chat assistant that discusses one selected research paper with readers.',
  'You see the question, the selected paper, a reference answer written from the paper\'s full text with its',
  'supporting sentence, and two candidate answers labelled 1 and 2. Grade each candidate on its own against',
  'the reference; the labels say nothing about where an answer came from.',
  '',
  'Grades:',
  '- correct: answers what was asked, consistent with the reference on every point that matters, numbers included.',
  '- partial: right in part, but incomplete on what was asked, or with a minor error or a vague number.',
  '- incorrect: contradicts the reference, gives a wrong number, or states as the paper\'s something the paper does not say.',
  '- declined: does not answer (says it cannot find it, does not know, or will not discuss it).',
  'When the reference says the paper does not address the question: an answer that says so, or that answers',
  'and makes clear the answer comes from outside the paper, is correct; one that presents outside material as',
  'the paper\'s own finding is incorrect. A refusal of an off-topic question in that case is correct, not declined.',
  'Answers may be in another language than the reference; judge the meaning.',
  '',
  'wrongPaper: true when the answer attributes to the selected paper a finding, number, sample or method that',
  'belongs to a different paper, or describes a different paper as if it were the selected one. Mentioning',
  'another paper correctly labelled as another paper is not wrongPaper.',
  '',
  'Return JSON: {"1": {"grade": ..., "wrongPaper": bool, "reason": "one sentence"}, "2": {...}}.',
].join('\n');

async function judge(dir: string, seed: number): Promise<void> {
  const questions = readJsonl<Question>(path.join(dir, 'questions.jsonl'));
  const golds = new Map(readJsonl<Gold>(path.join(dir, 'gold.jsonl')).map(g => [g.id, g]));
  const turns = readJsonl<Turn>(path.join(dir, 'turns.jsonl'));
  const runInfo = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
  const arms: string[] = runInfo.arms;
  const rand = rng(seed * 7919 + 17);
  const judgements: Judgement[] = [];
  for (const q of questions) {
    const g = golds.get(q.id)!;
    const pair = shuffled(arms.map(a => turns.find(t => t.id === q.id && t.arm === a)!).filter(Boolean), rand);
    if (pair.length !== 2) continue;
    const shown = (t: Turn) => (t.status === 200 && t.message.trim() ? t.message : `(no answer: HTTP ${t.status})`);
    const user = [
      `SELECTED PAPER: ${g.documentTitle} (key ${q.documentKey})`,
      `QUESTION (${q.language || 'English'}): ${q.question}`,
      `REFERENCE ANSWER: ${g.answer}`,
      `SUPPORTING SENTENCE FROM THE PAPER: ${g.support || '(none: the paper does not address this)'}`,
      `CANDIDATE 1: ${shown(pair[0])}`,
      `CANDIDATE 2: ${shown(pair[1])}`,
    ].join('\n\n');
    const { json } = await completeJson(JUDGE_SYSTEM, user);
    pair.forEach((t, i) => {
      const v = json[String(i + 1)] ?? {};
      const grade: Grade = ['correct', 'partial', 'incorrect', 'declined'].includes(v.grade) ? v.grade : 'incorrect';
      judgements.push({ id: q.id, arm: t.arm, grade: t.status === 200 ? grade : 'incorrect',
                        wrongPaper: v.wrongPaper === true, reason: String(v.reason ?? '') });
    });
    process.stdout.write('j');
  }
  writeJsonl(path.join(dir, 'judge.jsonl'), judgements);
  report(dir, questions, golds, turns, judgements, arms, runInfo.costPerTurn);
}

/** Re-report saved judgements, on all questions or on a subset (written to --out). */
function reportOnly(): void {
  const dir = need('--dir');
  const subset = arg('--questions');
  const out = subset ? need('--out') : dir;
  const all = readJsonl<Question>(path.join(dir, 'questions.jsonl'));
  const ids = subset ? new Set(readJsonl<Question>(subset).map(q => q.id)) : null;
  const questions = ids ? all.filter(q => ids.has(q.id)) : all;
  if (ids && questions.length !== ids.size) throw new Error('the subset names questions the run did not ask');
  const keep = <T extends { id: string }>(xs: T[]) => (ids ? xs.filter(x => ids.has(x.id)) : xs);
  const golds = new Map(keep(readJsonl<Gold>(path.join(dir, 'gold.jsonl'))).map(g => [g.id, g]));
  const turns = keep(readJsonl<Turn>(path.join(dir, 'turns.jsonl')));
  const judgements = keep(readJsonl<Judgement>(path.join(dir, 'judge.jsonl')));
  const runInfo = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
  fs.mkdirSync(out, { recursive: true });
  if (out !== dir) {
    writeJsonl(path.join(out, 'questions.jsonl'), questions);
    writeJsonl(path.join(out, 'gold.jsonl'), [...golds.values()]);
    writeJsonl(path.join(out, 'turns.jsonl'), turns);
    writeJsonl(path.join(out, 'judge.jsonl'), judgements);
    // The cost per turn is the whole run's: token_usage has no per-question rows.
    fs.writeFileSync(path.join(out, 'run.json'), JSON.stringify({ ...runInfo, subsetOf: dir }, null, 2) + '\n');
  }
  report(out, questions, golds, turns, judgements, runInfo.arms, runInfo.costPerTurn);
}

function graded(arm: string, turns: Turn[], judgements: Judgement[]): GradedTurn[] {
  return turns.filter(t => t.arm === arm).map(t => {
    const j = judgements.find(x => x.id === t.id && x.arm === arm);
    return { id: t.id, status: t.status, beyondScope: t.beyondScope, latencyMs: t.latencyMs,
             grade: j?.grade ?? null, wrongPaper: j?.wrongPaper ?? false };
  });
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();

function report(dir: string, questions: Question[], golds: Map<string, Gold>, turns: Turn[],
                judgements: Judgement[], arms: string[], costPerTurn: Record<string, number | null>): void {
  const [A, B] = arms;
  const result = evaluateCriteria(graded(A, turns, judgements), graded(B, turns, judgements),
                                  { a: costPerTurn[A] ?? null, b: costPerTurn[B] ?? null });
  const rows = questions.map(q => {
    const t = (a: string) => turns.find(x => x.id === q.id && x.arm === a);
    const j = (a: string) => judgements.find(x => x.id === q.id && x.arm === a);
    const ta = t(A), tb = t(B), ja = j(A), jb = j(B);
    const disagree = !!ta && !!tb && (ja?.grade !== jb?.grade || ta.beyondScope !== tb.beyondScope
                                      || !!ja?.wrongPaper || !!jb?.wrongPaper);
    return { q, gold: golds.get(q.id), a: ta, b: tb, ja, jb, disagree };
  });
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ arms, costPerTurn, criteria: result, rows }, null, 2) + '\n');

  const md: string[] = [];
  md.push(`# Grounding A/B: ${A} (A) vs ${B} (B)`, '', `${result.questions} questions.`, '');
  md.push('| # | Criterion | Pass | Detail |', '|---|---|---|---|');
  for (const c of result.criteria) md.push(`| ${c.n} | ${c.name} | ${c.pass === null ? 'n/a' : c.pass ? 'yes' : 'no'} | ${c.detail} |`);
  md.push('', `All five: ${result.pass ? 'pass' : 'not passed'}.`, '');
  md.push(`## Questions where the arms disagree (${rows.filter(r => r.disagree).length})`, '');
  md.push('| id | document | question | A answer | B answer | gold | A judged | B judged |', '|---|---|---|---|---|---|---|---|');
  const judged = (j?: Judgement, t?: Turn) => j
    ? `${j.grade}${j.wrongPaper ? ', WRONG PAPER' : ''}; beyondScope ${t?.beyondScope}; ${cell(j.reason)}` : 'n/a';
  for (const r of rows.filter(x => x.disagree)) {
    md.push(`| ${r.q.id} | ${r.q.documentKey} | ${cell(r.q.question)} | ${cell(r.a?.message ?? '')} | ${cell(r.b?.message ?? '')} | ` +
            `${cell(r.gold?.answer ?? '')} | ${judged(r.ja, r.a)} | ${judged(r.jb, r.b)} |`);
  }
  md.push('', '## Every question', '', '| id | document | A | B | A s | B s |', '|---|---|---|---|---|---|');
  for (const r of rows) {
    md.push(`| ${r.q.id} | ${r.q.documentKey} | ${r.ja?.grade ?? 'n/a'}${r.ja?.wrongPaper ? ' (wrong paper)' : ''} | ` +
            `${r.jb?.grade ?? 'n/a'}${r.jb?.wrongPaper ? ' (wrong paper)' : ''} | ` +
            `${((r.a?.latencyMs ?? 0) / 1000).toFixed(1)} | ${((r.b?.latencyMs ?? 0) / 1000).toFixed(1)} |`);
  }
  fs.writeFileSync(path.join(dir, 'report.md'), md.join('\n') + '\n');

  console.log(`\n${result.questions} questions, ${rows.filter(r => r.disagree).length} disagreements`);
  for (const c of result.criteria) console.log(`  ${c.pass === null ? 'n/a ' : c.pass ? 'PASS' : 'FAIL'} ${c.n}. ${c.name}: ${c.detail}`);
  console.log(`  all five: ${result.pass ? 'PASS' : 'not passed'}`);
  console.log(`report: ${path.relative(process.cwd(), path.join(dir, 'report.md'))}`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'gold') return gold();
  if (cmd === 'run') return run();
  if (cmd === 'judge') return judge(need('--dir'), Number(arg('--seed') ?? 1));
  if (cmd === 'report') return reportOnly();
  console.error('Usage: npx tsx tools/ab-grounding.ts gold|run|judge|report ... (see the header)');
  process.exit(2);
}

main().catch(err => {
  console.error('Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
