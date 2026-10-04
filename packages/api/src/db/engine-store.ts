/**
 * The engine's tables: what every app on the chat engine reads and writes.
 *
 * - documents in `<prefix>admin_content`: the system prompt, the vignettes
 *   (documents) and languages.json;
 * - the global ledgers: `token_usage`, `qa_log`, `session_log` (messages) and
 *   `project_settings`.
 *
 * `engineStore` is the chat pipeline's view of it (ChatStore). The simulator's
 * rows live in sim-store.ts; the connection and DDL in connection.ts.
 */
import type { ChatStore } from '@ai-med/chat-core';
import { db, pgPool, dbType, activeAdminTable } from './connection.js';

// Database interface for our admin content
export interface AdminContent {
  id?: number;
  content_type: 'system_prompt' | 'vignette' | 'kobo_form_url' | 'kobo_form_uid' | 'languages' | 'case_template';
  vignette_key?: string | null;
  content: string;
  created_at?: string;
  updated_at?: string;
}

// Get system prompt from database
export async function getSystemPrompt(): Promise<string | null> {
  if (dbType === 'sqlite' && db) {
    const row = db.prepare(`SELECT content FROM ${activeAdminTable()} WHERE content_type = ? LIMIT 1`)
      .get('system_prompt') as { content: string } | undefined;
    return row?.content || null;
  } else if (dbType === 'postgres' && pgPool) {
    const result = await pgPool.query(
      `SELECT content FROM ${activeAdminTable()} WHERE content_type = $1 LIMIT 1`,
      ['system_prompt']
    );
    return result.rows[0]?.content || null;
  }
  return null;
}

// Save or update system prompt
export async function saveSystemPrompt(content: string): Promise<void> {
  const trimmed = content.trim();
  if (!trimmed) throw new Error('System prompt cannot be empty');
  
  if (dbType === 'sqlite' && db) {
    // Check if system prompt exists
    const existing = db.prepare(`SELECT id FROM ${activeAdminTable()} WHERE content_type = ? LIMIT 1`)
      .get('system_prompt') as { id: number } | undefined;
    
    if (existing) {
      // Update existing
      db.prepare(`UPDATE ${activeAdminTable()} SET content = ?, updated_at = datetime('now') WHERE content_type = ?`)
        .run(trimmed, 'system_prompt');
    } else {
      // Insert new
      db.prepare(`INSERT INTO ${activeAdminTable()} (content_type, vignette_key, content) VALUES (?, NULL, ?)`)
        .run('system_prompt', trimmed);
    }
  } else if (dbType === 'postgres' && pgPool) {
    // Check if system prompt exists
    const result = await pgPool.query(
      `SELECT id FROM ${activeAdminTable()} WHERE content_type = $1 LIMIT 1`,
      ['system_prompt']
    );
    
    if (result.rows.length > 0) {
      // Update existing
      await pgPool.query(
        `UPDATE ${activeAdminTable()} SET content = $1, updated_at = NOW() WHERE content_type = $2`,
        [trimmed, 'system_prompt']
      );
    } else {
      // Insert new
      await pgPool.query(
        `INSERT INTO ${activeAdminTable()} (content_type, vignette_key, content) VALUES ($1, NULL, $2)`,
        ['system_prompt', trimmed]
      );
    }
  }
}

// Get all vignettes from database (ordered by sort_order)
export async function getAllVignettes(): Promise<Array<{ id: number; key: string; content: string; sort_order: number }>> {
  if (dbType === 'sqlite' && db) {
    const rows = db.prepare(`SELECT id, vignette_key, content, sort_order FROM ${activeAdminTable()} WHERE content_type = ? ORDER BY sort_order ASC, id ASC`)
      .all('vignette') as Array<{ id: number; vignette_key: string; content: string; sort_order: number }>;
    return rows.map(r => ({ id: r.id, key: r.vignette_key, content: r.content, sort_order: r.sort_order || 0 }));
  } else if (dbType === 'postgres' && pgPool) {
    const result = await pgPool.query(
      `SELECT id, vignette_key, content, sort_order FROM ${activeAdminTable()} WHERE content_type = $1 ORDER BY sort_order ASC, id ASC`,
      ['vignette']
    );
    return result.rows.map((r: any) => ({ id: r.id, key: r.vignette_key, content: r.content, sort_order: r.sort_order || 0 }));
  }
  return [];
}

