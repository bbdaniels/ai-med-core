// Run: npm -w @ai-med/chat-core test   (node:test under tsx)
//
// project.json flag resolution (project-config.ts), and the validator's
// contradiction check, run on a throwaway projects directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProjectFlags, talkContradictions, talkManifestPath, TALK_IMPLIED } from './project-config.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const pick = (f: ReturnType<typeof resolveProjectFlags>) => ({
  app: f.app, formless: f.formless, enableFeedback: f.enableFeedback,
  skipWelcome: f.skipWelcome, enableFollowups: f.enableFollowups, chatOnly: f.chatOnly,
});

test('no file: every default, and the simulator', () => {
  const f = resolveProjectFlags({});
  assert.equal(f.app, 'simulation');
  for (const [k, v] of Object.entries(f)) {
    if (k === 'app') continue;
    assert.equal(v, k === 'talkPublicUrl' ? '' : k === 'docRefs' ? null : false, k);
  }
});

test('a simulator project reads its flags as written', () => {
  assert.deepEqual(pick(resolveProjectFlags({ enableFeedback: true, kobo: {} })),
    { app: 'simulation', formless: false, enableFeedback: true, skipWelcome: false, enableFollowups: false, chatOnly: false });
});

test('without app, formless:true is talk and nothing is implied (the old behaviour)', () => {
  // Spelled out, as the talk projects did before declaring app.
  assert.deepEqual(pick(resolveProjectFlags({ formless: true, enableFeedback: false, skipWelcome: true, enableFollowups: true, chatOnly: true })),
    { app: 'talk', formless: true, enableFeedback: false, skipWelcome: true, enableFollowups: true, chatOnly: true });
  // A bare formless project gets no implied flags.
  assert.deepEqual(pick(resolveProjectFlags({ formless: true })),
    { app: 'talk', formless: true, enableFeedback: false, skipWelcome: false, enableFollowups: false, chatOnly: false });
  // formless:false is the simulator.
  assert.equal(resolveProjectFlags({ formless: false, enableFollowups: false }).app, 'simulation');
});

test('app:"talk" implies the four advisor flags; chatOnly stays explicit', () => {
  assert.deepEqual(pick(resolveProjectFlags({ app: 'talk' })),
    { app: 'talk', ...TALK_IMPLIED, chatOnly: false });
  assert.equal(resolveProjectFlags({ app: 'talk', chatOnly: true }).chatOnly, true);
});

test('app:"talk" and the spelled-out flags resolve identically', () => {
  const legacy = { formless: true, enableFeedback: false, skipWelcome: true, enableFollowups: true, chatOnly: true, requireAccessCode: true };
  const declared = { app: 'talk', chatOnly: true, requireAccessCode: true };
  assert.deepEqual(resolveProjectFlags(declared), resolveProjectFlags(legacy));
});

test('an explicit flag wins over an implied one', () => {
  const f = resolveProjectFlags({ app: 'talk', skipWelcome: false, enableFollowups: false });
  assert.equal(f.skipWelcome, false);
  assert.equal(f.enableFollowups, false);
  assert.equal(f.formless, true);
});

test('app:"simulation" implies nothing', () => {
  assert.deepEqual(pick(resolveProjectFlags({ app: 'simulation' })),
    { app: 'simulation', formless: false, enableFeedback: false, skipWelcome: false, enableFollowups: false, chatOnly: false });
});

test('talkManifest is only a flag; talkPublicUrl and docRefs pass through', () => {
  const f = resolveProjectFlags({ app: 'talk', talkManifest: 'projects/x/manifest.json', talkPublicUrl: 'https://example.org/{slug}', docRefs: { a: 1 } });
  assert.equal(f.talkManifest, true);
  assert.equal(f.talkPublicUrl, 'https://example.org/{slug}');
  assert.deepEqual(f.docRefs, { a: 1 });
  assert.equal(resolveProjectFlags({ talkManifest: '' }).talkManifest, false);
});

test('the talk manifest path is there exactly when the flag is', () => {
  assert.equal(talkManifestPath({ talkManifest: 'projects/x/manifest.json' }), 'projects/x/manifest.json');
  for (const cfg of [{}, { talkManifest: '' }, { talkManifest: true }, { talkManifest: { path: 'x' } }]) {
    assert.equal(talkManifestPath(cfg), null, JSON.stringify(cfg));
    assert.equal(resolveProjectFlags(cfg).talkManifest, false, JSON.stringify(cfg));
  }
});

test('contradictions: talk with formless:false or enableFeedback:true', () => {
  assert.deepEqual(talkContradictions({ app: 'talk' }), []);
  assert.deepEqual(talkContradictions({ app: 'talk', formless: true, enableFeedback: false }), []);
  assert.deepEqual(talkContradictions({ formless: false, enableFeedback: true }), []);
  assert.equal(talkContradictions({ app: 'talk', formless: false }).length, 1);
  assert.equal(talkContradictions({ app: 'talk', enableFeedback: true }).length, 1);
  assert.equal(talkContradictions({ app: 'talk', formless: false, enableFeedback: true }).length, 2);
});

/** A throwaway projects/ tree holding one talk project, as the validator reads it. */
function tempProject(extra: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-projects-'));
  const dir = path.join(root, 'projects', 'temp');
  fs.mkdirSync(path.join(dir, 'cases', 'doc'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'system-prompt.md'), 'Prompt.\n');
  fs.writeFileSync(path.join(dir, 'cases', 'doc', 'one.md'), 'Document.\n');
  fs.writeFileSync(path.join(dir, 'languages.json'), '{"languages":[{"code":"en","name":"English"}]}\n');
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    name: 'temp',
    displayName: 'Temp',
    frontend: 'chat',
    cases: { systemPrompt: 'projects/temp/system-prompt.md', vignettes: [{ key: 'one', template: 'doc', file: 'projects/temp/cases/doc/one.md' }] },
    languages: ['en'],
    deployment: { tablePrefix: 'temp' },
    ...extra,
  }));
  return root;
}

function runValidator(root: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', path.join(REPO, 'tools/validate-projects.ts')], {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, AI_MED_REPO_ROOT: root },
  });
}

test('the validator: a talk project needs no kobo; contradictions fail', () => {
  const ok = tempProject({ app: 'talk' });
  const bare = tempProject({});
  const bad = tempProject({ app: 'talk', formless: false, enableFeedback: true });
  try {
    const r = runValidator(ok);
    assert.equal(r.status, 0, r.stdout + r.stderr);

    // Neither talk nor formless: the simulator, which must declare kobo.
    const r2 = runValidator(bare);
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /kobo/);

    const r3 = runValidator(bad);
    assert.equal(r3.status, 1);
    assert.match(r3.stderr, /contradicts formless: false/);
    assert.match(r3.stderr, /contradicts enableFeedback: true/);
  } finally {
    for (const d of [ok, bare, bad]) fs.rmSync(d, { recursive: true, force: true });
  }
});
