import { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from 'react';
import './App.css';
import { api, apiFetch, getAccessToken, setAccessToken, readAccessCodeFromUrl, scrubAccessCodeFromUrl } from './api-base';
import AccessGate from './components/AccessGate';
import AdminLogin from './components/AdminLogin';
import WelcomeScreen from './WelcomeVariants';
import TabBar from './components/TabBar';
import TabPanel from './components/TabPanel';
import ContentPanel from './components/ContentPanel';
import SuggestedQuestions, { type SuggestionsContent } from './components/SuggestedQuestions';
import DocumentPanel from './components/DocumentPanel';
import LegalLibraryPanel, { type LegalLibraryContent } from './components/LegalLibraryPanel';
import DualViewTab, { type DualViewKind } from './components/DualViewTab';
import ChatNoticeBar from './ChatNoticeBar';
import { scrollListToBottom } from './scroll-list';
import LanguageSwitcher from './LanguageSwitcher';
import { resolveInitialLanguage } from './lang-boot';
import { type DocRefsConfig, extractAnchorIds, buildDocRefMatcher } from './doc-refs';
import { splitRoleSegments, resolveSegmentVoice } from './tts-speech';

// Heavy components are code-split so their dependencies stay out of the entry
// chunk: NativeKoboForm pulls the whole enketo-core/enketo-transformer/jquery
// stack (~2 MB raw), PdfJsViewer pulls pdfjs-dist, and RealtimeVoice imports
// NativeKoboForm itself. Each render site is behind a conditional, so form
// projects still fetch the form chunk on demand the moment they render it —
// while formless projects (haivn_eip) never download any of it.
const AdminDashboard = lazy(() => import('./components/AdminDashboard'));
const RealtimeVoice = lazy(() => import('./RealtimeVoice'));
const NativeKoboForm = lazy(() => import('./components/NativeKoboForm'));
const GradingScreen = lazy(() => import('./components/GradingScreen'));
const PdfJsViewer = lazy(() => import('./components/PdfJsViewer'));

// Types
interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  // Set by /api/chat when the answer states anything the project's reference
  // content does not itself cover; drives the per-answer disclosure marker.
  beyondScope?: boolean;
}

// Play one TTS clip on a (reused) audio element; resolves when the clip ends,
// is paused (the mute button pauses the element), or errors — never rejects on
// media errors, so a sequential playback chain always advances or stops
// cleanly. play() rejections (autoplay blocked) propagate to the caller.
function playClip(audio: HTMLAudioElement, url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      audio.removeEventListener('ended', done);
      audio.removeEventListener('pause', done);
      audio.removeEventListener('error', done);
      resolve();
    };
    audio.src = url;
    audio.addEventListener('ended', done);
    audio.addEventListener('pause', done);
    audio.addEventListener('error', done);
    audio.play().catch(err => {
      if (!settled) {
        settled = true;
        audio.removeEventListener('ended', done);
        audio.removeEventListener('pause', done);
        audio.removeEventListener('error', done);
        reject(err);
      }
    });
  });
}

// Language types
interface LanguageDef { code: string; name: string; flag?: string }
interface LanguageUISection {
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
interface ContentSection {
  heading: string
  content: string
  image?: string
}
// Labels and other tab strings may be either a plain string (legacy/CBS pattern)
// or a language-keyed object like {en: "...", vi: "..."} (new pattern, from /api/tabs content files).
type TabLabel = string | Record<string, string>
interface TabDefinition {
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

// The two tab types that can be two views of one document.
const DUAL_VIEW_TYPES: ReadonlySet<string> = new Set(['pdf', 'document'])

/**
 * Fold tabs that declare the SAME id into one tab with two views.
 *
 * A reference document that ships both a PDF and an extracted text is one
 * document, and a project says so by declaring one tab id twice — once as `pdf`,
 * once as `document`, each with its own contentFile:
 *
 *   { "id": "eip-doc", "type": "pdf",      "contentFile": {...} }   <- default view
 *   { "id": "eip-doc", "type": "document", "contentFile": {...} }
 *
 * Declaration order decides which view opens first. The shared id is the point:
 * everything that addresses a tab — the doc-reference jump machinery, the PDF
 * page jumps, the active-tab reselect — keeps working on one stable id instead of
 * having to know which edition a citation happened to be aimed at.
 *
 * A project that declares each id once (every project but haivn_eip today) gets
 * its tab list back unchanged.
 */
function mergeTabViews(tabs: TabDefinition[]): TabDefinition[] {
  const byId = new Map<string, TabDefinition>()
  const merged: TabDefinition[] = []
  for (const tab of tabs) {
    const primary = byId.get(tab.id)
    if (!primary) {
      const copy = { ...tab }
      byId.set(tab.id, copy)
      merged.push(copy)
      continue
    }
    // Only a genuine second EDITION folds in. Anything else is a config mistake
    // (two unrelated tabs sharing an id), and rendering it would put two panels
    // behind one tab button — so it is dropped loudly rather than shown.
    if (
      !primary.altView &&
      DUAL_VIEW_TYPES.has(primary.type) &&
      DUAL_VIEW_TYPES.has(tab.type) &&
      primary.type !== tab.type
    ) {
      primary.altView = tab
    } else {
      console.warn(`Duplicate tab id "${tab.id}" (type ${tab.type}) ignored: not a second view of the primary tab.`)
    }
  }
  return merged
}

// The markdown a document tab carries, whichever of its views holds it. Used to
// derive the valid anchor set for document references, which must not depend on
// the reader having opened the text view.
function tabMarkdown(tab: TabDefinition | null | undefined): string | undefined {
  const own = (tab?.content as { markdown?: string } | null | undefined)?.markdown
  return own ?? (tab?.altView?.content as { markdown?: string } | null | undefined)?.markdown
}

// The PDF url a document tab carries, whichever of its views holds it.
function tabPdfUrl(tab: TabDefinition | null | undefined): string | undefined {
  const own = (tab?.content as { pdfUrl?: string } | null | undefined)?.pdfUrl
  return own ?? (tab?.altView?.content as { pdfUrl?: string } | null | undefined)?.pdfUrl
}

// Whether a tab offers a PDF rendering at all — as its own type or as its alt view.
function tabHasPdf(tab: TabDefinition | null | undefined): boolean {
  return !!tab && (tab.type === 'pdf' || tab.altView?.type === 'pdf')
}

// Resolves a language-keyed object string to the user's language, falling back to English.
// Pass-through for plain strings (legacy behavior).
function resolveI18n(val: TabLabel | undefined, lang: string): string {
  if (!val) return ''
  if (typeof val === 'string') return val
  return val[lang] || val['en'] || ''
}

// UI strings for the pdf tab's "open in a new tab" affordance. Kept here rather than
// in each project's languages.json so a pdf tab works for any project with no extra
// i18n wiring — the same small-map convention DocumentPanel uses. Falls back to English.
const PDF_TAB_UI: Record<string, { openInNewTab: string }> = {
  en: { openInNewTab: 'Open in new tab' },
  vi: { openInNewTab: 'Mở trong tab mới' },
}

// The Text/PDF control on a merged document tab. Same wording as the Legal
// Library's own switcher (LegalLibraryPanel's UI map) so one vocabulary covers
// both surfaces; kept here rather than in each project's languages.json for the
// same reason PDF_TAB_UI is — a merged tab needs no per-project i18n wiring.
const DUAL_VIEW_UI: Record<string, { group: string; pdf: string; text: string }> = {
  en: { group: 'View', pdf: 'PDF', text: 'Text' },
  vi: { group: 'Xem', pdf: 'PDF', text: 'Văn bản' },
}

// The secondary affordance on a document-reference chip. The chip itself opens
// the PDF at the cited page; this is the way back to the text edition.
const DOC_REF_UI: Record<string, { text: string; openPdf: string; openText: string }> = {
  en: { text: 'Text', openPdf: 'Open in the PDF', openText: 'Open in the text' },
  vi: { text: 'Văn bản', openPdf: 'Mở trong bản PDF', openText: 'Mở trong toàn văn' },
}

// A PDF tab's page map lives beside the PDF it maps, under the same base name:
//   .../eip-en.pdf  ->  .../eip-map.en.json
// Derived rather than configured so no project.json change is needed, and a
// project with no such file simply gets a 404 and keeps today's behavior.
function pdfPageMapUrl(pdfUrl: string): string | null {
  const m = /^(.*\/)([^/]+)-([A-Za-z]{2}(?:-[A-Za-z0-9]+)?)\.pdf$/.exec(pdfUrl)
  return m ? `${m[1]}${m[2]}-map.${m[3]}.json` : null
}

interface VignetteInfo {
  title?: string
  scenarioDescription: string
  imageFile?: string
  imageMaxWidth?: string
  voiceEnabled?: boolean
  voice?: string
  speakerVoices?: Record<string, string>
  tabSections?: Record<string, ContentSection[]>
}
interface LanguagesJson {
  languages: LanguageDef[]
  ui: Record<string, LanguageUISection>
  vignetteInfo?: Record<string, VignetteInfo>
  tabs?: TabDefinition[]
}

// Placeholder informed consent, shown on the welcome page only when a project's
// languages.json supplies no consentParagraphs of its own.
//
// This is NOT approved consent text for any study. It is a structural example with
// bracketed placeholders, and the brackets are deliberate: a project that ships
// without its own IRB-approved text will display them, which fails loudly instead
// of silently presenting another study's consent to participants. Every project
// MUST override this. See CREATING-A-PROJECT.md.
const DEFAULT_CONSENT_PARAGRAPHS: string[] = [
  'You are being asked to take part in a research study.',
  'This research is being conducted to learn about the performance of health care providers. Specifically, we are interested in learning about how health care providers elicit diagnostic information from patients when making management decisions. You are being asked to participate in this research because you are a health care provider.',
  'Your participation in this study is voluntary and you may withdraw your participation at any time for any reason.',
  'If you take part in this study, you will be asked to converse with an LLM-generated \u201csimulated patient\u201d until you feel prepared to form an initial diagnosis and treatment plan. Specifically, you may ask the LLM \u201cpatient\u201d any number of questions about their health, including asking for the results of simulated physical examinations and laboratory tests. You may be presented with a maximum of five conversations, and you may choose to complete as many as you like. Participating in all five is expected to take no more than an hour.',
  'The possible risks of participating in this study include the breach of confidentiality, meaning that your responses may be associated with your identity. If you were referred to this study from another program in which you are participating, that program may receive your responses associated with your personal identity. Your responses will also be shared anonymously with non-academic third parties, including the LLM service provider, for analytical and commercial purposes. Only anonymized data will be used in AI-related activities, and no automated decision-making will occur that could directly affect you. You may also feel uncomfortable making difficult choices about the patient\u2019s care.',
  'We cannot promise any benefits to you or others from your taking part in this research. However, possible benefits include importance of knowledge to be gained for improving the quality of medical care for patients or provider populations at large.',
  'You can decline to participate in any part of this study for any reason and can end your participation at any time.',
  'If you have any questions about this study, you can contact [STUDY CONTACT NAME] at [INSTITUTION] at [PHONE].',
  'Thank you again for your time and participation. Please print or save this information now to retain a copy.',
];

// API functions
const fetchVignettes = async (uid?: string | null): Promise<string[]> => {
  const url = uid ? api(`/api/vignettes?uid=${encodeURIComponent(uid)}`) : api('/api/vignettes');
  const response = await apiFetch(url);
  if (!response.ok) throw new Error('Failed to fetch vignettes');
  const data = await response.json();
  return data.vignetteKeys;
};

interface ChatResponse {
  message: string;
  followups?: string[];
  beyondScope?: boolean;
  caseTemplate?: string | null;
  usage?: unknown;
}

const sendMessage = async ({ messages, vignetteKey, language, sessionToken }: {
  messages: Message[];
  vignetteKey: string;
  language?: string | null;
  sessionToken?: string | null;
}): Promise<ChatResponse> => {
  const response = await apiFetch(api('/api/chat'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, vignetteKey, language, sessionToken }),
  });
  if (!response.ok) throw new Error('Failed to send message');
  return response.json();
};

