/**
 * The database connection and the multi-project tenancy context.
 *
 * One connection (SQLite in dev, a Postgres pool in production) and one
 * AsyncLocalStorage tenancy context serve the engine (engine-store.ts) and the
 * simulator (sim-store.ts) alike, and the DDL for the shared tables lives here:
 * `<prefix>admin_content` holds both apps' rows. The stores own the queries;
 * this module owns the handles, the table names and the schema.
 */
import Database from 'better-sqlite3';
import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';

const { Pool } = pg;

const DEFAULT_ADMIN_TABLE = 'admin_content';
const DEFAULT_ASSIGNMENTS_TABLE = 'vignette_assignments';

// Database connection singleton
// Exported as live bindings for the stores in this directory, which only read
// them. Code outside db/ uses getDbHandles().
export let db: Database.Database | null = null;
export let pgPool: pg.Pool | null = null;
export let dbType: 'sqlite' | 'postgres' | null = null;
let tableName: string = DEFAULT_ADMIN_TABLE; // Default table name (from TABLE_PREFIX env var)
let assignmentsTableName: string = DEFAULT_ASSIGNMENTS_TABLE; // Default assignments table name

// Multi-tenant support: per-request table name overrides via AsyncLocalStorage
interface ProjectContext {
  admin: string;
  assignments: string;
  prefix: string;
}
const projectStore = new AsyncLocalStorage<ProjectContext>();

// Getters that check per-request context first, then fall back to startup defaults
export function activeAdminTable(): string {
  return projectStore.getStore()?.admin ?? tableName;
}

export function activeAssignmentsTable(): string {
  return projectStore.getStore()?.assignments ?? assignmentsTableName;
}

// Get the active project prefix (empty string if using default)
export function activeProjectPrefix(): string {
  return projectStore.getStore()?.prefix ?? sanitizeTablePrefix(process.env.TABLE_PREFIX);
}

// Run a function within a specific project context (sets table names for the duration)
export function runWithProject<T>(prefix: string, fn: () => T): T {
  const sanitized = sanitizeTablePrefix(prefix);
  const ctx: ProjectContext = {
    admin: sanitized ? `${sanitized}${DEFAULT_ADMIN_TABLE}` : DEFAULT_ADMIN_TABLE,
    assignments: sanitized ? `${sanitized}${DEFAULT_ASSIGNMENTS_TABLE}` : DEFAULT_ASSIGNMENTS_TABLE,
    prefix: sanitized,
  };
  return projectStore.run(ctx, fn);
}

/** Create the active project's tables (run inside runWithProject). */
export async function createProjectSchema(): Promise<void> {
  if (dbType === 'sqlite') {
    initSqliteSchema();
  } else if (dbType === 'postgres') {
    await initPostgresSchema();
  }
}

/**
 * Open the connection DATABASE_URL names and create the startup project's
 * tables. Seeding is not done here: it writes both owners' rows, so it lives
 * above both stores, in init.ts (initDatabase).
 */
export async function connectDatabase(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL || 'sqlite://./local-dev.db';
  const tableNames = getTableNamesFromEnv();
  tableName = tableNames.admin;
  assignmentsTableName = tableNames.assignments;
  console.log('🔌 Attempting database connection...');
  console.log('📊 Database type:', dbUrl.startsWith('postgres') ? 'PostgreSQL' : 'SQLite');
  console.log('📋 Admin table name:', tableName);
  console.log('📋 Assignments table name:', assignmentsTableName);
  if (tableNames.prefix) {
    console.log('🏷️  TABLE_PREFIX:', tableNames.prefix);
  }
  
  if (dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://')) {
    // PostgreSQL (Production - Digital Ocean)
    console.log('🐘 Initializing PostgreSQL connection...');
    dbType = 'postgres';
    
    // Note: Digital Ocean provides ?sslmode=require in DATABASE_URL
    // The sslmode parameter in the connection string can conflict with our SSL config
    // So we remove it and handle SSL ourselves
    const cleanUrl = dbUrl.replace(/[?&]sslmode=\w+/, '');
    
    pgPool = new Pool({
      connectionString: cleanUrl,
      ssl: {
        rejectUnauthorized: false  // Accept Digital Ocean's self-signed certificates
      },
    });
    console.log('✅ PostgreSQL pool created');
    
    console.log('📋 Creating database schema...');
    await initPostgresSchema();
    console.log('✅ Schema ready');
  } else {
    // SQLite connection
    console.log('📁 Initializing SQLite connection...');
    dbType = 'sqlite';
    const dbPath = dbUrl.replace('sqlite://', '');
    db = new Database(dbPath);
    console.log('✅ SQLite database initialized at', dbPath);
    
    initSqliteSchema();
  }
}

