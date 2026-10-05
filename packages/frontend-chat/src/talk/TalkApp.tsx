// The talk page: chat about documents (papers, slides, course readings, a
// reference document and its legal library). It is the simulator page
// (App.tsx) without the simulator: no welcome page, no assessment form, no
// grading, no voice. It imports nothing from Kobo, enketo or grading, so a
// talk build ships none of them; src/talk-main.tsx mounts it, and vite.config.ts
// builds that entry when VITE_APP=talk.
//
// Everything it shows comes from the parts both pages share in src/chat/.
//
// A followHost project inside a frame follows the host page instead of its
// link (src/host-document.ts): the host says which document is current, the
// header shows it, each question is asked on it, and the one conversation
// carries on across documents with a "Now on" divider where a question moves
// to another one. Every other project, and a followHost project opened
// top-level, is unchanged.

import { useEffect, useState } from 'react';
import { useProjectConfig } from '../chat/useProjectConfig';
import { useAccessGate } from '../chat/useAccessGate';
import { useDocumentTitle, useLanguages } from '../chat/useLanguages';
import { useDeepLink } from '../chat/useDeepLink';
import { useHostDocument } from '../chat/useHostDocument';
import { currentDocument, questionsBlocked } from '../host-document';
import { useChatSession } from '../chat/useChatSession';
import { useTabs } from '../chat/useTabs';
import { useDocRefs } from '../chat/useDocRefs';
import ChatColumn from '../chat/ChatColumn';
import { renderAssistantContent } from '../chat/AssistantContent';
import { type MobilePanel, MobileTabStrip, TabbedPanel, type TabViewContext, renderTabView } from '../chat/TabViews';
import { CourseAccessGate, LoadingScreen, UnknownDocumentScreen } from '../chat/Screens';