// Chat Component
function ChatInterface() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [formSubmitted, setFormSubmitted] = useState(false);
  const [selectedVignetteKey, setSelectedVignetteKey] = useState<string | null>(null);
  const [vignetteKeys, setVignetteKeys] = useState<string[]>([]);
  const [currentVignetteIndex, setCurrentVignetteIndex] = useState<number>(0);
  const [showEndScreen, setShowEndScreen] = useState(false);
  const [showTransition, setShowTransition] = useState(false);
  const [formReloadKey, setFormReloadKey] = useState(0);
  const [transcriptToken, setTranscriptToken] = useState<string | null>(null);
  const [sessionTokens, setSessionTokens] = useState<string[]>(() => {
    try {
      const stored = sessionStorage.getItem('sessionTokens');
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });
  const [showGradingScreen, setShowGradingScreen] = useState(false);
  const [langs, setLangs] = useState<LanguagesJson | null>(null);
  const [selectedLanguageCode, setSelectedLanguageCode] = useState<string>(() => {
    try {
      return resolveInitialLanguage(
        window.location.search,
        localStorage.getItem('lang_code'),
        navigator.languages ?? [navigator.language],
      );
    } catch { return 'en' }
  });
  const [hasStarted, setHasStarted] = useState(false);
  const [caseTemplate, setCaseTemplate] = useState<string | null>(null);
  const [caseTemplateLoaded, setCaseTemplateLoaded] = useState(false);
  const [mobileActivePanel, setMobileActivePanel] = useState<'chat' | 'form'>('chat');
  const [activeTabId, setActiveTabId] = useState<string>('form');
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [realtimeEnabled, setRealtimeEnabled] = useState(false);
  const [selectedVoice, setSelectedVoice] = useState('nova');
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [voiceMuted, setVoiceMuted] = useState(false);
  // Holds the whole assistant Message (not just its text) so per-message flags
  // such as beyondScope survive the voice path and land on the flushed bubble.
  const [pendingAssistantMessage, setPendingAssistantMessage] = useState<Message | null>(null);
  const [awaitingTTS, setAwaitingTTS] = useState(false);
  // Tabs fetched from /api/tabs (new pattern: tab structure in project.json, content in separate files).
  // When null, falls back to legacy langs.tabs pattern.
  const [apiTabs, setApiTabs] = useState<TabDefinition[] | null>(null);
  // Formless mode: project has no Kobo form; we skip the auto-added form tab.
  const [formless, setFormless] = useState(false);
  // skipWelcome: the project boots straight into chat; the welcome page's two
  // jobs (language choice, consent notice) move into ChatNoticeBar. configLoaded
  // gates the welcome renders so a slow /api/config can't flash the welcome page
  // on a skipWelcome project — and a FAILED /api/config still degrades to the
  // normal welcome rather than a blank screen.
  const [skipWelcome, setSkipWelcome] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  // Course access gate. `requireAccessCode` comes from /api/config; `unlocked`
  // starts true when a token is already held, so a returning student never sees
  // the gate. A token the server has since rejected surfaces as a 401 on the
  // first content request, which flips this back to false.
  const [requireAccessCode, setRequireAccessCode] = useState(false);
  // chatOnly: the project has no second panel at all — no tabs, no form, no
  // document view. The chat becomes a single centered column at every width.
  // ppol5013 is chat-only because its corpus is copyrighted: there is no
  // reading text to put in a side panel, and an empty pane is worse than none.
  const [chatOnly, setChatOnly] = useState(false);
  const [unlocked, setUnlocked] = useState<boolean>(() => !!getAccessToken());
  // Whether the gated endpoints (/api/tabs, /api/vignettes, /api/project-content)
  // will answer us. Every fetch of one must wait on this. React runs a component's
  // effects even when it early-returns the gate instead of the app, so without
  // this the tab fetch fires behind the gate, takes a 401, and never retries --
  // which is exactly how the form panel ended up rendering for a formless project.
  // A code supplied in the URL fragment is redeemed before the gate is ever
  // shown. Held in state rather than read on each render, because the redemption
  // effect scrubs the fragment and a re-read after that would find nothing.
  const [urlAccessCode, setUrlAccessCode] = useState<string | null>(() => readAccessCodeFromUrl());
  const [redeemingUrlCode, setRedeemingUrlCode] = useState<boolean>(() => !!urlAccessCode);
  const accessReady = configLoaded && (!requireAccessCode || unlocked);
  // Document-reference linking: when a project declares `docRefs`, references in
  // an assistant answer ("Section 4.1", "Phụ lục 7.1") become clickable and jump
  // the document tab to that passage. Absent this config the feature is off and
  // assistant messages render exactly as before. See doc-refs.ts.
  const [docRefs, setDocRefs] = useState<DocRefsConfig | null>(null);
  // A clicked reference asks the target document tab to scroll; the bumped nonce
  // re-triggers the jump even when the same anchor is clicked twice.
  const [docScrollTarget, setDocScrollTarget] = useState<{ tabId: string; anchor: string; nonce: number } | null>(null);
  // The same click, aimed at the PDF edition instead: which pdf tab, which
  // 1-based page, and a nonce so the same page can be re-requested.
  const [pdfScrollTarget, setPdfScrollTarget] = useState<{ tabId: string; page: number; nonce: number } | null>(null);
  // anchor -> 1-based PDF page, from the PDF tab's page map. Null until the map
  // has loaded (or if it never does), and the chips render exactly as they did
  // before it arrived — so a jump is never delayed waiting on this.
  const [pdfAnchorPages, setPdfAnchorPages] = useState<Record<string, number> | null>(null);
  const pdfMapRequestedRef = useRef<string | null>(null);
  // A clicked legal-document reference asks the legal-library tab to select that
  // document; the bumped nonce re-triggers even for the same document.
  const [legalSelectTarget, setLegalSelectTarget] = useState<{ docId: string; nonce: number } | null>(null);
  // Drag-drop allocation widget: project-specific opt-in for transforming
  // three select_one fields into a drag-drop assignment UI.
  const [dragDropAllocation, setDragDropAllocation] = useState(false);
  // Whether to show the grading screen after the last case (project enableFeedback; defaults on).
  const [feedbackEnabled, setFeedbackEnabled] = useState(true);
  // Inline follow-up suggestions returned by /api/chat (only populated when the project
  // sets enableFollowups=true). Rendered as clickable chips above the input box.
  const [followups, setFollowups] = useState<string[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const selectedVoiceRef = useRef(selectedVoice);
  // Multi-clip TTS playback: each synthesis run gets a fresh id; a stale id
  // tells an in-flight playback chain that a newer message superseded it.
  const ttsPlaybackIdRef = useRef(0);
  // Synchronous mirror of voiceMuted for the playback chain (state is stale
  // inside long-lived async closures).
  const voiceMutedRef = useRef(voiceMuted);
  // Guard against double-submit: isLoading state lags by a render, so rapid Enter+click
  // can bypass the isLoading check. This ref updates synchronously.
  const sendInFlightRef = useRef(false);
  const wipEnabled = useMemo(() => new URLSearchParams(window.location.search).has('wip'), []);
  const resolvedTabs = useMemo(() => {
    // Prefer tabs from /api/tabs (new pattern); fall back to legacy langs.tabs (CBS pattern).
    const source = (apiTabs && apiTabs.length > 0) ? apiTabs : (langs?.tabs ?? null);
    if (!source) return null;
    // Per-vignette visibility: hide tabs whose showForVignetteKeys doesn't include the current vignette.
    const tabs = source.filter(tab => {
      if (!tab.showForVignetteKeys || tab.showForVignetteKeys.length === 0) return true;
      return !!selectedVignetteKey && tab.showForVignetteKeys.includes(selectedVignetteKey);
    });
    // Auto-add a form tab unless the project declares formless mode or already has one.
    if (!formless && !tabs.some(t => t.type === 'form')) {
      tabs.push({ id: 'form', label: 'Assessment', type: 'form', pinned: true, order: 999 });
    }
    // Fold any id declared twice into one tab with two views (see mergeTabViews)
    // BEFORE sorting, so declaration order — not the two entries' `order` values —
    // is what decides which view a merged tab opens on.
    return mergeTabViews(tabs).sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  }, [langs, apiTabs, formless, selectedVignetteKey]);
  const hasTabs = resolvedTabs !== null;
  // Starter questions come from languages.json (chat.starterQuestions), so they
  // localize with everything else and need no extra endpoint.
  const starterQuestions = useMemo<string[]>(() => {
    const code = selectedLanguageCode || 'en';
    const raw = (langs?.ui?.[code]?.chat as { starterQuestions?: unknown } | undefined)?.starterQuestions
      ?? (langs?.ui?.['en']?.chat as { starterQuestions?: unknown } | undefined)?.starterQuestions;
    return Array.isArray(raw) ? raw.filter((q): q is string => typeof q === 'string') : [];
  }, [langs, selectedLanguageCode]);
  // Which tabs exist — not their contents. Switching vignette changes the set
  // (TEECH reveals its Physical Exams tab that way, and relies on the reselect
  // below to bring it forward); switching language only swaps each tab's content,
  // and must leave the reader where they were.
  const tabIdsKey = resolvedTabs?.map(t => t.id).join('|') ?? '';
  useEffect(() => {
    if (resolvedTabs && resolvedTabs.length > 0) {
      setActiveTabId(resolvedTabs[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabIdsKey]);
  // Mount a tab's content only after its tab has been activated once, then keep
  // it mounted (TabPanel hides inactive tabs with display:none, so scroll
  // position etc. survive tab switches exactly as before). Without this, every
  // hidden tab eagerly fetched its payload at startup — for haivn_eip that was
  // the 5 MB EIP PDF + pdf.js worker and the first legal document's full text.
  const [visitedTabIds, setVisitedTabIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    setVisitedTabIds(prev => (prev.has(activeTabId) ? prev : new Set(prev).add(activeTabId)));
  }, [activeTabId]);
  // Which view a merged document tab is showing (see mergeTabViews). Absent
  // means "the primary view", i.e. whichever edition the project declared first —
  // the PDF, for haivn_eip's EIP tab. Held here rather than inside the panel
  // because a clicked citation both selects the tab and chooses the edition.
  const [tabViews, setTabViews] = useState<Record<string, DualViewKind>>({});
  // The same defer-until-first-opened rule visitedTabIds applies to tabs, applied
  // to the second view of a merged tab: keyed `${tabId}:${view}`. The primary
  // view is always mounted with the tab, so only the alt view appears here.
  const [visitedViewKeys, setVisitedViewKeys] = useState<Set<string>>(new Set());
  const setTabView = useCallback((tabId: string, view: DualViewKind) => {
    setTabViews(prev => (prev[tabId] === view ? prev : { ...prev, [tabId]: view }));
    // Mounted in the SAME commit as the view change, deliberately: a citation
    // that opens the text edition needs the panel mounted with its scroll target
    // already in place, not one render later.
    setVisitedViewKeys(prev => {
      const key = `${tabId}:${view}`;
      return prev.has(key) ? prev : new Set(prev).add(key);
    });
  }, []);
  // Build the document-reference matcher from the anchors actually present in the
  // target document tab. Deriving the valid-anchor set from the loaded markdown
  // (rather than a hardcoded list) means a link can only point at a passage that
  // exists, and the set is identical across languages for numbered sections — so
  // a Vietnamese answer's "Mục 4.1" resolves to the same anchor as "Section 4.1".
  // The legal-library tab (if any) and a map of its document numbers -> ids, so a
  // legal instrument the advisor names ("Quyết định 1740/QĐ-BYT") becomes a link
  // that opens that document in the library. Only numbers actually in the registry
  // resolve, so an invented citation stays plain text.
  const legalTab = useMemo(() => resolvedTabs?.find(t => t.type === 'library') ?? null, [resolvedTabs]);
  const legalNumberToId = useMemo(() => {
    const map = new Map<string, string>();
    const docs = (legalTab?.content as { documents?: Array<{ id: string; number?: string }> } | null | undefined)?.documents;
    // Only real instrument numbers (they contain a "/", e.g. 1740/QĐ-BYT) — skips
    // the WHO reports whose "number" is a descriptive title, not a citable number.
    if (docs) for (const d of docs) if (d.number && d.number.includes('/')) map.set(d.number, d.id);
    return map;
  }, [legalTab]);
  const docRefMatcher = useMemo(() => {
    if (!docRefs) return null;
    const tab = resolvedTabs?.find(t => t.id === docRefs.tabId);
    // The markdown may sit on the tab itself or on its alt view (a merged
    // PDF+text tab), and the anchors must be known either way: they are what
    // decides whether a citation becomes a link at all, long before the reader
    // has opened — or even seen — the text edition.
    const markdown = tabMarkdown(tab);
    const anchors = markdown ? extractAnchorIds(markdown) : new Set<string>();
    return buildDocRefMatcher(docRefs, anchors, legalNumberToId);
  }, [docRefs, resolvedTabs, legalNumberToId]);
  // The PDF edition of the same document, and the page map beside it. Both are
  // optional: with no pdf tab, or no map file, document references behave
  // exactly as they did before this feature existed.
  // `tabHasPdf`, not `type === 'pdf'`: on a merged tab the PDF may be the alt
  // view, and a citation must still be able to open it.
  const pdfTab = useMemo(() => resolvedTabs?.find(tabHasPdf) ?? null, [resolvedTabs]);
  const pdfTabMapUrl = useMemo(() => {
    const url = tabPdfUrl(pdfTab);
    const rel = url ? pdfPageMapUrl(url) : null;
    return rel ? `${import.meta.env.VITE_API_BASE_URL || ''}${rel}` : null;
  }, [pdfTab]);
  // Load the map lazily — on the first answer that actually cites a passage,
  // not at startup — and only once per PDF edition. Until it lands (or if it
  // never does) the chips keep today's text-tab behavior, so nothing waits on
  // this fetch and nothing flashes when it fails.
  useEffect(() => {
    if (!pdfTabMapUrl || !docRefMatcher) return;
    if (pdfMapRequestedRef.current === pdfTabMapUrl) return;
    const cites = messages.some(m => m.role === 'assistant' && docRefMatcher(m.content).some(s => !!s.anchor));
    if (!cites) return;
    pdfMapRequestedRef.current = pdfTabMapUrl;
    let cancelled = false;
    apiFetch(pdfTabMapUrl)
      .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
      .then((json: { anchors?: Record<string, number> }) => {
        const anchors = json && typeof json === 'object' ? json.anchors : null;
        if (!cancelled && anchors && typeof anchors === 'object') setPdfAnchorPages(anchors);
      })
      .catch(() => { /* no map: text-tab jumps, as before */ });
    return () => { cancelled = true; };
  }, [pdfTabMapUrl, docRefMatcher, messages]);
  // A language switch swaps the PDF edition, and with it the page map.
  useEffect(() => { setPdfAnchorPages(null); }, [pdfTabMapUrl]);
  const userPrefillParams = useMemo<string | null>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const valuesList = params.getAll('values').map(v => v.trim()).filter(Boolean);
      if (valuesList.length === 0) return null;
      const joined = valuesList.join('&').replace(/^&+/, '');
      return joined.length > 0 ? joined : null;
    } catch {
      return null;
    }
  }, []);
  
  // Extract uid from URL values parameter (format: ?values=d[uid]=xxx)
  const userUid = useMemo<string | null>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const valuesList = params.getAll('values').map(v => v.trim()).filter(Boolean);
      for (const value of valuesList) {
        // Look for d[uid]=xxx pattern
        const match = value.match(/d\[uid\]=([^&]*)/);
        if (match && match[1]) {
          return decodeURIComponent(match[1]);
        }
      }
      return null;
    } catch {
      return null;
    }
  }, []);
  
  const transcriptTokenRef = useRef<string | null>(null);

  const selectedLanguageName = useMemo(() => {
    const list = langs?.languages || [];
    const found = list.find((l: LanguageDef) => l.code === selectedLanguageCode);
    // If selected code not found, fall back to first language or 'English'
    return found?.name || list[0]?.name || 'English';
  }, [langs, selectedLanguageCode]);

  // Load languages on mount (via API, with static file fallback)
  useEffect(() => {
    apiFetch(api('/api/languages'))
      .then(res => res.json())
      .then((data: LanguagesJson) => setLangs(data))
      .catch(() => {
        // Fallback to static file for backward compatibility.
        // Base-aware: under per-project GitHub Pages builds BASE_URL is
        // "/<project>/" and a root-absolute path would 404; in dev it is "/".
        fetch(`${import.meta.env.BASE_URL}languages.json`)
          .then(res => res.json())
          .then((data: LanguagesJson) => setLangs(data))
          .catch(() => setLangs(null));
      });
  }, []);

  // Load case template on mount
  // NOTE: caseTemplate is loaded from /api/chat response when conversation starts
  // (removed the /api/kobo-url fetch that was returning full JSON instead of just template name)

  // Set document title from welcome title
  useEffect(() => {
    const title = langs?.ui?.[selectedLanguageCode]?.welcome?.title
      || langs?.ui?.[langs.languages?.[0]?.code]?.welcome?.title;
    if (title) document.title = title;
  }, [langs, selectedLanguageCode]);

  // Persist language selection
  useEffect(() => {
    try { localStorage.setItem('lang_code', selectedLanguageCode) } catch {}
  }, [selectedLanguageCode]);

  // Auto-correct language code if it doesn't exist in the loaded languages
  useEffect(() => {
    if (!langs || !langs.languages || langs.languages.length === 0) return;
    
    const codeExists = langs.languages.some((l: LanguageDef) => l.code === selectedLanguageCode);
    if (!codeExists && langs.languages.length > 0) {
      // Current code not found, switch to first available language
      console.log(`Language code '${selectedLanguageCode}' not found, switching to '${langs.languages[0].code}'`);
      setSelectedLanguageCode(langs.languages[0].code);
    }
  }, [langs, selectedLanguageCode]);

  // Reload form when UI language changes (only after start)
  useEffect(() => {
    if (!hasStarted) return;
    setFormReloadKey((prev: number) => prev + 1);
  }, [hasStarted, selectedLanguageCode]);

  // Fetch project config to check enableVoice + formless mode
  useEffect(() => {
    apiFetch(api('/api/config'))
      .then(res => res.json())
      .then(data => {
        if (data.enableVoice) setVoiceEnabled(true);
        if (data.enableRealtime) setRealtimeEnabled(true);
        if (data.formless) setFormless(true);
        if (data.skipWelcome) setSkipWelcome(true);
        if (data.dragDropAllocation) setDragDropAllocation(true);
        if (data.requireAccessCode) setRequireAccessCode(true);
        if (data.chatOnly) setChatOnly(true);
        if (data.enableFeedback === false) setFeedbackEnabled(false);
        if (data.docRefs && typeof data.docRefs === 'object' && typeof data.docRefs.tabId === 'string') {
          setDocRefs(data.docRefs as DocRefsConfig);
        }
        setConfigLoaded(true);
      })
      .catch(() => { setConfigLoaded(true); });
  }, []);

  // Changing only the fragment is a same-document navigation: the SPA does not
  // reload and nothing remounts. A student already on the page who follows a
  // coded Canvas link would otherwise never have it redeemed.
  useEffect(() => {
    const onHashChange = () => {
      const code = readAccessCodeFromUrl();
      if (!code) return;
      setUrlAccessCode(code);
      setRedeemingUrlCode(true);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Redeem a URL-supplied access code. Runs before the gate can render, and
  // scrubs the fragment either way — a code left in the address bar is
  // shoulder-surfable and would be re-submitted on every reload.
  //
  // It runs even when a token is already held, which is the point: in a
  // third-party iframe Safari may have dropped the stored token since the last
  // visit, and re-redeeming costs one request and always leaves us with a fresh
  // one.
  useEffect(() => {
    if (!configLoaded) return;
    if (!urlAccessCode) return;
    if (!requireAccessCode) {
      // Nothing to redeem it against; still take it out of the address bar.
      scrubAccessCodeFromUrl();
      setRedeemingUrlCode(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(api('/api/access'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: urlAccessCode }),
        });
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok && data?.token) {
          setAccessToken(data.token);
          setUnlocked(true);
        }
      } catch {
        /* fall through to the manual gate */
      } finally {
        scrubAccessCodeFromUrl();
        if (!cancelled) setRedeemingUrlCode(false);
      }
    })();
    return () => { cancelled = true; };
  }, [configLoaded, requireAccessCode, urlAccessCode]);

  // skipWelcome projects boot straight into chat once languages are loaded —
  // the welcome page's two jobs (language choice, consent notice) live in
  // ChatNoticeBar instead. Mirrors onStart minus the audio unlock (which
  // needs a user gesture and only matters for voice projects).
  useEffect(() => {
    if (!skipWelcome || hasStarted || !langs) return;
    sessionStorage.removeItem('sessionTokens');
    setSessionTokens([]);
    setHasStarted(true);
  }, [skipWelcome, hasStarted, langs]);

  // Fetch tabs from /api/tabs (new pattern). Falls through to legacy langs.tabs if empty.
  // Re-fetched on language change: a tab's contentFile may be declared per language
  // (haivn_eip serves the EIP document and its text in both English and Vietnamese),
  // and the backend resolves which file to send from ?lang.
  useEffect(() => {
    if (!accessReady) return;
    let cancelled = false;
    apiFetch(api(`/api/tabs?lang=${encodeURIComponent(selectedLanguageCode || 'en')}`))
      .then(res => res.json())
      .then(data => {
        if (!cancelled && Array.isArray(data.tabs) && data.tabs.length > 0) {
          setApiTabs(data.tabs);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedLanguageCode, accessReady]);

  // Keep voice refs in sync
  useEffect(() => { selectedVoiceRef.current = selectedVoice; }, [selectedVoice]);
  useEffect(() => { voiceMutedRef.current = voiceMuted; }, [voiceMuted]);

  // Per-vignette voice gate: project-level `enableVoice` is the master switch,
  // but each vignette must also opt in via `vignetteInfo[key].voiceEnabled` so
  // bland cases don't get TTS auto-play when paired with voice variants.
  const currentVignetteInfo = selectedVignetteKey ? langs?.vignetteInfo?.[selectedVignetteKey] : undefined;
  const currentVignetteVoice = !!(voiceEnabled && currentVignetteInfo?.voiceEnabled);
  // A pre-assigned voice (e.g. "onyx") disables the voice-picker dropdown so
  // respondents can't change the demographic profile mid-study.
  const assignedVoice = currentVignetteInfo?.voice;
  const hasAssignedVoice = typeof assignedVoice === 'string' && assignedVoice.length > 0;

  // TTS: fetch audio for pending assistant message, then reveal text + play simultaneously.
  // When voice is disabled or muted, the message is flushed to chat immediately.
  useEffect(() => {
    if (!pendingAssistantMessage) return;

    // If muted or voice not active, flush text immediately
    if (voiceMuted || !currentVignetteVoice) {
      setMessages(prev => [...prev, pendingAssistantMessage]);
      setPendingAssistantMessage(null);
      setAwaitingTTS(false);
      setIsLoading(false);
      sendInFlightRef.current = false;
      return;
    }

    // Stop any currently playing audio
    if (audioRef.current) {
      audioRef.current.pause();
    }

    setAwaitingTTS(true);
    let cancelled = false;
    // Supersede any playback chain still running from a previous message.
    ttsPlaybackIdRef.current += 1;
    const playbackId = ttsPlaybackIdRef.current;

    (async () => {
      try {
        // Split the message into per-role segments (role prefixes stripped —
        // the visible chat text keeps them) and synthesize each with its
        // speaker's voice. A single-role message yields one segment → one
        // request, exactly as before.
        const patientVoice = assignedVoice || selectedVoiceRef.current;
        const speakerVoices = currentVignetteInfo?.speakerVoices;
        const segments = splitRoleSegments(
          pendingAssistantMessage.content,
          speakerVoices ? Object.keys(speakerVoices) : [],
        );
        if (segments.length === 0) {
          // Nothing speakable — flush the text without audio.
          setMessages(prev => [...prev, pendingAssistantMessage]);
          setPendingAssistantMessage(null);
          setAwaitingTTS(false);
          setIsLoading(false);
          sendInFlightRef.current = false;
          return;
        }

        // Issue requests in segment order; fetch all clips before revealing text.
        const responses = await Promise.all(segments.map(seg =>
          apiFetch(api('/api/tts'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: seg.text,
              voice: resolveSegmentVoice(seg, patientVoice, speakerVoices),
            }),
          })
        ));
        if (responses.some(r => !r.ok)) throw new Error('TTS request failed');
        if (cancelled) return;

        const urls: string[] = [];
        for (const r of responses) {
          urls.push(URL.createObjectURL(await r.blob()));
        }
        // Re-check after the blob awaits: a mute/voice change mid-download
        // reveals the message via the cancelled path, and revealing again
        // here would duplicate the assistant bubble.
        if (cancelled) {
          urls.forEach(u => URL.revokeObjectURL(u));
          return;
        }

        const audio = audioRef.current || new Audio();
        audioRef.current = audio;

        // Reveal text + start audio simultaneously
        setMessages(prev => [...prev, pendingAssistantMessage]);
        setPendingAssistantMessage(null);
        setAwaitingTTS(false);
        setIsLoading(false);
        sendInFlightRef.current = false;
        setIsPlayingAudio(true);
        try {
          // Play clips sequentially, in segment order. Stop cleanly if the
          // user mutes (mute button pauses the element → current clip
          // resolves) or a newer message starts its own chain (stale id).
          for (const url of urls) {
            if (ttsPlaybackIdRef.current !== playbackId || voiceMutedRef.current) break;
            await playClip(audio, url);
          }
        } catch (playErr) {
          // Autoplay blocked or device error — text already shown, just clear audio state
          console.error('Audio play error:', playErr);
        } finally {
          urls.forEach(u => URL.revokeObjectURL(u));
          if (ttsPlaybackIdRef.current === playbackId) {
            setIsPlayingAudio(false);
          }
        }
      } catch (err) {
        console.error('TTS error:', err);
        if (!cancelled) {
          // Graceful fallback: show text without audio
          setMessages(prev => [...prev, pendingAssistantMessage]);
          setPendingAssistantMessage(null);
          setAwaitingTTS(false);
          setIsLoading(false);
          sendInFlightRef.current = false;
          setIsPlayingAudio(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [pendingAssistantMessage, voiceMuted, currentVignetteVoice]);

  // Tiny translation helper
  function t<S extends 'welcome' | 'chat' | 'feedback', K extends keyof NonNullable<LanguageUISection[S]>>(section: S, key: K): string {
    const code = selectedLanguageCode || 'en';
    const localized = langs?.ui?.[code]?.[section] as LanguageUISection[S] | undefined;
    const fallback = langs?.ui?.['en']?.[section] as LanguageUISection[S] | undefined;
    const value = (localized?.[key] ?? fallback?.[key]) as unknown;
    return typeof value === 'string' ? (value as string) : '';
  }

  // Load vignettes only after the user starts (filtered by uid if present)
  useEffect(() => {
    if (!hasStarted || !accessReady) return;
    fetchVignettes(userUid)
      .then(keys => {
        setVignetteKeys(keys);
        if (keys.length > 0) {
          setCurrentVignetteIndex(0);
          setSelectedVignetteKey(keys[0]);
        }
        console.log('Vignette keys loaded successfully', userUid ? `for uid: ${userUid}` : '(all vignettes)');
      })
      .catch(error => {
        console.error('Error loading vignette keys:', error);
      });
  }, [hasStarted, userUid, accessReady]);

  // Initialize conversation when vignette keys are loaded (only after start)
  useEffect(() => {
    if (hasStarted && selectedVignetteKey && !initialized) {
      initializeConversation();
    }
  }, [hasStarted, selectedVignetteKey, initialized]);

  // Generate a new transcript token whenever the form reloads (only after start)
  useEffect(() => {
    if (!hasStarted) return;
    const generateToken = (): string => {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    };
    const token = generateToken();
    setTranscriptToken(token);
  }, [hasStarted, formReloadKey]);

  // Keep a ref to the latest token for event handlers
  useEffect(() => {
    transcriptTokenRef.current = transcriptToken;
  }, [transcriptToken]);

  // Called by NativeKoboForm when submission succeeds
  const handleFormSubmitted = async () => {
    try {
      const token = transcriptTokenRef.current;
      if (token && messages.length > 0) {
        const transcript = serializeTranscriptText();
        const resp = await apiFetch(api('/api/kobo-transcript'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, transcript })
        });

        if (!resp.ok) {
          console.error(`Transcript persistence failed (${resp.status}) — skipping grading for this token`);
        } else {
          // Only track token for grading if transcript was successfully persisted
          const updatedTokens = [...sessionTokens, token];
          setSessionTokens(updatedTokens);
          sessionStorage.setItem('sessionTokens', JSON.stringify(updatedTokens));
        }
      }
    } catch (err) {
      // non-fatal: transcript stays as token in Kobo
      console.error('Failed to write transcript to Kobo:', err);
    } finally {
      setFormSubmitted(true);
    }
  };

  // Show transition screen then advance to next case after form submission
  useEffect(() => {
    if (formSubmitted) {
      setShowTransition(true);
      // If transitionContinue is defined, wait for user click instead of auto-advancing
      if (!t('chat', 'transitionContinue')) {
        const timer = setTimeout(() => {
          setShowTransition(false);
          handleNextCase();
        }, 2500);
        return () => clearTimeout(timer);
      }
    }
  }, [formSubmitted]);

  // No persistence for ordered progress; always start from the first vignette per session

  const initializeConversation = async () => {
    if (!selectedVignetteKey) return;

    // If a hardcoded opening message is defined for this project, use it directly
    // and skip the LLM greeting roundtrip. This gives a stable, predictable first turn.
    const langChat = (langs?.ui?.[selectedLanguageCode]?.chat ?? langs?.ui?.['en']?.chat ?? {}) as Record<string, unknown>;
    const hardcodedOpening = typeof langChat.openingMessage === 'string' ? langChat.openingMessage.trim() : '';
    if (hardcodedOpening) {
      if (currentVignetteVoice && !voiceMuted) {
        setIsLoading(true);
        setPendingAssistantMessage({ role: 'assistant', content: hardcodedOpening });
      } else {
        setMessages([{ role: 'assistant', content: hardcodedOpening }]);
      }
      setCaseTemplateLoaded(true);
      setInitialized(true);
      return;
    }

    try {
      setIsLoading(true);
      const response = await sendMessage({
        messages: [{ role: 'user', content: 'Please begin the conversation as instructed.' }],
        vignetteKey: selectedVignetteKey,
        language: selectedLanguageName,
        sessionToken: transcriptToken,
      });

      // The greeting turn is generated from the project's own prompt, so it is
      // never marked as going beyond the reference content.
      const opening: Message = { role: 'assistant', content: response.message };
      if (currentVignetteVoice && !voiceMuted) {
        setPendingAssistantMessage(opening);
        // isLoading stays true; TTS useEffect will clear it
      } else {
        setMessages([opening]);
        setIsLoading(false);
      }
      if (response.caseTemplate) {
        setCaseTemplate(response.caseTemplate);
      }
      setCaseTemplateLoaded(true);
      setInitialized(true);
    } catch (error) {
      console.error('Error initializing conversation:', error);
      setMessages([{
        role: 'assistant',
        content: 'Error starting conversation. Please check your connection and try again.'
      }]);
      setIsLoading(false);
    }
  };

  const handleNextCase = () => {
    if (vignetteKeys.length === 0) return;
    const nextIndex = currentVignetteIndex + 1;
    if (nextIndex >= vignetteKeys.length) {
      // End reached; show grading screen, or go straight to the end screen when feedback is disabled
      if (feedbackEnabled) {
        setShowGradingScreen(true);
      } else {
        setShowEndScreen(true);
        sessionStorage.removeItem('sessionTokens');
      }
      const mainContainer = document.querySelector('.main-container') as HTMLElement | null;
      if (mainContainer) mainContainer.style.display = 'none';
      return;
    }
    const nextKey = vignetteKeys[nextIndex];
    setCurrentVignetteIndex(nextIndex);
    setSelectedVignetteKey(nextKey);
    setMessages([]);
    setPendingAssistantMessage(null);
    setAwaitingTTS(false);
    setInput('');
    setFollowups([]);
    setInitialized(false);
    setFormSubmitted(false);
    // Force the form to remount with fresh state
    setFormReloadKey((prev: number) => prev + 1);
  };

  // handleSendMessage accepts an optional overrideText — used by clickable
  // suggested questions, which bypass the input box and send directly.
  const handleSendMessage = async (overrideText?: string) => {
    const messageText = (typeof overrideText === 'string' ? overrideText : input).trim();
    if (!messageText || !selectedVignetteKey) return;
    // Ref-based guard prevents concurrent sends (state-based isLoading lags a render).
    if (sendInFlightRef.current) return;
    sendInFlightRef.current = true;

    const userMessage: Message = { role: 'user', content: messageText };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    if (typeof overrideText !== 'string') setInput('');
    setFollowups([]); // clear stale follow-ups from the previous turn
    setIsLoading(true);

    try {
      const response = await sendMessage({
        messages: newMessages,
        vignetteKey: selectedVignetteKey,
        language: selectedLanguageName,
        sessionToken: transcriptToken,
      });

      const assistantMessage: Message = {
        role: 'assistant',
        content: response.message,
        beyondScope: response.beyondScope === true,
      };
      if (currentVignetteVoice && !voiceMuted) {
        setPendingAssistantMessage(assistantMessage);
        // isLoading stays true; TTS useEffect will clear it + sendInFlightRef
      } else {
        setMessages(prev => [...prev, assistantMessage]);
        setIsLoading(false);
        sendInFlightRef.current = false;
      }
      if (Array.isArray(response.followups) && response.followups.length > 0) {
        setFollowups(response.followups);
      }
    } catch (error) {
      console.error('Error sending message:', error);
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Connection error. Please check your internet connection and try again.'
      }]);
      setIsLoading(false);
      sendInFlightRef.current = false;
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // Clicked suggested question: send directly as user message, bypass input box.
  // On mobile, also switch panels to the chat so the user sees their question land.
  const handleQuestionClick = (question: string) => {
    setMobileActivePanel('chat');
    handleSendMessage(question);
  };

  // Clicked document reference in an assistant answer: reveal the document tab
  // (desktop tab + mobile right panel) and ask it to scroll the passage in.
  const handleDocRefClick = (anchor: string) => {
    if (!docRefs) return;
    setActiveTabId(docRefs.tabId);
    setMobileActivePanel('form');
    // On a merged tab this also flips the edition: the anchor lives in the text.
    setTabView(docRefs.tabId, 'document');
    setDocScrollTarget({ tabId: docRefs.tabId, anchor, nonce: Date.now() });
  };

  // The same reference, opened in the PDF edition at the mapped page. This is
  // the primary action wherever the map knows the anchor.
  const handleDocRefPdfClick = (page: number) => {
    if (!pdfTab) return;
    setActiveTabId(pdfTab.id);
    setMobileActivePanel('form');
    setTabView(pdfTab.id, 'pdf');
    setPdfScrollTarget({ tabId: pdfTab.id, page, nonce: Date.now() });
  };

  // A legal-document reference: open the legal-library tab and select that document.
  const handleLegalRefClick = (docId: string) => {
    if (!legalTab) return;
    setActiveTabId(legalTab.id);
    setMobileActivePanel('form');
    setLegalSelectTarget({ docId, nonce: Date.now() });
  };

  // The two renderings of a document tab. Factored out because a merged tab
  // shows both behind one switcher and a plain tab shows one; two copies of
  // either panel's wiring is exactly how the PDF and text editions would drift
  // apart. `tabId` is the id the jump machinery addresses — on a merged tab both
  // views answer to the tab's own id, which is the point of merging them.
  //
  // Rendered with bundled pdf.js (not the browser's built-in viewer) so we
  // control link targets: every in-PDF external link becomes a real
  // <a target="_blank">, and there is no outline sidebar eating panel width.
  const renderPdfView = (view: TabDefinition, tabId: string, label: string) => {
    const pdfUrl = (view.content as { pdfUrl?: string } | null)?.pdfUrl;
    const pdfSrc = pdfUrl ? `${import.meta.env.VITE_API_BASE_URL || ''}${pdfUrl}` : '';
    if (!pdfSrc) return <p style={{ padding: '1rem' }}>PDF not available.</p>;
    return (
      <Suspense fallback={
        <div className="loading-form-wrapper">
          <p>{t('chat','loadingForm')}</p>
        </div>
      }>
        <PdfJsViewer
          src={pdfSrc}
          title={label}
          openLabel={(PDF_TAB_UI[selectedLanguageCode] ?? PDF_TAB_UI.en).openInNewTab}
          lang={selectedLanguageCode}
          jumpTarget={pdfScrollTarget?.tabId === tabId ? pdfScrollTarget : null}
        />
      </Suspense>
    );
  };

  const renderDocumentView = (view: TabDefinition, tabId: string) => (
    <DocumentPanel
      content={(view.content as { markdown?: string } | null) ?? null}
      lang={selectedLanguageCode}
      scrollTarget={docScrollTarget?.tabId === tabId ? docScrollTarget : null}
    />
  );

  // Render an assistant message, linking any recognized document references.
  // When the feature is off (no matcher) or nothing resolves, the raw string is
  // returned untouched, preserving the deliberate plain-text chat rendering — no
  // markdown. Segments are plain strings and <a> nodes built by React (never
  // innerHTML), so the model's text can't inject markup; the href is a validated
  // anchor id from doc-refs.ts.
  const renderAssistantContent = (text: string): React.ReactNode => {
    if (!docRefMatcher) return text;
    const refUi = DOC_REF_UI[selectedLanguageCode] ?? DOC_REF_UI.en;
    const segments = docRefMatcher(text);
    if (segments.length === 1 && !segments[0].anchor) return text;
    return segments.map((seg, i) => {
      if (seg.anchor) {
        const anchor = seg.anchor;
        const page = pdfTab && pdfAnchorPages ? pdfAnchorPages[anchor] : undefined;
        // With a mapped page, the PDF is the jump and the text edition is the
        // secondary affordance. Without one — no map, map not loaded yet, or an
        // anchor the map does not carry — this is exactly the old link.
        if (typeof page === 'number' && page > 0) {
          return (
            <span key={i} className="doc-ref-chip">
              <a
                href={`#${anchor}`}
                className="doc-ref-link"
                title={refUi.openPdf}
                onClick={(e) => { e.preventDefault(); handleDocRefPdfClick(page); }}
              >
                {seg.text}
              </a>
              <button
                type="button"
                className="doc-ref-alt"
                title={refUi.openText}
                onClick={() => handleDocRefClick(anchor)}
              >
                {refUi.text}
              </button>
            </span>
          );
        }
        return (
          <a
            key={i}
            href={`#${anchor}`}
            className="doc-ref-link"
            onClick={(e) => { e.preventDefault(); handleDocRefClick(anchor); }}
          >
            {seg.text}
          </a>
        );
      }
      if (seg.legalId) {
        const legalId = seg.legalId;
        return (
          <a
            key={i}
            href="#legal"
            className="doc-ref-link"
            onClick={(e) => { e.preventDefault(); handleLegalRefClick(legalId); }}
          >
            {seg.text}
          </a>
        );
      }
      return seg.text;
    });
  };

  const serializeTranscriptText = (): string => {
    const headerLines: string[] = [];
    headerLines.push('Transcript');
    headerLines.push(`Created: ${new Date().toISOString()}`);
    if (selectedVignetteKey) headerLines.push(`Vignette: ${selectedVignetteKey}`);
    const meta: Record<string, unknown> = { initialized, formSubmitted };
    headerLines.push(`Metadata: ${JSON.stringify(meta)}`);
    headerLines.push('');

    // Include any pending assistant message that hasn't been flushed to messages yet
    // (voice-enabled flow holds text until TTS audio is ready)
    const allMessages = pendingAssistantMessage
      ? [...messages, pendingAssistantMessage]
      : messages;
    const body = allMessages
      .map((m: { role: string; content: string }) => {
        const label = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'System';
        return `${label}:\n${m.content}`;
      })
      .join('\n\n');

    return headerLines.join('\n') + body + '\n';
  };

  const saveTranscript = async () => {
    if (messages.length === 0) return;
    setSaving(true);
    try {
      const response = await apiFetch(api('/api/transcripts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages,
          vignetteKey: selectedVignetteKey,
          metadata: { initialized, formSubmitted },
        }),
      });
      if (!response.ok) throw new Error('Failed to save transcript');
      const data = await response.json();
      console.log('Transcript saved:', data);
      alert('Transcript saved locally for QA.');
    } catch (err) {
      console.error(err);
      alert('Failed to save transcript.');
    } finally {
      setSaving(false);
    }
  };

  // Send to Kobo functionality removed

  // Keep the cursor in the input whenever loading finishes
  useEffect(() => {
    if (!isLoading) {
      // Defer to ensure DOM updates after disabled->enabled toggle.
      // preventScroll: focusing an element scrolls it into view by default, and
      // that scroll reaches the parent document when embedded in an iframe.
      setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0);
    }
  }, [isLoading]);
  
  // Auto-scroll to bottom when messages change or when loading. Scrolls the
  // message list itself, never scrollIntoView on a node — see scroll-list.ts:
  // scrollIntoView scrolls every scrollable ancestor, and inside the Canvas
  // iframe that includes the course page, which got dragged down on every reply.
  useEffect(() => {
    scrollListToBottom(messagesEndRef.current);
  }, [messages, isLoading]);

  // Access gate. Rendered instead of the app, after every hook above has run, so
  // the hook order is identical whether or not the gate is showing. It waits for
  // /api/config: gating on a flag we have not loaded yet would flash the gate at
  // every visitor of every ungated project.
  if (configLoaded && requireAccessCode && !unlocked && !redeemingUrlCode) {
    return (
      <AccessGate
        title={t('welcome', 'title') || 'Course access'}
        hint={t('welcome', 'accessHint')
          || 'Enter the access code from the course Canvas page.'}
        onUnlocked={() => setUnlocked(true)}
      />
    );
  }
  

  return (
    <>
    {/* Transition Screen Between Scenarios */}
    {showTransition && (
      <div className="transition-screen">
        <div className="transition-content">
          <div className="transition-check">&#10003;</div>
          <h2>{t('chat','submittedTitle') || 'Submitted successfully'}</h2>
          <p style={{whiteSpace: 'pre-line'}}>{t('chat','loadingNext') || 'Loading next scenario...'}</p>
          {t('chat', 'transitionContinue') && (
            <button className="transition-continue-btn" onClick={() => { setShowTransition(false); handleNextCase(); }}>
              {t('chat', 'transitionContinue')}
            </button>
          )}
        </div>
      </div>
    )}
    {/* Grading Screen */}
    {showGradingScreen && (
      <Suspense fallback={null}>
      <GradingScreen
        tokens={sessionTokens}
        language={selectedLanguageCode}
        translations={{
          loading: t('feedback', 'loading'),
          loadingDetail: t('feedback', 'loadingDetail') || 'This will take just a few seconds',
          explored: t('feedback', 'explored'),
          opportunities: t('feedback', 'opportunities'),
          complete: t('feedback', 'complete'),
          error: t('feedback', 'error'),
          continue: t('feedback', 'continue') || 'Continue',
        }}
        onComplete={() => {
          setShowGradingScreen(false);
          setShowEndScreen(true);
          sessionStorage.removeItem('sessionTokens');
        }}
      />
      </Suspense>
    )}
    {/* Final Thank You Screen */}
    <div className="end-screen" style={{ display: showEndScreen ? 'flex' : 'none' }}>
      <div className="end-content">
        <h1>{t('chat','thanksTitle') || 'Thank you!'}</h1>
        <p>{t('chat','endThankYouMessage') || 'You have completed all scenarios. Thank you for your participation. You may now close this page.'}</p>
      </div>
    </div>
    {!hasStarted && (!langs || !configLoaded) && (
      <div className="welcome-screen">
        <div className="welcome-content" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '200px' }}>
          <p>Loading...</p>
        </div>
      </div>
    )}
    {!hasStarted && langs && configLoaded && !skipWelcome && (() => {
      const code = selectedLanguageCode || 'en';
      const consentParagraphs: string[] = (langs?.ui?.[code]?.welcome?.consentParagraphs || langs?.ui?.['en']?.welcome?.consentParagraphs || DEFAULT_CONSENT_PARAGRAPHS) as string[];
      const bullets = (langs?.ui?.[code]?.welcome?.bullets || langs?.ui?.['en']?.welcome?.bullets || []) as string[];
      return (
        <WelcomeScreen
          title={t('welcome','title')}
          subtitle={t('welcome','subtitle')}
          instructionsLead={t('welcome','instructionsLead')}
          howItWorks={t('welcome','howItWorks')}
          bullets={bullets}
          bulletIcons={((langs?.ui?.[code]?.welcome as Record<string, unknown>)?.bulletIcons as string[] | undefined) ?? ((langs?.ui?.['en']?.welcome as Record<string, unknown>)?.bulletIcons as string[] | undefined)}
          consentParagraphs={consentParagraphs}
          consentHeading={(langs?.ui?.[code]?.welcome as Record<string, unknown>)?.consentHeading as string | undefined ?? (langs?.ui?.['en']?.welcome as Record<string, unknown>)?.consentHeading as string | undefined}
          getStartedLabel={t('welcome','getStarted')}
          languageLabel={t('welcome','languageLabel') || 'Language'}
          languages={(langs.languages?.length || 0) > 1 ? langs.languages : undefined}
          selectedLanguageCode={selectedLanguageCode}
          onLanguageChange={setSelectedLanguageCode}
          onStart={() => {
            // Clear any accumulated tokens from previous testing sessions
            sessionStorage.removeItem('sessionTokens');
            setSessionTokens([]);
            // Unlock audio on user gesture (required for mobile autoplay)
            if (voiceEnabled && !audioRef.current) {
              const audio = new Audio();
              audio.src = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAABhgC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAAYYAAAAAAAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAABhgC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAAYYAAAAAAAAAAAAAAAAAAAAA';
              audio.play().then(() => audio.pause()).catch(() => {});
              audioRef.current = audio;
            }
            setHasStarted(true);
            setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0);
          }}
        />
      );
    })()}
    
    {/* Opt-in entry to live voice mode, shown on the welcome screen when the
        project enables realtime. Navigates to ?mode=voice (preserving ?values=). */}
    {!hasStarted && langs && configLoaded && !skipWelcome && realtimeEnabled && (
      <button
        onClick={() => {
          const u = new URL(window.location.href);
          u.searchParams.set('mode', 'voice');
          window.location.href = u.toString();
        }}
        className="voice-entry-fab"
        style={{
          position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: 24, zIndex: 50,
          padding: '12px 20px', borderRadius: 999, border: '1px solid var(--border)',
          background: 'var(--bg-surface)', color: 'var(--accent)', fontWeight: 600, cursor: 'pointer',
          boxShadow: '0 4px 14px rgba(0,0,0,0.12)',
        }}
      >
        🎙 Prefer to talk? Start a voice conversation
      </button>
    )}

    {hasStarted && (
    <>
    {/* Mobile Toggle/Tab Bar - Only visible on screens < 768px.
        A chat-only project has no second panel, so there is nothing to toggle
        between and the strip would just eat vertical space on a phone. */}
    {chatOnly ? null : hasTabs ? (
      <div className="mobile-tab-strip">
        <TabBar
          tabs={[
            { id: 'chat', label: t('chat', 'patientMode') || 'Chat', icon: '💬' },
            ...resolvedTabs.map(tab => ({ id: tab.id, label: resolveI18n(tab.label, selectedLanguageCode), icon: tab.icon }))
          ]}
          activeTabId={mobileActivePanel === 'chat' ? 'chat' : activeTabId}
          onTabChange={(id) => {
            if (id === 'chat') {
              setMobileActivePanel('chat');
            } else {
              setMobileActivePanel('form');
              setActiveTabId(id);
            }
          }}
          scrollable
        />
        {/* Mobile copy of the chat top bar's switcher: the strip is fixed to the
            top of the viewport, so the control stays reachable while the reader is
            in the document or library panel. Desktop hides the whole strip. */}
        {skipWelcome && (langs?.languages?.length ?? 0) > 1 && (
          <LanguageSwitcher
            languages={langs?.languages || []}
            selectedCode={selectedLanguageCode || 'en'}
            onSelect={setSelectedLanguageCode}
            label={t('welcome', 'languageLabel') || 'Language'}
            className="lang-switcher-strip"
          />
        )}
      </div>
    ) : (
      <div className="mobile-toggle-bar">
        <button
          className={`mobile-toggle-button ${mobileActivePanel === 'chat' ? 'active' : ''}`}
          onClick={() => setMobileActivePanel('chat')}
        >
          {t('chat', 'patientMode')}
        </button>
        <button
          className={`mobile-toggle-button ${mobileActivePanel === 'form' ? 'active' : ''}`}
          onClick={() => setMobileActivePanel('form')}
        >
          {t('chat', 'diagnosis')}
        </button>
      </div>
    )}
    
    <div className={`main-container ${hasTabs ? 'has-tabs' : ''} ${chatOnly ? 'chat-only' : ''}`}>
      {/* Left Panel: Chatbot */}
      <div className={`left-panel ${!chatOnly && mobileActivePanel === 'form' ? 'mobile-hidden' : ''}`}>
        <div className="left-panel-inner">
          {/* skipWelcome projects never see the welcome screen, so both of its
              standing jobs live here, in the chat's top bar: the language selector
              on the left, the grounding disclaimer and consent notice on the right
              (client feedback, 2026-08-28 — the notices used to sit under the input
              and cost the chat a band of vertical space). Deliberately NO
              DEFAULT_CONSENT_PARAGRAPHS fallback: that constant is a bracketed
              placeholder, so a project without its own consent text gets no consent
              line rather than fake text. On mobile with tabs the switcher here is
              hidden by CSS in favour of the copy in the fixed tab strip, which stays
              reachable from every panel, and the notices go full width below the
              switcher's row. Projects that show the welcome screen render nothing
              here and are untouched. */}
          {skipWelcome && (() => {
            const code = selectedLanguageCode || 'en';
            const noticeParagraphs = (langs?.ui?.[code]?.welcome?.consentParagraphs
              || langs?.ui?.['en']?.welcome?.consentParagraphs) as string[] | undefined;
            const standingNote = t('chat', 'groundingNote');
            const hasSwitcher = (langs?.languages?.length ?? 0) > 1;
            const hasNotice = Boolean(standingNote) || (noticeParagraphs?.length ?? 0) > 0;
            if (!hasSwitcher && !hasNotice) return null;
            return (
              <div className="chat-topbar">
                {hasSwitcher && (
                  <LanguageSwitcher
                    languages={langs?.languages || []}
                    selectedCode={selectedLanguageCode || 'en'}
                    onSelect={setSelectedLanguageCode}
                    label={t('welcome', 'languageLabel') || 'Language'}
                  />
                )}
                <ChatNoticeBar
                  standingNote={standingNote}
                  noticeLine={t('chat', 'noticeLine')}
                  detailsLabel={t('chat', 'noticeDetails') || 'Details'}
                  consentParagraphs={noticeParagraphs || []}
                />
              </div>
            );
          })()}
          {wipEnabled && (
            <div className="left-panel-header">
              <button
                className="save-transcript-btn"
                onClick={saveTranscript}
                disabled={messages.length === 0 || saving}
              >
                {saving ? 'Saving…' : 'Save transcript'}
              </button>
            </div>
          )}

          <div className="left-panel-content">
            {/* Chatbot Interface */}
            <div className="chatbot-container chatbot-container-inner">
              {/* Conversation Display */}
              <div className="conversation-display conversation-display-inner">
                {/* Scrollable Header */}
                <div className="chat-header-scrollable">
                  {(() => {
                    const vi = selectedVignetteKey ? langs?.vignetteInfo?.[selectedVignetteKey] : undefined;
                    const hasContentTab = resolvedTabs?.some(t => t.type === 'content') || false;
                    return (
                      <div className="vignette-info">
                        <h1>{vi?.title || t('chat','headerTitle')}</h1>
                        {!hasContentTab && vi?.imageFile && (
                          <img
                            src={`${import.meta.env.BASE_URL}images/${vi.imageFile}`}
                            alt="Patient"
                            className="vignette-image"
                            style={{ width: '100%', maxWidth: vi.imageMaxWidth || '100%' }}
                          />
                        )}
                        {!hasContentTab && <p>{vi?.scenarioDescription || t('chat','scenarioDescription')}</p>}
                        {(() => {
                          const langChat = (langs?.ui?.[selectedLanguageCode]?.chat ?? langs?.ui?.['en']?.chat ?? {}) as Record<string, unknown>;
                          const desc = typeof langChat.description === 'string' ? langChat.description : '';
                          return desc ? <div className="vignette-description">{desc.split('\n\n').map((p, i) => <p key={i}>{p}</p>)}</div> : null;
                        })()}
                      </div>
                    );
                  })()}
                  {currentVignetteVoice && (
                    <div className="voice-controls">
                      {hasAssignedVoice ? null : (
                        <>
                          <label htmlFor="voice-select">Voice:</label>
                          <select
                            id="voice-select"
                            value={selectedVoice}
                            onChange={e => setSelectedVoice(e.target.value)}
                          >
                            <option value="alloy">Alloy</option>
                            <option value="ash">Ash</option>
                            <option value="ballad">Ballad</option>
                            <option value="coral">Coral</option>
                            <option value="echo">Echo</option>
                            <option value="fable">Fable</option>
                            <option value="nova">Nova</option>
                            <option value="onyx">Onyx</option>
                            <option value="sage">Sage</option>
                            <option value="shimmer">Shimmer</option>
                          </select>
                        </>
                      )}
                      <button
                        className={`voice-mute-btn ${voiceMuted ? 'muted' : ''}`}
                        onClick={() => {
                          setVoiceMuted(m => !m);
                          if (!voiceMuted && audioRef.current) {
                            audioRef.current.pause();
                            setIsPlayingAudio(false);
                          }
                        }}
                        title={voiceMuted ? 'Unmute voice' : 'Mute voice'}
                        type="button"
                      >
                        {voiceMuted ? (
                          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                            <line x1="23" y1="9" x2="17" y2="15" />
                            <line x1="17" y1="9" x2="23" y2="15" />
                          </svg>
                        ) : (
                          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                          </svg>
                        )}
                      </button>
                      {awaitingTTS && <span className="voice-playing-indicator">Loading voice...</span>}
                      {!awaitingTTS && isPlayingAudio && <span className="voice-playing-indicator">Playing...</span>}
                      <span style={{ fontStyle: 'italic', fontSize: '0.85rem', color: 'var(--text-muted, #999)', marginLeft: '8px' }}>Please turn on your speaker so that you can hear the patient responses.</span>
                    </div>
                  )}
                </div>

                <div className="messages-container">
                  {messages.map((message: Message, index: number) => (
                    <div key={index} className={`message ${message.role === 'user' ? 'user-message' : 'bot-message'}`}>
                      <div className="message-content">
                        {message.role === 'assistant' ? renderAssistantContent(message.content) : message.content}
                        {/* Per-answer disclosure: this reply said something the
                            project's reference content does not itself cover.
                            Shown only when the project supplies the localized
                            string, so other projects are unaffected; when the
                            model omits the flag the standing note still applies. */}
                        {message.role === 'assistant' && message.beyondScope && t('chat', 'beyondScopeNotice') && (
                          <div className="beyond-scope-note">
                            <span aria-hidden="true">⚠</span> {t('chat', 'beyondScopeNotice')}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}

                  {isLoading && (
                    <div className="message bot-message">
                      <div className="message-content">
                        <span className="typing-dots">
                          <span className="dot"></span>
                          <span className="dot"></span>
                          <span className="dot"></span>
                        </span>
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* Inline follow-up suggestions (opt-in per project via enableFollowups).
                    Rendered INSIDE the scrollable conversation-display as a sticky overlay
                    so messages scroll behind the chips with a frosted-glass effect. */}
                {/* Starter questions, shown only on an untouched conversation and
                    only when the project supplies them. A chat-only project has
                    no panel to put suggestions in, and a blank chat gives a
                    student no idea what this thing can actually answer. They
                    disappear as soon as the conversation starts, where the
                    per-answer follow-up chips take over. */}
                {starterQuestions.length > 0 && messages.length <= 1 && !isLoading && (
                  <div className="suggested-prompts">
                    {starterQuestions.map((q, i) => (
                      <button
                        key={`starter-${i}`}
                        type="button"
                        onClick={() => handleQuestionClick(q)}
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                )}
                {followups.length > 0 && !isLoading && (
                  <div className="followups-bar">
                    {followups.map((q, i) => (
                      <button
                        key={`${i}-${q}`}
                        type="button"
                        className="followup-chip"
                        onClick={() => handleQuestionClick(q)}
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Input Area */}
              <div className="input-container input-container-inner">
                <div className="input-wrapper">
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyPress={handleKeyPress}
                    className="user-input"
                    placeholder={t('chat','inputPlaceholder')}
                    rows={1}
                    disabled={isLoading}
                  />
                  <button
                    onClick={() => handleSendMessage()}
                    disabled={!input.trim() || isLoading}
                    className="send-button"
                    type="button"
                    aria-label={t('chat','send')}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 19V5"></path>
                      <path d="M5 12l7-7 7 7"></path>
                    </svg>
                  </button>
                </div>
              </div>

            </div>
          </div>
        </div>
      </div>

      {/* Right Panel: Tabbed content or legacy form. Omitted entirely for a
          chat-only project — rendering it and hiding it with CSS would still
          mount the panel, and for a formless project that means mounting the
          legacy Kobo form and firing its fetch. */}
      {!chatOnly && (
      <div className={`right-panel ${mobileActivePanel === 'chat' ? 'mobile-hidden' : ''}`}>
        {hasTabs ? (
          <>
            <TabBar
              tabs={resolvedTabs.map(tab => ({ id: tab.id, label: resolveI18n(tab.label, selectedLanguageCode), icon: tab.icon }))}
              activeTabId={activeTabId}
              onTabChange={setActiveTabId}
              className="desktop-tab-bar"
            />
            <TabPanel activeTabId={activeTabId}>
              {resolvedTabs.map(tab => {
                // Defer panel content until the tab is first opened (see
                // visitedTabIds above). The placeholder keeps TabPanel's
                // data-tab-id contract so tab switching is unaffected.
                if (!visitedTabIds.has(tab.id)) {
                  return <div key={tab.id} data-tab-id={tab.id} />;
                }
                if (tab.type === 'suggestions') {
                  return (
                    <div key={tab.id} data-tab-id={tab.id}>
                      <SuggestedQuestions
                        content={(tab.content as SuggestionsContent | null) ?? null}
                        lang={selectedLanguageCode}
                        onQuestionClick={handleQuestionClick}
                      />
                    </div>
                  );
                }
                if (tab.type === 'pdf' || tab.type === 'document') {
                  const tabLabel = typeof tab.label === 'string' ? tab.label : resolveI18n(tab.label, selectedLanguageCode || 'en');
                  const renderView = (view: TabDefinition) =>
                    view.type === 'pdf' ? renderPdfView(view, tab.id, tabLabel) : renderDocumentView(view, tab.id);

                  // A tab with only one edition renders exactly as it always did.
                  if (!tab.altView) {
                    const style = tab.type === 'pdf'
                      ? { flex: 1, display: 'flex', flexDirection: 'column' as const, minHeight: 0 }
                      : undefined;
                    return (
                      <div key={tab.id} data-tab-id={tab.id} style={style}>
                        {renderView(tab)}
                      </div>
                    );
                  }

                  // Two editions of one document behind one tab. The primary (the
                  // edition declared first — the PDF) is mounted with the tab; the
                  // alt view waits until the reader asks for it, the same way a tab
                  // itself waits for its first visit.
                  const primary = tab;
                  const alt = tab.altView;
                  const currentView = tabViews[tab.id] ?? primary.type as DualViewKind;
                  const altMounted = visitedViewKeys.has(`${tab.id}:${alt.type}`);
                  const pdfSide = primary.type === 'pdf' ? primary : alt;
                  const textSide = primary.type === 'pdf' ? alt : primary;
                  const isMounted = (view: TabDefinition) => view === primary || altMounted;
                  // The latest jump aimed at this tab, in either edition — it
                  // tells the panel not to restore a remembered offset on top of
                  // a destination the reader just asked for.
                  const jumpNonce = Math.max(
                    docScrollTarget?.tabId === tab.id ? docScrollTarget.nonce : 0,
                    pdfScrollTarget?.tabId === tab.id ? pdfScrollTarget.nonce : 0,
                  );
                  return (
                    <div key={tab.id} data-tab-id={tab.id} style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                      <DualViewTab
                        view={currentView}
                        onViewChange={(next) => setTabView(tab.id, next)}
                        labels={DUAL_VIEW_UI[selectedLanguageCode] ?? DUAL_VIEW_UI.en}
                        jumpNonce={jumpNonce}
                        pdfView={isMounted(pdfSide) ? renderView(pdfSide) : null}
                        textView={isMounted(textSide) ? renderView(textSide) : null}
                      />
                    </div>
                  );
                }
                if (tab.type === 'library') {
                  return (
                    <div key={tab.id} data-tab-id={tab.id}>
                      <LegalLibraryPanel
                        content={(tab.content as LegalLibraryContent | null) ?? null}
                        lang={selectedLanguageCode}
                        selectTarget={legalSelectTarget}
                      />
                    </div>
                  );
                }
                if (tab.type === 'form') {
                  return (
                    <div key={tab.id} data-tab-id={tab.id}>
                      {formSubmitted ? (
                        <div className="post-submission-wrapper">
                          <div className="post-submission-content">
                            <h2>{t('chat','thanksTitle')}</h2>
                            <button onClick={handleNextCase}>
                              {t('chat','nextCase')}
                            </button>
                          </div>
                        </div>
                      ) : (
                        selectedVignetteKey && transcriptToken && caseTemplateLoaded ? (
                          <Suspense fallback={
                            <div className="loading-form-wrapper">
                              <p>{t('chat','loadingForm')}</p>
                            </div>
                          }>
                            <NativeKoboForm
                              key={formReloadKey}
                              transcriptToken={transcriptToken}
                              vignetteId={selectedVignetteKey}
                              caseTemplate={caseTemplate}
                              language={selectedLanguageCode}
                              userPrefillParams={userPrefillParams}
                              userUid={userUid}
                              submitLabel={t('chat', 'submitForm') || 'Submit'}
                              submittingLabel={t('chat', 'submittingForm') || 'Submitting...'}
                              loadingLabel={t('chat', 'loadingForm') || 'Loading form...'}
                              formTitle={t('chat', 'formTitle') || undefined}
                              dragDropAllocation={dragDropAllocation}
                              onSubmitted={handleFormSubmitted}
                            />
                          </Suspense>
                        ) : (
                          <div className="loading-form-wrapper">
                            <p>{t('chat','loadingForm')}</p>
                          </div>
                        )
                      )}
                    </div>
                  );
                }
                // content tabs — sections can come from (a) legacy tab.globalSections
                // inside langs.tabs, or (b) the new pattern where tab.content (loaded
                // from a contentFile via /api/tabs) has a sections/globalSections field.
                const vi = selectedVignetteKey ? langs?.vignetteInfo?.[selectedVignetteKey] : undefined;
                const sceneSections = vi?.tabSections?.[tab.id];
                const formTabId = !tab.hideAction ? resolvedTabs.find(t => t.type === 'form')?.id : undefined;
                const contentFromFile = tab.content as { sections?: ContentSection[]; globalSections?: ContentSection[] } | null;
                const globalSections = tab.globalSections
                  || contentFromFile?.globalSections
                  || contentFromFile?.sections;
                return (
                  <div key={tab.id} data-tab-id={tab.id}>
                    <ContentPanel
                      globalSections={globalSections}
                      sceneSections={sceneSections}
                      basePath={import.meta.env.BASE_URL}
                      actionLabel={formTabId ? 'Submit Your Response \u2192' : undefined}
                      onAction={formTabId ? () => setActiveTabId(formTabId) : undefined}
                    />
                  </div>
                );
              })}
            </TabPanel>
          </>
        ) : (
          /* Legacy: single form panel */
          formSubmitted ? (
            <div className="post-submission-wrapper">
              <div className="post-submission-content">
                <h2>{t('chat','thanksTitle')}</h2>
                <button onClick={handleNextCase}>
                  {t('chat','nextCase')}
                </button>
              </div>
            </div>
          ) : (
            selectedVignetteKey && transcriptToken && caseTemplateLoaded ? (
              <Suspense fallback={
                <div className="loading-form-wrapper">
                  <p>{t('chat','loadingForm')}</p>
                </div>
              }>
                <NativeKoboForm
                  key={formReloadKey}
                  transcriptToken={transcriptToken}
                  vignetteId={selectedVignetteKey}
                  caseTemplate={caseTemplate}
                  language={selectedLanguageCode}
                  userPrefillParams={userPrefillParams}
                  userUid={userUid}
                  submitLabel={t('chat', 'submitForm') || 'Submit'}
                  submittingLabel={t('chat', 'submittingForm') || 'Submitting...'}
                  loadingLabel={t('chat', 'loadingForm') || 'Loading form...'}
                  formTitle={t('chat', 'formTitle') || undefined}
                  onSubmitted={handleFormSubmitted}
                />
              </Suspense>
            ) : (
              <div className="loading-form-wrapper">
                <p>{t('chat','loadingForm')}</p>
              </div>
            )
          )
        )}
      </div>
      )}
    </div>
    </>
    )}
    </>
  );
}

// Main App Component
function App() {
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [adminScope, setAdminScope] = useState<'global' | 'project'>('global');
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  // Strip Vite base path to get the app-relative path
  const basePath = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
  const getAppPath = () => {
    const full = window.location.pathname;
    return basePath && full.startsWith(basePath)
      ? full.slice(basePath.length) || '/'
      : full;
  };
  const [currentPath, setCurrentPath] = useState(getAppPath());

  // Listen for navigation changes
  useEffect(() => {
    const handlePopState = () => {
      setCurrentPath(getAppPath());
    };
    
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Check for existing session on mount (only on admin route)
  useEffect(() => {
    if (currentPath !== '/admin') {
      setIsCheckingAuth(false);
      return;
    }
    
    const verifySession = async () => {
      try {
        const response = await apiFetch(api('/api/admin/verify'), {
          credentials: 'include',
        });
        if (response.ok) {
          const data = await response.json();
          setAdminToken('session');
          setAdminScope(data.scope === 'project' ? 'project' : 'global');
        }
      } catch (err) {
        // Session invalid or error, stay logged out
        console.error('Session verification failed:', err);
      } finally {
        setIsCheckingAuth(false);
      }
    };
    
    verifySession();
  }, [currentPath]);

  // Handle admin login
  const handleAdminLogin = (token: string, scope?: string) => {
    setAdminToken(token);
    setAdminScope(scope === 'project' ? 'project' : 'global');
  };

  // Handle admin logout
  const handleAdminLogout = async () => {
    try {
      await apiFetch(api('/api/admin/logout'), {
        method: 'POST',
        credentials: 'include',
      });
    } catch (err) {
      console.error('Logout error:', err);
    }
    setAdminToken(null);
  };

  // Check if we're on the admin route
  if (currentPath === '/admin') {
    // Show loading state while checking auth
    if (isCheckingAuth) {
      return (
        <div className="admin-page">
          <div style={{ color: 'var(--text-secondary)', fontSize: '1.2em' }}>Loading...</div>
        </div>
      );
    }
    
    if (adminToken) {
      return (
        <Suspense fallback={
          <div className="admin-page">
            <div style={{ color: 'var(--text-secondary)', fontSize: '1.2em' }}>Loading...</div>
          </div>
        }>
          <AdminDashboard token={adminToken} onLogout={handleAdminLogout} readOnly={adminScope === 'project'} />
        </Suspense>
      );
    } else {
      return <AdminLogin onLogin={handleAdminLogin} />;
    }
  }

  // Voice mode (opt-in via ?mode=voice). Self-contained realtime flow; falls
  // through to the normal text chat for every other URL, so projects without
  // realtime are byte-identical. The server-side enableRealtime gate is the real
  // enforcement — this just routes the UI.
  if (currentPath !== '/admin' && new URLSearchParams(window.location.search).get('mode') === 'voice') {
    return (
      <Suspense fallback={null}>
        <RealtimeVoice />
      </Suspense>
    );
  }

  // Default: show chat interface
  return <ChatInterface />;
}

export default App;