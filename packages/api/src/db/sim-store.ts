/**
 * The simulator's tables and rows: vignette assignments, the Kobo form URL and
 * UID, the case template, and the form and transcript marks on `session_log`.
 *
 * The simulator is built on the engine, so this module may read the engine's
 * documents (engine-store.ts); the engine never imports from here.
 */
import { db, pgPool, dbType, activeAdminTable, activeAssignmentsTable } from './connection.js';
import { getSystemPrompt, getAllVignettes } from './engine-store.js';

// Interface for vignette-to-user assignments
export interface VignetteAssignment {
  id: number;
  uid: string;
  vignette_id: number;
  vignette_key?: string;  // Populated via JOIN for display purposes
  created_at?: string;
}

export interface BulkAssignmentRow {
  uid: string;
  vignetteKey: string;
}

export interface BulkAssignmentResult {
  created: number;
  skippedExisting: number;
  duplicatesInPayload: number;
}

export class MissingVignetteKeysError extends Error {
  missingKeys: string[];

  constructor(missingKeys: string[]) {
    super(`Missing vignette keys: ${missingKeys.join(', ')}`);
    this.name = 'MissingVignetteKeysError';
    this.missingKeys = missingKeys;
  }
}

// Get all admin content (for admin dashboard)
export async function getAllAdminContent(): Promise<{
  systemPrompt: string | null;
  vignettes: Array<{ id: number; key: string; content: string; sort_order: number }>;
  koboFormUrl: string | null;
  koboFormUid: string | null;
  caseTemplate: string | null;
}> {
  const systemPrompt = await getSystemPrompt();
  const vignettes = await getAllVignettes();
  const koboFormUrl = await getKoboFormUrl();
  const koboFormUid = await getKoboFormUid();
  const caseTemplate = await getCaseTemplate();
  return { systemPrompt, vignettes, koboFormUrl, koboFormUid, caseTemplate };
}

// Get Kobo form URL from database
export async function getKoboFormUrl(): Promise<string | null> {
  if (dbType === 'sqlite' && db) {
    const row = db.prepare(`SELECT content FROM ${activeAdminTable()} WHERE content_type = ? LIMIT 1`)
      .get('kobo_form_url') as { content: string } | undefined;
    return row?.content || null;
  } else if (dbType === 'postgres' && pgPool) {
    const result = await pgPool.query(
      `SELECT content FROM ${activeAdminTable()} WHERE content_type = $1 LIMIT 1`,
      ['kobo_form_url']
    );
    return result.rows[0]?.content || null;
  }
  return null;
}

// Save or update Kobo form URL
export async function saveKoboFormUrl(url: string): Promise<void> {
  const trimmed = url.trim();
  if (!trimmed) throw new Error('Kobo form URL cannot be empty');
  
  // Basic URL validation
  try {
    const urlObj = new URL(trimmed);
    if (urlObj.protocol !== 'https:') {
      throw new Error('Kobo form URL must use HTTPS');
    }
  } catch (e) {
    throw new Error('Invalid Kobo form URL format');
  }
  
  if (dbType === 'sqlite' && db) {
    // Check if Kobo URL exists
    const existing = db.prepare(`SELECT id FROM ${activeAdminTable()} WHERE content_type = ? LIMIT 1`)
      .get('kobo_form_url') as { id: number } | undefined;
    
    if (existing) {
      // Update existing
      db.prepare(`UPDATE ${activeAdminTable()} SET content = ?, updated_at = datetime('now') WHERE content_type = ?`)
        .run(trimmed, 'kobo_form_url');
    } else {
      // Insert new
      db.prepare(`INSERT INTO ${activeAdminTable()} (content_type, vignette_key, content) VALUES (?, NULL, ?)`)
        .run('kobo_form_url', trimmed);
    }
  } else if (dbType === 'postgres' && pgPool) {
    // Check if Kobo URL exists
    const result = await pgPool.query(
      `SELECT id FROM ${activeAdminTable()} WHERE content_type = $1 LIMIT 1`,
      ['kobo_form_url']
    );
    
    if (result.rows.length > 0) {
      // Update existing
      await pgPool.query(
        `UPDATE ${activeAdminTable()} SET content = $1, updated_at = NOW() WHERE content_type = $2`,
        [trimmed, 'kobo_form_url']
      );
    } else {
      // Insert new
      await pgPool.query(
        `INSERT INTO ${activeAdminTable()} (content_type, vignette_key, content) VALUES ($1, NULL, $2)`,
        ['kobo_form_url', trimmed]
      );
    }
  }
}

