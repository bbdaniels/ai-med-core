// Run: npm -w @ai-med/api test   (node:test under tsx)
//
// A deck project ("talk to the results"), end to end against the real
// server.ts: the access gate, prompt assembly for a deck vignette, and the
// beyond-scope path. Nothing here leaves the machine, and nothing here reads a
// real project. The server runs on the shared harness (test-support/), on a
// fixture checkout this test writes under its own temp root: a gated deck
// project shaped like the real one, and an open project to compare against.
// The real deck project's own configuration and prompt are checked by a test
// that lives with that project, outside the published tree.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDeckVignettes, deckNotesFile, parsePack, writeDeck, MAX_CHARS } from '../../../tools/sync-deck-packs.js';
import { resolveProjectFlags } from '@ai-med/chat-core';
import { startServer, type Harness } from '../test-support/server-harness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '../test-fixtures/decks-packs');

const PROJECT = 'fixture_deck';       // gated, one vignette per slide
const OPEN = 'fixture_open';          // sets neither option: the old behavior
const DECK = 'fixture-deck';
const KEY_MAIN = `${DECK}--main-effect`;
const KEY_WHO = `${DECK}--who-attends`;
const CODE = 'fixture-code';          // a test value; a real code is never in source
const P = { 'X-Project': PROJECT, 'Content-Type': 'application/json' };

// The fixture deck project: the shape and the flags of a deck project, with an
// invented prompt that names its blocks the way a real one does.
const SYSTEM_PROMPT = [
  'FIXTURE deck prompt. You answer questions about one slide of a research deck.',
  'The DECK NOTES hold what is true for the whole deck, and the vignette is one SLIDE PACK.',
  'Quote each number with its table and cell. Never do arithmetic.',
  'If the reader asks for an analysis the deck does not hold, restate it as a specification',
  '(Outcome:, Sample:, Comparison:, Unit and weights:, Inference:), set beyondScope, and say',
  'It has been logged for the authors.',
].join('\n');
const PROJECT_JSON = {
  name: PROJECT,
  displayName: 'Fixture deck',
  frontend: 'chat',
  cases: { systemPrompt: `projects/${PROJECT}/system-prompt.md`, vignettes: [] },
  // The deck is a grounding set, as a sync lists it: its notes are
  // grounding/<deck>.md, which reach a deployment in the private store.
  groundingSets: [DECK],
  languages: ['en'],
  chatModel: 'gpt-4o-mini',
  app: 'talk',
  chatOnly: true,
  requireAccessCode: true,
  requireKnownVignette: true,
  logConversations: true,
  deployment: { tablePrefix: PROJECT },
};
const LANGUAGES = {
  languages: [{ code: 'en', name: 'English' }],
  ui: { en: {
    welcome: { title: 'Fixture deck', accessHint: 'Enter the access code the authors gave you.' },
    chat: { unknownVignette: 'This slide has no pack in this deployment.' },
  } },
  vignetteInfo: {},
};

let h: Harness;
let tmp = '';
let root = '';
let empty: Record<string, { status: number; json: any }> = {};

/** Chat completion requests the fake gateway has received. */
const completions = () => h.fake.requests.filter(r => r.path.endsWith('/chat/completions'));

function writeFixtureCheckout(dir: string): void {
  const deck = path.join(dir, 'projects', PROJECT);
  fs.mkdirSync(deck, { recursive: true });
  fs.writeFileSync(path.join(deck, 'project.json'), JSON.stringify(PROJECT_JSON, null, 2));
  fs.writeFileSync(path.join(deck, 'system-prompt.md'), SYSTEM_PROMPT);
  fs.writeFileSync(path.join(deck, 'languages.json'), JSON.stringify(LANGUAGES, null, 2));
  const open = path.join(dir, 'projects', OPEN);
  fs.mkdirSync(open, { recursive: true });
  fs.writeFileSync(path.join(open, 'project.json'), JSON.stringify({
    name: OPEN, displayName: 'Fixture open', frontend: 'chat',
    cases: { systemPrompt: '', vignettes: [] }, languages: ['en'],
    deployment: { tablePrefix: OPEN },
  }, null, 2));
}

