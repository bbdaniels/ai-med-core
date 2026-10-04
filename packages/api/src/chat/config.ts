/**
 * A project's chat settings, read from projects/<slug>/project.json on every
 * turn (no database, no push step).
 */
import fs from 'fs/promises';
import path from 'path';
import type { ChatProjectConfig, KnownChatModel } from './types.js';
import { KNOWN_CHAT_MODELS } from './usage.js';

/**
 * Read the project's chat settings. A project.json that is missing or does not
 * parse yields the defaults (no followups, no logging, no index, gpt-4o-mini).
 * `usageProject` is recorded as is, for token_usage.
 */
export async function loadChatProjectConfig(repoRoot: string, slug: string, usageProject: string): Promise<ChatProjectConfig> {
  // When follow-ups are enabled, the model returns JSON: {answer, followups,
  // beyondScope} via response_format. logConversations gates qa_log writes
  // (formless Q&A advisors like haivn_eip whose consent states turns are logged).
  let enableFollowups = false;
  let logConversations = false;
  let formless = false;
  let readingsIndexPath: string | null = null;
  let readingsQueryLanguage: string | null = null;
  let chatModel: KnownChatModel = 'gpt-4o-mini';
  try {
    const cfgPath = path.join(repoRoot, 'projects', slug, 'project.json');
    const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf-8'));
    enableFollowups = cfg.enableFollowups === true;
    logConversations = cfg.logConversations === true;
    formless = cfg.formless === true;
    readingsIndexPath = typeof cfg.readingsIndex === 'string' ? cfg.readingsIndex : null;
    // The language the corpus is WRITTEN in, when that is not the language its
    // users ask in. haivn_eip's legal library is entirely Vietnamese, so an
    // English question searches it across a language boundary: the BM25 half
    // matches almost nothing, and the dense half is left to separate one Điều
    // from four hundred on a cross-lingual similarity, which returns confident
    // near-misses — the right decree and the wrong article. Declaring the
    // language here makes the tool loop restate every query in it before
    // searching, so it no longer matters what language the model searched in.
    // A project that omits the key (ppol5013) searches exactly as it did.
    // A language NAME, as in the `language` field, since it goes into a prompt.
    if (typeof cfg.readingsQueryLanguage === 'string'
        && /^[A-Za-z][A-Za-z ]{1,31}$/.test(cfg.readingsQueryLanguage.trim())) {
      readingsQueryLanguage = cfg.readingsQueryLanguage.trim();
    } else if (typeof cfg.readingsQueryLanguage === 'string') {
      console.warn(`[readings] ${slug}: unusable readingsQueryLanguage, ignoring`);
    }
    // Per-project chat model. gpt-4o-mini is the platform default and is right
    // for the roleplay projects; a grounded advisor that must attribute a year
    // to the correct paper needs the stronger model. Restricted to models the
    // cost table knows, so a typo cannot silently log every call as free.
    if (typeof cfg.chatModel === 'string' && KNOWN_CHAT_MODELS.has(cfg.chatModel as KnownChatModel)) {
      chatModel = cfg.chatModel as KnownChatModel;
    } else if (typeof cfg.chatModel === 'string') {
      console.warn(`[chat] ${slug}: unknown chatModel "${cfg.chatModel}", using the default`);
    }
  } catch { /* ignore — default off */ }

  return {
    slug,
    usageProject,
    // Until project.json declares `app`, a formless project is document chat.
    app: formless ? 'talk' : 'simulation',
    enableFollowups,
    logConversations,
    readingsIndexPath,
    readingsQueryLanguage,
    chatModel,
    groundingFile: null,
  };
}
