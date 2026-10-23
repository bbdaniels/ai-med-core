// Run: npm -w @ai-med/api test   (node:test under tsx)
//
// tools/deploy-commit.sh names the commit whose image should be serving a ref:
// the newest commit at or before it, along the first parent, that changed a
// path in the Docker build context (tracked files less .dockerignore), with
// Dockerfile and .dockerignore always counting. The Pi's deployer builds
// that commit and deploy-pages.yml waits for /api/health to report it.
//
// Each test builds a throwaway repository and runs the real script in it. The
// first group uses the repository's own .dockerignore, so it pins what this
// project's image is made of: documentation and workflows map back to the
// previous image, evaluation results and server code do not. The second group
// pins the matcher against Docker's pattern rules with a .dockerignore of its
// own. (The public mirror carries no Dockerfile or .dockerignore, so there the
// first group is skipped and says why.)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = path.join(REPO, 'tools/deploy-commit.sh');
const REAL_IGNORE = path.join(REPO, '.dockerignore');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};

class Repo {
  dir = mkdtempSync(path.join(os.tmpdir(), 'deploy-commit-'));
  constructor() { this.git('init', '-q', '-b', 'main'); }
  git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.dir, env: GIT_ENV, encoding: 'utf8' }).trim();
  }
  /** Write (or, with null, delete) files and commit them; returns the commit. */
  commit(message: string, files: Record<string, string | null>): string {
    for (const [rel, body] of Object.entries(files)) {
      const p = path.join(this.dir, rel);
      if (body === null) { rmSync(p); continue; }
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, body);
    }
    this.git('add', '-A');
    this.git('commit', '-q', '--allow-empty', '-m', message);
    return this.git('rev-parse', 'HEAD');
  }
  deployCommit(ref: string): string {
    return execFileSync('sh', [SCRIPT, ref], { cwd: this.dir, env: GIT_ENV, encoding: 'utf8' }).trim();
  }
  list(ref: string): string[] {
    return execFileSync('sh', [SCRIPT, '--list', ref], { cwd: this.dir, env: GIT_ENV, encoding: 'utf8' })
      .split('\n').filter(Boolean).sort();
  }
  fails(args: string[]): string {
    try {
      execFileSync('sh', [SCRIPT, ...args], { cwd: this.dir, env: GIT_ENV, encoding: 'utf8', stdio: 'pipe' });
    } catch (e: any) {
      return String(e.stderr);
    }
    throw new Error(`deploy-commit.sh ${args.join(' ')} succeeded`);
  }
  remove() { rmSync(this.dir, { recursive: true, force: true }); }
}

const noRealImage = !existsSync(REAL_IGNORE) || !existsSync(path.join(REPO, 'Dockerfile'))
  ? 'this tree has no Dockerfile and .dockerignore (the public mirror)'
  : false;

