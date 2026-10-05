// Standalone check: npx tsx packages/frontend-chat/src/host-document.check.ts
//
// Following a host page (host-document.ts): which messages the page obeys,
// that a switch never clears the conversation, the "Now on" divider and its
// collapse, that a document-less page blocks sending, and the ready message.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOST_DOCUMENT_MESSAGE, TALK_READY_MESSAGE, acceptHostDocument, currentDocument, listenForHostDocument,
  postTalkReady, questionOn, questionsBlocked, threadWithDividers,
} from './host-document.js';

let n = 0;
const check = (name: string, fn: () => void) => { fn(); n++; void name; };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'https://host.example';
const self = { name: 'talk page' };
const parent = { name: 'host page' };
const ctx = { followHost: true, embedOrigins: [ORIGIN, 'http://localhost:8770'], self, parent };
const doc = (key: unknown, title: unknown = 'T') => ({ type: HOST_DOCUMENT_MESSAGE, key, title });
const from = (data: unknown, over: Partial<{ source: unknown; origin: string }> = {}) => ({ source: parent, origin: ORIGIN, data, ...over });

check('origin and source: only the parent, only a listed origin, only with followHost, only framed', () => {
  assert.deepEqual(acceptHostDocument(from(doc('k1', 'Slide one')), ctx), { key: 'k1', title: 'Slide one' });
  assert.deepEqual(acceptHostDocument(from(doc('k1'), { origin: 'http://localhost:8770' }), ctx), { key: 'k1', title: 'T' });
  // another origin, a look-alike, a trailing slash, and a missing origin
  for (const origin of ['https://evil.example', 'https://host.example.evil.example', 'https://host.example/', 'null', '']) {
    assert.equal(acceptHostDocument(from(doc('k1'), { origin }), ctx), null, origin);
  }
  // any window but the parent: the page itself, a sibling frame, an opener
  for (const source of [self, { name: 'sibling' }, null]) {
    assert.equal(acceptHostDocument(from(doc('k1'), { source }), ctx), null);
  }
  // the project does not follow a host
  assert.equal(acceptHostDocument(from(doc('k1')), { ...ctx, followHost: false }), null);
  // not framed: the parent is the page itself, so even its own message is ignored
  assert.equal(acceptHostDocument(from(doc('k1'), { source: self }), { ...ctx, parent: self }), null);
  // no origins listed: nothing is obeyed
  assert.equal(acceptHostDocument(from(doc('k1')), { ...ctx, embedOrigins: [] }), null);
});

check('the message itself: its type, a key or null, a title kept as text', () => {
  assert.equal(acceptHostDocument(from({ type: 'orcid-display:talk-close' }), ctx), null);
  assert.equal(acceptHostDocument(from('host:document'), ctx), null);
  assert.equal(acceptHostDocument(from(null), ctx), null);
  assert.deepEqual(acceptHostDocument(from(doc(null, 'Title slide')), ctx), { key: null, title: 'Title slide' });
  assert.deepEqual(acceptHostDocument(from(doc('', 'Blank')), ctx), { key: null, title: 'Blank' });
  for (const key of [3, {}, ['k1'], undefined, 'x'.repeat(201)]) assert.equal(acceptHostDocument(from(doc(key)), ctx), null);
  assert.deepEqual(acceptHostDocument(from(doc('k1', 7)), ctx), { key: 'k1', title: '' });
  assert.equal(acceptHostDocument(from(doc('k1', ` ${'t'.repeat(400)} `)), ctx)!.title.length, 300);
});

check('the listener: obeys its parent, ignores the rest, and tears down', () => {
  const target = new EventTarget() as EventTarget & { parent: unknown };
  target.parent = parent;
  const got: unknown[] = [];
  const fire = (data: unknown, source: unknown = parent, origin = ORIGIN) => {
    const ev = new Event('message') as Event & Record<string, unknown>;
    Object.assign(ev, { data, source, origin });
    target.dispatchEvent(ev);
  };
  const stop = listenForHostDocument(target as any, ctx, d => got.push(d));
  fire(doc('k1', 'One'));
  fire(doc('k2', 'Two'), parent, 'https://evil.example');
  fire(doc('k3', 'Three'), { name: 'sibling' });
  fire(doc(null, 'Title'));
  assert.deepEqual(got, [{ key: 'k1', title: 'One' }, { key: null, title: 'Title' }]);
  stop();
  fire(doc('k4'));
  assert.equal(got.length, 2);
});

check('the ready message: once framed, to the parent, carrying nothing; never top-level', () => {
  const posted: Array<[unknown, string]> = [];
  const framed = { parent: { postMessage: (m: unknown, o: string) => { posted.push([m, o]); } } };
  assert.equal(postTalkReady(framed), true);
  assert.deepEqual(posted, [[{ type: TALK_READY_MESSAGE }, '*']]);
  const top: { parent: unknown } = { parent: null };
  top.parent = top;
  assert.equal(postTalkReady(top as any), false);
  assert.equal(postTalkReady({ parent: { postMessage: () => { throw new Error('detached'); } } }), false);
});

const known = ['k1', 'k2', 'k3'];
const titles: Record<string, string> = { k1: 'Own title one' };
const titleOf = (k: string) => titles[k];