async function accessToken(): Promise<string> {
  return h.access(PROJECT, CODE);
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decks-test-'));
  root = path.join(tmp, 'checkout');
  writeFixtureCheckout(root);
  h = await startServer({ root, accessCodes: { [PROJECT]: CODE }, env: { PRIVATE_CONTENT_ROOT: path.join(tmp, 'store') } });

  // The project lands before any deck is synced. Record what it serves with no
  // vignettes at all, before the fixtures go in (asserted in a test below).
  {
    const headers = { ...P, 'X-Access-Token': await accessToken() };
    const get = async (route: string) => {
      const r = await fetch(`${h.base}${route}`, { headers });
      return { status: r.status, json: await r.json() as any };
    };
    empty = {
      vignettes: await get('/api/vignettes'),
      named: await get(`/api/vignettes?vignette=${KEY_MAIN}`),
      config: await get('/api/config'),
      languages: await get('/api/languages'),
    };
  }

  // Content goes in the way push-content.ts puts it: the admin API, the slides
  // to the database and the deck notes (gitignored, like the slides) to the
  // private store.
  const admin = h.admin(PROJECT);
  const build = buildDeckVignettes(FIXTURES, DECK);
  await admin.saveSystemPrompt(SYSTEM_PROMPT);
  for (const v of build.vignettes) await admin.saveVignette(v.key, v.content);
  await admin.putPrivateContent(`projects/${PROJECT}/${deckNotesFile(DECK)}`, Buffer.from(build.notes));
});

after(async () => {
  await h?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the loader turns a packs folder into <deck>--<slide-id> vignettes', () => {
  const build = buildDeckVignettes(FIXTURES, DECK);
  assert.deepEqual(build.vignettes.map(v => v.key), [KEY_WHO, KEY_MAIN]);   // slide order
  const main = build.vignettes[1];
  assert.equal(main.title, 'Slide 2: FIXTURE main effect');
  assert.ok(main.content.startsWith('SLIDE PACK\nSlide id: main-effect'));
  assert.doesNotMatch(main.content, /200 invented clinics/);                // the deck notes are not in a vignette
  assert.ok(build.notes.startsWith('DECK NOTES (true for every slide of this deck)\nDeck: '));
  assert.match(build.notes, /200 invented clinics/);                        // they are the deck's grounding set, sent once
  assert.match(main.content, /the coefficient is 0\.111/);                  // its own slide
  assert.doesNotMatch(main.content, /0\.777/);                              // not the other slide
  for (const v of build.vignettes) assert.match(v.key, /^[A-Za-z0-9_-]{1,100}$/);
});

test('the loader refuses what a small model cannot read, and never writes a fixture deck', () => {
  assert.throws(() => parsePack('---\ntitle: T\n---\n| a | b |\n|---|---|\n| 1 | 2 |\n', 'x.md'), /markdown table/);
  assert.throws(() => parsePack('no front matter', 'x.md'), /front matter/);
  assert.throws(() => parsePack('---\nslide: 1\n---\nbody', 'x.md'), /title/);
  const dir = fs.mkdtempSync(path.join(tmp, 'decks-packs-'));
  fs.writeFileSync(path.join(dir, '_deck.md'), '---\ntitle: D\n---\nDeck.\n');
  fs.writeFileSync(path.join(dir, 'big.md'), `---\ntitle: Big\n---\n${'x'.repeat(MAX_CHARS)}\n`);
  assert.throws(() => buildDeckVignettes(dir, DECK), /over the/);
  fs.renameSync(path.join(dir, 'big.md'), path.join(dir, 'Bad_Id.md'));
  assert.throws(() => buildDeckVignettes(dir, DECK), /slide id/);
  // Refused even when pointed at the fixture checkout, and nothing is written there.
  assert.throws(() => writeDeck(buildDeckVignettes(FIXTURES, DECK), PROJECT, root), /fixture/);
  assert.equal(fs.existsSync(path.join(root, 'projects', PROJECT, 'cases')), false);
});

