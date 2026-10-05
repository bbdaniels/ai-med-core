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
import {
  documentSetGroundingFiles, followHostContradictions, groundingSetFile, groundingSetFiles, groundingSets, groundingSetsContradictions, projectUrlSlug, rememberConversationContradictions, resolveProjectFlags, talkContradictions,
  talkManifestPath, TALK_IMPLIED, urlAliasContradictions, urlAliases,
} from './project-config.js';

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
    if (k === 'embedOrigins') { assert.deepEqual(v, [], k); continue; }
    assert.equal(v, k === 'talkPublicUrl' ? '' : k === 'docRefs' || k === 'rememberConversation' ? null : false, k);
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

test('followHost is implied by nothing, and embedOrigins keeps only origins', () => {
  assert.equal(resolveProjectFlags({ app: 'talk' }).followHost, false);
  assert.equal(resolveProjectFlags({ app: 'talk', followHost: 'yes' }).followHost, false);
  const f = resolveProjectFlags({
    app: 'talk', followHost: true,
    embedOrigins: ['https://example.org', 'http://localhost:8770', 'https://example.org', 'https://example.org/', 'https://example.org/path', 'example.org', 3],
  });
  assert.equal(f.followHost, true);
  assert.deepEqual(f.embedOrigins, ['https://example.org', 'http://localhost:8770']);
  assert.deepEqual(resolveProjectFlags({ embedOrigins: 'https://example.org' }).embedOrigins, []);
});

