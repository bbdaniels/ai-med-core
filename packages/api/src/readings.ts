/**
 * Grounded retrieval over a project's assigned-reading corpus.
 *
 * A project opts in by declaring `readingsIndex` in its project.json; the value
 * is a repo-relative path to a SQLite file. Two builders write that schema --
 * tools/build-ppol-corpus.py for a course reading list, tools/build-legal-corpus.py
 * for haivn_eip's library of Vietnamese legal instruments -- and this module
 * reads either without knowing which. The index holds one row per ~500-token
 * chunk with an FTS5 (BM25) index over it and, when the build could reach an
 * embeddings endpoint, a dense vector per chunk. Retrieval fuses the two
 * rankings; with no vectors it degrades to BM25 alone, which is why a failed
 * embedding pass never fails a build.
 *
 * Whether the index file is committed is the project's call, and the two
 * projects answer it differently. ppol5013's is a derived copy of copyrighted
 * course PDFs and is gitignored. haivn_eip's is built from published Vietnamese
 * legal instruments and IS committed deliberately, because Railway deploys from
 * git and the API needs the file present at runtime. Neither reaches the public
 * mirror, which publishes only projects/demo. Nothing here serves chunk text to
 * a browser -- text goes to the model, inside the chat request, and reaches the
 * reader only as whatever the model quotes back under the system prompt's
 * excerpt limits.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export interface ReadingChunk {
  chunkId: number;
  docId: string;
  authorShort: string;
  authors: string;
  year: number | null;
  title: string;
  venue: string | null;
  section: string | null;
  /** Page numbers within the source PDF, as the index recorded them. */
  pageStart: number;
  pageEnd: number;
  /** Weeks this reading is assigned, from the manifest. */
  weeks: Array<{ date: string; topic: string; term: string; reference: boolean }>;
  /**
   * A passage-level staleness note the corpus attached to this chunk: text that
   * is out of date even though the document carrying it is in force, keyed by
   * language code. Null on almost every chunk, and on every chunk of an index
   * built before the column existed. See `supersededPassages` in haivn_eip's
   * legal registry.
   */
  notice: Record<string, string> | null;
  header: string;
  text: string;
  score: number;
}

export interface ReadingsIndexInfo {
  documents: number;
  chunks: number;
  embeddedChunks: number;
  embeddingModel: string;
  builtAt: string;
}

interface OpenIndex {
  db: Database.Database;
  dim: number;
  hasVectors: boolean;
  /**
   * Whether any document in this index is assigned to a week. `weeks` is a
   * course-schedule concept: a corpus with no schedule (the haivn_eip legal
   * library) carries "[]" on every row, so a week filter can only ever return
   * nothing. See searchReadingsTool.
   */
  hasWeeks: boolean;
  /**
   * Whether this index carries the `chunks.notice` column. Both builders write
   * it now, but an index built before it existed is still a valid index -- the
   * PPOL one is not committed and is uploaded rather than rebuilt on deploy --
   * so the column is read only where it is present rather than made a hard
   * requirement that would take retrieval down entirely.
   */
  hasNotice: boolean;
  mtimeMs: number;
  filePath: string;
}

const MAX_RESULTS = 12;
const DEFAULT_RESULTS = 6;
/** How many candidates each ranker contributes before fusion. */
const CANDIDATE_POOL = 40;
/** Reciprocal-rank-fusion damping. 60 is the value the original RRF paper uses. */
const RRF_K = 60;

const openIndexes = new Map<string, OpenIndex | null>();

/**
 * Open (and cache) a project's index. Returns null when the project declares no
 * index, or when the file is absent -- a deployment without the corpus must
 * still start and still answer from the always-on syllabus map.
 */