function initSqliteSchema() {
  if (!db) throw new Error('SQLite not initialized');

  const tableName = activeAdminTable();
  console.log(`[DEBUG] initSqliteSchema creating table: ${tableName}`);

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${tableName} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_type TEXT NOT NULL CHECK(content_type IN ('system_prompt', 'vignette', 'kobo_form_url', 'kobo_form_uid', 'languages', 'case_template')),
      vignette_key TEXT,
      content TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK((content_type = 'system_prompt' AND vignette_key IS NULL) OR (content_type = 'vignette' AND vignette_key IS NOT NULL) OR (content_type = 'kobo_form_url' AND vignette_key IS NULL) OR (content_type = 'kobo_form_uid' AND vignette_key IS NULL) OR (content_type = 'languages' AND vignette_key IS NULL) OR (content_type = 'case_template' AND vignette_key IS NULL)),
      UNIQUE(vignette_key)
    );
  `);
    console.log(`[DEBUG] Table ${tableName} created successfully`);
  } catch (error) {
    console.error(`[ERROR] Failed to create table ${tableName}:`, error);
    throw error;
  }

  // Migration: Add sort_order column if it doesn't exist (for existing databases)
  try {
    db.exec(`ALTER TABLE ${activeAdminTable()} ADD COLUMN sort_order INTEGER DEFAULT 0`);
    console.log('  ✅ Added sort_order column to SQLite');
  } catch (e: any) {
    // Column already exists - this is fine
    if (!e.message?.includes('duplicate column')) {
      throw e;
    }
  }
  
  // Backfill sort_order for existing vignettes based on id (insertion order)
  db.exec(`
    UPDATE ${activeAdminTable()}
    SET sort_order = id
    WHERE content_type = 'vignette' AND (sort_order IS NULL OR sort_order = 0)
  `);

  // Migration: Rebuild table if CHECK constraint is missing newer content types
  try {
    const meta = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(tableName) as { sql: string } | undefined;
    if (meta && !meta.sql.includes('case_template')) {
      console.log('  🔄 Migrating SQLite schema to add case_template support...');
      db.exec(`ALTER TABLE ${activeAdminTable()} RENAME TO ${activeAdminTable()}_old`);
      db.exec(`
        CREATE TABLE ${activeAdminTable()} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content_type TEXT NOT NULL CHECK(content_type IN ('system_prompt', 'vignette', 'kobo_form_url', 'kobo_form_uid', 'languages', 'case_template')),
          vignette_key TEXT,
          content TEXT NOT NULL,
          sort_order INTEGER DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          CHECK((content_type = 'system_prompt' AND vignette_key IS NULL) OR (content_type = 'vignette' AND vignette_key IS NOT NULL) OR (content_type = 'kobo_form_url' AND vignette_key IS NULL) OR (content_type = 'kobo_form_uid' AND vignette_key IS NULL) OR (content_type = 'languages' AND vignette_key IS NULL) OR (content_type = 'case_template' AND vignette_key IS NULL)),
          UNIQUE(vignette_key)
        )
      `);
      db.exec(`INSERT INTO ${activeAdminTable()} SELECT * FROM ${activeAdminTable()}_old`);
      db.exec(`DROP TABLE ${activeAdminTable()}_old`);
      console.log('  ✅ SQLite schema migrated');
    }
  } catch (e: any) {
    console.error('  ⚠️ SQLite migration warning:', e.message);
  }

  // Create vignette_assignments table for user-specific vignette assignments
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${activeAssignmentsTable()} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT NOT NULL,
      vignette_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(uid, vignette_id)
    );
  `);

  // Create global token_usage table (NOT project-scoped)
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL DEFAULT '',
      endpoint TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Create global session_log table (NOT project-scoped)
  // Tracks student engagement: one row per chat session, updated as the session progresses
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      session_token TEXT NOT NULL,
      vignette_key TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      form_submitted INTEGER NOT NULL DEFAULT 0,
      transcript_saved INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project, session_token)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_log_project_started ON session_log(project, started_at);`);

  // Global qa_log table (NOT project-scoped) — durable record of each chat turn for
  // projects that opt in via `logConversations` in project.json (formless Q&A advisors
  // like haivn_eip, whose welcome consent states questions and answers are logged).
  // Form-based IRB studies do NOT opt in; their transcripts live in Kobo as before.
  db.exec(`
    CREATE TABLE IF NOT EXISTS qa_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      session_token TEXT,
      vignette_key TEXT,
      language TEXT,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_qa_log_project_created ON qa_log(project, created_at);`);

  // Create global project_settings table (NOT project-scoped)
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_slug TEXT NOT NULL,
      setting_key TEXT NOT NULL,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_slug, setting_key)
    );
  `);
}

