#!/usr/bin/env npx tsx
/**
 * push-content.ts
 *
 * Push cases, system prompt, Kobo URL, and languages from a project.json
 * definition to a running deployment via its admin API.
 *
 * Usage:
 *   DEPLOY_URL=https://... npx tsx tools/push-content.ts <project-name>
 *   npx tsx tools/push-content.ts <project-name> --dry-run
 *   npx tsx tools/push-content.ts <project-name> --local   # push to localhost dev server
 *   npx tsx tools/push-content.ts <project-name> --url <base-url>  # override DEPLOY_URL
 */

import fs from 'fs/promises';
import path from 'path';
import { AdminApiClient } from './lib/api-client.js';

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
  const readinessDeadline = Date.now() + 180_000; // 3 min
  let health = await client.healthCheck();
  let attempt = 1;
  while (
    expectedPrefix &&
    health.tablePrefix !== expectedPrefix &&
    Date.now() < readinessDeadline
  ) {
    console.log(
      `  Attempt ${attempt}: expected prefix "${expectedPrefix}", got "${health.tablePrefix || '(not set)'}". Backend not ready — waiting 10s...`
    );
    await new Promise(r => setTimeout(r, 10_000));
    attempt += 1;
    health = await client.healthCheck();
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
  for (const vignette of project.cases.vignettes) {
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
