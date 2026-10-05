// Shapes shared by the simulator page (App.tsx) and the talk page
// (talk/TalkApp.tsx): chat messages, the project's languages file, and tabs.

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  // Set by /api/chat when the answer states anything the project's reference
  // content does not itself cover; drives the per-answer disclosure marker.
  beyondScope?: boolean;
  // followHost pages only (host-document.ts): the document current when this
  // question was asked. The key goes to the API with the history; the title
  // stays on the page, for the thread's "Now on" dividers.
  documentKey?: string;
  documentTitle?: string;
}

// Language types
export interface LanguageDef { code: string; name: string; flag?: string }
export interface LanguageUISection {
  welcome: {
    title: string
    subtitle: string
    instructionsLead: string
    howItWorks: string
    bullets: string[]
    disclaimer?: string | string[]
    consentParagraphs?: string[]
    /** Shown on the access gate, for projects that set requireAccessCode. */
    accessHint?: string
    getStarted: string
    languageLabel: string
  }
  chat: {
    /** Optional starter questions shown on an untouched conversation. */
    starterQuestions?: string[]
    headerTitle: string
    scenarioDescription: string
    inputPlaceholder: string
    send: string
    loadingForm: string
    thanksTitle: string
    nextCase: string
    endThankYouMessage?: string
    submittedTitle?: string
    loadingNext?: string
    transitionContinue?: string
    patientMode: string
    diagnosis: string
    submitForm?: string
    submittingForm?: string
    formTitle?: string
    noticeLine?: string
    noticeDetails?: string
    // Standing disclosure under the chat input: what answers are grounded in.
    groundingNote?: string
    // Per-answer marker shown on a reply that goes beyond the grounding source.
    beyondScopeNotice?: string
    // talkManifest projects: heading of the paper picker, and the link back to it.
    pickerHeading?: string
    /** Shown instead of the chat when a requireKnownVignette link names no known vignette. */
    unknownVignette?: string
    pickerBack?: string
    pickerClose?: string
    /** followHost: the thread's divider before a question on another document, followed by its title. */
    nowOn?: string
    /** followHost: shown, with sending disabled, while the host's current page has no document. */
    noCurrentDocument?: string
    /** rememberConversation: the header control that clears the saved thread and starts afresh. */
    newConversation?: string
    /** rememberConversation: the same control asking once more, on a long thread. */
    newConversationConfirm?: string
  }
  feedback?: {
    loading: string
    loadingDetail?: string
    explored: string
    opportunities: string
    complete: string
    error: string
    continue?: string
  }
}
export interface ContentSection {
  heading: string
  content: string
  image?: string
}
// Labels and other tab strings may be either a plain string (legacy/CBS pattern)
// or a language-keyed object like {en: "...", vi: "..."} (new pattern, from /api/tabs content files).
export type TabLabel = string | Record<string, string>
export interface TabDefinition {
  id: string
  label: TabLabel
  type: 'content' | 'form' | 'suggestions' | 'document' | 'pdf' | 'library'
  icon?: string
  pinned?: boolean
  order?: number
  globalSections?: ContentSection[]
  hideAction?: boolean
  // Populated when the tab comes from /api/tabs (content loaded from a contentFile).
  // Shape depends on tab type: for 'suggestions', has {label, intro, sections}.
  content?: unknown
  // When set, tab only renders if the currently selected vignette key is in this list.
  showForVignetteKeys?: string[]
  // A second rendering of the same document, folded in from a duplicate tab
  // declaration (see mergeTabViews). Set only on a merged `pdf`/`document` tab.
  altView?: TabDefinition
}

export interface VignetteInfo {
  title?: string
  scenarioDescription: string
  imageFile?: string
  imageMaxWidth?: string
  voiceEnabled?: boolean
  voice?: string
  speakerVoices?: Record<string, string>
  tabSections?: Record<string, ContentSection[]>
}
export interface LanguagesJson {
  languages: LanguageDef[]
  ui: Record<string, LanguageUISection>
  vignetteInfo?: Record<string, VignetteInfo>
  tabs?: TabDefinition[]
}

export interface ChatResponse {
  message: string;
  followups?: string[];
  beyondScope?: boolean;
  caseTemplate?: string | null;
  usage?: unknown;
}
