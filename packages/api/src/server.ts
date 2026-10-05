import express from 'express';
import cors, { CorsOptions } from 'cors';
import dotenv from 'dotenv';
import { openaiClients, DirectKeyMissingError, OPENAI_DIRECT_URL, resolveProjectFlags, estimateCost, type ResolvedFlags } from '@ai-med/chat-core';
import path from 'path';
import fs from 'fs/promises';
import { readdirSync, readFileSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import {
  initDatabase,
  getSystemPrompt,
  saveSystemPrompt,
  getAllVignettes,
  saveVignette,
  deleteVignette,
  deleteVignetteById,
  updateVignetteById,
  swapVignetteOrder,
  getAllAdminContent,
  getKoboFormUrl,
  saveKoboFormUrl,
  getKoboFormUid,
  saveKoboFormUid,
  getLanguages,
  saveLanguages,
  getCaseTemplate,
  saveCaseTemplate,
  getTableName,
  getAssignmentsTableName,
  getVignetteAssignments,
  addVignetteAssignment,
  deleteVignetteAssignment,
  deleteVignetteAssignments,
  getVignettesForUid,
  getVignetteIdByKey,
  bulkAddVignetteAssignments,
  MissingVignetteKeysError,
  runWithProject,
  ensureProjectTables,
  activeProjectPrefix,
  sanitizeTablePrefix,
  logTokenUsage,
  getTokenUsageSummary,
  getProjectSetting,
  setProjectSetting,
  deleteProjectSetting,
  getAllProjectSettings,
  isPublicChatEnabled,
  logSessionFormSubmit,
  logSessionTranscriptSaved,
  getSessionStats,
  getQaLog,
  QA_LOG_MAX_LIMIT,
} from './database.js';
import {
  ensureNpj26Tables,
  getNpj26Progress,
  saveNpj26Response,
  npj26CellExists,
  loadNpj26Cells,
  exportNpj26Csv,
  TOKEN_RE as NPJ26_TOKEN_RE,
} from './npj26.js';
import { REPO_ROOT } from './repo-root.js';
import { talkRoutes } from './talk/routes.js';
import { chatRouter } from './routes/chat.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from repo root
dotenv.config({ path: path.join(REPO_ROOT, '.env') });

const app = express();
app.set('trust proxy', 1); // Trust first proxy (Railway) so rate limiters see real client IPs
const PORT = process.env.PORT || 3001;

// Load valid project slugs from projects/ directory at startup
// Used to reject unknown X-Project headers (prevents unbounded table creation).
// The checkout is REPO_ROOT (repo-root.ts), the same one every project file is
// read from, so the allowlist and the projects it admits always agree.
let validProjectSlugs: Set<string> = new Set();
try {
  const projectsDir = path.join(REPO_ROOT, 'projects');
  const entries = readdirSync(projectsDir, { withFileTypes: true });
  validProjectSlugs = new Set(
    entries.filter(e => e.isDirectory()).map(e => e.name)
  );
  console.log(`✅ Valid project slugs: ${[...validProjectSlugs].join(', ')}`);
} catch {
  console.warn('⚠️ Could not read projects/ directory for slug validation');
}

// OpenAI clients: built once, in openai-clients.ts, now that .env is loaded.
// A missing OPENAI_API_KEY throws here, at startup.
const { gateway: openai, direct: openaiDirect, realtimeKey: OPENAI_REALTIME_KEY } = openaiClients();

// Startup check for the features that must reach api.openai.com directly. TTS
// and direct billing use the direct client; realtime uses OPENAI_REALTIME_KEY or
// the direct key. The Harvard gateway cannot serve any of them (its credit-
// redemption proxy rejects TTS and realtime models, and realtime audio flows
// browser to OpenAI over WebRTC), so a missing direct key is reported here and
// those routes answer 503 rather than falling back to the gateway.
{
  const lacking: string[] = [];
  for (const slug of validProjectSlugs) {
    try {
      const flags = resolveProjectFlags(JSON.parse(readFileSync(path.join(REPO_ROOT, 'projects', slug, 'project.json'), 'utf-8')));
      if (flags.enableVoice && !openaiDirect) lacking.push(`${slug} (enableVoice: TTS)`);
      if (flags.enableRealtime && !OPENAI_REALTIME_KEY) lacking.push(`${slug} (enableRealtime)`);
    } catch { /* no project.json: nothing configured */ }
  }
  if (lacking.length > 0) {
    console.error(`❌ No direct OpenAI key (OPENAI_TTS_KEY) for features these projects enable; they will return 503: ${lacking.join(', ')}`);
  } else if (!openaiDirect) {
    console.warn('⚠️ No direct OpenAI key (OPENAI_TTS_KEY): TTS and payment_source "direct" are unavailable.');
  }
}
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2';
const OPENAI_REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || 'alloy';
// Client-enforced session cap (cost guardrail). The frontend auto-disconnects at
// this many seconds; override per-deployment via REALTIME_MAX_SESSION_SECONDS.
const REALTIME_MAX_SESSION_SECONDS = parseInt(process.env.REALTIME_MAX_SESSION_SECONDS || '600', 10);

// KoboToolbox base URL — override for self-hosted install. No trailing slash.
// All runtime Kobo calls (XForm fetch, submission search, bulk update, OpenRosa
// submission POST) go through this host.
const KOBO_KF_BASE = (process.env.KOBO_KF_BASE || 'https://kf.kobotoolbox.org').replace(/\/$/, '');

// JWT Configuration
// No fallback secret. A default here would let a misconfigured deployment sign
// admin tokens with a value that is public in this repo's history, so refuse to
// boot instead of starting in a state where every admin session is forgeable.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set.');
  console.error('It signs admin session tokens, so there is no safe default.');
  console.error('Generate one with:  openssl rand -base64 32');
  console.error('Then set JWT_SECRET in your environment (or .env) and restart.');
  process.exit(1);
}
const JWT_EXPIRY = '24h';
const COOKIE_NAME = 'admin_token';
const COOKIE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

// Middleware
// Strict CORS: only allow explicitly configured origins
const parseAllowedOrigins = (): string[] => {
  const raw = process.env.ALLOWED_ORIGINS || '';
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (process.env.NODE_ENV !== 'production') {
    // Local development defaults
    const devDefaults = ['http://localhost:3000', 'http://127.0.0.1:3000'];
    for (const origin of devDefaults) {
      if (!list.includes(origin)) list.push(origin);
    }
  }
  return list;
};

const normalizeOrigin = (origin: string): string => {
  try {
    const url = new URL(origin);
    // Normalize by removing any trailing slash
    return `${url.protocol}//${url.host}`;
  } catch {
    return origin.replace(/\/$/, '');
  }
};

const allowedOrigins = parseAllowedOrigins().map(normalizeOrigin);
if (allowedOrigins.length > 0) {
  console.log('🔒 CORS allowed origins:', allowedOrigins.join(', '));
} else {
  console.log('🔒 CORS enabled with no cross-origin whitelist (same-origin only)');
}

const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    // Allow requests without an Origin (non-browser or same-origin navigations)
    if (!origin) return callback(null, true);
    const normalized = normalizeOrigin(origin);
    const isAllowed = allowedOrigins.includes(normalized);
    return callback(null, isAllowed);
  },
  methods: ['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'OPTIONS'],
  // X-Access-Token must be listed or the browser's preflight rejects it and every
  // gated request fails cross-origin. Local dev cannot catch that: Vite proxies
  // /api from :3000 to :3001, so development never makes a cross-origin call.
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Project', 'X-Access-Token'],
  credentials: true, // Allow cookies to be sent with requests
  maxAge: 86400, // 24h preflight cache
};

// Document chat's routes (talk/routes.ts). The public talk manifest is the ONE
// route open to any origin, so its router is mounted here, before the global
// allowlisted CORS middleware below; the global policy is not widened.
const talk = talkRoutes({
  isValidProject: slug => validProjectSlugs.has(slug),
  readProjectConfig,
  requestProjectSlug,
});
app.use(talk.manifestRouter);
const { requirePublicChatIfDeclared } = talk;

// Apply CORS only to API-style routes
app.use('/api', cors(corsOptions));
app.options('/api/*', cors(corsOptions));
app.use('/t', cors(corsOptions));
app.options('/t/*', cors(corsOptions));
// npj26 review tool. Its page is served from GitHub Pages (ai-med.live) and
// calls this API cross-origin, so it needs the same allowlist the /api routes
// get -- it is deliberately NOT under /api, which would put it behind the
// X-Project middleware for tables that are global by design.
app.use('/npj26', cors(corsOptions));
app.options('/npj26/*', cors(corsOptions));

// /npj26/load carries 100 cells of full bilingual transcripts, well past the 100kb default;
// the route mounts its own parser, so the global one must skip it or it rejects first.
// Admin content writes get a larger limit than public routes: a vignette can be a
// whole paper (the papers project's longest are about 180 KB of text), and at the
// 100kb default push-content.ts got a 413 for every one of them.
const jsonBody = express.json();
const adminJsonBody = express.json({ limit: '5mb' });
app.use((req, res, next) => {
  if (req.path === '/npj26/load') return next();
  return (req.path.startsWith('/api/admin/') ? adminJsonBody : jsonBody)(req, res, next);
});
app.use(cookieParser());

// Multi-tenant project routing via X-Project header
// When a frontend sends X-Project: <slug>, all database operations use that project's table prefix
app.use('/api', (req, _res, next) => {
  const project = req.headers['x-project'];
  if (typeof project === 'string' && project.trim()) {
    try {
      const prefix = project.trim();
      // Validate the prefix (sanitizeTablePrefix will throw on invalid chars)
      sanitizeTablePrefix(prefix);
      // Reject unknown project slugs to prevent unbounded table creation
      const slug = prefix.replace(/_+$/, '');
      if (validProjectSlugs.size > 0 && !validProjectSlugs.has(slug)) {
        console.warn(`⚠️ Rejected unknown project slug: ${slug}`);
        return next(); // Fall through to default (no project-scoped tables created)
      }
      // Ensure tables exist for this project (lazy init, cached after first call)
      ensureProjectTables(prefix).then(() => {
        runWithProject(prefix, () => next());
      }).catch(next);
      return;
    } catch (err) {
      // Invalid prefix format - fall through to default
      console.warn(`⚠️ Invalid X-Project header: ${project}`);
    }
  }
  next();
});

// Rate limiting for chat endpoint - burst protection (1 request per second)
const chatBurstLimiter = rateLimit({
  windowMs: 1000,
  max: 1,
  message: { error: 'Too many messages. Please wait before sending another message' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting for chat endpoint - sustained protection (100 requests per 15 min)
const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting for TTS endpoint - 20 requests per minute per IP
// (protects direct OpenAI key from abuse while allowing normal student use)
const ttsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many TTS requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting for realtime session minting - 15 mints per 5 min per IP.
// This is the server-side cost guardrail: each mint can open a per-minute-billed
// audio session on a DIRECT key. Honest student use stays well under this; the
// cap bounds a single abuser. (Per-session cost is bounded separately by the
// client-side REALTIME_MAX_SESSION_SECONDS auto-disconnect.)
const realtimeLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 15,
  message: { error: 'Too many voice session requests, please wait a minute and try again' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting for login endpoint - 20 attempts per 15 min per IP
// (CI pushes content for each project with a separate login)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Initialize database (async - will complete before server starts)
try {
  await initDatabase();
  console.log('✅ Database initialization complete');
  await ensureNpj26Tables();
  console.log('✅ npj26 verification tables ready');
} catch (error) {
  console.error('❌ Database initialization failed:', error);
  console.error('App will continue but admin features will not work');
}

// Admin authentication middleware
const authenticateAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Try to get token from cookie first, then Authorization header
  let token: string | undefined;
  
  // Check cookie
  if (req.cookies && req.cookies[COOKIE_NAME]) {
    token = req.cookies[COOKIE_NAME];
  }
  
  // Fallback to Authorization header
  if (!token) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }
  }
  
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    // Verify JWT and check scope
    const payload = jwt.verify(token, JWT_SECRET) as { role?: string; scope?: string; project?: string };
    const scope = payload.scope ?? 'global'; // Backward compat: old tokens without scope are global

    if (scope === 'project' && payload.project) {
      // Project-scoped token: must match the current project context
      const currentProject = (activeProjectPrefix() || '').replace(/_+$/, '');
      if (payload.project !== currentProject) {
        return res.status(403).json({ error: 'Token not valid for this project' });
      }
    }

    // Attach scope info to request for downstream use
    (req as any).adminScope = scope;
    (req as any).adminProject = payload.project;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Require global admin scope (rejects project-scoped tokens)
const requireGlobalAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  // First run the standard admin auth
  authenticateAdmin(req, res, () => {
    const scope = (req as any).adminScope;
    if (scope !== 'global') {
      return res.status(403).json({ error: 'Global admin access required' });
    }
    next();
  });
};

// Require global admin for content writes (project-scoped admins are read-only except assignments)
const requireContentWrite = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const scope = (req as any).adminScope;
  if (scope === 'project') {
    return res.status(403).json({ error: 'Content editing requires global admin access' });
  }
  next();
};

