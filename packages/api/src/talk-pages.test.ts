// Run: npm -w @ai-med/api test   (node:test under tsx)
//
// The talk pages the API server serves itself (src/talk/pages.ts), against the
// real server.ts on the shared harness. The checkout is a fixture tree this
// test writes, so it names no real project: two talk projects (one framed by a
// listed host, one with a URL alias), a simulator project, and a talk build
// for each of them, the simulator's included, to show it is never served.
// Requests go out with an explicit Host header, the way a custom domain
// reaches the server behind Railway's proxy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer, type Harness } from '../test-support/server-harness.js';
import { talkHostSummary, talkPagesSettings } from './talk/pages.js';
import { DEFAULT_TALK_DIST_DIR } from './repo-root.js';

const CANONICAL = 'chat.example.test';
const OTHER = 'api.example.test';
const HOME = 'https://home.example.test/';
const FRAMER = 'https://deck-host.example.test';

const TALK = 'fixture_talk';       // served at /fixture-talk/, alias fixture-old
const DECK = 'fixture_deck';       // served at /fixture-deck/, framed by FRAMER only
const SIM = 'fixture_sim';         // a simulator: never served here
const ASSET = 'assets/index-abc123.js';

let h: Harness;
let tmp = '';

function writeProject(root: string, name: string, extra: Record<string, unknown>): void {
  const dir = path.join(root, 'projects', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    name, displayName: name, frontend: 'chat',
    cases: { systemPrompt: '', vignettes: [] }, languages: ['en'],
    deployment: { tablePrefix: name },
    ...extra,
  }, null, 2));
}

function writeBuild(dist: string, slug: string): void {
  const dir = path.join(dist, slug);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><title>${slug}</title><script src="/${slug}/${ASSET}"></script>`);
  fs.writeFileSync(path.join(dir, ASSET), `console.log(${JSON.stringify(slug)})`);
  fs.writeFileSync(path.join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
}

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

/** One request with a chosen Host header; redirects are returned, not followed. */
function get(pathname: string, host = CANONICAL, method = 'GET', headers: Record<string, string> = {}): Promise<Reply> {
  const { port } = new URL(h.base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { Host: host, ...headers } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'talk-pages-test-'));
  const root = path.join(tmp, 'checkout');
  writeProject(root, TALK, { app: 'talk', urlAliases: ['fixture-old'] });
  writeProject(root, DECK, { app: 'talk', followHost: true, embedOrigins: [FRAMER] });
  writeProject(root, SIM, {});
  const dist = path.join(tmp, 'dist-talk');
  for (const slug of ['fixture-talk', 'fixture-deck', 'fixture-sim']) writeBuild(dist, slug);
  h = await startServer({
    root,
    env: { TALK_DIST_DIR: dist, TALK_CANONICAL_HOST: CANONICAL, TALK_HOME_URL: HOME },
  });
});

after(async () => {
  await h?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('each talk project serves its index.html at /<slug>/, uncached', async () => {
  for (const slug of ['fixture-talk', 'fixture-deck']) {
    const r = await get(`/${slug}/`);
    assert.equal(r.status, 200, slug);
    assert.match(String(r.headers['content-type']), /text\/html/);
    assert.match(r.body, new RegExp(`<title>${slug}</title>`));
    assert.equal(r.headers['cache-control'], 'no-cache');
  }
});

test('/<slug> without the slash redirects to /<slug>/, keeping the query', async () => {
  const r = await get('/fixture-talk?paper=10.1000%2Fx');
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, '/fixture-talk/?paper=10.1000%2Fx');
});

test('hashed assets are cached for a year; other files revalidate', async () => {
  const a = await get(`/fixture-talk/${ASSET}`);
  assert.equal(a.status, 200);
  assert.equal(a.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.match(a.body, /fixture-talk/);
  const f = await get('/fixture-talk/favicon.svg');
  assert.equal(f.status, 200);
  assert.equal(f.headers['cache-control'], 'no-cache');
});

test('a route inside the page falls back to index.html; a missing file is a 404, not HTML', async () => {
  const r = await get('/fixture-talk/some/deep/route?x=1');
  assert.equal(r.status, 200);
  assert.match(r.body, /<title>fixture-talk<\/title>/);
  assert.equal(r.headers['cache-control'], 'no-cache');
  const missing = await get('/fixture-talk/assets/gone-000000.js');
  assert.equal(missing.status, 404);
  assert.doesNotMatch(missing.body, /<title>/);
});

test('HEAD answers like GET without a body', async () => {
  const r = await get('/fixture-talk/', CANONICAL, 'HEAD');
  assert.equal(r.status, 200);
  assert.equal(r.body, '');
});

test('a URL alias redirects to the same path under the project slug', async () => {
  const r = await get('/fixture-old/x?y=1');
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, '/fixture-talk/x?y=1');
  const bare = await get('/fixture-old');
  assert.equal(bare.status, 301);
  assert.equal(bare.headers.location, '/fixture-talk/');
});

test('on any other host a talk path redirects to the canonical host', async () => {
  const r = await get('/fixture-talk/?paper=1', OTHER);
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, `https://${CANONICAL}/fixture-talk/?paper=1`);
  const alias = await get('/fixture-old/', OTHER);
  assert.equal(alias.status, 301);
  assert.equal(alias.headers.location, `https://${CANONICAL}/fixture-talk/`);
});