// Backwards compatibility alias
export async function getCustomVignettes(): Promise<Array<{ key: string; content: string }>> {
  return getAllVignettes();
}

// Save or update a vignette
export async function saveVignette(key: string, content: string, sortOrder?: number): Promise<void> {
  const trimmedKey = key.trim();
  const trimmedContent = content.trim();
  
  if (!trimmedKey) throw new Error('Vignette key cannot be empty');
  if (!trimmedContent) throw new Error('Vignette content cannot be empty');
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmedKey)) {
    throw new Error('Vignette key must contain only letters, numbers, underscores, and hyphens');
  }
  
  if (dbType === 'sqlite' && db) {
    // Check if vignette exists
    const existing = db.prepare(`SELECT id FROM ${activeAdminTable()} WHERE content_type = ? AND vignette_key = ? LIMIT 1`)
      .get('vignette', trimmedKey) as { id: number } | undefined;
    
    if (existing) {
      // Update existing (don't change sort_order unless explicitly provided)
      if (sortOrder !== undefined) {
        db.prepare(`UPDATE ${activeAdminTable()} SET content = ?, sort_order = ?, updated_at = datetime('now') WHERE content_type = ? AND vignette_key = ?`)
          .run(trimmedContent, sortOrder, 'vignette', trimmedKey);
      } else {
        db.prepare(`UPDATE ${activeAdminTable()} SET content = ?, updated_at = datetime('now') WHERE content_type = ? AND vignette_key = ?`)
          .run(trimmedContent, 'vignette', trimmedKey);
      }
    } else {
      // Insert new - get max sort_order and add 1
      const maxOrder = db.prepare(`SELECT MAX(sort_order) as max_order FROM ${activeAdminTable()} WHERE content_type = ?`)
        .get('vignette') as { max_order: number | null } | undefined;
      const newOrder = sortOrder ?? ((maxOrder?.max_order || 0) + 1);
      db.prepare(`INSERT INTO ${activeAdminTable()} (content_type, vignette_key, content, sort_order) VALUES (?, ?, ?, ?)`)
        .run('vignette', trimmedKey, trimmedContent, newOrder);
    }
  } else if (dbType === 'postgres' && pgPool) {
    // Check if vignette exists
    const result = await pgPool.query(
      `SELECT id FROM ${activeAdminTable()} WHERE content_type = $1 AND vignette_key = $2 LIMIT 1`,
      ['vignette', trimmedKey]
    );
    
    if (result.rows.length > 0) {
      // Update existing (don't change sort_order unless explicitly provided)
      if (sortOrder !== undefined) {
        await pgPool.query(
          `UPDATE ${activeAdminTable()} SET content = $1, sort_order = $2, updated_at = NOW() WHERE content_type = $3 AND vignette_key = $4`,
          [trimmedContent, sortOrder, 'vignette', trimmedKey]
        );
      } else {
        await pgPool.query(
          `UPDATE ${activeAdminTable()} SET content = $1, updated_at = NOW() WHERE content_type = $2 AND vignette_key = $3`,
          [trimmedContent, 'vignette', trimmedKey]
        );
      }
    } else {
      // Insert new - get max sort_order and add 1
      const maxResult = await pgPool.query(
        `SELECT MAX(sort_order) as max_order FROM ${activeAdminTable()} WHERE content_type = $1`,
        ['vignette']
      );
      const newOrder = sortOrder ?? ((maxResult.rows[0]?.max_order || 0) + 1);
      await pgPool.query(
        `INSERT INTO ${activeAdminTable()} (content_type, vignette_key, content, sort_order) VALUES ($1, $2, $3, $4)`,
        ['vignette', trimmedKey, trimmedContent, newOrder]
      );
    }
  }
}

