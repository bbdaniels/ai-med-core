/**
 * The document set a document belongs to: the part of its key before the first
 * "--" (a deck's slides, `deck-a--title`, are the set `deck-a`), else the whole
 * key. Two decks never share a set; two slides of one deck do.
 *
 * The one definition. The talk page keys a remembered conversation by it
 * (`talk_thread:<project>:<set>`, packages/frontend-chat/src/remember-conversation.ts),
 * and the chat pipeline picks a project's grounding set by it (project.json
 * `groundingSets`, chat/grounding.ts). It is browser-safe: the frontend imports
 * it as `@ai-med/chat-core/document-set`, so it must never import a Node module.
 */
export function documentSet(documentKey: string): string {
  const cut = documentKey.indexOf('--');
  return cut > 0 ? documentKey.slice(0, cut) : documentKey;
}