// ── Course access gate ───────────────────────────────────────────────
//
// A project may set `requireAccessCode: true` in project.json. Every content and
// chat request for that project then needs a valid access token, which a visitor
// gets by entering a shared code once. This is a speed bump against a link
// escaping the class, not an authentication system: the code is shared among a
// cohort and one student can always pass it on. It exists so the deployment is
// not open to the whole internet, and so it is not a free LLM endpoint.
//
// The token travels in an `X-Access-Token` header, deliberately NOT in a cookie.
// The admin cookie is SameSite=strict, which a browser withholds from an iframe
// on another origin — and this project's whole delivery is an iframe inside
// Canvas. A header read from localStorage is the only thing that works there.

const ACCESS_TOKEN_EXPIRY = '30d';

const accessLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

const projectConfigCache = new Map<string, Record<string, any>>();

async function readProjectConfig(slug: string): Promise<Record<string, any>> {
  const cached = projectConfigCache.get(slug);
  if (cached) return cached;
  try {
    const raw = await fs.readFile(
      path.join(REPO_ROOT, 'projects', slug, 'project.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    projectConfigCache.set(slug, parsed);
    return parsed;
  } catch {
    return {};
  }
}

/** The project's flags, resolved by chat-core's resolveProjectFlags from its project.json. */
async function readProjectFlags(slug: string): Promise<ResolvedFlags> {
  return resolveProjectFlags(await readProjectConfig(slug));
}

function requestProjectSlug(req: express.Request): string {
  const header = req.headers['x-project'];
  const slug = typeof header === 'string' ? header.trim().replace(/_+$/, '') : '';
  return slug || (activeProjectPrefix() || '').replace(/_+$/, '') || 'demo';
}

/**
 * The configured code for a project: a project setting first (so it can be
 * rotated through the admin API without a redeploy), then an environment
 * variable. Returns null when neither is set, which leaves the project ungated.
 */
async function getAccessCode(slug: string): Promise<string | null> {
  try {
    const setting = await getProjectSetting(slug, 'access_code');
    if (setting && setting.trim()) return setting.trim();
  } catch { /* fall through to the environment */ }
  const envKey = `ACCESS_CODE_${slug.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const fromEnv = process.env[envKey];
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : null;
}

/**
 * Where a request stands against its project's access gate. The one place the
 * token is checked: the middleware below and every route that serves less to a
 * visitor without the code (see /api/languages) ask this.
 *   open          the project is not gated
 *   ok            gated, and the request holds a valid token for this project
 *   unconfigured  gated, but no code is configured (fail closed)
 *   missing       gated, no token or a token for something else
 *   expired       gated, a token that no longer verifies
 */
type AccessState = 'open' | 'ok' | 'unconfigured' | 'missing' | 'expired';

// An arrow, not a hoisted declaration: JWT_SECRET is narrowed to string by the
// boot check above only for closures created after it.
const accessState = async (req: express.Request): Promise<AccessState> => {
  const slug = requestProjectSlug(req);
  if (!(await readProjectFlags(slug)).requireAccessCode) return 'open';

  // A project that asks to be gated but has no code configured must FAIL CLOSED.
  // Falling through to "no code, so allow everyone" would silently publish it.
  const configured = await getAccessCode(slug);
  if (!configured) {
    console.error(`[access] ${slug} sets requireAccessCode but no code is configured; ` +
                  'denying every request. Set a project setting "access_code" or the ' +
                  `ACCESS_CODE_${slug.toUpperCase()} environment variable.`);
    return 'unconfigured';
  }

  const raw = req.headers['x-access-token'];
  const token = typeof raw === 'string' ? raw : '';
  if (!token) return 'missing';
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { role?: string; project?: string };
    return payload.role === 'course-access' && payload.project === slug ? 'ok' : 'missing';
  } catch {
    return 'expired';
  }
};

const requireAccessCode = async (req: express.Request, res: express.Response,
                                 next: express.NextFunction) => {
  const state = await accessState(req);
  if (state === 'open' || state === 'ok') return next();
  if (state === 'unconfigured') {
    return res.status(503).json({ error: 'Access is not configured for this course site' });
  }
  return res.status(401).json({
    error: state === 'expired' ? 'Access code expired' : 'Access code required',
    needsAccessCode: true,
  });
};

// ── Private project content ──────────────────────────────────────────
//
// Some files a project serves are deliberately not in the repository: the
// papers project's PDFs are gitignored (several are publisher-copyright, and none
// belong in git history). A Railway deploy is built from git, so those files are
// never on its disk. They live instead in a private store on the mounted volume,
// PRIVATE_CONTENT_ROOT (e.g. /data/private-content), at the SAME repo-relative
// path they have in a checkout (projects/papers/content/library/x.pdf). Every
// reader resolves a content path through resolveProjectContentFile(), which tries
// the checkout first and the store second, so project.json names one path and it
// works in dev and in production alike. tools/push-content.ts fills the store.
const PRIVATE_CONTENT_ROOT = process.env.PRIVATE_CONTENT_ROOT?.trim()
  ? path.resolve(process.env.PRIVATE_CONTENT_ROOT.trim())
  : null;

/** A repo-relative path under projects/, normalized; null for anything else. */
function projectContentRelPath(rel: string): string | null {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return null;
  const normalized = path.posix.normalize(rel.replace(/\\/g, '/'));
  if (normalized.startsWith('/') || normalized.startsWith('../')) return null;
  if (!normalized.startsWith('projects/')) return null;
  return normalized;
}

/** Where a private file lives in the store; null when no store is configured. */
function privateContentPath(rel: string): string | null {
  if (!PRIVATE_CONTENT_ROOT) return null;
  const abs = path.resolve(PRIVATE_CONTENT_ROOT, rel);
  return abs.startsWith(PRIVATE_CONTENT_ROOT + path.sep) ? abs : null;
}

/** The file on disk for a project content path: the checkout, then the private store. */
async function resolveProjectContentFile(rel: string): Promise<string | null> {
  const clean = projectContentRelPath(rel);
  if (!clean) return null;
  const candidates = [path.resolve(REPO_ROOT, clean), privateContentPath(clean)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch { /* try the next */ }
  }
  return null;
}

/** Every file a project's tabs point at, all languages, as repo-relative paths. */
function projectTabContentFiles(config: Record<string, any>): Set<string> {
  const out = new Set<string>();
  for (const tab of Array.isArray(config.tabs) ? config.tabs : []) {
    const files = typeof tab?.contentFile === 'string' ? [tab.contentFile]
      : Object.values(tab?.contentFile ?? {});
    for (const f of files) {
      const clean = typeof f === 'string' ? projectContentRelPath(f) : null;
      if (clean) out.add(clean);
    }
  }
  return out;
}

/**
 * Write a file by way of a temporary sibling and a rename, so a dropped upload
 * leaves the previous copy in place rather than a truncated one. Shared by every
 * upload that lands on the volume.
 */
async function writeFileAtomic(dest: string, body: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.upload-${randomUUID().slice(0, 8)}`;
  await fs.writeFile(tmp, body);
  await fs.rename(tmp, dest);
}

app.post('/api/access', accessLimiter, async (req, res) => {
  const slug = requestProjectSlug(req);
  if (!(await readProjectFlags(slug)).requireAccessCode) {
    return res.json({ success: true, token: null, required: false });
  }
  const configured = await getAccessCode(slug);
  if (!configured) {
    return res.status(503).json({ error: 'Access is not configured for this course site' });
  }
  const supplied = typeof req.body?.code === 'string' ? req.body.code : '';
  // Compare on a normalized form: the code is a spoken passphrase read off a
  // Canvas page, so case and stray spaces are the user's typing, not a mismatch.
  const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!supplied || normalize(supplied) !== normalize(configured)) {
    return res.status(401).json({ error: 'That code is not right' });
  }
  const token = jwt.sign({ role: 'course-access', project: slug }, JWT_SECRET,
                         { expiresIn: ACCESS_TOKEN_EXPIRY });
  return res.json({ success: true, token, required: true });
});

// ── npj26 disagreement verification ──────────────────────────────────
//
// A bilingual clinician opens ai-med.live/npj26/<CODE> and works one checklist
// cell at a time. The code is an opaque reviewer token issued out of band; there
// is no login, so the token IS the identity and the only thing that scopes a
// reviewer's answers. Nothing here is project-scoped, which is why these routes
// sit outside /api and its X-Project middleware.
//
// `bucket` and `match_method` are the study's sampling and matching labels. They
// would tell a reviewer which answer the analysis expects, so the reviewer
// serializer in npj26.ts drops them and they leave only via the admin export.

const npj26Limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Too many requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});

const npj26AdminOk = (supplied: unknown): boolean => {
  const expected = process.env.ADMIN_PASSPHRASE;
  return typeof expected === 'string' && expected.length > 0
    && typeof supplied === 'string' && supplied === expected;
};

// Admin routes are declared before the /:token routes so that a literal segment
// ("export", "load") can never be read as a reviewer token.

app.get('/npj26/export', async (req, res) => {
  if (!npj26AdminOk(req.query.passphrase)) {
    return res.status(401).json({ error: 'Invalid passphrase' });
  }
  try {
    const csv = await exportNpj26Csv();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="npj26-responses.csv"');
    return res.send(csv);
  } catch (error) {
    console.error('npj26 export failed:', error);
    return res.status(500).json({ error: 'Export failed' });
  }
});

// Cells carry full bilingual transcripts; 100 cells exceed express.json()'s 100kb default.
app.post('/npj26/load', express.json({ limit: '20mb' }), async (req, res) => {
  const { passphrase, cells } = req.body ?? {};
  if (!npj26AdminOk(passphrase)) {
    return res.status(401).json({ error: 'Invalid passphrase' });
  }
  if (!Array.isArray(cells) || cells.length === 0) {
    return res.status(400).json({ error: 'cells must be a non-empty array' });
  }
  try {
    const loaded = await loadNpj26Cells(cells);
    console.log(`npj26: loaded ${loaded} cells (replacing all)`);
    return res.json({ success: true, loaded });
  } catch (error) {
    console.error('npj26 load failed:', error);
    return res.status(400).json({ error: (error as Error).message });
  }
});

app.get('/npj26/:token/next', npj26Limiter, async (req, res) => {
  const { token } = req.params;
  if (!NPJ26_TOKEN_RE.test(token)) {
    return res.status(400).json({ error: 'Invalid review code' });
  }
  try {
    return res.json(await getNpj26Progress(token));
  } catch (error) {
    console.error('npj26 next failed:', error);
    return res.status(500).json({ error: 'Could not load the next item' });
  }
});

