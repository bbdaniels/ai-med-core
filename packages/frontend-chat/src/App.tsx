import { useState, useEffect, useRef, useMemo, lazy, Suspense } from 'react';
import './App.css';
import { api, apiFetch } from './api-base';
import { CourseAccessGate, LoadErrorScreen, LoadingScreen, UnknownDocumentScreen } from './chat/Screens';
import { ADMIN_PATH, AdminRoute, useAppPath } from './admin-route';
import WelcomeScreen from './WelcomeVariants';
import { splitRoleSegments, resolveSegmentVoice } from './tts-speech';
import { useChatSession } from './chat/useChatSession';
import { useProjectConfig } from './chat/useProjectConfig';
import { useAccessGate } from './chat/useAccessGate';
import { useDocumentTitle, useLanguages } from './chat/useLanguages';
import { useDeepLink } from './chat/useDeepLink';
import { useTabs } from './chat/useTabs';
import { useDocRefs } from './chat/useDocRefs';
import ChatColumn from './chat/ChatColumn';
import { renderAssistantContent } from './chat/AssistantContent';
import { MobileTabStrip, TabbedPanel, type TabViewContext, renderTabView } from './chat/TabViews';

// Heavy components are code-split so their dependencies stay out of the entry
// chunk: NativeKoboForm pulls the whole enketo-core/enketo-transformer/jquery
// stack (~2 MB raw), and RealtimeVoice imports NativeKoboForm itself (PdfJsViewer
// is split the same way in chat/TabViews.tsx). Each render site is behind a conditional, so form
// projects still fetch the form chunk on demand the moment they render it —
// while formless projects (haivn_eip) never download any of it.
const RealtimeVoice = lazy(() => import('./RealtimeVoice'));
const NativeKoboForm = lazy(() => import('./components/NativeKoboForm'));
const GradingScreen = lazy(() => import('./components/GradingScreen'));

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

