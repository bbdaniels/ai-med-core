// Run: npm run test:chat            (compare against the committed snapshots)
//      UPDATE_SNAPSHOTS=1 npm run test:chat   (rewrite them; a deliberate change only)
//
// Characterization of POST /api/chat: what the server sends the model, what it
// answers, and what it logs, for every case a project declares. It pins today's
// behavior so the pipeline can be moved and refactored without changing it.
//
// Cases live with the projects, never here: projects/<slug>/tests/chat-cases.json
// and their snapshots in projects/<slug>/tests/chat-snapshots/<case>.json. A
// snapshot holds a project's prompts, so it stays under projects/, which is
// never published. Where projects/ has no cases (the public mirror), this file
// skips with a message.
//
// A snapshot records, per turn: the HTTP status, the response JSON, every
// request the fake gateway received (path and body), the token_usage and qa_log
// rows the turn added, and whether a first-turn prompt snapshot was written.
// Before recording, the project's system prompt text becomes <<SYSTEM_PROMPT>>
// and each grounding file's text (the project's, and each grounding set's)
// becomes <<GROUNDING <path>>>, so an edit to a prompt does not churn every
// snapshot.
//
// Case file shape:
//   { "cases": [ {
//       "name": "first-turn",                      // snapshot file name
//       "project": "<slug>",                       // default: the folder's slug
//       "accessCode": "fixture-code",              // set ACCESS_CODE_<SLUG>; turns then carry a token
//       "setup": {
//         "documents": [{ "key": "...", "file": "fixtures/case.md" }],   // pushed as vignettes
//         "caseTemplate": { ... } | "...",          // saved as the case template
//         "settings": { "payment_source": "...", "public_chat": "on" },
//         "readingsIndex": "fixtures/index.json"    // a fixture index spec (see chat-core test-support/fixture-index.ts)
//       },
//       "turns": [ {
//         "name": "...",
//         "body": { ...the /api/chat request body },
//         "http"?: { "path": "/api/...", "method"?: "GET", "origin"?: "...", "headers": ["..."] },
//                                                   // instead of body: one plain request under the
//                                                   // case's X-Project; records its status and the
//                                                   // named response headers (null when absent)
//         "fake": [ FakeReply | { "reject": 400, "body"?: {...} } ] | { "reject": [400, ...], "then"?: [FakeReply] },
//         "settings"?: { ... },                     // applied before this turn
//         "auth"?: false                            // send no access token on this turn
//       } ]
//   } ] }
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, REPO_ROOT, type Harness } from '../test-support/server-harness.js';
import { buildFixtureIndex } from '@ai-med/chat-core/test-support/fixture-index';
import type { FakeReply } from '../test-support/fake-openai.js';
import { loadChatProjectConfig, corpusGroundingFile, groundingSetFiles } from '@ai-med/chat-core';

const PROJECTS = path.join(REPO_ROOT, 'projects');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';

type FakeStep = FakeReply | { reject: number; body?: object };
interface HttpProbe {
  path: string;
  method?: string;
  origin?: string;
  headers: string[];
}
interface Turn {
  name: string;
  body?: Record<string, unknown>;
  http?: HttpProbe;
  fake?: FakeStep[] | { reject: Array<number | { status: number; body?: object }>; then?: FakeReply[] };
  settings?: Record<string, string>;
  auth?: boolean;
}
interface Case {
  name: string;
  project?: string;
  accessCode?: string;
  setup?: {
    documents?: Array<{ key: string; file: string }>;
    caseTemplate?: string | object;
    settings?: Record<string, string>;
    readingsIndex?: string;
  };
  turns: Turn[];
}
interface LoadedCase extends Case {
  slug: string;          // the folder the case file lives in
  project: string;       // the X-Project it runs under
  dir: string;           // projects/<slug>/tests
}

// Every case file, in a stable order.
function discover(): LoadedCase[] {
  const out: LoadedCase[] = [];
  let slugs: string[] = [];
  try { slugs = fs.readdirSync(PROJECTS).sort(); } catch { return out; }
  for (const slug of slugs) {
    const file = path.join(PROJECTS, slug, 'tests', 'chat-cases.json');
    if (!fs.existsSync(file)) continue;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { cases: Case[] };
    for (const c of parsed.cases) {
      out.push({ ...c, slug, project: c.project ?? slug, dir: path.dirname(file) });
    }
  }
  return out;
}