// Delete a vignette
export async function deleteVignette(key: string): Promise<void> {
  if (dbType === 'sqlite' && db) {
    db.prepare(`DELETE FROM ${activeAdminTable()} WHERE content_type = ? AND vignette_key = ?`)
      .run('vignette', key);
  } else if (dbType === 'postgres' && pgPool) {
    await pgPool.query(
      `DELETE FROM ${activeAdminTable()} WHERE content_type = $1 AND vignette_key = $2`,
      ['vignette', key]
    );
  }
}

// Delete a vignette by ID
export async function deleteVignetteById(id: number): Promise<void> {
  if (dbType === 'sqlite' && db) {
    db.prepare(`DELETE FROM ${activeAdminTable()} WHERE content_type = ? AND id = ?`)
      .run('vignette', id);
  } else if (dbType === 'postgres' && pgPool) {
    await pgPool.query(
      `DELETE FROM ${activeAdminTable()} WHERE content_type = $1 AND id = $2`,
      ['vignette', id]
    );
  }
}

// Update a vignette by ID (allows changing the key)
export async function updateVignetteById(id: number, key: string, content: string): Promise<void> {
  const trimmedKey = key.trim();
  const trimmedContent = content.trim();
  
  if (!trimmedKey) throw new Error('Vignette key cannot be empty');
  if (!trimmedContent) throw new Error('Vignette content cannot be empty');
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmedKey)) {
    throw new Error('Vignette key must contain only letters, numbers, underscores, and hyphens');
  }
  
  if (dbType === 'sqlite' && db) {
    db.prepare(`UPDATE ${activeAdminTable()} SET vignette_key = ?, content = ?, updated_at = datetime('now') WHERE content_type = ? AND id = ?`)
      .run(trimmedKey, trimmedContent, 'vignette', id);
  } else if (dbType === 'postgres' && pgPool) {
    await pgPool.query(
      `UPDATE ${activeAdminTable()} SET vignette_key = $1, content = $2, updated_at = NOW() WHERE content_type = $3 AND id = $4`,
      [trimmedKey, trimmedContent, 'vignette', id]
    );
  }
}

// Update vignette sort order
export async function updateVignetteSortOrder(key: string, newOrder: number): Promise<void> {
  if (dbType === 'sqlite' && db) {
    db.prepare(`UPDATE ${activeAdminTable()} SET sort_order = ?, updated_at = datetime('now') WHERE content_type = ? AND vignette_key = ?`)
      .run(newOrder, 'vignette', key);
  } else if (dbType === 'postgres' && pgPool) {
    await pgPool.query(
      `UPDATE ${activeAdminTable()} SET sort_order = $1, updated_at = NOW() WHERE content_type = $2 AND vignette_key = $3`,
      [newOrder, 'vignette', key]
    );
  }
}

// Swap the order of two vignettes
export async function swapVignetteOrder(key1: string, key2: string): Promise<void> {
  // Get current orders
  const vignettes = await getAllVignettes();
  const v1 = vignettes.find(v => v.key === key1);
  const v2 = vignettes.find(v => v.key === key2);
  
  if (!v1 || !v2) {
    throw new Error('One or both vignettes not found');
  }
  
  // Swap the sort_order values
  await updateVignetteSortOrder(key1, v2.sort_order);
  await updateVignetteSortOrder(key2, v1.sort_order);
}

// Get languages configuration from database
export async function getLanguages(): Promise<string | null> {
  if (dbType === 'sqlite' && db) {
    const row = db.prepare(`SELECT content FROM ${activeAdminTable()} WHERE content_type = ? LIMIT 1`)
      .get('languages') as { content: string } | undefined;
    return row?.content || null;
  } else if (dbType === 'postgres' && pgPool) {
    const result = await pgPool.query(
      `SELECT content FROM ${activeAdminTable()} WHERE content_type = $1 LIMIT 1`,
      ['languages']
    );
    return result.rows[0]?.content || null;
  }
  return null;
}

