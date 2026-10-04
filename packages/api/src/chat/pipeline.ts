/**
 * One chat turn: validate the request, assemble the prompt, complete (with
 * retrieval when the project has an index), account for it, and log it.
 * `POST /api/chat` is a thin route over runChatTurn.
 *
 * The pipeline owns no storage and no client. The store is passed in, and so
 * is the client, which the route chooses per request by payment source; the
 * pipeline never builds or fetches one itself.
 */
import { parseStructuredAnswer } from './answer.js';
import { makeIssuer, type CompletionClient } from './completion.js';
import { loadCorpusGrounding } from './grounding.js';
import type { AppHooks } from './hooks.js';
import { assemblePrompt } from './prompt.js';
import { makeEmbedder, makeRestater, runRetrievalLoop } from './retrieval.js';
import { logChatUsage, sumUsages, type UsageSink } from './usage.js';
import type { ChatMessage, ChatProjectConfig, ChatTurnResult } from './types.js';
import type { OpenIndex } from '../readings.js';

export interface ChatStore extends UsageSink {
  getSystemPrompt(): Promise<string | null>;
  getDocument(key: string): Promise<{ key: string; content: string } | null>;
  logQaTurn(project: string, sessionToken: string | null, documentKey: string | null, language: string | null, q: string, a: string): Promise<void>;
  logSessionMessage(project: string, sessionToken: string, documentKey: string): Promise<void>;
}

export interface ChatTurnRequest {
  messages: ChatMessage[];
  documentKey: string;
  language?: string | null;
  sessionToken?: string | null;
}

export interface ChatDeps {
  repoRoot: string;
  config: ChatProjectConfig;
  store: ChatStore;
  /**
   * The completion client for this request. Resolved only after the request
   * is validated and the first-turn hook has run, which is the order the
   * route has always had: a request refused for its billing (503) still left
   * its first-turn snapshot. It may throw (DirectKeyMissingError).
   */
  client: () => Promise<CompletionClient>;
  hooks: AppHooks;
  now: () => Date;
  openIndex: (cfg: ChatProjectConfig) => OpenIndex | null;
}

/** A request the route answers with `status` and `{error: message}`. */
export class ChatInputError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = 'ChatInputError';
  }
}

// Only reasonable language names: the field goes into the prompt.
const LANGUAGE_RE = /^[\p{L}\p{M}\s\-()]{1,50}$/u;

export async function runChatTurn(req: ChatTurnRequest, deps: ChatDeps): Promise<ChatTurnResult> {
  const { messages, documentKey, language, sessionToken } = req;
  const { config, store, hooks } = deps;

  if (!documentKey) throw new ChatInputError('vignetteKey is required');

  // Look up content server-side - sensitive data never leaves the server
  const systemPrompt = await store.getSystemPrompt();
  const document = await store.getDocument(documentKey);
  if (!document) throw new ChatInputError('Invalid vignette key');

  // Validate language parameter (prevents prompt injection via the language field)
  if (language && !LANGUAGE_RE.test(language)) throw new ChatInputError('Invalid language parameter');

  const completeSystemPrompt = assemblePrompt({
    systemPrompt,
    preamble: hooks.promptPreamble({ now: deps.now(), config }),
    documentContent: document.content,
    corpusGrounding: await loadCorpusGrounding(deps.repoRoot, config),
    structured: config.enableFollowups,
    language,
  });

  if (Array.isArray(messages) && messages.length === 1 && hooks.onFirstTurn) {
    await hooks.onFirstTurn({ systemPrompt: completeSystemPrompt, messages, language, documentKey });
  }

  // The conversation the model sees. It grows during the retrieval loop: an
  // assistant turn holding tool calls, then one tool result per call.
  const convo: any[] = [
    { role: 'system', content: completeSystemPrompt },
    ...messages,
  ];

  const client = await deps.client();
  const { response, usages } = await runRetrievalLoop({
    convo,
    issue: makeIssuer(client, { model: config.chatModel, structured: config.enableFollowups }),
    index: deps.openIndex(config),
    language,
    restate: makeRestater(client, config.readingsQueryLanguage, language),
    embed: makeEmbedder(client),
  });

  // Log token usage for every hop.
  logChatUsage(store, config, usages);

  const caseTemplate = await hooks.caseTemplateFor(documentKey);

  // Session and conversation logs are keyed by the bare slug ('default' when
  // the request named no project). Both are non-blocking: a logging failure
  // never breaks a reply.
  const logProject = config.usageProject.replace(/_+$/, '') || 'default';
  const loggedToken = typeof sessionToken === 'string' && sessionToken.length >= 16 ? sessionToken : null;

  // Log session engagement (non-blocking)
  if (loggedToken) {
    store.logSessionMessage(logProject, loggedToken, documentKey).catch(e =>
      console.warn('Failed to log session message:', e)
    );
  }

  const answer = parseStructuredAnswer(response.choices[0]?.message?.content, { structured: config.enableFollowups });

  // Durable conversation log (opt-in per project). Records the user's question
  // (the last user message) paired with the answer just generated.
  if (config.logConversations) {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (lastUser && lastUser.content.trim()) {
      store.logQaTurn(
        logProject,
        loggedToken,
        documentKey || null,
        language || null,
        lastUser.content,
        answer.message,
      ).catch(e => console.warn('Failed to log qa turn:', e));
    }
  }

  return {
    ...answer,
    // Summed across retrieval hops, so a searched answer reports what it
    // actually cost rather than only its final hop.
    usage: sumUsages(usages),
    caseTemplate,
  };
}
