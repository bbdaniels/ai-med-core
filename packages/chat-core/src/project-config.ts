/**
 * The feature flags a project.json resolves to.
 *
 * A project declares which application it is: `app: "simulation"` (the clinical
 * simulator, the default) or `app: "talk"` (document chat). A talk project needs
 * no Kobo form and implies the four advisor flags in TALK_IMPLIED, so it does
 * not have to spell them out. An explicit flag still wins over an implied one.
 *
 * A project that does not declare `app` is resolved exactly as before: it is
 * talk when it sets `formless: true`, and every flag is what the file says,
 * with nothing implied.
 *
 * This is the one place project.json flags are read. `/api/config`, the access
 * gate, the unknown-vignette refusal, the voice and realtime checks, the talk
 * routes, the chat pipeline and the validator all go through it, and an API
 * test (packages/api/src/project-flags.test.ts) fails on a flag read straight
 * off a parsed project.json. The talk manifest's path, which the talk routes
 * need, is read here too (talkManifestPath); only its presence is a flag.
 */
import type { AppType } from './chat/types.js';

export type { AppType };

/** What `app: "talk"` implies for each flag the project leaves unset. */
export const TALK_IMPLIED = {
  formless: true,
  enableFeedback: false,
  skipWelcome: true,
  enableFollowups: true,
} as const;

/** Every flag `/api/config` emits, plus the application. */
export interface ResolvedFlags {
  app: AppType;
  enableFeedback: boolean;
  enableVoice: boolean;
  enableRealtime: boolean;
  formless: boolean;
  enableFollowups: boolean;
  skipWelcome: boolean;
  dragDropAllocation: boolean;
  requireAccessCode: boolean;
  chatOnly: boolean;
  /** Refuse a deep link naming no vignette or an unknown one (see /api/vignettes). */
  requireKnownVignette: boolean;
  /** Whether the project publishes a talk manifest. Only the flag: the path is a server-side detail. */
  talkManifest: boolean;
  /** The public page that fronts a talkManifest project; '' when unset. */
  talkPublicUrl: string;
  /** The document-reference linking config, passed through verbatim, or null. */
  docRefs: unknown;
  /**
   * The talk page follows a host page: the page that frames it says which
   * document is current, and one conversation runs across documents. Implied
   * by nothing; see followHostContradictions for what it requires.
   */
  followHost: boolean;
  /** The origins allowed to drive a followHost page, each `scheme://host[:port]`; [] otherwise. */
  embedOrigins: string[];
  /**
   * The talk page keeps the conversation in the reader's browser and brings it
   * back on the next visit, for up to `days` days after the last turn (1 to
   * 30). Null when the project does not set it, or sets it to anything else.
   * See rememberConversationContradictions for what it requires.
   */
  rememberConversation: { days: number } | null;
}

/** The bounds of rememberConversation.days, as the schema states them. */
export const REMEMBER_DAYS_MIN = 1;
export const REMEMBER_DAYS_MAX = 30;

type ImpliedFlag = keyof typeof TALK_IMPLIED;

/** The declared application, or null when project.json does not declare one. */
function declaredApp(cfg: Record<string, any>): AppType | null {
  return cfg.app === 'talk' || cfg.app === 'simulation' ? cfg.app : null;
}

