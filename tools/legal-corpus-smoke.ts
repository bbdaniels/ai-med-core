/**
 * Smoke test for the haivn_eip legal corpus, run through the SERVER's own loader.
 *
 * The point is not that the SQLite file exists -- it is that packages/api/src/
 * readings.ts can open it, switch on hybrid retrieval, and render passages the
 * model would actually read. A test that opened the database with its own query
 * would verify the builder against itself and prove nothing about the seam.
 *
 *   npx tsx tools/legal-corpus-smoke.ts            # BM25 + dense (needs the API key)
 *   npx tsx tools/legal-corpus-smoke.ts --bm25     # BM25 only, no network
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import {
  openReadingsIndex, readingsIndexInfo, searchReadings, formatSearchResults,
} from '../packages/api/src/readings.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = 'haivn_eip';
const QUERIES = [
  'phạm vi hành nghề',
  'Điều 40',
  // A bare article number is the hardest case for the lexical half: readings.ts's
  // toFtsQuery drops any term of two characters or fewer, so "40" never reaches
  // FTS5 and BM25 alone is left matching on "điều". The dense half is what
  // answers it -- which is exactly why the header carries the instrument number
  // and the section label into the embedded string.
  'Điều 40 của Nghị định 96/2023/NĐ-CP quy định gì',
  'điều kiện cấp giấy phép hoạt động',
];

function loadEnv(): void {
  const file = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const key = t.slice(0, i).trim();
    if (!process.env[key]) process.env[key] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
}

async function main(): Promise<number> {
  loadEnv();
  const bm25Only = process.argv.includes('--bm25');

  const cfg = JSON.parse(fs.readFileSync(
    path.join(REPO_ROOT, 'projects', SLUG, 'project.json'), 'utf8'));
  const declared = cfg.readingsIndex;
  console.log(`project.json readingsIndex: ${declared}`);

  const index = openReadingsIndex(REPO_ROOT, SLUG, declared);
  if (!index) { console.error('FAIL: openReadingsIndex returned null'); return 1; }
  console.log('index info:', readingsIndexInfo(index));

  let client: OpenAI | null = null;
  if (!bm25Only && process.env.OPENAI_API_KEY) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
    });
  }

  for (const query of QUERIES) {
    let vector: Float32Array | null = null;
    if (client) {
      try {
        // Exactly the call packages/api/src/server.ts makes per search.
        const res = await client.embeddings.create({
          model: 'text-embedding-3-small', input: query,
        });
        vector = new Float32Array(res.data[0].embedding);
      } catch (e) {
        console.warn('query embedding failed; BM25 only for this query:', e);
      }
    }
    const hits = searchReadings(index, query, vector, { limit: 4 });
    console.log(`\n${'='.repeat(72)}\nQUERY ${JSON.stringify(query)} `
      + `(${vector ? 'hybrid' : 'BM25 only'}) -> ${hits.length} passages`);
    for (const h of hits) {
      console.log(`  ${h.authorShort} ${h.year ?? ''} | p.${h.pageStart} | `
        + `${(h.section ?? '').slice(0, 80)} | score ${h.score.toFixed(4)}`);
    }
    const rendered = formatSearchResults(query, hits);
    console.log('--- what the model sees (first 700 chars) ---');
    console.log(rendered.slice(0, 700));
  }
  return 0;
}

main().then(code => process.exit(code));