app.post('/npj26/:token/:cellId', npj26Limiter, async (req, res) => {
  const { token, cellId } = req.params;
  if (!NPJ26_TOKEN_RE.test(token)) {
    return res.status(400).json({ error: 'Invalid review code' });
  }

  // code is a smallint 1-4: 1 Vietnamese, 2 English, 3 Both, 4 Neither.
  const { code, turn_relevant: turnRelevant, comment } = req.body ?? {};
  const codeNum = typeof code === 'number' ? code : parseInt(String(code), 10);
  if (!Number.isInteger(codeNum) || codeNum < 1 || codeNum > 4) {
    return res.status(400).json({
      error: 'code must be an integer 1-4 (1 Vietnamese, 2 English, 3 Both, 4 Neither)',
    });
  }
  // Only a highlighted cell asks the turn question, so null is a real value here
  // and must survive as null rather than collapse to false.
  const turn = turnRelevant === null || turnRelevant === undefined
    ? null
    : Boolean(turnRelevant);
  // The reviewer form no longer collects a comment, so this is null in practice.
  // The column stays, and the parse stays, so older clients and any future
  // free-text field write through the same path.
  const commentText = typeof comment === 'string' && comment.trim()
    ? comment.trim().slice(0, 4000)
    : null;

  try {
    if (!(await npj26CellExists(cellId))) {
      return res.status(404).json({ error: 'Unknown item' });
    }
    await saveNpj26Response(token, cellId, codeNum, turn, commentText);
    return res.json(await getNpj26Progress(token));
  } catch (error) {
    console.error('npj26 submit failed:', error);
    return res.status(500).json({ error: 'Could not save your answer' });
  }
});

// Serve static files from dist/client in production (unless SERVE_FRONTEND=false)
const serveFrontend = process.env.SERVE_FRONTEND !== 'false';
if (process.env.NODE_ENV === 'production' && serveFrontend) {
  const staticDir = process.env.STATIC_DIR || path.join(__dirname, '../../frontend-chat/dist');
  app.use(express.static(staticDir));
}

// API Routes

// The chat pipeline's route (routes/chat.ts), behind the same guards in the same order.
app.use(chatRouter([chatBurstLimiter, chatLimiter, requireAccessCode, requirePublicChatIfDeclared]));

// Text-to-speech endpoint
const TTS_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'] as const;
type TTSVoice = typeof TTS_VOICES[number];

app.post('/api/tts', ttsLimiter, requirePublicChatIfDeclared, async (req, res) => {
  try {
    const { text, voice } = req.body as { text?: string; voice?: string };

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text is required' });
    }

    if (!openaiDirect) {
      return res.status(503).json({ error: new DirectKeyMissingError('Text-to-speech').message });
    }

    const selectedVoice: TTSVoice = TTS_VOICES.includes(voice as TTSVoice)
      ? (voice as TTSVoice)
      : 'nova';

    const ttsModel = 'gpt-4o-mini-tts';
    const mp3 = await openaiDirect.audio.speech.create({
      model: ttsModel,
      voice: selectedVoice,
      input: text,
    });

    // Log TTS usage (billed per character, no token counts returned)
    const charCount = text.length;
    logTokenUsage({
      project: activeProjectPrefix(),
      endpoint: '/api/tts',
      model: ttsModel,
      prompt_tokens: charCount,
      completion_tokens: 0,
      estimated_cost: estimateCost(ttsModel, charCount, 0),
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', String(buffer.length));
    res.send(buffer);
  } catch (error) {
    console.error('TTS API error:', error);
    res.status(500).json({
      error: 'Failed to generate speech',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ── OpenAI Realtime API: mint an ephemeral client secret ────────────────────
// The browser uses the returned ephemeral secret to open a WebRTC connection
// directly to OpenAI; audio never flows through this server. Per-project opt-in
// via `enableRealtime` in project.json; rate-limited as the cost guardrail.
// Bills a DIRECT key (see OPENAI_REALTIME_KEY) — never the Harvard gateway.
app.post('/api/realtime/session', realtimeLimiter, requirePublicChatIfDeclared, async (req, res) => {
  try {
    const { vignetteKey, language } = req.body as {
      vignetteKey?: string;
      language?: string | null;
    };

    // Per-project opt-in: realtime is inert unless the project enables it.
    const slug = (activeProjectPrefix() || '').replace(/_+$/, '') || 'demo';
    // No project.json resolves to every default: off.
    if (!(await readProjectFlags(slug)).enableRealtime) {
      return res.status(403).json({ error: 'Realtime voice is not enabled for this project' });
    }

    if (!OPENAI_REALTIME_KEY) {
      return res.status(503).json({ error: 'Realtime voice needs a direct OpenAI key (OPENAI_REALTIME_KEY or OPENAI_TTS_KEY): the Harvard gateway cannot serve it, and none is configured.' });
    }

    if (language && !/^[\p{L}\p{M}\s\-()]{1,50}$/u.test(language)) {
      return res.status(400).json({ error: 'Invalid language parameter' });
    }

    // Compose instructions: project system prompt + selected vignette + voice
    // framing + language pin. Mirrors /api/chat's assembly so the spoken patient
    // matches the text patient for the same vignette.
    const systemPrompt = await getSystemPrompt();
    let vignetteContent = '';
    if (vignetteKey) {
      const vignettes = await getAllVignettes();
      const v = vignettes.find(x => x.key === vignetteKey);
      if (!v) return res.status(400).json({ error: 'Invalid vignette key' });
      vignetteContent = v.content;
    }

    // The chat system prompts tell the model to prefix turns with role labels
    // ("Patient:", "Nurse:", "患者：", "护士："). In voice those get spoken aloud,
    // which sounds robotic — override that here. (Text chat is unaffected.)
    const voiceFraming =
      'VOICE MODE OVERRIDE: You are speaking aloud via real-time voice. ' +
      'Do NOT prefix what you say with "Patient:", "Nurse:", "护士：", "患者：", or any role label — ' +
      'those labels belong to the written-chat version of this scenario and would be read aloud, which sounds robotic. ' +
      'Speak ONLY the words the character would actually say out loud. The role is conveyed by tone and content, not by announcing it. ' +
      'Keep turns short and conversational. No markdown, asterisks, headings, stage directions, or narration. Stay in character.';

    // Voice mode has no typed message to calibrate language from, so pin it
    // explicitly every time (including English) or the model drifts toward
    // whatever language the vignette text is heaviest in.
    const languageDirective = language
      ? `LANGUAGE: Speak only in ${language}. Do not switch languages for any reason.`
      : '';

    const instructions = [systemPrompt || '', vignetteContent, voiceFraming, languageDirective]
      .filter(Boolean)
      .join('\n\n');

    // New API shape: session config nested under `session`, audio under
    // `audio.input` / `audio.output`. Instructions are baked into the ephemeral
    // token here — the frontend must NOT resend `instructions` (it would replace,
    // not append, wiping the vignette + language pin).
    const resp = await fetch(`${OPENAI_DIRECT_URL}/realtime/client_secrets`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_REALTIME_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session: {
          type: 'realtime',
          model: OPENAI_REALTIME_MODEL,
          instructions,
          audio: {
            input: {
              transcription: { model: 'whisper-1' },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.6,
                silence_duration_ms: 800,
              },
              noise_reduction: { type: 'near_field' },
            },
            output: { voice: OPENAI_REALTIME_VOICE },
          },
        },
      }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error('OpenAI realtime client_secrets mint failed:', resp.status, text);
      return res.status(502).json({ error: 'Failed to mint realtime session' });
    }

    // Ephemeral secret is at `value` on the new endpoint; fall back to the older
    // `client_secret.value` shape just in case.
    const data = await resp.json() as {
      value?: string;
      expires_at?: number;
      id?: string;
      client_secret?: { value?: string; expires_at?: number };
    };
    const clientSecret = data.value || data.client_secret?.value;
    const expiresAt = data.expires_at ?? data.client_secret?.expires_at;
    if (!clientSecret) {
      console.error('OpenAI realtime response missing secret:', data);
      return res.status(502).json({ error: 'Malformed realtime session response' });
    }

    // Record the mint so volume shows up in the admin Usage tab. Audio is billed
    // by OpenAI per-minute and isn't returned here, so cost is logged as 0 — the
    // row count is what surfaces realtime activity per project.
    logTokenUsage({
      project: activeProjectPrefix(),
      endpoint: '/api/realtime/session',
      model: OPENAI_REALTIME_MODEL,
      prompt_tokens: 0,
      completion_tokens: 0,
      estimated_cost: 0,
    });

    // Resolve the same template name the text chat sends so the voice flow's Kobo
    // submission carries an identical `case_template` prefill.
    let templateName: string | null = null;
    try {
      const caseTemplateData = await getCaseTemplate();
      if (caseTemplateData && vignetteKey) {
        const parsed = JSON.parse(caseTemplateData);
        templateName = parsed.vignetteTemplates?.[vignetteKey] || null;
      }
    } catch { /* leave null */ }

    return res.json({
      clientSecret,
      expiresAt,
      model: OPENAI_REALTIME_MODEL,
      voice: OPENAI_REALTIME_VOICE,
      maxSessionSeconds: REALTIME_MAX_SESSION_SECONDS,
      caseTemplate: templateName,
    });
  } catch (error) {
    console.error('Realtime session error:', error);
    return res.status(500).json({ error: 'Failed to create realtime session' });
  }
});

// Save transcript to local text file (for QA / planning)
app.post('/api/transcripts', async (req, res) => {
  try {
    const { messages, vignetteKey, metadata } = req.body as {
      messages?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
      vignetteKey?: string | null;
      metadata?: Record<string, unknown> | undefined;
    };

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    // Serialize to a clean, readable transcript text
    const headerLines: string[] = [];
    headerLines.push('Transcript');
    headerLines.push(`Created: ${new Date().toISOString()}`);
    if (vignetteKey) headerLines.push(`Vignette: ${vignetteKey}`);
    if (metadata && Object.keys(metadata).length > 0) {
      headerLines.push(`Metadata: ${JSON.stringify(metadata)}`);
    }
    headerLines.push('');

    const body = messages
      .map(m => {
        const label = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'System';
        return `${label}:\n${m.content}`;
      })
      .join('\n\n');

    const transcriptText = headerLines.join('\n') + body + '\n';

    // Ensure transcripts directory exists at project root
    const transcriptsDir = path.resolve(REPO_ROOT, 'transcripts');
    await fs.mkdir(transcriptsDir, { recursive: true });

    const safeVignette = vignetteKey ? String(vignetteKey).replace(/[^a-zA-Z0-9_-]/g, '-') : 'session';
    const fileName = `${safeVignette}_${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID().slice(0, 8)}.txt`;
    const filePath = path.join(transcriptsDir, fileName);

    await fs.writeFile(filePath, transcriptText, 'utf8');

    return res.json({ ok: true, fileName, path: filePath });
  } catch (error) {
    console.error('Error saving transcript:', error);
    return res.status(500).json({ error: 'Failed to save transcript' });
  }
});

// Save transcript content by token (idempotent write)
app.post('/api/transcripts/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    // Basic token validation: at least 16 chars, url-safe
    if (!/^[A-Za-z0-9_-]{16,}$/.test(token)) {
      return res.status(400).json({ error: 'invalid token' });
    }

    const content = typeof req.body?.content === 'string' ? req.body.content : null;
    if (!content) {
      return res.status(400).json({ error: 'content is required' });
    }

    const transcriptsDir = path.resolve(REPO_ROOT, 'transcripts');
    await fs.mkdir(transcriptsDir, { recursive: true });

    // Ensure filenames include a timestamp prefix before the token to match initial_ format
    // Maintain idempotency by reusing an existing file for this token if found
    const files = await fs.readdir(transcriptsDir);
    const existing = files.find(name => name.endsWith(`_${token}.txt`));
    const targetFileName = existing || `${new Date().toISOString().replace(/[:.]/g, '-')}_${token}.txt`;
    const filePath = path.join(transcriptsDir, targetFileName);

    await fs.writeFile(filePath, content, 'utf8');
    return res.json({ ok: true, token, url: `/t/${token}` });
  } catch (error) {
    console.error('Error saving transcript by token:', error);
    return res.status(500).json({ error: 'Failed to save transcript' });
  }
});

// Serve transcript by token
app.get('/t/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!/^[A-Za-z0-9_-]{16,}$/.test(token)) {
      return res.status(400).send('Invalid token');
    }

    const transcriptsDir = path.resolve(REPO_ROOT, 'transcripts');
    // Support timestamp-prefixed filenames like <ISO>_<token>.txt
    const files = await fs.readdir(transcriptsDir);
    const match = files.find(name => name.endsWith(`_${token}.txt`));
    if (!match) {
      return res.status(404).send('Not found');
    }
    const filePath = path.join(transcriptsDir, match);

    // Read and return as text/plain
    const data = await fs.readFile(filePath, 'utf8');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(data);
  } catch (error) {
    if ((error as any)?.code === 'ENOENT') {
      return res.status(404).send('Not found');
    }
    console.error('Error reading transcript by token:', error);
    return res.status(500).send('Server error');
  }
});

