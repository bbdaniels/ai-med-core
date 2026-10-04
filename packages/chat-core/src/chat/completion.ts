/**
 * One chat completion, with the response_format fallback ladder.
 *
 * The pipeline is handed its client (chosen per request by payment source) and
 * never builds or fetches one itself.
 */
import type { KnownChatModel } from './types.js';

/** The strict json_schema a structured project asks for. */
export const CHAT_RESPONSE_SCHEMA = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'chat_response',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['answer', 'followups', 'beyondScope'],
      properties: {
        answer: {
          type: 'string',
          description: 'Concise plain-prose response. Maximum 1-3 short sentences. NO markdown (no **bold**, *italics*, # headings, - bullets, numbered lists, tables, or code blocks). Write as natural flowing sentences like a quick text message to a colleague.',
        },
        followups: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 3,
          description: '2-3 short specific follow-up questions the user might naturally ask next, each under 12 words.',
        },
        beyondScope: {
          type: 'boolean',
          description: 'True when the answer states anything the reference content does not itself cover (declined, out-of-scope, partially covered, or general framing added around the reference content). False only when every statement is drawn from the reference content.',
        },
      },
    },
  },
};

/** The part of an OpenAI client the pipeline uses. */
export interface CompletionClient {
  chat: { completions: { create(req: any): Promise<any> } };
  embeddings: { create(req: any): Promise<any> };
}

/** Issue one completion over the conversation so far, offering `tools` when given. */
export type Issue = (convo: unknown[], tools: unknown[] | null) => Promise<any>;

/**
 * An Issue for this model. A structured project asks for the json_schema; a
 * gateway that rejects it drops to json_object, and one that rejects that drops
 * to plain text. `tools` is omitted entirely when there are none, so a project
 * without a corpus sends exactly what it always sent.
 */
export function makeIssuer(client: CompletionClient, o: { model: KnownChatModel; structured: boolean }): Issue {
  const baseChatRequest = {
    model: o.model,
    max_tokens: 1000,
    temperature: 0.7,
  };
  const schemaRequest = { ...baseChatRequest, response_format: CHAT_RESPONSE_SCHEMA };
  return async (convo, tools) => {
    const withTools = (req: Record<string, unknown>) =>
      (tools && tools.length ? { ...req, tools, tool_choice: 'auto' } : req);
    const request = { ...baseChatRequest, messages: convo };
    if (!o.structured) {
      return client.chat.completions.create(withTools(request) as any);
    }
    try {
      return await client.chat.completions.create(
        withTools({ ...schemaRequest, messages: convo }) as any);
    } catch (e) {
      console.warn('json_schema rejected, retrying with json_object fallback:', e instanceof Error ? e.message : e);
      try {
        return await client.chat.completions.create(withTools({
          ...request,
          response_format: { type: 'json_object' as const },
        }) as any);
      } catch (e2) {
        console.warn('json_object also rejected, retrying without response_format:', e2 instanceof Error ? e2.message : e2);
        return client.chat.completions.create(withTools(request) as any);
      }
    }
  };
}
