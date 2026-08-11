import { useEffect, useMemo, useState } from 'react';
import { api, apiFetch } from '../api-base';
import DocumentPanel from './DocumentPanel';

// A language-keyed string, e.g. {en: "...", vi: "..."}. Registry values use this
// shape throughout; plain strings are tolerated for forward-compatibility.
type I18n = string | Record<string, string>;

interface LegalDocument {
  id: string;
  number: string;
  type: string;
  typeLabel?: I18n;
  title: I18n;
  issuingAgency?: I18n;
  issueDate?: string;
  effectiveDate?: string;
  status: 'in-force' | 'superseded' | 'partially-superseded' | 'unknown';
  supersededBy?: string | null;
  statusEvidence?: I18n;
  scope?: I18n;
  officialUrl?: string;
  // The URL the EIP itself cites (usually thuvienphapluat.vn). Used as the source
  // link when officialUrl is missing or only a gazette homepage.
  eipUrl?: string;
  textFile?: string | null;
}

// The best human-facing source link: a specific official-document URL when we
// have one, else the EIP's own citation. A bare domain root (some gazette
// entries resolve only to the site homepage) is treated as no link at all.
function bestSourceUrl(doc: LegalDocument): string | undefined {
  const isSpecific = (u?: string): boolean => {
    if (!u) return false;
    try {
      return new URL(u).pathname.replace(/\/+$/, '').length > 0;
    } catch {
      return false;
    }
  };
  if (isSpecific(doc.officialUrl)) return doc.officialUrl;
  if (isSpecific(doc.eipUrl)) return doc.eipUrl;
  return doc.officialUrl || doc.eipUrl || undefined;
}

export interface LegalLibraryContent {
  label?: I18n;
  intro?: I18n;
  statusLabels?: Record<string, I18n>;
  documents?: LegalDocument[];
}

interface LegalLibraryPanelProps {
  content: LegalLibraryContent | null;
  lang?: string;
  // When set (bumped `nonce`), select this document id — driven from the chat side
  // where a clicked legal-document reference opens that document here.
  selectTarget?: { docId: string; nonce: number } | null;
}

function resolveI18n(val: I18n | undefined, lang: string): string {
  if (!val) return '';
  if (typeof val === 'string') return val;
  return val[lang] || val['en'] || '';
}

const UI: Record<string, {
  choose: string; empty: string; issued: string; effective: string;
  agency: string; openSource: string; scope: string;
  noText: string; loading: string; loadFailed: string; disclaimer: string;
}> = {
  en: {
    choose: 'Choose a document',
    empty: 'No legal documents available.',
    issued: 'Issued',
    effective: 'Effective',
    agency: 'Issuing agency',
    openSource: 'Open official source',
    scope: 'Scope',
    noText: 'Full text is not embedded for this document. Use the official source above to read it.',
    loading: 'Loading full text…',
    loadFailed: 'Could not load the full text. Use the official source above.',
    disclaimer: 'You are responsible for ensuring you rely on the most up-to-date legal documents. Documents, or portions of documents, shown here may be superseded.',
  },
  vi: {
    choose: 'Chọn một văn bản',
    empty: 'Không có văn bản pháp lý.',
    issued: 'Ban hành',
    effective: 'Hiệu lực',
    agency: 'Cơ quan ban hành',
    openSource: 'Mở nguồn chính thức',
    scope: 'Phạm vi',
    noText: 'Văn bản này chưa đính kèm toàn văn. Vui lòng dùng nguồn chính thức ở trên để đọc.',
    loading: 'Đang tải toàn văn…',
    loadFailed: 'Không tải được toàn văn. Vui lòng dùng nguồn chính thức ở trên.',
    disclaimer: 'Bạn có trách nhiệm bảo đảm sử dụng các văn bản pháp luật cập nhật mới nhất. Các văn bản, hoặc một phần của văn bản, hiển thị ở đây có thể đã bị thay thế.',
  },
};

