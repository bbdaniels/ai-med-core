/**
 * Start the real API server (src/server.ts) for a test, with nothing leaving
 * the machine.
 *
 * - The server runs as a child process on a throwaway SQLite file.
 * - Its one gateway client is pointed (HARVARD_GATEWAY_URL) at a FakeOpenAI in
 *   this process, which records every request and answers from a queue.
 * - The environment is explicit, not process.env: dotenv never overrides a
 *   name that is already set, so every name the repository's .env could supply
 *   is pinned to a test value or to empty. Every project's access code and
 *   readings index is pinned too, so a local .env or a local index can never
 *   change what a test sees.
 * - The clock is fixed (AI_MED_TEST_NOW, see fixed-clock.mjs) and TZ is UTC, so
 *   the date block in a prompt is reproducible.
 *
 * `chat()` keeps 1.2 s between turns, because /api/chat allows one request a
 * second per client. `stop()` removes the first-turn prompt snapshots
 * (transcripts/initial_*) that appeared since `startServer()`.
 *
 * The server writes those snapshots to the repository's one transcripts/
 * directory and cannot be pointed elsewhere, so a file cannot tell which server
 * wrote it. Two harnesses alive at once would each read and delete the other's
 * snapshots, which is why the api test script runs its test files one at a
 * time (--test-concurrency=1). The real fix is a per-server transcripts
 * directory, which arrives when the first-turn snapshot moves behind the
 * simulator hook with an injected transcriptsDir.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { AdminApiClient } from '../../../tools/lib/api-client.js';
import { FakeOpenAI } from './fake-openai.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../../..');
export const API_DIR = path.join(REPO_ROOT, 'packages/api');
export const TRANSCRIPTS_DIR = path.join(REPO_ROOT, 'transcripts');
export const FIXED_CLOCK_URL = pathToFileURL(path.join(HERE, 'fixed-clock.mjs')).href;
/** A Thursday. The date block then reads "Today is Thursday, October 1, 2026." */
export const DEFAULT_TEST_NOW = '2026-10-01T12:00:00Z';
export const TEST_PASSPHRASE = 'fixture-admin-passphrase';
export const CHAT_SPACING_MS = 1200;

export interface StartOptions {
  /** ISO instant the server's clock starts at. Default DEFAULT_TEST_NOW. */
  now?: string;
  /** slug -> path of a fixture readings index (READINGS_INDEX_<SLUG>). */
  readingsIndexes?: Record<string, string>;
  /** slug -> access code (ACCESS_CODE_<SLUG>). */
  accessCodes?: Record<string, string>;
  /** Extra environment, applied last. */
  env?: Record<string, string>;
}

export interface ChatResult {
  status: number;
  json: any;
}

export interface TokenUsageRow {
  project: string;
  endpoint: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  estimated_cost: number;
}

export interface QaLogRow {
  project: string;
  session_token: string | null;
  vignette_key: string | null;
  language: string | null;
  question: string;
  answer: string;
}

export interface Harness {
  base: string;
  fake: FakeOpenAI;
  dbPath: string;
  chat(project: string, body: Record<string, unknown>, token?: string): Promise<ChatResult>;
  /** POST /api/access; returns the token, or throws on anything but 200. */
  access(project: string, code: string): Promise<string>;
  /** An admin client for the project (one login per project per run). */
  admin(project: string): AdminApiClient;
  /** token_usage rows whose project is this slug (with or without its trailing _), oldest first. */
  tokenUsage(project: string): TokenUsageRow[];
  /** qa_log rows for this slug, oldest first. */
  qaLog(project: string): QaLogRow[];
  /** Write a project setting straight to the database (for values the admin API refuses). */
  setProjectSetting(project: string, key: string, value: string): void;
  /** Contents of the first-turn prompt snapshots written since the harness started. */
  initialSnapshots(): string[];
  /** The server's combined stdout and stderr so far. */
  log(): string;
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = http.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address() as AddressInfo;
    s.close(() => resolve(port));
  }).on('error', reject);
});

const envSlug = (slug: string) => slug.toUpperCase().replace(/[^A-Z0-9]/g, '_');
const bareSlug = (s: string) => s.replace(/_+$/, '');

function projectSlugs(): string[] {
  const dir = path.join(REPO_ROOT, 'projects');
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'project.json')))
    .map(e => e.name);
}

function listInitial(): Set<string> {
  try {
    return new Set(fs.readdirSync(TRANSCRIPTS_DIR).filter(f => f.startsWith('initial_')));
  } catch {
    return new Set();
  }
}

