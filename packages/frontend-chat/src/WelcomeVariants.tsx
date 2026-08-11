interface WelcomeScreenProps {
  title: string;
  subtitle: string;
  instructionsLead: string;
  howItWorks: string;
  bullets: string[];
  bulletIcons?: string[];
  consentParagraphs: string[];
  consentHeading?: string;
  getStartedLabel: string;
  languageLabel?: string;
  languages?: { code: string; name: string }[];
  selectedLanguageCode?: string;
  onLanguageChange?: (code: string) => void;
  onStart: () => void;
}

// Default icons — lean clinical. Projects can override via languages.json welcome.bulletIcons.
const defaultStepIcons = ['\u{1FA7A}', '\u{1F50D}', '\u{1F9EA}', '\u{1F4CB}', '\u{1F465}'];

export default function WelcomeScreen(props: WelcomeScreenProps) {
  return (
    <div className="welcome-screen welcome-a">
      <div className="welcome-content wa-content">
        <div className="wa-header">
          <h1>{props.title}</h1>
          {/* Only render the subtitle when a project supplies one; an empty string
              (e.g. haivn_eip's trimmed welcome) leaves the header at just the title. */}
          {props.subtitle && <p className="wa-subtitle">{props.subtitle}</p>}
        </div>

        {props.languages && props.languages.length > 1 && (
          <div className="language-selector-wrapper">
            <label htmlFor="language-select">{props.languageLabel || 'Language'}</label>
            <select
              id="language-select"
              value={props.selectedLanguageCode}
              onChange={(e) => props.onLanguageChange?.(e.target.value)}
            >
              {props.languages.map((l) => (
                <option key={l.code} value={l.code}>{l.name}</option>
              ))}
            </select>
          </div>
        )}

        <div className="wa-steps">
          {props.bullets.map((bullet, i) => {
            const icons = props.bulletIcons && props.bulletIcons.length > 0 ? props.bulletIcons : defaultStepIcons;
            return (
              <div className="wa-step" key={i}>
                <span className="wa-step-icon">{icons[i] || icons[0]}</span>
                <p className="wa-step-text">{bullet}</p>
              </div>
            );
          })}
        </div>

        <div className="wa-consent-section">
          {(props.consentHeading === undefined ? 'Research Consent' : props.consentHeading) &&
            <h3 className="wa-consent-heading">{props.consentHeading ?? 'Research Consent'}</h3>}
          <div className="wa-consent-body">
            {props.consentParagraphs.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        </div>

        <button className="wa-start-btn" onClick={props.onStart}>
          {props.getStartedLabel}
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M7 4l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>
    </div>
  );
}