check('the current document: the host wins, the list decides, titles fall back', () => {
  assert.equal(currentDocument(null, null, known, titleOf), null);
  // the link, until the host speaks; its own title
  assert.deepEqual(currentDocument(null, 'k1', known, titleOf), { key: 'k1', title: 'Own title one' });
  // the host's word, with its title
  assert.deepEqual(currentDocument({ key: 'k2', title: 'Slide two' }, 'k1', known, titleOf), { key: 'k2', title: 'Slide two' });
  // no title from the host: the document's own, else the key
  assert.deepEqual(currentDocument({ key: 'k3', title: '' }, null, known, titleOf), { key: 'k3', title: 'k3' });
  // null: nothing here; unknown: the same; list not loaded yet: nothing yet
  assert.deepEqual(currentDocument({ key: null, title: 'Title slide' }, 'k1', known, titleOf), { key: null, title: 'Title slide' });
  assert.deepEqual(currentDocument({ key: 'k9', title: 'No pack' }, 'k1', known, titleOf), { key: null, title: 'No pack' });
  assert.deepEqual(currentDocument({ key: 'k1', title: 'One' }, null, null, titleOf), { key: null, title: 'One' });
});

check('a null or unknown key blocks sending; a known one, or a page that does not follow a host, never does', () => {
  const blocked = (host: { key: string | null; title: string }, hostDriven = true) =>
    questionsBlocked({ hostDriven, listLoaded: true, key: currentDocument(host, null, known, titleOf)!.key });
  assert.equal(blocked({ key: null, title: 'Title slide' }), true);
  assert.equal(blocked({ key: 'k9', title: 'No pack' }), true);
  assert.equal(blocked({ key: 'k2', title: 'Slide two' }), false);
  assert.equal(questionsBlocked({ hostDriven: false, listLoaded: true, key: null }), false);
  // while the list is loading the page says nothing yet
  assert.equal(questionsBlocked({ hostDriven: true, listLoaded: false, key: null }), false);
});

check('switching never clears the conversation; dividers only where a question changes document, collapsed', () => {
  // A session as the page runs it: the host pages through documents, the
  // reader asks now and then. Only asking adds to the thread.
  type M = { role: 'user' | 'assistant'; content: string; documentKey?: string; documentTitle?: string };
  let messages: M[] = [{ role: 'assistant', content: 'Opening.' }];
  let current = currentDocument(null, 'k1', known, titleOf);
  const host = (key: string | null, title: string) => { current = currentDocument({ key, title }, 'k1', known, titleOf); };
  const askNow = (q: string) => {
    if (questionsBlocked({ hostDriven: true, listLoaded: true, key: current!.key })) return false;
    messages = [...messages, questionOn(q, { key: current!.key!, title: current!.title }), { role: 'assistant', content: `A: ${q}` }];
    return true;
  };
  assert.ok(askNow('First?'));                       // on k1, the link's document
  const afterFirst = messages;
  for (let i = 0; i < 20; i++) host(i % 2 ? 'k2' : 'k3', `Slide ${i}`);   // twenty slides, no question
  host(null, 'Title slide');
  assert.equal(askNow('Here?'), false);              // blocked, and nothing added
  assert.equal(messages, afterFirst);                // the same thread, untouched by any switch
  host('k2', 'Slide two');
  assert.ok(askNow('Second?'));
  assert.ok(askNow('Third?'));                       // same document: no divider
  host('k3', 'Slide three');
  host('k1', 'Slide one');                           // passed through k3 without asking
  assert.ok(askNow('Fourth?'));
  assert.equal(messages.length, 9);

  const items = threadWithDividers(messages);
  const dividers = items.filter(i => i.kind === 'divider');
  assert.deepEqual(dividers.map(d => d.kind === 'divider' && [d.key, d.title]), [['k2', 'Slide two'], ['k1', 'Slide one']]);
  // each divider sits right before the question that moved
  for (const d of dividers) {
    const next = items[items.indexOf(d) + 1];
    assert.ok(next.kind === 'message' && next.message.role === 'user' && next.message.documentKey === (d.kind === 'divider' && d.key));
  }
  // every message is shown, in order
  assert.deepEqual(items.filter(i => i.kind === 'message').map(i => i.kind === 'message' && i.index), [...messages.keys()]);
  // untagged messages (a page that does not follow a host) never get one
  assert.equal(threadWithDividers([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }]).length, 2);
});

check('nothing in the page clears the conversation when the document changes', () => {
  // The thread is cleared only by reset(), and the talk page calls reset()
  // only from the paper picker (openPaper) and the reader's own New
  // conversation (newConversation), never on a host's switch.
  const session = fs.readFileSync(path.join(HERE, 'chat/useChatSession.ts'), 'utf8');
  const clears = session.split('\n').filter(l => /setMessages\(\[\]\)/.test(l));
  assert.equal(clears.length, 1);
  assert.match(session, /const reset = \(\) => \{\n\s+setMessages\(\[\]\);/);
  const talk = fs.readFileSync(path.join(HERE, 'talk/TalkApp.tsx'), 'utf8');
  assert.equal(talk.match(/session\.reset\(\)/g)?.length, 2);
  assert.match(talk, /const openPaper = \(key: string \| null\) => \{\n\s+if \(!deepLink\.openPaper\(key\)\) return;\n\s+session\.reset\(\);/);
  assert.match(talk, /const newConversation = \(\) => \{[^}]*\}\n\s+setConfirmingNew\(false\);\n\s+session\.forgetSaved\(\);\n\s+session\.reset\(\);/);
});

console.log(`host-document checks: ${n}/${n} passed`);
