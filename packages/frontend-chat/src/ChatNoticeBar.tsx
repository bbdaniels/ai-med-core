import { useRef, useState } from 'react';
import { useDismiss } from './use-dismiss';

// Standing notices for skipWelcome projects, which have no welcome page to carry
// them: a grounding disclaimer (always visible) plus an abbreviated consent line
// whose "Details" opens the full consent text.
//
// It renders in the top-right of <div className="chat-topbar">, opposite the
// language switcher. Both used to sit at the bottom: the switcher moved up on
// 2026-08-21 (client feedback: too hard to find under the dialog box) and these
// notices followed on 2026-08-28, which returned the bottom band to the chat.
// The popover therefore opens DOWNWARD and leftward from the corner — see
// .chat-notice-popover in style.css.
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
