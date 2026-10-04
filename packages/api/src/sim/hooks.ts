/**
 * The simulator's hooks on the chat pipeline (AppHooks in @ai-med/chat-core).
 * Document chat's hooks (talkHooks) live in chat-core; these are simulator
 * code, so they stay in the API.
 */
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { datePreamble, type AppHooks } from '@ai-med/chat-core';

export interface HookDeps {
  /** The project's case-template mapping as stored (JSON text), or null. */
  getCaseTemplate(): Promise<string | null>;
  /** Where first-turn prompt snapshots are written. */
  transcriptsDir: string;
}

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
