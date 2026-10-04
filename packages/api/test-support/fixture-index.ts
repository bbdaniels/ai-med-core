/**
 * Build a small readings index for tests, in the one schema every index uses.
 *
 * The schema is not copied here: it is read from tools/lib/readings_schema.py,
 * its single source, so a column added there reaches the fixtures too. The
 * index carries no embeddings (meta.embedded_chunks = 0), so readings.ts
 * searches it by BM25 alone and the results do not depend on any vector.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const READINGS_SCHEMA_PY = path.resolve(HERE, '../../../tools/lib/readings_schema.py');

export interface FixtureWeek {
  date: string;
  topic?: string;
  term?: string;
  reference?: string;
}

export interface FixtureDoc {
  id: string;
  authors: string;
  author_short: string;
  year?: number | null;
  title: string;
  venue?: string | null;
  gloss?: string | null;
  weeks?: FixtureWeek[];
  page_offset?: number;
  doi?: string | null;
}

export interface FixtureChunk {
  doc_id: string;
  ordinal?: number;
  section?: string | null;
  page_start: number;
  page_end: number;
  header: string;
  text: string;
  tokens?: number;
  notice?: string | null;
}

export function readingsSchema(): string {
  const src = fs.readFileSync(READINGS_SCHEMA_PY, 'utf8');
  const m = src.match(/^SCHEMA\s*=\s*"""([\s\S]*?)"""/m);
  if (!m) throw new Error(`no SCHEMA = """...""" block in ${READINGS_SCHEMA_PY}`);
  return m[1];
}

export function buildFixtureIndex(dest: string, spec: { documents: FixtureDoc[]; chunks: FixtureChunk[] }): string {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dest + suffix, { force: true });
  const db = new Database(dest);
  try {
    db.exec(readingsSchema());
    const insertDoc = db.prepare(`INSERT INTO documents
      (id, authors, author_short, year, title, venue, gloss, weeks, page_offset, n_chunks, doi)
      VALUES (@id, @authors, @author_short, @year, @title, @venue, @gloss, @weeks, @page_offset, @n_chunks, @doi)`);
    const insertChunk = db.prepare(`INSERT INTO chunks
      (doc_id, ordinal, section, page_start, page_end, header, text, tokens, notice)
      VALUES (@doc_id, @ordinal, @section, @page_start, @page_end, @header, @text, @tokens, @notice)`);
    const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    db.transaction(() => {
      for (const d of spec.documents) {
        insertDoc.run({
          id: d.id, authors: d.authors, author_short: d.author_short, year: d.year ?? null,
          title: d.title, venue: d.venue ?? null, gloss: d.gloss ?? null,
          weeks: JSON.stringify(d.weeks ?? []), page_offset: d.page_offset ?? 0,
          n_chunks: spec.chunks.filter(c => c.doc_id === d.id).length, doi: d.doi ?? null,
        });
      }
      const ordinals = new Map<string, number>();
      for (const c of spec.chunks) {
        const ordinal = c.ordinal ?? (ordinals.get(c.doc_id) ?? 0);
        ordinals.set(c.doc_id, ordinal + 1);
        insertChunk.run({
          doc_id: c.doc_id, ordinal, section: c.section ?? null,
          page_start: c.page_start, page_end: c.page_end, header: c.header, text: c.text,
          tokens: c.tokens ?? Math.ceil(c.text.length / 4), notice: c.notice ?? null,
        });
      }
      db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')");
      for (const [k, v] of [
        ['embedded_chunks', '0'], ['embedding_dim', '8'],
        ['embedding_model', 'text-embedding-3-small'], ['built_at', '2026-10-01T00:00:00Z'],
      ]) setMeta.run(k, v);
    })();
    // The schema turns WAL on; a read-only opener needs no sidecar files.
    db.pragma('journal_mode = DELETE');
  } finally {
    db.close();
  }
  return dest;
}
