#!/usr/bin/env npx tsx
/**
 * npj26-load.ts
 *
 * Load the disagreement-cell list for the npj26 review tool. Reads the CSV an
 * upstream R script writes and POSTs it to /npj26/load, which REPLACES the whole
 * cells table -- the reviewer order is the CSV's `display_order`, already
 * shuffled upstream, so a half-replaced list would interleave two generations of
 * the instrument. Responses key on cell_id and are never touched, so reloading a
 * corrected CSV that keeps its ids keeps the answers attached.
 *
 * Usage:
 *   ADMIN_PASSPHRASE=... npx tsx tools/npj26-load.ts <cells.csv> --local
 *   ADMIN_PASSPHRASE=... npx tsx tools/npj26-load.ts <cells.csv> --url https://api.ai-med.live
 *   ADMIN_PASSPHRASE=... npx tsx tools/npj26-load.ts <cells.csv> --dry-run
 */

import fs from 'fs/promises';
import path from 'path';

const REQUIRED_COLUMNS = [
  'cell_id', 'display_order', 'bucket', 'case_id', 'condition', 'variable', 'domain',
  'item_text', 'viet_turn_index', 'viet_turn_text', 'eng_turn_index', 'eng_turn_text',
  'viet_transcript', 'eng_transcript', 'has_highlight', 'match_method',
] as const;

/**
 * RFC 4180 CSV reader.
 *
 * Written out rather than split on commas because the payload is transcripts:
 * every field can hold commas, embedded newlines, and doubled quotes, and R's
 * write.csv emits exactly that. A naive split would shred a consultation.
 */
function parseCsv(text: string): string[][] {
  // Strip a UTF-8 BOM; Excel round-trips leave one and it would corrupt the
  // first header name into "﻿cell_id".
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === ',') { endField(); i += 1; continue; }
    if (ch === '\r') { i += 1; continue; }
    if (ch === '\n') { endRow(); i += 1; continue; }
    field += ch; i += 1;
  }
  if (field.length > 0 || row.length > 0) endRow();

  // Drop a trailing blank line.
  return rows.filter(r => !(r.length === 1 && r[0].trim() === ''));
}

function toRecords(rows: string[][]): Array<Record<string, string>> {
  if (rows.length === 0) throw new Error('CSV is empty');
  const header = rows[0].map(h => h.trim());
  const missing = REQUIRED_COLUMNS.filter(c => !header.includes(c));
  if (missing.length > 0) {
    throw new Error(`CSV is missing required column(s): ${missing.join(', ')}`);
  }
  return rows.slice(1).map((r, idx) => {
    if (r.length !== header.length) {
      throw new Error(
        `Row ${idx + 2} has ${r.length} fields but the header has ${header.length}`
      );
    }
    const rec: Record<string, string> = {};
    header.forEach((h, j) => { rec[h] = r[j]; });
    return rec;
  });
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const isLocal = args.includes('--local');
  const urlIdx = args.indexOf('--url');
  const urlOverride = urlIdx !== -1 ? args[urlIdx + 1] : undefined;
  const csvPath = args.find(
    (a, i) => !a.startsWith('--') && (urlIdx === -1 || i !== urlIdx + 1)
  );

  if (!csvPath) {
    console.error('Usage: npx tsx tools/npj26-load.ts <cells.csv> [--local] [--url <base>] [--dry-run]');
    process.exit(1);
  }

  const baseUrl = (
    isLocal
      ? `http://localhost:${process.env.PORT || 3001}`
      : urlOverride || process.env.DEPLOY_URL || 'https://api.ai-med.live'
  ).replace(/\/$/, '');

  const passphrase = process.env.ADMIN_PASSPHRASE;
  if (!passphrase && !dryRun) {
    console.error('ADMIN_PASSPHRASE environment variable is required');
    process.exit(1);
  }

  const raw = await fs.readFile(path.resolve(csvPath), 'utf8');
  const records = toRecords(parseCsv(raw));
  console.log(`Read ${records.length} cells from ${csvPath}`);

  const orders = new Set(records.map(r => r.display_order));
  if (orders.size !== records.length) {
    console.warn(`  WARNING: display_order is not unique across ${records.length} rows`);
  }
  const highlighted = records.filter(
    r => ['true', 't', '1', 'yes', 'y'].includes((r.has_highlight || '').trim().toLowerCase())
  ).length;
  console.log(`  ${highlighted} highlighted, ${records.length - highlighted} without a highlight`);

  if (dryRun) {
    console.log(`\n(Dry run -- would POST to ${baseUrl}/npj26/load, replacing all cells)`);
    return;
  }

  const res = await fetch(`${baseUrl}/npj26/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passphrase, cells: records }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`${baseUrl}/npj26/load returned ${res.status}: ${body}`);
  }
  console.log(`Loaded: ${body}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
