/**
 * npj26 disagreement verification.
 *
 * A bilingual clinician walks a fixed list of checklist cells where the
 * Vietnamese and English codings of the same consultation disagreed, and says
 * for each one which side is wrong. The reviewer reaches the task at
 * ai-med.live/npj26/<CODE>, where CODE is an opaque per-reviewer token issued
 * out of band; there is no login and no account.
 *
 * Two tables, both GLOBAL rather than project-prefixed -- this is one study's
 * instrument, not a project's content, and no X-Project header ever reaches
 * these routes.
 *
 *   dspverify_cells      the work list, loaded from an upstream R script's CSV
 *   dspverify_responses  one row per (token, cell), upserted on submit
 *
 * `bucket` and `match_method` are the study's own labels for how each cell was
 * sampled and matched. Showing them to the reviewer would tell them what answer
 * the analysis expects, so the reviewer-facing serializer drops both columns and
 * they leave the database only through the admin CSV export.
 */

import { getDbHandles } from './database.js';

const CELLS = 'dspverify_cells';
const RESPONSES = 'dspverify_responses';

/** Reviewer tokens are issued upstream; this is the only shape we accept. */
export const TOKEN_RE = /^[A-Za-z0-9]{6,16}$/;

export interface Npj26Cell {
  cell_id: string;
  display_order: number;
  bucket: string | null;
  case_id: string | null;
  condition: string | null;
  variable: string | null;
  domain: string | null;
  item_text: string | null;
  viet_turn_index: number | null;
  viet_turn_text: string | null;
  eng_turn_index: number | null;
  eng_turn_text: string | null;
  viet_transcript: string | null;
  eng_transcript: string | null;
  has_highlight: boolean;
  match_method: string | null;
}

/** What a reviewer is allowed to see: everything except bucket and match_method. */
export type ReviewerCell = Omit<Npj26Cell, 'bucket' | 'match_method'>;

export interface Npj26Progress {
  done: number;
  total: number;
  cell: ReviewerCell | null;
}

export function toReviewerCell(cell: Npj26Cell): ReviewerCell {
  const { bucket: _bucket, match_method: _matchMethod, ...rest } = cell;
  return rest;
}

// ── Schema ───────────────────────────────────────────────────────────
//
// `condition` is a reserved word in the SQL standard, so it is quoted at every
// mention. Double quotes are the identifier quote in both SQLite and Postgres,
// so one spelling serves both.

export async function ensureNpj26Tables(): Promise<void> {
  const { dbType, sqlite, pg } = getDbHandles();

  if (dbType === 'sqlite' && sqlite) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS ${CELLS} (
        cell_id TEXT PRIMARY KEY,
        display_order INTEGER NOT NULL,
        bucket TEXT,
        case_id TEXT,
        "condition" TEXT,
        variable TEXT,
        domain TEXT,
        item_text TEXT,
        viet_turn_index INTEGER,
        viet_turn_text TEXT,
        eng_turn_index INTEGER,
        eng_turn_text TEXT,
        viet_transcript TEXT,
        eng_transcript TEXT,
        has_highlight INTEGER NOT NULL DEFAULT 0,
        match_method TEXT
      );
    `);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_${CELLS}_order ON ${CELLS}(display_order);`);
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS ${RESPONSES} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT NOT NULL,
        cell_id TEXT NOT NULL,
        code INTEGER NOT NULL,
        turn_relevant INTEGER,
        comment TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        UNIQUE(token, cell_id)
      );
    `);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_${RESPONSES}_token ON ${RESPONSES}(token);`);
    return;
  }

  if (dbType === 'postgres' && pg) {
    await pg.query(`
      CREATE TABLE IF NOT EXISTS ${CELLS} (
        cell_id TEXT PRIMARY KEY,
        display_order INTEGER NOT NULL,
        bucket TEXT,
        case_id TEXT,
        "condition" TEXT,
        variable TEXT,
        domain TEXT,
        item_text TEXT,
        viet_turn_index INTEGER,
        viet_turn_text TEXT,
        eng_turn_index INTEGER,
        eng_turn_text TEXT,
        viet_transcript TEXT,
        eng_transcript TEXT,
        has_highlight BOOLEAN NOT NULL DEFAULT FALSE,
        match_method TEXT
      );
    `);
    await pg.query(`CREATE INDEX IF NOT EXISTS idx_${CELLS}_order ON ${CELLS}(display_order);`);
    await pg.query(`
      CREATE TABLE IF NOT EXISTS ${RESPONSES} (
        id SERIAL PRIMARY KEY,
        token TEXT NOT NULL,
        cell_id TEXT NOT NULL,
        code SMALLINT NOT NULL,
        turn_relevant BOOLEAN,
        comment TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(token, cell_id)
      );
    `);
    await pg.query(`CREATE INDEX IF NOT EXISTS idx_${RESPONSES}_token ON ${RESPONSES}(token);`);
    return;
  }

  throw new Error('npj26: no database connection');
}

// ── Row normalization ────────────────────────────────────────────────

function toInt(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s === '' ? null : s;
}

