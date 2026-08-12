import { useEffect, useRef, useState } from 'react';

// Slim permanent line under the chat input for skipWelcome projects: shows the
// current language (flag + name) and an abbreviated consent notice; tapping it
// opens a popover that is both the language switcher and the full notice text.
// This replaces the welcome page's two jobs (selector + consent) in one control.
interface ChatNoticeBarProps {
  languages: Array<{ code: string; name: string; flag?: string }>;
  selectedCode: string;
  onSelect: (code: string) => void;
  noticeLine: string;
  detailsLabel: string;
  consentParagraphs: string[];
}

export default function ChatNoticeBar({
  languages, selectedCode, onSelect, noticeLine, detailsLabel, consentParagraphs,
}: ChatNoticeBarProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const current = languages.find(l => l.code === selectedCode) || languages[0];

  // Close on outside tap / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!current) return null;

  return (
    <div className="chat-notice-bar" ref={rootRef}>
      {open && (
        <div className="chat-notice-popover">
          <div className="chat-notice-langs">
            {languages.map(l => (
              <button
                key={l.code}
                type="button"
                className={`chat-notice-lang-option${l.code === selectedCode ? ' active' : ''}`}
                onClick={() => { onSelect(l.code); setOpen(false); }}
              >
                <span aria-hidden="true">{l.flag || '🌐'}</span> {l.name}
              </button>
            ))}
          </div>
          {consentParagraphs.map((p, i) => (
            <p key={i} className="chat-notice-paragraph">{p}</p>
          ))}
        </div>
      )}
      <button
        type="button"
        className="chat-notice-line"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        <span aria-hidden="true">{current.flag || '🌐'}</span> {current.name}
        {noticeLine ? <span className="chat-notice-text"> · {noticeLine}</span> : null}
        <span className="chat-notice-details"> — {detailsLabel}</span>
      </button>
    </div>
  );
}
