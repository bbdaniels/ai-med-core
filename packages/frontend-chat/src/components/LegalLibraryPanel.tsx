import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { api, apiFetch } from '../api-base';
import DocumentPanel from './DocumentPanel';

// Same code-split chunk App.tsx uses for the EIP PDF tab: pointing a second
// lazy() at the same module path shares the chunk rather than duplicating it,
// so pdfjs-dist (library + worker) still stays out of the entry bundle and is
// fetched only when a reader actually switches a document to its PDF view.
const PdfJsViewer = lazy(() => import('./PdfJsViewer'));

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
  // Repo-relative path to the document's saved source PDF, written into the
  // registry only when the fetch succeeded. Absent → no PDF view is offered.
  pdfFile?: string | null;
  // Repo-relative path to this document's section→page map, written into the
  // registry only when a map actually shipped. Absent → no section jumps.
  mapFile?: string | null;
}

// A section of a legal document and the PDF page it starts on (1-based).
// `confidence` records how the page was established: "confirmed" means an exact
// normalized match of the canonical heading text against exactly one page;
// "structural" means the heading was only detected in the page's own (possibly
// OCR'd) text, with no canonical text to check it against.
interface LegalMapSection {
  key: string;
  label: string;
  page: number;
  confidence?: 'confirmed' | 'structural';
}

interface LegalDocMap {
  docId?: string;
  source?: 'native' | 'ocr';
  sections?: LegalMapSection[];
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
  noText: string; noTextPdf: string; loading: string; loadFailed: string; disclaimer: string;
  viewText: string; viewPdf: string; viewLabel: string; openInNewTab: string;
  sections: string; pageAbbr: string; jumpHint: string;
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
    noTextPdf: 'Extracted text is not available for this document. Use the PDF view above to read it.',
    loading: 'Loading full text…',
    loadFailed: 'Could not load the full text. Use the official source above.',
    viewText: 'Text',
    viewPdf: 'PDF',
    viewLabel: 'View',
    openInNewTab: 'Open in new tab',
    sections: 'Sections',
    pageAbbr: 'p.',
    jumpHint: 'Open in the PDF',
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
    noTextPdf: 'Văn bản này không có bản trích xuất chữ. Vui lòng dùng chế độ xem PDF ở trên để đọc.',
    loading: 'Đang tải toàn văn…',
    loadFailed: 'Không tải được toàn văn. Vui lòng dùng nguồn chính thức ở trên.',
    viewText: 'Văn bản',
    viewPdf: 'PDF',
    viewLabel: 'Xem',
    openInNewTab: 'Mở trong tab mới',
    sections: 'Mục lục',
    pageAbbr: 'tr.',
    jumpHint: 'Mở trong bản PDF',
    disclaimer: 'Bạn có trách nhiệm bảo đảm sử dụng các văn bản pháp luật cập nhật mới nhất. Các văn bản, hoặc một phần của văn bản, hiển thị ở đây có thể đã bị thay thế.',
  },
};