export function openReadingsIndex(repoRoot: string, projectSlug: string,
                                  relativePath: string | null): OpenIndex | null {
  if (!relativePath) return null;

  // A deployment keeps the index outside the repo: it is 20+ MB of copyrighted
  // derived text, it is never committed, and the container filesystem is wiped on
  // every redeploy — so on Railway it lives on a mounted volume and this env var
  // points at it. The name is the project slug upper-cased, e.g.
  // READINGS_INDEX_PPOL5013=/data/ppol5013-readings.db.
  const envKey = `READINGS_INDEX_${projectSlug.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const override = process.env[envKey];

  let filePath: string;
  if (override && override.trim()) {
    // Operator-set, so an absolute path outside the repo is the whole point and
    // the containment check below does not apply to it.
    filePath = path.resolve(override.trim());
  } else {
    filePath = path.resolve(repoRoot, relativePath);
    // From project.json (repo content, not user input), but resolve against the
    // repo root anyway so a bad edit cannot read outside the tree.
    if (!filePath.startsWith(path.resolve(repoRoot) + path.sep)) {
      console.warn(`[readings] ${projectSlug}: index path escapes the repo root, ignoring`);
      return null;
    }
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    if (!openIndexes.has(projectSlug)) {
      console.warn(`[readings] ${projectSlug}: no index at ${filePath}; ` +
                   'search_readings will be unavailable');
      openIndexes.set(projectSlug, null);
    }
    return null;
  }

  const cached = openIndexes.get(projectSlug);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached;
  if (cached) cached.db.close();   // rebuilt underneath us; reopen

  try {
    const db = new Database(filePath, { readonly: true, fileMustExist: true });
    const embedded = Number(
      (db.prepare("SELECT value FROM meta WHERE key = 'embedded_chunks'")
         .get() as { value?: string } | undefined)?.value ?? 0,
    );
    const dim = Number(
      (db.prepare("SELECT value FROM meta WHERE key = 'embedding_dim'")
         .get() as { value?: string } | undefined)?.value ?? 0,
    );
    const scheduled = Number(
      (db.prepare(
        "SELECT COUNT(*) AS n FROM documents WHERE weeks IS NOT NULL AND TRIM(weeks) NOT IN ('', '[]')",
      ).get() as { n?: number } | undefined)?.n ?? 0,
    );
    const hasNotice = (db.prepare('PRAGMA table_info(chunks)').all() as
                       Array<{ name: string }>).some(c => c.name === 'notice');
    const opened: OpenIndex = {
      db, dim, hasVectors: embedded > 0 && dim > 0,
      hasWeeks: scheduled > 0,
      hasNotice,
      mtimeMs: stat.mtimeMs, filePath,
    };
    openIndexes.set(projectSlug, opened);
    console.log(`[readings] ${projectSlug}: opened ${filePath} ` +
                `(${embedded} embedded chunks, ${opened.hasVectors ? 'hybrid' : 'BM25-only'}` +
                `${opened.hasWeeks ? '' : ', unscheduled'})`);
    return opened;
  } catch (e) {
    console.error(`[readings] ${projectSlug}: failed to open index:`, e);
    openIndexes.set(projectSlug, null);
    return null;
  }
}

export function readingsIndexInfo(index: OpenIndex): ReadingsIndexInfo {
  const meta = (key: string): string =>
    ((index.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      { value?: string } | undefined)?.value ?? '');
  return {
    documents: (index.db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n,
    chunks: (index.db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n,
    embeddedChunks: Number(meta('embedded_chunks') || 0),
    embeddingModel: meta('embedding_model'),
    builtAt: meta('built_at'),
  };
}

/**
 * Turn a natural-language question into an FTS5 MATCH expression.
 *
 * FTS5 treats bare punctuation as syntax, so an unescaped question reaches it as
 * a syntax error rather than a query. Each surviving term is OR-ed: an AND of
 * every word in a sentence-length question matches nothing.
 */
function toFtsQuery(raw: string): string | null {
  const terms = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t))
    .slice(0, 24);
  if (!terms.length) return null;
  return terms.map(t => `"${t}"`).join(' OR ');
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was',
  'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its', 'new',
  'now', 'old', 'see', 'two', 'way', 'who', 'boy', 'did', 'she', 'use', 'they',
  'this', 'that', 'with', 'from', 'have', 'what', 'when', 'where', 'which',
  'does', 'about', 'into', 'than', 'them', 'were', 'been', 'their', 'would',
  'there', 'could', 'should', 'said', 'say', 'tell', 'explain', 'reading',
  'readings', 'course', 'class', 'week',
]);

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

interface ChunkRow {
  id: number;
  doc_id: string;
  section: string | null;
  page_start: number;
  page_end: number;
  header: string;
  text: string;
  authors: string;
  author_short: string;
  year: number | null;
  title: string;
  venue: string | null;
  weeks: string;
  notice: string | null;
}

const chunkSelect = (index: OpenIndex) => `
  SELECT c.id, c.doc_id, c.section, c.page_start, c.page_end, c.header, c.text,
         ${index.hasNotice ? 'c.notice' : 'NULL AS notice'},
         d.authors, d.author_short, d.year, d.title, d.venue, d.weeks
  FROM chunks c JOIN documents d ON d.id = c.doc_id
`;

export interface SearchOptions {
  /** Restrict to readings assigned in a given week, as YYYY-MM-DD. */
  week?: string | null;
  /** Restrict to one document id from the index. */
  docId?: string | null;
  limit?: number;
}

/**
 * Hybrid search. `queryVector` is optional: without it (no embeddings in the
 * index, or the embedding call failed on this request) the result is pure BM25,
 * which is a real answer rather than an error.
 */
export function searchReadings(index: OpenIndex, query: string,
                               queryVector: Float32Array | null,
                               opts: SearchOptions = {}): ReadingChunk[] {
  const limit = Math.min(MAX_RESULTS, Math.max(1, opts.limit ?? DEFAULT_RESULTS));
  const ranks = new Map<number, number>();   // chunk id -> fused RRF score
  const rows = new Map<number, ChunkRow>();

  const addRanking = (ordered: ChunkRow[]) => {
    ordered.forEach((row, i) => {
      rows.set(row.id, row);
      ranks.set(row.id, (ranks.get(row.id) ?? 0) + 1 / (RRF_K + i + 1));
    });
  };

  // ── lexical (BM25) ──
  const fts = toFtsQuery(query);
  if (fts) {
    try {
      const lexical = index.db.prepare(
        `${chunkSelect(index)} JOIN chunks_fts f ON f.rowid = c.id
         WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts, 2.0, 1.0) LIMIT ?`,
      ).all(fts, CANDIDATE_POOL) as ChunkRow[];
      addRanking(lexical);
    } catch (e) {
      console.warn('[readings] BM25 query failed:', e);
    }
  }

  // ── dense (cosine over every vector) ──
  // Brute force is the right call at this size: a few thousand 1,536-d vectors
  // is single-digit milliseconds, and it removes a vector-store dependency and
  // an index that could fall out of sync with the chunks.
  if (queryVector && index.hasVectors) {
    try {
      const vectors = index.db.prepare(
        'SELECT chunk_id, vec FROM embeddings',
      ).all() as Array<{ chunk_id: number; vec: Buffer }>;
      const scored = vectors.map(({ chunk_id, vec }) => ({
        id: chunk_id,
        score: cosine(queryVector, new Float32Array(
          vec.buffer, vec.byteOffset, vec.byteLength / 4)),
      }));
      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, CANDIDATE_POOL);
      const placeholders = top.map(() => '?').join(',');
      const fetched = index.db.prepare(
        `${chunkSelect(index)} WHERE c.id IN (${placeholders})`,
      ).all(...top.map(t => t.id)) as ChunkRow[];
      const byId = new Map(fetched.map(r => [r.id, r]));
      addRanking(top.map(t => byId.get(t.id)).filter((r): r is ChunkRow => !!r));
    } catch (e) {
      console.warn('[readings] vector search failed; using BM25 only:', e);
    }
  }

  let results = [...ranks.entries()]
    .map(([id, score]) => ({ row: rows.get(id)!, score }))
    .filter(r => !!r.row);

  if (opts.docId) {
    results = results.filter(r => r.row.doc_id === opts.docId);
  }
  // A week filter against an unscheduled corpus can only empty the result set,
  // so it is ignored there rather than silently returning nothing. The tool
  // schema does not offer `week` for such an index either; this is the guard for
  // a caller that passes one anyway.
  if (opts.week && index.hasWeeks) {
    results = results.filter(r => {
      try {
        return (JSON.parse(r.row.weeks) as Array<{ date: string }>)
          .some(w => w.date === opts.week);
      } catch { return false; }
    });
  }

  results.sort((a, b) => b.score - a.score);

  return results.slice(0, limit).map(({ row, score }) => {
    let weeks: ReadingChunk['weeks'] = [];
    try { weeks = JSON.parse(row.weeks); } catch { /* metadata only */ }
    return {
      chunkId: row.id,
      docId: row.doc_id,
      authorShort: row.author_short,
      authors: row.authors,
      year: row.year,
      title: row.title,
      venue: row.venue,
      section: row.section,
      pageStart: row.page_start,
      pageEnd: row.page_end,
      weeks,
      notice: parseNotice(row.notice),
      header: row.header,
      text: row.text,
      score,
    };
  });
}

/** List every indexed reading. Cheap enough to answer "what can you search?". */
export function listReadings(index: OpenIndex): Array<{
  docId: string; authorShort: string; year: number | null; title: string;
  chunks: number; weeks: ReadingChunk['weeks'];
}> {
  const rows = index.db.prepare(
    'SELECT id, author_short, year, title, n_chunks, weeks FROM documents ORDER BY author_short',
  ).all() as Array<{ id: string; author_short: string; year: number | null;
                     title: string; n_chunks: number; weeks: string }>;
  return rows.map(r => {
    let weeks: ReadingChunk['weeks'] = [];
    try { weeks = JSON.parse(r.weeks); } catch { /* metadata only */ }
    return {
      docId: r.id, authorShort: r.author_short, year: r.year,
      title: r.title, chunks: r.n_chunks, weeks,
    };
  });
}

/**
 * A chunk's notice column, as a language-keyed record.
 *
 * The builders write a JSON object of language code to text. A plain string is
 * accepted too, as one English notice, so an index built before the column was
 * bilingual still renders rather than throwing inside a tool call.
 */
function parseNotice(raw: string | null): Record<string, string> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim()) out[k] = v;
      }
      return Object.keys(out).length ? out : null;
    }
  } catch { /* not JSON: an older index wrote the text directly */ }
  return { en: raw };
}

/**
 * The language code to render a notice in, from the language NAME the chat
 * request carries ("English", "Tiếng Việt", "Vietnamese").
 *
 * A notice is an instruction to the model about the passage above it, so it is
 * written in the language the answer is being written in and only that one:
 * shipping every language on every search doubled the cost of the annotation
 * for no reading the model was going to do. Unknown or absent falls back to
 * English, which every notice carries.
 */
const NOTICE_LANGUAGE_PATTERNS: Array<[string, RegExp]> = [
  ['vi', /^(vi|vie|vietnamese|tieng viet)\b/],
];

export function noticeLanguage(language?: string | null): string {
  const norm = (language ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!norm) return 'en';
  for (const [code, pattern] of NOTICE_LANGUAGE_PATTERNS) {
    if (pattern.test(norm)) return code;
  }
  return 'en';
}

function noticeText(notice: Record<string, string>, code: string): string | null {
  return notice[code] ?? notice.en ?? Object.values(notice)[0] ?? null;
}

/**
 * Render results as the tool message the model reads.
 *
 * Every passage carries its own citation line, so the model never has to infer
 * which reading a passage came from -- the single most common way a grounded
 * answer ends up attributed to the wrong author.
 */
export function formatSearchResults(
  query: string,
  results: ReadingChunk[],
  options: { language?: string | null } = {},
): string {
  if (!results.length) {
    return `No passage in the indexed course readings matches "${query}". Say so ` +
           'plainly rather than answering from general knowledge, and if the topic ' +
           'is assigned in a week whose reading is not indexed, point the student there.';
  }
  // A notice is a property of the ANNOTATION, not of each row that matched it,
  // and one annotation routinely covers several passages of the same document.
  // Emitting it per passage repeated the identical block up to five times in
  // one tool result -- measured at 38% of the payload, and paid for on every
  // search of a deployment running under a monthly credit cap. So each distinct
  // notice is printed once, above the passages, naming which ones it covers.
  const lang = noticeLanguage(options.language);
  const notices: string[] = [];
  const noticeOf = new Map<number, number>();
  results.forEach((r, i) => {
    const text = r.notice ? noticeText(r.notice, lang) : null;
    if (!text) return;
    let at = notices.indexOf(text);
    if (at === -1) { notices.push(text); at = notices.length - 1; }
    noticeOf.set(i, at);
  });
  const covered = notices.map((_, n) =>
    [...noticeOf.entries()].filter(([, v]) => v === n).map(([i]) => i + 1));
  const noticeBlocks = notices.map((text, n) =>
    `NOTICE ${n + 1}, on passage${covered[n].length > 1 ? 's' : ''} ` +
    `${covered[n].join(', ')}: ${text}`);

  const blocks = results.map((r, i) => {
    const year = r.year ? ` ${r.year}` : '';
    // Page 0 means the source has no pages to cite -- a spreadsheet row, an
    // unmapped statute chunk. Printing "p. 0" hands the model a page number that
    // does not exist, and the prompt tells it to repeat locations verbatim.
    const pages = r.pageStart === 0
      ? '' : r.pageStart === r.pageEnd
        ? `p. ${r.pageStart}` : `pp. ${r.pageStart}-${r.pageEnd}`;
    const week = r.weeks[0]
      ? ` | assigned ${r.weeks[0].date}, "${r.weeks[0].topic}"` : '';
    const section = r.section ? `section: ${r.section}` : '';
    const location = [pages, section, week.replace(/^ \| /, '')]
      .filter(Boolean).join(' | ');
    // The pointer stays on the passage even though the text sits above it: the
    // document can be in force while the passage's rule has been converted, and
    // an answer that quotes the passage has to carry the correction with it.
    const n = noticeOf.get(i);
    return [
      `--- passage ${i + 1} ---`,
      `CITE AS: ${r.authorShort}${year}`,
      `Full title: ${r.title}${r.venue ? ` (${r.venue})` : ''}`,
      ...(location ? [`Location: ${location}`] : []),
      ...(n === undefined ? [] : [`NOTICE ${n + 1} above applies to this passage.`]),
      '',
      r.text,
    ].join('\n');
  });
  return `Passages from the indexed course materials matching "${query}":\n\n` +
         (noticeBlocks.length ? `${noticeBlocks.join('\n\n')}\n\n` : '') +
         blocks.join('\n\n');
}

/** The tool definition handed to the model. */
export const SEARCH_READINGS_TOOL = {
  type: 'function' as const,
  function: {
    name: 'search_readings',
    description:
      'Search the full text of the course corpus and return the passages that best ' +
      'match a query, each with the author, year, page range, and the week it is ' +
      'assigned. The corpus holds the assigned readings AND the course resource ' +
      'listings of datasets, data portals and research catalogs. Call this before ' +
      'answering any question about what a reading says, argues, defines, or ' +
      'recommends, AND before naming any specific data source, dataset, portal or ' +
      'catalog to a student. Call it more than once, with different wording, when the ' +
      'first search misses or when a question spans several weeks.',
    parameters: {
      type: 'object' as const,
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description:
            'What to look for, in the vocabulary the source itself would use. ' +
            'Prefer the technical term over the student\'s paraphrase: search ' +
            '"minimum detectable effect statistical power" rather than "how big does ' +
            'my sample need to be". For a data source, search the subject and the ' +
            'kind of data: "adolescent health longitudinal survey" or "municipal ' +
            'crime open data portal", not the student\'s thesis question.',
        },
        week: {
          type: 'string',
          description:
            'Optional. Restrict to readings assigned on one class date, as YYYY-MM-DD ' +
            '(for example 2027-02-02). Use only when the student asks about a ' +
            'specific week.',
        },
        limit: {
          type: 'integer',
          description: `Optional. Passages to return, 1-${MAX_RESULTS}. Defaults to ${DEFAULT_RESULTS}.`,
        },
      },
    },
  },
};

/**
 * The tool definition for one opened index.
 *
 * `week` is only a real parameter over a corpus that has a schedule. Offering it
 * against an unscheduled corpus is worse than useless: the model does use it,
 * every such call filters the fused results down to nothing, and each one spends
 * one of the three tool hops a request gets. So the parameter is withheld from
 * the schema when no document in the index is assigned to a week.
 *
 * The DESCRIPTION is replaced for the same reason. The default one tells the
 * model it is searching "the assigned course readings" and will get back "the
 * week it is assigned" -- two promises an unscheduled corpus cannot keep, in the
 * one piece of text the model reads when deciding whether this tool is relevant
 * at all.
 *
 * Measured, so the next reader does not over-credit this: swapping the wording
 * did NOT change gpt-4o-mini's tool-calling on haivn_eip. That model calls
 * search_readings when the user's question names an instrument ("which article
 * of Decree 96/2023/NĐ-CP...") and skips it on a follow-up that names none
 * ("What section of the law says that?") -- zero calls in 22 trials before the
 * change and zero in the trials after it. The fix here removes a false promise
 * from the model's context; it is not a fix for that behavior. That one is a
 * model-capability question: gpt-4o called the tool on such follow-ups, the
 * default gpt-4o-mini does not, and haivn_eip's system prompt is what keeps the
 * ungrounded answer honest ("no article in the Legal Library states it") rather
 * than letting it reach for the nearest article. Do not re-pin a bigger chatModel
 * to paper over this without pricing it first: it raises every turn on the
 * project, not only the statute turns.
 *
 * A scheduled index (ppol5013) gets the same object it always got, by identity.
 */
const UNSCHEDULED_DESCRIPTION =
  'Search the full text of this project\'s reference corpus and return the passages ' +
  'that best match a query, each with its source document, citation, page range, and ' +
  'the section or article it comes from. Call this before answering ANY question that ' +
  'turns on what a source document actually says, including a follow-up asking which ' +
  'provision, section, or article states something you have just said, and including ' +
  'a question that names no document at all. Call it more than once, with different ' +
  'wording, when the first passages miss.';

export function searchReadingsTool(index: OpenIndex) {
  if (index.hasWeeks) return SEARCH_READINGS_TOOL;
  const { query, limit } = SEARCH_READINGS_TOOL.function.parameters.properties;
  return {
    ...SEARCH_READINGS_TOOL,
    function: {
      ...SEARCH_READINGS_TOOL.function,
      description: UNSCHEDULED_DESCRIPTION,
      parameters: {
        ...SEARCH_READINGS_TOOL.function.parameters,
        properties: { query, limit },
      },
    },
  };
}

export { MAX_RESULTS as READINGS_MAX_RESULTS };
