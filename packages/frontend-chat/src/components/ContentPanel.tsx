import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Configure marked for safe inline rendering
marked.setOptions({ breaks: true });

interface ContentSection {
  heading: string;
  content: string;
  image?: string;
}

interface ContentPanelProps {
  globalSections?: ContentSection[];
  sceneSections?: ContentSection[];
  basePath?: string;
  actionLabel?: string;
  onAction?: () => void;
}

function MarkdownContent({ content }: { content: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(content) as string), [content]);
  return <div className="content-section-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

function Section({ section, basePath, className }: { section: ContentSection; basePath?: string; className: string }) {
  return (
    <div className={`content-section ${className}`}>
      <h3>{section.heading}</h3>
      {section.image && (
        <img
          src={`${basePath || ''}images/${section.image}`}
          alt={section.heading}
          className="content-section-image"
        />
      )}
      <MarkdownContent content={section.content} />
    </div>
  );
}

export default function ContentPanel({ globalSections, sceneSections, basePath, actionLabel, onAction }: ContentPanelProps) {
  return (
    <div className="content-panel">
      {globalSections && globalSections.length > 0 && (
        <div className="content-panel-global">
          {globalSections.map((section, i) => (
            <Section key={`global-${i}`} section={section} basePath={basePath} className="global-section" />
          ))}
        </div>
      )}

      {sceneSections && sceneSections.length > 0 && (
        <div className="content-panel-scene">
          {sceneSections.map((section, i) => (
            <Section key={`scene-${i}`} section={section} basePath={basePath} className="scene-section" />
          ))}
        </div>
      )}

      {actionLabel && onAction && (
        <div className="content-panel-action">
          <button className="content-panel-action-btn" onClick={onAction}>
            {actionLabel}
          </button>
        </div>
      )}

      {(!globalSections || globalSections.length === 0) && (!sceneSections || sceneSections.length === 0) && (
        <div className="content-panel-empty">
          <p>No content available for this tab.</p>
        </div>
      )}
    </div>
  );
}