// Save or update languages configuration
export async function saveLanguages(content: string): Promise<void> {
  const trimmed = content.trim();
  if (!trimmed) throw new Error('Languages content cannot be empty');
  
  // Validate JSON
  try {
    JSON.parse(trimmed);
  } catch (e) {
    throw new Error('Languages content must be valid JSON');
  }
  
  if (dbType === 'sqlite' && db) {
    // Check if languages config exists
    const existing = db.prepare(`SELECT id FROM ${activeAdminTable()} WHERE content_type = ? LIMIT 1`)
      .get('languages') as { id: number } | undefined;
    
    if (existing) {
      // Update existing
      db.prepare(`UPDATE ${activeAdminTable()} SET content = ?, updated_at = datetime('now') WHERE content_type = ?`)
        .run(trimmed, 'languages');
    } else {
      // Insert new
      db.prepare(`INSERT INTO ${activeAdminTable()} (content_type, vignette_key, content) VALUES (?, NULL, ?)`)
        .run('languages', trimmed);
    }
  } else if (dbType === 'postgres' && pgPool) {
    // Check if languages config exists
    const result = await pgPool.query(
      `SELECT id FROM ${activeAdminTable()} WHERE content_type = $1 LIMIT 1`,
      ['languages']
    );
    
    if (result.rows.length > 0) {
      // Update existing
      await pgPool.query(
        `UPDATE ${activeAdminTable()} SET content = $1, updated_at = NOW() WHERE content_type = $2`,
        [trimmed, 'languages']
      );
    } else {
      // Insert new
      await pgPool.query(
        `INSERT INTO ${activeAdminTable()} (content_type, vignette_key, content) VALUES ($1, NULL, $2)`,
        ['languages', trimmed]
      );
    }
  }
}

