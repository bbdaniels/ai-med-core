// Remembering the conversation (project.json rememberConversation): the talk
// page keeps the visible thread in this browser's localStorage and brings it
// back on the next visit, for up to `days` days after the last turn. Nothing is
// kept on the server; the server never held a conversation (the page sends the
// whole history with every turn), so a restored thread simply carries on.
//
// What is saved, one entry per project and document set:
//   - the messages as shown, with their followHost tags (documentKey,
//     documentTitle), from which the "Now on" dividers are drawn again;
//   - the session token, the page-minted key that groups the conversation's
//     rows in the server's logs (it is never verified, so it cannot expire);
//   - the time of the last turn, which decides whether the thread comes back.
// The access token is not here: it stays where it always was (api-base.ts).
//
// Storage can throw or read back empty: a private window, Safari's tracking
// prevention, a partitioned third-party frame. Every access is try/caught, and
// the page then behaves as it did before this existed. Pure apart from the
// storage it is handed, so it is checked without a browser
// (src/remember-conversation.check.ts).

import type { Message } from './chat/types';
import { documentSet } from '@ai-med/chat-core/document-set';

export const THREAD_KEY_PREFIX = 'talk_thread:';
const DAY_MS = 24 * 60 * 60 * 1000;
/** A last turn this far in the future is a clock that moved, not a turn; more than that is a forgery. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** The part of localStorage used here. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}
/** Handed as a getter, because merely reading window.localStorage can throw. */
export type GetStorage = () => StorageLike;

export interface SavedThread {
  messages: Message[];
  /** Null when the saved one was missing or malformed: the page draws a new one and keeps the thread. */
  sessionToken: string | null;
  lastTurnAt: number;
}

/**
 * The document set a document belongs to: the part of its key before "--", else
 * the whole key. Two decks never share a thread; two slides of one deck do. The
 * one definition is chat-core's, which also picks a project's grounding set by it.
 */
export { documentSet };

/** The storage key for a project's thread on a document set: `talk_thread:<project>:<set>`. */
export function threadStorageKey(project: string, set: string): string {
  return `${THREAD_KEY_PREFIX}${project || 'default'}:${set}`;
}

/**
 * The document set a page's thread is kept under. A page that follows a host
 * keeps the set of the first document it was on (`boundSet`): the host may move
 * on, but the thread on the page is the one it began. Any other page follows
 * the open document, since opening another one starts another conversation.
 */
export function threadSetFor(o: { hostDriven: boolean; boundSet: string | null; documentKey: string | null }): string | null {
  if (o.hostDriven) return o.boundSet ?? (o.documentKey ? documentSet(o.documentKey) : null);
  return o.documentKey ? documentSet(o.documentKey) : null;
}

/**
 * The session token for a new epoch: the one a thread was restored with in
 * this same epoch, else a fresh one. A later epoch (a language switch, New
 * conversation) always draws afresh.
 */
export function tokenForEpoch(restored: { token: string; epoch: number } | null, epoch: number, mint: () => string): string {
  return restored && restored.epoch === epoch ? restored.token : mint();
}

/** A session token as the page mints it (useChatSession's randomToken): 32 hex digits. */
export function isSessionToken(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}

/** Whether a thread whose last turn was at `lastTurnAt` still comes back at `now`. */
export function withinWindow(lastTurnAt: number, days: number, now: number): boolean {
  return Number.isFinite(lastTurnAt) && lastTurnAt <= now + CLOCK_SKEW_MS && now - lastTurnAt <= days * DAY_MS;
}

/** A message read back from storage, keeping only what the page itself writes. */
function cleanMessage(raw: unknown): Message | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if ((m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return null;
  const out: Message = { role: m.role, content: m.content };
  if (m.beyondScope === true) out.beyondScope = true;
  if (typeof m.documentKey === 'string' && m.documentKey) out.documentKey = m.documentKey;
  if (typeof m.documentTitle === 'string' && m.documentTitle) out.documentTitle = m.documentTitle;
  return out;
}

/** Whether a thread holds a question: one that does not is not worth keeping. */
export function hasQuestion(messages: readonly Message[]): boolean {
  return messages.some(m => m.role === 'user');
}

/**
 * The saved thread, if it is well formed, holds a question and its last turn is
 * within `days`. Anything else is removed and null returned, so an expired or
 * damaged thread is discarded on the first visit that finds it.
 */
export function loadThread(storage: GetStorage, key: string, days: number, now: number): SavedThread | null {
  let raw: string | null = null;
  try {
    raw = storage().getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let thread: SavedThread | null = null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const messages = Array.isArray(parsed?.messages) ? parsed.messages.map(cleanMessage) : [];
    const lastTurnAt = typeof parsed?.lastTurnAt === 'number' ? parsed.lastTurnAt : NaN;
    if (parsed?.v === 1 && messages.length > 0 && messages.every(m => m !== null)
      && hasQuestion(messages as Message[]) && withinWindow(lastTurnAt, days, now)) {
      thread = {
        messages: messages as Message[],
        sessionToken: isSessionToken(parsed.sessionToken) ? parsed.sessionToken : null,
        lastTurnAt,
      };
    }
  } catch {
    thread = null;
  }
  if (!thread) forgetThread(storage, key);
  return thread;
}

/** Save the thread. False when storage refused it (blocked, or full); the page carries on regardless. */
export function saveThread(storage: GetStorage, key: string, thread: SavedThread): boolean {
  try {
    storage().setItem(key, JSON.stringify({
      v: 1,
      messages: thread.messages.map(({ role, content, beyondScope, documentKey, documentTitle }) =>
        ({ role, content, ...(beyondScope ? { beyondScope } : {}), ...(documentKey ? { documentKey } : {}), ...(documentTitle ? { documentTitle } : {}) })),
      sessionToken: thread.sessionToken,
      lastTurnAt: thread.lastTurnAt,
    }));
    return true;
  } catch {
    return false;
  }
}

/** Remove the saved thread. */
export function forgetThread(storage: GetStorage, key: string): void {
  try {
    storage().removeItem(key);
  } catch {
    /* storage blocked: there is nothing saved to remove */
  }
}

/**
 * Remove this project's other saved threads whose last turn is outside the
 * window, so a thread on a deck never reopened does not sit in the browser
 * forever. Only keys under `project`'s own prefix are touched.
 */
export function sweepExpiredThreads(storage: GetStorage, project: string, days: number, now: number): void {
  const prefix = threadStorageKey(project, '');
  let keys: string[] = [];
  try {
    const s = storage();
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(prefix)) keys.push(k);
    }
  } catch {
    keys = [];
  }
  for (const k of keys) loadThread(storage, k, days, now);
}
