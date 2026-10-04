/**
 * The system message of a chat turn, assembled from its parts. Pure: no I/O,
 * no clock (the date block takes `now`).
 */

/** Appended for a structured project (enableFollowups); the reply is then a JSON object. */
export const STRUCTURED_INSTRUCTION = 'You will respond as a JSON object with {answer, followups, beyondScope}. The answer MUST be plain prose — no markdown, no **, no *, no #, no lists, no bullets, no tables. Write 1-3 short sentences maximum unless the user explicitly asks for detail. The followups array contains 2-3 short questions (each under 12 words) in the same language as the answer. Only suggest follow-up questions that can be answered from the reference content provided in this conversation. If your answer declines the question or states it is out of scope, the followups must instead redirect to topics the reference content does cover. Set beyondScope to true whenever the answer says anything the reference content does not itself cover — a declined or out-of-scope question, a partially covered question, or any general framing you added around what the reference content says — and to false only when every statement in the answer is drawn from the reference content. Do not mention the beyondScope flag in the answer text; the interface discloses it.';

const fmt = (d: Date) => d.toLocaleDateString('en-US', {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
});

/** Today and the recent past by name, so a patient can say "since Tuesday". Local time. */
export function dateReferenceBlock(now: Date): string {
  const daysAgo = (n: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() - n);
    return fmt(d);
  };
  return [
    `Today is ${fmt(now)}.`,
    `Yesterday was ${daysAgo(1)}.`,
    `Two days ago was ${daysAgo(2)}.`,
    `Three days ago was ${daysAgo(3)}.`,
    `Four days ago was ${daysAgo(4)}.`,
    `One week ago was ${daysAgo(7)}.`,
  ].join(' ');
}

export interface PromptInput {
  systemPrompt: string | null;
  /** Blocks from the application's hooks, each emitted as '\n\n' + block. */
  preamble: string[];
  /** The document's (vignette's) content. */
  documentContent: string;
  /** '' = none. */
  corpusGrounding: string;
  structured: boolean;
  language: string | null | undefined;
}

/**
 * System prompt, preamble blocks, the document, grounding, the JSON
 * instruction, then the language directive, each separated by a blank line.
 */
export function assemblePrompt(p: PromptInput): string {
  return (p.systemPrompt || '') +
    p.preamble.map(b => `\n\n${b}`).join('') +
    `\n\n${p.documentContent}` +
    (p.corpusGrounding ? `\n\n${p.corpusGrounding}` : '') +
    (p.structured ? `\n\n${STRUCTURED_INSTRUCTION}` : '') +
    (p.language ? `\n\nSPEAK ONLY IN ${p.language}` : '');
}
