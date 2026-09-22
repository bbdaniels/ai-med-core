#!/usr/bin/env npx tsx
/**
 * push-content.ts
 *
 * Push cases, system prompt, Kobo URL, and languages from a project.json
 * definition to a running deployment via its admin API.
 *
 * Private files (gitignored by design: the papers project's paper texts and
 * PDFs, see tools/lib/private-files.ts) are pushed when this checkout has them
 * and skipped, with the deployed copy left in place, when it does not. So CI's
 * push keeps everything else current, and the author's push after a rebuild
 * (`npx tsx tools/push-content.ts papers --url ...`) delivers the private files.
 * Private tab files (PDFs) go to the deployment's private store on its volume;
 * vignette text goes to the database like any other vignette.
 *
 * Usage:
 *   DEPLOY_URL=https://... npx tsx tools/push-content.ts <project-name>
 *   npx tsx tools/push-content.ts <project-name> --dry-run
 *   npx tsx tools/push-content.ts <project-name> --local   # push to localhost dev server
 *   npx tsx tools/push-content.ts <project-name> --url <base-url>  # override DEPLOY_URL
 */

import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { AdminApiClient } from './lib/api-client.js';
import { isPrivateFile, tabContentFiles } from './lib/private-files.js';

interface ProjectJson {
  name: string;
  displayName: string;
  frontend: string;
  cases: {
    systemPrompt: string;
    vignettes: Array<{ key: string; template: string; file: string; title?: string }>;
  };
  // Optional: formless projects (e.g. document Q&A chatbots) omit the kobo block entirely
  kobo?: {
    template: string;
    formUid: string | null;
    formUrl: string | null;
  };
  languages: string[];
  enableFeedback?: boolean;
  formless?: boolean;
  tabs?: Array<{ contentFile?: string | Record<string, string> }>;
  deployment: {
    tablePrefix: string;
  };
}

async function loadProject(projectName: string): Promise<ProjectJson> {
  const projectPath = path.resolve('projects', projectName, 'project.json');
  const raw = await fs.readFile(projectPath, 'utf8');
  return JSON.parse(raw);
}

