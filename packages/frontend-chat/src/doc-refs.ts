// Recognizing document references inside an assistant answer and turning them
// into in-panel jump links.
//
// A document-advisor project (e.g. haivn_eip) answers in prose and refers to
// parts of a reference document by number -- "Section 4.1", "Appendix 7.1", and
// the Vietnamese equivalents "Mục 4.1" / "Phần 4.1" / "Phụ lục 7.1". The reader
// document (a `document` tab) carries stable `{#sec-4-1}` / `{#app-7-1}` heading
// anchors keyed on the section NUMBER, so they are identical across the English
// and Vietnamese editions. This module recognizes those references in an answer
// and resolves each to an anchor id, so the chat can scroll the document to it.
//
// Two deliberate properties:
//   - It recognizes the references the model ALREADY emits (the system prompt
//     asks it to cite sections by number), so it needs no new out-of-band marker
//     and degrades to plain text when the model writes nothing recognizable.
//   - It only ever resolves to an anchor that actually exists in the loaded
//     document (`validAnchors`), so a section the model invented stays plain
//     text -- a dead link is worse than no link.
//
// The mechanism is project-agnostic: the trigger vocabulary and the anchor
// prefix it maps to are supplied by config, and the number->anchor transform
// ("4.1" -> "sec-4-1") is the anchor convention the document markdown carries.
//
// The same module recognizes citations of LEGAL instruments in a project that
// ships a legal library: a bare instrument number ("96/2023/NĐ-CP") resolves to
// that document, and a number qualified by an article ("96/2023/NĐ-CP, Điều 40",
// or the reverse order "Điều 40 của Nghị định 96/2023/NĐ-CP") additionally
// resolves to that document's section-map key ("dieu-40"), which the caller turns
// into a page. The same two properties hold: no out-of-band marker syntax, and a
// number that is not in the library — or an article the map does not carry —
// degrades rather than producing a link that goes nowhere.

export interface DocRefPattern {
  /** Anchor prefix these words map to, e.g. "sec" or "app". */
  prefix: string;
  /** Surface words that introduce a numbered reference, e.g. ["Section", "Mục"]. */
  words: string[];
}

export interface DocRefsConfig {
  /** id of the `document` tab these references point into. */
  tabId: string;
  patterns: DocRefPattern[];
  /**
   * Words that introduce an article of a LEGAL instrument, recognized only when
   * they sit next to a known instrument number ("96/2023/NĐ-CP, Điều 40"). Left
   * unset the built-in vocabulary below is used, so no project.json change is
   * needed; a project with a different citation habit can override it.
   */
  legalSectionWords?: string[];
}

/** A run of message text. A resolved reference carries EITHER `anchor` (a passage
 *  in the document tab) OR `legalId` (a document in the legal-library tab), and a
 *  legal reference may additionally carry `sectionKey` -- the section-map key of
 *  the article it names ("dieu-40"), when the citation named one. */
export interface DocRefSegment {
  text: string;
  anchor?: string;
  legalId?: string;
  sectionKey?: string;
}

// The article of a Vietnamese legal instrument, in the two languages the advisor
// answers in plus the bare-ASCII spelling a keyboard without diacritics produces.
// Only articles: the section maps key chapters as "chuong-1" while an answer
// writes "Chương I", and a roman-numeral guess is exactly the kind of near-miss
// that sends a reader to the wrong page.
const DEFAULT_LEGAL_SECTION_WORDS = ['Điều', 'Dieu', 'Article', 'Articles', 'Art.'];

// Section-map keys are Vietnamese and article-scoped ("dieu-40"), whichever
// language the citation was written in, so both "Điều 40" and "Article 40" from
// the same answer land on the same page.
const LEGAL_SECTION_PREFIX = 'dieu';