// Get Kobo form UID from database
export async function getKoboFormUid(): Promise<string | null> {
  if (dbType === 'sqlite' && db) {
    const row = db.prepare(`SELECT content FROM ${activeAdminTable()} WHERE content_type = ? LIMIT 1`)
      .get('kobo_form_uid') as { content: string } | undefined;
    return row?.content || null;
  } else if (dbType === 'postgres' && pgPool) {
    const result = await pgPool.query(
      `SELECT content FROM ${activeAdminTable()} WHERE content_type = $1 LIMIT 1`,
      ['kobo_form_uid']
    );
    return result.rows[0]?.content || null;
  }
  return null;
}

// Save or update Kobo form UID
export async function saveKoboFormUid(uid: string): Promise<void> {
  const trimmed = uid.trim();
  if (!trimmed) throw new Error('Kobo form UID cannot be empty');

  if (dbType === 'sqlite' && db) {
    const existing = db.prepare(`SELECT id FROM ${activeAdminTable()} WHERE content_type = ? LIMIT 1`)
      .get('kobo_form_uid') as { id: number } | undefined;

    if (existing) {
      db.prepare(`UPDATE ${activeAdminTable()} SET content = ?, updated_at = datetime('now') WHERE content_type = ?`)
        .run(trimmed, 'kobo_form_uid');
    } else {
      db.prepare(`INSERT INTO ${activeAdminTable()} (content_type, vignette_key, content) VALUES (?, NULL, ?)`)
        .run('kobo_form_uid', trimmed);
    }
  } else if (dbType === 'postgres' && pgPool) {
    const result = await pgPool.query(
      `SELECT id FROM ${activeAdminTable()} WHERE content_type = $1 LIMIT 1`,
      ['kobo_form_uid']
    );

    if (result.rows.length > 0) {
      await pgPool.query(
        `UPDATE ${activeAdminTable()} SET content = $1, updated_at = NOW() WHERE content_type = $2`,
        [trimmed, 'kobo_form_uid']
      );
    } else {
      await pgPool.query(
        `INSERT INTO ${activeAdminTable()} (content_type, vignette_key, content) VALUES ($1, NULL, $2)`,
        ['kobo_form_uid', trimmed]
      );
    }
  }
}

// Get case template name from database
export async function getCaseTemplate(): Promise<string | null> {
  if (dbType === 'sqlite' && db) {
    const row = db.prepare(`SELECT content FROM ${activeAdminTable()} WHERE content_type = ? LIMIT 1`)
      .get('case_template') as { content: string } | undefined;
    return row?.content || null;
  } else if (dbType === 'postgres' && pgPool) {
    const result = await pgPool.query(
      `SELECT content FROM ${activeAdminTable()} WHERE content_type = $1 LIMIT 1`,
      ['case_template']
    );
    return result.rows[0]?.content || null;
  }
  return null;
}

// Save or update case template name
export async function saveCaseTemplate(templateName: string): Promise<void> {
  const trimmed = templateName.trim();
  if (!trimmed) throw new Error('Case template name cannot be empty');

  if (dbType === 'sqlite' && db) {
    const existing = db.prepare(`SELECT id FROM ${activeAdminTable()} WHERE content_type = ? LIMIT 1`)
      .get('case_template') as { id: number } | undefined;

    if (existing) {
      db.prepare(`UPDATE ${activeAdminTable()} SET content = ?, updated_at = datetime('now') WHERE content_type = ?`)
        .run(trimmed, 'case_template');
    } else {
      db.prepare(`INSERT INTO ${activeAdminTable()} (content_type, vignette_key, content) VALUES (?, NULL, ?)`)
        .run('case_template', trimmed);
    }
  } else if (dbType === 'postgres' && pgPool) {
    const result = await pgPool.query(
      `SELECT id FROM ${activeAdminTable()} WHERE content_type = $1 LIMIT 1`,
      ['case_template']
    );

    if (result.rows.length > 0) {
      await pgPool.query(
        `UPDATE ${activeAdminTable()} SET content = $1, updated_at = NOW() WHERE content_type = $2`,
        [trimmed, 'case_template']
      );
    } else {
      await pgPool.query(
        `INSERT INTO ${activeAdminTable()} (content_type, vignette_key, content) VALUES ($1, NULL, $2)`,
        ['case_template', trimmed]
      );
    }
  }
}