async function initPostgresSchema() {
  if (!pgPool) throw new Error('PostgreSQL not initialized');
  
  const client = await pgPool.connect();
  try {
    // Create table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${activeAdminTable()} (
        id SERIAL PRIMARY KEY,
        content_type VARCHAR(20) NOT NULL CHECK(content_type IN ('system_prompt', 'vignette', 'kobo_form_url', 'kobo_form_uid', 'languages', 'case_template')),
        vignette_key VARCHAR(100),
        content TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        CHECK((content_type = 'system_prompt' AND vignette_key IS NULL) OR (content_type = 'vignette' AND vignette_key IS NOT NULL) OR (content_type = 'kobo_form_url' AND vignette_key IS NULL) OR (content_type = 'kobo_form_uid' AND vignette_key IS NULL) OR (content_type = 'languages' AND vignette_key IS NULL) OR (content_type = 'case_template' AND vignette_key IS NULL)),
        UNIQUE(vignette_key)
      );
    `);

    // Migration: Add sort_order column if it doesn't exist (for existing databases)
    try {
      await client.query(`ALTER TABLE ${activeAdminTable()} ADD COLUMN sort_order INTEGER DEFAULT 0`);
      console.log('  ✅ Added sort_order column to PostgreSQL');
    } catch (e: any) {
      // Column already exists (error code 42701) - this is fine
      if (e?.code !== '42701') {
        throw e;
      }
    }

    // Backfill sort_order for existing vignettes based on id (insertion order)
    await client.query(`
      UPDATE ${activeAdminTable()}
      SET sort_order = id
      WHERE content_type = 'vignette' AND (sort_order IS NULL OR sort_order = 0)
    `);

    // Migrate existing constraints to support 'kobo_form_uid' and 'languages' types
    // Idempotent and targeted: only touches old constraints that are missing newer types
    console.log('🔄 Checking if database schema needs migration...');
    const tableRegClass = `public.${activeAdminTable()}`;
    const existingChecks = await client.query(
      `
      SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      WHERE c.conrelid = to_regclass($1)
        AND c.contype = 'c'
      `,
      [tableRegClass]
    );

    // Drop constraints that reference content_type but are missing newer types
    for (const row of existingChecks.rows as Array<{ name: string; def: string }>) {
      const name = row.name;
      const def = (row.def || '').toLowerCase();
      const mentionsContentType = def.includes('content_type');
      const mentionsCaseTemplate = def.includes("'case_template'");
      const isTypeListOrEquals =
        def.includes(' in (') || def.includes('=') || def.includes(' = ');
      const mentionsVignetteKey = def.includes('vignette_key');

      // Identify old constraints missing case_template support
      const isOldTypeRestriction =
        mentionsContentType && isTypeListOrEquals && !mentionsCaseTemplate;
      const isOldConsistency =
        mentionsContentType && mentionsVignetteKey && !mentionsCaseTemplate;

      if (isOldTypeRestriction || isOldConsistency) {
        await client.query(`ALTER TABLE ${activeAdminTable()} DROP CONSTRAINT "${name}";`);
        console.log(`  🗑️  Dropped outdated constraint: ${name} (${row.def})`);
      }
    }

    // Add/ensure updated constraints (ignore duplicates)
    try {
      await client.query(`
        ALTER TABLE ${activeAdminTable()}
        ADD CONSTRAINT ${activeAdminTable()}_content_type_check
        CHECK (content_type IN ('system_prompt', 'vignette', 'kobo_form_url', 'kobo_form_uid', 'languages', 'case_template'))
      `);
      console.log(`  ✅ Added constraint: ${activeAdminTable()}_content_type_check`);
    } catch (e: any) {
      if (e?.code === '42710') {
        console.log(`  ↩️ Constraint already exists: ${activeAdminTable()}_content_type_check`);
      } else {
        throw e;
      }
    }

    try {
      await client.query(`
        ALTER TABLE ${activeAdminTable()}
        ADD CONSTRAINT ${activeAdminTable()}_consistency_check
        CHECK (
          (content_type = 'system_prompt' AND vignette_key IS NULL) OR
          (content_type = 'vignette' AND vignette_key IS NOT NULL) OR
          (content_type = 'kobo_form_url' AND vignette_key IS NULL) OR
          (content_type = 'kobo_form_uid' AND vignette_key IS NULL) OR
          (content_type = 'languages' AND vignette_key IS NULL) OR
          (content_type = 'case_template' AND vignette_key IS NULL)
        )
      `);
      console.log(`  ✅ Added constraint: ${activeAdminTable()}_consistency_check`);
    } catch (e: any) {
      if (e?.code === '42710') {
        console.log(`  ↩️ Constraint already exists: ${activeAdminTable()}_consistency_check`);
      } else {
        throw e;
      }
    }
    
    console.log('✅ Database schema migration check complete');
    
    // Create vignette_assignments table for user-specific vignette assignments
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${activeAssignmentsTable()} (
        id SERIAL PRIMARY KEY,
        uid VARCHAR(255) NOT NULL,
        vignette_id INTEGER NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(uid, vignette_id)
      );
    `);
    console.log('✅ Vignette assignments table ready');

    // Create global token_usage table (NOT project-scoped)
    await client.query(`
      CREATE TABLE IF NOT EXISTS token_usage (
        id SERIAL PRIMARY KEY,
        project TEXT NOT NULL DEFAULT '',
        endpoint TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Create global session_log table (NOT project-scoped)
    await client.query(`
      CREATE TABLE IF NOT EXISTS session_log (
        id SERIAL PRIMARY KEY,
        project TEXT NOT NULL,
        session_token TEXT NOT NULL,
        vignette_key TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        form_submitted INTEGER NOT NULL DEFAULT 0,
        transcript_saved INTEGER NOT NULL DEFAULT 0,
        started_at TIMESTAMP NOT NULL DEFAULT NOW(),
        last_activity_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(project, session_token)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_session_log_project_started ON session_log(project, started_at);`);

    // Global qa_log table — durable record of each chat turn for projects that opt in
    // via `logConversations` (formless Q&A advisors like haivn_eip). See the SQLite
    // block above for the rationale; form-based IRB studies keep their Kobo-only flow.
    await client.query(`
      CREATE TABLE IF NOT EXISTS qa_log (
        id SERIAL PRIMARY KEY,
        project TEXT NOT NULL,
        session_token TEXT,
        vignette_key TEXT,
        language TEXT,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_qa_log_project_created ON qa_log(project, created_at);`);

    // Create global project_settings table (NOT project-scoped)
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_settings (
        id SERIAL PRIMARY KEY,
        project_slug TEXT NOT NULL,
        setting_key TEXT NOT NULL,
        setting_value TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(project_slug, setting_key)
      );
    `);
  } finally {
    client.release();
  }
}