// The ONLY words that may sit between an article number and the instrument
// number it belongs to, in the reverse-order citation "Điều 40 của Nghị định
// 96/2023/NĐ-CP". A closed vocabulary, deliberately, not a word budget: the
// first version allowed any four letters-only words, and that bound
// "Điều 40 aligns with Law 15/2023/QH15 on scope of practice" to the Law,
// producing a confident page jump into a document that does not contain the
// article. Every entry here is either a possessive/preposition or one token of
// an instrument-type noun, so any verb or relational phrase -- "aligns with",
// "amends", "applies to", "referenced in", "và" -- breaks the bridge and the
// citation degrades to the whole-document link the bare-number match provides.
// One entry per whitespace-separated token: "Nghị định" is two connectors,
// "Thông tư" is two, which is why the span below allows up to four of them
// ("của Nghị định số" is the longest real form).
const LEGAL_REF_CONNECTORS = [
  // possessive / prepositional / "number"
  'của', 'cua', 'thuộc', 'thuoc', 'trong', 'tại', 'tai', 'số', 'so',
  'of', 'the', 'in', 'no', 'number',
  // instrument-type nouns, tokenized: Nghị định, Thông tư, Luật, Quyết định,
  // Pháp lệnh, Chỉ thị, Công văn, Văn bản
  'nghị', 'nghi', 'định', 'dinh', 'thông', 'thong', 'tư', 'tu',
  'luật', 'luat', 'quyết', 'quyet', 'pháp', 'phap', 'lệnh', 'lenh',
  'chỉ', 'chi', 'thị', 'thi', 'công', 'cong', 'văn', 'van', 'bản', 'ban',
  'decree', 'circular', 'law', 'decision', 'resolution', 'ordinance',
  'directive', 'document', 'act',
];

/** One connector token, longest-first, with the optional period of "No." */
const LEGAL_CONNECTOR_TOKEN = `(?:${[...LEGAL_REF_CONNECTORS]
  .sort((a, b) => b.length - a.length)
  .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|')})\\.?`;

/** "40" / "40a" -> "dieu-40" / "dieu-40a", the key `maps/<id>.json` uses. */
export function legalSectionKey(num: string): string {
  return `${LEGAL_SECTION_PREFIX}-${num.toLowerCase()}`;
}