/** Resolve a parsed project.json. `{}` (no file) yields every default. */
export function resolveProjectFlags(cfg: Record<string, any>): ResolvedFlags {
  const declared = declaredApp(cfg);
  const app: AppType = declared ?? (cfg.formless === true ? 'talk' : 'simulation');
  const implied: Partial<Record<ImpliedFlag, boolean>> = declared === 'talk' ? TALK_IMPLIED : {};
  const flag = (k: string): boolean =>
    typeof cfg[k] === 'boolean' ? cfg[k] : (implied[k as ImpliedFlag] ?? false);

  return {
    app,
    enableFeedback: flag('enableFeedback'),
    enableVoice: flag('enableVoice'),
    enableRealtime: flag('enableRealtime'),
    formless: flag('formless'),
    enableFollowups: flag('enableFollowups'),
    skipWelcome: flag('skipWelcome'),
    dragDropAllocation: flag('dragDropAllocation'),
    requireAccessCode: flag('requireAccessCode'),
    chatOnly: flag('chatOnly'),
    requireKnownVignette: flag('requireKnownVignette'),
    talkManifest: typeof cfg.talkManifest === 'string' && cfg.talkManifest !== '',
    talkPublicUrl: typeof cfg.talkPublicUrl === 'string' ? cfg.talkPublicUrl : '',
    docRefs: cfg.docRefs && typeof cfg.docRefs === 'object' ? cfg.docRefs : null,
    followHost: flag('followHost'),
    embedOrigins: embedOrigins(cfg),
    rememberConversation: rememberConversation(cfg),
  };
}

/** `{days}` when rememberConversation.days is an integer in range; null otherwise. */
function rememberConversation(cfg: Record<string, any>): { days: number } | null {
  const days = cfg.rememberConversation?.days;
  return Number.isInteger(days) && days >= REMEMBER_DAYS_MIN && days <= REMEMBER_DAYS_MAX ? { days } : null;
}

/** An origin as a browser reports it in MessageEvent.origin: scheme, host, optional port, nothing after. */
export const ORIGIN_RE = /^https?:\/\/[^/\s?#@]+$/;

/** The declared embedOrigins that are origins, in order, without repeats. */
function embedOrigins(cfg: Record<string, any>): string[] {
  if (!Array.isArray(cfg.embedOrigins)) return [];
  return [...new Set(cfg.embedOrigins.filter((o: unknown): o is string => typeof o === 'string' && ORIGIN_RE.test(o)))];
}

/** The repo-relative path of the project's talk manifest, or null when it declares none. */
export function talkManifestPath(cfg: Record<string, any>): string | null {
  return resolveProjectFlags(cfg).talkManifest ? cfg.talkManifest : null;
}

/**
 * Flags a talk project may not set: document chat has no Kobo form and no
 * grading, so `formless: false` or `enableFeedback: true` contradicts it.
 * One message per contradiction; none for a project that does not declare talk.
 */
export function talkContradictions(cfg: Record<string, any>): string[] {
  if (declaredApp(cfg) !== 'talk') return [];
  const out: string[] = [];
  if (cfg.formless === false) out.push('app "talk" contradicts formless: false (talk is formless)');
  if (cfg.enableFeedback === true) out.push('app "talk" contradicts enableFeedback: true (talk has no grading)');
  return out;
}

/**
 * What a followHost project needs, and the settings that mean nothing without
 * it. Only the talk page follows a host, and it obeys only the origins the
 * project lists, so followHost with no origin could never be driven. One
 * message per problem; none for a project that uses none of the three keys.
 */
export function followHostContradictions(cfg: Record<string, any>): string[] {
  const out: string[] = [];
  const flags = resolveProjectFlags(cfg);
  if (flags.followHost) {
    if (flags.app !== 'talk') out.push('followHost needs app "talk" (only the talk page follows a host)');
    if (flags.embedOrigins.length === 0) out.push('followHost needs embedOrigins: at least one origin allowed to drive the page');
  } else {
    if (cfg.embedOrigins !== undefined) out.push('embedOrigins is read only with followHost: true');
    if (cfg.historyTokens !== undefined) out.push('historyTokens is read only with followHost: true');
  }
  return out;
}

/**
 * rememberConversation belongs to the talk page, which is the only page that
 * keeps a thread in the browser. The schema checks the shape and the range of
 * days; this checks the application. One message per problem.
 */
export function rememberConversationContradictions(cfg: Record<string, any>): string[] {
  if (cfg.rememberConversation === undefined) return [];
  if (resolveProjectFlags(cfg).app !== 'talk') {
    return ['rememberConversation needs app "talk" (only the talk page remembers a conversation)'];
  }
  return [];
}
