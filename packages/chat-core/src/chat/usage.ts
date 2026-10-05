/**
 * Token accounting: the one price table, and the token_usage rows a chat turn
 * writes. Other endpoints (/api/tts, grading) price their calls here too.
 */
import type { ChatProjectConfig, ResponseUsage, TokenUsage } from './types.js';

/**
 * The chat models a project may select, and their prices: one table, so a
 * selectable model always has a price. USD per 1M tokens, Standard tier, from
 * OpenAI's pricing page https://developers.openai.com/api/docs/pricing
 * (formerly platform.openai.com/docs/pricing), read 2026-10-05. cachedInput is
the rate for prompt tokens the API served from its prompt cache (a repeated
prefix of 1,024 tokens or more: the system prompt and grounding). The schema's
 * chatModel enum (projects/project-schema.json) is checked against these keys
 * by usage.test.ts.
 */
export const CHAT_MODEL_PRICES = {
  'gpt-4o-mini': { input: 0.15, cachedInput: 0.075, output: 0.60 },
  'gpt-4o': { input: 2.50, cachedInput: 1.25, output: 10.00 },
  'gpt-4.1-mini': { input: 0.40, cachedInput: 0.10, output: 1.60 },
  'gpt-4.1': { input: 2.00, cachedInput: 0.50, output: 8.00 },
} as const satisfies Record<string, ChatPrice>;

interface ChatPrice { input: number; cachedInput: number; output: number }

/** Chat models a project may select via `chatModel` in project.json. */
export type KnownChatModel = keyof typeof CHAT_MODEL_PRICES;

/**
 * The platform's model: every project's chat model unless its project.json
 * sets `chatModel`, and the in-app grader's model (packages/api/src/grading.ts).
 * gpt-4.1-mini since 2026-10-05 (Ben: "it's fast and accurate").
 */
export const DEFAULT_CHAT_MODEL: KnownChatModel = 'gpt-4.1-mini';

/** The chatModel values a project may set: the price table's keys. */
export const KNOWN_CHAT_MODELS: ReadonlySet<KnownChatModel> =
  new Set(Object.keys(CHAT_MODEL_PRICES) as KnownChatModel[]);

/** TTS models, priced per 1M characters of input. */
const TTS_PRICES: Record<string, number> = {
  'gpt-4o-mini-tts': 12.00, // ~$0.015/min ≈ $12/1M chars
  'tts-1': 15.00,
  'tts-1-hd': 30.00,
};

/**
 * Estimated cost in USD. Chat models are priced per token, TTS models per
 * character. Unknown models cost 0. `cachedTokens` is the part of
 * `promptTokens` served from the prompt cache (cachedTokens() reads it off a
 * usage object) and is billed at the cached rate; it is clamped to
 * promptTokens.
 */
export function estimateCost(model: string, promptTokens: number, completionTokens: number, cachedTokens = 0): number {
  const chat = (CHAT_MODEL_PRICES as Record<string, ChatPrice>)[model];
  if (chat) {
    const cached = Math.min(Math.max(cachedTokens, 0), promptTokens);
    const M = 1_000_000;
    return (promptTokens - cached) * (chat.input / M) + cached * (chat.cachedInput / M)
      + completionTokens * (chat.output / M);
  }
  return promptTokens * ((TTS_PRICES[model] ?? 0) / 1_000_000);
}

/** The prompt tokens a completion's usage reports as cache hits (usage.prompt_tokens_details.cached_tokens); 0 when absent. */
export function cachedTokens(u: object | null | undefined): number {
  const details = (u as { prompt_tokens_details?: { cached_tokens?: unknown } | null } | null | undefined)
    ?.prompt_tokens_details;
  const n = details?.cached_tokens;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/** One token_usage row. */
export interface TokenUsageEntry {
  project: string;
  endpoint: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  estimated_cost: number;
}

export interface UsageSink {
  logTokenUsage(e: TokenUsageEntry): Promise<void>;
}

/**
 * Usage summed across a turn's hops, so a searched answer reports what it
 * actually cost rather than only its final hop. Undefined when no hop reported
 * usage.
 */
export function sumUsages(u: TokenUsage[]): ResponseUsage | undefined {
  if (!u.length) return undefined;
  return {
    prompt_tokens: u.reduce((n, x) => n + (x.prompt_tokens || 0), 0),
    completion_tokens: u.reduce((n, x) => n + (x.completion_tokens || 0), 0),
    total_tokens: u.reduce((n, x) => n + (x.prompt_tokens || 0) + (x.completion_tokens || 0), 0),
  };
}

/**
 * One token_usage row per hop, endpoint '/api/chat', under the project string
 * the usage log has always grouped on (the table prefix, e.g. 'ppol5013_').
 * Not awaited: the write never delays or fails a reply.
 */
export function logChatUsage(store: UsageSink, cfg: Pick<ChatProjectConfig, 'usageProject' | 'chatModel'>, usages: TokenUsage[]): void {
  for (const u of usages) {
    void store.logTokenUsage({
      project: cfg.usageProject,
      endpoint: '/api/chat',
      model: cfg.chatModel,
      prompt_tokens: u.prompt_tokens || 0,
      completion_tokens: u.completion_tokens || 0,
      estimated_cost: estimateCost(cfg.chatModel, u.prompt_tokens || 0, u.completion_tokens || 0, cachedTokens(u)),
    });
  }
}