// A legal-document number as it appears in the registry ("1740/QĐ-BYT",
// "96/2023/NĐ-CP"). Escapes only true regex metacharacters -- `/` and `-` are
// literal outside a character class, and under the `u` flag escaping `-` is in
// fact an error. A leading lookbehind (added by the caller) keeps a number from
// matching inside a longer one.
function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every `{#anchor}` id declared in a document's markdown. */
export function extractAnchorIds(markdown: string): Set<string> {
  const ids = new Set<string>();
  const re = /\{#([A-Za-z0-9-]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) ids.add(m[1]);
  return ids;
}

// Escape regex metacharacters, and let any literal space in a trigger word
// ("Phụ lục") match one-or-more whitespace so odd spacing still resolves.
function toWordPattern(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
}

/**
 * Build a matcher that splits an answer into plain-text and resolved-reference
 * segments. Returns null when the config is unusable (no patterns / no anchors),
 * which the caller treats as "feature off".
 */
export function buildDocRefMatcher(
  config: DocRefsConfig,
  validAnchors: Set<string>,
  legalNumberToId?: Map<string, string>,
): ((text: string) => DocRefSegment[]) | null {
  const hasLegal = !!legalNumberToId && legalNumberToId.size > 0;
  // Feature is off only when there is nothing to resolve to at all.
  if (!config || (validAnchors.size === 0 && !hasLegal)) return null;

  // One regex over all known legal-document numbers, longest first so a full
  // "15/2023/QH15" wins over any shorter number embedded in it. Only numbers that
  // are actually in the library are matched, so a number the model invented (or
  // one not in the corpus) stays plain text.
  const legalNumbers = hasLegal
    ? [...legalNumberToId!.keys()].sort((a, b) => b.length - a.length).map(escapeLiteral).join('|')
    : '';
  const legalRe = hasLegal ? new RegExp(`(?<!\\d)(${legalNumbers})`, 'gu') : null;

  // The same numbers, qualified by an article: "96/2023/NĐ-CP, Điều 40" and the
  // reverse order Vietnamese also writes, "Điều 40 của Nghị định 96/2023/NĐ-CP".
  // Both spans include the instrument number, so they outrank the bare-number
  // match at the same position (longest-wins in the overlap pass below) and a
  // citation that names an article never degrades to a whole-document link while
  // its page is known.
  const sectionWords = (config.legalSectionWords && config.legalSectionWords.length > 0
    ? config.legalSectionWords
    : DEFAULT_LEGAL_SECTION_WORDS)
    .filter((w) => typeof w === 'string' && w.length > 0)
    .sort((a, b) => b.length - a.length)
    .map(toWordPattern)
    .join('|');
  // "40", "40a" -- an article number, never the start of a longer number.
  const artNum = '(\\d+[a-zA-Z]?)(?!\\d)';
  const legalSectionRes: Array<{ re: RegExp; numFirst: boolean }> = hasLegal && sectionWords
    ? [
        // number first, comma optional: "96/2023/NĐ-CP, Điều 40"
        { re: new RegExp(`(?<!\\d)(${legalNumbers})\\s*,?\\s*(?:${sectionWords})\\s*${artNum}`, 'giu'), numFirst: true },
        // article first, bridged only by connector words from the closed
        // vocabulary above ("của Nghị định", "of Law"), at most four of them.
        // A non-connector word anywhere in the bridge ends the match, so an
        // article can never be bound to an instrument it is merely mentioned
        // alongside; that citation falls through to the bare-number match and
        // opens the document without claiming a page.
        { re: new RegExp(`(?<![\\p{L}\\p{M}])(?:${sectionWords})\\s*${artNum}\\s+(?:${LEGAL_CONNECTOR_TOKEN}\\s+){0,4}?(${legalNumbers})(?!\\d)`, 'giu'), numFirst: false },
      ]
    : [];
  // The section regexes match case-insensitively (so "article 40" resolves too),
  // which means the captured number may not be byte-identical to the registry
  // key; resolve those through a lowercased index.
  const legalByLower = new Map<string, string>();
  if (hasLegal) for (const [num, id] of legalNumberToId!) legalByLower.set(num.toLowerCase(), id);

  // One regex per pattern group. Longer words first so "Sections" wins over
  // "Section" at the same position. The leading lookbehind rejects a word that
  // is really the tail of a longer one ("subsection"). The trailing group is the
  // section number; `(?:\.\d+)*` stops before a sentence-ending period.
  const compiled = (config.patterns || [])
    .map((p) => {
      const words = (p.words || [])
        .filter((w) => typeof w === 'string' && w.length > 0)
        .sort((a, b) => b.length - a.length)
        .map(toWordPattern)
        .join('|');
      if (!words) return null;
      return {
        prefix: p.prefix,
        re: new RegExp(`(?<![\\p{L}\\p{M}])(?:${words})\\s+(\\d+(?:\\.\\d+)*)`, 'giu'),
      };
    })
    .filter((c): c is { prefix: string; re: RegExp } => c !== null);

  if (compiled.length === 0 && !legalRe) return null;

  return (text: string): DocRefSegment[] => {
    const hits: Array<{ start: number; end: number; anchor?: string; legalId?: string; sectionKey?: string }> = [];
    for (const { prefix, re } of compiled) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        const anchor = `${prefix}-${m[1].replace(/\./g, '-')}`;
        // The load-bearing guard: only link references that exist in the document.
        if (!validAnchors.has(anchor)) continue;
        hits.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, anchor });
      }
    }
    for (const { re, numFirst } of legalSectionRes) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        const legalId = legalByLower.get((numFirst ? m[1] : m[2]).toLowerCase());
        if (!legalId) continue;
        hits.push({
          start: m.index ?? 0,
          end: (m.index ?? 0) + m[0].length,
          legalId,
          sectionKey: legalSectionKey(numFirst ? m[2] : m[1]),
        });
      }
    }
    if (legalRe) {
      legalRe.lastIndex = 0;
      for (const m of text.matchAll(legalRe)) {
        const legalId = legalNumberToId!.get(m[1]);
        if (!legalId) continue;
        hits.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, legalId });
      }
    }
    if (hits.length === 0) return [{ text }];

    // Earliest first; on a tie prefer the longer match. Skip any that overlaps
    // one already taken so two patterns can't both claim the same span.
    hits.sort((a, b) => a.start - b.start || b.end - a.end);
    const segments: DocRefSegment[] = [];
    let cursor = 0;
    for (const h of hits) {
      if (h.start < cursor) continue;
      if (h.start > cursor) segments.push({ text: text.slice(cursor, h.start) });
      segments.push({ text: text.slice(h.start, h.end), anchor: h.anchor, legalId: h.legalId, sectionKey: h.sectionKey });
      cursor = h.end;
    }
    if (cursor < text.length) segments.push({ text: text.slice(cursor) });
    return segments;
  };
}
