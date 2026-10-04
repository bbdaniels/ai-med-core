/**
 * @ai-med/chat-core: the grounded-conversation engine shared by the
 * simulator and document chat.
 *
 * - the chat pipeline (chat/): runChatTurn and the contracts an app supplies
 *   to it, ChatStore (the database) and AppHooks (what differs per app);
 * - readings search (readings.ts) and the one OpenAI client module
 *   (openai-clients.ts);
 * - project.json flag resolution (project-config.ts).
 *
 * Subpath `@ai-med/chat-core/talk-url` holds the browser-safe DOI and
 * public-URL helpers the frontend imports on its own.
 */
export * from './talk-url.js';
export * from './gateway.js';
export * from './openai-clients.js';
export * from './readings.js';
export * from './project-config.js';
export * from './chat/types.js';
export * from './chat/answer.js';
export * from './chat/completion.js';
export * from './chat/config.js';
export * from './chat/grounding.js';
export * from './chat/hooks.js';
export * from './chat/language.js';
export * from './chat/pipeline.js';
export * from './chat/prompt.js';
export * from './chat/request.js';
export * from './chat/retrieval.js';
export * from './chat/usage.js';