test('a sync writes each deck\'s notes as its grounding set, and a second deck keeps its own', () => {
  const packs = fs.mkdtempSync(path.join(tmp, 'two-deck-packs-'));
  fs.writeFileSync(path.join(packs, '_deck.md'), '---\ntitle: Invented deck\n---\nNotes for every slide.\n');
  fs.writeFileSync(path.join(packs, 'first.md'), '---\ntitle: First\n---\nTable Z, row A, column 1: 0.5.\n');
  const checkout = fs.mkdtempSync(path.join(tmp, 'two-deck-checkout-'));
  const dir = path.join(checkout, 'projects', PROJECT);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ ...PROJECT_JSON, groundingSets: undefined }, null, 2));
  fs.writeFileSync(path.join(dir, 'languages.json'), JSON.stringify(LANGUAGES, null, 2));
  const config = () => JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));

  writeDeck(buildDeckVignettes(packs, 'deck-a'), PROJECT, checkout);
  assert.equal(deckNotesFile('deck-a'), 'grounding/deck-a.md');              // the set's file, by the engine's convention
  assert.deepEqual(config().groundingSets, ['deck-a']);
  assert.equal(config().groundingFile, undefined);
  assert.match(fs.readFileSync(path.join(dir, 'grounding', 'deck-a.md'), 'utf8'), /^DECK NOTES[\s\S]*Notes for every slide\./);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'cases', 'slide', 'deck-a--first.md'), 'utf8'), /Notes for every slide/);

  // A second deck is its own set; the first deck's entries and notes stay.
  writeDeck(buildDeckVignettes(packs, 'deck-b'), PROJECT, checkout);
  writeDeck(buildDeckVignettes(packs, 'deck-a'), PROJECT, checkout);          // and a re-sync adds nothing twice
  assert.deepEqual(config().groundingSets, ['deck-a', 'deck-b']);
  assert.deepEqual(config().cases.vignettes.map((v: any) => v.key).sort(), ['deck-a--first', 'deck-b--first']);
  assert.ok(fs.existsSync(path.join(dir, 'grounding', 'deck-b.md')));
});

test('the deck project shape is gated, logged, and on the small model', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'projects', PROJECT, 'project.json'), 'utf8'));
  const flags = resolveProjectFlags(cfg);
  assert.equal(flags.requireAccessCode, true);
  assert.equal(cfg.logConversations, true);
  assert.equal(flags.enableFollowups, true);         // the JSON channel that carries beyondScope
  assert.equal(cfg.chatModel, 'gpt-4o-mini');
  assert.equal(flags.talkManifest, false);           // no public, unauthenticated slide list
  assert.equal(flags.requireKnownVignette, true);    // an unknown slide is refused, never swapped
});

test('with no vignettes yet, every slide link is refused and nothing else breaks', () => {
  assert.equal(empty.vignettes.status, 200);
  assert.deepEqual(empty.vignettes.json.vignetteKeys, []);
  assert.equal(empty.named.status, 404);
  assert.equal(empty.named.json.code, 'unknown_vignette');
  assert.equal(empty.config.status, 200);
  assert.equal(empty.config.json.requireKnownVignette, true);
  assert.equal(empty.languages.status, 200);           // seeded from the project's languages.json
});

test('the vignette endpoint refuses without the access code', async () => {
  const bare = await fetch(`${h.base}/api/vignettes`, { headers: P });
  assert.equal(bare.status, 401);
  assert.equal((await bare.json() as any).needsAccessCode, true);

  const forged = await fetch(`${h.base}/api/vignettes`, { headers: { ...P, 'X-Access-Token': 'not-a-token' } });
  assert.equal(forged.status, 401);

  const wrong = await fetch(`${h.base}/api/access`, { method: 'POST', headers: P, body: JSON.stringify({ code: 'nope' }) });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json() as any).token, undefined);

  // /api/config is open, and is how the page learns it must show the gate.
  const config = await (await fetch(`${h.base}/api/config`, { headers: P })).json() as any;
  assert.equal(config.requireAccessCode, true);
  assert.equal(config.requireKnownVignette, true);

  const ok = await fetch(`${h.base}/api/vignettes`, { headers: { ...P, 'X-Access-Token': await accessToken() } });
  assert.equal(ok.status, 200);
  assert.deepEqual(((await ok.json()) as any).vignetteKeys.sort(), [KEY_MAIN, KEY_WHO].sort());
});

