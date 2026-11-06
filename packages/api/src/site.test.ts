// Run: npm -w @ai-med/api test   (node:test under tsx)
//
// The platform site the API server serves itself (src/sim/site.ts): the
// simulator pages, the landing page, the global admin page and the npj26 page,
// against the real server.ts on the shared harness. The checkout is a fixture
// tree this test writes: a simulator with a URL alias, a simulator with no
// build, a talk project, and a talk project named decks, which the site host
// serves too (SITE_TALK_PAGES). Requests go out with an explicit Host header,
// the way a custom domain reaches the server behind the Cloudflare Tunnel.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer, type Harness } from '../test-support/server-harness.js';
import { SITE_TALK_PAGES, siteSettings } from './sim/site.js';
import { DEFAULT_SITE_DIST_DIR } from './repo-root.js';

const SITE = 'site.example.test';
const TALK_HOST = 'chat.example.test';
const OTHER = 'api.example.test';

const SIM = 'fixture_sim';          // served at /fixture-sim/, alias fixture-old
const UNBUILT = 'fixture_unbuilt';  // a simulator with no build
const TALK = 'fixture_talk';        // a talk project: redirects to TALK_HOST
const DECKS = 'decks';              // a talk project the site host serves too
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
}

function writeFile(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

/** One request with a chosen Host header; redirects are returned, not followed. */
function get(pathname: string, host = SITE, method = 'GET', headers: Record<string, string> = {}): Promise<Reply> {
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'site-test-'));
  const root = path.join(tmp, 'checkout');
  writeProject(root, SIM, { urlAliases: ['fixture-old'] });
  writeProject(root, UNBUILT, {});
  writeProject(root, TALK, { app: 'talk' });
  writeProject(root, DECKS, { app: 'talk' });

  const site = path.join(tmp, 'dist-site');
  writeBuild(site, 'fixture-sim');
  writeFile(path.join(site, 'index.html'), '<!doctype html><title>landing</title>');
  writeFile(path.join(site, 'admin', 'index.html'), '<!doctype html><title>admin</title>');
  writeFile(path.join(site, 'npj26', 'index.html'), '<!doctype html><title>npj26</title>');
  writeFile(path.join(site, 'projects.json'), '{"projects":[]}');
  writeFile(path.join(site, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

  const talk = path.join(tmp, 'dist-talk');
  writeBuild(talk, 'fixture-talk');
  writeBuild(talk, 'decks');

  h = await startServer({
    root,
    env: {
      SITE_DIST_DIR: site, SITE_HOST: SITE,
      TALK_DIST_DIR: talk, TALK_CANONICAL_HOST: TALK_HOST, TALK_HOME_URL: 'https://home.example.test/',
    },
  });
});

after(async () => {
  await h?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('/ is the landing page, uncached', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.body, /<title>landing<\/title>/);
  assert.equal(r.headers['cache-control'], 'no-cache');
});

test('a simulator serves its index.html, its hashed assets for a year, and its routes as index.html', async () => {
  const page = await get('/fixture-sim/?vignette=x');
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>fixture-sim<\/title>/);
  assert.equal(page.headers['cache-control'], 'no-cache');
  const asset = await get(`/fixture-sim/${ASSET}`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
  const route = await get('/fixture-sim/admin');
  assert.equal(route.status, 200);
  assert.match(route.body, /<title>fixture-sim<\/title>/);
  const missing = await get('/fixture-sim/assets/gone.js');
  assert.equal(missing.status, 404);
  assert.doesNotMatch(String(missing.headers['content-type']), /html/);
});

test('HEAD answers like GET without a body', async () => {
  const r = await get('/fixture-sim/', SITE, 'HEAD');
  assert.equal(r.status, 200);
  assert.equal(r.body, '');
});

test('a slug without its slash, written with _, or an alias redirects under the slug, keeping the query', async () => {
  for (const [from, to] of [
    ['/fixture-sim?lang=fr', '/fixture-sim/?lang=fr'],
    ['/fixture_sim/', '/fixture-sim/'],
    ['/fixture-old/x?y=1', '/fixture-sim/x?y=1'],
  ]) {
    const r = await get(from);
    assert.equal(r.status, 301, from);
    assert.equal(r.headers.location, to, from);
  }
});

test('on any other host a simulator path redirects to the site host', async () => {
  for (const host of [TALK_HOST, OTHER]) {
    const r = await get('/fixture-sim/?vignette=x', host);
    assert.equal(r.status, 301, host);
    assert.equal(r.headers.location, `https://${SITE}/fixture-sim/?vignette=x`, host);
  }
});

test('the admin page and the npj26 page, with a code in the path', async () => {
  const admin = await get('/admin/');
  assert.match(admin.body, /<title>admin<\/title>/);
  const bare = await get('/admin');
  assert.equal(bare.status, 301);
  assert.equal(bare.headers.location, '/admin/');
  for (const p of ['/npj26/', '/npj26/ABC123', '/npj26/ABC123/']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.body, /<title>npj26<\/title>/, p);
  }
});

test('the landing files are served, revalidated', async () => {
  for (const p of ['/projects.json', '/favicon.svg']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers['cache-control'], 'no-cache', p);
  }
});

test('an unknown path goes to the landing page; a missing file is a 404; an unbuilt simulator is a 404', async () => {
  const r = await get('/no-such-project/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/');
  const file = await get('/nothing.png');
  assert.equal(file.status, 404);
  for (const p of ['/fixture-unbuilt/', '/fixture-unbuilt']) {
    const u = await get(p);
    assert.equal(u.status, 404, p);
  }
});

test('decks is served on the site host; any other talk page redirects to the talk host', async () => {
  assert.ok(SITE_TALK_PAGES.includes('decks'));
  const decks = await get('/decks/');
  assert.equal(decks.status, 200);
  assert.match(decks.body, /<title>decks<\/title>/);
  const talk = await get('/fixture-talk/?paper=1');
  assert.equal(talk.status, 301);
  assert.equal(talk.headers.location, `https://${TALK_HOST}/fixture-talk/?paper=1`);
});

test('the site is not served on other hosts, and /api answers everywhere', async () => {
  const landing = await get('/', OTHER);
  assert.equal(landing.status, 404);
  for (const host of [SITE, TALK_HOST, OTHER]) {
    const r = await get('/api/health', host);
    assert.equal(r.status, 200, host);
  }
});

test('settings: the site on every host from the default build unless the variables say otherwise', () => {
  assert.deepEqual(siteSettings({}), { distDir: DEFAULT_SITE_DIST_DIR, host: '' });
  assert.deepEqual(siteSettings({ SITE_DIST_DIR: ' /x/site ', SITE_HOST: ' AI-MED.live ' }), { distDir: '/x/site', host: 'ai-med.live' });
});
