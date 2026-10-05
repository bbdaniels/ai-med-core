// Run: npm -w @ai-med/api test   (node:test under tsx)
//      UPDATE_SNAPSHOTS=1 npx tsx --test src/grounding-sets.test.ts   (rewrite the snapshot; a deliberate change only)
//
// Characterization of POST /api/chat for a project that grounds each document
// set on its own file (project.json groundingSets): the grounding of a turn is
// the file of its CURRENT document's set, projects/<slug>/grounding/<set>.md,
// read from the checkout or, for a private file, from the private store; any
// other document falls back to groundingFile. One grounding per turn: the
// earlier document of a followHost turn shares it when it is of the same set
// and brings none of its own when it is of another. Against the real
// server.ts, on a fixture checkout and a private store this test writes under
// its own temp root, so it reads no real project and runs the same in the
// public mirror.
//
// Also: the private store accepts a declared set's file and refuses any other
// path under grounding/ (the admin upload push-content uses).
//
// The snapshot is test-fixtures/grounding-sets/snapshots.json; every document,
// note and prompt in it is invented here.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, type Harness } from '../test-support/server-harness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = path.join(HERE, '../test-fixtures/grounding-sets/snapshots.json');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';

const SETS = 'fixture_sets';
const SESSION = 'fixture-session-grounding-sets-0001';

// Two document sets and one loose document. set-a's notes are tracked (in the
// checkout); set-b's are private (only in the store, as a deck's would be).
const DOCS: Record<string, { title: string; content: string }> = {
  'set-a--one': { title: 'FIXTURE A one', content: 'FIXTURE DOCUMENT A1. Table A1, row 1: 12 clinics.' },
  'set-a--two': { title: 'FIXTURE A two', content: 'FIXTURE DOCUMENT A2. Table A2, column 1: the coefficient is 0.21.' },
  'set-b--one': { title: 'FIXTURE B one', content: 'FIXTURE DOCUMENT B1. Figure B1: two lines, blue above red.' },
  loose: { title: 'FIXTURE loose', content: 'FIXTURE DOCUMENT LOOSE. A note on its own.' },
};
const NOTES_A = 'FIXTURE NOTES SET A. Every table in set A is weighted by clinic.';
const NOTES_B = 'FIXTURE NOTES SET B. Every figure in set B is unweighted.';
const NOTES_PROJECT = 'FIXTURE PROJECT GROUNDING. The project-wide index.';
const SYSTEM_PROMPT = 'FIXTURE grounding-sets prompt. Answer from the current document and its notes.';
const OPENING = 'FIXTURE opening.';

function writeFixtureCheckout(root: string): void {
  const dir = path.join(root, 'projects', SETS);
  fs.mkdirSync(path.join(dir, 'cases', 'doc'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'grounding'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    name: SETS,
    displayName: 'Fixture grounding sets',
    frontend: 'chat',
    cases: {
      systemPrompt: `projects/${SETS}/system-prompt.md`,
      vignettes: Object.entries(DOCS).map(([key, d]) => ({ key, template: 'doc', title: d.title, file: `projects/${SETS}/cases/doc/${key}.md` })),
    },
    languages: ['en'],
    app: 'talk',
    chatOnly: true,
    requireKnownVignette: true,
    logConversations: true,
    followHost: true,
    embedOrigins: ['https://host.example'],
    groundingFile: `projects/${SETS}/project-grounding.md`,
    groundingSets: ['set-a', 'set-b'],
    deployment: { tablePrefix: SETS },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'system-prompt.md'), SYSTEM_PROMPT);
  fs.writeFileSync(path.join(dir, 'project-grounding.md'), NOTES_PROJECT);
  fs.writeFileSync(path.join(dir, 'grounding', 'set-a.md'), NOTES_A);
  fs.writeFileSync(path.join(dir, 'languages.json'), JSON.stringify({
    languages: [{ code: 'en', name: 'English' }],
    ui: { en: { chat: { openingMessage: OPENING } } },
  }, null, 2));
  for (const [key, d] of Object.entries(DOCS)) fs.writeFileSync(path.join(dir, 'cases', 'doc', `${key}.md`), d.content);
}

let h: Harness;
let tmp = '';
const recorded: Record<string, unknown[]> = {};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-sets-test-'));
  const root = path.join(tmp, 'checkout');
  writeFixtureCheckout(root);
  h = await startServer({ root, env: { PRIVATE_CONTENT_ROOT: path.join(tmp, 'store') } });
});

after(async () => {
  await h?.stop();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  if (UPDATE && Object.keys(recorded).length > 0) {
    fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
    fs.writeFileSync(SNAPSHOT, JSON.stringify(recorded, null, 2) + '\n');
  }
});

type Msg = { role: 'user' | 'assistant'; content: string; documentKey?: string; beyondScope?: boolean };
const ask = (content: string, documentKey: string): Msg => ({ role: 'user', content, documentKey });
const answer = (content: string): Msg => ({ role: 'assistant', content, beyondScope: false });
const opening: Msg = { role: 'assistant', content: OPENING };

