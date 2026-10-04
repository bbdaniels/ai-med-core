/**
 * Turning a completion's text into the answer the reader sees.
 */
import type { StructuredAnswer } from './types.js';

/**
 * The first balanced JSON object in `s`, or null. Even with a strict
 * json_schema, the model has been observed to emit a valid object followed by
 * whitespace padding, so the object is brace-matched rather than parsed whole.
 */
export function extractJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Split a completion into {message, followups, beyondScope}.
 *
 * Unstructured projects get the text as it came. A structured project's JSON
 * is parsed; if parsing fails, the raw content is returned with no followups
 * and beyondScope false. The frontend's standing disclaimer covers the answer
 * either way, so a missing flag degrades to "no per-answer marker", never to a
 * wrong claim of coverage.
 */
export function parseStructuredAnswer(raw: string | null | undefined, opts: { structured: boolean }): StructuredAnswer {
  let messageText = raw || 'No response generated';
  let followups: string[] = [];
  let beyondScope = false;
  if (opts.structured) {
    const jsonStr = extractJsonObject(messageText);
    if (jsonStr) {
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          if (typeof parsed.answer === 'string' && parsed.answer.trim().length > 0) {
            messageText = parsed.answer;
          }
          if (Array.isArray(parsed.followups)) {
            followups = parsed.followups
              .filter((f: unknown) => typeof f === 'string' && f.trim().length > 0)
              .slice(0, 3);
          }
          beyondScope = parsed.beyondScope === true || parsed.beyondScope === 'true';
        }
      } catch (e) {
        console.warn('Follow-ups JSON parse failed on extracted object; returning raw content:', e);
      }
    } else {
      console.warn('Follow-ups: no JSON object found in response');
    }
    // Last-resort guard: if we ended up with empty/whitespace content, surface an error instead
    if (!messageText || messageText.trim().length === 0) {
      messageText = 'Sorry, I had trouble generating a response. Please try rephrasing your question.';
      followups = [];
      beyondScope = false;
    }
  }
  return { message: messageText, followups, beyondScope };
}