test('slide titles are not served without the access code', async () => {
  const titles = { [KEY_MAIN]: { title: 'Slide 2: FIXTURE main effect', scenarioDescription: 'FIXTURE deck' } };
  await h.admin(PROJECT).saveLanguages({ ...LANGUAGES, vignetteInfo: titles });

  for (const headers of [P, { ...P, 'X-Access-Token': 'not-a-token' }]) {
    const res = await fetch(`${h.base}/api/languages`, { headers });
    assert.equal(res.status, 200);                    // the gate itself is drawn from these strings
    const body = await res.text();
    assert.doesNotMatch(body, /FIXTURE main effect/);
    const json = JSON.parse(body);
    assert.equal(json.vignetteInfo, undefined);
    assert.ok(json.ui.en.welcome.accessHint);
  }
  // No other open route carries a title either.
  for (const route of ['/api/config', '/api/tabs', `/api/talk-manifest/${PROJECT}`]) {
    const body = await (await fetch(`${h.base}${route}`, { headers: P })).text();
    assert.doesNotMatch(body, /FIXTURE/, route);
  }

  const withCode = await fetch(`${h.base}/api/languages`, { headers: { ...P, 'X-Access-Token': await accessToken() } });
  assert.deepEqual(((await withCode.json()) as any).vignetteInfo, titles);

  // An ungated project is served its languages file whole, as before.
  await h.admin(OPEN).saveLanguages({ languages: [], ui: {}, vignetteInfo: { scene_1: { title: 'Open title' } } });
  const open = await (await fetch(`${h.base}/api/languages`, { headers: { 'X-Project': OPEN } })).json() as any;
  assert.equal(open.vignetteInfo.scene_1.title, 'Open title');
});

test('an unknown slide is refused, never swapped for the first one', async () => {
  const headers = { ...P, 'X-Access-Token': await accessToken() };
  const known = await fetch(`${h.base}/api/vignettes?vignette=${KEY_MAIN}`, { headers });
  assert.equal(known.status, 200);

  const unknown = await fetch(`${h.base}/api/vignettes?vignette=${DECK}--no-such-slide`, { headers });
  assert.equal(unknown.status, 404);
  const body = await unknown.json() as any;
  assert.equal(body.code, 'unknown_vignette');
  assert.equal(body.vignetteKeys, undefined);          // no list to fall back on

  // ?doc= is the same check under its new name; ?vignette= wins over it.
  assert.equal((await fetch(`${h.base}/api/vignettes?doc=${KEY_MAIN}`, { headers })).status, 200);
  assert.equal((await fetch(`${h.base}/api/vignettes?doc=${DECK}--no-such-slide`, { headers })).status, 404);
  assert.equal((await fetch(`${h.base}/api/vignettes?vignette=${KEY_MAIN}&doc=${DECK}--no-such-slide`, { headers })).status, 200);

  // The gate comes first: without the code the answer is 401, not 404.
  assert.equal((await fetch(`${h.base}/api/vignettes?vignette=${DECK}--no-such-slide`, { headers: P })).status, 401);

  // Chat refuses the key too, and makes no model call for it.
  const before = completions().length;
  const res = await h.chat(PROJECT, { vignetteKey: `${DECK}--no-such-slide`, messages: [{ role: 'user', content: 'x' }] }, headers['X-Access-Token']);
  assert.equal(res.status, 400);
  assert.equal(completions().length, before);

  // The page has words for it.
  const langs = await (await fetch(`${h.base}/api/languages`, { headers })).json() as any;
  assert.ok(langs.ui.en.chat.unknownVignette);

  // A project that does not set the option keeps its behavior: the full list.
  const open = await fetch(`${h.base}/api/vignettes?vignette=nope`, { headers: { 'X-Project': OPEN } });
  assert.equal(open.status, 200);
});

test('chat needs the access code, and no model call is made without it', async () => {
  const before = completions().length;
  const res = await h.chat(PROJECT, { vignetteKey: KEY_MAIN, messages: [{ role: 'user', content: 'What is the coefficient?' }] });
  assert.equal(res.status, 401);
  assert.equal(res.json.needsAccessCode, true);
  assert.equal(completions().length, before);
});