describe('the image commit under this repository\'s .dockerignore', { skip: noRealImage }, () => {
  const base = (): Record<string, string> => ({
    '.dockerignore': readFileSync(REAL_IGNORE, 'utf8'),
    'Dockerfile': 'FROM node:22-slim\n',
    'package.json': '{}\n',
    'packages/api/src/server.ts': 'export {};\n',
    'packages/api/src/server.test.ts': 'test\n',
    'packages/api/CLAUDE.md': 'docs\n',
    'projects/demo/project.json': '{}\n',
    'projects/demo/eval/index.json': '{"submissions":[]}\n',
    'projects/demo/tests/chat-cases.json': '[]\n',
    'eval/dashboard/index.html': '<!doctype html>\n',
    'eval/scripts/grade.py': 'print()\n',
    'tools/build-frontends.ts': 'export {};\n',
    'tools/push-content.ts': 'export {};\n',
    'docs/deployment.md': 'docs\n',
    'CLAUDE.md': 'docs\n',
    'README.md': 'docs\n',
    '.github/workflows/test.yml': 'on: push\n',
    'landing/index.html': '<!doctype html>\n',
  });

  test('a documentation-only commit maps back to the previous image commit', () => {
    const r = new Repo();
    try {
      const image = r.commit('code', base());
      const docs = r.commit('docs', {
        'CLAUDE.md': 'more docs\n',
        'packages/api/CLAUDE.md': 'more docs\n',
        'docs/deployment.md': 'more docs\n',
        'README.md': 'more docs\n',
        '.github/workflows/test.yml': 'on: [push]\n',
        'landing/index.html': '<!doctype html><p>\n',
        'tools/push-content.ts': 'export const x = 1;\n',
        'eval/scripts/grade.py': 'print(1)\n',
        'packages/api/src/server.test.ts': 'test 2\n',
        'projects/demo/tests/chat-cases.json': '[1]\n',
      });
      assert.equal(r.deployCommit(docs), image);
      assert.equal(r.deployCommit(image), image);
      const empty = r.commit('empty', {});
      assert.equal(r.deployCommit(empty), image, 'an empty commit changes no image');
    } finally { r.remove(); }
  });

  test('a change to projects/*/eval is an image commit: the API serves eval results from disk', () => {
    const r = new Repo();
    try {
      r.commit('code', base());
      const graded = r.commit('Update evaluation data [automated]', {
        'projects/demo/eval/index.json': '{"submissions":[1]}\n',
        'projects/demo/eval/submissions/a.json': '{}\n',
      });
      assert.equal(r.deployCommit(graded), graded);
      const docs = r.commit('docs', { 'CLAUDE.md': 'later docs\n' });
      assert.equal(r.deployCommit(docs), graded);
      assert.ok(r.list(graded).includes('projects/demo/eval/submissions/a.json'));
    } finally { r.remove(); }
  });

  test('server code, project content, the dashboard page and the talk build are image commits', () => {
    const r = new Repo();
    try {
      r.commit('code', base());
      for (const file of ['packages/api/src/server.ts', 'projects/demo/project.json',
        'eval/dashboard/index.html', 'tools/build-frontends.ts', 'package.json']) {
        const c = r.commit(`edit ${file}`, { [file]: `changed ${file}\n` });
        assert.equal(r.deployCommit(c), c, file);
      }
    } finally { r.remove(); }
  });

  test('Dockerfile and .dockerignore always count, and a deletion counts', () => {
    const r = new Repo();
    try {
      r.commit('code', base());
      const df = r.commit('Dockerfile', { 'Dockerfile': 'FROM node:22\n' });
      assert.equal(r.deployCommit(df), df);
      const di = r.commit('.dockerignore', { '.dockerignore': readFileSync(REAL_IGNORE, 'utf8') + '\n# note\n' });
      assert.equal(r.deployCommit(di), di);
      const del = r.commit('delete a project file', { 'projects/demo/project.json': null });
      assert.equal(r.deployCommit(del), del);
    } finally { r.remove(); }
  });

  test('--list names the context: server and content in, documentation and tests out', () => {
    const r = new Repo();
    try {
      const c = r.commit('code', base());
      assert.deepEqual(r.list(c), [
        '.dockerignore', 'Dockerfile', 'eval/dashboard/index.html', 'package.json',
        'packages/api/src/server.ts', 'projects/demo/eval/index.json', 'projects/demo/project.json',
        'tools/build-frontends.ts',
      ]);
    } finally { r.remove(); }
  });
});