/** One turn: what the gateway was sent and what the log kept. */
async function turn(documentKey: string, messages: Msg[], reply = 'FIXTURE answer.') {
  const before = h.fake.requests.length;
  const qaBefore = h.qaLog(SETS).length;
  h.fake.clearQueue();
  h.fake.enqueue({ content: { answer: reply, followups: ['One?', 'Two?'], beyondScope: false } });
  const res = await h.chat(SETS, { documentKey, vignetteKey: documentKey, language: 'English', sessionToken: SESSION, messages });
  if (res.status !== 200) h.fake.clearQueue();
  await new Promise(r => setTimeout(r, 50));       // qa_log is written without blocking the reply
  const sent = h.fake.requests.slice(before).filter(r => r.path.endsWith('/chat/completions')).map(r => r.body.messages);
  return { status: res.status, response: res.json, sent, qaLog: h.qaLog(SETS).slice(qaBefore) };
}

/** Record a case for the snapshot and compare it with the committed one. */
function pin(name: string, turns: unknown[]): void {
  recorded[name] = turns;
  if (UPDATE) return;
  assert.ok(fs.existsSync(SNAPSHOT), `no snapshot; record it with UPDATE_SNAPSHOTS=1 npx tsx --test src/grounding-sets.test.ts`);
  const expected = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  assert.deepStrictEqual(turns, expected[name], `${name} differs from the snapshot`);
}

const system = (t: { sent: any[][] }) => t.sent[0][0].content as string;
const notes = (s: string) => [NOTES_A, NOTES_B, NOTES_PROJECT].filter(n => s.includes(n));

test('the private store takes a declared set\'s file and refuses any other path under grounding/', async () => {
  // Through the client push-content uses: a declared set's file is accepted.
  await h.admin(SETS).putPrivateContent(`projects/${SETS}/grounding/set-b.md`, Buffer.from(NOTES_B));
  const listed = await h.admin(SETS).listPrivateContent();
  assert.deepEqual(listed.files.map(f => f.path), [`projects/${SETS}/grounding/set-b.md`]);
  // A set the project does not list, and a file beside the sets, are refused.
  for (const rel of [`projects/${SETS}/grounding/set-z.md`, `projects/${SETS}/grounding/notes.txt`]) {
    await assert.rejects(h.admin(SETS).putPrivateContent(rel, Buffer.from('X')), /400[^]*neither a tab contentFile nor a grounding set file/);
  }
});

test('a turn is grounded on its current document\'s set; a document outside the sets on the project\'s grounding', async () => {
  const qa = ask('How many clinics?', 'set-a--one');
  const ta = await turn('set-a--one', [opening, qa], 'A1.');
  assert.equal(ta.status, 200);
  assert.deepEqual(notes(system(ta)), [NOTES_A]);
  // The stable parts first: the prompt, the date, the set's notes, then the document.
  assert.ok(system(ta).indexOf(NOTES_A) < system(ta).indexOf('## Current document: FIXTURE A one (set-a--one)'));

  const tb = await turn('set-b--one', [opening, ask('Which line is higher?', 'set-b--one')], 'B1.');
  assert.equal(tb.status, 200);
  assert.deepEqual(notes(system(tb)), [NOTES_B], 'the private set file is read from the store');

  const tl = await turn('loose', [opening, ask('What is this?', 'loose')], 'L1.');
  assert.equal(tl.status, 200);
  assert.deepEqual(notes(system(tl)), [NOTES_PROJECT]);
  pin('by-set', [ta, tb, tl]);
});

test('one grounding per turn: the earlier document shares its set\'s, or brings none of its own', async () => {
  const q1 = ask('How many clinics?', 'set-a--one');
  // Same set: set-a's notes once, with the earlier document's section.
  const q2 = ask('And the coefficient?', 'set-a--two');
  const same = await turn('set-a--two', [opening, q1, answer('A1.'), q2], 'A2.');
  assert.equal(same.status, 200);
  assert.deepEqual(notes(system(same)), [NOTES_A]);
  assert.equal(system(same).split(NOTES_A).length, 2, 'the notes appear once');
  assert.match(system(same), /## Earlier document: FIXTURE A one \(set-a--one\)\n\nFIXTURE DOCUMENT A1\.[^]*$/);

  // Another set: the current document's notes only; set-a's are not sent.
  const q3 = ask('Which line is higher?', 'set-b--one');
  const across = await turn('set-b--one', [opening, q1, answer('A1.'), q2, answer('A2.'), q3], 'B1.');
  assert.equal(across.status, 200);
  assert.deepEqual(notes(system(across)), [NOTES_B]);
  assert.match(system(across), /## Earlier document: FIXTURE A two \(set-a--two\)\n\nFIXTURE DOCUMENT A2\.[^]*$/);
  pin('earlier-document', [same, across]);
});