/** Accepts the several truthy spellings an R `write.csv` can emit. */
function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'true' || s === 't' || s === '1' || s === 'yes' || s === 'y';
}

function rowToCell(row: Record<string, unknown>): Npj26Cell {
  return {
    cell_id: String(row.cell_id ?? ''),
    display_order: toInt(row.display_order) ?? 0,
    bucket: toStr(row.bucket),
    case_id: toStr(row.case_id),
    condition: toStr(row.condition),
    variable: toStr(row.variable),
    domain: toStr(row.domain),
    item_text: toStr(row.item_text),
    viet_turn_index: toInt(row.viet_turn_index),
    viet_turn_text: toStr(row.viet_turn_text),
    eng_turn_index: toInt(row.eng_turn_index),
    eng_turn_text: toStr(row.eng_turn_text),
    viet_transcript: toStr(row.viet_transcript),
    eng_transcript: toStr(row.eng_transcript),
    has_highlight: toBool(row.has_highlight),
    match_method: toStr(row.match_method),
  };
}

// ── Loading ──────────────────────────────────────────────────────────

/**
 * Replace the whole cell list. The reviewer order is `display_order`, already
 * shuffled upstream, so a reload is only ever a full swap -- a partial merge
 * would silently leave two generations of the instrument interleaved.
 *
 * Responses are NOT touched: they key on cell_id, and a reload that keeps the
 * same ids keeps the answers attached to them.
 */
export async function loadNpj26Cells(rows: Array<Record<string, unknown>>): Promise<number> {
  const cells = rows.map(rowToCell);
  const bad = cells.find(c => !c.cell_id);
  if (bad) throw new Error('every row must have a non-empty cell_id');
  const seen = new Set<string>();
  for (const c of cells) {
    if (seen.has(c.cell_id)) throw new Error(`duplicate cell_id in payload: ${c.cell_id}`);
    seen.add(c.cell_id);
  }

  const { dbType, sqlite, pg } = getDbHandles();
  const cols = `cell_id, display_order, bucket, case_id, "condition", variable, domain,
                item_text, viet_turn_index, viet_turn_text, eng_turn_index, eng_turn_text,
                viet_transcript, eng_transcript, has_highlight, match_method`;

  if (dbType === 'sqlite' && sqlite) {
    const insert = sqlite.prepare(
      `INSERT INTO ${CELLS} (${cols}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    const swap = sqlite.transaction((list: Npj26Cell[]) => {
      sqlite.prepare(`DELETE FROM ${CELLS}`).run();
      for (const c of list) {
        insert.run(
          c.cell_id, c.display_order, c.bucket, c.case_id, c.condition, c.variable, c.domain,
          c.item_text, c.viet_turn_index, c.viet_turn_text, c.eng_turn_index, c.eng_turn_text,
          c.viet_transcript, c.eng_transcript, c.has_highlight ? 1 : 0, c.match_method
        );
      }
    });
    swap(cells);
    return cells.length;
  }

  if (dbType === 'postgres' && pg) {
    const client = await pg.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM ${CELLS}`);
      for (const c of cells) {
        await client.query(
          `INSERT INTO ${CELLS} (${cols})
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            c.cell_id, c.display_order, c.bucket, c.case_id, c.condition, c.variable, c.domain,
            c.item_text, c.viet_turn_index, c.viet_turn_text, c.eng_turn_index, c.eng_turn_text,
            c.viet_transcript, c.eng_transcript, c.has_highlight, c.match_method,
          ]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return cells.length;
  }

  throw new Error('npj26: no database connection');
}

// ── Reviewer flow ────────────────────────────────────────────────────

/**
 * Where this reviewer stands: how many cells they have answered, how many there
 * are, and the first one in `display_order` they have not answered yet.
 *
 * "First unanswered" rather than "the (done+1)th" is what makes the URL
 * resumable after a partial or out-of-order session -- a response row that
 * exists is the only record of progress, and no cursor is stored anywhere.
 */
export async function getNpj26Progress(token: string): Promise<Npj26Progress> {
  const { dbType, sqlite, pg } = getDbHandles();

  if (dbType === 'sqlite' && sqlite) {
    const total = (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${CELLS}`).get() as { n: number }).n;
    const done = (sqlite.prepare(
      `SELECT COUNT(*) AS n FROM ${RESPONSES} WHERE token = ?`
    ).get(token) as { n: number }).n;
    const row = sqlite.prepare(
      `SELECT c.* FROM ${CELLS} c
       WHERE NOT EXISTS (SELECT 1 FROM ${RESPONSES} r WHERE r.token = ? AND r.cell_id = c.cell_id)
       ORDER BY c.display_order ASC, c.cell_id ASC
       LIMIT 1`
    ).get(token) as Record<string, unknown> | undefined;
    return { done, total, cell: row ? toReviewerCell(rowToCell(row)) : null };
  }

  if (dbType === 'postgres' && pg) {
    const totalRes = await pg.query(`SELECT COUNT(*)::int AS n FROM ${CELLS}`);
    const doneRes = await pg.query(
      `SELECT COUNT(*)::int AS n FROM ${RESPONSES} WHERE token = $1`, [token]
    );
    const cellRes = await pg.query(
      `SELECT c.* FROM ${CELLS} c
       WHERE NOT EXISTS (SELECT 1 FROM ${RESPONSES} r WHERE r.token = $1 AND r.cell_id = c.cell_id)
       ORDER BY c.display_order ASC, c.cell_id ASC
       LIMIT 1`, [token]
    );
    const row = cellRes.rows[0] as Record<string, unknown> | undefined;
    return {
      done: totalRes.rows[0].n === 0 ? 0 : doneRes.rows[0].n,
      total: totalRes.rows[0].n,
      cell: row ? toReviewerCell(rowToCell(row)) : null,
    };
  }

  throw new Error('npj26: no database connection');
}

