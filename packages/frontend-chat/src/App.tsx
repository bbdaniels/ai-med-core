import { useState, useEffect, useRef, useMemo, lazy, Suspense } from 'react';
import './App.css';
import { api, apiFetch } from './api-base';
import AdminLogin from './components/AdminLogin';
import WelcomeScreen from './WelcomeVariants';
import TabBar from './components/TabBar';
import TabPanel from './components/TabPanel';
import ContentPanel from './components/ContentPanel';
import SuggestedQuestions, { type SuggestionsContent } from './components/SuggestedQuestions';
import DocumentPanel from './components/DocumentPanel';
import LegalLibraryPanel, { type LegalLibraryContent } from './components/LegalLibraryPanel';
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
interface LanguageDef { code: string; name: string }
interface LanguageUISection {
  welcome: {
    title: string
    subtitle: string
    instructionsLead: string
    howItWorks: string
    bullets: string[]
    disclaimer?: string | string[]
    consentParagraphs?: string[]
    getStarted: string
    languageLabel: string
  }
  chat: {
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
    try { return localStorage.getItem('lang_code') || 'en' } catch { return 'en' }
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
  const [pendingAssistantMessage, setPendingAssistantMessage] = useState<string | null>(null);
  const [awaitingTTS, setAwaitingTTS] = useState(false);
  // Tabs fetched from /api/tabs (new pattern: tab structure in project.json, content in separate files).
  // When null, falls back to legacy langs.tabs pattern.
  const [apiTabs, setApiTabs] = useState<TabDefinition[] | null>(null);
  // Formless mode: project has no Kobo form; we skip the auto-added form tab.
  const [formless, setFormless] = useState(false);
  // Document-reference linking: when a project declares `docRefs`, references in
  // an assistant answer ("Section 4.1", "Phụ lục 7.1") become clickable and jump
  // the document tab to that passage. Absent this config the feature is off and
  // assistant messages render exactly as before. See doc-refs.ts.
  const [docRefs, setDocRefs] = useState<DocRefsConfig | null>(null);
  // A clicked reference asks the target document tab to scroll; the bumped nonce
  // re-triggers the jump even when the same anchor is clicked twice.
  const [docScrollTarget, setDocScrollTarget] = useState<{ tabId: string; anchor: string; nonce: number } | null>(null);
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
    return tabs.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  }, [langs, apiTabs, formless, selectedVignetteKey]);
  const hasTabs = resolvedTabs !== null;
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
    const markdown = (tab?.content as { markdown?: string } | null | undefined)?.markdown;
    const anchors = markdown ? extractAnchorIds(markdown) : new Set<string>();
    return buildDocRefMatcher(docRefs, anchors, legalNumberToId);
  }, [docRefs, resolvedTabs, legalNumberToId]);
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
        if (data.dragDropAllocation) setDragDropAllocation(true);
        if (data.enableFeedback === false) setFeedbackEnabled(false);
        if (data.docRefs && typeof data.docRefs === 'object' && typeof data.docRefs.tabId === 'string') {
          setDocRefs(data.docRefs as DocRefsConfig);
        }
      })
      .catch(() => {});
  }, []);

  // Fetch tabs from /api/tabs (new pattern). Falls through to legacy langs.tabs if empty.
  // Re-fetched on language change: a tab's contentFile may be declared per language
  // (haivn_eip serves the EIP document and its text in both English and Vietnamese),
  // and the backend resolves which file to send from ?lang.
  useEffect(() => {
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
  }, [selectedLanguageCode]);

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
      setMessages(prev => [...prev, { role: 'assistant', content: pendingAssistantMessage }]);
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
          pendingAssistantMessage,
          speakerVoices ? Object.keys(speakerVoices) : [],
        );
        if (segments.length === 0) {
          // Nothing speakable — flush the text without audio.
          setMessages(prev => [...prev, { role: 'assistant', content: pendingAssistantMessage }]);
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
        setMessages(prev => [...prev, { role: 'assistant', content: pendingAssistantMessage }]);
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
          setMessages(prev => [...prev, { role: 'assistant', content: pendingAssistantMessage }]);
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
    if (!hasStarted) return;
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
  }, [hasStarted, userUid]);

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
        setPendingAssistantMessage(hardcodedOpening);
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

      if (currentVignetteVoice && !voiceMuted) {
        setPendingAssistantMessage(response.message);
        // isLoading stays true; TTS useEffect will clear it
      } else {
        setMessages([{ role: 'assistant', content: response.message }]);
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

      if (currentVignetteVoice && !voiceMuted) {
        setPendingAssistantMessage(response.message);
        // isLoading stays true; TTS useEffect will clear it + sendInFlightRef
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: response.message }]);
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
    setDocScrollTarget({ tabId: docRefs.tabId, anchor, nonce: Date.now() });
  };

  // A legal-document reference: open the legal-library tab and select that document.
  const handleLegalRefClick = (docId: string) => {
    if (!legalTab) return;
    setActiveTabId(legalTab.id);
    setMobileActivePanel('form');
    setLegalSelectTarget({ docId, nonce: Date.now() });
  };

  // Render an assistant message, linking any recognized document references.
  // When the feature is off (no matcher) or nothing resolves, the raw string is
  // returned untouched, preserving the deliberate plain-text chat rendering — no
  // markdown. Segments are plain strings and <a> nodes built by React (never
  // innerHTML), so the model's text can't inject markup; the href is a validated
  // anchor id from doc-refs.ts.
  const renderAssistantContent = (text: string): React.ReactNode => {
    if (!docRefMatcher) return text;
    const segments = docRefMatcher(text);
    if (segments.length === 1 && !segments[0].anchor) return text;
    return segments.map((seg, i) => {
      if (seg.anchor) {
        const anchor = seg.anchor;
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
      ? [...messages, { role: 'assistant' as const, content: pendingAssistantMessage }]
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
      // Defer to ensure DOM updates after disabled->enabled toggle
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isLoading]);
  
  // Auto-scroll to bottom when messages change or when loading
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);
  

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
    {!hasStarted && !langs && (
      <div className="welcome-screen">
        <div className="welcome-content" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '200px' }}>
          <p>Loading...</p>
        </div>
      </div>
    )}
    {!hasStarted && langs && (() => {
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
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
        />
      );
    })()}
    
    {/* Opt-in entry to live voice mode, shown on the welcome screen when the
        project enables realtime. Navigates to ?mode=voice (preserving ?values=). */}
    {!hasStarted && langs && realtimeEnabled && (
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
    {/* Mobile Toggle/Tab Bar - Only visible on screens < 768px */}
    {hasTabs ? (
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
    
    <div className={`main-container ${hasTabs ? 'has-tabs' : ''}`}>
      {/* Left Panel: Chatbot */}
      <div className={`left-panel ${mobileActivePanel === 'form' ? 'mobile-hidden' : ''}`}>
        <div className="left-panel-inner">
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

      {/* Right Panel: Tabbed content or legacy form */}
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
                if (tab.type === 'pdf') {
                  const pdfContent = tab.content as { pdfUrl?: string } | null;
                  const pdfSrc = pdfContent?.pdfUrl
                    ? `${import.meta.env.VITE_API_BASE_URL || ''}${pdfContent.pdfUrl}`
                    : '';
                  const pdfLabel = typeof tab.label === 'string' ? tab.label : resolveI18n(tab.label, selectedLanguageCode || 'en');
                  const openLabel = (PDF_TAB_UI[selectedLanguageCode] ?? PDF_TAB_UI.en).openInNewTab;
                  // Rendered with bundled pdf.js (not the browser's built-in viewer) so we
                  // control link targets: every in-PDF external link becomes a real
                  // <a target="_blank">, and there is no outline sidebar eating panel width.
                  return (
                    <div key={tab.id} data-tab-id={tab.id} style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                      {pdfSrc ? (
                        <Suspense fallback={
                          <div className="loading-form-wrapper">
                            <p>{t('chat','loadingForm')}</p>
                          </div>
                        }>
                          <PdfJsViewer src={pdfSrc} title={pdfLabel} openLabel={openLabel} />
                        </Suspense>
                      ) : (
                        <p style={{ padding: '1rem' }}>PDF not available.</p>
                      )}
                    </div>
                  );
                }
                if (tab.type === 'document') {
                  return (
                    <div key={tab.id} data-tab-id={tab.id}>
                      <DocumentPanel
                        content={(tab.content as { markdown?: string } | null) ?? null}
                        lang={selectedLanguageCode}
                        scrollTarget={docScrollTarget?.tabId === tab.id ? docScrollTarget : null}
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