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
  /** Declared grounding file (Phase 2); null uses the legacy candidates. */
  groundingFile: string | null;
}

export interface StructuredAnswer { message: string; followups: string[]; beyondScope: boolean }

export interface ChatTurnResult extends StructuredAnswer { usage?: ResponseUsage; caseTemplate: string | null }