test('followHost contradictions: talk only, needs an origin; its settings need it', () => {
  const origins = { embedOrigins: ['https://example.org'] };
  assert.deepEqual(followHostContradictions({ app: 'talk' }), []);
  assert.deepEqual(followHostContradictions({ app: 'talk', followHost: true, ...origins, historyTokens: 4000 }), []);
  assert.deepEqual(followHostContradictions({ app: 'talk', followHost: false }), []);
  assert.match(followHostContradictions({ followHost: true, ...origins, kobo: {} }).join('\n'), /needs app "talk"/);
  assert.match(followHostContradictions({ app: 'talk', followHost: true }).join('\n'), /needs embedOrigins/);
  assert.match(followHostContradictions({ app: 'talk', followHost: true, embedOrigins: ['nope'] }).join('\n'), /needs embedOrigins/);
  assert.match(followHostContradictions({ app: 'talk', ...origins }).join('\n'), /embedOrigins is read only with followHost/);
  assert.match(followHostContradictions({ app: 'talk', historyTokens: 4000 }).join('\n'), /historyTokens is read only with followHost/);
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

test('rememberConversation: {days} only for an integer from 1 to 30, and only on talk', () => {
  assert.equal(resolveProjectFlags({ app: 'talk' }).rememberConversation, null);
  assert.deepEqual(resolveProjectFlags({ app: 'talk', rememberConversation: { days: 7 } }).rememberConversation, { days: 7 });
  assert.deepEqual(resolveProjectFlags({ app: 'talk', rememberConversation: { days: 1 } }).rememberConversation, { days: 1 });
  assert.deepEqual(resolveProjectFlags({ app: 'talk', rememberConversation: { days: 30 } }).rememberConversation, { days: 30 });
  for (const bad of [{ days: 0 }, { days: 31 }, { days: 7.5 }, { days: '7' }, {}, true, 7, null]) {
    assert.equal(resolveProjectFlags({ app: 'talk', rememberConversation: bad }).rememberConversation, null, JSON.stringify(bad));
  }
  assert.deepEqual(rememberConversationContradictions({ app: 'talk' }), []);
  assert.deepEqual(rememberConversationContradictions({ app: 'talk', rememberConversation: { days: 7 } }), []);
  assert.match(rememberConversationContradictions({ kobo: {}, rememberConversation: { days: 7 } }).join('\n'), /needs app "talk"/);
});

test('the validator: rememberConversation needs talk; days outside 1 to 30 fail the schema', () => {
  const ok = tempProject({ app: 'talk', rememberConversation: { days: 7 } });
  const sim = tempProject({ kobo: { formUrl: 'https://example.org/f', formUid: 'f' }, rememberConversation: { days: 7 } });
  const long = tempProject({ app: 'talk', rememberConversation: { days: 31 } });
  const stray = tempProject({ app: 'talk', rememberConversation: { days: 7, hours: 2 } });
  try {
    const r = runValidator(ok);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const r2 = runValidator(sim);
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /rememberConversation needs app "talk"/);
    const r3 = runValidator(long);
    assert.equal(r3.status, 1);
    assert.match(r3.stderr, /rememberConversation\/days must be <= 30/);
    const r4 = runValidator(stray);
    assert.equal(r4.status, 1);
    assert.match(r4.stderr, /additional properties/);
  } finally {
    for (const d of [ok, sim, long, stray]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('the validator: followHost needs talk and an origin; a malformed origin fails the schema', () => {
  const ok = tempProject({ app: 'talk', followHost: true, embedOrigins: ['https://example.org', 'http://localhost:8770'], historyTokens: 8000 });
  const bare = tempProject({ app: 'talk', followHost: true });
  const stray = tempProject({ app: 'talk', embedOrigins: ['https://example.org'] });
  const slash = tempProject({ app: 'talk', followHost: true, embedOrigins: ['https://example.org/'] });
  try {
    const r = runValidator(ok);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const r2 = runValidator(bare);
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /followHost needs embedOrigins/);
    const r3 = runValidator(stray);
    assert.equal(r3.status, 1);
    assert.match(r3.stderr, /embedOrigins is read only with followHost/);
    const r4 = runValidator(slash);
    assert.equal(r4.status, 1);
    assert.match(r4.stderr, /embedOrigins\/0 must match pattern/);
  } finally {
    for (const d of [ok, bare, stray, slash]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('a project is served under its directory name with _ written -', () => {
  assert.equal(projectUrlSlug('haivn_eip'), 'haivn-eip');
  assert.equal(projectUrlSlug('a_b_c'), 'a-b-c');
  assert.equal(projectUrlSlug('papers'), 'papers');
});

test('urlAliases: the well-formed ones, without repeats, and only on talk', () => {
  assert.deepEqual(urlAliases({}), []);
  assert.deepEqual(urlAliases({ urlAliases: ['old-name', 'Bad', 'x/y', '', 7, 'old-name', 'b2'] }), ['old-name', 'b2']);
  assert.deepEqual(urlAliasContradictions({ app: 'talk', urlAliases: ['old'] }), []);
  assert.deepEqual(urlAliasContradictions({ kobo: {} }), []);
  assert.match(urlAliasContradictions({ kobo: {}, urlAliases: ['old'] }).join('\n'), /urlAliases needs app "talk"/);
});

test('the validator: an alias another project claims, as its slug or its alias, fails', () => {
  const ok = tempProject({ app: 'talk', urlAliases: ['old-temp'] });
  const sim = tempProject({ kobo: { formUrl: 'https://example.org/f', formUid: 'f' }, urlAliases: ['old-temp'] });
  const clash = tempProject({ app: 'talk', urlAliases: ['other-one'] });
  // A second project whose URL slug is other-one (directory other_one) and whose alias is old-temp.
  const second = path.join(clash, 'projects', 'other_one');
  fs.cpSync(path.join(clash, 'projects', 'temp'), second, { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(second, 'project.json'), 'utf8'));
  fs.writeFileSync(path.join(second, 'project.json'), JSON.stringify({
    ...cfg, name: 'other_one', urlAliases: ['temp'],
    cases: { ...cfg.cases, systemPrompt: 'projects/other_one/system-prompt.md',
      vignettes: [{ key: 'one', template: 'doc', file: 'projects/other_one/cases/doc/one.md' }] },
    deployment: { tablePrefix: 'other_one' },
  }));
  try {
    const r = runValidator(ok);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const r2 = runValidator(sim);
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /urlAliases needs app "talk"/);
    const r3 = runValidator(clash);
    assert.equal(r3.status, 1);
    assert.match(r3.stderr, /urlAliases: "other-one" is also claimed by other_one/);
    assert.match(r3.stderr, /urlAliases: "temp" is also claimed by temp/);
  } finally {
    for (const d of [ok, sim, clash]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('groundingSets: the well-formed names, without repeats; each set\'s file is projects/<slug>/grounding/<set>.md', () => {
  assert.deepEqual(groundingSets({}), []);
  assert.deepEqual(groundingSets({ groundingSets: ['deck-a', 'deck-a', 'a--b', '../x', 'x.y', '', 7, 'deck_b-2'] }), ['deck-a', 'deck_b-2']);
  assert.equal(groundingSetFile('proj', 'deck-a'), 'projects/proj/grounding/deck-a.md');
  assert.deepEqual(groundingSetFiles('proj', { groundingSets: ['deck-a', 'deck-b'] }),
    ['projects/proj/grounding/deck-a.md', 'projects/proj/grounding/deck-b.md']);
});

test('documentSetGroundingFiles: one file per well-formed document set the keys form, by the groundingSets rule', () => {
  assert.deepEqual(documentSetGroundingFiles('proj', []), []);
  assert.deepEqual(documentSetGroundingFiles('proj', ['deck-a--one', 'deck-a--two', 'paper', 'deck-b--x--y', 'x.y', '../z--1']),
    ['projects/proj/grounding/deck-a.md', 'projects/proj/grounding/paper.md', 'projects/proj/grounding/deck-b.md']);
});

test('groundingSetsContradictions: each set is some vignette\'s set, and grounding/ holds only declared files', () => {
  const vignettes = [{ key: 'deck-a--one' }, { key: 'deck-a--two' }, { key: 'paper' }];
  const cfg = (sets?: string[]) => ({ cases: { vignettes }, ...(sets ? { groundingSets: sets } : {}) });
  assert.deepEqual(groundingSetsContradictions(cfg()), []);
  assert.deepEqual(groundingSetsContradictions(cfg(['deck-a', 'paper']), ['deck-a.md', 'paper.md']), []);
  assert.match(groundingSetsContradictions(cfg(['deck-b'])).join('\n'), /"deck-b" is no vignette's document set/);
  assert.match(groundingSetsContradictions(cfg(['deck-a']), ['deck-a.md', 'deck-b.md']).join('\n'), /grounding\/deck-b\.md: not a declared grounding set's file/);
  // A grounding/ directory in a project that declares no sets is refused too.
  assert.match(groundingSetsContradictions(cfg(), ['deck-a.md']).join('\n'), /grounding\/deck-a\.md: not a declared/);
});

test('the validator: grounding sets must match a vignette\'s set, their files must exist, and grounding/ holds nothing else', () => {
  const vignettes = [
    { key: 'set-a--one', template: 'doc', file: 'projects/temp/cases/doc/one.md' },
    { key: 'set-a--two', template: 'doc', file: 'projects/temp/cases/doc/one.md' },
  ];
  const withFile = (root: string, name: string) => {
    fs.mkdirSync(path.join(root, 'projects/temp/grounding'), { recursive: true });
    fs.writeFileSync(path.join(root, 'projects/temp/grounding', name), 'Notes.\n');
    return root;
  };
  const project = (sets: unknown) => ({ app: 'talk', groundingSets: sets,
    cases: { systemPrompt: 'projects/temp/system-prompt.md', vignettes } });
  const ok = withFile(tempProject(project(['set-a'])), 'set-a.md');
  const missing = tempProject(project(['set-a']));
  const unknown = withFile(tempProject(project(['set-b'])), 'set-b.md');
  const stray = withFile(withFile(tempProject(project(['set-a'])), 'set-a.md'), 'set-z.md');
  const undeclared = withFile(tempProject({ app: 'talk' }), 'one.md');
  const malformed = tempProject(project(['set-a.md']));
  const all = [ok, missing, unknown, stray, undeclared, malformed];
  try {
    const r = runValidator(ok);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const r2 = runValidator(missing);
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /missing file: projects\/temp\/grounding\/set-a\.md/);
    const r3 = runValidator(unknown);
    assert.equal(r3.status, 1);
    assert.match(r3.stderr, /"set-b" is no vignette's document set/);
    const r4 = runValidator(stray);
    assert.equal(r4.status, 1);
    assert.match(r4.stderr, /grounding\/set-z\.md: not a declared grounding set's file/);
    const r5 = runValidator(undeclared);
    assert.equal(r5.status, 1);
    assert.match(r5.stderr, /grounding\/one\.md: not a declared/);
    const r6 = runValidator(malformed);
    assert.equal(r6.status, 1);
    assert.match(r6.stderr, /groundingSets\/0 must match pattern/);
  } finally {
    for (const d of all) fs.rmSync(d, { recursive: true, force: true });
  }
});
