/**
 * A turn of a project that follows a host page (project.json `followHost`).
 *
 * The page that frames the talk page (a slide deck, say) tells it which
 * document is current, and the reader keeps one conversation going while the
 * current document changes under it. Each turn is still about one document,
 * the one current when the question was asked (the request's documentKey), but
 * the model also needs to know which document each earlier question was asked
 * on, and what the last other document said when the reader refers back to it.
 *
 * History reaches the server the one way it always has: the page sends the
 * whole conversation with every turn, and the server keeps none. A followHost
 * page tags each of its questions with `documentKey`; nothing else changes.
 *
 * The prompt, in this order so that the parts that do not change from turn to
 * turn come first and the provider's prompt cache can apply to them:
 *
 *   system prompt, preamble blocks (the date), corpus grounding, the JSON
 *   instruction, the language directive, then
 *   "## Current document: <title> (<key>)" and that document's content, then,
 *   if an earlier question was asked on another document,
 *   "## Earlier document: <title> (<key>)" and the content of the most recent
 *   such document (one only), loaded here by key, never taken from the page.
 *
 * The history follows as chat messages: each question prefixed
 * "[On: <title>] ", answers as they were, capped at `historyTokens` (estimated)
 * by dropping the oldest turns first. The qa_log keeps every turn whatever the
 * cap drops. The project's system prompt is written against this shape; see
 * packages/chat-core/CLAUDE.md, "Following a host page".
 */
import { STRUCTURED_INSTRUCTION, type PromptInput } from './prompt.js';
import type { ChatMessage, FollowHostConfig, HistoryMessage } from './types.js';

/** The history cap when a project sets none: room for a long session well inside a 128k context (gpt-4.1-mini has 1M). */
export const DEFAULT_HISTORY_TOKENS = 24_000;

/** A rough token count (four characters a token), the estimate the deck tooling uses too. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export interface HostedDocument { key: string; title: string; content: string }

export const currentDocumentHeading = (d: Pick<HostedDocument, 'key' | 'title'>) => `## Current document: ${d.title} (${d.key})`;
export const earlierDocumentHeading = (d: Pick<HostedDocument, 'key' | 'title'>) => `## Earlier document: ${d.title} (${d.key})`;
/** What a question is prefixed with in the history the model sees. */
export const onDocumentPrefix = (title: string) => `[On: ${title}] `;

export interface FollowHostPromptInput extends Omit<PromptInput, 'documentContent'> {
  current: HostedDocument;
  earlier: HostedDocument | null;
}

/** The system message of a followHost turn (see the order above). Pure. */
export function assembleFollowHostPrompt(p: FollowHostPromptInput): string {
  return (p.systemPrompt || '') +
    p.preamble.map(b => `\n\n${b}`).join('') +
    (p.corpusGrounding ? `\n\n${p.corpusGrounding}` : '') +
    (p.structured ? `\n\n${STRUCTURED_INSTRUCTION}` : '') +
    (p.language ? `\n\nSPEAK ONLY IN ${p.language}` : '') +
    `\n\n${currentDocumentHeading(p.current)}\n\n${p.current.content}` +
    (p.earlier ? `\n\n${earlierDocumentHeading(p.earlier)}\n\n${p.earlier.content}` : '');
}

/** The document a history message was asked on, when the page tagged it with a key. */
function taggedKey(m: HistoryMessage): string | null {
  return typeof m?.documentKey === 'string' && m.documentKey !== '' ? m.documentKey : null;
}

/** The questions and answers of a history, in order; anything else a page sent is left out. */
function conversation(messages: unknown): HistoryMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages.filter((m): m is HistoryMessage =>
    !!m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
}

/**
 * The key of the most recent question, before the current one, that was asked
 * on a document other than `currentKey`; null when every earlier question was
 * asked on the current document (or none was tagged).
 */
export function earlierDocumentKey(messages: unknown, currentKey: string): string | null {
  const questions = conversation(messages).filter(m => m.role === 'user');
  for (let i = questions.length - 2; i >= 0; i--) {
    const key = taggedKey(questions[i]);
    if (key !== null && key !== currentKey) return key;
  }
  return null;
}

/**
 * The history as the model sees it: role and content only, each question
 * prefixed with the title of the document it was asked on. The last question
 * is the current turn's, so it is asked on the current document whatever its
 * tag says. A question whose document has no known title gets no prefix: a
 * key is printed into the prompt only once the server knows it.
 */
export function prefixedHistory(messages: unknown, currentKey: string, titleOf: (key: string) => string | null): ChatMessage[] {
  const convo = conversation(messages);
  const last = convo.map(m => m.role).lastIndexOf('user');
  return convo.map((m, i) => {
    if (m.role === 'assistant') return { role: 'assistant', content: m.content };
    const key = i === last ? currentKey : taggedKey(m);
    const title = key === null ? null : titleOf(key);
    return { role: 'user', content: title === null ? m.content : onDocumentPrefix(title) + m.content };
  });
}

/**
 * Keep the most recent turns that fit in `budget` estimated tokens. A turn is
 * a question and the answers after it; what comes before the first question
 * (the page's opening message) is a turn of its own. Whole turns are dropped,
 * oldest first, and the last turn (the current question) is always kept.
 */
export function capHistory(messages: ChatMessage[], budget: number): ChatMessage[] {
  const turns: ChatMessage[][] = [];
  for (const m of messages) {
    if (m.role === 'user' || turns.length === 0) turns.push([m]);
    else turns[turns.length - 1].push(m);
  }
  const size = (t: ChatMessage[]) => t.reduce((n, m) => n + estimateTokens(m.content), 0);
  let total = turns.reduce((n, t) => n + size(t), 0);
  while (turns.length > 1 && total > budget) total -= size(turns.shift()!);
  return turns.flat();
}

export interface FollowHostTurnInput {
  /** The history the page sent. */
  messages: unknown;
  /** The turn's document, already looked up and validated by the pipeline. */
  document: { key: string; content: string };
  follow: FollowHostConfig;
  /** The project's document lookup (ChatStore.getDocument): the earlier document is loaded only through it. */
  getDocument: (key: string) => Promise<{ key: string; content: string } | null>;
  prompt: Omit<PromptInput, 'documentContent'>;
}

/** The system message and the history of a followHost turn. */
export async function followHostTurn(a: FollowHostTurnInput): Promise<{ system: string; history: ChatMessage[] }> {
  const titleFor = (key: string) => a.follow.titles[key] ?? key;
  const current: HostedDocument = { key: a.document.key, title: titleFor(a.document.key), content: a.document.content };

  // The earlier document is named by the page, so it is validated as any
  // document is: it must be one this project holds, or there is no section.
  const earlierKey = earlierDocumentKey(a.messages, current.key);
  const found = earlierKey === null ? null : await a.getDocument(earlierKey);
  const earlier: HostedDocument | null = found ? { key: found.key, title: titleFor(found.key), content: found.content } : null;

  // A title is printed only for a key the server knows: the current and the
  // earlier document, and every document titled in project.json.
  const titleOf = (key: string): string | null =>
    key === current.key ? current.title
      : key === earlier?.key ? earlier.title
        : a.follow.titles[key] ?? null;

  return {
    system: assembleFollowHostPrompt({ ...a.prompt, current, earlier }),
    history: capHistory(prefixedHistory(a.messages, current.key, titleOf), a.follow.historyTokens),
  };
}
