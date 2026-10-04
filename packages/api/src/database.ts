/**
 * The API's database, split by owner (db/):
 * - db/connection.ts: the connection, the tenancy context, table names, DDL;
 * - db/engine-store.ts: the engine's documents and ledgers, and `engineStore`;
 * - db/sim-store.ts: the simulator's assignments, Kobo form and case template;
 * - db/init.ts: startup, per-project table creation and seeding.
 * Import sites keep importing from here.
 */
export {
  sanitizeTablePrefix,
  runWithProject,
  activeProjectPrefix,
  getTableName,
  getAssignmentsTableName,
  getDbHandles,
  closeDatabase,
} from './db/connection.js';
export * from './db/engine-store.js';
export * from './db/sim-store.js';
export * from './db/init.js';
