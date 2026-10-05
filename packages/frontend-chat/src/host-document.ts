// Following a host page: the page that frames the talk page says which
// document is current, and one conversation runs across documents (a slide
// deck's side panel that stays open while the reader tabs through slides).
// Only a project that sets `followHost` does this, and only inside a frame.
//
// The messages, both directions:
//
//   talk page -> parent   {type: 'talk:ready'}
//       posted once, when the page is mounted and access is settled (the
//       access code entered, the document list loaded). It carries no data,
//       so it goes to any origin ('*'). The host answers with the current
//       document, and sends it again on every change.
//
//   parent -> talk page   {type: 'host:document', key: '<key>' | null, title: '<string>'}
//       key null: this part of the host (a title slide, say) has no document
//       to ask about. The page keeps the conversation, says that questions
//       here cannot be answered, and disables sending until a document is
//       current again. A key the deployment does not hold is treated the same.
//
// Everything the page receives is checked: the project must set followHost,
// the page must be framed, the message must come from the page's own parent
// window (event.source), and from one of the project's embedOrigins
// (event.origin, compared exactly). Anything else is ignored without a word.
//
// Switching documents never clears the conversation. A question carries the
// key and title of the document current when it was asked; the thread shows a
// "Now on: <title>" divider only before a question asked on a different
// document from the question before it, so paging past twenty slides without
// asking adds nothing.
//
// Pure apart from listenForHostDocument and postTalkReady, which take the
// window they act on. Checked by host-document.check.ts.

export const HOST_DOCUMENT_MESSAGE = 'host:document';
export const TALK_READY_MESSAGE = 'talk:ready';

/** A title longer than this is cut; it is display text and never reaches the server. */
const MAX_TITLE = 300;
/** A key longer than this cannot be a document key. */
const MAX_KEY = 200;

/** What the host says is current. key null: nothing to ask about here. */
export interface HostDocument { key: string | null; title: string }

export interface HostMessageContext {
  followHost: boolean;
  embedOrigins: readonly string[];
  /** The page's own window and its parent; equal when the page is not framed. */
  self: unknown;
  parent: unknown;
}

export interface HostMessageEventLike { source: unknown; origin: string; data: unknown }

/** The document a message names, or null when the page must ignore the message. */
export function acceptHostDocument(e: HostMessageEventLike, ctx: HostMessageContext): HostDocument | null {
  if (!ctx.followHost) return null;
  if (ctx.parent === ctx.self || ctx.parent == null) return null;   // not framed: there is no host
  if (e.source !== ctx.parent) return null;
  if (!ctx.embedOrigins.includes(e.origin)) return null;
  const d = e.data as Record<string, unknown> | null;
  if (!d || typeof d !== 'object' || d.type !== HOST_DOCUMENT_MESSAGE) return null;
  let key: string | null;
  if (d.key === null || d.key === '') key = null;
  else if (typeof d.key === 'string' && d.key.length <= MAX_KEY) key = d.key;
  else return null;
  const title = typeof d.title === 'string' ? d.title.trim().slice(0, MAX_TITLE) : '';
  return { key, title };
}

interface WindowLike {
  parent: { postMessage(message: unknown, targetOrigin: string): void } | null;
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
  removeEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
}

/** Listen for the host's documents; returns the teardown. */
export function listenForHostDocument(
  win: WindowLike,
  ctx: Pick<HostMessageContext, 'followHost' | 'embedOrigins'>,
  onDocument: (d: HostDocument) => void,
): () => void {
  const onMessage = (e: MessageEvent) => {
    const doc = acceptHostDocument(e, { ...ctx, self: win, parent: win.parent });
    if (doc) onDocument(doc);
  };
  win.addEventListener('message', onMessage);
  return () => win.removeEventListener('message', onMessage);
}

/** Tell the host the page is ready for its documents. Nothing when the page is not framed. */
export function postTalkReady(win: Pick<WindowLike, 'parent'>): boolean {
  if (!win.parent || (win.parent as unknown) === win) return false;
  try { win.parent.postMessage({ type: TALK_READY_MESSAGE }, '*'); return true; } catch { return false; }
}

/** The document the page treats as current. */
export interface CurrentDocument {
  /** The key questions are asked on; null when nothing here can be asked about. */
  key: string | null;
  /** What the header shows. */
  title: string;
}

/**
 * The current document: the host's latest word, else the one the link named.
 * A key is current only once the deployment's document list has loaded and
 * holds it (requireKnownVignette, applied to every switch); until then, and for
 * a key it does not hold, nothing is. The title is the host's, else the
 * document's own, else the key. Null before anything is known.
 */
export function currentDocument(
  host: HostDocument | null,
  linked: string | null,
  knownKeys: readonly string[] | null,
  titleOf: (key: string) => string | undefined,
): CurrentDocument | null {
  const wanted = host ? host.key : linked;
  if (!host && !wanted) return null;
  const key = wanted !== null && knownKeys !== null && knownKeys.includes(wanted) ? wanted : null;
  const title = host?.title || (wanted ? titleOf(wanted) || wanted : '');
  return { key, title };
}

/**
 * Whether the reader is kept from asking: a followed page whose document list
 * has loaded and whose current document is none (the host's key was null, or
 * one the deployment does not hold). The input keeps what was typed.
 */
export function questionsBlocked(o: { hostDriven: boolean; listLoaded: boolean; key: string | null }): boolean {
  return o.hostDriven && o.listLoaded && o.key === null;
}

/**
 * Whether a key press in the question box sends. While questions are blocked
 * the box stays usable, so a reader mid-question when the host moves to a page
 * with no document keeps drafting and sends once back on one; Enter then does
 * nothing (no newline either), like the disabled send button beside it, and the
 * notice above the box says why. Shift+Enter is always a newline.
 */
export function enterSends(e: { key: string; shiftKey: boolean }, blocked: boolean): { send: boolean; preventDefault: boolean } {
  if (e.key !== 'Enter' || e.shiftKey) return { send: false, preventDefault: false };
  return { send: !blocked, preventDefault: true };
}

/** A question, tagged with the document current when it was asked. */
export function questionOn(content: string, current: { key: string; title?: string }) {
  return { role: 'user' as const, content, documentKey: current.key, documentTitle: current.title || current.key };
}

interface ThreadMessage { role: string; documentKey?: string; documentTitle?: string }

export type ThreadItem<M> =
  | { kind: 'message'; message: M; index: number }
  | { kind: 'divider'; key: string; title: string; index: number };

/**
 * The thread as shown: every message, with a "Now on" divider before each
 * question asked on a different document from the question before it. Only
 * questions are compared, so switches between questions collapse into one
 * divider, and the first question gets none (the header names its document).
 */
export function threadWithDividers<M extends ThreadMessage>(messages: readonly M[]): ThreadItem<M>[] {
  const out: ThreadItem<M>[] = [];
  let previous: string | undefined;
  messages.forEach((message, index) => {
    if (message.role === 'user' && message.documentKey) {
      if (previous !== undefined && message.documentKey !== previous) {
        out.push({ kind: 'divider', key: message.documentKey, title: message.documentTitle || message.documentKey, index });
      }
      previous = message.documentKey;
    }
    out.push({ kind: 'message', message, index });
  });
  return out;
}