export async function npj26CellExists(cellId: string): Promise<boolean> {
  const { dbType, sqlite, pg } = getDbHandles();
  if (dbType === 'sqlite' && sqlite) {
    return !!sqlite.prepare(`SELECT 1 FROM ${CELLS} WHERE cell_id = ?`).get(cellId);
  }
  if (dbType === 'postgres' && pg) {
    const r = await pg.query(`SELECT 1 FROM ${CELLS} WHERE cell_id = $1`, [cellId]);
    return r.rowCount ? r.rowCount > 0 : false;
  }
  throw new Error('npj26: no database connection');
}

/**
 * Upsert one answer. Re-submitting the same cell overwrites, which is what makes
 * a double-tapped Submit button or a retried request harmless.
 */
export async function saveNpj26Response(
  token: string,
  cellId: string,
  code: number,
  turnRelevant: boolean | null,
  comment: string | null,
): Promise<void> {
  const { dbType, sqlite, pg } = getDbHandles();

  if (dbType === 'sqlite' && sqlite) {
    sqlite.prepare(
      `INSERT INTO ${RESPONSES} (token, cell_id, code, turn_relevant, comment)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(token, cell_id) DO UPDATE SET
         code = excluded.code,
         turn_relevant = excluded.turn_relevant,
         comment = excluded.comment`
    ).run(token, cellId, code, turnRelevant === null ? null : (turnRelevant ? 1 : 0), comment);
    return;
  }

  if (dbType === 'postgres' && pg) {
    await pg.query(
      `INSERT INTO ${RESPONSES} (token, cell_id, code, turn_relevant, comment)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (token, cell_id) DO UPDATE SET
         code = EXCLUDED.code,
         turn_relevant = EXCLUDED.turn_relevant,
         comment = EXCLUDED.comment`,
      [token, cellId, code, turnRelevant, comment]
    );
    return;
  }

  throw new Error('npj26: no database connection');
}

// ── Admin export ─────────────────────────────────────────────────────

const EXPORT_COLUMNS = [
  'token', 'cell_id', 'display_order', 'bucket', 'case_id', 'condition', 'variable',
  'domain', 'item_text', 'has_highlight', 'match_method', 'viet_turn_index',
  'eng_turn_index', 'code', 'code_label', 'turn_relevant', 'comment', 'created_at',
] as const;

const CODE_LABELS: Record<number, string> = {
  1: 'Vietnamese supports item; English dropped or garbled it',
  2: 'Present in both languages but does not meet the item',
  3: 'Nothing in the Vietnamese supports this item',
  4: 'Cannot tell',
};

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Every response joined to its cell's study labels, as CSV. This is the only
 * place `bucket` and `match_method` leave the database, and it is behind the
 * admin passphrase.
 */
export async function exportNpj26Csv(): Promise<string> {
  const { dbType, sqlite, pg } = getDbHandles();
  const sql = `
    SELECT r.token, r.cell_id, c.display_order, c.bucket, c.case_id, c."condition",
           c.variable, c.domain, c.item_text, c.has_highlight, c.match_method,
           c.viet_turn_index, c.eng_turn_index,
           r.code, r.turn_relevant, r.comment, r.created_at
    FROM ${RESPONSES} r
    LEFT JOIN ${CELLS} c ON c.cell_id = r.cell_id
    ORDER BY r.token ASC, c.display_order ASC, r.cell_id ASC`;

  let rows: Array<Record<string, unknown>>;
  if (dbType === 'sqlite' && sqlite) {
    rows = sqlite.prepare(sql).all() as Array<Record<string, unknown>>;
  } else if (dbType === 'postgres' && pg) {
    rows = (await pg.query(sql)).rows;
  } else {
    throw new Error('npj26: no database connection');
  }

  const lines = [EXPORT_COLUMNS.join(',')];
  for (const r of rows) {
    const code = toInt(r.code);
    const out: Record<string, unknown> = {
      ...r,
      has_highlight: toBool(r.has_highlight),
      turn_relevant: r.turn_relevant === null || r.turn_relevant === undefined
        ? null
        : toBool(r.turn_relevant),
      code_label: code !== null ? (CODE_LABELS[code] ?? '') : '',
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    };
    lines.push(EXPORT_COLUMNS.map(col => csvCell(out[col])).join(','));
  }
  return lines.join('\n') + '\n';
}
