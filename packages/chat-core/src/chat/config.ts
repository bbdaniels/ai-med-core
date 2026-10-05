/**
 * A project's chat settings, read from projects/<slug>/project.json on every
 * turn (no database, no push step).
 */
import fs from 'fs/promises';
import path from 'path';
import type { ChatProjectConfig, FollowHostConfig, KnownChatModel, RetrievalScope } from './types.js';
import { DEFAULT_HISTORY_TOKENS } from './follow-host.js';
import { KNOWN_CHAT_MODELS } from './usage.js';
import { groundingSets as declaredGroundingSets, resolveProjectFlags } from '../project-config.js';

/**
 * Read the project's chat settings. A project.json that is missing or does not
 * parse yields the defaults (no followups, no logging, no index, gpt-4o-mini).
 * `usageProject` is recorded as is, for token_usage.
 */
export async function loadChatProjectConfig(repoRoot: string, slug: string, usageProject: string): Promise<ChatProjectConfig> {
  // When follow-ups are enabled, the model returns JSON: {answer, followups,
  // beyondScope} via response_format. logConversations gates qa_log writes
  // (formless Q&A advisors like haivn_eip whose consent states turns are logged).
  // `app` and enableFollowups are resolved (project-config.ts): a talk project
  // implies followups.
  let flags = resolveProjectFlags({});
  let logConversations = false;
  let readingsIndexPath: string | null = null;
  let readingsQueryLanguage: string | null = null;
  let chatModel: KnownChatModel = 'gpt-4o-mini';
  let groundingFile: string | null = null;
  let groundingSets: string[] = [];
  let retrievalScope: RetrievalScope = 'corpus';
  let searchFirst = false;
  let followHost: FollowHostConfig | null = null;
  try {
    const cfgPath = path.join(repoRoot, 'projects', slug, 'project.json');
    const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf-8'));
    flags = resolveProjectFlags(cfg);
    logConversations = cfg.logConversations === true;
    readingsIndexPath = typeof cfg.readingsIndex === 'string' ? cfg.readingsIndex : null;
    groundingFile = typeof cfg.groundingFile === 'string' && cfg.groundingFile ? cfg.groundingFile : null;
    // Document sets with their own grounding file (chat/grounding.ts).
    groundingSets = declaredGroundingSets(cfg);
    // A document-scoped project searches only the passages of the document the
    // turn is about (its key is the index's document id), and a search-first
    // project must search before it answers. Both default off.
    if (cfg.retrievalScope === 'document') retrievalScope = 'document';
    else if (cfg.retrievalScope !== undefined && cfg.retrievalScope !== 'corpus') {
      console.warn(`[readings] ${slug}: unknown retrievalScope, searching the corpus`);
    }
    searchFirst = cfg.searchFirst === true;
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
    // A project that follows a host page runs one conversation across its
    // documents; its prompt names each one by title (follow-host.ts).
    if (flags.followHost) followHost = followHostConfig(cfg);
  } catch { /* ignore — default off */ }

  return {
    slug,
    usageProject,
    app: flags.app,
    enableFollowups: flags.enableFollowups,
    logConversations,
    readingsIndexPath,
    readingsQueryLanguage,
    chatModel,
    groundingFile,
    groundingSets,
    retrievalScope,
    searchFirst,
    followHost,
  };
}

/** historyTokens (an integer in the schema's range, else the default) and the vignette titles. */
function followHostConfig(cfg: Record<string, any>): FollowHostConfig {
  const n = cfg.historyTokens;
  const historyTokens = Number.isInteger(n) && n >= 256 && n <= 100_000 ? n : DEFAULT_HISTORY_TOKENS;
  const titles: Record<string, string> = {};
  for (const v of Array.isArray(cfg.cases?.vignettes) ? cfg.cases.vignettes : []) {
    if (typeof v?.key === 'string' && typeof v?.title === 'string' && v.title.trim()) titles[v.key] = v.title.trim();
  }
  return { historyTokens, titles };
}