// Chat Component
function ChatInterface() {
  const [saving, setSaving] = useState(false);
  const [formSubmitted, setFormSubmitted] = useState(false);
  const [showEndScreen, setShowEndScreen] = useState(false);
  const [showTransition, setShowTransition] = useState(false);
  const [formReloadKey, setFormReloadKey] = useState(0);
  const [sessionTokens, setSessionTokens] = useState<string[]>(() => {
    try {
      const stored = sessionStorage.getItem('sessionTokens');
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });
  const [showGradingScreen, setShowGradingScreen] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [caseTemplate, setCaseTemplate] = useState<string | null>(null);
  const [caseTemplateLoaded, setCaseTemplateLoaded] = useState(false);
  const [mobileActivePanel, setMobileActivePanel] = useState<'chat' | 'form'>('chat');
  const [selectedVoice, setSelectedVoice] = useState('nova');
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [voiceMuted, setVoiceMuted] = useState(false);
  // /api/config. configLoaded gates the welcome renders so a slow /api/config
  // can't flash the welcome page on a skipWelcome project — and a FAILED
  // /api/config still degrades to the normal welcome rather than a blank screen.
  const { configLoaded, config } = useProjectConfig();
  const {
    enableVoice: voiceEnabled, enableRealtime: realtimeEnabled, formless, skipWelcome, dragDropAllocation,
    requireAccessCode, chatOnly, enableFeedback: feedbackEnabled, docRefs,
  } = config;
  const gate = useAccessGate(configLoaded, requireAccessCode);
  const { accessReady } = gate;
  const { langs, languagesError, selectedLanguageCode, setSelectedLanguageCode, selectedLanguageName, starterQuestions, t } =
    useLanguages(requireAccessCode && gate.unlocked);
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
  // Which vignette is open, and the case sequence through the rest.
  const deepLink = useDeepLink({
    configLoaded,
    talkManifestSlug: config.talkManifestSlug,
    talkPublicUrl: config.talkPublicUrl,
    requireKnownVignette: config.requireKnownVignette,
    accessReady,
    active: hasStarted,
    uid: userUid,
  });
  const { vignetteKeys, selectedVignetteKey, currentVignetteIndex, embeddedInFrame, closeEmbeddingFrame, selectedPaper, pickerPapers } = deepLink;
  useDocumentTitle(langs, selectedLanguageCode, selectedPaper?.title);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const selectedVoiceRef = useRef(selectedVoice);
  // Multi-clip TTS playback: each synthesis run gets a fresh id; a stale id
  // tells an in-flight playback chain that a newer message superseded it.
  const ttsPlaybackIdRef = useRef(0);
  // Synchronous mirror of voiceMuted for the playback chain (state is stale
  // inside long-lived async closures).
  const voiceMutedRef = useRef(voiceMuted);
  // Per-vignette voice gate: project-level `enableVoice` is the master switch,
  // but each vignette must also opt in via `vignetteInfo[key].voiceEnabled` so
  // bland cases don't get TTS auto-play when paired with voice variants.
  const currentVignetteInfo = selectedVignetteKey ? langs?.vignetteInfo?.[selectedVignetteKey] : undefined;
  const currentVignetteVoice = !!(voiceEnabled && currentVignetteInfo?.voiceEnabled);
  // A pre-assigned voice (e.g. "onyx") disables the voice-picker dropdown so
  // respondents can't change the demographic profile mid-study.
  const assignedVoice = currentVignetteInfo?.voice;
  const hasAssignedVoice = typeof assignedVoice === 'string' && assignedVoice.length > 0;
  // The conversation itself (messages, input, follow-ups, session token). A
  // voice vignette parks each reply for the TTS player below.
  const session = useChatSession({
    active: hasStarted,
    documentKey: selectedVignetteKey,
    languageName: selectedLanguageName,
    languageCode: selectedLanguageCode,
    langs,
    epoch: formReloadKey,
    speak: currentVignetteVoice && !voiceMuted,
    onOpened: (template) => {
      if (template) setCaseTemplate(template);
      setCaseTemplateLoaded(true);
    },
  });
  const { messages, initialized, pendingAssistantMessage, awaitingTTS, inputRef } = session;
  const transcriptToken = session.sessionToken;
  const wipEnabled = useMemo(() => new URLSearchParams(window.location.search).has('wip'), []);
  const tabs = useTabs({
    accessReady,
    languageCode: selectedLanguageCode,
    langs,
    vignetteKey: selectedVignetteKey,
    addFormTab: !formless,
  });
  const { resolvedTabs, hasTabs, setActiveTabId } = tabs;
  // A formless project can end up with no visible tab for the selected vignette
  // (papers: closed-access papers get no PDF tab). An empty second panel is
  // worse than none, so that case takes the chat-only layout.
  const noPanel = chatOnly || (formless && resolvedTabs !== null && resolvedTabs.length === 0);
  const refs = useDocRefs({
    docRefs,
    resolvedTabs,
    messages,
    setTabView: tabs.setTabView,
    reveal: (tabId) => { setActiveTabId(tabId); setMobileActivePanel('form'); },
  });

  // Reload form when UI language changes (only after start)
  useEffect(() => {
    if (!hasStarted) return;
    setFormReloadKey((prev: number) => prev + 1);
  }, [hasStarted, selectedLanguageCode]);

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

  // Keep voice refs in sync
  useEffect(() => { selectedVoiceRef.current = selectedVoice; }, [selectedVoice]);
  useEffect(() => { voiceMutedRef.current = voiceMuted; }, [voiceMuted]);

  // TTS: fetch audio for pending assistant message, then reveal text + play simultaneously.
  // When voice is disabled or muted, the message is flushed to chat immediately.
  useEffect(() => {
    if (!pendingAssistantMessage) return;

    // If muted or voice not active, flush text immediately
    if (voiceMuted || !currentVignetteVoice) {
      session.revealPending(pendingAssistantMessage);
      return;
    }

    // Stop any currently playing audio
    if (audioRef.current) {
      audioRef.current.pause();
    }

    session.beginSpeaking();
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
          session.revealPending(pendingAssistantMessage);
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
        session.revealPending(pendingAssistantMessage);
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
          session.revealPending(pendingAssistantMessage);
          setIsPlayingAudio(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [pendingAssistantMessage, voiceMuted, currentVignetteVoice]);

  // Open a paper from the picker, or (key = null) go back to the picker: a
  // fresh conversation either way, with a fresh transcript token.
  const openPaper = (key: string | null) => {
    if (!deepLink.openPaper(key)) return;
    session.reset();
    setFormReloadKey((prev: number) => prev + 1);
  };

  // Called by NativeKoboForm when submission succeeds
  const handleFormSubmitted = async () => {
    try {
      const token = session.sessionTokenRef.current;
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
    deepLink.selectVignette(nextIndex, nextKey);
    session.reset();
    setFormSubmitted(false);
    // Force the form to remount with fresh state
    setFormReloadKey((prev: number) => prev + 1);
  };

  // Clicked suggested question: send directly as user message, bypass input box.
  // On mobile, also switch panels to the chat so the user sees their question land.
  const handleQuestionClick = (question: string) => {
    setMobileActivePanel('chat');
    session.sendMessage(question);
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

  // The assessment form, in its tab or as the whole legacy panel: the thanks
  // card once submitted, else the form once the conversation has its token and
  // case template.
  const renderFormPanel = () => (
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
            dragDropAllocation={dragDropAllocation}
            onSubmitted={handleFormSubmitted}
          />
        </Suspense>
      ) : (
        <div className="loading-form-wrapper">
          <p>{t('chat','loadingForm')}</p>
        </div>
      )
    )
  );
  const tabViewContext: TabViewContext = {
    lang: selectedLanguageCode,
    loadingLabel: t('chat', 'loadingForm'),
    tabs,
    refs,
    onQuestionClick: handleQuestionClick,
    vignetteInfo: currentVignetteInfo,
  };

  // talkPublicUrl project opened top-level: the manifest effect is sending the
  // browser to the public page. Render nothing meanwhile, so neither the chat
  // shell nor the picker flashes first.
  if (deepLink.leavingForPublicPage) return null;

  // Access gate. Rendered instead of the app, after every hook above has run, so
  // the hook order is identical whether or not the gate is showing. It waits for
  // /api/config: gating on a flag we have not loaded yet would flash the gate at
  // every visitor of every ungated project.
  if (gate.gateShown) {
    return <CourseAccessGate t={t} onUnlocked={gate.unlock} />;
  }

  // A requireKnownVignette link that names no vignette this deployment holds.
  if (deepLink.vignetteRefused) {
    return <UnknownDocumentScreen t={t} />;
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
    {!hasStarted && languagesError && <LoadErrorScreen message={languagesError} />}
    {!hasStarted && !languagesError && (!langs || !configLoaded) && <LoadingScreen />}
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
    {noPanel ? null : hasTabs ? (
      <MobileTabStrip
        tabs={tabs}
        lang={selectedLanguageCode}
        chatLabel={t('chat', 'patientMode') || 'Chat'}
        mobilePanel={mobileActivePanel}
        onMobilePanel={setMobileActivePanel}
        languageSwitcher={skipWelcome
          ? { langs, onSelect: setSelectedLanguageCode, label: t('welcome', 'languageLabel') || 'Language' }
          : null}
      />
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
    
    <div className={`main-container ${hasTabs && !noPanel ? 'has-tabs' : ''} ${noPanel ? 'chat-only' : ''}`}>
      {/* Left Panel: Chatbot */}
      <ChatColumn
        session={session}
        t={t}
        langs={langs}
        lang={selectedLanguageCode}
        onLanguageChange={setSelectedLanguageCode}
        showTopBar={skipWelcome}
        mobileHidden={!noPanel && mobileActivePanel === 'form'}
        headerSlot={wipEnabled && (
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
        voiceSlot={
          currentVignetteVoice && (
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
          )
        }
        documentKey={selectedVignetteKey}
        vignetteInfo={currentVignetteInfo}
        hasContentTab={resolvedTabs?.some(t => t.type === 'content') || false}
        selectedPaper={selectedPaper}
        pickerPapers={pickerPapers}
        openPaper={openPaper}
        embeddedInFrame={embeddedInFrame}
        closeEmbeddingFrame={closeEmbeddingFrame}
        starterQuestions={starterQuestions}
        renderAssistant={(text) => renderAssistantContent(text, refs, selectedLanguageCode)}
        onQuestionClick={handleQuestionClick}
      />

      {/* Right Panel: Tabbed content or legacy form. Omitted entirely for a
          chat-only project — rendering it and hiding it with CSS would still
          mount the panel, and for a formless project that means mounting the
          legacy Kobo form and firing its fetch. */}
      {!noPanel && (
      <div className={`right-panel ${mobileActivePanel === 'chat' ? 'mobile-hidden' : ''}`}>
        {hasTabs ? (
          <TabbedPanel
            tabs={tabs}
            lang={selectedLanguageCode}
            renderTab={tab => tab.type === 'form'
              ? <div key={tab.id} data-tab-id={tab.id}>{renderFormPanel()}</div>
              : renderTabView(tab, tabViewContext)}
          />
        ) : (
          /* Legacy: single form panel */
          renderFormPanel()
        )}
      </div>
      )}
    </div>
    </>
    )}
    </>
  );
}

// Main App Component: the admin route, the realtime voice page, or the chat.
function App() {
  const currentPath = useAppPath();

  if (currentPath === ADMIN_PATH) return <AdminRoute />;

  // Voice mode (opt-in via ?mode=voice). Self-contained realtime flow; falls
  // through to the normal text chat for every other URL, so projects without
  // realtime are byte-identical. The server-side enableRealtime gate is the real
  // enforcement — this just routes the UI.
  if (new URLSearchParams(window.location.search).get('mode') === 'voice') {
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
