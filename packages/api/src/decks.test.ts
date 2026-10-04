// Run: npm -w @ai-med/api test   (node:test under tsx)
//
// The decks project ("Talk to the results"), end to end against the real
// server.ts: the access gate, prompt assembly for a deck vignette, and the
// beyond-scope path. Nothing here leaves the machine. The server is started as
// a child process on a throwaway SQLite file, and its one OpenAI client is
// pointed (HARVARD_GATEWAY_URL, the only name openai-clients.ts reads) at a
// fake completion server in this process, which records what it was sent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { buildDeckVignettes, parsePack, writeDeck, MAX_CHARS } from '../../../tools/sync-deck-packs.js';
import { AdminApiClient } from '../../../tools/lib/api-client.js';
import { resolveProjectFlags } from './project-config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const FIXTURES = path.join(HERE, '../test-fixtures/decks-packs');
const SYSTEM_PROMPT = fs.readFileSync(path.join(REPO_ROOT, 'projects/decks/system-prompt.md'), 'utf8');

const DECK = 'fixture-deck';
const KEY_MAIN = `${DECK}--main-effect`;
const KEY_WHO = `${DECK}--who-attends`;
const CODE = 'fixture-code';          // a test value; the real code is never in source
const ADMIN = 'fixture-admin-passphrase';
const P = { 'X-Project': 'decks', 'Content-Type': 'application/json' };

let fake: http.Server;
let server: ChildProcess;
let base = '';
let tmp = '';
let serverLog = '';
const sent: any[] = [];               // every completion request the server made
let nextReply: Record<string, unknown> = {};
let transcriptsBefore = new Set<string>();
let empty: Record<string, { status: number; json: any }> = {};
const transcriptsDir = path.join(REPO_ROOT, 'transcripts');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = http.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address() as AddressInfo;
    s.close(() => resolve(port));
  }).on('error', reject);
});

// /api/chat allows one request a second per client.
let lastChat = 0;
async function chat(body: Record<string, unknown>, token?: string) {
  const wait = lastChat + 1200 - Date.now();
  if (wait > 0) await sleep(wait);
  lastChat = Date.now();
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { ...P, ...(token ? { 'X-Access-Token': token } : {}) },
    body: JSON.stringify(body),
  });
  lastChat = Date.now();
  return { status: res.status, json: await res.json() as any };
}

async function accessToken(): Promise<string> {
  const res = await fetch(`${base}/api/access`, { method: 'POST', headers: P, body: JSON.stringify({ code: CODE }) });
  assert.equal(res.status, 200);
  return (await res.json() as any).token;
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decks-test-'));
  try { transcriptsBefore = new Set(fs.readdirSync(transcriptsDir)); } catch { /* no dir yet */ }

  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      sent.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        id: 'chatcmpl-fixture', object: 'chat.completion', created: 0, model: 'gpt-4o-mini',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(nextReply) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    });
  });
  await new Promise<void>(r => fake.listen(0, '127.0.0.1', () => r()));
  const fakePort = (fake.address() as AddressInfo).port;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;

  // An explicit environment, not process.env: dotenv never overrides a name
  // that is already set, so every key the repo's .env could supply is pinned
  // here to a test value or to empty, and no real credential or database is used.
  server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: path.join(REPO_ROOT, 'packages/api'),
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      NODE_ENV: 'test',
      PORT: String(port),
      DATABASE_URL: `sqlite://${path.join(tmp, 'test.db')}`,
      TABLE_PREFIX: '',
      JWT_SECRET: 'fixture-jwt-secret',
      ADMIN_PASSPHRASE: ADMIN,
      ADMIN_PASSPHRASE_PROD: '',
      OPENAI_API_KEY: 'fixture-key-not-real',
      HARVARD_GATEWAY_URL: `http://127.0.0.1:${fakePort}/v1`,
      OPENAI_TTS_KEY: '', OPENAI_REALTIME_KEY: '', KOBO_API_TOKEN: '', GEMINI_API_KEY: '',
      PRIVATE_CONTENT_ROOT: '', ALLOWED_ORIGINS: '',
      ACCESS_CODE_DECKS: CODE,
    } as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout!.on('data', d => { serverLog += d; });
  server.stderr!.on('data', d => { serverLog += d; });

  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    await sleep(200);
    if (server.exitCode !== null) break;
    try { up = (await fetch(`${base}/api/health`)).ok; } catch { /* not yet */ }
  }
  assert.ok(up, `server did not start:\n${serverLog.slice(-2000)}`);

  // The project lands before any deck is synced. Record what it serves with no
  // vignettes at all, before the fixtures go in (asserted in a test below).
  {
    const res = await fetch(`${base}/api/access`, { method: 'POST', headers: P, body: JSON.stringify({ code: CODE }) });
    const headers = { ...P, 'X-Access-Token': (await res.json() as any).token };
    const get = async (route: string) => {
      const r = await fetch(`${base}${route}`, { headers });
      return { status: r.status, json: await r.json() as any };
    };
    empty = {
      vignettes: await get('/api/vignettes'),
      named: await get(`/api/vignettes?vignette=${KEY_MAIN}`),
      config: await get('/api/config'),
      languages: await get('/api/languages'),
    };
  }

  // Content goes in the way push-content.ts puts it: the admin API.
  const admin = new AdminApiClient({ baseUrl: base, passphrase: ADMIN, project: 'decks' });
  await admin.saveSystemPrompt(SYSTEM_PROMPT);
  for (const v of buildDeckVignettes(FIXTURES, DECK).vignettes) await admin.saveVignette(v.key, v.content);
});

