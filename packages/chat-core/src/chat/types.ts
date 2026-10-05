/**
 * Types shared by the chat pipeline (`POST /api/chat`): one grounded turn over a
 * document, for either application on the engine.
 */

export type ChatRole = 'user' | 'assistant' | 'system';
export interface ChatMessage { role: ChatRole; content: string }

/**
 * A message of the history a page sends with every turn (the server holds no
 * conversation). A followHost page tags each question with the key of the
 * document that was current when it was asked; every other page sends none,
 * and the pipeline ignores the tag unless the project follows a host.
 */
export interface HistoryMessage extends ChatMessage { documentKey?: string }

/** The two applications: the clinical simulator, and document chat. */
export type AppType = 'simulation' | 'talk';

/** Chat models a project may select; each has a price in estimateCost. */
export type KnownChatModel = 'gpt-4o-mini' | 'gpt-4o';

/** One completion's usage as the API returns it. */
export interface TokenUsage { prompt_tokens?: number; completion_tokens?: number; [k: string]: unknown }

/** Usage summed over a turn's hops, as the chat response reports it. */
export interface ResponseUsage { prompt_tokens: number; completion_tokens: number; total_tokens: number }

/** What a turn needs to know about its project, read from project.json. */
export interface ChatProjectConfig {
  /** The project slug, e.g. 'ppol5013'. */
  slug: string;
  /** The value token_usage.project has always held: the table prefix, e.g. 'ppol5013_'. */
  usageProject: string;
  app: AppType;
  /** Structured answers: {answer, followups, beyondScope}. */
  enableFollowups: boolean;
  /** Write each turn to qa_log. */
  logConversations: boolean;
  readingsIndexPath: string | null;
  /** The language the corpus is written in, when queries must be restated into it. */
  readingsQueryLanguage: string | null;
  /** Resolved; the default is 'gpt-4o-mini'. */
  chatModel: KnownChatModel;
  /** The declared grounding file, repo-relative; null looks in the legacy locations. */
  groundingFile: string | null;
  /**
   * The document sets grounded on their own file (project.json groundingSets):
   * a turn on a document of one of them is grounded on
   * `projects/<slug>/grounding/<set>.md` instead of groundingFile. [] when none.
   */
  groundingSets: string[];
  /**
   * What a search may return: the whole corpus ('corpus', the default), or
   * only the passages of the document the turn is about ('document'). The
   * scope is applied by the server; the model cannot widen it.
   */
  retrievalScope: RetrievalScope;
  /** The first completion must search (tool_choice 'required' on hop 0 only). */
  searchFirst: boolean;
  /** Set when the project follows a host page (project.json followHost); null otherwise. */
  followHost: FollowHostConfig | null;
}

/** What a followHost turn needs beyond the rest of the config (follow-host.ts). */
export interface FollowHostConfig {
  /** The most history, in estimated tokens, a turn sends; the oldest turns go first. */
  historyTokens: number;
  /** Each document's title by key, from project.json's vignettes; a key without one is titled by itself. */
  titles: Record<string, string>;
}

export type RetrievalScope = 'corpus' | 'document';

export interface StructuredAnswer { message: string; followups: string[]; beyondScope: boolean }

export interface ChatTurnResult extends StructuredAnswer { usage?: ResponseUsage; caseTemplate: string | null }
