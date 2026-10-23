/**
 * Is the deployment serving the commit this run was started from?
 *
 * A merge to main starts two things at once: the API host (the Raspberry Pi,
 * whose deployer, the runner job hosting-deploy, pulls main every five
 * minutes) rebuilds and restarts the API, and the Pages
 * workflow pushes that commit's content to the API. A push that begins before
 * the restart talks to the old container, then to nothing (502 while the new
 * one takes over). So the workflow waits here first, on GET /api/health and
 * its `commit` field, which the server always sends: GIT_COMMIT_SHA, or null
 * when that is unset (the image takes it as a build argument, see Dockerfile).
 *
 * The host builds an image only for a commit that changed the image's build
 * context, and labels it with that commit (tools/deploy-commit.sh). A commit
 * that changed only documentation or workflows is served by the image of an
 * earlier commit, forever. So the commit a caller waits for is the image
 * commit of the one it has (`imageCommit`), never the pushed commit itself.
 *
 * What a healthy answer means, by its `commit`:
 *
 *   the expected commit      ready.
 *   a later commit that      ready too. When two merges land close together
 *   contains it              the service may already run the second, and will
 *                            never run the first again (`isDescendant`).
 *   another commit           the old container, or a failed build: keep
 *                            waiting, and fail at the deadline.
 *   no `commit` key          a build from before the key existed, so the old
 *                            container: keep waiting.
 *   null                     this deployment does not report its commit
 *                            (GIT_COMMIT_SHA is unset: an image built without
 *                            the build argument). Nothing can be compared, so
 *                            the wait is for a service that stays healthy
 *                            (`stableAnswers` answers running), and the result
 *                            says `verified: false` so the caller can warn.
 *
 * With `commit: null` the caller asks for that last fallback outright.
 *
 * It fails, with the reason, when the deadline passes first.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The image commit for `ref`: the newest commit at or before it that changed
 * the Docker build context, which is the commit the host builds and its
 * /api/health reports (tools/deploy-commit.sh, the one implementation of the
 * rule here; the Pi's deployer runs the same script beside its own copy,
 * pi/hosting/bin/image-commit.sh, and deploys nothing when they disagree). Read from the
 * repository at `cwd` (default: this checkout), which needs the history back
 * to that commit: a CI checkout needs `fetch-depth: 0`, and the script fails,
 * saying so, when the history is too shallow to tell.
 */