after(async () => {
  server?.kill();
  await new Promise<void>(r => fake.close(() => r()));
  // /api/chat snapshots each first turn into transcripts/ (gitignored). Remove ours.
  try {
    for (const f of fs.readdirSync(transcriptsDir)) {
      if (f.startsWith('initial_') && !transcriptsBefore.has(f)) fs.unlinkSync(path.join(transcriptsDir, f));
    }
  } catch { /* nothing written */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the loader turns a packs folder into <deck>--<slide-id> vignettes', () => {
  const build = buildDeckVignettes(FIXTURES, DECK);
  assert.deepEqual(build.vignettes.map(v => v.key), [KEY_WHO, KEY_MAIN]);   // slide order
  const main = build.vignettes[1];
  assert.equal(main.title, 'Slide 2: FIXTURE main effect');
  assert.ok(main.content.indexOf('SLIDE IN SCOPE') < main.content.indexOf('DECK PACK'));
  assert.ok(main.content.indexOf('DECK PACK') < main.content.indexOf('SLIDE PACK'));
  assert.match(main.content, /200 invented clinics/);                       // deck pack
  assert.match(main.content, /the coefficient is 0\.111/);                  // its own slide
  assert.doesNotMatch(main.content, /0\.777/);                              // not the other slide
  for (const v of build.vignettes) assert.match(v.key, /^[A-Za-z0-9_-]{1,100}$/);
});

test('the loader refuses what a small model cannot read, and never writes a fixture deck', () => {
  assert.throws(() => parsePack('---\ntitle: T\n---\n| a | b |\n|---|---|\n| 1 | 2 |\n', 'x.md'), /markdown table/);
  assert.throws(() => parsePack('no front matter', 'x.md'), /front matter/);
  assert.throws(() => parsePack('---\nslide: 1\n---\nbody', 'x.md'), /title/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decks-packs-'));
  try {
    fs.writeFileSync(path.join(dir, '_deck.md'), '---\ntitle: D\n---\nDeck.\n');
    fs.writeFileSync(path.join(dir, 'big.md'), `---\ntitle: Big\n---\n${'x'.repeat(MAX_CHARS)}\n`);
    assert.throws(() => buildDeckVignettes(dir, DECK), /over the/);
    fs.renameSync(path.join(dir, 'big.md'), path.join(dir, 'Bad_Id.md'));
    assert.throws(() => buildDeckVignettes(dir, DECK), /slide id/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => writeDeck(buildDeckVignettes(FIXTURES, DECK)), /fixture/);
});

test('the project is gated, logged, and on the small model', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'projects/decks/project.json'), 'utf8'));
  assert.equal(cfg.requireAccessCode, true);
  assert.equal(cfg.logConversations, true);
  assert.equal(resolveProjectFlags(cfg).enableFollowups, true);  // the JSON channel that carries beyondScope
  assert.equal(cfg.chatModel, 'gpt-4o-mini');
  assert.equal(cfg.talkManifest, undefined);         // no public, unauthenticated slide list
  assert.equal(cfg.requireKnownVignette, true);      // an unknown slide is refused, never swapped
  // The code lives in configuration (ACCESS_CODE_DECKS), never in project.json.
  assert.deepEqual(Object.keys(cfg).filter(k => /code/i.test(k)), ['requireAccessCode']);
});

