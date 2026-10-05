// Run: npm -w @ai-med/chat-core test
//
// Document-scoped search: `docIds` restricts both rankers in SQL, so a
// document's own passages are ranked among themselves rather than filtered out
// of a candidate pool the rest of the corpus already filled.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { buildFixtureIndex, type FixtureChunk } from '../test-support/fixture-index.js';
import { openReadingsIndex, searchReadings, type OpenIndex } from './readings.js';

const DIM = 8;
const unit = (i: number, tilt = 0) => {
  const v = new Float32Array(DIM);
  v[i] = 1;
  if (tilt) v[(i + 1) % DIM] = tilt;
  return v;
};

let tmp = '';
let lexical: OpenIndex;
let hybrid: OpenIndex;

// doc-big has more strongly matching passages than the candidate pool holds,
// so a filter applied after ranking would find none of doc-small's.
function spec() {
  const chunks: FixtureChunk[] = [];
  for (let i = 0; i < 60; i++) {
    chunks.push({ doc_id: 'doc-big', header: 'Big | Methods', text: `Zebrafish protocol zebrafish protocol, part ${i}.`, page_start: i + 1, page_end: i + 1 });
  }
  chunks.push({ doc_id: 'doc-small', header: 'Small | Methods', text: 'A zebrafish appears once in a long paragraph about attendance and staffing.', page_start: 1, page_end: 1 });
  chunks.push({ doc_id: 'doc-small', header: 'Small | Results', text: 'Attendance rose by a third.', page_start: 2, page_end: 2 });
  return {
    documents: [
      { id: 'doc-big', authors: 'Big, A.', author_short: 'Big', year: 2026, title: 'A long document' },
      { id: 'doc-small', authors: 'Small, B.', author_short: 'Small', year: 2025, title: 'A short document' },
    ],
    chunks,
  };
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'readings-test-'));
  const lexPath = buildFixtureIndex(path.join(tmp, 'lexical.db'), spec());
  const hybPath = buildFixtureIndex(path.join(tmp, 'hybrid.db'), spec());
  // Vectors for the hybrid copy: every doc-big passage points along axis 0;
  // doc-small's "Results" passage is close to it, its "Methods" passage is not.
  const db = new Database(hybPath);
  const rows = db.prepare('SELECT id, doc_id, header FROM chunks ORDER BY id').all() as Array<{ id: number; doc_id: string; header: string }>;
  const put = db.prepare('INSERT INTO embeddings (chunk_id, vec) VALUES (?, ?)');
  for (const r of rows) {
    const v = r.doc_id === 'doc-big' ? unit(0) : r.header.endsWith('Results') ? unit(0, 0.2) : unit(4);
    put.run(r.id, Buffer.from(v.buffer));
  }
  db.prepare("UPDATE meta SET value = ? WHERE key = 'embedded_chunks'").run(String(rows.length));
  db.close();
  process.env.READINGS_INDEX_READINGS_LEXICAL = lexPath;
  process.env.READINGS_INDEX_READINGS_HYBRID = hybPath;
  lexical = openReadingsIndex(tmp, 'readings_lexical', 'unused.db')!;
  hybrid = openReadingsIndex(tmp, 'readings_hybrid', 'unused.db')!;
  assert.ok(lexical && !lexical.hasVectors);
  assert.ok(hybrid && hybrid.hasVectors);
});

after(() => {
  lexical?.db.close();
  hybrid?.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('unscoped: the corpus wins on rank', () => {
  const r = searchReadings(lexical, 'zebrafish protocol', null, { limit: 12 });
  assert.equal(r.length, 12);
  assert.ok(r.every(x => x.docId === 'doc-big'));
});

test('BM25 scoped to a document finds its passage past a full candidate pool', () => {
  const r = searchReadings(lexical, 'zebrafish protocol', null, { docIds: ['doc-small'] });
  assert.ok(r.length >= 1);
  assert.ok(r.every(x => x.docId === 'doc-small'));
  assert.match(r[0].text, /zebrafish appears once/);
});

test('dense scoped to a document ranks only that document', () => {
  // No lexical match at all, so every result comes from the dense ranker.
  const r = searchReadings(hybrid, 'qqqq', unit(0), { docIds: ['doc-small'] });
  assert.deepEqual(r.map(x => x.header), ['Small | Results', 'Small | Methods']);
  const all = searchReadings(hybrid, 'qqqq', unit(0), { limit: 12 });
  assert.ok(all.every(x => x.docId === 'doc-big'));
});

test('several ids, an unknown id, an empty list', () => {
  const both = searchReadings(lexical, 'zebrafish', null, { docIds: ['doc-small', 'doc-big'], limit: 12 });
  assert.ok(both.some(x => x.docId === 'doc-big'));
  assert.deepEqual(searchReadings(lexical, 'zebrafish', null, { docIds: ['no-such-doc'] }), []);
  assert.deepEqual(searchReadings(hybrid, 'zebrafish', unit(0), { docIds: [] }), []);
});
