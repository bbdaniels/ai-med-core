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
 * This is the one place project.json flags are read; `/api/config`, the chat
 * pipeline and the validator all go through it.
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
}

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
  };
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
