import { useRef, useState } from 'react';
import { useDismiss } from './use-dismiss';

// The in-chat language control for skipWelcome projects, which never see the
// welcome screen's selector. It is deliberately a real control — flag, language
// name, and a chevron — sitting in the chat's top bar, not a line of small print
// under the input (client feedback, 2026-08-21: "the language indicator is small
// and located at the bottom of the dialog box, making it hard to find").
interface LanguageSwitcherProps {
  languages: Array<{ code: string; name: string; flag?: string }>;
  selectedCode: string;
  onSelect: (code: string) => void;
  /** Accessible name, e.g. "Language" / "Ngôn ngữ" (welcome.languageLabel). */
  label: string;
  className?: string;
}

export default function LanguageSwitcher({
  languages, selectedCode, onSelect, label, className,
}: LanguageSwitcherProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismiss(rootRef, open, () => setOpen(false));

  const current = languages.find(l => l.code === selectedCode) || languages[0];
  if (!current || languages.length < 2) return null;

  return (
    <div className={`lang-switcher${className ? ` ${className}` : ''}`} ref={rootRef}>
      <button
        type="button"
        className="lang-switcher-button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${current.name}`}
        title={label}
      >
        <span className="lang-switcher-flag" aria-hidden="true">{current.flag || '🌐'}</span>
        <span className="lang-switcher-name">{current.name}</span>
        <svg
          className="lang-switcher-caret"
          aria-hidden="true"
          width="12" height="12" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2.5"
          strokeLinecap="round" strokeLinejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="lang-switcher-menu" role="listbox" aria-label={label}>
          {languages.map(l => (
            <button
              key={l.code}
              type="button"
              role="option"
              aria-selected={l.code === selectedCode}
              className={`lang-switcher-option${l.code === selectedCode ? ' active' : ''}`}
              onClick={() => { onSelect(l.code); setOpen(false); }}
            >
              <span aria-hidden="true">{l.flag || '🌐'}</span> {l.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