export function imageCommit(ref: string, cwd = REPO_ROOT): string {
  try {
    return execFileSync('sh', [path.join(REPO_ROOT, 'tools/deploy-commit.sh'), ref], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e: any) {
    throw new Error(String(e?.stderr ?? e?.message ?? e).trim() || `tools/deploy-commit.sh ${ref} failed`);
  }
}

export interface WaitOptions {
  baseUrl: string;
  /**
   * The commit that must be serving, an image commit (`imageCommit`): a full
   * SHA, or a prefix of 7 or more characters. Null skips the commit check: the wait is then for a service
   * that stays healthy (a manual run from a branch the host does not deploy).
   */
  commit: string | null;
  timeoutMs?: number;
  intervalMs?: number;
  /** Consecutive healthy answers that count as stable when no commit can be checked. Default 4. */
  stableAnswers?: number;
  /** The wait between those answers. Default 5 seconds. */
  stableIntervalMs?: number;
  /** Does `deployed` contain `expected`? Default: asks git (gitIsDescendant). */
  isDescendant?: (deployed: string, expected: string) => boolean | Promise<boolean>;
  log?: (message: string) => void;
}

export interface Ready {
  /** The commit the service reported; null when it reports none. */
  commit: string | null;
  /** True when it is a later commit that contains the expected one. */
  later: boolean;
  /**
   * True when the commit was checked. False when the wait fell back to a
   * stable healthy service: no commit was asked for, or the deployment
   * reports none (`commit: null`, GIT_COMMIT_SHA unset).
   */
  verified: boolean;
  attempts: number;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const SHA = /^[0-9a-f]{7,40}$/i;

export function sameCommit(a: string, b: string): boolean {
  if (!SHA.test(a) || !SHA.test(b)) return false;
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * True when `deployed` is a descendant of `expected` in the repository at
 * `cwd`. A CI checkout is shallow, so the deployed commit is fetched first,
 * 100 commits deep; a commit git cannot fetch or relate is not a descendant.
 */
export function gitIsDescendant(deployed: string, expected: string, cwd = process.cwd()): boolean {
  if (!SHA.test(deployed) || !SHA.test(expected)) return false;
  const git = (args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  try {
    try { git(['fetch', '--quiet', '--depth=100', 'origin', deployed]); } catch { /* offline, or already here */ }
    git(['merge-base', '--is-ancestor', expected, deployed]);
    return true;
  } catch {
    return false;
  }
}

export async function waitForDeploy(o: WaitOptions): Promise<Ready> {
  if (o.commit !== null && !SHA.test(o.commit)) throw new Error(`"${o.commit}" is not a commit SHA`);
  const base = o.baseUrl.replace(/\/$/, '');
  const timeoutMs = o.timeoutMs ?? 600_000;
  const intervalMs = o.intervalMs ?? 10_000;
  const stableAnswers = o.stableAnswers ?? 4;
  const stableIntervalMs = o.stableIntervalMs ?? 5_000;
  const isDescendant = o.isDescendant ?? ((d, e) => gitIsDescendant(d, e));
  const log = o.log ?? (m => console.log(m));
  const deadline = Date.now() + timeoutMs;
  const want = o.commit ? o.commit.slice(0, 7) : 'a stable healthy service';
  const notDescendants = new Set<string>();
  let state = 'no answer yet';
  let stable = 0;
  for (let attempts = 1; ; attempts++) {
    // Counting toward stable: this deployment cannot be checked by commit.
    let counting = false;
    try {
      const res = await fetch(`${base}/api/health`);
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        state = `/api/health answered ${res.status}`;
      } else {
        const health = await res.json() as Record<string, unknown>;
        const deployed = typeof health.commit === 'string' ? health.commit : null;
        if (o.commit === null || (deployed === null && 'commit' in health)) {
          // No commit to compare: none was asked for, or this deployment says
          // outright that it reports none. Healthy several times running is
          // then the most that can be known.
          counting = true;
          stable += 1;
          if (stable >= stableAnswers) return { commit: deployed, later: false, verified: false, attempts };
          state = `healthy ${stable} of ${stableAnswers} times running` + (o.commit === null ? '' : ', and it reports no commit');
        } else if (deployed === null) {
          // No `commit` key at all: a build from before the key existed, so
          // the old container is still the one answering.
          state = 'healthy, but /api/health has no commit field (the previous deployment is still answering)';
        } else if (sameCommit(deployed, o.commit)) {
          return { commit: deployed, later: false, verified: true, attempts };
        } else if (!notDescendants.has(deployed) && await isDescendant(deployed, o.commit)) {
          return { commit: deployed, later: true, verified: true, attempts };
        } else {
          notDescendants.add(deployed);
          state = `healthy, but serving ${deployed.slice(0, 7)}`;
        }
      }
    } catch (e) {
      state = `unreachable (${(e as any)?.cause?.code ?? (e as Error).message})`;
    }
    if (!counting) stable = 0;
    const pause = counting ? stableIntervalMs : intervalMs;
    if (Date.now() + pause > deadline) {
      throw new Error(`${base} is not serving ${want} after ${Math.round(timeoutMs / 1000)}s: ${state}`);
    }
    log(`  Attempt ${attempts}: ${state}. Waiting ${Math.round(pause / 1000)}s for ${want}...`);
    await sleep(pause);
  }
}

/**
 * The warning for a wait that ended without a commit check, as a GitHub
 * Actions annotation; null when the commit was checked.
 */
export function unverifiedWarning(ready: Ready, expected: string | null): string | null {
  if (ready.verified) return null;
  if (expected === null) {
    return '::warning::The deployment was not checked against a commit (this run is not a push to main); ' +
      `it is healthy and serving ${ready.commit ? ready.commit.slice(0, 7) : 'an unreported commit'}. Content is pushed to it as it is.`;
  }
  return '::warning::The deployment does not report its commit: /api/health says commit null, so GIT_COMMIT_SHA ' +
    `is not set in the running container. Could not confirm it serves ${expected.slice(0, 7)}; went ahead on a service ` +
    'that stayed healthy. Check the variable (the image sets it from its GIT_COMMIT_SHA build argument).';
}

/**
 * Has the content of a commit reached the deployment?
 *
 * A healthy service on the right commit is only half of a release. Prompts,
 * grounding and case content reach the API through the content push, the
 * CONTENT_STEP of the CONTENT_WORKFLOW run for the commit, which finishes
 * minutes after the API starts serving it. A check that stops at the commit
 * tests the new code with the previous content (on 2026-10-14 four rounds of
 * live answers were credited to the wrong system prompt that way). So a wait
 * for a release waits for this step too.
 *
 * What the recent runs on main mean, for the commit asked about:
 *
 *   its run's push step succeeded            ready.
 *   a later run that contains it succeeded   ready too (`later`): a queued run
 *                                            is cancelled when a newer one
 *                                            queues, and the newer run pushes
 *                                            the same content and more.
 *   its push step failed or was skipped      fail at once, with the run's URL.
 *   its run was cancelled                    wait for a later run.
 *   no run for it or a later commit          fail after `startTimeoutMs`: a
 *                                            commit pushed with a workflow
 *                                            token, or [skip ci], starts none.
 *
 * The workflow's own wait must not call this (it would wait for itself):
 * wait-for-deploy.ts takes --no-content-push there.
 */
export const CONTENT_WORKFLOW = 'deploy-pages.yml';
export const CONTENT_STEP = 'Push content to the API';

export interface ContentRun { id: number; headSha: string; status: string; conclusion: string | null; url: string }
export interface ContentStep { status: string; conclusion: string | null }

export interface ContentPushOptions {
  commit: string;
  timeoutMs?: number;
  /** How long a run for the commit (or a later one) may take to appear. Default 3 minutes. */
  startTimeoutMs?: number;
  intervalMs?: number;
  /** Recent runs of CONTENT_WORKFLOW on main, newest first. Default: `gh api`. */
  listRuns?: () => ContentRun[] | Promise<ContentRun[]>;
  /** The CONTENT_STEP of a run; null while the run has no such step yet. Default: `gh api`. */
  pushStep?: (runId: number) => ContentStep | null | Promise<ContentStep | null>;
  isDescendant?: (later: string, expected: string) => boolean | Promise<boolean>;
  log?: (message: string) => void;
}

export interface ContentPushed { commit: string; runId: number; later: boolean; attempts: number }

function ghJson(path: string): any {
  return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}

export function ghListRuns(): ContentRun[] {
  const data = ghJson(`repos/{owner}/{repo}/actions/workflows/${CONTENT_WORKFLOW}/runs?branch=main&per_page=30`);
  return (data.workflow_runs ?? []).map((r: any) => ({
    id: r.id, headSha: r.head_sha, status: r.status, conclusion: r.conclusion, url: r.html_url,
  }));
}

export function ghPushStep(runId: number): ContentStep | null {
  const data = ghJson(`repos/{owner}/{repo}/actions/runs/${runId}/jobs?per_page=100`);
  for (const job of data.jobs ?? []) {
    const step = (job.steps ?? []).find((s: any) => s.name === CONTENT_STEP);
    if (step) return { status: step.status, conclusion: step.conclusion };
  }
  return null;
}

export async function waitForContentPush(o: ContentPushOptions): Promise<ContentPushed> {
  if (!SHA.test(o.commit)) throw new Error(`"${o.commit}" is not a commit SHA`);
  const timeoutMs = o.timeoutMs ?? 900_000;
  const startTimeoutMs = o.startTimeoutMs ?? 180_000;
  const intervalMs = o.intervalMs ?? 15_000;
  const listRuns = o.listRuns ?? ghListRuns;
  const pushStep = o.pushStep ?? ghPushStep;
  const isDescendant = o.isDescendant ?? ((d, e) => gitIsDescendant(d, e));
  const log = o.log ?? (m => console.log(m));
  const start = Date.now();
  const deadline = start + timeoutMs;
  const want = o.commit.slice(0, 7);
  const related = new Map<string, boolean>();
  let state = 'no run listed yet';
  for (let attempts = 1; ; attempts++) {
    const runs = await listRuns();
    const own = runs.filter(r => sameCommit(r.headSha, o.commit));
    const later: ContentRun[] = [];
    for (const r of runs) {
      if (sameCommit(r.headSha, o.commit)) continue;
      if (!related.has(r.headSha)) related.set(r.headSha, await isDescendant(r.headSha, o.commit));
      if (related.get(r.headSha)) later.push(r);
    }
    for (const r of [...own, ...later]) {
      const step = await pushStep(r.id);
      if (step?.conclusion === 'success') {
        return { commit: r.headSha, runId: r.id, later: !own.includes(r), attempts };
      }
    }
    const mine = own[0];
    if (mine) {
      const step = await pushStep(mine.id);
      if (step && step.status === 'completed' && step.conclusion !== 'success') {
        throw new Error(`the content push for ${want} did not succeed: step "${CONTENT_STEP}" ${step.conclusion} (${mine.url})`);
      }
      if (mine.status === 'completed' && mine.conclusion !== 'cancelled') {
        throw new Error(`the content push for ${want} never ran: run ${mine.conclusion} before step "${CONTENT_STEP}" (${mine.url})`);
      }
      state = mine.status === 'completed'
        ? `run for ${want} was cancelled; waiting for a later run that contains it`
        : `run for ${want} is ${mine.status}${step ? `, step "${CONTENT_STEP}" ${step.status}` : ''}`;
    } else if (later.length) {
      state = `no run for ${want}; ${later.length} later run(s) that contain it, none pushed yet`;
    } else {
      state = `no ${CONTENT_WORKFLOW} run for ${want} or a later commit`;
      if (Date.now() - start >= startTimeoutMs) {
        throw new Error(`${state} after ${Math.round(startTimeoutMs / 1000)}s (a commit pushed with a workflow token, or [skip ci], starts none)`);
      }
    }
    if (Date.now() + intervalMs > deadline) {
      throw new Error(`the content of ${want} was not pushed after ${Math.round(timeoutMs / 1000)}s: ${state}`);
    }
    log(`  Content attempt ${attempts}: ${state}. Waiting ${Math.round(intervalMs / 1000)}s...`);
    await sleep(intervalMs);
  }
}