test('with no vignettes yet, every slide link is refused and nothing else breaks', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'projects/decks/project.json'), 'utf8'));
  assert.deepEqual(cfg.cases.vignettes, []);          // the project lands empty; packs arrive by sync
  assert.equal(empty.vignettes.status, 200);
  assert.deepEqual(empty.vignettes.json.vignetteKeys, []);   // no seeded default case
  assert.equal(empty.named.status, 404);
  assert.equal(empty.named.json.code, 'unknown_vignette');
  assert.equal(empty.config.status, 200);
  assert.equal(empty.config.json.requireKnownVignette, true);
  assert.ok(empty.languages.status === 200 || empty.languages.status === 404);   // 404 until first content push
});

test('the vignette endpoint refuses without the access code', async () => {
  const bare = await fetch(`${base}/api/vignettes`, { headers: P });
  assert.equal(bare.status, 401);
  assert.equal((await bare.json() as any).needsAccessCode, true);

  const forged = await fetch(`${base}/api/vignettes`, { headers: { ...P, 'X-Access-Token': 'not-a-token' } });
  assert.equal(forged.status, 401);

  const wrong = await fetch(`${base}/api/access`, { method: 'POST', headers: P, body: JSON.stringify({ code: 'nope' }) });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json() as any).token, undefined);

  // /api/config is open, and is how the page learns it must show the gate.
  const config = await (await fetch(`${base}/api/config`, { headers: P })).json() as any;
  assert.equal(config.requireAccessCode, true);
  assert.equal(config.requireKnownVignette, true);

  const ok = await fetch(`${base}/api/vignettes`, { headers: { ...P, 'X-Access-Token': await accessToken() } });
  assert.equal(ok.status, 200);
  assert.deepEqual(((await ok.json()) as any).vignetteKeys.sort(), [KEY_MAIN, KEY_WHO].sort());
});

test('slide titles are not served without the access code', async () => {
  const titles = { [KEY_MAIN]: { title: 'Slide 2: FIXTURE main effect', scenarioDescription: 'FIXTURE deck' } };
  const langs = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'projects/decks/languages.json'), 'utf8'));
  const admin = new AdminApiClient({ baseUrl: base, passphrase: ADMIN, project: 'decks' });
  await admin.saveLanguages({ ...langs, vignetteInfo: titles });

  for (const headers of [P, { ...P, 'X-Access-Token': 'not-a-token' }]) {
    const res = await fetch(`${base}/api/languages`, { headers });
    assert.equal(res.status, 200);                    // the gate itself is drawn from these strings
    const body = await res.text();
    assert.doesNotMatch(body, /FIXTURE main effect/);
    const json = JSON.parse(body);
    assert.equal(json.vignetteInfo, undefined);
    assert.ok(json.ui.en.welcome.accessHint);
  }
  // No other open route carries a title either.
  for (const route of ['/api/config', '/api/tabs', '/api/talk-manifest/decks']) {
    const body = await (await fetch(`${base}${route}`, { headers: P })).text();
    assert.doesNotMatch(body, /FIXTURE/, route);
  }

  const withCode = await fetch(`${base}/api/languages`, { headers: { ...P, 'X-Access-Token': await accessToken() } });
  assert.deepEqual(((await withCode.json()) as any).vignetteInfo, titles);

  // An ungated project is served its languages file whole, as before.
  await new AdminApiClient({ baseUrl: base, passphrase: ADMIN, project: 'demo' })
    .saveLanguages({ languages: [], ui: {}, vignetteInfo: { scene_1: { title: 'Open title' } } });
  const demo = await (await fetch(`${base}/api/languages`, { headers: { 'X-Project': 'demo' } })).json() as any;
  assert.equal(demo.vignetteInfo.scene_1.title, 'Open title');
});

