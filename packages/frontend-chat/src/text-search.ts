/**
 * One spelling of "how text is compared when a reader searches", shared by every
 * find bar in the app.
 *
 * Vietnamese is the reason this exists. A reader on a laptop keyboard types
 * `dieu tri`, and the document says `điều trị`; a reader with a Vietnamese IME
 * types `điều trị`, and an OCR'd scan spells it `diêu tri`. Folding both sides
 * to the same accent-free, case-free, single-spaced form is what makes those the
 * same query. It is the same fold `tools/build-jump-maps.py` applies on the
 * Python side (`strip_diacritics` / `norm`), so the section maps and the find
 * bars agree about what matches what.
 */

const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Fold a single character to its comparison form. NFD splits every Vietnamese
 * vowel into a base letter plus combining marks, which are then dropped — but
 * `đ`/`Đ` is a letter in its own right and NFD leaves it alone, so it is folded
 * by hand. Returns '' for a character that is nothing but an accent, and
 * occasionally more than one character (ligatures), which is why callers that
 * need to map back to the source track the mapping per output character.
 */
function foldChar(ch: string): string {
  if (ch === 'đ' || ch === 'Đ') return 'd';
  return ch.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();
}

/** The comparison form of a query: folded, with runs of whitespace collapsed. */
export function foldQuery(query: string): string {
  let out = '';
  let lastWasSpace = false;
  for (const ch of query) {
    if (/\s/.test(ch)) {
      if (!lastWasSpace && out.length > 0) out += ' ';
      lastWasSpace = true;
      continue;
    }
    lastWasSpace = false;
    out += foldChar(ch);
  }
  return out.trimEnd();
}

export interface FoldedText {
  /** The comparison form the query is matched against. */
  folded: string;
  /**
   * `map[i]` is the index in the source string of the character that produced
   * `folded[i]`. This is what lets a match found in the folded form be painted
   * back onto the original characters, whose lengths and spacing differ.
   */
  map: Int32Array;
}

/**
 * Fold a source string and keep, for every folded character, the source index it
 * came from. Whitespace runs collapse to one space (mapped to the first
 * whitespace character of the run), so a query typed with single spaces still
 * matches text broken across lines or padded out with layout spacing.
 */
export function foldWithMap(source: string): FoldedText {
  let folded = '';
  const map: number[] = [];
  let lastWasSpace = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      if (!lastWasSpace && folded.length > 0) {
        folded += ' ';
        map.push(i);
      }
      lastWasSpace = true;
      continue;
    }
    lastWasSpace = false;
    const piece = foldChar(ch);
    for (let k = 0; k < piece.length; k++) {
      folded += piece[k];
      map.push(i);
    }
  }
  return { folded, map: Int32Array.from(map) };
}
