#!/usr/bin/env npx tsx
/**
 * wait-for-deploy.ts: wait until a deployment serves a commit.
 *
 *   npx tsx tools/wait-for-deploy.ts --url <api-base-url> --commit <sha> [--timeout <seconds>]
 *   npx tsx tools/wait-for-deploy.ts --url <api-base-url> --any-commit   [--timeout <seconds>]
 *
 * Polls GET /api/health until it answers 200 and reports `--commit` (or a
 * later commit that contains it) in its `commit` field, then exits 0. Exits 1,
 * saying what it last saw, when `--timeout` (default 600) passes first. The
 * rule, case by case, is tools/lib/deploy-ready.ts.
 *
 * Two cases cannot be checked by commit, and both end in a wait for a service
 * that stays healthy (four answers, five seconds apart), exit 0 and a
 * `::warning::` line that GitHub Actions shows on the run: a deployment whose
 * /api/health says `commit: null` (RAILWAY_GIT_COMMIT_SHA is unset), and
 * `--any-commit`, for a run from a commit Railway does not deploy.
 *
 * The Pages workflow runs it before the content push, and the post-deploy
 * smoke (tools/smoke-chat.ts --commit) runs the same wait, because a merge to
 * main restarts the API while both are starting.
 */
import { unverifiedWarning, waitForDeploy } from './lib/deploy-ready.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const url = arg('--url');
  const anyCommit = process.argv.includes('--any-commit');
  const commit = anyCommit ? null : arg('--commit');
  const timeout = Number(arg('--timeout') ?? 600);
  if (!url || commit === undefined || !Number.isFinite(timeout) || timeout <= 0) {
    console.error('Usage: npx tsx tools/wait-for-deploy.ts --url <api-base-url> (--commit <sha> | --any-commit) [--timeout <seconds>]');
    process.exit(2);
  }
  console.log(`Waiting for ${url} to serve ${commit ? commit.slice(0, 7) : 'a stable healthy answer (no commit check)'}...`);
  const ready = await waitForDeploy({ baseUrl: url, commit, timeoutMs: timeout * 1000 });
  console.log(unverifiedWarning(ready, commit) ?? (ready.later
    ? `  Serving ${ready.commit!.slice(0, 7)}, a later commit that contains ${commit!.slice(0, 7)}.`
    : `  Serving ${ready.commit!.slice(0, 7)}.`));
}

main().catch(err => {
  console.error(`ABORT: ${err instanceof Error ? err.message : err}. Check the Railway deployment, then re-run the workflow.`);
  process.exit(1);
});
