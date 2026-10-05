/**
 * Startup and first use of a project: open the connection, create tables, and
 * seed content that is missing. Seeding writes both owners' rows (the engine's
 * prompt, documents and languages; the simulator's Kobo form), so it sits above
 * both stores.
 */
import fs from 'fs/promises';
import path from 'path';
import { REPO_ROOT, PACKAGE_DEFAULTS_DIR } from '../repo-root.js';
import { connectDatabase, createProjectSchema, dbType, runWithProject, sanitizeTablePrefix } from './connection.js';
import { getSystemPrompt, saveSystemPrompt, getCustomVignettes, saveVignette, getLanguages, saveLanguages } from './engine-store.js';
import { getKoboFormUrl, saveKoboFormUrl, saveKoboFormUid } from './sim-store.js';

// Ensure database tables exist for a given project prefix (creates if needed).
//
// One promise per prefix, held from the first request on, and every request for
// that project awaits it: the tables AND the seed. A page's first load sends
// several requests at once; when only a Set of finished prefixes was kept (and
// the prefix went in before seeding), the second and third requests read empty
// tables while the first was still seeding -- /api/languages answered 404, and
// the talk page asked the model for an opening instead of using the languages
// file's openingMessage (first-use-seed.test.ts). A failed attempt is forgotten,
// so the next request tries again.
const projectInit = new Map<string, Promise<void>>();

export function ensureProjectTables(prefix: string): Promise<void> {
  const sanitized = sanitizeTablePrefix(prefix);
  let pending = projectInit.get(sanitized);
  if (!pending) {
    // Run schema creation within the project context so activeAdminTable/activeAssignmentsTable resolve correctly
    pending = runWithProject(prefix, async () => {
      await createProjectSchema();
      console.log(`✅ Ensured tables for project prefix: ${sanitized || '(default)'}`);
      await seedProjectFromFilesIfEmpty(sanitized.replace(/_+$/, ''));
    });
    projectInit.set(sanitized, pending);
    pending.catch(() => projectInit.delete(sanitized));
  }
  return pending;
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

    const projectDir = path.join(REPO_ROOT, 'projects', slug);

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
      await saveSystemPrompt(await fs.readFile(path.resolve(REPO_ROOT, promptPath), 'utf8'));
      console.log('  ✓ System prompt seeded');
    }

    const vignettes = Array.isArray(config?.cases?.vignettes) ? config.cases.vignettes : [];
    let sortOrder = 0;
    for (const vignette of vignettes) {
      if (!vignette?.key || !vignette?.file) continue;
      let content: string;
      try {
        content = await fs.readFile(path.resolve(REPO_ROOT, vignette.file), 'utf8');
      } catch (error) {
        // A private vignette (gitignored, e.g. a paper's full text) is absent from
        // a checkout that was never given it. Skip it and seed the rest: aborting
        // here left the project half seeded (prompt saved, languages not), and
        // because the prompt was then present the seed never ran again.
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
        console.log(`  ℹ Vignette "${vignette.key}" skipped: ${vignette.file} is not in this checkout`);
        continue;
      }
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
  await connectDatabase();
  if (dbType === 'postgres') {
    console.log('🌱 Checking if seeding is needed...');
  }
  await seedDefaultsIfNeeded();

  // Mark the startup prefix as initialized so ensureProjectTables skips it
  const startupPrefix = sanitizeTablePrefix(process.env.TABLE_PREFIX);
  projectInit.set(startupPrefix, Promise.resolve());
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
      const vignettesPath = path.join(PACKAGE_DEFAULTS_DIR, 'vignettes.json');
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
        const languagesTemplatePath = path.join(PACKAGE_DEFAULTS_DIR, 'languages.template.json');
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