// ==================== Vignette Assignments ====================

// Get all vignette assignments, optionally filtered by uid
// JOINs to admin_content to include vignette_key for display
export async function getVignetteAssignments(uid?: string): Promise<VignetteAssignment[]> {
  if (dbType === 'sqlite' && db) {
    const query = `
      SELECT a.id, a.uid, a.vignette_id, a.created_at, c.vignette_key
      FROM ${activeAssignmentsTable()} a
      LEFT JOIN ${activeAdminTable()} c ON c.id = a.vignette_id AND c.content_type = 'vignette'
      ${uid ? 'WHERE a.uid = ?' : ''}
      ORDER BY ${uid ? 'a.id ASC' : 'a.uid ASC, a.id ASC'}
    `;
    const rows = uid
      ? db.prepare(query).all(uid) as VignetteAssignment[]
      : db.prepare(query).all() as VignetteAssignment[];
    return rows;
  } else if (dbType === 'postgres' && pgPool) {
    const query = `
      SELECT a.id, a.uid, a.vignette_id, a.created_at, c.vignette_key
      FROM ${activeAssignmentsTable()} a
      LEFT JOIN ${activeAdminTable()} c ON c.id = a.vignette_id AND c.content_type = 'vignette'
      ${uid ? 'WHERE a.uid = $1' : ''}
      ORDER BY ${uid ? 'a.id ASC' : 'a.uid ASC, a.id ASC'}
    `;
    const result = uid
      ? await pgPool.query(query, [uid])
      : await pgPool.query(query);
    return result.rows;
  }
  return [];
}

// Add a vignette assignment for a user
export async function addVignetteAssignment(uid: string, vignetteId: number): Promise<VignetteAssignment> {
  const trimmedUid = uid.trim();
  
  if (!trimmedUid) throw new Error('User ID cannot be empty');
  if (!vignetteId || vignetteId <= 0) throw new Error('Vignette ID must be a positive integer');
  
  if (dbType === 'sqlite' && db) {
    const result = db.prepare(`INSERT INTO ${activeAssignmentsTable()} (uid, vignette_id) VALUES (?, ?)`)
      .run(trimmedUid, vignetteId);
    const newId = result.lastInsertRowid as number;
    // Return with vignette_key via JOIN for display
    const row = db.prepare(`
      SELECT a.id, a.uid, a.vignette_id, a.created_at, c.vignette_key
      FROM ${activeAssignmentsTable()} a
      LEFT JOIN ${activeAdminTable()} c ON c.id = a.vignette_id AND c.content_type = 'vignette'
      WHERE a.id = ?
    `).get(newId) as VignetteAssignment;
    return row;
  } else if (dbType === 'postgres' && pgPool) {
    const result = await pgPool.query(
      `INSERT INTO ${activeAssignmentsTable()} (uid, vignette_id) VALUES ($1, $2)
       RETURNING id, uid, vignette_id, created_at`,
      [trimmedUid, vignetteId]
    );
    // Fetch vignette_key for display
    const assignment = result.rows[0];
    const keyResult = await pgPool.query(
      `SELECT vignette_key FROM ${activeAdminTable()} WHERE id = $1 AND content_type = 'vignette'`,
      [vignetteId]
    );
    assignment.vignette_key = keyResult.rows[0]?.vignette_key || null;
    return assignment;
  }
  throw new Error('Database not initialized');
}

// Delete a vignette assignment by id
export async function deleteVignetteAssignment(id: number): Promise<void> {
  if (dbType === 'sqlite' && db) {
    db.prepare(`DELETE FROM ${activeAssignmentsTable()} WHERE id = ?`).run(id);
  } else if (dbType === 'postgres' && pgPool) {
    await pgPool.query(`DELETE FROM ${activeAssignmentsTable()} WHERE id = $1`, [id]);
  }
}

