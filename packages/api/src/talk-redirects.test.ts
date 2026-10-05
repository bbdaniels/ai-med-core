// Run: npm -w @ai-med/api test   (node:test under tsx)
//
// tools/build-talk-redirects.ts: the stubs and the 404 page a static site
// keeps at its old talk paths. The checkout is a fixture tree this test
// writes, so it names no real project, and the pages' own scripts are run
// against a fake location, so what is checked is where a reader lands.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { page404, stubHtml, talkProjects, talkRedirects } from '../../../tools/build-talk-redirects.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const TO = 'https://chat.example.test';
// landing/ is the private repo's Pages site and is not in the public mirror,
// so the tests that run its 404 page are skipped there.
const PAGE_404 = path.join(REPO, 'landing/404.html');
const NO_LANDING = !fs.existsSync(PAGE_404) && 'landing/404.html is not in this tree';
let root: string;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'talk-redirects-'));
  const project = (dir: string, cfg: Record<string, unknown>) => {
    fs.mkdirSync(path.join(root, 'projects', dir), { recursive: true });
    fs.writeFileSync(path.join(root, 'projects', dir, 'project.json'), JSON.stringify(cfg));
  };
  project('fixture_talk', { app: 'talk', urlAliases: ['old-name'] });
  project('fixture_kept', { app: 'talk' });
  project('fixture_sim', {});
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

/** Run a page's inline scripts with this location; return where it was sent. */
function landing(html: string, href: string, storage: Record<string, string> = {}): string | null {
  const url = new URL(href);
  let sent: string | null = null;
  const location = {
    pathname: url.pathname, search: url.search, hash: url.hash,
    replace: (to: string) => { sent = to; },
  };
  const sessionStorage = {
    getItem: (k: string) => storage[k] ?? null,
    setItem: (k: string, v: string) => { storage[k] = v; },
    removeItem: (k: string) => { delete storage[k]; },
  };
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(scripts.length > 0, 'the page has an inline script');
  const context = vm.createContext({ location, window: { location }, sessionStorage, Date });
  for (const s of scripts) vm.runInContext(s, context);
  return sent;
}

test('the map: every talk project not kept, and its aliases, to its URL slug; simulators never', () => {
  assert.deepEqual(talkProjects(root), ['fixture_kept', 'fixture_talk']);
  assert.deepEqual(talkRedirects(TO, ['fixture_kept'], root),
    { to: TO, slugs: { 'fixture-talk': 'fixture-talk', 'old-name': 'fixture-talk' } });
  assert.deepEqual(Object.keys(talkRedirects(`${TO}/`, [], root).slugs).sort(), ['fixture-kept', 'fixture-talk', 'old-name']);
  assert.throws(() => talkRedirects(TO, ['fixture_sim'], root), /not talk projects: fixture_sim/);
  assert.throws(() => talkRedirects(`${TO}/x`, [], root), /no path/);
  assert.throws(() => talkRedirects('ftp://x.test', [], root), /http/);
});

test('a stub sends the reader to the same path, query and fragment on the talk host', () => {
  const stub = stubHtml(TO, 'fixture-talk');
  assert.equal(landing(stub, 'https://pages.test/fixture-talk/?paper=10.1/x#y'), `${TO}/fixture-talk/?paper=10.1/x#y`);
  assert.equal(landing(stub, 'https://pages.test/fixture-talk/#code=Z'), `${TO}/fixture-talk/#code=Z`);
  assert.equal(landing(stub, 'https://pages.test/fixture-talk/index.html?lang=vi'), `${TO}/fixture-talk/index.html?lang=vi`);
  assert.match(stub, /<noscript>.*href="https:\/\/chat\.example\.test\/fixture-talk\/"/s);
});

test('404.html: deeper talk paths and aliases go to the talk host; everything else is the old SPA redirect', { skip: NO_LANDING }, () => {
  const template = fs.readFileSync(PAGE_404, 'utf8');
  const page = page404(template, talkRedirects(TO, ['fixture_kept'], root));
  assert.equal(landing(page, 'https://pages.test/fixture-talk/deeper/path?q=1#f'), `${TO}/fixture-talk/deeper/path?q=1#f`);
  assert.equal(landing(page, 'https://pages.test/old-name/'), `${TO}/fixture-talk/`);
  assert.equal(landing(page, 'https://pages.test/old-name?lang=vi'), `${TO}/fixture-talk/?lang=vi`);
  assert.equal(landing(page, 'https://pages.test/old-name/x#h'), `${TO}/fixture-talk/x#h`);
  assert.equal(landing(page, 'https://pages.test/fixture_talk/x'), `${TO}/fixture-talk/x`);
  // A kept talk build and a simulator stay on the site, by the SPA redirect.
  const kept: Record<string, string> = {};
  assert.equal(landing(page, 'https://pages.test/fixture-kept/slide/3', kept), '/fixture-kept/');
  assert.equal(kept['spa-redirect'], 'slide/3');
  assert.equal(landing(page, 'https://pages.test/fixture_sim/admin'), '/fixture-sim/');
  assert.equal(landing(page, 'https://pages.test/'), '/');
  // The template served unfilled redirects nothing to a talk host.
  assert.equal(landing(template, 'https://pages.test/fixture-talk/x'), '/fixture-talk/');
  assert.equal(landing(template, 'https://pages.test/stitch/'), '/stitch/', 'no hand-kept alias map is left');
  assert.throws(() => page404('<html></html>', { to: TO, slugs: {} }), /marker/);
});

test('the CLI writes a stub per redirected project and the 404 page, and leaves a kept build alone', { skip: NO_LANDING }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'talk-redirects-out-'));
  try {
    fs.mkdirSync(path.join(out, 'fixture-kept'));
    fs.writeFileSync(path.join(out, 'fixture-kept', 'index.html'), 'BUILD');
    const tsx = path.join(REPO, 'node_modules/.bin/tsx');
    const run = (...extra: string[]) => spawnSync(tsx, [path.join(REPO, 'tools/build-talk-redirects.ts'),
      '--out', out, '--page-404', PAGE_404, ...extra],
      { encoding: 'utf8', env: { ...process.env, AI_MED_REPO_ROOT: root } });
    const noHost = run('--keep', 'fixture_kept');
    assert.notEqual(noHost.status, 0, 'a host is required');
    assert.match(noHost.stderr, /--to <origin>/);
    const r = run('--to', TO, '--keep', 'fixture_kept');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(path.join(out, 'fixture-kept', 'index.html'), 'utf8'), 'BUILD');
    assert.equal(landing(fs.readFileSync(path.join(out, 'fixture-talk', 'index.html'), 'utf8'),
      'https://pages.test/fixture-talk/?a=1'), `${TO}/fixture-talk/?a=1`);
    assert.equal(fs.existsSync(path.join(out, 'old-name')), false, 'an alias has no stub of its own; 404.html sends it');
    assert.equal(landing(fs.readFileSync(path.join(out, '404.html'), 'utf8'), 'https://pages.test/old-name/'), `${TO}/fixture-talk/`);
    fs.rmSync(path.join(out, 'fixture-kept'), { recursive: true });
    const missing = run('--to', TO, '--keep', 'fixture_kept');
    assert.notEqual(missing.status, 0, 'a kept project must already be built');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