export async function startServer(o: StartOptions = {}): Promise<Harness> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-med-harness-'));
  const dbPath = path.join(tmp, 'test.db');
  const initialBefore = listInitial();
  const fake = new FakeOpenAI();
  await fake.start();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  // Every project's access code and readings index, pinned. A project without
  // a fixture index is pointed at a file that does not exist, so it has no
  // search tool, exactly as a deployment without its uploaded index.
  const pinned: Record<string, string> = {};
  for (const slug of projectSlugs()) {
    pinned[`ACCESS_CODE_${envSlug(slug)}`] = '';
    pinned[`READINGS_INDEX_${envSlug(slug)}`] = path.join(tmp, `no-index-${slug}.db`);
  }
  for (const [slug, code] of Object.entries(o.accessCodes ?? {})) pinned[`ACCESS_CODE_${envSlug(slug)}`] = code;
  for (const [slug, p] of Object.entries(o.readingsIndexes ?? {})) pinned[`READINGS_INDEX_${envSlug(slug)}`] = p;

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    NODE_ENV: 'test',
    TZ: 'UTC',
    AI_MED_TEST_NOW: o.now ?? DEFAULT_TEST_NOW,
    PORT: String(port),
    DATABASE_URL: `sqlite://${dbPath}`,
    TABLE_PREFIX: '',
    JWT_SECRET: 'fixture-jwt-secret',
    ADMIN_PASSPHRASE: TEST_PASSPHRASE,
    ADMIN_PASSPHRASE_PROD: '',
    OPENAI_API_KEY: 'fixture-key-not-real',
    HARVARD_GATEWAY_URL: fake.url,
    OPENAI_BASE_URL: '', OPENAI_ORG_ID: '', OPENAI_PROJECT_ID: '',
    OPENAI_TTS_KEY: '', OPENAI_REALTIME_KEY: '', KOBO_API_TOKEN: '', GEMINI_API_KEY: '',
    PRIVATE_CONTENT_ROOT: '', ALLOWED_ORIGINS: '', SERVE_FRONTEND: '', STATIC_DIR: '',
    ...pinned,
    ...(o.env ?? {}),
  };

  const child: ChildProcess = spawn(process.execPath,
    ['--import', FIXED_CLOCK_URL, '--import', 'tsx', 'src/server.ts'],
    { cwd: API_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  child.stdout!.on('data', d => { serverLog += d; });
  child.stderr!.on('data', d => { serverLog += d; });

  let up = false;
  for (let i = 0; i < 150 && !up; i++) {
    await sleep(200);
    if (child.exitCode !== null) break;
    try { up = (await fetch(`${base}/api/health`)).ok; } catch { /* not yet */ }
  }
  if (!up) {
    child.kill();
    await fake.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`server did not start:\n${serverLog.slice(-3000)}`);
  }

  let lastChat = 0;
  const admins = new Map<string, AdminApiClient>();

  const readDb = <T>(fn: (db: Database.Database) => T): T => {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try { return fn(db); } finally { db.close(); }
  };

  const harness: Harness = {
    base,
    fake,
    dbPath,

    async chat(project, body, token) {
      const wait = lastChat + CHAT_SPACING_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastChat = Date.now();
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: {
          'X-Project': project, 'Content-Type': 'application/json',
          ...(token ? { 'X-Access-Token': token } : {}),
        },
        body: JSON.stringify(body),
      });
      lastChat = Date.now();
      const text = await res.text();
      let json: any;
      try { json = JSON.parse(text); } catch { json = { _raw: text }; }
      // Logging after a reply is fire-and-forget in the server; give it a beat.
      await sleep(60);
      return { status: res.status, json };
    },

    async access(project, code) {
      const res = await fetch(`${base}/api/access`, {
        method: 'POST',
        headers: { 'X-Project': project, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const json = await res.json() as any;
      if (res.status !== 200 || typeof json.token !== 'string') {
        throw new Error(`access for ${project} failed: ${res.status} ${JSON.stringify(json)}`);
      }
      return json.token;
    },

    admin(project) {
      let c = admins.get(project);
      if (!c) {
        c = new AdminApiClient({ baseUrl: base, passphrase: TEST_PASSPHRASE, project });
        admins.set(project, c);
      }
      return c;
    },

    tokenUsage(project) {
      return readDb(db => (db.prepare(
        `SELECT project, endpoint, model, prompt_tokens, completion_tokens, estimated_cost
           FROM token_usage ORDER BY id`).all() as TokenUsageRow[])
        .filter(r => bareSlug(r.project) === bareSlug(project)));
    },

    qaLog(project) {
      return readDb(db => (db.prepare(
        `SELECT project, session_token, vignette_key, language, question, answer
           FROM qa_log ORDER BY id`).all() as QaLogRow[])
        .filter(r => bareSlug(r.project) === bareSlug(project)));
    },

    setProjectSetting(project, key, value) {
      const db = new Database(dbPath, { fileMustExist: true });
      try {
        db.prepare(`INSERT INTO project_settings (project_slug, setting_key, setting_value, updated_at)
                    VALUES (?, ?, ?, datetime('now'))
                    ON CONFLICT(project_slug, setting_key)
                    DO UPDATE SET setting_value = excluded.setting_value, updated_at = datetime('now')`)
          .run(bareSlug(project), key, value);
      } finally {
        db.close();
      }
    },

    initialSnapshots() {
      const out: string[] = [];
      for (const f of listInitial()) {
        if (initialBefore.has(f)) continue;
        try { out.push(fs.readFileSync(path.join(TRANSCRIPTS_DIR, f), 'utf8')); } catch { /* removed meanwhile */ }
      }
      return out;
    },

    log() {
      return serverLog;
    },

    async stop() {
      child.kill();
      await new Promise<void>(r => {
        if (child.exitCode !== null) return r();
        child.once('exit', () => r());
        setTimeout(r, 3000);
      });
      await fake.stop();
      for (const f of listInitial()) {
        if (!initialBefore.has(f)) fs.rmSync(path.join(TRANSCRIPTS_DIR, f), { force: true });
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
  return harness;
}
