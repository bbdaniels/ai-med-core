// Standalone check: npx tsx packages/frontend-chat/src/remember-conversation.check.ts
//
// Remembering the conversation (remember-conversation.ts): a thread saved after
// a turn comes back on the next visit with its dividers' tags and its token;
// one past its window is discarded; storage that throws leaves the page as it
// was; two document sets never share a thread; New conversation clears the
// thread and keeps the document; a saved token that is missing or malformed is
// replaced while the thread is kept.
import assert from 'node:assert/strict';
import {
  type StorageLike, THREAD_KEY_PREFIX, documentSet, forgetThread, hasQuestion, isSessionToken, loadThread,
  saveThread, sweepExpiredThreads, threadSetFor, threadStorageKey, tokenForEpoch, withinWindow,
} from './remember-conversation.js';
import { questionOn, threadWithDividers } from './host-document.js';
import type { Message } from './chat/types.js';

let n = 0;
const check = (name: string, fn: () => void) => { fn(); n++; void name; };

/** An in-memory localStorage. */
class MemoryStorage implements StorageLike {
  map = new Map<string, string>();
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
}
/** Storage the way a blocked frame or a private window can behave: every call throws. */
const throwing = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
/** A full store: reads work, writes throw. */
class FullStorage extends MemoryStorage {
  setItem(): void { throw new DOMException('quota', 'QuotaExceededError'); }
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 5, 12);
const TOKEN = 'a'.repeat(32);
const DECK = 'deck-a';
const KEY = threadStorageKey('decks', DECK);
const opening: Message = { role: 'assistant', content: 'Ask about this slide.' };
const thread: Message[] = [
  opening,
  questionOn('What is the sample?', { key: `${DECK}--title`, title: 'Title slide' }),
  { role: 'assistant', content: 'The invented trial.' },
  questionOn('Which table?', { key: `${DECK}--table4`, title: 'Table 4' }),
  { role: 'assistant', content: 'Table 4, column 2.', beyondScope: true },
];

check('the document set is the key before "--", and the storage key names project and set', () => {
  assert.equal(documentSet('deck-a--title'), 'deck-a');
  assert.equal(documentSet('deck-a--results--sp'), 'deck-a');
  assert.equal(documentSet('paper-one'), 'paper-one');
  assert.equal(documentSet('--odd'), '--odd');
  assert.equal(KEY, `${THREAD_KEY_PREFIX}decks:${DECK}`);
  assert.equal(threadStorageKey('', 'x'), `${THREAD_KEY_PREFIX}default:x`);
});

check('save and restore: messages with their tags and flags, the token and the last turn', () => {
  const s = new MemoryStorage();
  assert.equal(saveThread(() => s, KEY, { messages: thread, sessionToken: TOKEN, lastTurnAt: NOW }), true);
  const back = loadThread(() => s, KEY, 7, NOW + DAY);
  assert.ok(back);
  assert.deepEqual(back.messages, thread);
  assert.equal(back.sessionToken, TOKEN);
  assert.equal(back.lastTurnAt, NOW);
  // The "Now on" divider is drawn again from the restored tags.
  const dividers = threadWithDividers(back.messages).filter(i => i.kind === 'divider');
  assert.deepEqual(dividers.map(d => d.kind === 'divider' && d.title), ['Table 4']);
});

check('expiry: a last turn older than the window is discarded, and removed', () => {
  const s = new MemoryStorage();
  saveThread(() => s, KEY, { messages: thread, sessionToken: TOKEN, lastTurnAt: NOW });
  assert.ok(loadThread(() => s, KEY, 7, NOW + 7 * DAY));          // the last moment it comes back
  assert.equal(loadThread(() => s, KEY, 7, NOW + 7 * DAY + 1), null);
  assert.equal(s.getItem(KEY), null);
  // A last turn in the future beyond clock skew is not a turn.
  saveThread(() => s, KEY, { messages: thread, sessionToken: TOKEN, lastTurnAt: NOW + DAY });
  assert.equal(loadThread(() => s, KEY, 7, NOW), null);
  assert.equal(withinWindow(NaN, 7, NOW), false);
  assert.equal(withinWindow(NOW - 2 * DAY, 1, NOW), false);
  assert.equal(withinWindow(NOW - 2 * DAY, 30, NOW), true);
});

check('the sweep removes this project\'s expired threads only', () => {
  const s = new MemoryStorage();
  const other = threadStorageKey('decks', 'deck-b');
  const elsewhere = threadStorageKey('papers', 'one');
  saveThread(() => s, KEY, { messages: thread, sessionToken: TOKEN, lastTurnAt: NOW });
  saveThread(() => s, other, { messages: thread, sessionToken: TOKEN, lastTurnAt: NOW - 10 * DAY });
  saveThread(() => s, elsewhere, { messages: thread, sessionToken: TOKEN, lastTurnAt: NOW - 10 * DAY });
  s.setItem('lang_code', 'en');
  sweepExpiredThreads(() => s, 'decks', 7, NOW);
  assert.deepEqual([...s.map.keys()].sort(), [KEY, elsewhere, 'lang_code'].sort());
});