export async function deleteVignetteAssignments(ids: number[]): Promise<number> {
  const uniqueIds = Array.from(new Set(ids.filter((value) => Number.isInteger(value) && value > 0)));
  if (uniqueIds.length === 0) {
    return 0;
  }

  if (dbType === 'sqlite' && db) {
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const statement = db.prepare(
      `DELETE FROM ${activeAssignmentsTable()} WHERE id IN (${placeholders})`
    );
    const result = statement.run(...uniqueIds);
    return result.changes ?? 0;
  } else if (dbType === 'postgres' && pgPool) {
    const result = await pgPool.query(
      `DELETE FROM ${activeAssignmentsTable()} WHERE id = ANY($1::int[]) RETURNING id`,
      [uniqueIds]
    );
    return result.rowCount ?? 0;
  }

  throw new Error('Database not initialized');
}

// Get vignette ID from key (for translating user-facing key to internal ID)
export async function getVignetteIdByKey(key: string): Promise<number | null> {
  const trimmedKey = key.trim();
  if (!trimmedKey) return null;
  
  if (dbType === 'sqlite' && db) {
    const row = db.prepare(`SELECT id FROM ${activeAdminTable()} WHERE content_type = 'vignette' AND vignette_key = ? LIMIT 1`)
      .get(trimmedKey) as { id: number } | undefined;
    return row?.id || null;
  } else if (dbType === 'postgres' && pgPool) {
    const result = await pgPool.query(
      `SELECT id FROM ${activeAdminTable()} WHERE content_type = 'vignette' AND vignette_key = $1 LIMIT 1`,
      [trimmedKey]
    );
    return result.rows[0]?.id || null;
  }
  return null;
}