test('an unknown slide is refused, never swapped for the first one', async () => {
  const headers = { ...P, 'X-Access-Token': await accessToken() };
  const known = await fetch(`${base}/api/vignettes?vignette=${KEY_MAIN}`, { headers });
  assert.equal(known.status, 200);

  const unknown = await fetch(`${base}/api/vignettes?vignette=${DECK}--no-such-slide`, { headers });
  assert.equal(unknown.status, 404);
  const body = await unknown.json() as any;
  assert.equal(body.code, 'unknown_vignette');
  assert.equal(body.vignetteKeys, undefined);          // no list to fall back on

  // ?doc= is the same check under its new name; ?vignette= wins over it.
  assert.equal((await fetch(`${base}/api/vignettes?doc=${KEY_MAIN}`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/api/vignettes?doc=${DECK}--no-such-slide`, { headers })).status, 404);
  assert.equal((await fetch(`${base}/api/vignettes?vignette=${KEY_MAIN}&doc=${DECK}--no-such-slide`, { headers })).status, 200);

  // The gate comes first: without the code the answer is 401, not 404.
  assert.equal((await fetch(`${base}/api/vignettes?vignette=${DECK}--no-such-slide`, { headers: P })).status, 401);

  // Chat refuses the key too, and makes no model call for it.
  const before = sent.length;
  const res = await chat({ vignetteKey: `${DECK}--no-such-slide`, messages: [{ role: 'user', content: 'x' }] }, headers['X-Access-Token']);
  assert.equal(res.status, 400);
  assert.equal(sent.length, before);

  // The page has words for it.
  const langs = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'projects/decks/languages.json'), 'utf8'));
  assert.match(langs.ui.en.chat.unknownVignette, /no pack/);

  // A project that does not set the option keeps its behavior: the full list.
  const demo = await fetch(`${base}/api/vignettes?vignette=nope`, { headers: { 'X-Project': 'demo' } });
  assert.equal(demo.status, 200);
});

test('chat needs the access code, and no model call is made without it', async () => {
  const before = sent.length;
  const res = await chat({ vignetteKey: KEY_MAIN, messages: [{ role: 'user', content: 'What is the coefficient?' }] });
  assert.equal(res.status, 401);
  assert.equal(res.json.needsAccessCode, true);
  assert.equal(sent.length, before);
});

test('prompt assembly: system prompt, then the deck pack, then this slide only', async () => {
  const token = await accessToken();
  nextReply = {
    answer: 'The coefficient is 0.111 (Table F1, row Training, column 1). The design is randomized.',
    followups: ['What is the control mean?', 'How many clinics are in the sample?'],
    beyondScope: false,
  };
  const before = sent.length;
  const res = await chat({
    vignetteKey: KEY_MAIN,
    sessionToken: 'fixture-session-0001',
    messages: [{ role: 'user', content: 'What is the coefficient on training?' }],
  }, token);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(sent.length, before + 1);

  const req = sent[sent.length - 1].body;
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
  for (const marker of ['SLIDE IN SCOPE\nDeck: ', 'DECK PACK (true for the whole deck)', 'SLIDE PACK (this slide only)']) {
    assert.ok(at(marker) > SYSTEM_PROMPT.trim().length - 1, `${marker} follows the system prompt`);
  }
  assert.ok(at('DECK PACK (true for the whole deck)') < at('SLIDE PACK (this slide only)'));
  assert.ok(at('SLIDE PACK (this slide only)') < at('You will respond as a JSON object'));
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
  nextReply = {
    answer: 'That analysis is not in the deck. The request as I understand it. Outcome: correct management. ' +
            'Sample: clinics, small clinics dropped. Comparison: training against no training. ' +
            'Unit and weights: clinic, weights not specified. Inference: not specified. It has been logged for the authors.',
    followups: ['What is the control mean?', 'How many clinics are in the sample?'],
    beyondScope: true,
  };
  const res = await chat({
    vignetteKey: KEY_MAIN,
    sessionToken: 'fixture-session-0001',
    messages: [{ role: 'user', content: question }],
  }, token);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.beyondScope, true);
  assert.match(res.json.message, /logged for the authors/);

  // "Logged for the authors" has to be true: the turn is in qa_log, with its slide.
  const admin = new AdminApiClient({ baseUrl: base, passphrase: ADMIN, project: 'decks' });
  let rows: any[] = [];
  for (let i = 0; i < 20 && !rows.some(r => r.question === question); i++) {
    await sleep(100);                                 // the log write is non-blocking
    rows = (await admin.getQaLog({ days: 1 })).rows;
  }
  const row = rows.find(r => r.question === question);
  assert.ok(row, 'the request is in qa_log');
  assert.equal(row.vignette_key, KEY_MAIN);
  assert.match(row.answer, /Outcome: .*Sample: .*Comparison: .*Unit and weights: .*Inference: /);

  // The log is admin-only.
  const open = await fetch(`${base}/api/admin/qa-log`, { headers: P });
  assert.equal(open.status, 401);
});

test('the system prompt carries the rules the packs depend on', () => {
  for (const phrase of [
    'Never do arithmetic', 'Never estimate, extrapolate, round or guess',
    'The pack for this slide does not state that.',
    'Outcome:', 'Sample:', 'Comparison:', 'Unit and weights:', 'Inference:', 'It has been logged for the authors.',
    'randomized, difference-in-differences or descriptive',
    'beyondScope', 'No dashes as punctuation', 'American spelling', 'No flattery',
  ]) assert.ok(SYSTEM_PROMPT.includes(phrase), `system prompt lacks: ${phrase}`);
  assert.doesNotMatch(SYSTEM_PROMPT, /[–—]|\s--\s/);
});