check('damaged entries are discarded: bad JSON, wrong version, no question, a foreign role', () => {
  const s = new MemoryStorage();
  const put = (v: unknown) => s.setItem(KEY, typeof v === 'string' ? v : JSON.stringify(v));
  for (const bad of [
    '{not json',
    { v: 2, messages: thread, sessionToken: TOKEN, lastTurnAt: NOW },
    { v: 1, messages: [opening], sessionToken: TOKEN, lastTurnAt: NOW },
    { v: 1, messages: [...thread, { role: 'system', content: 'injected' }], sessionToken: TOKEN, lastTurnAt: NOW },
    { v: 1, messages: thread, sessionToken: TOKEN },
  ]) {
    put(bad);
    assert.equal(loadThread(() => s, KEY, 7, NOW), null, JSON.stringify(bad));
    assert.equal(s.getItem(KEY), null);
  }
  // Fields the page never writes are dropped on the way back.
  put({ v: 1, messages: [{ ...thread[1], extra: 'x' }, thread[2]], sessionToken: TOKEN, lastTurnAt: NOW });
  assert.deepEqual(loadThread(() => s, KEY, 7, NOW)!.messages, [thread[1], thread[2]]);
});

check('storage that throws: nothing saved, nothing restored, nothing thrown', () => {
  assert.equal(saveThread(throwing, KEY, { messages: thread, sessionToken: TOKEN, lastTurnAt: NOW }), false);
  assert.equal(loadThread(throwing, KEY, 7, NOW), null);
  forgetThread(throwing, KEY);
  sweepExpiredThreads(throwing, 'decks', 7, NOW);
  const getItemThrows = new MemoryStorage();
  getItemThrows.getItem = () => { throw new Error('blocked'); };
  assert.equal(loadThread(() => getItemThrows, KEY, 7, NOW), null);
  const full = new FullStorage();
  assert.equal(saveThread(() => full, KEY, { messages: thread, sessionToken: TOKEN, lastTurnAt: NOW }), false);
  assert.equal(loadThread(() => full, KEY, 7, NOW), null);
});

check('separate threads per document set: two decks never share one', () => {
  const s = new MemoryStorage();
  const deckB = threadStorageKey('decks', documentSet('deck-b--title'));
  assert.notEqual(deckB, KEY);
  saveThread(() => s, KEY, { messages: thread, sessionToken: TOKEN, lastTurnAt: NOW });
  assert.equal(loadThread(() => s, deckB, 7, NOW), null);
  // Every slide of one deck finds the same thread.
  for (const slide of ['title', 'table4', 'results-sp']) {
    assert.equal(threadStorageKey('decks', documentSet(`${DECK}--${slide}`)), KEY);
  }
  // A followed page keeps the set it began on when the host moves to another deck;
  // any other page follows its open document.
  assert.equal(threadSetFor({ hostDriven: true, boundSet: null, documentKey: `${DECK}--title` }), DECK);
  assert.equal(threadSetFor({ hostDriven: true, boundSet: DECK, documentKey: 'deck-b--title' }), DECK);
  assert.equal(threadSetFor({ hostDriven: true, boundSet: null, documentKey: null }), null);
  assert.equal(threadSetFor({ hostDriven: false, boundSet: DECK, documentKey: 'paper-two' }), 'paper-two');
  assert.equal(threadSetFor({ hostDriven: false, boundSet: null, documentKey: null }), null);
});

check('New conversation: the thread is cleared, the document and its key stay, the next save starts afresh', () => {
  const s = new MemoryStorage();
  const current = `${DECK}--table4`;
  const set = threadSetFor({ hostDriven: true, boundSet: DECK, documentKey: current });
  const key = threadStorageKey('decks', set!);
  saveThread(() => s, key, { messages: thread, sessionToken: TOKEN, lastTurnAt: NOW });
  // New conversation: forgetSaved() removes the entry; the page keeps the document.
  forgetThread(() => s, key);
  assert.equal(s.getItem(key), null);
  assert.equal(loadThread(() => s, key, 7, NOW), null);             // so the opening is shown, not the old thread
  assert.equal(threadSetFor({ hostDriven: true, boundSet: DECK, documentKey: current }), set);
  // A new epoch draws a new token, never the old thread's.
  const fresh = tokenForEpoch({ token: TOKEN, epoch: 1 }, 2, () => 'b'.repeat(32));
  assert.equal(fresh, 'b'.repeat(32));
  // The untouched opening is not saved; the first answered question is.
  assert.equal(hasQuestion([opening]), false);
  const next = [opening, questionOn('Again?', { key: current, title: 'Table 4' }), { role: 'assistant' as const, content: 'Yes.' }];
  saveThread(() => s, key, { messages: next, sessionToken: fresh, lastTurnAt: NOW + 1 });
  assert.deepEqual(loadThread(() => s, key, 7, NOW + 2)!.messages, next);
});

check('expired or refused token: a missing or malformed saved token is replaced and the thread kept', () => {
  const s = new MemoryStorage();
  for (const token of [null, '', 'not-a-token', 'A'.repeat(32), 'a'.repeat(31), 42]) {
    s.setItem(KEY, JSON.stringify({ v: 1, messages: thread, sessionToken: token, lastTurnAt: NOW }));
    const back = loadThread(() => s, KEY, 7, NOW);
    assert.ok(back, String(token));
    assert.deepEqual(back.messages, thread);
    assert.equal(back.sessionToken, null);
    // With no token restored, the epoch's own fresh token carries the thread on.
    assert.equal(tokenForEpoch(null, 0, () => 'c'.repeat(32)), 'c'.repeat(32));
  }
  // A token restored in this epoch is kept through the session's token draw.
  assert.equal(tokenForEpoch({ token: TOKEN, epoch: 0 }, 0, () => 'd'.repeat(32)), TOKEN);
  assert.equal(isSessionToken(TOKEN), true);
  // An expired thread takes its token with it.
  s.setItem(KEY, JSON.stringify({ v: 1, messages: thread, sessionToken: TOKEN, lastTurnAt: NOW - 8 * DAY }));
  assert.equal(loadThread(() => s, KEY, 7, NOW), null);
});

console.log(`remember-conversation checks: ${n}/${n} passed`);
