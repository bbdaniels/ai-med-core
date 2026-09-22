"""The one SQLite shape every reading index is written in.

packages/api/src/readings.ts reads every project's index with one
implementation, so the tables are not any builder's to design. Both builders
(tools/build-readings-corpus.py for bibliographic corpora, tools/build-legal-
corpus.py for haivn_eip's legal library) used to carry their own copy of this
string with a comment promising the copies were byte-identical. A promise is
not a guard; an import is. Add a column here, once, and make readings.ts read
it only where present, because an index built before the column existed is
still a valid index (they are uploaded, not rebuilt on deploy).

Columns added after the first deployment, and what readings.ts does without them:
  chunks.notice    passage-level staleness note; treated as NULL when absent.
  documents.doi    a bare DOI ("10.1136/bmjgh-2017-000333"), rendered as a
                   https://doi.org/ link on the passage's citation line;
                   treated as NULL when absent.
"""

SCHEMA = """
PRAGMA journal_mode = WAL;

CREATE TABLE documents (
  id            TEXT PRIMARY KEY,
  authors       TEXT NOT NULL,
  author_short  TEXT NOT NULL,
  year          INTEGER,
  title         TEXT NOT NULL,
  venue         TEXT,
  gloss         TEXT,
  weeks         TEXT NOT NULL,   -- JSON array of {date, topic, term, reference}
  page_offset   INTEGER NOT NULL DEFAULT 0,
  n_chunks      INTEGER NOT NULL DEFAULT 0,
  doi           TEXT             -- bare DOI; NULL when the source has none
);

CREATE TABLE chunks (
  id          INTEGER PRIMARY KEY,
  doc_id      TEXT NOT NULL REFERENCES documents(id),
  ordinal     INTEGER NOT NULL,
  section     TEXT,
  page_start  INTEGER NOT NULL,
  page_end    INTEGER NOT NULL,
  header      TEXT NOT NULL,     -- contextual prefix, indexed alongside the body
  text        TEXT NOT NULL,
  tokens      INTEGER NOT NULL,
  notice      TEXT               -- passage-level staleness note; NULL for most chunks
);
CREATE INDEX idx_chunks_doc ON chunks(doc_id);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  header, text, content='chunks', content_rowid='id', tokenize='porter unicode61'
);

CREATE TABLE embeddings (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id),
  vec      BLOB NOT NULL
);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""
