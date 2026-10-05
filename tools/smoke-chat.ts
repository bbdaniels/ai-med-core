#!/usr/bin/env npx tsx
/**
 * smoke-chat.ts: the post-deploy chat smoke.
 *
 * For each project, against a running deployment:
 *   1. GET /api/config answers 200 (and says whether the project is gated,
 *      structured, or publishes a talk manifest);
 *   2. GET /api/vignettes answers 401 without an access token when the project
 *      is gated, and 200 with one (or 200 outright when it is not gated);
 *   3. one POST /api/chat turn answers 200 with a non-empty message, a
 *      followups array when the project is structured, and usage;
 *   4. a project that publishes a talk manifest lists at least one paper.
 *
 * Usage:
 *   npx tsx tools/smoke-chat.ts --url <api-base-url> [--projects a,b,c] [--repo <checkout>] [--commit <sha>]
 *
 * `--commit <sha>` waits first, up to 10 minutes, until the deployment serves
 * that commit (tools/lib/deploy-ready.ts). A merge to main restarts the API, so
 * a smoke run right after one would otherwise test the old container, or fail
 * on the 502s of the restart. Pass the merged commit.
 *
 * The question asked of each project comes from its private
 * projects/<slug>/tests/smoke.json: { "vignetteKey": "...", "question": "...",
 * "language"?: "English" }. Without --projects, every project that has one is
 * smoked. Access codes come from ACCESS_CODE_<SLUG>. With ADMIN_PASSPHRASE set,
 * the cost of each turn is read from the deployment's own token_usage estimate
 * (GET /api/admin/token-usage, before and after the turn); without it only the
 * token counts are printed. A run costs about a cent.
 *
 * Each turn sends a sessionToken starting "smoke-chat-", so the turn can be
 * told apart in qa_log and conversation exports. Exits 1 on any failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdminApiClient } from './lib/api-client.js';
import { unverifiedWarning, waitForDeploy } from './lib/deploy-ready.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

interface Smoke {
  vignetteKey: string;
  question: string;
  language?: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const envSlug = (slug: string) => slug.toUpperCase().replace(/[^A-Z0-9]/g, '_');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function getJson(url: string, headers: Record<string, string>, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> ?? {}) } });
  let json: any = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json };
}

async function serverCost(admin: AdminApiClient | null): Promise<number | null> {
  if (!admin) return null;
  try {
    const summary = await admin.getTokenUsage(1);
    return Number(summary?.totals?.estimated_cost ?? 0);
  } catch {
    return null;
  }
}

async function smokeProject(base: string, slug: string, smoke: Smoke): Promise<string[]> {
  const failures: string[] = [];
  const P = { 'X-Project': slug, 'Content-Type': 'application/json' };

  const config = await getJson(`${base}/api/config`, P);
  if (config.status !== 200) {
    return [`config: /api/config answered ${config.status}`];
  }
  const gated = config.json?.requireAccessCode === true;
  const structured = config.json?.enableFollowups === true;
  const talkManifest = config.json?.talkManifest === true;

  let token: string | undefined;
  if (gated) {
    const bare = await getJson(`${base}/api/vignettes`, P);
    if (bare.status !== 401) failures.push(`vignettes: gated, but answered ${bare.status} without a token`);
    const code = process.env[`ACCESS_CODE_${envSlug(slug)}`];
    if (!code) {
      failures.push(`access: gated, and ACCESS_CODE_${envSlug(slug)} is not set`);
      return failures;
    }
    const access = await getJson(`${base}/api/access`, P, { method: 'POST', body: JSON.stringify({ code }) });
    if (access.status !== 200 || typeof access.json?.token !== 'string') {
      failures.push(`access: /api/access answered ${access.status}`);
      return failures;
    }
    token = access.json.token;
  }
  const authed = token ? { ...P, 'X-Access-Token': token } : P;
  const vignettes = await getJson(`${base}/api/vignettes`, authed);
  if (vignettes.status !== 200) failures.push(`vignettes: answered ${vignettes.status}${gated ? ' with a token' : ''}`);

  if (talkManifest) {
    const manifest = await getJson(`${base}/api/talk-manifest/${slug}`, {});
    const n = Array.isArray(manifest.json?.papers) ? manifest.json.papers.length : 0;
    if (manifest.status !== 200 || n === 0) failures.push(`talk-manifest: answered ${manifest.status} with ${n} papers`);
  }

  const passphrase = process.env.ADMIN_PASSPHRASE;
  const admin = passphrase ? new AdminApiClient({ baseUrl: base, passphrase, project: slug }) : null;
  const costBefore = await serverCost(admin);
  const sessionToken = `smoke-chat-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
  const chat = await getJson(`${base}/api/chat`, authed, {
    method: 'POST',
    body: JSON.stringify({
      vignetteKey: smoke.vignetteKey,
      language: smoke.language ?? 'English',
      sessionToken,
      messages: [{ role: 'user', content: smoke.question }],
    }),
  });
  if (chat.status !== 200) {
    failures.push(`chat: answered ${chat.status}: ${JSON.stringify(chat.json).slice(0, 200)}`);
    return failures;
  }
  if (typeof chat.json?.message !== 'string' || !chat.json.message.trim()) failures.push('chat: empty message');
  if (structured && !Array.isArray(chat.json?.followups)) failures.push('chat: structured project, but followups is not an array');
  const usage = chat.json?.usage;
  if (!usage || typeof usage.total_tokens !== 'number') failures.push('chat: no usage in the response');

  await sleep(500);                       // the usage row is written after the reply
  const costAfter = await serverCost(admin);
  const cost = costBefore !== null && costAfter !== null
    ? `$${(costAfter - costBefore).toFixed(6)}`
    : 'cost n/a (set ADMIN_PASSPHRASE for the server\'s own estimate)';
  console.log(`  ${slug}: ${usage?.prompt_tokens ?? '?'} prompt + ${usage?.completion_tokens ?? '?'} completion tokens, ${cost}`);
  console.log(`  ${slug}: "${String(chat.json?.message ?? '').slice(0, 120)}"`);
  return failures;
}

async function main() {
  const url = arg('--url');
  if (!url) {
    console.error('Usage: npx tsx tools/smoke-chat.ts --url <api-base-url> [--projects a,b,c] [--repo <checkout>] [--commit <sha>]');
    process.exit(2);
  }
  const base = url.replace(/\/$/, '');
  const commit = arg('--commit');
  if (commit) {
    console.log(`Waiting for ${base} to serve ${commit.slice(0, 7)}...`);
    try {
      const ready = await waitForDeploy({ baseUrl: base, commit });
      console.log(unverifiedWarning(ready, commit)?.replace('::warning::', 'WARNING: ') ?? `  Serving ${ready.commit!.slice(0, 7)}.`);
    } catch (e) {
      console.error(`FAIL: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
  }
  const repo = path.resolve(arg('--repo') ?? path.resolve(HERE, '..'));
  const projectsDir = path.join(repo, 'projects');
  const listed = arg('--projects');
  const slugs = listed
    ? listed.split(',').map(s => s.trim()).filter(Boolean)
    : (fs.existsSync(projectsDir) ? fs.readdirSync(projectsDir).sort() : [])
        .filter(s => fs.existsSync(path.join(projectsDir, s, 'tests', 'smoke.json')));
  if (slugs.length === 0) {
    console.error(`FAIL: no projects to smoke (no ${path.join(projectsDir, '<slug>', 'tests', 'smoke.json')})`);
    process.exit(1);
  }

  let failed = 0;
  for (const slug of slugs) {
    const file = path.join(projectsDir, slug, 'tests', 'smoke.json');
    let smoke: Smoke;
    try {
      smoke = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      console.log(`FAIL ${slug}: no readable ${path.relative(repo, file)}`);
      failed++;
      continue;
    }
    let failures: string[];
    try {
      failures = await smokeProject(base, slug, smoke);
    } catch (e) {
      failures = [`error: ${e instanceof Error ? e.message : String(e)}`];
    }
    if (failures.length) {
      failed++;
      console.log(`FAIL ${slug}`);
      for (const f of failures) console.log(`  - ${f}`);
    } else {
      console.log(`PASS ${slug}`);
    }
    await sleep(1100);                    // /api/chat allows one request a second per client
  }
  console.log(`\n${slugs.length - failed}/${slugs.length} projects passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error('Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