// Get vignettes for a specific uid
// If user has assignments, returns only those vignettes; otherwise returns all vignettes
export async function getVignettesForUid(uid: string | null): Promise<Array<{ key: string; content: string; sort_order: number }>> {
  // If no uid provided, return all vignettes
  if (!uid || !uid.trim()) {
    return getAllVignettes();
  }
  
  // Check if user has any assignments
  const assignments = await getVignetteAssignments(uid.trim());
  
  // If no assignments, return all vignettes
  if (assignments.length === 0) {
    return getAllVignettes();
  }
  
  // User has assignments - return only assigned vignettes by ID
  const assignedIds = new Set(assignments.map(a => a.vignette_id));
  
  // Get vignettes directly by ID from database
  if (dbType === 'sqlite' && db) {
    const placeholders = Array.from(assignedIds).map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT vignette_key, content, sort_order, id 
      FROM ${activeAdminTable()} 
      WHERE content_type = 'vignette' AND id IN (${placeholders})
      ORDER BY sort_order ASC, id ASC
    `).all(...assignedIds) as Array<{ vignette_key: string; content: string; sort_order: number; id: number }>;
    return rows.map(r => ({ key: r.vignette_key, content: r.content, sort_order: r.sort_order || 0 }));
  } else if (dbType === 'postgres' && pgPool) {
    const idsArray = Array.from(assignedIds);
    const result = await pgPool.query(
      `SELECT vignette_key, content, sort_order, id 
       FROM ${activeAdminTable()} 
       WHERE content_type = 'vignette' AND id = ANY($1)
       ORDER BY sort_order ASC, id ASC`,
      [idsArray]
    );
    return result.rows.map((r: any) => ({ key: r.vignette_key, content: r.content, sort_order: r.sort_order || 0 }));
  }
  
  return getAllVignettes();
}

export async function bulkAddVignetteAssignments(rows: BulkAssignmentRow[]): Promise<BulkAssignmentResult> {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { created: 0, skippedExisting: 0, duplicatesInPayload: 0 };
  }

  const cleanedRows = rows.map((row) => {
    const uid = row.uid?.trim();
    const key = row.vignetteKey?.trim();

    if (!uid || !key) {
      throw new Error('Each assignment must include both uid and vignetteKey');
    }

    return {
      uid,
      normalizedKey: key.toLowerCase(),
      originalKey: key,
    };
  });

  const normalizedKeyToOriginal = new Map<string, string>();
  const uniqueRows: Array<{ uid: string; normalizedKey: string; originalKey: string }> = [];
  const seenPairs = new Set<string>();
  let duplicatesInPayload = 0;

  for (const row of cleanedRows) {
    if (!normalizedKeyToOriginal.has(row.normalizedKey)) {
      normalizedKeyToOriginal.set(row.normalizedKey, row.originalKey);
    }

    const pairKey = `${row.uid}||${row.normalizedKey}`;
    if (seenPairs.has(pairKey)) {
      duplicatesInPayload += 1;
      continue;
    }

    seenPairs.add(pairKey);
    uniqueRows.push(row);
  }

  if (uniqueRows.length === 0) {
    return { created: 0, skippedExisting: 0, duplicatesInPayload };
  }

  const vignettes = await getAllVignettes();
  const vignetteMap = new Map<string, { id: number; key: string }>();
  for (const vignette of vignettes) {
    if (vignette.key) {
      vignetteMap.set(vignette.key.trim().toLowerCase(), { id: vignette.id, key: vignette.key });
    }
  }

  const requiredKeys = new Set(uniqueRows.map((row) => row.normalizedKey));
  const missingKeys: string[] = [];
  for (const normalizedKey of requiredKeys) {
    if (!vignetteMap.has(normalizedKey)) {
      missingKeys.push(normalizedKeyToOriginal.get(normalizedKey) || normalizedKey);
    }
  }

  if (missingKeys.length > 0) {
    throw new MissingVignetteKeysError(missingKeys);
  }

  const rowsWithIds = uniqueRows.map((row) => ({
    uid: row.uid,
    vignetteId: vignetteMap.get(row.normalizedKey)!.id,
  }));

  let created = 0;
  let skippedExisting = 0;

  if (dbType === 'sqlite' && db) {
    const insertStmt = db.prepare(
      `INSERT INTO ${activeAssignmentsTable()} (uid, vignette_id) VALUES (?, ?)`
    );
    const runInTransaction = db.transaction((entries: Array<{ uid: string; vignetteId: number }>) => {
      for (const entry of entries) {
        try {
          insertStmt.run(entry.uid, entry.vignetteId);
          created += 1;
        } catch (error: any) {
          if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            skippedExisting += 1;
          } else {
            throw error;
          }
        }
      }
    });

    runInTransaction(rowsWithIds);
  } else if (dbType === 'postgres' && pgPool) {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');

      for (const entry of rowsWithIds) {
        try {
          await client.query(
            `INSERT INTO ${activeAssignmentsTable()} (uid, vignette_id) VALUES ($1, $2)`,
            [entry.uid, entry.vignetteId]
          );
          created += 1;
        } catch (error: any) {
          if (error?.code === '23505') {
            skippedExisting += 1;
            continue;
          }
          throw error;
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } else {
    throw new Error('Database not initialized');
  }

  return { created, skippedExisting, duplicatesInPayload };
}

export async function logSessionFormSubmit(project: string, sessionToken: string): Promise<void> {
  if (dbType === 'sqlite' && db) {
    db.prepare(`
      INSERT INTO session_log (project, session_token, form_submitted, started_at, last_activity_at)
      VALUES (?, ?, 1, datetime('now'), datetime('now'))
      ON CONFLICT(project, session_token) DO UPDATE SET
        form_submitted = 1,
        last_activity_at = datetime('now')
    `).run(project, sessionToken);
  } else if (dbType === 'postgres' && pgPool) {
    await pgPool.query(`
      INSERT INTO session_log (project, session_token, form_submitted, started_at, last_activity_at)
      VALUES ($1, $2, 1, NOW(), NOW())
      ON CONFLICT(project, session_token) DO UPDATE SET
        form_submitted = 1,
        last_activity_at = NOW()
    `, [project, sessionToken]);
  }
}

export async function logSessionTranscriptSaved(project: string, sessionToken: string): Promise<void> {
  if (dbType === 'sqlite' && db) {
    db.prepare(`
      INSERT INTO session_log (project, session_token, transcript_saved, started_at, last_activity_at)
      VALUES (?, ?, 1, datetime('now'), datetime('now'))
      ON CONFLICT(project, session_token) DO UPDATE SET
        transcript_saved = 1,
        last_activity_at = datetime('now')
    `).run(project, sessionToken);
  } else if (dbType === 'postgres' && pgPool) {
    await pgPool.query(`
      INSERT INTO session_log (project, session_token, transcript_saved, started_at, last_activity_at)
      VALUES ($1, $2, 1, NOW(), NOW())
      ON CONFLICT(project, session_token) DO UPDATE SET
        transcript_saved = 1,
        last_activity_at = NOW()
    `, [project, sessionToken]);
  }
}
