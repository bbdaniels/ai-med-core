/**
 * Shared types for AI-MED packages.
 * Import from '@ai-med/shared' in api and frontend packages.
 */

/** A chat message between user and assistant */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}
