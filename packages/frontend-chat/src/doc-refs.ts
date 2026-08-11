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
}

/** A run of message text. A resolved reference carries EITHER `anchor` (a passage
 *  in the document tab) OR `legalId` (a document in the legal-library tab). */
export interface DocRefSegment {
  text: string;
  anchor?: string;
  legalId?: string;
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
  const legalRe = hasLegal
    ? new RegExp(
        '(?<!\\d)(' +
          [...legalNumberToId!.keys()]
            .sort((a, b) => b.length - a.length)
            .map(escapeLiteral)
            .join('|') +
          ')',
        'gu',
      )
    : null;

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
    const hits: Array<{ start: number; end: number; anchor?: string; legalId?: string }> = [];
    for (const { prefix, re } of compiled) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        const anchor = `${prefix}-${m[1].replace(/\./g, '-')}`;
        // The load-bearing guard: only link references that exist in the document.
        if (!validAnchors.has(anchor)) continue;
        hits.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, anchor });
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
      segments.push({ text: text.slice(h.start, h.end), anchor: h.anchor, legalId: h.legalId });
      cursor = h.end;
    }
    if (cursor < text.length) segments.push({ text: text.slice(cursor) });
    return segments;
  };
}