test('/ on the canonical host redirects home; elsewhere it is left alone', async () => {
  const r = await get('/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, HOME);
  const other = await get('/', OTHER);
  assert.equal(other.status, 404);
});

test('/api answers on every host, unredirected', async () => {
  for (const host of [CANONICAL, OTHER]) {
    const r = await get('/api/health', host);
    assert.equal(r.status, 200, host);
    assert.equal(JSON.parse(r.body).status, 'ok');
    const c = await get('/api/config', host, 'GET', { 'X-Project': TALK });
    assert.equal(c.status, 200, host);
    assert.equal(JSON.parse(c.body).app, 'talk');
  }
});

test('an unknown slug and a simulator slug are 404 on every host, even with a build present', async () => {
  for (const host of [CANONICAL, OTHER]) {
    for (const p of ['/no-such-project/', '/fixture-sim/', '/fixture-sim', `/fixture-sim/${ASSET}`]) {
      const r = await get(p, host);
      assert.equal(r.status, 404, `${host}${p}`);
      assert.equal(r.headers.location, undefined, `${host}${p}`);
    }
  }
});

test('frame-ancestors is sent for a project that lists embedOrigins, and only for it', async () => {
  const deck = await get('/fixture-deck/');
  assert.equal(deck.headers['content-security-policy'], `frame-ancestors 'self' ${FRAMER}`);
  const deckRoute = await get('/fixture-deck/slide/3');
  assert.equal(deckRoute.headers['content-security-policy'], `frame-ancestors 'self' ${FRAMER}`);
  const talk = await get('/fixture-talk/');
  assert.equal(talk.headers['content-security-policy'], undefined);
  assert.equal(talk.headers['x-frame-options'], undefined);
});

test('settings: no canonical host and no home URL unless the variables set them, in any NODE_ENV', () => {
  assert.deepEqual(talkPagesSettings({ NODE_ENV: 'production' }),
    { distDir: DEFAULT_TALK_DIST_DIR, canonicalHost: '', homeUrl: '' });
  assert.equal(talkPagesSettings({ NODE_ENV: 'development' }).canonicalHost, '');
  assert.equal(talkPagesSettings({}).canonicalHost, '');
  assert.equal(talkPagesSettings({ NODE_ENV: 'production', TALK_CANONICAL_HOST: '' }).canonicalHost, '');
  assert.equal(talkPagesSettings({ TALK_CANONICAL_HOST: ' Chat.Example.TEST ' }).canonicalHost, 'chat.example.test');
  assert.equal(talkPagesSettings({ NODE_ENV: 'production', TALK_HOME_URL: ' https://www.example.test/ ' }).homeUrl, 'https://www.example.test/');
  assert.equal(talkPagesSettings({ TALK_HOME_URL: '' }).homeUrl, '');
  assert.equal(talkPagesSettings({ TALK_DIST_DIR: '/x/y' }).distDir, path.resolve('/x/y'));
  assert.equal(path.basename(DEFAULT_TALK_DIST_DIR), 'dist-talk');
  assert.equal(path.basename(path.dirname(DEFAULT_TALK_DIST_DIR)), 'frontend-chat');
});

test('the boot log says which host settings are in force', () => {
  const off = talkHostSummary({ canonicalHost: '', homeUrl: '' });
  assert.match(off, /no canonical host \(TALK_CANONICAL_HOST unset\)/);
  assert.match(talkHostSummary({ canonicalHost: '', homeUrl: HOME }), /TALK_HOME_URL ignored/);
  const on = talkHostSummary({ canonicalHost: CANONICAL, homeUrl: HOME });
  assert.ok(on.includes(`canonical host ${CANONICAL} (TALK_CANONICAL_HOST)`), on);
  assert.ok(on.includes(`redirects to ${HOME} (TALK_HOME_URL)`), on);
  assert.match(talkHostSummary({ canonicalHost: CANONICAL, homeUrl: '' }), /left alone \(TALK_HOME_URL unset\)/);
});