test('prompt assembly: system prompt, then the deck notes, then this slide only', async () => {
  const token = await accessToken();
  h.fake.enqueue({ content: {
    answer: 'The coefficient is 0.111 (Table F1, row Training, column 1). The design is randomized.',
    followups: ['What is the control mean?', 'How many clinics are in the sample?'],
    beyondScope: false,
  } });
  const before = completions().length;
  const res = await h.chat(PROJECT, {
    vignetteKey: KEY_MAIN,
    sessionToken: 'fixture-session-0001',
    messages: [{ role: 'user', content: 'What is the coefficient on training?' }],
  }, token);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(completions().length, before + 1);

  const req = completions().at(-1)!.body;
  assert.equal(req.model, 'gpt-4o-mini');
  assert.equal(req.max_tokens, 1000);
  assert.equal(req.response_format?.type, 'json_schema');
  assert.equal(req.tools, undefined);                 // no retrieval: the pack is the whole source
  assert.equal(req.messages[0].role, 'system');
  assert.equal(req.messages.at(-1).content, 'What is the coefficient on training?');

  const system: string = req.messages[0].content;
  const at = (s: string) => system.indexOf(s);
  assert.equal(at(SYSTEM_PROMPT.trim().slice(0, 200)), 0);
  // The prompt itself names the blocks, so match each block's own heading line.
  for (const marker of ['DECK NOTES (true for every slide of this deck)\nDeck: ', 'SLIDE PACK\nSlide id: ']) {
    assert.ok(at(marker) > SYSTEM_PROMPT.trim().length - 1, `${marker} follows the system prompt`);
    assert.ok(at(marker) < at('You will respond as a JSON object'));
    assert.equal(system.split(marker).length, 2, `${marker} is sent once`);
  }
  assert.match(system, /Slide id: main-effect/);
  assert.match(system, /200 invented clinics/);
  assert.match(system, /the coefficient is 0\.111/);
  assert.doesNotMatch(system, /0\.777/);              // the other slide's pack is not sent
  // Fits the model with room to spare: under a tenth of gpt-4o-mini's 128,000 tokens.
  assert.ok(system.length / 4 < 12_800, `system message is about ${Math.round(system.length / 4)} tokens`);

  assert.equal(res.json.beyondScope, false);
  assert.match(res.json.message, /0\.111/);
  assert.equal(res.json.followups.length, 2);
});

test('beyond scope: the flag reaches the reader and the request reaches the log', async () => {
  const token = await accessToken();
  const question = 'Can you rerun Table F1 dropping the small clinics?';
  h.fake.enqueue({ content: {
    answer: 'That analysis is not in the deck. The request as I understand it. Outcome: correct management. ' +
            'Sample: clinics, small clinics dropped. Comparison: training against no training. ' +
            'Unit and weights: clinic, weights not specified. Inference: not specified. It has been logged for the authors.',
    followups: ['What is the control mean?', 'How many clinics are in the sample?'],
    beyondScope: true,
  } });
  const res = await h.chat(PROJECT, {
    vignetteKey: KEY_MAIN,
    sessionToken: 'fixture-session-0001',
    messages: [{ role: 'user', content: question }],
  }, token);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.beyondScope, true);
  assert.match(res.json.message, /logged for the authors/);

  // "Logged for the authors" has to be true: the turn is in qa_log, with its slide.
  const admin = h.admin(PROJECT);
  let rows: any[] = [];
  for (let i = 0; i < 20 && !rows.some(r => r.question === question); i++) {
    await new Promise(r => setTimeout(r, 100));      // the log write is non-blocking
    rows = (await admin.getQaLog({ days: 1 })).rows;
  }
  const row = rows.find(r => r.question === question);
  assert.ok(row, 'the request is in qa_log');
  assert.equal(row.vignette_key, KEY_MAIN);
  assert.match(row.answer, /Outcome: .*Sample: .*Comparison: .*Unit and weights: .*Inference: /);

  // The log is admin-only.
  const open = await fetch(`${h.base}/api/admin/qa-log`, { headers: P });
  assert.equal(open.status, 401);
});