export default function TalkApp() {
  const [mobileActivePanel, setMobileActivePanel] = useState<MobilePanel>('chat');
  const { configLoaded, config } = useProjectConfig();
  const gate = useAccessGate(configLoaded, config.requireAccessCode);
  const { accessReady } = gate;
  const { langs, selectedLanguageCode, setSelectedLanguageCode, selectedLanguageName, starterQuestions, t } =
    useLanguages(config.requireAccessCode && gate.unlocked);

  // No welcome page: the conversation starts once the config and the languages
  // file have loaded. The language switcher and the consent notice sit in the
  // chat's top bar instead.
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (!started && configLoaded && langs) setStarted(true);
  }, [started, configLoaded, langs]);

  // A fresh session token when the conversation starts, on every language
  // switch, and for every paper opened from the picker, as on the simulator
  // page.
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    if (!started) return;
    setEpoch(prev => prev + 1);
  }, [started, selectedLanguageCode]);

  const deepLink = useDeepLink({
    configLoaded,
    talkManifestSlug: config.talkManifestSlug,
    talkPublicUrl: config.talkPublicUrl,
    requireKnownVignette: config.requireKnownVignette,
    followHost: config.followHost,
    accessReady,
    active: started,
  });
  const { selectedPaper, hostDriven } = deepLink;
  useDocumentTitle(langs, selectedLanguageCode, selectedPaper?.title);

  // followHost, framed: the host's current document, checked against the
  // deployment's list on every switch. Ready (talk:ready) once access is
  // settled and that list has loaded.
  const { hostDocument } = useHostDocument({
    enabled: hostDriven,
    embedOrigins: config.embedOrigins,
    ready: started && accessReady && deepLink.vignetteKeysLoaded,
  });
  const hosted = hostDriven
    ? currentDocument(hostDocument, deepLink.selectedVignetteKey,
      deepLink.vignetteKeysLoaded ? deepLink.vignetteKeys : null,
      key => langs?.vignetteInfo?.[key]?.title)
    : null;
  // The document questions are asked on. Followed, it is the host's (null
  // while the host's page has none); otherwise the link's, as always.
  const selectedVignetteKey = hostDriven ? hosted?.key ?? null : deepLink.selectedVignetteKey;
  const vignetteInfo = selectedVignetteKey ? langs?.vignetteInfo?.[selectedVignetteKey] : undefined;

  const session = useChatSession({
    active: started,
    documentKey: selectedVignetteKey,
    languageName: selectedLanguageName,
    languageCode: selectedLanguageCode,
    langs,
    epoch,
    speak: false,
    tagQuestions: hostDriven,
    documentTitle: hosted?.title,
  });

  const tabs = useTabs({
    accessReady,
    languageCode: selectedLanguageCode,
    langs,
    vignetteKey: selectedVignetteKey,
    addFormTab: false,
  });
  const { resolvedTabs, setActiveTabId } = tabs;
  // No second panel for a chat-only project, or when the open document has no
  // tab (papers: a closed-access paper has no PDF tab). An empty panel is worse
  // than none.
  const noPanel = config.chatOnly || !resolvedTabs || resolvedTabs.length === 0;
  const refs = useDocRefs({
    docRefs: config.docRefs,
    resolvedTabs,
    messages: session.messages,
    setTabView: tabs.setTabView,
    reveal: (tabId) => { setActiveTabId(tabId); setMobileActivePanel('form'); },
  });

  // Clicked suggested question: send directly as user message, bypass input box.
  // On mobile, also switch panels to the chat so the user sees their question land.
  const handleQuestionClick = (question: string) => {
    setMobileActivePanel('chat');
    session.sendMessage(question);
  };

  // Open a paper from the picker, or (key = null) go back to the picker: a
  // fresh conversation either way, with a fresh session token.
  const openPaper = (key: string | null) => {
    if (!deepLink.openPaper(key)) return;
    session.reset();
    setEpoch(prev => prev + 1);
  };

  const tabViewContext: TabViewContext = {
    lang: selectedLanguageCode,
    loadingLabel: t('chat', 'loadingForm'),
    tabs,
    refs,
    onQuestionClick: handleQuestionClick,
    vignetteInfo,
  };

  // A talkPublicUrl project opened top-level: the browser is leaving for the
  // public page. Render nothing meanwhile, so neither the chat nor the picker
  // flashes first.
  if (deepLink.leavingForPublicPage) return null;
  // The gate is rendered after every hook above has run, so the hook order is
  // the same whether or not it shows.
  if (gate.gateShown) return <CourseAccessGate t={t} onUnlocked={gate.unlock} />;
  if (deepLink.vignetteRefused) return <UnknownDocumentScreen t={t} />;
  if (!started) return <LoadingScreen />;

  return (
    <>
      {/* The tab strip on a phone; a page with no second panel has nothing to switch to. */}
      {!noPanel && (
        <MobileTabStrip
          tabs={tabs}
          lang={selectedLanguageCode}
          chatLabel={t('chat', 'patientMode') || 'Chat'}
          mobilePanel={mobileActivePanel}
          onMobilePanel={setMobileActivePanel}
          languageSwitcher={{ langs, onSelect: setSelectedLanguageCode, label: t('welcome', 'languageLabel') || 'Language' }}
        />
      )}
      <div className={`main-container ${noPanel ? 'chat-only' : 'has-tabs'}`}>
        <ChatColumn
          session={session}
          t={t}
          langs={langs}
          lang={selectedLanguageCode}
          onLanguageChange={setSelectedLanguageCode}
          showTopBar
          mobileHidden={!noPanel && mobileActivePanel === 'form'}
          documentKey={selectedVignetteKey}
          vignetteInfo={vignetteInfo}
          hasContentTab={resolvedTabs?.some(tab => tab.type === 'content') || false}
          selectedPaper={selectedPaper}
          pickerPapers={deepLink.pickerPapers}
          openPaper={openPaper}
          embeddedInFrame={deepLink.embeddedInFrame}
          closeEmbeddingFrame={deepLink.closeEmbeddingFrame}
          starterQuestions={starterQuestions}
          renderAssistant={(text) => renderAssistantContent(text, refs, selectedLanguageCode)}
          onQuestionClick={handleQuestionClick}
          headerTitle={hostDriven ? hosted?.title : undefined}
          documentDividers={hostDriven}
          sendBlockedNotice={questionsBlocked({ hostDriven, listLoaded: deepLink.vignetteKeysLoaded, key: selectedVignetteKey })
            ? t('chat', 'noCurrentDocument') || 'Nothing on this page can be asked about. Move to a page that can, and the conversation carries on.'
            : undefined}
        />
        {!noPanel && (
          <div className={`right-panel ${mobileActivePanel === 'chat' ? 'mobile-hidden' : ''}`}>
            <TabbedPanel
              tabs={tabs}
              lang={selectedLanguageCode}
              // A form tab belongs to the simulator page; here it stays empty.
              renderTab={tab => tab.type === 'form'
                ? <div key={tab.id} data-tab-id={tab.id} />
                : renderTabView(tab, tabViewContext)}
            />
          </div>
        )}
      </div>
    </>
  );
}