async function readFile(filePath: string): Promise<string> {
  return fs.readFile(path.resolve(filePath), 'utf8');
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(path.resolve(filePath)).then(() => true, () => false);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const isLocal = args.includes('--local');
  const urlFlagIdx = args.indexOf('--url');
  const urlOverride = urlFlagIdx !== -1 ? args[urlFlagIdx + 1] : undefined;
  const projectName = args.find(a => !a.startsWith('--') && (urlFlagIdx === -1 || a !== args[urlFlagIdx + 1]));

  if (!projectName) {
    console.error('Usage: npx tsx tools/push-content.ts <project-name> [--dry-run] [--local] [--url <base-url>]');
    process.exit(1);
  }

  console.log(`Loading project: ${projectName}`);
  const project = await loadProject(projectName);

  // Resolve target URL: --local > --url > DEPLOY_URL env var
  const baseUrl = isLocal
    ? `http://localhost:${process.env.PORT || 3001}`
    : urlOverride || process.env.DEPLOY_URL;

  if (!baseUrl) {
    console.error('No deployment URL. Set DEPLOY_URL env var, use --url <url>, or --local.');
    process.exit(1);
  }

  const passphrase = process.env.ADMIN_PASSPHRASE;
  if (!passphrase) {
    console.error('ADMIN_PASSPHRASE environment variable is required');
    process.exit(1);
  }

  const client = new AdminApiClient({
    baseUrl,
    passphrase,
    project: project.deployment.tablePrefix || undefined,
  });

  // Health check + readiness gate.
  // The backend's X-Project allowlist is computed from the projects/ directory at STARTUP.
  // If a new or renamed project is pushed before the backend has redeployed, the X-Project
  // header is rejected and all writes silently land in the default (unprefixed) tables.
  // Poll briefly until the backend recognizes this project, otherwise fail loudly.
  const expectedPrefix = project.deployment.tablePrefix
    ? `${project.deployment.tablePrefix.replace(/_+$/, '')}_`
    : '';
  console.log(`Checking deployment at ${baseUrl}...`);
  // A failed request (502 while Railway restarts, connection refused, timeout) is
  // "not ready" too, not a fatal error: the push runs on the same trigger as the
  // backend redeploy and routinely lands inside the restart window.
  const readinessDeadline = Date.now() + 180_000; // 3 min
  const probe = async (): Promise<{ tablePrefix?: string; error?: string }> => {
    try {
      return await client.healthCheck();
    } catch (e) {
      return { error: (e as Error).message };
    }
  };
  let health = await probe();
  let attempt = 1;
  const notReady = () => health.error !== undefined || (expectedPrefix !== '' && health.tablePrefix !== expectedPrefix);
  while (notReady() && Date.now() < readinessDeadline) {
    const why = health.error
      ? `health check failed (${health.error})`
      : `expected prefix "${expectedPrefix}", got "${health.tablePrefix || '(not set)'}"`;
    console.log(`  Attempt ${attempt}: ${why}. Backend not ready — waiting 10s...`);
    await new Promise(r => setTimeout(r, 10_000));
    attempt += 1;
    health = await probe();
  }
  if (health.error) {
    console.error(`ABORT: backend unreachable after 3 minutes (${health.error}). Re-run the workflow once Railway's deploy is green.`);
    process.exit(1);
  }
  if (expectedPrefix && health.tablePrefix !== expectedPrefix) {
    console.error(
      `ABORT: backend rejected X-Project "${project.deployment.tablePrefix}" after ${Math.round((Date.now() - (readinessDeadline - 180_000)) / 1000)}s. ` +
      `Expected tablePrefix "${expectedPrefix}", got "${health.tablePrefix || '(not set)'}". ` +
      `This usually means the backend (Railway) has not redeployed the new projects/ directory yet. ` +
      `Re-run the workflow once Railway's deploy is green.`
    );
    process.exit(1);
  }
  console.log(`  Status: ${health.status}, Table prefix: ${health.tablePrefix}`);

  // Push system prompt
  if (project.cases.systemPrompt) {
    const content = await readFile(project.cases.systemPrompt);
    console.log(`System prompt: ${project.cases.systemPrompt} (${content.length} chars)`);
    if (!dryRun) {
      await client.saveSystemPrompt(content);
      console.log('  Pushed.');
    }
  }

  // Push vignettes
  const localKeys = new Set(project.cases.vignettes.map(v => v.key));
  let privateVignettesSkipped = 0;
  for (const vignette of project.cases.vignettes) {
    if (!(await exists(vignette.file)) && isPrivateFile(vignette.file)) {
      // Kept out of git by design; the key stays in localKeys, so the deployed
      // copy is not treated as stale below.
      console.log(`Vignette "${vignette.key}": ${vignette.file} is private (gitignored) and not in this checkout; deployed copy left in place.`);
      privateVignettesSkipped++;
      continue;
    }
    const content = await readFile(vignette.file);
    console.log(`Vignette "${vignette.key}": ${vignette.file} (${content.length} chars)`);
    if (!dryRun) {
      await client.saveVignette(vignette.key, content);
      console.log('  Pushed.');
    }
  }

  // Remove remote vignettes not in project.json
  const remote = await client.getContent();
  const staleKeys = remote.vignettes
    .map((v: { key: string }) => v.key)
    .filter((k: string) => !localKeys.has(k));
  for (const key of staleKeys) {
    console.log(`Removing stale vignette "${key}"`);
    if (!dryRun) {
      await client.deleteVignette(key);
      console.log('  Deleted.');
    }
  }

  // Push Kobo URL + UID if configured (formless projects skip this)
  if (project.kobo?.formUrl) {
    console.log(`Kobo URL: ${project.kobo.formUrl}`);
    if (!dryRun) {
      await client.saveKoboUrl(project.kobo.formUrl);
      console.log('  Pushed.');
    }
  }

  if (project.kobo?.formUid) {
    console.log(`Kobo UID: ${project.kobo.formUid}`);
    if (!dryRun) {
      await client.saveKoboUid(project.kobo.formUid);
      console.log('  Pushed.');
    }
  }

  if (!project.kobo) {
    console.log('Formless project (no kobo config) — skipping Kobo URL/UID push');
  }

  // Push vignette assignments (look for assignments.json in the project dir)
  const assignmentsPath = path.resolve('projects', projectName, 'assignments.json');
  try {
    const assignmentsRaw = await fs.readFile(assignmentsPath, 'utf8');
    const local = JSON.parse(assignmentsRaw) as Array<{ uid: string; vignette_key: string }>;
    console.log(`Assignments: ${assignmentsPath} (${local.length} rows)`);

    const { assignments: remote } = await client.getAssignments();
    const pairKey = (r: { uid: string; vignette_key: string }) => `${r.uid}||${r.vignette_key}`;
    const localSet = new Set(local.map(pairKey));
    const remoteByPair = new Map(remote.map(r => [pairKey(r), r]));
    const toDelete = remote.filter(r => !localSet.has(pairKey(r)));
    const toAdd = local.filter(l => !remoteByPair.has(pairKey(l)));
    console.log(`  Diff vs remote: -${toDelete.length} / +${toAdd.length}`);

    if (!dryRun) {
      for (const row of toDelete) {
        await client.deleteAssignment(row.id);
      }
      if (toAdd.length > 0) {
        await client.bulkAddAssignments(
          toAdd.map(r => ({ uid: r.uid, vignetteKey: r.vignette_key }))
        );
      }
      if (toDelete.length > 0 || toAdd.length > 0) {
        console.log('  Synced.');
      } else {
        console.log('  Already in sync.');
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log('No assignments.json in project directory, skipping.');
    } else {
      throw err;
    }
  }

  // Push languages (look for a languages.json in the project dir)
  const langPath = path.resolve('projects', projectName, 'languages.json');
  try {
    const langContent = await fs.readFile(langPath, 'utf8');
    const langConfig = JSON.parse(langContent);
    console.log(`Languages: ${langPath} (${langConfig.languages?.length || 0} languages)`);
    if (!dryRun) {
      await client.saveLanguages(langConfig);
      console.log('  Pushed.');
    }
  } catch {
    console.log('No languages.json in project directory, skipping.');
  }

  // Push case template (project display name + list of templates + per-vignette mapping)
  const templates = [...new Set(project.cases.vignettes.map(v => v.template))];
  if (templates.length > 0) {
    const title = project.displayName || templates.join(', ');
    const vignetteTemplates: Record<string, string> = {};
    for (const v of project.cases.vignettes) {
      vignetteTemplates[v.key] = v.template;
    }
    const caseTemplateJson = JSON.stringify({ name: templates.join(', '), title, vignetteTemplates });
    console.log(`Case template: ${templates.join(', ')} ("${title}"), ${Object.keys(vignetteTemplates).length} vignette mappings`);
    if (!dryRun) {
      await client.saveCaseTemplate(caseTemplateJson);
      console.log('  Pushed.');
    }
  }

  // Private tab files (PDFs kept out of git) -> the deployment's private store.
  const privateFiles = tabContentFiles(project).filter(isPrivateFile);
  if (privateFiles.length > 0) {
    const store = await client.listPrivateContent();
    const present: string[] = [];
    for (const rel of privateFiles) if (await exists(rel)) present.push(rel);
    console.log(`Private content: ${privateFiles.length} file(s) named, ${present.length} in this checkout`);
    if (!store.configured) {
      if (present.length > 0) {
        console.error('ABORT: the deployment has no private store (PRIVATE_CONTENT_ROOT is not set), ' +
                      `so ${present.length} private file(s) cannot be delivered. Set it to a path on the ` +
                      'mounted volume (e.g. /data/private-content) and re-run.');
        process.exit(1);
      }
      console.log('  Deployment has no private store and this checkout has none of the files; skipping.');
    } else {
      const remote = new Map(store.files.map(f => [f.path, f.sha256]));
      let uploaded = 0;
      for (const rel of present) {
        const buf = await fs.readFile(path.resolve(rel));
        const sha = createHash('sha256').update(buf).digest('hex');
        if (remote.get(rel) === sha) continue;
        console.log(`  Upload ${rel} (${Math.round(buf.length / 1000)} KB)`);
        if (!dryRun) await client.putPrivateContent(rel, buf);
        uploaded++;
      }
      const named = new Set(privateFiles);
      const stale = store.files.map(f => f.path).filter(p => !named.has(p));
      for (const rel of stale) {
        console.log(`  Remove ${rel} (no longer named in project.json)`);
        if (!dryRun) await client.deletePrivateContent(rel);
      }
      const missingEverywhere = privateFiles.filter(rel => !present.includes(rel) && !remote.has(rel));
      console.log(`  ${uploaded} uploaded, ${present.length - uploaded} unchanged, ${stale.length} removed` +
                  (present.length < privateFiles.length
                    ? `; ${privateFiles.length - present.length} not in this checkout (deployed copies left in place)` : ''));
      if (missingEverywhere.length > 0) {
        console.warn(`  WARNING: ${missingEverywhere.length} private file(s) are neither here nor deployed; ` +
                     'their tabs stay hidden until pushed from a checkout that has them.');
      }
    }
  }

  if (privateVignettesSkipped > 0) {
    console.log(`\nNOTE: ${privateVignettesSkipped} private vignette(s) were not in this checkout and were left as deployed. ` +
                `After rebuilding them, push from a checkout that has them: npx tsx tools/push-content.ts ${projectName} --url <deployment-url>`);
  }

  if (dryRun) {
    console.log('\n(Dry run -- no changes made)');
  } else {
    console.log('\nAll content pushed successfully.');
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
