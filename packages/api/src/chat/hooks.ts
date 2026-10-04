/**
 * What differs between the two applications on one chat pipeline. The
 * pipeline asks its hooks for the blocks that precede the document in the
 * prompt, for the case template a response carries, and whether to keep a
 * record of a conversation's first turn.
 */
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
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

export interface HookDeps {
  /** The project's case-template mapping as stored (JSON text), or null. */
  getCaseTemplate(): Promise<string | null>;
  /** Where first-turn prompt snapshots are written. */
  transcriptsDir: string;
}

/** Today's date and the recent past by name, before the document. */
const datePreamble: AppHooks['promptPreamble'] = ({ now }) => [dateReferenceBlock(now)];

/**
 * The simulator: the patient knows today's date and the recent past by name,
 * a response names the vignette's case template, and the first turn's raw
 * prompt is written to transcripts/ for debugging a case.
 */
export function simulationHooks(deps: HookDeps): AppHooks {
  return {
    promptPreamble: datePreamble,

    async caseTemplateFor(documentKey) {
      // Look up template name from case template mapping
      let templateName: string | null = null;
      try {
        const caseTemplateData = await deps.getCaseTemplate();
        if (caseTemplateData) {
          const parsed = JSON.parse(caseTemplateData);
          templateName = parsed.vignetteTemplates?.[documentKey] || null;
          console.log(`[DEBUG] Case template for ${documentKey}: ${templateName}`);
        } else {
          console.log(`[DEBUG] No case template data in DB`);
        }
      } catch (e) {
        console.warn('Failed to parse case template mapping:', e);
      }
      return templateName;
    },

    // Write the RAW system instructions and the initial payload into a
    // transcript snippet, before the model is called.
    async onFirstTurn({ systemPrompt, messages, language, documentKey }) {
      try {
        await fs.mkdir(deps.transcriptsDir, { recursive: true });

        const fileName = `initial_${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID().slice(0, 8)}.txt`;
        const filePath = path.join(deps.transcriptsDir, fileName);

        const headerLines: string[] = [];
        headerLines.push('Initial Request Snapshot');
        headerLines.push(`Created: ${new Date().toISOString()}`);
        headerLines.push('');

        const bodyParts: string[] = [];
        bodyParts.push('RAW System Instructions Sent to OpenAI:');
        bodyParts.push(systemPrompt);
        bodyParts.push('');
        bodyParts.push('Initial Request Payload:');
        bodyParts.push(JSON.stringify({ messages, language, vignetteKey: documentKey }, null, 2));
        bodyParts.push('');

        const content = headerLines.join('\n') + bodyParts.join('\n') + '\n';
        await fs.writeFile(filePath, content, 'utf8');
      } catch (e) {
        console.error('Failed to write initial request snapshot:', e);
      }
    },
  };
}

/**
 * Document chat. A document has no case template, so a talk response carries
 * `caseTemplate: null` (formless pages never read it). There is no first-turn
 * hook: the raw prompt of a talk project holds its documents (a paper's full
 * text, a deck's unpublished results), and it is never written to disk. The
 * prompt preamble is still the simulator's.
 */
export function talkHooks(): AppHooks {
  return {
    promptPreamble: datePreamble,
    caseTemplateFor: async () => null,
  };
}
