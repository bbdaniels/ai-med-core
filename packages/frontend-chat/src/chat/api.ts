// The two chat-page API calls both pages make: the vignette list and a chat turn.

import { api, apiFetch } from '../api-base';
import type { ChatResponse, Message } from './types';

/** Thrown by fetchVignettes when a requireKnownVignette project does not hold the requested key. */
export class UnknownVignetteError extends Error {}

// `requested` is sent only by requireKnownVignette projects: the server then
// answers 404 when it does not hold that key (see /api/vignettes).
export const fetchVignettes = async (uid?: string | null, requested?: string | null): Promise<string[]> => {
  const params = new URLSearchParams();
  if (uid) params.set('uid', uid);
  if (requested) params.set('vignette', requested);
  const query = params.toString();
  const response = await apiFetch(api(`/api/vignettes${query ? `?${query}` : ''}`));
  if (response.status === 404 && requested) throw new UnknownVignetteError(requested);
  if (!response.ok) throw new Error('Failed to fetch vignettes');
  const data = await response.json();
  return data.vignetteKeys;
};

/** A talkManifest project switched off from the global admin page; the message is shown verbatim. */
export class ChatSwitchedOffError extends Error {}

export const postChat = async ({ messages, vignetteKey, language, sessionToken }: {
  messages: Message[];
  vignetteKey: string;
  language?: string | null;
  sessionToken?: string | null;
}): Promise<ChatResponse> => {
  const response = await apiFetch(api('/api/chat'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // documentKey is the document's name in the API; vignetteKey carries the
    // same key so an API rolled back to before documentKey still answers.
    body: JSON.stringify({ messages, documentKey: vignetteKey, vignetteKey, language, sessionToken }),
  });
  if (!response.ok) {
    // A talkManifest project switched off from the global admin page answers 503
    // with code public_chat_disabled; its message is shown to the user verbatim.
    if (response.status === 503) {
      const body = await response.json().catch(() => ({}));
      if (body?.code === 'public_chat_disabled' && typeof body.error === 'string') {
        throw new ChatSwitchedOffError(body.error);
      }
    }
    throw new Error('Failed to send message');
  }
  return response.json();
};
