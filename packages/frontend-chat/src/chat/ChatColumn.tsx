// The chat column both pages share: the top bar of a project without a
// welcome page (language switcher, grounding and consent notices), the header
// (the document's title, a paper's venue and DOI with its Close or All-papers
// control, the scenario text), the paper picker, the conversation with its
// beyond-scope markers, the starter questions, the follow-up chips and the
// input. A page adds its own controls through `headerSlot` (above the
// conversation) and `voiceSlot` (in the header).

import type React from 'react';
import ChatNoticeBar from '../ChatNoticeBar';
import LanguageSwitcher from '../LanguageSwitcher';
import type { TalkPaper } from '../talk-paper';
import type { LanguagesJson, Message, VignetteInfo } from './types';
import type { ChatSession } from './useChatSession';
import type { Translate } from './useLanguages';

export interface ChatColumnProps {
  session: ChatSession;
  t: Translate;
  langs: LanguagesJson | null;
  lang: string;
  onLanguageChange: (code: string) => void;
  /** The top bar: on for a project that has no welcome page (skipWelcome). */
  showTopBar: boolean;
  /** Hidden on a phone while the second panel is showing. */
  mobileHidden: boolean;
  headerSlot?: React.ReactNode;
  voiceSlot?: React.ReactNode;
  documentKey: string | null;
  vignetteInfo?: VignetteInfo;
  /** A content tab carries the scenario, so the header leaves it out. */
  hasContentTab: boolean;
  selectedPaper: TalkPaper | null;
  pickerPapers: TalkPaper[];
  openPaper: (key: string | null) => void;
  embeddedInFrame: boolean;
  closeEmbeddingFrame: () => void;
  starterQuestions: string[];
  renderAssistant: (text: string) => React.ReactNode;
  onQuestionClick: (question: string) => void;
}

export default function ChatColumn({
  session, t, langs, lang, onLanguageChange, showTopBar, mobileHidden, headerSlot, voiceSlot,
  documentKey, vignetteInfo, hasContentTab, selectedPaper, pickerPapers, openPaper,
  embeddedInFrame, closeEmbeddingFrame, starterQuestions, renderAssistant, onQuestionClick,
}: ChatColumnProps) {
  const { messages, input, setInput, isLoading, followups, inputRef, messagesEndRef, sendMessage } = session;
  const handleKeyPress = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };
  return (
    <div className={`left-panel ${mobileHidden ? 'mobile-hidden' : ''}`}>
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
        {showTopBar && (() => {
          const code = lang || 'en';
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
                  selectedCode={lang || 'en'}
                  onSelect={onLanguageChange}
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
        {headerSlot}

        <div className="left-panel-content">
          {/* Chatbot Interface */}
          <div className="chatbot-container chatbot-container-inner">
            {/* Conversation Display */}
            <div className="conversation-display conversation-display-inner">
              {/* Scrollable Header */}
              <div className="chat-header-scrollable">
                {(() => {
                  const vi = vignetteInfo;
                  return (
                    <div className="vignette-info">
                      <h1>{vi?.title || selectedPaper?.title || t('chat','headerTitle')}</h1>
                      {selectedPaper && (
                        <p className="paper-meta">
                          {[selectedPaper.venue, selectedPaper.year].filter(Boolean).join(', ')}
                          {selectedPaper.doi && (
                            <> · <a href={`https://doi.org/${selectedPaper.doi}`} target="_blank" rel="noopener noreferrer">https://doi.org/{selectedPaper.doi}</a></>
                          )}
                          {embeddedInFrame ? (
                            <> · <button type="button" className="paper-picker-back" onClick={closeEmbeddingFrame}>
                              {t('chat', 'pickerClose') || 'Close'}
                            </button></>
                          ) : pickerPapers.length > 1 && (
                            <> · <button type="button" className="paper-picker-back" onClick={() => openPaper(null)}>
                              {t('chat', 'pickerBack') || 'All papers'}
                            </button></>
                          )}
                        </p>
                      )}
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
                        const langChat = (langs?.ui?.[lang]?.chat ?? langs?.ui?.['en']?.chat ?? {}) as Record<string, unknown>;
                        const desc = typeof langChat.description === 'string' ? langChat.description : '';
                        return desc ? <div className="vignette-description">{desc.split('\n\n').map((p, i) => <p key={i}>{p}</p>)}</div> : null;
                      })()}
                    </div>
                  );
                })()}
                {voiceSlot}
              </div>

              <div className="messages-container">
                {!documentKey && pickerPapers.length > 0 && (
                  <div className="paper-picker">
                    <h2>{t('chat', 'pickerHeading') || 'Choose a paper'}</h2>
                    <ul>
                      {pickerPapers.map(p => (
                        <li key={p.vignette}>
                          <button type="button" onClick={() => openPaper(p.vignette)}>
                            <span className="paper-picker-title">{p.title}</span>
                            <span className="paper-picker-meta">{[p.venue, p.year].filter(Boolean).join(', ')}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {messages.map((message: Message, index: number) => (
                  <div key={index} className={`message ${message.role === 'user' ? 'user-message' : 'bot-message'}`}>
                    <div className="message-content">
                      {message.role === 'assistant' ? renderAssistant(message.content) : message.content}
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
                      onClick={() => onQuestionClick(q)}
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
                      onClick={() => onQuestionClick(q)}
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
                  onClick={() => sendMessage()}
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
  );
}
