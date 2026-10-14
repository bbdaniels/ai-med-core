#!/usr/bin/env npx tsx
/**
 * wait-for-deploy.ts: wait until a deployment serves a commit and its content.
 *
 *   npx tsx tools/wait-for-deploy.ts --url <api-base-url> --commit <sha> [--timeout <seconds>] [--no-content-push]
 *   npx tsx tools/wait-for-deploy.ts --url <api-base-url> --any-commit   [--timeout <seconds>]
 *
 * Polls GET /api/health until it answers 200 and reports `--commit` (or a
 * later commit that contains it) in its `commit` field. Then, with `--commit`,
 * waits until the "Push content to Railway" step of the deploy-pages.yml run
 * for that commit (or a later run that contains it) has succeeded, through
 * `gh api`, because prompts and grounding reach the API only through that
 * push. Exits 0 when both hold; exits 1, saying what it last saw, when the
 * push fails, never starts, or `--timeout` (default 600, for each wait)
 * passes first. The rules, case by case, are in tools/lib/deploy-ready.ts.
 *
 * `--no-content-push` skips the second wait. Only deploy-pages.yml passes it:
 * it runs this before its own content push and would otherwise wait for itself.
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
import { CONTENT_STEP, unverifiedWarning, waitForContentPush, waitForDeploy } from './lib/deploy-ready.js';

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
  if (commit && !process.argv.includes('--no-content-push')) {
    console.log(`Waiting for the content of ${commit.slice(0, 7)} to be pushed ("${CONTENT_STEP}")...`);
    const pushed = await waitForContentPush({ commit, timeoutMs: timeout * 1000 });
    console.log(pushed.later
      ? `  Content pushed by the run for ${pushed.commit.slice(0, 7)}, a later commit that contains ${commit.slice(0, 7)}.`
      : `  Content pushed (run ${pushed.runId}).`);
  }
}

main().catch(err => {
  console.error(`ABORT: ${err instanceof Error ? err.message : err}. Check the Railway deployment and the deploy-pages.yml run.`);
  process.exit(1);
});