// A case may be written before its project lands (its cases then wait in
// projects/<slug>/tests/ beside no project.json). It runs once the project's
// project.json exists, and until then is reported as skipped.
const discovered = discover();
const cases = discovered.filter(c => fs.existsSync(path.join(PROJECTS, c.project, 'project.json')));
const waiting = discovered.filter(c => !cases.includes(c));

// What the project's own texts look like, so the snapshot can say where they go
// instead of repeating them. The grounding file is the one the pipeline reads.
async function redactions(project: string): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  const cfg = JSON.parse(fs.readFileSync(path.join(PROJECTS, project, 'project.json'), 'utf8'));
  const sp = cfg.cases?.systemPrompt;
  if (typeof sp === 'string' && sp) {
    const text = fs.readFileSync(path.join(REPO_ROOT, sp), 'utf8');
    if (text) out.push([text, '<<SYSTEM_PROMPT>>']);
  }
  const chatCfg = await loadChatProjectConfig(REPO_ROOT, project, '');
  // The project's grounding, and each grounding set's file this checkout has.
  const files = [await corpusGroundingFile(REPO_ROOT, chatCfg),
    ...groundingSetFiles(project, cfg).map(rel => path.join(REPO_ROOT, rel))];
  for (const g of files) {
    if (!g || !fs.existsSync(g)) continue;
    const text = fs.readFileSync(g, 'utf8');
    if (text) out.push([text, `<<GROUNDING ${path.relative(REPO_ROOT, g)}>>`]);
  }
  return out.sort((a, b) => b[0].length - a[0].length);
}

