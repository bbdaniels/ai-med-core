// What the chat pages read from GET /api/config. Pure, so it can be checked
// without a browser (src/project-config.check.ts).

import type { DocRefsConfig } from '../doc-refs';

export interface ProjectConfig {
  enableVoice: boolean;
  enableRealtime: boolean;
  // Formless mode: project has no Kobo form; we skip the auto-added form tab.
  formless: boolean;
  // skipWelcome: the project boots straight into chat; the welcome page's two
  // jobs (language choice, consent notice) move into ChatNoticeBar.
  skipWelcome: boolean;
  // Drag-drop allocation widget: project-specific opt-in for transforming
  // three select_one fields into a drag-drop assignment UI.
  dragDropAllocation: boolean;
  // Course access gate (see useAccessGate).
  requireAccessCode: boolean;
  // chatOnly: the project has no second panel at all — no tabs, no form, no
  // document view. The chat becomes a single centered column at every width.
  // ppol5013 is chat-only because its corpus is copyrighted: there is no
  // reading text to put in a side panel, and an empty pane is worse than none.
  chatOnly: boolean;
  // requireKnownVignette (project.json): each deep link is for one vignette (a
  // slide, in the decks project). A link naming none, or one the deployment
  // does not hold, is refused with a message; the first vignette is never
  // opened in its place.
  requireKnownVignette: boolean;
  // "Talk to this paper" projects (project.json talkManifest): the slug whose
  // public talk manifest maps each paper's DOI to its vignette. Null otherwise.
  talkManifestSlug: string | null;
  // talkPublicUrl projects (project.json): the author's page is the only public
  // front door. A top-level visit leaves for it; only the popout iframe stays.
  talkPublicUrl: string;
  // Whether to show the grading screen after the last case (defaults on).
  enableFeedback: boolean;
  // Document-reference linking: when a project declares `docRefs`, references in
  // an assistant answer ("Section 4.1", "Phụ lục 7.1") become clickable and jump
  // the document tab to that passage. Absent this config the feature is off and
  // assistant messages render exactly as before. See doc-refs.ts.
  docRefs: DocRefsConfig | null;
  // followHost (project.json): framed, the talk page follows the host page's
  // current document and keeps one conversation (host-document.ts), obeying
  // only messages from embedOrigins.
  followHost: boolean;
  embedOrigins: string[];
}

/** What a page assumes before /api/config answers, and keeps if it never does. */
export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  enableVoice: false,
  enableRealtime: false,
  formless: false,
  skipWelcome: false,
  dragDropAllocation: false,
  requireAccessCode: false,
  chatOnly: false,
  requireKnownVignette: false,
  talkManifestSlug: null,
  talkPublicUrl: '',
  enableFeedback: true,
  docRefs: null,
  followHost: false,
  embedOrigins: [],
};

/**
 * Read an /api/config body. Every flag is on only when the body says so, except
 * enableFeedback, which is off only when the body says false. `buildProject` is
 * the slug the page was built for, the manifest slug when the body names no
 * table prefix.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseProjectConfig(data: any, buildProject: string): ProjectConfig {
  const d = data && typeof data === 'object' ? data : {};
  let talkManifestSlug: string | null = null;
  if (d.talkManifest) {
    const slug = (typeof d.tablePrefix === 'string' ? d.tablePrefix : '').replace(/_+$/, '');
    talkManifestSlug = slug || buildProject || null;
  }
  return {
    enableVoice: !!d.enableVoice,
    enableRealtime: !!d.enableRealtime,
    formless: !!d.formless,
    skipWelcome: !!d.skipWelcome,
    dragDropAllocation: !!d.dragDropAllocation,
    requireAccessCode: !!d.requireAccessCode,
    chatOnly: !!d.chatOnly,
    requireKnownVignette: !!d.requireKnownVignette,
    talkManifestSlug,
    talkPublicUrl: typeof d.talkPublicUrl === 'string' ? d.talkPublicUrl : '',
    enableFeedback: d.enableFeedback !== false,
    docRefs: d.docRefs && typeof d.docRefs === 'object' && typeof d.docRefs.tabId === 'string'
      ? d.docRefs as DocRefsConfig : null,
    followHost: d.followHost === true,
    embedOrigins: Array.isArray(d.embedOrigins) ? d.embedOrigins.filter((o: unknown): o is string => typeof o === 'string') : [],
  };
}
