/**
 * Private files: content a project serves that is deliberately kept out of git.
 *
 * The papers project's vignettes (each paper's full text) and its PDFs are
 * gitignored, because several are publisher-copyright. A CI checkout therefore
 * lacks them, and that absence is by design, not an error. Every tool that
 * walks a project's file references asks this one question, so "missing" means
 * the same thing in the validator and in the content push:
 *
 *   isPrivateFile(rel) === true   absent here is fine; it reaches the deployment
 *                                 from a checkout that has it (push-content.ts)
 *   isPrivateFile(rel) === false  it is tracked content, and absent is a bug
 *
 * The .gitignore is the declaration. There is no second list to keep in step.
 */
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** True when git ignores this repo-relative path. Fails safe: no git means false. */
export function isPrivateFile(rel: string): boolean {
  try {
    // Exit 0: ignored. Exit 1: not ignored. Anything else (no git, not a
    // repository) throws too, and counts as "not private", so a broken
    // environment makes a missing file an error rather than a silent skip.
    execFileSync('git', ['check-ignore', '-q', '--', rel], { cwd: REPO_ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Every file a project.json's tabs point at, all languages, repo-relative. */
export function tabContentFiles(project: { tabs?: Array<{ contentFile?: string | Record<string, string> }> }): string[] {
  const out = new Set<string>();
  for (const t of project.tabs ?? []) {
    if (typeof t.contentFile === 'string') out.add(t.contentFile);
    else if (t.contentFile) for (const f of Object.values(t.contentFile)) out.add(f);
  }
  return [...out];
}