// Optional .txt alias (e.g., /t/<token>.txt)
app.get('/t/:token.txt', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!/^[A-Za-z0-9_-]{16,}$/.test(token)) {
      return res.status(400).send('Invalid token');
    }

    const transcriptsDir = path.resolve(REPO_ROOT, 'transcripts');
    const files = await fs.readdir(transcriptsDir);
    const match = files.find(name => name.endsWith(`_${token}.txt`));
    if (!match) {
      return res.status(404).send('Not found');
    }
    const filePath = path.join(transcriptsDir, match);
    const data = await fs.readFile(filePath, 'utf8');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(data);
  } catch (error) {
    if ((error as any)?.code === 'ENOENT') {
      return res.status(404).send('Not found');
    }
    console.error('Error reading transcript by token (.txt):', error);
    return res.status(500).send('Server error');
  }
});

// Write transcript to KoboToolbox submission (called after form submit)
app.post('/api/kobo-transcript', async (req, res) => {
  try {
    const { token, transcript } = req.body as { token?: string; transcript?: string };
    if (!token || typeof token !== 'string' || token.length < 16) {
      return res.status(400).json({ error: 'valid token is required' });
    }
    if (!transcript || typeof transcript !== 'string') {
      return res.status(400).json({ error: 'transcript is required' });
    }

    const koboToken = process.env.KOBO_API_TOKEN;
    if (!koboToken) {
      console.error('KOBO_API_TOKEN not configured — skipping Kobo write');
      return res.status(503).json({ error: 'Kobo integration not configured' });
    }

    const formUid = await getKoboFormUid();
    if (!formUid) {
      return res.status(503).json({ error: 'Kobo form UID not configured' });
    }

    // Find the submission by matching the token in transcriptToken (or chat_transcript fallback)
    let searchUrl = `${KOBO_KF_BASE}/api/v2/assets/${formUid}/data/?query=${encodeURIComponent(JSON.stringify({ transcriptToken: token }))}&limit=1`;
    let searchResp = await fetch(searchUrl, {
      headers: { Authorization: `Token ${koboToken}` },
    });
    if (!searchResp.ok) {
      console.error('Kobo search failed:', searchResp.status, await searchResp.text());
      return res.status(502).json({ error: 'Failed to query Kobo' });
    }
    let searchData = await searchResp.json() as { count: number; results: Array<{ _id: number }> };

    // Fallback to chat_transcript for backward compatibility with old submissions
    if (searchData.count === 0) {
      searchUrl = `${KOBO_KF_BASE}/api/v2/assets/${formUid}/data/?query=${encodeURIComponent(JSON.stringify({ chat_transcript: token }))}&limit=1`;
      searchResp = await fetch(searchUrl, {
        headers: { Authorization: `Token ${koboToken}` },
      });
      if (!searchResp.ok) {
        console.error('Kobo fallback search failed:', searchResp.status, await searchResp.text());
        return res.status(502).json({ error: 'Failed to query Kobo' });
      }
      searchData = await searchResp.json() as { count: number; results: Array<{ _id: number }> };
    }

    if (searchData.count === 0 || !searchData.results?.[0]?._id) {
      return res.status(404).json({ error: 'Submission not found in Kobo' });
    }

    const submissionId = searchData.results[0]._id;

    // Use bulk update endpoint to replace token with full transcript
    const bulkUrl = `${KOBO_KF_BASE}/api/v2/assets/${formUid}/data/bulk/`;
    const bulkResp = await fetch(bulkUrl, {
      method: 'PATCH',
      headers: {
        Authorization: `Token ${koboToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        payload: {
          submission_ids: [submissionId],
          data: { chat_transcript: transcript },
        },
      }),
    });
    if (!bulkResp.ok) {
      console.error('Kobo bulk update failed:', bulkResp.status, await bulkResp.text());
      return res.status(502).json({ error: 'Failed to update Kobo submission' });
    }
    const bulkData = await bulkResp.json() as { successes?: number };
    if (!bulkData.successes) {
      console.error('Kobo bulk update returned no successes:', bulkData);
      return res.status(502).json({ error: 'Kobo update did not succeed' });
    }

    console.log(`Transcript written to Kobo submission ${submissionId}`);

    // Log session engagement: form submitted + transcript saved (non-blocking)
    const project = (activeProjectPrefix() || '').replace(/_+$/, '') || 'default';
    logSessionFormSubmit(project, token).catch(e =>
      console.warn('Failed to log session form submit:', e)
    );
    logSessionTranscriptSaved(project, token).catch(e =>
      console.warn('Failed to log session transcript save:', e)
    );

    return res.json({ ok: true, submissionId });
  } catch (error) {
    console.error('Error writing transcript to Kobo:', error);
    return res.status(500).json({ error: 'Failed to write transcript to Kobo' });
  }
});

// Grade session endpoint - returns grading results for all tokens in a session
app.post('/api/grade-session', requirePublicChatIfDeclared, async (req, res) => {
  try {
    const { tokens, language } = req.body as {
      tokens?: string[];
      language?: string;
    };

    if (!Array.isArray(tokens) || tokens.length === 0) {
      return res.status(400).json({ error: 'tokens array is required' });
    }

    const languageCode = language || 'en';

    const koboToken = process.env.KOBO_API_TOKEN;
    if (!koboToken) {
      console.error('KOBO_API_TOKEN not configured — skipping grading');
      return res.status(503).json({ error: 'Kobo integration not configured' });
    }

    const formUid = await getKoboFormUid();
    if (!formUid) {
      return res.status(503).json({ error: 'Kobo form UID not configured' });
    }

    // Remove trailing underscore from table prefix to get project slug
    const projectSlug = (activeProjectPrefix() || 'demo').replace(/_+$/, '') || 'demo';

    // Load project config to check if feedback enabled
    const projectConfigPath = path.join(REPO_ROOT, 'projects', projectSlug, 'project.json');
    let projectConfig: any;
    try {
      const configContent = await fs.readFile(projectConfigPath, 'utf-8');
      projectConfig = JSON.parse(configContent);
    } catch (error) {
      console.error(`Failed to load project config for ${projectSlug}:`, error);
      return res.status(500).json({ error: 'Failed to load project configuration' });
    }

    if (!resolveProjectFlags(projectConfig).enableFeedback) {
      return res.status(403).json({ error: 'Feedback not enabled for this project' });
    }

    // Fetch all submissions from Kobo by transcriptToken
    const submissions: Array<{
      token: string;
      transcript: string;
      vignetteId: string;
      caseTemplate: string;
      language: string;
    }> = [];

    for (const token of tokens) {
      // Search by transcriptToken
      let searchUrl = `${KOBO_KF_BASE}/api/v2/assets/${formUid}/data/?query=${encodeURIComponent(
        JSON.stringify({ transcriptToken: token })
      )}&limit=1`;
      let searchResp = await fetch(searchUrl, {
        headers: { Authorization: `Token ${koboToken}` },
      });
      let searchData = await searchResp.json() as {
        count: number;
        results: Array<{
          _id: number;
          chat_transcript?: string;
          vignette_id?: string;
          case_template?: string;
        }>;
      };

      // Fallback to chat_transcript for backward compatibility
      if (searchData.count === 0) {
        searchUrl = `${KOBO_KF_BASE}/api/v2/assets/${formUid}/data/?query=${encodeURIComponent(
          JSON.stringify({ chat_transcript: token })
        )}&limit=1`;
        searchResp = await fetch(searchUrl, {
          headers: { Authorization: `Token ${koboToken}` },
        });
        searchData = await searchResp.json() as typeof searchData;
      }

      if (searchData.count > 0 && searchData.results[0]) {
        const result = searchData.results[0];
        const transcript = result.chat_transcript || '';
        const vignetteId = result.vignette_id || '';
        const caseTemplate = result.case_template || '';

        console.log(`[GRADE-SESSION] Token: ${token}`);
        console.log(`[GRADE-SESSION]   Submission ID: ${result._id}`);
        console.log(`[GRADE-SESSION]   case_template value: ${JSON.stringify(caseTemplate)}`);
        console.log(`[GRADE-SESSION]   case_template type: ${typeof caseTemplate}`);

        // Validate case_template: must be a simple name (no path traversal)
        // and must exist as a directory under projects/{slug}/cases/
        const templateValid = /^[\w-]+$/.test(caseTemplate);
        let templateExists = false;
        if (templateValid) {
          try {
            const templateDir = path.join(REPO_ROOT, 'projects', projectSlug, 'cases', caseTemplate);
            const stat = await fs.stat(templateDir);
            templateExists = stat.isDirectory();
          } catch { /* doesn't exist */ }
        }

        // Only include submissions with valid data
        if (transcript && vignetteId && caseTemplate && templateValid && templateExists) {
          submissions.push({
            token,
            transcript,
            vignetteId,
            caseTemplate,
            language: languageCode,
          });
          console.log(`[GRADE-SESSION]   ✓ Added to submissions array`);
        } else if (caseTemplate && (!templateValid || !templateExists)) {
          console.warn(`[GRADE-SESSION]   ✗ Rejected invalid case_template: ${JSON.stringify(caseTemplate)}`);
        } else {
          console.warn(
            `Incomplete submission data for token ${token}: transcript=${!!transcript}, vignetteId=${!!vignetteId}, caseTemplate=${!!caseTemplate}`
          );
        }
      } else {
        console.warn(`No submission found for token ${token}`);
      }
    }

    if (submissions.length === 0) {
      return res.status(404).json({ error: 'No valid submissions found for the provided tokens' });
    }

    console.log(`[GRADE-SESSION] Total submissions to grade: ${submissions.length}`);
    console.log(`[GRADE-SESSION] Submissions detail:`);
    submissions.forEach((sub, idx) => {
      console.log(`  [${idx}] token=${sub.token}, template=${JSON.stringify(sub.caseTemplate)}`);
    });

    // Grade all submissions in parallel
    const { gradeSession } = await import('./grading.js');
    const results = await gradeSession(submissions, projectSlug);

    // Extract opening statements from transcripts
    const openingStatements: Record<string, string> = {};
    for (const sub of submissions) {
      // Get first Assistant message from transcript (the AI patient's opening line)
      // Format: "Assistant:" on one line, then the message on the next line
      const lines = sub.transcript.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed === 'Assistant:' && i + 1 < lines.length) {
          // Get the next line which contains the actual message
          openingStatements[sub.token] = lines[i + 1].trim();
          console.log(`[OPENING] Token ${sub.token}: "${openingStatements[sub.token]}"`);
          break;
        }
      }
      if (!openingStatements[sub.token]) {
        console.log(`[OPENING] No opening statement found for ${sub.token}`);
      }
    }
    console.log('[OPENING] Extracted opening statements:', Object.keys(openingStatements).length);

    // Synthesize focused feedback for each token
    const { synthesizeFeedback } = await import('./grading.js');
    const synthesizedFeedback: Record<string, any> = {};

    for (const [token, gradingResults] of results.entries()) {
      try {
        const feedback = await synthesizeFeedback(gradingResults, languageCode, projectSlug);
        synthesizedFeedback[token] = {
          ...feedback,
          openingStatement: openingStatements[token] || '',
        };
      } catch (error) {
        console.error(`Failed to synthesize feedback for token ${token}:`, error);
        // Fallback to empty feedback if synthesis fails
        synthesizedFeedback[token] = {
          strengths: [],
          growthAreas: [],
          openingStatement: openingStatements[token] || '',
        };
      }
    }

    // Convert Map to object for JSON (raw results for debugging/detailed view)
    const resultsObj: Record<string, any[]> = {};
    for (const [token, gradingResults] of results.entries()) {
      resultsObj[token] = gradingResults;
    }

    return res.json({
      ok: true,
      results: resultsObj,
      synthesized: synthesizedFeedback
    });
  } catch (error) {
    console.error('Error grading session:', error);
    if (error instanceof DirectKeyMissingError) return res.status(503).json({ error: error.message });
    return res.status(500).json({ error: 'Failed to grade session' });
  }
});

// Admin routes
app.post('/api/admin/login', loginLimiter, async (req, res) => {
  try {
    const { passphrase } = req.body;
    const adminPassphrase = process.env.ADMIN_PASSPHRASE;
    
    if (!adminPassphrase) {
      return res.status(500).json({ error: 'Admin authentication not configured' });
    }

    let scope: 'global' | 'project' = 'global';
    let projectSlug: string | undefined;

    if (passphrase === adminPassphrase) {
      // Global admin passphrase matches
      scope = 'global';
    } else {
      // Try per-project passphrase (project slug from X-Project header)
      const projectHeader = req.headers['x-project'];
      const slug = typeof projectHeader === 'string' ? projectHeader.trim().replace(/_+$/, '') : '';
      if (slug) {
        const projectPass = await getProjectSetting(slug, 'admin_passphrase');
        if (projectPass && passphrase === projectPass) {
          scope = 'project';
          projectSlug = slug;
        } else {
          return res.status(401).json({ error: 'Invalid passphrase' });
        }
      } else {
        return res.status(401).json({ error: 'Invalid passphrase' });
      }
    }

    // Generate JWT with scope
    const jwtPayload: Record<string, any> = {
      role: 'admin',
      scope,
      iat: Math.floor(Date.now() / 1000),
    };
    if (projectSlug) jwtPayload.project = projectSlug;

    const token = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: JWT_EXPIRY });

    // Set HTTP-only cookie
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: COOKIE_MAX_AGE,
    });

    return res.json({ success: true, token, scope, project: projectSlug });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Login failed' });
  }
});

// Verify admin session (for restoring session on page load)
app.get('/api/admin/verify', authenticateAdmin, (req, res) => {
  return res.json({
    authenticated: true,
    scope: (req as any).adminScope || 'global',
    project: (req as any).adminProject,
  });
});

// Logout (clear cookie)
app.post('/api/admin/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
  });
  return res.json({ success: true });
});

// ── Global admin: per-project passphrase management ──────────────────

app.get('/api/admin/global/project-passphrases', requireGlobalAdmin, async (_req, res) => {
  try {
    const settings = await getAllProjectSettings('admin_passphrase');
    const settingsMap = new Map(settings.map(s => [s.project_slug, s.setting_value]));

    const passphrases = [...validProjectSlugs].sort().map(slug => ({
      slug,
      passphrase: settingsMap.get(slug) || null,
    }));

    return res.json({ passphrases });
  } catch (error) {
    console.error('Error fetching project passphrases:', error);
    return res.status(500).json({ error: 'Failed to fetch project passphrases' });
  }
});

app.put('/api/admin/global/project-passphrases/:slug', requireGlobalAdmin, async (req, res) => {
  try {
    const { slug } = req.params;
    const { passphrase } = req.body;

    if (validProjectSlugs.size > 0 && !validProjectSlugs.has(slug)) {
      return res.status(404).json({ error: 'Unknown project slug' });
    }
    if (!passphrase || typeof passphrase !== 'string' || !passphrase.trim()) {
      return res.status(400).json({ error: 'Passphrase is required' });
    }

    await setProjectSetting(slug, 'admin_passphrase', passphrase.trim());
    return res.json({ success: true });
  } catch (error) {
    console.error('Error setting project passphrase:', error);
    return res.status(500).json({ error: 'Failed to set project passphrase' });
  }
});

app.delete('/api/admin/global/project-passphrases/:slug', requireGlobalAdmin, async (req, res) => {
  try {
    const { slug } = req.params;
    await deleteProjectSetting(slug, 'admin_passphrase');
    return res.json({ success: true });
  } catch (error) {
    console.error('Error clearing project passphrase:', error);
    return res.status(500).json({ error: 'Failed to clear project passphrase' });
  }
});

app.get('/api/admin/content', authenticateAdmin, async (_req, res) => {
  try {
    // Get all content from database (defaults were seeded on first run)
    const content = await getAllAdminContent();
    
    return res.json({
      systemPrompt: content.systemPrompt || '',
      vignettes: content.vignettes,
      koboFormUrl: content.koboFormUrl || '',
      koboFormUid: content.koboFormUid || '',
      caseTemplate: content.caseTemplate || '',
      hasCustomSystemPrompt: !!content.systemPrompt,
    });
  } catch (error) {
    console.error('Error fetching admin content:', error);
    return res.status(500).json({ error: 'Failed to fetch content' });
  }
});

app.post('/api/admin/content', authenticateAdmin, requireContentWrite, async (req, res) => {
  try {
    const { systemPrompt, vignettes, koboFormUrl } = req.body as {
      systemPrompt?: string;
      vignettes?: Array<{ id?: number; key: string; content: string }>;
      koboFormUrl?: string;
    };
    
    // Validate: at least one vignette is required if vignettes array is provided
    if (Array.isArray(vignettes) && vignettes.length === 0) {
      return res.status(400).json({ 
        error: 'At least one vignette is required',
        details: 'Cannot save with zero vignettes. The application requires at least one vignette to function.'
      });
    }
    
    // Save system prompt if provided
    if (systemPrompt !== undefined && systemPrompt.trim()) {
      await saveSystemPrompt(systemPrompt);
    }
    
    // Save Kobo form URL if provided
    if (koboFormUrl !== undefined && koboFormUrl.trim()) {
      await saveKoboFormUrl(koboFormUrl);
    }
    
    // Save vignettes if provided - use ID-based strategy to preserve IDs on key renames
    if (Array.isArray(vignettes) && vignettes.length > 0) {
      // Get existing vignettes with their IDs
      const existingVignettes = await getAllVignettes();
      const existingIds = new Set(existingVignettes.map(v => v.id));
      
      // Collect IDs from incoming vignettes (those that have IDs are existing)
      const incomingIds = new Set(
        vignettes
          .filter(v => v.id !== undefined && v.id !== null)
          .map(v => v.id as number)
      );
      
      // Delete vignettes whose IDs are not in the incoming list
      for (const existing of existingVignettes) {
        if (!incomingIds.has(existing.id)) {
          await deleteVignetteById(existing.id);
        }
      }
      
      // Save/update all incoming vignettes
      for (const vignette of vignettes) {
        if (vignette.key && vignette.content) {
          if (vignette.id !== undefined && vignette.id !== null && existingIds.has(vignette.id)) {
            // Update existing vignette by ID (preserves ID even if key changes)
            await updateVignetteById(vignette.id, vignette.key, vignette.content);
          } else {
            // New vignette - insert it
            await saveVignette(vignette.key, vignette.content);
          }
        }
      }
    }
    
    return res.json({ success: true, message: 'Content saved successfully' });
  } catch (error) {
    console.error('Error saving admin content:', error);
    return res.status(500).json({ 
      error: 'Failed to save content',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Save system prompt individually
// ── Reading index upload ─────────────────────────────────────────────
//
// The index is a derived copy of copyrighted PDFs. It is never committed, so it
// cannot arrive with a deploy, and Railway's container filesystem is wiped on
// every redeploy, so it cannot simply be uploaded once to disk either. It lives
// on a mounted volume, and this is how it gets there.
//
// Global admin only, and the destination is READINGS_INDEX_<SLUG> — the same
// variable the reader uses, so an upload cannot land anywhere the reader will
// not look. Writes to a temporary file and renames, so a connection that drops
// mid-upload leaves the previous index in place rather than a truncated one.
//
//   curl -f -X POST "$DEPLOY_URL/api/admin/readings-index" \
//     -H "X-Project: ppol5013" -H "Authorization: Bearer $TOKEN" \
//     -H "Content-Type: application/octet-stream" \
//     --data-binary @projects/ppol5013/content/readings/readings.db
//
// See tools/upload-readings-index.sh, which wraps the login and this call.
app.post('/api/admin/readings-index',
  authenticateAdmin, requireContentWrite,
  express.raw({ type: 'application/octet-stream', limit: '200mb' }),
  async (req, res) => {
    try {
      const slug = requestProjectSlug(req);
      const envKey = `READINGS_INDEX_${slug.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      const target = process.env[envKey];
      if (!target || !target.trim()) {
        return res.status(400).json({
          error: `${envKey} is not set on this deployment, so there is nowhere ` +
                 'persistent to put the index. Set it to a path on a mounted volume.',
        });
      }
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return res.status(400).json({ error: 'Empty body; send the file as application/octet-stream' });
      }
      // Cheap sanity check that this is actually a SQLite database, so a wrong
      // --data-binary argument fails here instead of at the next student question.
      if (body.subarray(0, 15).toString('latin1') !== 'SQLite format 3') {
        return res.status(400).json({ error: 'That is not a SQLite database file' });
      }

      const dest = path.resolve(target.trim());
      await writeFileAtomic(dest, body);

      console.log(`[readings] ${slug}: index uploaded to ${dest} (${body.length} bytes)`);
      return res.json({ success: true, path: dest, bytes: body.length });
    } catch (error) {
      console.error('Reading index upload failed:', error);
      return res.status(500).json({
        error: 'Upload failed',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

// ── Private content store (see resolveProjectContentFile) ──────────────
//
// Global admin only. A file may be stored only at a path the requesting
// project's own project.json names as a tab contentFile, so the store cannot be
// used for anything a project does not actually serve. tools/push-content.ts
// lists, uploads changed files, and removes ones project.json no longer names.

/** A request path for this project's store, or an error to send. */
async function privateContentTarget(req: express.Request):
    Promise<{ rel: string; dest: string; referenced: boolean } | { status: number; error: string }> {
  if (!PRIVATE_CONTENT_ROOT) {
    return { status: 400, error: 'PRIVATE_CONTENT_ROOT is not set on this deployment, so there is ' +
                                 'nowhere persistent to put private content. Set it to a path on a mounted volume.' };
  }
  const slug = requestProjectSlug(req);
  const rel = projectContentRelPath(String(req.params[0] ?? ''));
  const dest = rel ? privateContentPath(rel) : null;
  if (!rel || !dest || !rel.startsWith(`projects/${slug}/`)) {
    return { status: 403, error: `Path must lie under projects/${slug}/` };
  }
  const referenced = projectTabContentFiles(await readProjectConfig(slug)).has(rel);
  return { rel, dest, referenced };
}

app.get('/api/admin/private-content', authenticateAdmin, requireContentWrite, async (req, res) => {
  const slug = requestProjectSlug(req);
  if (!PRIVATE_CONTENT_ROOT) return res.json({ configured: false, files: [] });
  const dir = privateContentPath(`projects/${slug}`);
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  const walk = async (abs: string): Promise<void> => {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = path.join(abs, e.name);
      if (e.isDirectory()) {
        await walk(child);
      } else if (e.isFile() && !e.name.includes('.upload-')) {
        const buf = await fs.readFile(child);
        files.push({
          path: path.relative(PRIVATE_CONTENT_ROOT, child).split(path.sep).join('/'),
          bytes: buf.length,
          sha256: createHash('sha256').update(buf).digest('hex'),
        });
      }
    }
  };
  if (dir) await walk(dir);
  return res.json({ configured: true, files });
});

app.put('/api/admin/private-content/*',
  authenticateAdmin, requireContentWrite,
  express.raw({ type: 'application/octet-stream', limit: '100mb' }),
  async (req, res) => {
    try {
      const target = await privateContentTarget(req);
      if ('error' in target) return res.status(target.status).json({ error: target.error });
      if (!target.referenced) {
        return res.status(400).json({ error: `${target.rel} is not a contentFile in this project's project.json` });
      }
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return res.status(400).json({ error: 'Empty body; send the file as application/octet-stream' });
      }
      await writeFileAtomic(target.dest, body);
      console.log(`[private-content] stored ${target.rel} (${body.length} bytes)`);
      return res.json({ success: true, path: target.rel, bytes: body.length });
    } catch (error) {
      console.error('Private content upload failed:', error);
      return res.status(500).json({ error: 'Upload failed' });
    }
  });

app.delete('/api/admin/private-content/*', authenticateAdmin, requireContentWrite, async (req, res) => {
  const target = await privateContentTarget(req);
  if ('error' in target) return res.status(target.status).json({ error: target.error });
  try {
    await fs.unlink(target.dest);
    console.log(`[private-content] removed ${target.rel}`);
    return res.json({ success: true, path: target.rel });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return res.json({ success: true, path: target.rel });
    console.error('Private content delete failed:', error);
    return res.status(500).json({ error: 'Delete failed' });
  }
});

app.post('/api/admin/system-prompt', authenticateAdmin, async (req, res) => {
  try {
    const { systemPrompt } = req.body as { systemPrompt?: string };
    
    if (systemPrompt === undefined) {
      return res.status(400).json({ error: 'systemPrompt is required' });
    }
    
    if (!systemPrompt.trim()) {
      return res.status(400).json({ error: 'System prompt cannot be empty' });
    }
    
    await saveSystemPrompt(systemPrompt.trim());
    return res.json({ success: true, message: 'System prompt saved successfully' });
  } catch (error) {
    console.error('Error saving system prompt:', error);
    return res.status(500).json({ 
      error: 'Failed to save system prompt',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Save Kobo form URL individually
app.post('/api/admin/kobo-url', authenticateAdmin, async (req, res) => {
  try {
    const { koboFormUrl } = req.body as { koboFormUrl?: string };
    
    if (koboFormUrl === undefined) {
      return res.status(400).json({ error: 'koboFormUrl is required' });
    }
    
    const sanitizedUrl = koboFormUrl.trim();
    
    // Validate URL format if provided
    if (sanitizedUrl) {
      try {
        const urlObj = new URL(sanitizedUrl);
        if (urlObj.protocol !== 'https:') {
          return res.status(400).json({ error: 'Kobo form URL must use HTTPS' });
        }
      } catch (e) {
        return res.status(400).json({ error: 'Invalid Kobo form URL format' });
      }
    }
    
    await saveKoboFormUrl(sanitizedUrl);
    return res.json({ success: true, message: 'Kobo form URL saved successfully' });
  } catch (error) {
    console.error('Error saving Kobo form URL:', error);
    return res.status(500).json({ 
      error: 'Failed to save Kobo form URL',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Save Kobo form UID individually
app.post('/api/admin/kobo-uid', authenticateAdmin, async (req, res) => {
  try {
    const { koboFormUid } = req.body as { koboFormUid?: string };

    if (koboFormUid === undefined) {
      return res.status(400).json({ error: 'koboFormUid is required' });
    }

    const sanitized = koboFormUid.trim();

    if (!sanitized) {
      return res.status(400).json({ error: 'Kobo form UID cannot be empty' });
    }

    await saveKoboFormUid(sanitized);
    return res.json({ success: true, message: 'Kobo form UID saved successfully' });
  } catch (error) {
    console.error('Error saving Kobo form UID:', error);
    return res.status(500).json({
      error: 'Failed to save Kobo form UID',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Save/update case template name
app.post('/api/admin/case-template', authenticateAdmin, async (req, res) => {
  try {
    const { caseTemplate } = req.body as { caseTemplate?: string };
    if (!caseTemplate || !caseTemplate.trim()) {
      return res.status(400).json({ error: 'caseTemplate is required' });
    }
    await saveCaseTemplate(caseTemplate.trim());
    return res.json({ success: true, message: 'Case template saved successfully' });
  } catch (error) {
    console.error('Error saving case template:', error);
    return res.status(500).json({
      error: 'Failed to save case template',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Save/update a single vignette
app.post('/api/admin/vignette', authenticateAdmin, requireContentWrite, async (req, res) => {
  try {
    const { id, key, content } = req.body as { id?: number; key?: string; content?: string };
    
    if (!key || !key.trim()) {
      return res.status(400).json({ error: 'Vignette key is required' });
    }
    
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Vignette content cannot be empty' });
    }
    
    // Validate key format (alphanumeric, underscores, and hyphens only)
    if (!/^[a-zA-Z0-9_-]+$/.test(key.trim())) {
      return res.status(400).json({
        error: 'Vignette key must contain only letters, numbers, underscores, and hyphens'
      });
    }
    
    const sanitizedKey = key.trim();
    const sanitizedContent = content.trim().replace(/\0/g, '');
    
    // Check if this key already exists
    const existingVignettes = await getAllVignettes();
    const existingWithKey = existingVignettes.find(v => v.key === sanitizedKey);

    // Save or update the vignette
    if (id !== undefined && id !== null) {
      // Explicit ID: update that specific record
      const existingById = existingVignettes.find(v => v.id === id);
      if (existingById) {
        await updateVignetteById(id, sanitizedKey, sanitizedContent);
      } else {
        return res.status(404).json({ error: 'Vignette not found' });
      }
    } else if (existingWithKey) {
      // Key exists: upsert (update content in place)
      await updateVignetteById(existingWithKey.id!, sanitizedKey, sanitizedContent);
    } else {
      // New vignette
      await saveVignette(sanitizedKey, sanitizedContent);
    }
    
    return res.json({ success: true, message: 'Vignette saved successfully' });
  } catch (error) {
    console.error('Error saving vignette:', error);
    return res.status(500).json({ 
      error: 'Failed to save vignette',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

app.delete('/api/admin/vignette/:key', authenticateAdmin, requireContentWrite, async (req, res) => {
  try {
    const { key } = req.params;
    
    // Check if this would delete the last vignette
    const existingVignettes = await getAllVignettes();
    if (existingVignettes.length <= 1) {
      return res.status(400).json({ 
        error: 'Cannot delete the last vignette',
        details: 'At least one vignette is required for the application to function.'
      });
    }
    
    await deleteVignette(key);
    return res.json({ success: true, message: 'Vignette deleted successfully' });
  } catch (error) {
    console.error('Error deleting vignette:', error);
    return res.status(500).json({ error: 'Failed to delete vignette' });
  }
});

// Swap order of two vignettes
app.post('/api/admin/vignettes/swap', authenticateAdmin, requireContentWrite, async (req, res) => {
  try {
    const { key1, key2 } = req.body as { key1?: string; key2?: string };
    
    if (!key1 || !key2) {
      return res.status(400).json({ error: 'Both key1 and key2 are required' });
    }
    
    await swapVignetteOrder(key1, key2);
    return res.json({ success: true, message: 'Vignette order swapped successfully' });
  } catch (error) {
    console.error('Error swapping vignette order:', error);
    return res.status(500).json({ 
      error: 'Failed to swap vignette order',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get vignettes (optionally filtered by uid assignments)
// Returns only vignette keys - sensitive content stays server-side
app.get('/api/vignettes', requireAccessCode, async (req, res) => {
  try {
    const uid = typeof req.query.uid === 'string' ? req.query.uid.trim() : null;
    const vignettes = await getVignettesForUid(uid);

    // A project that sets requireKnownVignette serves one vignette per deep
    // link (a slide, in the decks project). A link naming a key the deployment
    // does not hold is refused here, so the page can say so; it must never
    // open some other vignette under the requested one's name.
    // ?doc= is an alias of ?vignette=; ?vignette= wins when both are given.
    const wanted = typeof req.query.vignette === 'string' ? req.query.vignette
      : typeof req.query.doc === 'string' ? req.query.doc : null;
    if (wanted !== null) {
      const { requireKnownVignette } = await readProjectFlags(requestProjectSlug(req));
      if (requireKnownVignette && !vignettes.some(v => v.key === wanted)) {
        return res.status(404).json({ error: 'No pack for this vignette', code: 'unknown_vignette' });
      }
    }

    // Return only keys, not content
    res.json({
      vignetteKeys: vignettes.map(v => v.key),
    });
  } catch (error) {
    console.error('Error loading vignettes:', error);
    res.status(500).json({ error: 'Failed to load vignettes' });
  }
});

// Get Kobo form URL (public endpoint)
// NOTE: caseTemplate is NOT returned here - it comes from /api/chat instead
app.get('/api/kobo-url', async (_req, res) => {
  try {
    const koboUrl = await getKoboFormUrl();
    if (!koboUrl) {
      return res.json({
        url: '',
        error: 'No Kobo form URL is configured. Set one in the admin dashboard, or push a project whose project.json declares kobo.formUrl.',
      });
    }
    res.json({ url: koboUrl });
  } catch (error) {
    console.error('Error loading Kobo URL:', error);
    res.status(500).json({ error: 'Failed to load Kobo form URL' });
  }
});

// ── Enketo native-render proxy endpoints ─────────────────────────
// Proxy XForm XML from KoboToolbox (avoids CORS, hides token)
const xformCache = new Map<string, { xml: string; ts: number }>();
const XFORM_CACHE_TTL = 15 * 60 * 1000; // 15 min

// Cache deployment UUID (needed to bridge kf XForm id → kc submission matching)
const deploymentUuidCache = new Map<string, { uuid: string; ts: number }>();

async function getDeploymentUuid(formUid: string, koboToken: string): Promise<string | null> {
  const cached = deploymentUuidCache.get(formUid);
  if (cached && Date.now() - cached.ts < XFORM_CACHE_TTL) return cached.uuid;

  const resp = await fetch(`${KOBO_KF_BASE}/api/v2/assets/${formUid}/`, {
    headers: { Authorization: `Token ${koboToken}` },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const uuid = data.deployment__uuid;
  if (uuid) deploymentUuidCache.set(formUid, { uuid, ts: Date.now() });
  return uuid || null;
}

/**
 * Rewrite submission XML for kc compatibility.
 * kf serves XForms with id="ai_med_diagnosis" (the XForm title-based id),
 * but kc registers the form with id_string=<asset_uid>. We must also inject
 * formhub/uuid so kc can match the submission to the deployed form.
 */
function rewriteSubmissionXml(xml: string, formUid: string, deploymentUuid: string): string {
  // Replace id attribute on root element to match kc's id_string
  let result = xml.replace(
    new RegExp(`(<${formUid}\\s[^>]*?)id="[^"]*"`),
    `$1id="${formUid}"`
  );

  // Inject <formhub><uuid>...</uuid></formhub> as first child of root element
  if (!result.includes('<formhub>')) {
    result = result.replace(
      new RegExp(`(<${formUid}[^>]*>)`),
      `$1<formhub><uuid>${deploymentUuid}</uuid></formhub>`
    );
  }

  return result;
}

app.get('/api/enketo-xform', async (_req, res) => {
  try {
    const koboToken = process.env.KOBO_API_TOKEN;
    if (!koboToken) return res.status(503).json({ error: 'Kobo not configured' });

    const formUid = await getKoboFormUid();
    if (!formUid) return res.status(503).json({ error: 'Kobo form UID not configured' });

    // Check cache (skip in dev mode for faster form iteration)
    const isDev = process.env.NODE_ENV !== 'production';
    if (!isDev) {
      const cached = xformCache.get(formUid);
      if (cached && Date.now() - cached.ts < XFORM_CACHE_TTL) {
        res.type('application/xml').send(cached.xml);
        return;
      }
    }

    const url = `${KOBO_KF_BASE}/api/v2/assets/${formUid}/?format=xml`;
    const resp = await fetch(url, {
      headers: { Authorization: `Token ${koboToken}` },
    });
    if (!resp.ok) {
      console.error('XForm fetch failed:', resp.status, await resp.text());
      return res.status(502).json({ error: 'Failed to fetch XForm from Kobo' });
    }
    const xml = await resp.text();
    xformCache.set(formUid, { xml, ts: Date.now() });
    res.type('application/xml').send(xml);
  } catch (error) {
    console.error('Error fetching XForm:', error);
    res.status(500).json({ error: 'Failed to fetch XForm' });
  }
});

// Proxy submission to KoboToolbox via OpenRosa endpoint
// The legacy v1 endpoint (kc.kobotoolbox.org/api/v1/submissions) is decommissioned
// 2026-06-02. OpenRosa standard endpoint is POST {kf_base}/submission — routes
// by id_string in the XML payload (which rewriteSubmissionXml sets to the asset uid).
app.post('/api/enketo-submit', async (req, res) => {
  try {
    const koboToken = process.env.KOBO_API_TOKEN;
    if (!koboToken) return res.status(503).json({ error: 'Kobo not configured' });

    const formUid = await getKoboFormUid();
    if (!formUid) return res.status(503).json({ error: 'Kobo form UID not configured' });

    const { xmlInstance } = req.body as { xmlInstance?: string };
    if (!xmlInstance) return res.status(400).json({ error: 'xmlInstance is required' });

    // Rewrite XML: kf XForm uses id="ai_med_diagnosis" but OpenRosa routes by
    // id_string=<asset_uid>. Also injects formhub/uuid.
    const deploymentUuid = await getDeploymentUuid(formUid, koboToken);
    const submissionXml = deploymentUuid
      ? rewriteSubmissionXml(xmlInstance, formUid, deploymentUuid)
      : xmlInstance;

    // POST to OpenRosa-standard /submission endpoint as multipart form
    const submitUrl = `${KOBO_KF_BASE}/submission`;
    const formData = new FormData();
    formData.append(
      'xml_submission_file',
      new Blob([submissionXml], { type: 'text/xml' }),
      'submission.xml'
    );

    const submitResp = await fetch(submitUrl, {
      method: 'POST',
      headers: {
        Authorization: `Token ${koboToken}`,
        'X-OpenRosa-Version': '1.0',
      },
      body: formData,
    });

    if (!submitResp.ok) {
      const errText = await submitResp.text();
      console.error('Kobo submission failed:', submitResp.status, errText);
      return res.status(502).json({ error: 'Submission failed', detail: errText });
    }

    // kc v1 returns OpenRosa XML on success (201), not JSON.
    // Try JSON first (some endpoints return it), fall back to XML parsing.
    const respText = await submitResp.text();
    let submissionId: string | null = null;
    try {
      const result = JSON.parse(respText);
      submissionId = result._id || null;
    } catch {
      // OpenRosa XML response — extract submission ID if present
      const idMatch = respText.match(/<submissionMetadata[^>]*instanceID="([^"]*)"/);
      submissionId = idMatch?.[1] || null;
    }
    res.json({ ok: true, submissionId });
  } catch (error) {
    console.error('Error submitting to Kobo:', error);
    res.status(500).json({ error: 'Failed to submit' });
  }
});

// Get current languages configuration (admin only)
app.get('/api/admin/languages', authenticateAdmin, async (_req, res) => {
  try {
    const content = await getLanguages();
    if (!content) {
      return res.status(404).json({ error: 'Languages configuration not found' });
    }
    const json = JSON.parse(content);
    return res.json(json);
  } catch (error) {
    console.error('Error reading languages from database:', error);
    return res.status(500).json({ error: 'Failed to read languages configuration' });
  }
});

// Update languages configuration (admin only)
app.post('/api/admin/languages', authenticateAdmin, async (req, res) => {
  try {
    const newConfig = req.body;
    
    // Validate the structure
    if (!newConfig || typeof newConfig !== 'object') {
      return res.status(400).json({ error: 'Invalid JSON structure' });
    }
    
    if (!Array.isArray(newConfig.languages)) {
      return res.status(400).json({ error: 'Missing or invalid "languages" array' });
    }
    
    if (!newConfig.ui || typeof newConfig.ui !== 'object') {
      return res.status(400).json({ error: 'Missing or invalid "ui" object' });
    }
    
    // Basic validation of languages array
    for (const lang of newConfig.languages) {
      if (!lang.code || !lang.name) {
        return res.status(400).json({ error: 'Each language must have "code" and "name"' });
      }
    }
    
    // Save to database
    const jsonString = JSON.stringify(newConfig, null, 2);
    await saveLanguages(jsonString);
    
    return res.json({ success: true, message: 'Languages configuration updated successfully' });
  } catch (error) {
    console.error('Error updating languages:', error);
    return res.status(500).json({ 
      error: 'Failed to update languages configuration',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get all vignette-to-user assignments (admin only)
app.get('/api/admin/vignette-assignments', authenticateAdmin, async (_req, res) => {
  try {
    const assignments = await getVignetteAssignments();
    return res.json({ assignments });
  } catch (error) {
    console.error('Error fetching vignette assignments:', error);
    return res.status(500).json({ error: 'Failed to fetch vignette assignments' });
  }
});

// Add a vignette assignment for a user (admin only)
app.post('/api/admin/vignette-assignments', authenticateAdmin, async (req, res) => {
  try {
    const { uid, vignetteKey } = req.body as { uid?: string; vignetteKey?: string };
    
    if (!uid || !uid.trim()) {
      return res.status(400).json({ error: 'User ID (uid) is required' });
    }
    
    if (!vignetteKey || !vignetteKey.trim()) {
      return res.status(400).json({ error: 'Vignette key is required' });
    }
    
    // Lookup the vignette ID from the key
    const vignetteId = await getVignetteIdByKey(vignetteKey.trim());
    if (!vignetteId) {
      return res.status(400).json({ error: `Vignette "${vignetteKey}" does not exist` });
    }
    
    const assignment = await addVignetteAssignment(uid.trim(), vignetteId);
    return res.json({ success: true, assignment });
  } catch (error: any) {
    // Handle unique constraint violation (duplicate assignment)
    if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE' || error?.code === '23505') {
      return res.status(400).json({ error: 'This user already has this vignette assigned' });
    }
    console.error('Error adding vignette assignment:', error);
    return res.status(500).json({ 
      error: 'Failed to add vignette assignment',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

interface BulkAssignmentPayloadRow {
  uid?: string;
  vignetteKey?: string;
  'case'?: string;
}

app.post('/api/admin/vignette-assignments/bulk', authenticateAdmin, async (req, res) => {
  try {
    const { assignments } = req.body as { assignments?: BulkAssignmentPayloadRow[] };

    if (!Array.isArray(assignments) || assignments.length === 0) {
      return res.status(400).json({ error: 'No assignments provided' });
    }

    const rowLimit = 5000;
    if (assignments.length > rowLimit) {
      return res.status(400).json({ 
        error: 'Row limit exceeded',
        details: `Maximum ${rowLimit} rows per import`
      });
    }

    const sanitizedRows: Array<{ uid: string; vignetteKey: string }> = [];
    const invalidRows: Array<{ row: number; reason: string; uid?: string; case?: string }> = [];

    assignments.forEach((row, index) => {
      const uidValue = typeof row.uid === 'string' || typeof row.uid === 'number' ? String(row.uid) : '';
      const rawCase = typeof row.case === 'string' || typeof row.case === 'number'
        ? String(row.case)
        : typeof row.vignetteKey === 'string' || typeof row.vignetteKey === 'number'
          ? String(row.vignetteKey)
          : '';

      const uid = uidValue.trim();
      const vignetteKey = rawCase.trim();

      if (!uid || !vignetteKey) {
        invalidRows.push({
          row: index + 1,
          reason: 'uid and case are required',
          uid: uidValue || undefined,
          case: rawCase || undefined,
        });
      } else {
        sanitizedRows.push({ uid, vignetteKey });
      }
    });

    if (invalidRows.length > 0) {
      return res.status(400).json({ error: 'invalid_rows', invalidRows });
    }

    const summary = await bulkAddVignetteAssignments(sanitizedRows);
    return res.json({ success: true, summary });
  } catch (error) {
    if (error instanceof MissingVignetteKeysError) {
      return res.status(400).json({
        error: 'missing_vignettes',
        missingVignetteKeys: error.missingKeys,
      });
    }

    console.error('Error importing vignette assignments:', error);
    return res.status(500).json({ error: 'Failed to import vignette assignments' });
  }
});

// Delete a vignette assignment (admin only)
app.delete('/api/admin/vignette-assignments/:id', authenticateAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid assignment ID' });
    }
    
    await deleteVignetteAssignment(id);
    return res.json({ success: true, message: 'Assignment deleted successfully' });
  } catch (error) {
    console.error('Error deleting vignette assignment:', error);
    return res.status(500).json({ error: 'Failed to delete vignette assignment' });
  }
});

app.delete('/api/admin/vignette-assignments', authenticateAdmin, async (req, res) => {
  try {
    const payload = req.body as { ids?: unknown };
    const ids = Array.isArray(payload?.ids) ? payload.ids : [];

    if (!ids.length) {
      return res.status(400).json({ error: 'At least one assignment ID is required' });
    }

    const parsedIds = ids.map((value) => {
      if (typeof value === 'number') return value;
      if (typeof value === 'string' && value.trim()) return Number(value);
      return NaN;
    });

    if (parsedIds.some((value) => !Number.isInteger(value) || value <= 0)) {
      return res.status(400).json({ error: 'All assignment IDs must be positive integers' });
    }

    const deleted = await deleteVignetteAssignments(parsedIds as number[]);

    return res.json({
      success: true,
      deleted,
      message: deleted === 0
        ? 'No assignments matched the request.'
        : `Deleted ${deleted} assignment${deleted === 1 ? '' : 's'}.`,
    });
  } catch (error) {
    console.error('Error deleting vignette assignments in bulk:', error);
    return res.status(500).json({ error: 'Failed to delete assignments' });
  }
});

// Admin token usage endpoint
app.get('/api/admin/token-usage', authenticateAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const project = activeProjectPrefix() || undefined;
    const summary = await getTokenUsageSummary({ days, project });
    return res.json(summary);
  } catch (error) {
    console.error('Error fetching token usage:', error);
    return res.status(500).json({ error: 'Failed to fetch token usage' });
  }
});

// Admin session engagement stats endpoint
app.get('/api/admin/session-stats', authenticateAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const project = (activeProjectPrefix() || '').replace(/_+$/, '') || 'default';
    const stats = await getSessionStats(project, days);
    return res.json(stats);
  } catch (error) {
    console.error('Error fetching session stats:', error);
    return res.status(500).json({ error: 'Failed to fetch session stats' });
  }
});

// Admin conversation log endpoint.
//
// Reads back the durable qa_log rows written by /api/chat for projects that set
// `logConversations: true` in project.json (formless advisors like haivn_eip,
// whose consent text tells users their questions and answers are logged so the
// project team can improve the tool). This is that read path: the project team's
// own review tool, behind the same admin auth as every other /api/admin route,
// scoped to the project in the X-Project header. Paired CLI:
// tools/export-conversations.ts.
//
// Filters: ?days=N (relative, default 30) or ?since=YYYY-MM-DD[&until=YYYY-MM-DD]
// (absolute, `since` wins over `days`). Paginate with ?limit &?offset; `total`
// counts the whole filtered set so a caller knows when to stop.
app.get('/api/admin/qa-log', authenticateAdmin, async (req, res) => {
  try {
    const project = (activeProjectPrefix() || '').replace(/_+$/, '') || 'default';

    const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
    const since = isDate(req.query.since) ? req.query.since : undefined;
    const until = isDate(req.query.until) ? req.query.until : undefined;
    if ((req.query.since && !since) || (req.query.until && !until)) {
      return res.status(400).json({ error: 'since/until must be YYYY-MM-DD' });
    }

    const days = since ? undefined : (parseInt(req.query.days as string) || 30);
    const limit = Math.max(1, Math.min(parseInt(req.query.limit as string) || 500, QA_LOG_MAX_LIMIT));
    const offset = Math.max(0, parseInt(req.query.offset as string) || 0);

    const { rows, total } = await getQaLog(project, { days, since, until, limit, offset });

    return res.json({
      project,
      days: days ?? null,
      since: since ?? null,
      until: until ?? null,
      limit,
      offset,
      total,
      returned: rows.length,
      hasMore: offset + rows.length < total,
      rows,
    });
  } catch (error) {
    // Never echo row content into logs — this endpoint carries conversation text.
    console.error('Error fetching conversation log:', error);
    return res.status(500).json({ error: 'Failed to fetch conversation log' });
  }
});

// Admin payment source endpoints
app.get('/api/admin/payment-source', authenticateAdmin, async (_req, res) => {
  try {
    const slug = (activeProjectPrefix() || '').replace(/_+$/, '') || 'default';
    const source = await getProjectSetting(slug, 'payment_source');
    return res.json({ source: source || 'harvard' });
  } catch (error) {
    console.error('Error fetching payment source:', error);
    return res.status(500).json({ error: 'Failed to fetch payment source' });
  }
});

app.put('/api/admin/payment-source', authenticateAdmin, requireContentWrite, async (req, res) => {
  try {
    const { source } = req.body as { source?: string };
    if (!source || !['harvard', 'direct'].includes(source)) {
      return res.status(400).json({ error: 'Invalid source. Must be "harvard" or "direct".' });
    }
    if (source === 'direct' && !openaiDirect) {
      return res.status(409).json({ error: new DirectKeyMissingError('Direct billing').message });
    }
    const slug = (activeProjectPrefix() || '').replace(/_+$/, '') || 'default';
    await setProjectSetting(slug, 'payment_source', source);
    console.log(`Payment source for project "${slug}" set to "${source}"`);
    return res.json({ success: true, source });
  } catch (error) {
    console.error('Error saving payment source:', error);
    return res.status(500).json({ error: 'Failed to save payment source' });
  }
});

// Admin public-chat kill switch (only has an effect for projects declaring talkManifest)
app.get('/api/admin/public-chat', authenticateAdmin, async (_req, res) => {
  try {
    const slug = (activeProjectPrefix() || '').replace(/_+$/, '') || 'default';
    return res.json({ enabled: await isPublicChatEnabled(slug) });
  } catch (error) {
    console.error('Error fetching public chat setting:', error);
    return res.status(500).json({ error: 'Failed to fetch public chat setting' });
  }
});

app.put('/api/admin/public-chat', authenticateAdmin, requireContentWrite, async (req, res) => {
  try {
    const { enabled } = req.body as { enabled?: unknown };
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Invalid value. "enabled" must be true or false.' });
    }
    const slug = (activeProjectPrefix() || '').replace(/_+$/, '') || 'default';
    await setProjectSetting(slug, 'public_chat', enabled ? 'on' : 'off');
    console.log(`Public chat for project "${slug}" set to "${enabled ? 'on' : 'off'}"`);
    return res.json({ success: true, enabled });
  } catch (error) {
    console.error('Error saving public chat setting:', error);
    return res.status(500).json({ error: 'Failed to save public chat setting' });
  }
});

// Public languages endpoint (decouples frontend from filesystem sync)
//
// On a project that sets requireAccessCode, `vignetteInfo` (each vignette's
// title and description) is content, not interface text, and is withheld until
// the request holds the access token. The UI strings are always served: the
// gate itself is drawn from them. The frontend re-fetches once unlocked.
// Ungated projects get the file whole, as before.
app.get('/api/languages', async (req, res) => {
  try {
    const content = await getLanguages();
    if (!content) {
      return res.status(404).json({ error: 'Languages configuration not found' });
    }
    const json = JSON.parse(content);
    const state = await accessState(req);
    if (state !== 'open' && state !== 'ok' && json && typeof json === 'object') {
      delete json.vignetteInfo;
    }
    return res.json(json);
  } catch (error) {
    console.error('Error reading languages:', error);
    return res.status(500).json({ error: 'Failed to read languages configuration' });
  }
});

// Public config endpoint (returns non-sensitive deployment config in one call)
app.get('/api/config', async (_req, res) => {
  try {
    const [koboUrl, koboUid, languagesContent] = await Promise.all([
      getKoboFormUrl(),
      getKoboFormUid(),
      getLanguages(),
    ]);

    let languages: Array<{ code: string; name: string }> = [];
    if (languagesContent) {
      try {
        const parsed = JSON.parse(languagesContent);
        languages = parsed.languages || [];
      } catch { /* ignore parse errors */ }
    }

    // The project's flags, resolved from project.json (chat-core project-config.ts):
    // a talk project implies the advisor flags it leaves unset.
    const projectSlug = (activeProjectPrefix() || 'demo').replace(/_+$/, '') || 'demo';
    const projectConfigPath = path.join(REPO_ROOT, 'projects', projectSlug, 'project.json');
    let flags = resolveProjectFlags({});
    try {
      flags = resolveProjectFlags(JSON.parse(await fs.readFile(projectConfigPath, 'utf-8')));
    } catch (error) {
      console.warn(`Could not load project config for ${projectSlug}:`, error);
    }

    res.json({
      koboFormUrl: koboUrl || '',
      koboFormUid: koboUid || '',
      languages,
      tablePrefix: activeProjectPrefix(),
      // Which application the project is: 'simulation' or 'talk'.
      app: flags.app,
      enableFeedback: flags.enableFeedback,
      enableVoice: flags.enableVoice,
      enableRealtime: flags.enableRealtime,
      formless: flags.formless,
      enableFollowups: flags.enableFollowups,
      skipWelcome: flags.skipWelcome,
      dragDropAllocation: flags.dragDropAllocation,
      requireAccessCode: flags.requireAccessCode,
      chatOnly: flags.chatOnly,
      // The frontend must refuse a deep link whose vignette is unknown (or
      // absent) instead of opening the first vignette. See /api/vignettes.
      requireKnownVignette: flags.requireKnownVignette,
      // Only the flag (the frontend then resolves ?paper=<DOI> against
      // /api/talk-manifest/<slug>); the manifest path is a server-side detail.
      talkManifest: flags.talkManifest,
      // A top-level visit to a talkManifest project is redirected here.
      talkPublicUrl: flags.talkPublicUrl,
      // Document-reference linking config (frontend doc-refs.ts), or null.
      docRefs: flags.docRefs,
    });
  } catch (error) {
    console.error('Error reading config:', error);
    res.status(500).json({ error: 'Failed to read configuration' });
  }
});

// Tabs endpoint: returns tab structure + content for the active project.
// Reads project.json and resolves each tab's contentFile from the filesystem.
// Returns [] for projects that don't declare tabs in project.json.
app.get('/api/tabs', requireAccessCode, async (req, res) => {
  try {
    const projectSlug = (activeProjectPrefix() || 'demo').replace(/_+$/, '') || 'demo';
    const projectConfigPath = path.join(REPO_ROOT, 'projects', projectSlug, 'project.json');

    // A tab may point at one file, or at one file per language. Reject anything
    // that isn't a bare ISO 639-1 code so a crafted value can't reach the lookup.
    const langParam = typeof req.query.lang === 'string' ? req.query.lang : '';
    const lang = /^[a-z]{2}$/.test(langParam) ? langParam : 'en';

    type TabLabel = string | Record<string, string>;
    type TabContentFile = string | Record<string, string>;
    let projectConfig: { tabs?: Array<{ id: string; type: string; order?: number; pinned?: boolean; label?: TabLabel; contentFile?: TabContentFile; showForVignetteKeys?: string[] }> };
    try {
      const configContent = await fs.readFile(projectConfigPath, 'utf-8');
      projectConfig = JSON.parse(configContent);
    } catch (error) {
      // Project has no project.json or can't be read — return empty, frontend falls back to langs.tabs.
      // Log as error (not warn) so deploy-time issues surface in logs.
      const e = error as NodeJS.ErrnoException;
      if (e?.code !== 'ENOENT') {
        console.error(`/api/tabs: failed to read project.json for ${projectSlug}:`, e?.message || e);
      }
      return res.json({ tabs: [] });
    }

    if (!Array.isArray(projectConfig.tabs) || projectConfig.tabs.length === 0) {
      return res.json({ tabs: [] });
    }

    const resolvedTabs = await Promise.all(
      projectConfig.tabs.map(async (tab) => {
        const base: Record<string, unknown> = {
          id: tab.id,
          type: tab.type,
          order: tab.order ?? 999,
          pinned: tab.pinned ?? false,
        };
        if (Array.isArray(tab.showForVignetteKeys) && tab.showForVignetteKeys.length > 0) {
          base.showForVignetteKeys = tab.showForVignetteKeys;
        }

        // Resolve the language variant, falling back to English then to whatever
        // single variant the tab declares.
        const contentFile = typeof tab.contentFile === 'string'
          ? tab.contentFile
          : (tab.contentFile?.[lang] ?? tab.contentFile?.['en'] ?? Object.values(tab.contentFile ?? {})[0]);

        if (!contentFile) {
          return { ...base, label: tab.label, content: null };
        }

        try {
          // Resolved from the checkout, or from the private store for content that
          // is deliberately not in git (see resolveProjectContentFile). Anything
          // outside projects/ resolves to null.
          const contentPath = await resolveProjectContentFile(contentFile);
          if (!contentPath) {
            // A PDF tab whose file has not been uploaded yet would open onto a 404;
            // leave the tab out instead, so the reader never sees a dead viewer.
            if (contentFile.endsWith('.pdf')) {
              console.warn(`/api/tabs: ${projectSlug}: ${contentFile} is in neither the checkout ` +
                           'nor the private store; leaving tab ' + tab.id + ' out');
              return null;
            }
            console.error(`/api/tabs: contentFile not found or outside projects/: ${contentFile}`);
            return { ...base, label: tab.label, content: null };
          }
          // PDFs are served via a dedicated endpoint — return a URL, don't read binary as text.
          if (contentFile.endsWith('.pdf')) {
            return { ...base, label: tab.label, content: { pdfUrl: `/api/project-content/${contentFile}` } };
          }
          const raw = await fs.readFile(contentPath, 'utf-8');
          // Markdown files are wrapped in {markdown: string}; JSON files are parsed as-is.
          // Label resolution: tab.label (from project.json) takes precedence over content.label.
          if (contentFile.endsWith('.md')) {
            return { ...base, label: tab.label, content: { markdown: raw } };
          }
          const parsed = JSON.parse(raw);
          const label = tab.label ?? parsed?.label;
          return { ...base, label, content: parsed };
        } catch (error) {
          console.error(`/api/tabs: failed to load contentFile ${contentFile}:`, error instanceof Error ? error.message : error);
          return { ...base, label: tab.label, content: null };
        }
      })
    );

    res.json({ tabs: resolvedTabs.filter(t => t !== null) });
  } catch (error) {
    console.error('Error reading tabs config:', error);
    res.status(500).json({ error: 'Failed to read tabs configuration' });
  }
});

// Serve project content files (PDFs, images, etc.)
// from the checkout or the private store (see resolveProjectContentFile).
app.get('/api/project-content/*', requireAccessCode, async (req, res) => {
  const relativePath = req.params[0];
  if (!relativePath) return res.status(400).json({ error: 'No path specified' });
  if (!projectContentRelPath(relativePath)) return res.status(403).json({ error: 'Access denied' });
  const filePath = await resolveProjectContentFile(relativePath);
  if (!filePath) return res.status(404).json({ error: 'Not found' });
  res.sendFile(filePath);
});

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    hasOpenAIKey: !!openai.apiKey,
    // Booleans only: the gateway host is never exposed.
    usesHarvardGateway: openaiClients().usesGateway,
    hasDirectOpenAIKey: !!openaiDirect,
    tableName: getTableName(),
    assignmentsTableName: getAssignmentsTableName(),
    tablePrefix: activeProjectPrefix() || 'not set',
  });
});

// SPA catch-all: serve React app in production (unless SERVE_FRONTEND=false)
if (process.env.NODE_ENV === 'production' && serveFrontend) {
  const staticDir = process.env.STATIC_DIR || path.join(__dirname, '../../frontend-chat/dist');
  app.get('*', (_req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📝 API available at http://localhost:${PORT}/api`);
  
  // OPENAI_API_KEY is guaranteed here: openaiClients() throws at startup without it.
  console.log(`✅ OpenAI: chat/grading via ${openaiClients().usesGateway ? 'Harvard gateway (HARVARD_GATEWAY_URL)' : 'api.openai.com'}; direct key ${openaiDirect ? 'configured' : 'absent'}`);
});
