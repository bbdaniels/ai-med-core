/**
 * A throwaway view of a checkout that holds only what git would hand a fresh
 * clone: every tracked file under `projects/`, plus untracked files that are not
 * ignored (work in progress the author has not added yet). Gitignored files are
 * left out: private paper texts, synced slide packs, local readings indexes.
 *
 * Why: a working copy that holds private content serves different answers than
 * CI's clean checkout (papers once listed seven languages locally and none in
 * CI, because the seed aborted on the first absent paper text). A server
 * started on this view (AI_MED_REPO_ROOT, see src/repo-root.ts) sees what CI
 * sees, so a snapshot recorded anywhere is the snapshot CI expects.
 *
 * Each file is a symlink to the working-copy file, so the view costs no copying
 * and always shows the current edit. Where git cannot list the tree (a staged
 * public tree with no .git, which holds no ignored files by construction),
 * `projects/` is linked whole.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Paths (relative, '/'-separated) under `dirs` that a clean checkout would have. */
export function trackedFiles(repoRoot: string, dirs: string[] = ['projects']): string[] | null {
  let out: string;
  try {
    out = execFileSync('git', ['-C', repoRoot, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...dirs],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
  return [...new Set(out.split('\0').filter(Boolean))].sort();
}

/**
 * Build the view at `dest` (created if needed) and return it. `transcripts/`
 * is created empty, so a server on this view has a transcripts directory of
 * its own.
 */
export function buildTrackedView(repoRoot: string, dest: string, dirs: string[] = ['projects']): string {
  fs.mkdirSync(path.join(dest, 'transcripts'), { recursive: true });
  const files = trackedFiles(repoRoot, dirs);
  if (files === null) {
    for (const d of dirs) {
      const src = path.join(repoRoot, d);
      if (fs.existsSync(src)) fs.symlinkSync(src, path.join(dest, d), 'dir');
    }
    return dest;
  }
  for (const rel of files) {
    const src = path.join(repoRoot, rel);
    if (!fs.existsSync(src)) continue;               // tracked, deleted in the working copy
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.symlinkSync(src, to);
  }
  return dest;
}
