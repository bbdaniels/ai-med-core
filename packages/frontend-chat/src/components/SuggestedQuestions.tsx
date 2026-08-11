interface I18nString {
  [lang: string]: string;
}

type LocalizableString = string | I18nString | undefined;

export interface QuestionsSection {
  heading: LocalizableString;
  questions: LocalizableString[];
}

export interface SuggestionsContent {
  label?: LocalizableString;
  intro?: LocalizableString;
  sections: QuestionsSection[];
}

interface SuggestedQuestionsProps {
  content: SuggestionsContent | null;
  lang: string;
  onQuestionClick: (question: string) => void;
}

function resolveI18n(val: LocalizableString, lang: string): string {
  if (!val) return '';
  if (typeof val === 'string') return val;
  return val[lang] || val['en'] || '';
}

export default function SuggestedQuestions({ content, lang, onQuestionClick }: SuggestedQuestionsProps) {
  if (!content || !Array.isArray(content.sections) || content.sections.length === 0) {
    return (
      <div className="suggestions-empty">
        <p>No suggestions available.</p>
      </div>
    );
  }

  const introText = resolveI18n(content.intro, lang);

  return (
    <div className="suggestions-panel">
      {introText && <p className="suggestions-intro">{introText}</p>}
      {content.sections.map((section, si) => {
        const heading = resolveI18n(section.heading, lang);
        return (
          <div key={si} className="suggestions-section">
            {heading && <h3 className="suggestions-heading">{heading}</h3>}
            <div className="suggestions-questions">
              {(section.questions || []).map((q, qi) => {
                const text = resolveI18n(q, lang);
                if (!text) return null;
                return (
                  <button
                    key={qi}
                    type="button"
                    className="suggestions-question"
                    onClick={() => onQuestionClick(text)}
                  >
                    {text}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
