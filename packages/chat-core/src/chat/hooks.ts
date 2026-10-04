/**
 * What differs between the two applications on one chat pipeline. The
 * pipeline asks its hooks for the blocks that precede the document in the
 * prompt, for the case template a response carries, and whether to keep a
 * record of a conversation's first turn.
 */
import { dateReferenceBlock } from './prompt.js';
import type { ChatMessage, ChatProjectConfig } from './types.js';

export interface AppHooks {
  /** Blocks placed between the system prompt and the document, in order. */
  promptPreamble(ctx: { now: Date; config: ChatProjectConfig }): string[];
  /** The case template name a response carries for this document, or null. */
  caseTemplateFor(documentKey: string): Promise<string | null>;
  /** Called on a conversation's first turn, before the model is called. Never throws. */
  onFirstTurn?(s: { systemPrompt: string; messages: ChatMessage[]; language: string | null | undefined; documentKey: string }): Promise<void>;
}

/** Today's date and the recent past by name, before the document. */
export const datePreamble: AppHooks['promptPreamble'] = ({ now }) => [dateReferenceBlock(now)];

/**
 * Document chat. A document has no case template, so a talk response carries
 * `caseTemplate: null` (formless pages never read it). There is no first-turn
 * hook: the raw prompt of a talk project holds its documents (a paper's full
 * text, a deck's unpublished results), and it is never written to disk. The
 * prompt preamble is still the simulator's (datePreamble). simulationHooks is
 * simulator code and lives in the API (packages/api/src/sim/hooks.ts).
 */
export function talkHooks(): AppHooks {
  return {
    promptPreamble: datePreamble,
    caseTemplateFor: async () => null,
  };
}
