/**
 * Types shared by the chat pipeline (`POST /api/chat`): one grounded turn over a
 * document, for either application on the engine.
 */

export type ChatRole = 'user' | 'assistant' | 'system';
export interface ChatMessage { role: ChatRole; content: string }

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
   * What a search may return: the whole corpus ('corpus', the default), or
   * only the passages of the document the turn is about ('document'). The
   * scope is applied by the server; the model cannot widen it.
   */
  retrievalScope: RetrievalScope;
  /** The first completion must search (tool_choice 'required' on hop 0 only). */
  searchFirst: boolean;
}

export type RetrievalScope = 'corpus' | 'document';

export interface StructuredAnswer { message: string; followups: string[]; beyondScope: boolean }

export interface ChatTurnResult extends StructuredAnswer { usage?: ResponseUsage; caseTemplate: string | null }