function redact<T>(value: T, rules: Array<[string, string]>): T {
  const walk = (v: any): any => {
    if (typeof v === 'string') {
      let s = v;
      for (const [text, marker] of rules) if (s.includes(text)) s = s.split(text).join(marker);
      return s;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}

function systemPromptFile(project: string): string | null {
  const cfg = JSON.parse(fs.readFileSync(path.join(PROJECTS, project, 'project.json'), 'utf8'));
  return typeof cfg.cases?.systemPrompt === 'string' ? path.join(REPO_ROOT, cfg.cases.systemPrompt) : null;
}

function fakeSteps(f: Turn['fake']): FakeStep[] {
  if (!f) return [];
  if (Array.isArray(f)) return f;
  const rejects = f.reject.map(r => (typeof r === 'number' ? { reject: r } : { reject: r.status, body: r.body }));
  return [...rejects, ...(f.then ?? [])];
}

let h: Harness | null = null;
let tmp = '';

before(async () => {
  if (cases.length === 0) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-characterization-'));
  const readingsIndexes: Record<string, string> = {};
  const accessCodes: Record<string, string> = {};
  for (const c of cases) {
    if (c.accessCode) {
      if (accessCodes[c.project] && accessCodes[c.project] !== c.accessCode) {
        throw new Error(`${c.slug}/${c.name}: a second access code for ${c.project}`);
      }
      accessCodes[c.project] = c.accessCode;
    }
    const spec = c.setup?.readingsIndex;
    if (spec) {
      const specPath = path.resolve(c.dir, spec);
      const dest = path.join(tmp, `${c.project}-${path.basename(spec, '.json')}.db`);
      if (readingsIndexes[c.project] && readingsIndexes[c.project] !== dest) {
        throw new Error(`${c.slug}/${c.name}: one readings index per project per run (${c.project})`);
      }
      if (!readingsIndexes[c.project]) buildFixtureIndex(dest, JSON.parse(fs.readFileSync(specPath, 'utf8')));
      readingsIndexes[c.project] = dest;
    }
  }
  h = await startServer({ readingsIndexes, accessCodes });
});

after(async () => {
  await h?.stop();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

if (discovered.length === 0) {
  test('chat characterization', { skip: 'no projects/*/tests/chat-cases.json in this tree (public mirror?)' }, () => {});
}
for (const c of waiting) {
  test(`${c.slug}: ${c.name}`, { skip: `projects/${c.project}/project.json does not exist yet; the case runs once it does` }, () => {});
}

for (const c of cases) {
  test(`${c.slug}: ${c.name}`, async () => {
    const harness = h!;
    const admin = harness.admin(c.project);

    // A clean project: only this case's documents, the real system prompt, and
    // explicit settings, whatever an earlier case left behind.
    // The server seeds an empty project from its files and refuses to delete
    // the last vignette, so this case's documents go in before the rest go out.
    const spFile = systemPromptFile(c.project);
    if (spFile) await admin.saveSystemPrompt(fs.readFileSync(spFile, 'utf8'));
    const keep = new Set<string>();
    for (const d of c.setup?.documents ?? []) {
      await admin.saveVignette(d.key, fs.readFileSync(path.resolve(c.dir, d.file), 'utf8'));
      keep.add(d.key);
    }
    if (keep.size > 0) {
      for (const v of (await admin.getContent()).vignettes) if (!keep.has(v.key)) await admin.deleteVignette(v.key);
    }
    const ct = c.setup?.caseTemplate ?? { name: '', title: '', vignetteTemplates: {} };
    await admin.saveCaseTemplate(typeof ct === 'string' ? ct : JSON.stringify(ct));
    const applySettings = (s: Record<string, string>) => {
      for (const [k, v] of Object.entries(s)) harness.setProjectSetting(c.project, k, v);
    };
    applySettings({ payment_source: 'harvard', public_chat: 'off', ...(c.setup?.settings ?? {}) });
    const token = c.accessCode ? await harness.access(c.project, c.accessCode) : undefined;

    const rules = await redactions(c.project);
    const recorded: any[] = [];
    for (const turn of c.turns) {
      if (turn.settings) applySettings(turn.settings);
      if (turn.http) {
        const probe = turn.http;
        const res = await fetch(`${harness.base}${probe.path}`, {
          method: probe.method ?? 'GET',
          headers: { 'X-Project': c.project, ...(probe.origin ? { Origin: probe.origin } : {}) },
        });
        await res.arrayBuffer();
        recorded.push({
          name: turn.name,
          status: res.status,
          headers: Object.fromEntries(probe.headers.map(h => [h.toLowerCase(), res.headers.get(h)])),
        });
        continue;
      }
      const body = turn.body ?? {};
      harness.fake.clearQueue();
      for (const step of fakeSteps(turn.fake)) {
        if ('reject' in step && typeof step.reject === 'number') harness.fake.rejectNext(step.reject, step.body);
        else harness.fake.enqueue(step as FakeReply);
      }
      const reqBefore = harness.fake.requests.length;
      const usageBefore = harness.tokenUsage(c.project).length;
      const qaBefore = harness.qaLog(c.project).length;
      const initialBefore = new Set(harness.initialSnapshots());

      const res = await harness.chat(c.project, body, turn.auth === false ? undefined : token);

      assert.equal(harness.fake.pending(), 0,
        `${c.name}/${turn.name}: ${harness.fake.pending()} scripted fake replies were never requested`);
      // A first-turn snapshot is a file in the server's own transcripts/
      // (the harness's checkout view) naming this turn's document and first
      // message.
      const msgs = Array.isArray(body.messages) ? body.messages as Array<{ content?: unknown }> : [];
      const firstText = typeof msgs[0]?.content === 'string' ? JSON.stringify(msgs[0].content) : null;
      const named = body.documentKey ?? body.vignetteKey;
      const docKey = typeof named === 'string' ? JSON.stringify(named) : null;
      const newSnapshots = harness.initialSnapshots().filter(s => !initialBefore.has(s));
      recorded.push({
        name: turn.name,
        status: res.status,
        response: res.json,
        requests: harness.fake.requests.slice(reqBefore),
        tokenUsage: harness.tokenUsage(c.project).slice(usageBefore),
        qaLog: harness.qaLog(c.project).slice(qaBefore),
        initialSnapshotWritten: !!firstText && !!docKey
          && newSnapshots.some(s => s.includes(firstText) && s.includes(docKey)),
      });
    }

    const actual = redact({ case: c.name, project: c.project, turns: recorded }, rules);
    const snapFile = path.join(c.dir, 'chat-snapshots', `${c.name}.json`);
    if (UPDATE) {
      fs.mkdirSync(path.dirname(snapFile), { recursive: true });
      fs.writeFileSync(snapFile, JSON.stringify(actual, null, 2) + '\n');
      return;
    }
    assert.ok(fs.existsSync(snapFile),
      `no snapshot at ${path.relative(REPO_ROOT, snapFile)}; record it with UPDATE_SNAPSHOTS=1 npm run test:chat`);
    assert.deepStrictEqual(actual, JSON.parse(fs.readFileSync(snapFile, 'utf8')));
  });
}
