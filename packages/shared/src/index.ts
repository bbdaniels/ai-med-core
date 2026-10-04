/**
 * Shared types for AI-MED packages.
 * Import from '@ai-med/shared' in api and frontend packages. The DOI and
 * talk-URL helpers live in @ai-med/chat-core/talk-url.
 */

/** A chat message between user and assistant */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}
