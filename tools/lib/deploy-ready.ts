/**
 * Is the deployment serving the commit this run was started from?
 *
 * A merge to main starts two things at once: Railway rebuilds and restarts the
 * API from the commit, and the Pages workflow pushes that commit's content to
 * the API. A push that begins before the restart talks to the old container,
 * then to nothing (502 while the new one takes over). So the workflow waits
 * here first, on GET /api/health and its `commit` field, which the server
 * always sends: RAILWAY_GIT_COMMIT_SHA, or null when that is unset (Railway
 * provides it "if the deploy originated from a GitHub trigger",
 * https://docs.railway.com/reference/variables).
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
 *   null                     this deployment does not report its commit (the
 *                            variable is unset: `railway up`, or Railway did
 *                            not provide it). Nothing can be compared, so the
 *                            wait is for a service that stays healthy
 *                            (`stableAnswers` answers running), and the result
 *                            says `verified: false` so the caller can warn.
 *
 * With `commit: null` the caller asks for that last fallback outright.
 *
 * It fails, with the reason, when the deadline passes first.
 */
import { execFileSync } from 'node:child_process';

export interface WaitOptions {
  baseUrl: string;
  /**
   * The commit that must be serving: a full SHA, or a prefix of 7 or more
   * characters. Null skips the commit check: the wait is then for a service
   * that stays healthy (a manual run from a branch Railway does not deploy).
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
   * reports none (`commit: null`, RAILWAY_GIT_COMMIT_SHA unset).
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
  return '::warning::The deployment does not report its commit: /api/health says commit null, so RAILWAY_GIT_COMMIT_SHA ' +
    `is not set in the running container. Could not confirm it serves ${expected.slice(0, 7)}; went ahead on a service ` +
    'that stayed healthy. Check the variable (Railway provides it for deployments triggered from GitHub).';
}
