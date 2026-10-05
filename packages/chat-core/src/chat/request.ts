/**
 * The body of `POST /api/chat`.
 *
 * The document a turn is about is named by `documentKey`. `vignetteKey`, the
 * simulator's word for it, is accepted forever: every page already deployed
 * sends it, and a page sends both so that it still works against an API rolled
 * back to before `documentKey`. The database keeps its own names
 * (`qa_log.vignette_key`, the vignette rows); only the request gains an alias.
 */
import { ChatInputError } from './pipeline.js';
import type { HistoryMessage } from './types.js';

export interface ChatRequestBody {
  /** The conversation so far; a followHost page tags each question with documentKey. */
  messages: HistoryMessage[];
  documentKey?: string;
  vignetteKey?: string;
  language?: string | null;
  sessionToken?: string | null;
}

// Truthiness, as the route has always tested the key: '' and a missing key
// are absent; anything else is looked up (and an unknown one refused there).
const given = (v: unknown): v is string => !!v;

/**
 * The document key a request names. Both names may be sent, but they must
 * agree. The error for a request naming neither keeps its old wording, which
 * clients already match on.
 */
export function resolveDocumentKey(b: Pick<ChatRequestBody, 'documentKey' | 'vignetteKey'>): string {
  const doc = given(b?.documentKey) ? b.documentKey : null;
  const vig = given(b?.vignetteKey) ? b.vignetteKey : null;
  if (doc !== null && vig !== null && doc !== vig) throw new ChatInputError('documentKey and vignetteKey differ');
  const key = doc ?? vig;
  if (key === null) throw new ChatInputError('vignetteKey is required');
  return key;
}
