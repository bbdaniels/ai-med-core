// Run: npm -w @ai-med/api test   (node:test under tsx)
//
// tools/push-content.ts refuses a registry that arrives before its content: a
// project.json naming a vignette whose file is neither in the checkout nor
// already deployed. Without the guard, a merge carrying only the registry
// (its CI push sends the titles and skips the gitignored files) would publish
// titles whose links all answer as unknown. The pure rule is tested first,
// then the tool itself against the test server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { groundingSetsWithoutContentMessage, vignettesWithoutContent, withoutContentMessage } from '../../../tools/lib/registry-guard.js';
import { startServer, REPO_ROOT, TEST_PASSPHRASE, type Harness } from '../test-support/server-harness.js';

const PUSH_TOOL = path.join(REPO_ROOT, 'tools', 'push-content.ts');
const TSX = import.meta.resolve('tsx');

test('a vignette is served when its file is here or its key is deployed', () => {
  const registered = [
    { key: 'here', inCheckout: true },
    { key: 'deployed', inCheckout: false },
    { key: 'both', inCheckout: true },
    { key: 'nowhere-1', inCheckout: false },
    { key: 'nowhere-2', inCheckout: false },
  ];
  assert.deepEqual(vignettesWithoutContent(registered, ['deployed', 'both', 'unrelated']), ['nowhere-1', 'nowhere-2']);
  assert.deepEqual(vignettesWithoutContent(registered.slice(0, 3), ['deployed']), []);
  assert.deepEqual(vignettesWithoutContent([], []), []);
  // A registry-only checkout against an empty deployment: every vignette.
  assert.deepEqual(vignettesWithoutContent([{ key: 'a', inCheckout: false }], []), ['a']);
});

test('the refusal names the count and never a key', () => {
  const msg = withoutContentMessage(124, 'some_project');
  assert.match(msg, /^ABORT: 124 vignette\(s\)/);
  assert.match(msg, /then merge the registry/);
  const sets = groundingSetsWithoutContentMessage(2, 'some_project');
  assert.match(sets, /^ABORT: 2 grounding set\(s\)/);
  assert.match(sets, /projects\/some_project\/grounding\/<set>\.md/);
});

let h: Harness;
let tmp = '';
const PROMPT = 'FIXTURE REGISTRY PROMPT';
const TITLE = 'FIXTURE REGISTRY TITLE';
const KEYS = ['fixture-registry--one', 'fixture-registry--two'];

/** A checkout holding only a registry for the demo slug: project.json and languages.json, no vignette files. */
function registryTree(extra: Record<string, unknown> = {}): string {
  const root = fs.mkdtempSync(path.join(tmp, 'tree-'));
  const dir = path.join(root, 'projects', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'system-prompt.md'), PROMPT);
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    name: 'demo',
    displayName: 'Fixture registry',
    frontend: 'chat',
    cases: {
      systemPrompt: 'projects/demo/system-prompt.md',
      vignettes: KEYS.map(key => ({ key, template: 'fixture', file: `projects/demo/cases/${key}.md` })),
    },
    languages: ['en'],
    deployment: { tablePrefix: 'demo' },
    ...extra,
  }));
  fs.writeFileSync(path.join(dir, 'languages.json'), JSON.stringify({
    languages: [{ code: 'en', name: 'English' }],
    ui: {},
    vignetteInfo: Object.fromEntries(KEYS.map(k => [k, { title: TITLE }])),
  }));
  return root;
}

// Asynchronous on purpose: a synchronous spawn would block the test server's
// fake gateway, which answers from this process.
function runPush(root: string): Promise<{ code: number | null; out: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--import', TSX, PUSH_TOOL, 'demo', '--url', h.base], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ADMIN_PASSPHRASE: TEST_PASSPHRASE },
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('close', code => { clearTimeout(timer); resolve({ code, out }); });
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-guard-test-'));
  h = await startServer({});
});

after(async () => {
  await h?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('push-content refuses a registry whose content is nowhere, and writes nothing', async () => {
  const root = registryTree();
  const r = await runPush(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ABORT: 2 vignette\(s\)/);
  for (const k of KEYS) assert.ok(!r.out.includes(k), 'the output names no key');

  const content = await h.admin('demo').getContent();
  assert.notEqual(content.systemPrompt, PROMPT);
  assert.deepEqual(content.vignettes.filter(v => KEYS.includes(v.key)), []);
  const langs = await (await fetch(`${h.base}/api/languages`, { headers: { 'X-Project': 'demo' } })).text();
  assert.ok(!langs.includes(TITLE), 'no title was pushed');
});

test('with the files in the checkout, the same registry pushes', async () => {
  const root = registryTree();
  fs.mkdirSync(path.join(root, 'projects', 'demo', 'cases'), { recursive: true });
  for (const k of KEYS) fs.writeFileSync(path.join(root, 'projects', 'demo', 'cases', `${k}.md`), `FIXTURE content for ${k}`);
  const r = await runPush(root);
  assert.equal(r.code, 0, r.out);
  const content = await h.admin('demo').getContent();
  assert.equal(content.systemPrompt, PROMPT);
  assert.deepEqual(content.vignettes.map(v => v.key).filter(k => KEYS.includes(k)).sort(), [...KEYS].sort());
  const langs = await (await fetch(`${h.base}/api/languages`, { headers: { 'X-Project': 'demo' } })).text();
  assert.ok(langs.includes(TITLE));
});

// A grounding set (project.json groundingSets) is guarded the same way: its
// file, projects/<slug>/grounding/<set>.md, must be here or in the private store.
const SET = 'fixture-registry';

test('push-content refuses a grounding set whose file is nowhere, and writes nothing', async () => {
  const root = registryTree({ groundingSets: [SET] });
  fs.mkdirSync(path.join(root, 'projects', 'demo', 'cases'), { recursive: true });
  for (const k of KEYS) fs.writeFileSync(path.join(root, 'projects', 'demo', 'cases', `${k}.md`), `FIXTURE content for ${k}`);
  const before = await h.admin('demo').getContent();
  const r = await runPush(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ABORT: 1 grounding set\(s\)/);
  assert.ok(!r.out.includes(SET), 'the output names no set');
  const after = await h.admin('demo').getContent();
  assert.equal(after.systemPrompt, before.systemPrompt);
  assert.deepEqual(after.vignettes.map(v => v.key).sort(), before.vignettes.map(v => v.key).sort());
});

test('with the set file in the checkout, the same registry pushes', async () => {
  const root = registryTree({ groundingSets: [SET] });
  fs.mkdirSync(path.join(root, 'projects', 'demo', 'cases'), { recursive: true });
  for (const k of KEYS) fs.writeFileSync(path.join(root, 'projects', 'demo', 'cases', `${k}.md`), `FIXTURE content for ${k}`);
  fs.mkdirSync(path.join(root, 'projects', 'demo', 'grounding'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', 'demo', 'grounding', `${SET}.md`), 'FIXTURE set notes');
  const r = await runPush(root);
  assert.equal(r.code, 0, r.out);
});
