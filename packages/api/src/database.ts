import Database from 'better-sqlite3';
import pg from 'pg';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { AsyncLocalStorage } from 'node:async_hooks';

const { Pool } = pg;

// Repo root (3 levels up from packages/api/src/)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database interface for our admin content
export interface AdminContent {
  id?: number;
  content_type: 'system_prompt' | 'vignette' | 'kobo_form_url' | 'kobo_form_uid' | 'languages' | 'case_template';
  vignette_key?: string | null;
  content: string;
  created_at?: string;
  updated_at?: string;
}

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

const DEFAULT_ADMIN_TABLE = 'admin_content';
const DEFAULT_ASSIGNMENTS_TABLE = 'vignette_assignments';

export class MissingVignetteKeysError extends Error {
  missingKeys: string[];

  constructor(missingKeys: string[]) {
    super(`Missing vignette keys: ${missingKeys.join(', ')}`);
    this.name = 'MissingVignetteKeysError';
    this.missingKeys = missingKeys;
  }
}

// Database connection singleton
let db: Database.Database | null = null;
let pgPool: pg.Pool | null = null;
let dbType: 'sqlite' | 'postgres' | null = null;
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
function activeAdminTable(): string {
  return projectStore.getStore()?.admin ?? tableName;
}

function activeAssignmentsTable(): string {
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

// Ensure database tables exist for a given project prefix (creates if needed)
const initializedPrefixes = new Set<string>();

export async function ensureProjectTables(prefix: string): Promise<void> {
  const sanitized = sanitizeTablePrefix(prefix);
  if (initializedPrefixes.has(sanitized)) return; // already initialized

  // Run schema creation within the project context so activeAdminTable/activeAssignmentsTable resolve correctly
  await runWithProject(prefix, async () => {
    if (dbType === 'sqlite') {
      initSqliteSchema();
    } else if (dbType === 'postgres') {
      await initPostgresSchema();
    }
    initializedPrefixes.add(sanitized);
    console.log(`✅ Ensured tables for project prefix: ${sanitized || '(default)'}`);
    await seedProjectFromFilesIfEmpty(sanitized.replace(/_+$/, ''));
  });
}

/**
 * Seed a project's tables from `projects/<slug>/` the first time that project is
 * used, if and only if they are empty.
 *
 * Why this exists: project content (system prompt, vignettes, languages, Kobo
 * config) is read at request time from the per-project admin_content table, but
 * ensureProjectTables only ever created that table empty. The only writer was
 * tools/push-content.ts. So a fresh clone running the documented quick start got
 * a blank welcome screen and a chat that could never start, with no error to
 * explain it -- the content was simply not there.
 *
 * This reads the same files push-content.ts pushes, from the same paths declared
 * in project.json, so the two paths share one source of truth on disk. It runs
 * only when the project has no content of its own, so an existing deployment,
 * or any project whose content was pushed through the admin API, is untouched.
 */
async function seedProjectFromFilesIfEmpty(slug: string): Promise<void> {
  if (!slug) return;

  try {
    const [existingPrompt, existingVignettes, existingLanguages] = await Promise.all([
      getSystemPrompt(),
      getCustomVignettes(),
      getLanguages(),
    ]);

    // Any content at all means this project is managed elsewhere. Leave it alone.
    if (existingPrompt || existingVignettes.length > 0) return;

    const repoRoot = path.resolve(__dirname, '../../..');
    const projectDir = path.join(repoRoot, 'projects', slug);

    let config: Record<string, any>;
    try {
      config = JSON.parse(await fs.readFile(path.join(projectDir, 'project.json'), 'utf8'));
    } catch {
      // No such project on disk. Valid: content may be pushed via push-content.ts.
      return;
    }

    console.log(`🌱 Seeding project "${slug}" from projects/${slug}/ ...`);

    const promptPath = config?.cases?.systemPrompt;
    if (typeof promptPath === 'string' && promptPath) {
      await saveSystemPrompt(await fs.readFile(path.resolve(repoRoot, promptPath), 'utf8'));
      console.log('  ✓ System prompt seeded');
    }

    const vignettes = Array.isArray(config?.cases?.vignettes) ? config.cases.vignettes : [];
    let sortOrder = 0;
    for (const vignette of vignettes) {
      if (!vignette?.key || !vignette?.file) continue;
      const content = await fs.readFile(path.resolve(repoRoot, vignette.file), 'utf8');
      await saveVignette(vignette.key, content, sortOrder++);
      console.log(`  ✓ Vignette "${vignette.key}" seeded`);
    }

    if (!existingLanguages) {
      try {
        await saveLanguages(await fs.readFile(path.join(projectDir, 'languages.json'), 'utf8'));
        console.log('  ✓ Languages seeded');
      } catch {
        console.log('  ℹ No languages.json for this project, skipping');
      }
    }

    if (typeof config?.kobo?.formUrl === 'string' && config.kobo.formUrl) {
      await saveKoboFormUrl(config.kobo.formUrl);
    }
    if (typeof config?.kobo?.formUid === 'string' && config.kobo.formUid) {
      await saveKoboFormUid(config.kobo.formUid);
    }

    console.log(`✅ Project "${slug}" seeded from disk`);
  } catch (error) {
    console.error(`⚠️ Could not seed project "${slug}" from disk:`, error);
    // Don't throw - the app must still start, and content can be pushed later.
  }
}

/**
 * Initialize database connection and seed with defaults if empty.
 * 
 * Behavior:
 * - If database is empty: seeds from vignettes.json
 * - If database has content: uses existing (no overwrite)
 * - This ensures content persists across deployments
 */
export async function initDatabase() {
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
    
    console.log('🌱 Checking if seeding is needed...');
    await seedDefaultsIfNeeded();
  } else {
    // SQLite connection
    console.log('📁 Initializing SQLite connection...');
    dbType = 'sqlite';
    const dbPath = dbUrl.replace('sqlite://', '');
    db = new Database(dbPath);
    console.log('✅ SQLite database initialized at', dbPath);
    
    initSqliteSchema();
    await seedDefaultsIfNeeded();
  }

  // Mark the startup prefix as initialized so ensureProjectTables skips it
  const startupPrefix = sanitizeTablePrefix(process.env.TABLE_PREFIX);
  initializedPrefixes.add(startupPrefix);
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
      harvard_credits_used REAL,
      harvard_credits_remaining REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migration: add Harvard credit columns if missing
  try { db.exec('ALTER TABLE token_usage ADD COLUMN harvard_credits_used REAL'); } catch (_) { /* already exists */ }
  try { db.exec('ALTER TABLE token_usage ADD COLUMN harvard_credits_remaining REAL'); } catch (_) { /* already exists */ }

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
        harvard_credits_used DOUBLE PRECISION,
        harvard_credits_remaining DOUBLE PRECISION,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Migration: add Harvard credit columns if missing
    try { await client.query('ALTER TABLE token_usage ADD COLUMN harvard_credits_used DOUBLE PRECISION'); } catch (_) { /* already exists */ }
    try { await client.query('ALTER TABLE token_usage ADD COLUMN harvard_credits_remaining DOUBLE PRECISION'); } catch (_) { /* already exists */ }

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

// Seed database with defaults from vignettes.json if empty
async function seedDefaultsIfNeeded() {
  try {
    // Check what content exists
    const existingVignettes = await getCustomVignettes();
    const existingSystemPrompt = await getSystemPrompt();
    const existingKoboUrl = await getKoboFormUrl();
    const existingLanguages = await getLanguages();
    
    // Track if we're seeding anything
    let didSeed = false;
    
    // Seed system prompt and vignettes only if database is completely empty
    if (existingVignettes.length === 0 && !existingSystemPrompt && !existingKoboUrl) {
      console.log('🌱 Seeding database with defaults from vignettes.json...');
      
      // Load defaults from vignettes.json
      const vignettesPath = path.resolve(__dirname, '../defaults/vignettes.json');
      const raw = await fs.readFile(vignettesPath, 'utf8');
      const defaultData = JSON.parse(raw);
      
      // Save default system prompt
      if (defaultData.system_prompt) {
        await saveSystemPrompt(defaultData.system_prompt);
        console.log('  ✓ System prompt seeded');
      }
      
      // Save default vignettes
      if (defaultData.vignettes) {
        const vignetteKeys = Object.keys(defaultData.vignettes);
        for (const key of vignetteKeys) {
          const vignette = defaultData.vignettes[key];
          if (vignette.case_scenario) {
            await saveVignette(key, vignette.case_scenario);
            console.log(`  ✓ Vignette "${key}" seeded`);
          }
        }
      }
      
      // No default Kobo form URL. Seeding one would point every fresh
      // deployment at somebody else's form, so leave it unset and let the
      // deployment supply its own.
      console.log('  ℹ No Kobo form URL seeded — set one in the admin dashboard');
      console.log('    or declare kobo.formUrl in your project.json.');
      
      didSeed = true;
    }
    
    // Always seed languages if they don't exist (even if other content exists)
    // This allows adding languages support to existing deployments
    if (!existingLanguages) {
      console.log('🌱 Seeding languages configuration from template...');
      try {
        const languagesTemplatePath = path.resolve(__dirname, '../defaults/languages.template.json');
        const languagesRaw = await fs.readFile(languagesTemplatePath, 'utf8');
        await saveLanguages(languagesRaw);
        console.log('  ✓ Languages configuration seeded');
        didSeed = true;
      } catch (error) {
        console.error('  ⚠️ Could not seed languages configuration:', error);
      }
    }
    
    if (didSeed) {
      console.log('✅ Database seeding complete');
    } else {
      console.log('📋 Database already has all content, no seeding needed');
    }
  } catch (error) {
    console.error('Error seeding database:', error);
    // Don't throw - allow app to start even if seeding fails
  }
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

// Log a single token usage entry
export async function logTokenUsage(entry: {
  project: string;
  endpoint: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  estimated_cost: number;
  harvard_credits_used?: number | null;
  harvard_credits_remaining?: number | null;
}): Promise<void> {
  try {
    if (dbType === 'sqlite' && db) {
      db.prepare(
        'INSERT INTO token_usage (project, endpoint, model, prompt_tokens, completion_tokens, estimated_cost, harvard_credits_used, harvard_credits_remaining) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(entry.project, entry.endpoint, entry.model, entry.prompt_tokens, entry.completion_tokens, entry.estimated_cost, entry.harvard_credits_used ?? null, entry.harvard_credits_remaining ?? null);
    } else if (dbType === 'postgres' && pgPool) {
      await pgPool.query(
        'INSERT INTO token_usage (project, endpoint, model, prompt_tokens, completion_tokens, estimated_cost, harvard_credits_used, harvard_credits_remaining) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [entry.project, entry.endpoint, entry.model, entry.prompt_tokens, entry.completion_tokens, entry.estimated_cost, entry.harvard_credits_used ?? null, entry.harvard_credits_remaining ?? null]
      );
    }
  } catch (error) {
    console.error('Failed to log token usage:', error);
  }
}

// Get the most recent Harvard credit balance
export async function getHarvardCreditBalance(): Promise<{ credits_remaining: number | null; credits_used: number | null; last_updated: string | null }> {
  const empty = { credits_remaining: null, credits_used: null, last_updated: null };
  try {
    if (dbType === 'sqlite' && db) {
      const row = db.prepare(
        'SELECT harvard_credits_remaining as credits_remaining, harvard_credits_used as credits_used, created_at as last_updated FROM token_usage WHERE harvard_credits_remaining IS NOT NULL ORDER BY id DESC LIMIT 1'
      ).get() as any;
      return row || empty;
    } else if (dbType === 'postgres' && pgPool) {
      const res = await pgPool.query(
        'SELECT harvard_credits_remaining as credits_remaining, harvard_credits_used as credits_used, created_at::text as last_updated FROM token_usage WHERE harvard_credits_remaining IS NOT NULL ORDER BY id DESC LIMIT 1'
      );
      return res.rows[0] || empty;
    }
  } catch (error) {
    console.error('Failed to get Harvard credit balance:', error);
  }
  return empty;
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
// `logConversations` in project.json. Read back by the admin Conversations view.

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

