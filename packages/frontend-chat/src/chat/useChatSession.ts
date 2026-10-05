// One conversation with the chat API: the messages, the input box, follow-up
// chips, the per-answer beyond-scope flag, the session token, and the opening
// turn. Shared by the simulator page (App.tsx) and the talk page (TalkApp.tsx).
//
// Voice is not handled here. A page that speaks its answers (the simulator's
// TTS) sets `speak`: each assistant reply is then parked in
// `pendingAssistantMessage` instead of being shown, and the page's player calls
// `beginSpeaking()` while it fetches audio and `revealPending(message)` when the
// text should appear. Without `speak` replies are shown at once.

import { useEffect, useRef, useState } from 'react';
import { scrollListToBottom } from '../scroll-list';
import { ChatSwitchedOffError, postChat } from './api';
import { questionOn } from '../host-document';
import type { LanguagesJson, Message } from './types';

export interface ChatSessionOptions {
  /** The conversation may open: the reader is past the welcome page. */
  active: boolean;
  /** The document (vignette) the conversation is about. */
  documentKey: string | null;
  /** The language name sent with each turn (the API's `language`). */
  languageName: string;
  /** The UI language code, for the project's fixed opening message. */
  languageCode: string;
  langs: LanguagesJson | null;
  /** A fresh session token is drawn when the session becomes active and whenever this changes. */
  epoch: number;
  /** Park assistant replies for a voice player instead of showing them (see above). */
  speak: boolean;
  /** Called when the opening turn has landed, with the case template the API returned. */
  onOpened?: (caseTemplate: string | null) => void;
  /**
   * followHost: tag each question with the document current when it was asked
   * (its key and title), for the API's history and the thread's dividers. The
   * conversation is never cleared when documentKey changes, here or anywhere.
   */
  tagQuestions?: boolean;
  /** The current document's title, for tagQuestions. */
  documentTitle?: string;
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function useChatSession(o: ChatSessionOptions) {
  const { active, documentKey, languageName, languageCode, langs, epoch, speak, onOpened, tagQuestions, documentTitle } = o;
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [initialized, setInitialized] = useState(false);
  // Inline follow-up suggestions returned by /api/chat (only populated when the project
  // sets enableFollowups=true). Rendered as clickable chips above the input box.
  const [followups, setFollowups] = useState<string[]>([]);
  // Holds the whole assistant Message (not just its text) so per-message flags
  // such as beyondScope survive the voice path and land on the flushed bubble.
  const [pendingAssistantMessage, setPendingAssistantMessage] = useState<Message | null>(null);
  const [awaitingTTS, setAwaitingTTS] = useState(false);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  // Keep a ref to the latest token for event handlers
  const sessionTokenRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Guard against double-submit: isLoading state lags by a render, so rapid Enter+click
  // can bypass the isLoading check. This ref updates synchronously.
  const sendInFlightRef = useRef(false);

  // The player has the audio (or gave up on it): show the reply and free the input.
  const revealPending = (message: Message) => {
    setMessages(prev => [...prev, message]);
    setPendingAssistantMessage(null);
    setAwaitingTTS(false);
    setIsLoading(false);
    sendInFlightRef.current = false;
  };
  const beginSpeaking = () => setAwaitingTTS(true);

  // A fresh conversation on another document (the next case, another paper).
  const reset = () => {
    setMessages([]);
    setPendingAssistantMessage(null);
    setAwaitingTTS(false);
    setInput('');
    setFollowups([]);
    setInitialized(false);
  };

  const initializeConversation = async () => {
    if (!documentKey) return;

    // If a hardcoded opening message is defined for this project, use it directly
    // and skip the LLM greeting roundtrip. This gives a stable, predictable first turn.
    const langChat = (langs?.ui?.[languageCode]?.chat ?? langs?.ui?.['en']?.chat ?? {}) as Record<string, unknown>;
    const hardcodedOpening = typeof langChat.openingMessage === 'string' ? langChat.openingMessage.trim() : '';
    if (hardcodedOpening) {
      if (speak) {
        setIsLoading(true);
        setPendingAssistantMessage({ role: 'assistant', content: hardcodedOpening });
      } else {
        setMessages([{ role: 'assistant', content: hardcodedOpening }]);
      }
      onOpened?.(null);
      setInitialized(true);
      return;
    }

    try {
      setIsLoading(true);
      const response = await postChat({
        messages: [{ role: 'user', content: 'Please begin the conversation as instructed.' }],
        vignetteKey: documentKey,
        language: languageName,
        sessionToken,
      });

      // The greeting turn is generated from the project's own prompt, so it is
      // never marked as going beyond the reference content.
      const opening: Message = { role: 'assistant', content: response.message };
      if (speak) {
        setPendingAssistantMessage(opening);
        // isLoading stays true; the player's revealPending clears it
      } else {
        setMessages([opening]);
        setIsLoading(false);
      }
      onOpened?.(response.caseTemplate || null);
      setInitialized(true);
    } catch (error) {
      console.error('Error initializing conversation:', error);
      setMessages([{
        role: 'assistant',
        content: error instanceof ChatSwitchedOffError
          ? error.message
          : 'Error starting conversation. Please check your connection and try again.'
      }]);
      setIsLoading(false);
    }
  };

  // Open the conversation once a document is chosen (only after start).
  useEffect(() => {
    if (active && documentKey && !initialized) {
      initializeConversation();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, documentKey, initialized]);

  // A new session token on start and on every epoch (the simulator's form reload).
  useEffect(() => {
    if (!active) return;
    setSessionToken(randomToken());
  }, [active, epoch]);

  useEffect(() => {
    sessionTokenRef.current = sessionToken;
  }, [sessionToken]);

  // A language switch before the reader's first question re-localizes the
  // project's fixed opening message, which was placed in the language active
  // when the conversation began. Only a lone opening message that matches one of
  // the project's own openingMessage strings is replaced, so an LLM greeting or
  // a conversation already under way is never rewritten.
  useEffect(() => {
    if (!langs?.ui) return;
    const openings = new Set(Object.values(langs.ui)
      .map(u => (u?.chat as Record<string, unknown> | undefined)?.openingMessage)
      .filter((m): m is string => typeof m === 'string' && m.trim() !== '')
      .map(m => m.trim()));
    const langChat = (langs.ui[languageCode]?.chat ?? langs.ui['en']?.chat ?? {}) as Record<string, unknown>;
    const next = typeof langChat.openingMessage === 'string' ? langChat.openingMessage.trim() : '';
    if (!next) return;
    setMessages(prev => (prev.length === 1 && prev[0].role === 'assistant'
      && prev[0].content !== next && openings.has(prev[0].content))
      ? [{ ...prev[0], content: next }] : prev);
  }, [langs, languageCode]);

  // sendMessage accepts an optional overrideText — used by clickable
  // suggested questions, which bypass the input box and send directly.
  const sendMessage = async (overrideText?: string) => {
    const messageText = (typeof overrideText === 'string' ? overrideText : input).trim();
    if (!messageText || !documentKey) return;
    // Ref-based guard prevents concurrent sends (state-based isLoading lags a render).
    if (sendInFlightRef.current) return;
    sendInFlightRef.current = true;

    const userMessage: Message = tagQuestions
      ? questionOn(messageText, { key: documentKey, title: documentTitle })
      : { role: 'user', content: messageText };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    if (typeof overrideText !== 'string') setInput('');
    setFollowups([]); // clear stale follow-ups from the previous turn
    setIsLoading(true);

    try {
      const response = await postChat({
        messages: newMessages,
        vignetteKey: documentKey,
        language: languageName,
        sessionToken,
      });

      const assistantMessage: Message = {
        role: 'assistant',
        content: response.message,
        beyondScope: response.beyondScope === true,
      };
      if (speak) {
        setPendingAssistantMessage(assistantMessage);
        // isLoading stays true; the player's revealPending clears it + sendInFlightRef
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
        content: error instanceof ChatSwitchedOffError
          ? error.message
          : 'Connection error. Please check your internet connection and try again.'
      }]);
      setIsLoading(false);
      sendInFlightRef.current = false;
    }
  };

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

  return {
    messages, input, setInput, isLoading, initialized, followups,
    pendingAssistantMessage, awaitingTTS, beginSpeaking, revealPending,
    sendMessage, reset, sessionToken, sessionTokenRef, inputRef, messagesEndRef,
  };
}

export type ChatSession = ReturnType<typeof useChatSession>;