// Get current table name (for debugging) - respects per-request project context
export function getTableName(): string {
  return activeAdminTable();
}

export function getAssignmentsTableName(): string {
  return activeAssignmentsTable();
}

export function sanitizeTablePrefix(rawPrefix: string | undefined | null): string {
  const trimmed = rawPrefix?.trim() ?? '';
  if (!trimmed) {
    return '';
  }

  if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
    throw new Error('TABLE_PREFIX may only include letters, numbers, or underscores.');
  }

  return trimmed.endsWith('_') ? trimmed : `${trimmed}_`;
}

function getTableNamesFromEnv(): { prefix: string; admin: string; assignments: string } {
  const prefix = sanitizeTablePrefix(process.env.TABLE_PREFIX);
  return {
    prefix,
    admin: prefix ? `${prefix}${DEFAULT_ADMIN_TABLE}` : DEFAULT_ADMIN_TABLE,
    assignments: prefix ? `${prefix}${DEFAULT_ASSIGNMENTS_TABLE}` : DEFAULT_ASSIGNMENTS_TABLE,
  };
}

/**
 * Raw handles for feature modules that own their own global tables.
 *
 * Most tables are project-scoped content, keyed by the AsyncLocalStorage
 * prefix. A few tables are deliberately global instead (`qa_log`, and the
 * `dspverify_*` pair in npj26.ts): they belong to one study, not to a project,
 * and no X-Project header ever reaches their routes. Rather than copy the
 * sqlite/postgres branch into every such module -- two implementations of one
 * job -- they take the handles from here and branch once, in one place.
 */
export function getDbHandles(): {
  dbType: 'sqlite' | 'postgres' | null;
  sqlite: Database.Database | null;
  pg: pg.Pool | null;
} {
  return { dbType, sqlite: db, pg: pgPool };
}

// Close database connections
export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
  if (pgPool) {
    pgPool.end();
    pgPool = null;
  }
}
