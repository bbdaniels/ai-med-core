/**
 * Token accounting: the one price table, and the token_usage rows a chat turn
 * writes. Other endpoints (/api/tts, grading) price their calls here too.
 */
import type { ChatProjectConfig, KnownChatModel, ResponseUsage, TokenUsage } from './types.js';

/** Estimated cost in USD. Chat models are priced per token, TTS models per character. Unknown models cost 0. */
export function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const pricing: Record<string, { input: number; output: number }> = {
    'gpt-4o-mini': { input: 0.15 / 1_000_000, output: 0.60 / 1_000_000 },
    'gpt-4o': { input: 2.50 / 1_000_000, output: 10.00 / 1_000_000 },
    'gpt-4o-mini-tts': { input: 12.00 / 1_000_000, output: 0 }, // ~$0.015/min ≈ $12/1M chars
    'tts-1': { input: 15.00 / 1_000_000, output: 0 }, // $15/1M chars
    'tts-1-hd': { input: 30.00 / 1_000_000, output: 0 },
  };
  const p = pricing[model] || { input: 0, output: 0 };
  return promptTokens * p.input + completionTokens * p.output;
}

// Chat models a project may select via `chatModel` in project.json. Kept in step
// with estimateCost's pricing table: a model missing from that table would be
// billed to the usage log as zero.
export const KNOWN_CHAT_MODELS = new Set<KnownChatModel>(['gpt-4o-mini', 'gpt-4o']);

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
      estimated_cost: estimateCost(cfg.chatModel, u.prompt_tokens || 0, u.completion_tokens || 0),
    });
  }
}