export default function LegalLibraryPanel({ content, lang, selectTarget }: LegalLibraryPanelProps) {
  const t = UI[lang || 'en'] ?? UI.en;
  const documents = useMemo(() => content?.documents ?? [], [content]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [docText, setDocText] = useState<string | null>(null);
  const [textState, setTextState] = useState<'idle' | 'loading' | 'error'>('idle');

  // Default to the first document so the panel opens on something, and reset the
  // selection if the document set changes underneath us (e.g. language switch).
  useEffect(() => {
    if (documents.length === 0) {
      setSelectedId('');
    } else if (!documents.some(d => d.id === selectedId)) {
      setSelectedId(documents[0].id);
    }
  }, [documents, selectedId]);

  // Select the document a chat reference asked for (if it exists in the library).
  useEffect(() => {
    if (!selectTarget) return;
    if (documents.some(d => d.id === selectTarget.docId)) setSelectedId(selectTarget.docId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectTarget?.nonce]);

  const selected = documents.find(d => d.id === selectedId) ?? null;

  // Fetch the full text only for documents that ship one. The file is served by
  // the existing /api/project-content route (path-guarded to projects/).
  useEffect(() => {
    const file = selected?.textFile;
    if (!file) {
      setDocText(null);
      setTextState('idle');
      return;
    }
    let cancelled = false;
    setTextState('loading');
    setDocText(null);
    apiFetch(api(`/api/project-content/${file}`))
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then(text => { if (!cancelled) { setDocText(text); setTextState('idle'); } })
      .catch(() => { if (!cancelled) { setDocText(null); setTextState('error'); } });
    return () => { cancelled = true; };
  }, [selected?.textFile]);

  if (documents.length === 0) {
    return (
      <div className="document-panel-empty">
        <p>{t.empty}</p>
      </div>
    );
  }

  return (
    <div className="legal-library">
      <div className="legal-library-picker">
        {content?.intro && <p className="legal-library-intro">{resolveI18n(content.intro, lang || 'en')}</p>}
        <label className="legal-library-select-label" htmlFor="legal-doc-select">{t.choose}</label>
        <select
          id="legal-doc-select"
          className="legal-library-select"
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
        >
          {documents.map(doc => (
            <option key={doc.id} value={doc.id}>
              {(doc.number ? `${doc.number} — ` : '') + resolveI18n(doc.title, lang || 'en')}
            </option>
          ))}
        </select>
        <p className="legal-library-disclaimer">{t.disclaimer}</p>
      </div>

      {selected && (
        <div className="legal-library-meta">
          {selected.number && <span className="legal-library-number">{selected.number}</span>}
          <h3 className="legal-library-title">{resolveI18n(selected.title, lang || 'en')}</h3>
          {selected.typeLabel && <p className="legal-library-type">{resolveI18n(selected.typeLabel, lang || 'en')}</p>}

          <dl className="legal-library-fields">
            {selected.issuingAgency && (
              <>
                <dt>{t.agency}</dt>
                <dd>{resolveI18n(selected.issuingAgency, lang || 'en')}</dd>
              </>
            )}
            {selected.issueDate && (<><dt>{t.issued}</dt><dd>{selected.issueDate}</dd></>)}
            {selected.effectiveDate && (<><dt>{t.effective}</dt><dd>{selected.effectiveDate}</dd></>)}
          </dl>

          {selected.scope && (
            <p className="legal-library-scope"><strong>{t.scope}:</strong> {resolveI18n(selected.scope, lang || 'en')}</p>
          )}

          {bestSourceUrl(selected) && (
            <p className="legal-library-source">
              <a href={bestSourceUrl(selected)} target="_blank" rel="noopener noreferrer">
                {t.openSource} ↗
              </a>
            </p>
          )}
        </div>
      )}

      {selected?.textFile ? (
        textState === 'loading' ? (
          <p className="legal-library-note">{t.loading}</p>
        ) : textState === 'error' ? (
          <p className="legal-library-note">{t.loadFailed}</p>
        ) : (
          // Reuse the document reader (find bar + typography) for the full text.
          <DocumentPanel content={{ markdown: docText || '' }} lang={lang} />
        )
      ) : (
        <p className="legal-library-note">{t.noText}</p>
      )}
    </div>
  );
}
