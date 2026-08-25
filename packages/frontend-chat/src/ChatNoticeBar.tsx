import { useRef, useState } from 'react';
import { useDismiss } from './use-dismiss';

// Slim permanent line under the chat input for skipWelcome projects, which have
// no welcome page to carry this: a standing disclaimer (always visible) plus an
// abbreviated consent notice whose "Details" opens the full consent text.
//
// The language switcher used to live here too. It moved to <LanguageSwitcher /> in
// the chat top bar (client feedback, 2026-08-21: the control was too hard to find
// at the bottom of the dialog box). There is exactly one in-chat switcher; this
// bar is now notice-only.
interface ChatNoticeBarProps {
  /** Always-visible disclaimer line, e.g. what the answers are grounded in. */
  standingNote?: string;
  noticeLine: string;
  detailsLabel: string;
  consentParagraphs: string[];
}

export default function ChatNoticeBar({
  standingNote, noticeLine, detailsLabel, consentParagraphs,
}: ChatNoticeBarProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismiss(rootRef, open, () => setOpen(false));

  const hasConsent = consentParagraphs.length > 0;
  if (!standingNote && !hasConsent) return null;

  return (
    <div className="chat-notice-bar" ref={rootRef}>
      {open && hasConsent && (
        <div className="chat-notice-popover">
          {consentParagraphs.map((p, i) => (
            <p key={i} className="chat-notice-paragraph">{p}</p>
          ))}
        </div>
      )}
      {standingNote && (
        <p className="chat-standing-note">
          <span className="chat-standing-note-icon" aria-hidden="true">ⓘ</span> {standingNote}
        </p>
      )}
      {hasConsent && (
        <button
          type="button"
          className="chat-notice-line"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
        >
          {noticeLine ? <span className="chat-notice-text">{noticeLine}</span> : null}
          <span className="chat-notice-details"> · {detailsLabel}</span>
        </button>
      )}
    </div>
  );
}
