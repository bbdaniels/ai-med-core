/**
 * The retrieval loop: the model may search the project's corpus, read what came
 * back, and search again, up to a hop cap.
 */
import {
  searchReadings,
  formatSearchResults,
  searchReadingsTool,
  READINGS_MAX_RESULTS,
  type OpenIndex,
} from '../readings.js';
import { EMBEDDING_MODEL } from '../gateway.js';
import type { CompletionClient, Issue } from './completion.js';
import { sameLanguage, type LanguageEntry } from './language.js';
import type { TokenUsage } from './types.js';

/**
 * Restate a search query in the language the corpus is written in.
 *
 * This is enforcement, not encouragement. A system prompt can ask the model
 * to search in Vietnamese and it will, sometimes; the times it does not are
 * indistinguishable in the answer, because a cross-lingual search returns
 * six real articles of the right instrument and none of them the one asked
 * about. Normalizing here means the model's own language discipline stops
 * mattering. Cheap model, deterministic temperature, and a failure just
 * searches the query as written — degraded, never broken.
 *
 * Deliberately not logged to token_usage: like the query embedding beside
 * it, it is a fixed sub-cent overhead on a search, and logging it under the
 * project's chatModel would misattribute both the model and the cost.
 * A session already in the corpus language (an English session on the
 * English papers corpus, a "Tiếng Việt" session on the corpus declared
 * "Vietnamese") has nothing to restate, so it skips the call. The two names are
 * compared through the project's languages list (chat/language.ts).
 */
export function makeRestater(client: CompletionClient, corpusLanguage: string | null,
                             sessionLanguage: string | null | undefined,
                             languages: LanguageEntry[] = []): (q: string) => Promise<string> {
  const sessionInCorpusLanguage = sameLanguage(sessionLanguage, corpusLanguage, languages);
  return async (raw: string): Promise<string> => {
    if (!corpusLanguage || sessionInCorpusLanguage) return raw;
    try {
      const restated = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 200,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              `Restate the search query in ${corpusLanguage}, in the vocabulary ` +
              `an official ${corpusLanguage} document would use for it. Keep every ` +
              'instrument number, article number, date, abbreviation and proper noun exactly ' +
              'as written. Do not answer the query, do not explain, do not add context: ' +
              'reply with the restated query and nothing else. If it is already in ' +
              `${corpusLanguage}, reply with it unchanged.`,
          },
          { role: 'user', content: raw },
        ],
      } as any);
      const out = (restated.choices?.[0]?.message?.content || '').trim();
      return out ? out.slice(0, 500) : raw;
    } catch (e) {
      console.warn('[readings] query restatement failed; searching as written:',
                   e instanceof Error ? e.message : e);
      return raw;
    }
  };
}

/**
 * Embed a query with the same model the index was built with. A failure is
 * not fatal: search falls back to BM25 alone.
 */
export function makeEmbedder(client: CompletionClient): (q: string) => Promise<Float32Array | null> {
  return async (q: string) => {
    try {
      const embedding = await client.embeddings.create({
        model: EMBEDDING_MODEL,
        input: q,
      });
      const vec = embedding.data?.[0]?.embedding;
      if (Array.isArray(vec)) return Float32Array.from(vec);
    } catch (e) {
      console.warn('[readings] query embedding failed; BM25 only:', e instanceof Error ? e.message : e);
    }
    return null;
  };
}

export interface RetrievalLoopArgs {
  /** The conversation so far; grown in place with tool calls and their results. */
  convo: unknown[];
  issue: Issue;
  index: OpenIndex | null;
  /** Hops that may offer the search tool. Default 3. */
  maxHops?: number;
  /** The session language's code (e.g. 'vi'), for the notices a result may carry; null renders them in English. */
  languageCode: string | null;
  restate: (q: string) => Promise<string>;
  embed: (q: string) => Promise<Float32Array | null>;
  log?: (line: string) => void;
}

export interface RetrievalLoopResult {
  response: any;
  usages: TokenUsage[];
  convo: unknown[];
  searches: Array<{ asked: string; ran: string; week: string | null; results: number }>;
}

/**
 * Complete, answering every search the model asks for, until it answers. Past
 * the last hop the tools are withheld, which forces the model to answer from
 * what it already retrieved rather than looping on a query that is never going
 * to match. The cap is hard: that tool-less request is the last one, and a
 * tool call in its reply is ignored, never run, so a turn makes at most
 * maxHops + 1 completions and maxHops rounds of searches. Without an index
 * there is exactly one completion.
 */
export async function runRetrievalLoop(a: RetrievalLoopArgs): Promise<RetrievalLoopResult> {
  const { convo, issue, index, languageCode, restate, embed } = a;
  const maxHops = a.maxHops ?? 3;
  const log = a.log ?? ((line: string) => console.log(line));
  const usages: TokenUsage[] = [];
  const searches: RetrievalLoopResult['searches'] = [];

  let response: any;
  for (let hop = 0; ; hop++) {
    const offerTools = index && hop < maxHops
      ? [searchReadingsTool(index)] : null;
    response = await issue(convo, offerTools);
    if (response.usage) usages.push({ ...response.usage });

    const assistantMsg = response.choices?.[0]?.message;
    const toolCalls = assistantMsg?.tool_calls;
    if (!index || !toolCalls?.length) break;
    if (!offerTools) {
      // Past the cap. No tool was offered, so a tool call here is not answered:
      // the reply stands as the turn's answer.
      log(`[readings] hop cap (${maxHops}) reached; ignoring ${toolCalls.length} tool call(s)`);
      break;
    }

    convo.push(assistantMsg);
    for (const call of toolCalls) {
      let content: string;
      try {
        const args = JSON.parse(call.function?.arguments || '{}');
        const askedQuery = typeof args.query === 'string' ? args.query.slice(0, 500) : '';
        if (!askedQuery) {
          content = 'search_readings requires a non-empty query string.';
        } else {
          // Both halves of the hybrid search run over the corpus's language,
          // so the restatement has to happen before the embedding, not after.
          const searchQuery = await restate(askedQuery);
          const queryVector = await embed(searchQuery);
          const week = typeof args.week === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.week)
            ? args.week : null;
          const limit = Number.isInteger(args.limit)
            ? Math.min(READINGS_MAX_RESULTS, Math.max(1, args.limit)) : undefined;
          const results = searchReadings(index, searchQuery, queryVector,
                                         { week, limit });
          const asked = searchQuery === askedQuery ? '' : `"${askedQuery}" -> `;
          log(`[readings] ${asked}"${searchQuery}"${week ? ` week=${week}` : ''} -> ${results.length} passages`);
          searches.push({ asked: askedQuery, ran: searchQuery, week, results: results.length });
          // The model is shown the query that was actually run, not the one it
          // asked for: a "no passage matches" line naming a query nobody ran is
          // a lie, and seeing the corpus's own wording nudges the next search.
          // The notice a retrieved passage may carry is an instruction about
          // that passage, so it is rendered in the language the answer is
          // being written in rather than in every language the corpus holds.
          // `scheduled` is the corpus's own answer to "does this index have a
          // class schedule?" -- the same bit `searchReadingsTool` branches on --
          // so an unscheduled corpus is not described to the model as course
          // readings assigned in weeks it does not have.
          content = formatSearchResults(searchQuery, results,
                                        { languageCode, scheduled: index.hasWeeks });
        }
      } catch (e) {
        console.error('[readings] tool call failed:', e);
        content = 'The reading search failed. Tell the student the search is ' +
                  'unavailable right now rather than answering from memory.';
      }
      convo.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }
  return { response, usages, convo, searches };
}