describe('the matcher follows Docker\'s .dockerignore rules', () => {
  test('anchoring, **, *, ?, ! and directory patterns', () => {
    const r = new Repo();
    try {
      const c = r.commit('fixture', {
        '.dockerignore': [
          '# a comment',
          '',
          '  /transcripts/  ',      // cleaned: leading and trailing slash, whitespace
          '**/cache',               // any depth
          'notes/*.md',             // one segment
          'log?.txt',
          'vendor',
          '!vendor/keep.js',        // put back
          'a/**/z.txt',             // ** in the middle, zero or more directories
          'docs/**',                // ** at the end
          '!docs/keep/**',
          'docs/keep/drop.txt',     // last match wins
          'x.y+z',                  // regex metacharacters are literal
        ].join('\n') + '\n',
        'Dockerfile': 'FROM scratch\n',
        'transcripts/t.txt': '1', 'projects/p/transcripts/t.txt': '1',
        'cache/c': '1', 'deep/er/cache/c': '1', 'cached/c': '1',
        'notes/a.md': '1', 'notes/sub/b.md': '1',
        'log1.txt': '1', 'log10.txt': '1',
        'vendor/lib.js': '1', 'vendor/keep.js': '1',
        'a/z.txt': '1', 'a/b/c/z.txt': '1', 'a/b/y.txt': '1',
        'docs/d.md': '1', 'docs/keep/k.md': '1', 'docs/keep/drop.txt': '1',
        'x.y+z': '1', 'xay+z': '1',
      });
      assert.deepEqual(r.list(c), [
        '.dockerignore', 'Dockerfile',
        'a/b/y.txt', 'cached/c', 'docs/keep/k.md', 'log10.txt', 'notes/sub/b.md',
        'projects/p/transcripts/t.txt', 'vendor/keep.js', 'xay+z',
      ]);
    } finally { r.remove(); }
  });

  test('the walk follows the first parent, and a merge counts what it brought in', () => {
    const r = new Repo();
    try {
      r.commit('fixture', { '.dockerignore': 'docs\n', 'Dockerfile': 'FROM scratch\n', 'src/a.ts': '1' });
      r.git('checkout', '-q', '-b', 'side');
      r.commit('side code', { 'src/b.ts': '1' });
      r.git('checkout', '-q', 'main');
      const docs = r.commit('main docs', { 'docs/x.md': '1' });
      r.git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
      const merge = r.git('rev-parse', 'HEAD');
      assert.equal(r.deployCommit(merge), merge, 'the merge brought src/b.ts onto main');
      const later = r.commit('more docs', { 'docs/y.md': '1' });
      assert.equal(r.deployCommit(later), merge);
      assert.notEqual(r.deployCommit(docs), docs);
    } finally { r.remove(); }
  });

  test('a repository with no .dockerignore puts every tracked file in the context', () => {
    const r = new Repo();
    try {
      const c = r.commit('fixture', { 'Dockerfile': 'FROM scratch\n', 'docs/a.md': '1' });
      const d = r.commit('docs', { 'docs/a.md': '2' });
      assert.equal(r.deployCommit(d), d);
      assert.deepEqual(r.list(c), ['Dockerfile', 'docs/a.md']);
    } finally { r.remove(); }
  });

  test('refuses what it cannot answer: an unknown ref, a shallow boundary, export-ignore', () => {
    const r = new Repo();
    const shallow = mkdtempSync(path.join(os.tmpdir(), 'deploy-commit-shallow-'));
    try {
      assert.match(r.fails(['nope']), /nope is not a commit/);
      r.commit('fixture', { '.dockerignore': 'docs\n', 'Dockerfile': 'FROM scratch\n', 'src/a.ts': '1' });
      const docs = r.commit('docs', { 'docs/a.md': '1' });
      execFileSync('git', ['clone', '-q', '--depth', '1', `file://${r.dir}`, shallow], { env: GIT_ENV });
      try {
        execFileSync('sh', [SCRIPT, 'HEAD'], { cwd: shallow, env: GIT_ENV, stdio: 'pipe' });
        assert.fail('a shallow clone answered');
      } catch (e: any) {
        assert.match(String(e.stderr), new RegExp(`shallow at ${docs}`));
      }
      r.commit('attributes', { '.gitattributes': 'docs export-ignore\n' });
      assert.match(r.fails(['HEAD']), /export-ignore/);
    } finally { r.remove(); rmSync(shallow, { recursive: true, force: true }); }
  });
});