export default function LegalLibraryPanel({ content, lang, selectTarget }: LegalLibraryPanelProps) {
  const t = UI[lang || 'en'] ?? UI.en;
  const documents = useMemo(() => content?.documents ?? [], [content]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [docText, setDocText] = useState<string | null>(null);
  const [textState, setTextState] = useState<'idle' | 'loading' | 'error'>('idle');
  // Which rendering of the selected document is on screen. The PDF is the
  // default wherever a document ships one: it is the instrument as issued --
  // stamps, signatures, page numbers a reader can cite -- while the text is our
  // extraction of it. A document with no saved PDF opens on its text, which is
  // then the only rendering there is.
  const [view, setView] = useState<'text' | 'pdf'>('pdf');
  // The selected document's section→page map, when one shipped. A document with
  // no map, or a map that fails to load, simply has no section list: everything
  // else on the panel is unchanged.
  const [docMap, setDocMap] = useState<LegalDocMap | null>(null);
  // A section click asks the PDF viewer to move; the bumped nonce re-triggers
  // even when the same section is clicked twice.
  const [pdfJump, setPdfJump] = useState<{ page: number; nonce: number } | null>(null);

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
  const pdfSrc = selected?.pdfFile ? api(`/api/project-content/${selected.pdfFile}`) : '';

  // A new document opens on its PDF whenever one was saved, and on its text
  // otherwise. Selecting a document resets this: carrying the previous
  // document's choice over would land a reader on "Text" for a document that has
  // none, showing a Text button styled active above a message saying there is no
  // text, with the only readable copy hidden one click away.
  useEffect(() => {
    setView(selected?.pdfFile ? 'pdf' : 'text');
    setPdfJump(null);
  }, [selectedId, selected?.textFile, selected?.pdfFile]);

  // Fetch the section map only for documents that ship one, through the same
  // /api/project-content route the PDF and the full text use. Any failure is
  // swallowed: the map is an accelerator, never a prerequisite for reading.
  useEffect(() => {
    const file = selected?.mapFile;
    if (!file) { setDocMap(null); return; }
    let cancelled = false;
    setDocMap(null);
    apiFetch(api(`/api/project-content/${file}`))
      .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
      .then((json: LegalDocMap) => { if (!cancelled) setDocMap(json && typeof json === 'object' ? json : null); })
      .catch(() => { if (!cancelled) setDocMap(null); });
    return () => { cancelled = true; };
  }, [selected?.mapFile]);

  // Which sections are offered as jumps. Where a canonical text is on screen,
  // only pages CONFIRMED by exact match are offered -- a structural guess must
  // never send a reader to a page that the text beside it contradicts. A
  // pdf-only document has nothing to confirm against, so its structural list is
  // all there is, and all it claims to be.
  const jumpSections = useMemo(() => {
    const all = (docMap?.sections ?? []).filter(
      (s): s is LegalMapSection =>
        !!s && typeof s.key === 'string' && typeof s.page === 'number' && s.page > 0,
    );
    return selected?.textFile ? all.filter(s => s.confidence === 'confirmed') : all;
  }, [docMap, selected?.textFile]);

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

          {/* Only documents whose source PDF was actually saved offer the choice;
              everything else is byte-identical to the text-only panel. */}
          {pdfSrc && (
            <div className="legal-doc-view-toggle" role="group" aria-label={t.viewLabel}>
              <button
                type="button"
                className={`legal-doc-view-btn${view === 'text' ? ' is-active' : ''}`}
                aria-pressed={view === 'text'}
                onClick={() => setView('text')}
              >
                {t.viewText}
              </button>
              <button
                type="button"
                className={`legal-doc-view-btn${view === 'pdf' ? ' is-active' : ''}`}
                aria-pressed={view === 'pdf'}
                onClick={() => setView('pdf')}
              >
                {t.viewPdf}
              </button>
            </div>
          )}

          {/* Section jumps. Present only when this document shipped a map AND a
              PDF to jump into; collapsed by default so a 121-article law does
              not push the document itself off a 390px screen. From the text
              view a click also flips the toggle to PDF -- that IS the jump. */}
          {pdfSrc && jumpSections.length > 0 && (
            <details className="legal-doc-sections">
              <summary className="legal-doc-sections-summary">
                {t.sections} <span className="legal-doc-sections-count">({jumpSections.length})</span>
              </summary>
              <ul className="legal-doc-section-list">
                {jumpSections.map((s, i) => (
                  <li key={`${s.key}-${i}`}>
                    <button
                      type="button"
                      className="legal-doc-section-jump"
                      title={t.jumpHint}
                      onClick={() => { setView('pdf'); setPdfJump({ page: s.page, nonce: Date.now() }); }}
                    >
                      <span className="legal-doc-section-label">{s.label || s.key}</span>
                      <span className="legal-doc-section-page">{t.pageAbbr} {s.page}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {pdfSrc && view === 'pdf' ? (
        <div className="legal-library-pdf">
          <Suspense fallback={<p className="legal-library-note">{t.loading}</p>}>
            <PdfJsViewer
              src={pdfSrc}
              title={resolveI18n(selected?.title, lang || 'en')}
              openLabel={t.openInNewTab}
              lang={lang}
              jumpTarget={pdfJump}
            />
          </Suspense>
        </div>
      ) : selected?.textFile ? (
        textState === 'loading' ? (
          <p className="legal-library-note">{t.loading}</p>
        ) : textState === 'error' ? (
          <p className="legal-library-note">{t.loadFailed}</p>
        ) : (
          // Reuse the document reader (find bar + typography) for the full text.
          <DocumentPanel content={{ markdown: docText || '' }} lang={lang} />
        )
      ) : (
        <p className="legal-library-note">{pdfSrc ? t.noTextPdf : t.noText}</p>
      )}
    </div>
  );
}