// Log a single token usage entry
export async function logTokenUsage(entry: {
  project: string;
  endpoint: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  estimated_cost: number;
}): Promise<void> {
  try {
    if (dbType === 'sqlite' && db) {
      db.prepare(
        'INSERT INTO token_usage (project, endpoint, model, prompt_tokens, completion_tokens, estimated_cost) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(entry.project, entry.endpoint, entry.model, entry.prompt_tokens, entry.completion_tokens, entry.estimated_cost);
    } else if (dbType === 'postgres' && pgPool) {
      await pgPool.query(
        'INSERT INTO token_usage (project, endpoint, model, prompt_tokens, completion_tokens, estimated_cost) VALUES ($1, $2, $3, $4, $5, $6)',
        [entry.project, entry.endpoint, entry.model, entry.prompt_tokens, entry.completion_tokens, entry.estimated_cost]
      );
    }
  } catch (error) {
    console.error('Failed to log token usage:', error);
  }
}

// Get aggregated token usage summary
export async function getTokenUsageSummary(options?: { days?: number; project?: string }): Promise<{
  totals: { prompt_tokens: number; completion_tokens: number; estimated_cost: number };
  byModel: Array<{ model: string; prompt_tokens: number; completion_tokens: number; estimated_cost: number; call_count: number }>;
  byProject: Array<{ project: string; prompt_tokens: number; completion_tokens: number; estimated_cost: number; call_count: number }>;
  byDay: Array<{ day: string; prompt_tokens: number; completion_tokens: number; estimated_cost: number; call_count: number }>;
}> {
  const days = options?.days || 30;
  const project = options?.project;

  const empty = {
    totals: { prompt_tokens: 0, completion_tokens: 0, estimated_cost: 0 },
    byModel: [],
    byProject: [],
    byDay: [],
  };

  try {
    if (dbType === 'sqlite' && db) {
      const cutoff = `datetime('now', '-${days} days')`;
      const projectFilter = project ? ` AND project = '${project}'` : '';

      const totals = db.prepare(
        `SELECT COALESCE(SUM(prompt_tokens),0) as prompt_tokens, COALESCE(SUM(completion_tokens),0) as completion_tokens, COALESCE(SUM(estimated_cost),0) as estimated_cost FROM token_usage WHERE created_at >= ${cutoff}${projectFilter}`
      ).get() as any;

      const byModel = db.prepare(
        `SELECT model, SUM(prompt_tokens) as prompt_tokens, SUM(completion_tokens) as completion_tokens, SUM(estimated_cost) as estimated_cost, COUNT(*) as call_count FROM token_usage WHERE created_at >= ${cutoff}${projectFilter} GROUP BY model ORDER BY estimated_cost DESC`
      ).all() as any[];

      const byProject = db.prepare(
        `SELECT project, SUM(prompt_tokens) as prompt_tokens, SUM(completion_tokens) as completion_tokens, SUM(estimated_cost) as estimated_cost, COUNT(*) as call_count FROM token_usage WHERE created_at >= ${cutoff}${projectFilter} GROUP BY project ORDER BY estimated_cost DESC`
      ).all() as any[];

      const byDay = db.prepare(
        `SELECT date(created_at) as day, SUM(prompt_tokens) as prompt_tokens, SUM(completion_tokens) as completion_tokens, SUM(estimated_cost) as estimated_cost, COUNT(*) as call_count FROM token_usage WHERE created_at >= ${cutoff}${projectFilter} GROUP BY date(created_at) ORDER BY day DESC`
      ).all() as any[];

      return { totals, byModel, byProject, byDay };
    } else if (dbType === 'postgres' && pgPool) {
      const cutoff = `NOW() - INTERVAL '${days} days'`;
      const projectFilter = project ? ` AND project = '${project}'` : '';

      const totalsRes = await pgPool.query(
        `SELECT COALESCE(SUM(prompt_tokens),0)::int as prompt_tokens, COALESCE(SUM(completion_tokens),0)::int as completion_tokens, COALESCE(SUM(estimated_cost),0)::float as estimated_cost FROM token_usage WHERE created_at >= ${cutoff}${projectFilter}`
      );

      const byModelRes = await pgPool.query(
        `SELECT model, SUM(prompt_tokens)::int as prompt_tokens, SUM(completion_tokens)::int as completion_tokens, SUM(estimated_cost)::float as estimated_cost, COUNT(*)::int as call_count FROM token_usage WHERE created_at >= ${cutoff}${projectFilter} GROUP BY model ORDER BY estimated_cost DESC`
      );

      const byProjectRes = await pgPool.query(
        `SELECT project, SUM(prompt_tokens)::int as prompt_tokens, SUM(completion_tokens)::int as completion_tokens, SUM(estimated_cost)::float as estimated_cost, COUNT(*)::int as call_count FROM token_usage WHERE created_at >= ${cutoff}${projectFilter} GROUP BY project ORDER BY estimated_cost DESC`
      );

      const byDayRes = await pgPool.query(
        `SELECT created_at::date::text as day, SUM(prompt_tokens)::int as prompt_tokens, SUM(completion_tokens)::int as completion_tokens, SUM(estimated_cost)::float as estimated_cost, COUNT(*)::int as call_count FROM token_usage WHERE created_at >= ${cutoff}${projectFilter} GROUP BY created_at::date ORDER BY day DESC`
      );

      return {
        totals: totalsRes.rows[0] || empty.totals,
        byModel: byModelRes.rows,
        byProject: byProjectRes.rows,
        byDay: byDayRes.rows,
      };
    }
  } catch (error) {
    console.error('Failed to get token usage summary:', error);
  }

  return empty;
}

// ── Q&A Log (global, not project-scoped) ───────────────────────────────
// One row per chat turn (question + answer). Written only for projects that set
// `logConversations` in project.json. This is the DURABLE conversation store —
// unlike the transcripts/ filesystem path, it survives a redeploy. Read back
// through GET /api/admin/qa-log (admin auth) and tools/export-conversations.ts.

export async function logQaTurn(
  project: string,
  sessionToken: string | null,
  vignetteKey: string | null,
  language: string | null,
  question: string,
  answer: string,
): Promise<void> {
  if (dbType === 'sqlite' && db) {
    db.prepare(`
      INSERT INTO qa_log (project, session_token, vignette_key, language, question, answer, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(project, sessionToken, vignetteKey, language, question, answer);
  } else if (dbType === 'postgres' && pgPool) {
    await pgPool.query(`
      INSERT INTO qa_log (project, session_token, vignette_key, language, question, answer, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [project, sessionToken, vignetteKey, language, question, answer]);
  }
}

export interface QaLogRow {
  id: number;
  session_token: string | null;
  vignette_key: string | null;
  language: string | null;
  question: string;
  answer: string;
  /** ISO-8601 UTC, normalized identically on SQLite and Postgres */
  created_at: string;
}

export interface QaLogQuery {
  /** Relative window in days. Ignored when `since` is given. */
  days?: number;
  /** Inclusive lower bound, YYYY-MM-DD (UTC). */
  since?: string;
  /** Inclusive upper bound, YYYY-MM-DD (UTC) — covers the whole day. */
  until?: string;
  limit: number;
  offset: number;
}

export const QA_LOG_MAX_LIMIT = 2000;

/**
 * Read one project's logged chat turns, oldest first.
 *
 * Ordered by (created_at, id) so pagination is stable and an exported page
 * sequence reads chronologically. `total` counts every row matching the filter,
 * not just the returned page, so a caller can page to the end.
 */
export async function getQaLog(
  project: string,
  query: QaLogQuery,
): Promise<{ rows: QaLogRow[]; total: number }> {
  const limit = Math.max(1, Math.min(query.limit, QA_LOG_MAX_LIMIT));
  const offset = Math.max(0, query.offset);

  if (dbType === 'sqlite' && db) {
    const where: string[] = ['project = ?'];
    const params: any[] = [project];

    if (query.since) {
      where.push(`created_at >= ?`);
      params.push(`${query.since} 00:00:00`);
    } else if (query.days !== undefined) {
      where.push(`created_at >= datetime('now', '-' || ? || ' days')`);
      params.push(query.days);
    }
    if (query.until) {
      where.push(`created_at <= ?`);
      params.push(`${query.until} 23:59:59`);
    }
    const clause = where.join(' AND ');

    const totalRow = db.prepare(`SELECT COUNT(*) as total FROM qa_log WHERE ${clause}`)
      .get(...params) as any;

    const rows = db.prepare(`
      SELECT id,
             session_token,
             vignette_key,
             language,
             question,
             answer,
             strftime('%Y-%m-%dT%H:%M:%SZ', created_at) as created_at
      FROM qa_log
      WHERE ${clause}
      ORDER BY created_at ASC, id ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as QaLogRow[];

    return { rows, total: Number(totalRow?.total) || 0 };
  } else if (dbType === 'postgres' && pgPool) {
    const where: string[] = ['project = $1'];
    const params: any[] = [project];

    if (query.since) {
      params.push(query.since);
      where.push(`created_at >= $${params.length}::date`);
    } else if (query.days !== undefined) {
      params.push(query.days);
      where.push(`created_at >= NOW() - ($${params.length} || ' days')::interval`);
    }
    if (query.until) {
      params.push(query.until);
      where.push(`created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
    const clause = where.join(' AND ');

    const totalRes = await pgPool.query(
      `SELECT COUNT(*)::int as total FROM qa_log WHERE ${clause}`,
      params,
    );

    const rowsRes = await pgPool.query(`
      SELECT id,
             session_token,
             vignette_key,
             language,
             question,
             answer,
             TO_CHAR(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
      FROM qa_log
      WHERE ${clause}
      ORDER BY created_at ASC, id ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    return { rows: rowsRes.rows as QaLogRow[], total: totalRes.rows[0]?.total || 0 };
  }

  return { rows: [], total: 0 };
}

// ── Session Log (global, not project-scoped) ───────────────────────────

export async function logSessionMessage(project: string, sessionToken: string, vignetteKey: string): Promise<void> {
  if (dbType === 'sqlite' && db) {
    db.prepare(`
      INSERT INTO session_log (project, session_token, vignette_key, message_count, started_at, last_activity_at)
      VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))
      ON CONFLICT(project, session_token) DO UPDATE SET
        message_count = message_count + 1,
        last_activity_at = datetime('now')
    `).run(project, sessionToken, vignetteKey);
  } else if (dbType === 'postgres' && pgPool) {
    await pgPool.query(`
      INSERT INTO session_log (project, session_token, vignette_key, message_count, started_at, last_activity_at)
      VALUES ($1, $2, $3, 1, NOW(), NOW())
      ON CONFLICT(project, session_token) DO UPDATE SET
        message_count = session_log.message_count + 1,
        last_activity_at = NOW()
    `, [project, sessionToken, vignetteKey]);
  }
}

export async function getSessionStats(project: string, days: number): Promise<{
  totals: { sessions: number; submissions: number; transcripts: number; messages: number };
  byDay: Array<{ day: string; sessions: number; submissions: number; messages: number }>;
  byVignette: Array<{ vignette_key: string; sessions: number; submissions: number; avg_messages: number }>;
}> {
  const empty = {
    totals: { sessions: 0, submissions: 0, transcripts: 0, messages: 0 },
    byDay: [],
    byVignette: [],
  };

  if (dbType === 'sqlite' && db) {
    const totals = db.prepare(`
      SELECT COUNT(*) as sessions,
             SUM(form_submitted) as submissions,
             SUM(transcript_saved) as transcripts,
             SUM(message_count) as messages
      FROM session_log
      WHERE project = ? AND started_at >= datetime('now', '-' || ? || ' days')
    `).get(project, days) as any;

    const byDay = db.prepare(`
      SELECT date(started_at) as day,
             COUNT(*) as sessions,
             SUM(form_submitted) as submissions,
             SUM(message_count) as messages
      FROM session_log
      WHERE project = ? AND started_at >= datetime('now', '-' || ? || ' days')
      GROUP BY date(started_at) ORDER BY day DESC
    `).all(project, days) as any[];

    const byVignette = db.prepare(`
      SELECT vignette_key,
             COUNT(*) as sessions,
             SUM(form_submitted) as submissions,
             ROUND(AVG(message_count), 1) as avg_messages
      FROM session_log
      WHERE project = ? AND started_at >= datetime('now', '-' || ? || ' days') AND vignette_key IS NOT NULL
      GROUP BY vignette_key ORDER BY sessions DESC
    `).all(project, days) as any[];

    return {
      totals: {
        sessions: totals?.sessions || 0,
        submissions: Number(totals?.submissions) || 0,
        transcripts: Number(totals?.transcripts) || 0,
        messages: Number(totals?.messages) || 0,
      },
      byDay,
      byVignette,
    };
  } else if (dbType === 'postgres' && pgPool) {
    const totalsRes = await pgPool.query(`
      SELECT COUNT(*)::int as sessions,
             SUM(form_submitted)::int as submissions,
             SUM(transcript_saved)::int as transcripts,
             SUM(message_count)::int as messages
      FROM session_log
      WHERE project = $1 AND started_at >= NOW() - ($2 || ' days')::interval
    `, [project, days]);

    const byDayRes = await pgPool.query(`
      SELECT TO_CHAR(started_at, 'YYYY-MM-DD') as day,
             COUNT(*)::int as sessions,
             SUM(form_submitted)::int as submissions,
             SUM(message_count)::int as messages
      FROM session_log
      WHERE project = $1 AND started_at >= NOW() - ($2 || ' days')::interval
      GROUP BY TO_CHAR(started_at, 'YYYY-MM-DD') ORDER BY day DESC
    `, [project, days]);

    const byVignetteRes = await pgPool.query(`
      SELECT vignette_key,
             COUNT(*)::int as sessions,
             SUM(form_submitted)::int as submissions,
             ROUND(AVG(message_count), 1) as avg_messages
      FROM session_log
      WHERE project = $1 AND started_at >= NOW() - ($2 || ' days')::interval AND vignette_key IS NOT NULL
      GROUP BY vignette_key ORDER BY sessions DESC
    `, [project, days]);

    const t = totalsRes.rows[0];
    return {
      totals: {
        sessions: t?.sessions || 0,
        submissions: t?.submissions || 0,
        transcripts: t?.transcripts || 0,
        messages: t?.messages || 0,
      },
      byDay: byDayRes.rows,
      byVignette: byVignetteRes.rows,
    };
  }

  return empty;
}

// ── Project Settings (global, not project-scoped) ──────────────────────

export async function getProjectSetting(slug: string, key: string): Promise<string | null> {
  if (dbType === 'sqlite' && db) {
    const row = db.prepare('SELECT setting_value FROM project_settings WHERE project_slug = ? AND setting_key = ?')
      .get(slug, key) as { setting_value: string } | undefined;
    return row?.setting_value || null;
  } else if (dbType === 'postgres' && pgPool) {
    const result = await pgPool.query(
      'SELECT setting_value FROM project_settings WHERE project_slug = $1 AND setting_key = $2',
      [slug, key]
    );
    return result.rows[0]?.setting_value || null;
  }
  return null;
}

export async function setProjectSetting(slug: string, key: string, value: string): Promise<void> {
  if (dbType === 'sqlite' && db) {
    db.prepare(`
      INSERT INTO project_settings (project_slug, setting_key, setting_value, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(project_slug, setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = datetime('now')
    `).run(slug, key, value);
  } else if (dbType === 'postgres' && pgPool) {
    await pgPool.query(`
      INSERT INTO project_settings (project_slug, setting_key, setting_value, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT(project_slug, setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()
    `, [slug, key, value]);
  }
}

/**
 * Per-project public-chat kill switch. Stored as project setting `public_chat`
 * ('on' | 'off'). Unset means OFF: a project that opts in with `talkManifest`
 * stays dark until someone switches it on from the global admin page.
 */
export async function isPublicChatEnabled(slug: string): Promise<boolean> {
  return (await getProjectSetting(slug, 'public_chat')) === 'on';
}

export async function deleteProjectSetting(slug: string, key: string): Promise<void> {
  if (dbType === 'sqlite' && db) {
    db.prepare('DELETE FROM project_settings WHERE project_slug = ? AND setting_key = ?')
      .run(slug, key);
  } else if (dbType === 'postgres' && pgPool) {
    await pgPool.query(
      'DELETE FROM project_settings WHERE project_slug = $1 AND setting_key = $2',
      [slug, key]
    );
  }
}

export async function getAllProjectSettings(key: string): Promise<Array<{ project_slug: string; setting_value: string }>> {
  if (dbType === 'sqlite' && db) {
    return db.prepare('SELECT project_slug, setting_value FROM project_settings WHERE setting_key = ?')
      .all(key) as Array<{ project_slug: string; setting_value: string }>;
  } else if (dbType === 'postgres' && pgPool) {
    const result = await pgPool.query(
      'SELECT project_slug, setting_value FROM project_settings WHERE setting_key = $1',
      [key]
    );
    return result.rows;
  }
  return [];
}

/** The chat pipeline's view of the database (ChatStore in @ai-med/chat-core). */
export const engineStore: ChatStore = {
  getSystemPrompt,
  getLanguages,
  async getDocument(key) {
    const vignette = (await getAllVignettes()).find(v => v.key === key);
    return vignette ? { key: vignette.key, content: vignette.content } : null;
  },
  logTokenUsage,
  logQaTurn,
  logSessionMessage,
};
