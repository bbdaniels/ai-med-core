#!/usr/bin/env npx tsx
/**
 * manage-kobo.ts
 *
 * Manage Kobo forms for AI-MED projects. Wraps the KoboToolbox MCP tools
 * and maintains the kobo/registry.json mapping.
 *
 * This script is designed to be run by Claude Code or manually via npx tsx.
 *
 * Commands:
 *   npx tsx tools/manage-kobo.ts list                    # List all forms
 *   npx tsx tools/manage-kobo.ts status <project-name>   # Show form status for a project
 *   npx tsx tools/manage-kobo.ts register <project-name> <form-uid> <form-url>  # Register a form
 *   npx tsx tools/manage-kobo.ts sync-registry           # Sync registry from all project.json files
 *
 * Note: deploy and replace commands use KoboToolbox MCP tools directly
 * (mcp__kobotoolbox__deploy_form, mcp__kobotoolbox__replace_form)
 * since they require file paths. Claude Code should call those MCP tools
 * and then run `register` to update the registry.
 *
 * MCP Tool Reference (for Claude Code):
 *   - mcp__kobotoolbox__list_forms          → List all forms
 *   - mcp__kobotoolbox__get_form(uid)       → Get form structure
 *   - mcp__kobotoolbox__get_submissions(uid) → Get form responses
 *   - mcp__kobotoolbox__deploy_form(path)   → Deploy new XLSForm
 *   - mcp__kobotoolbox__replace_form(uid, path) → Update existing form
 *   - mcp__kobotoolbox__export_data(uid)    → Export submission data
 */

import fs from 'fs/promises';
import path from 'path';

interface KoboRegistryEntry {
  projectName: string;
  templateFile: string;
  formUid: string;
  formUrl: string;
  formName: string;
  deployedAt: string;
  submissionCount?: number;
}

interface KoboRegistry {
  forms: Record<string, KoboRegistryEntry>;
}

interface ProjectJson {
  name: string;
  kobo: {
    template: string;
    formUid: string | null;
    formUrl: string | null;
  };
}

const REGISTRY_PATH = path.resolve('kobo/registry.json');
const PROJECTS_DIR = path.resolve('projects');

async function loadRegistry(): Promise<KoboRegistry> {
  try {
    const raw = await fs.readFile(REGISTRY_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { forms: {} };
  }
}

async function saveRegistry(registry: KoboRegistry): Promise<void> {
  await fs.writeFile(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

async function loadProject(name: string): Promise<ProjectJson> {
  const projectPath = path.join(PROJECTS_DIR, name, 'project.json');
  const raw = await fs.readFile(projectPath, 'utf8');
  return JSON.parse(raw);
}

// --- Commands ---

async function listForms(): Promise<void> {
  // This is a convenience wrapper. In practice, Claude Code should call
  // mcp__kobotoolbox__list_forms directly for richer output.
  const registry = await loadRegistry();
  const entries = Object.entries(registry.forms);

  if (entries.length === 0) {
    console.log('No forms registered. Use `register` to add forms to the registry.');
    return;
  }

  console.log('Registered Kobo forms:\n');
  for (const [projectName, entry] of entries) {
    console.log(`  ${projectName}`);
    console.log(`    Form: ${entry.formName || '(unnamed)'}`);
    console.log(`    UID:  ${entry.formUid}`);
    console.log(`    URL:  ${entry.formUrl}`);
    console.log(`    Template: ${entry.templateFile}`);
    console.log(`    Deployed: ${entry.deployedAt}`);
    if (entry.submissionCount !== undefined) {
      console.log(`    Submissions: ${entry.submissionCount}`);
    }
    console.log('');
  }
}

async function showStatus(projectName: string): Promise<void> {
  const registry = await loadRegistry();
  const entry = registry.forms[projectName];

  if (!entry) {
    console.log(`No Kobo form registered for project "${projectName}".`);
    console.log('Use mcp__kobotoolbox__deploy_form to deploy a form, then register it.');
    return;
  }

  console.log(`Kobo form for "${projectName}":`);
  console.log(`  Name:      ${entry.formName || '(unnamed)'}`);
  console.log(`  UID:       ${entry.formUid}`);
  console.log(`  URL:       ${entry.formUrl}`);
  console.log(`  Template:  ${entry.templateFile}`);
  console.log(`  Deployed:  ${entry.deployedAt}`);
  console.log('');
  console.log('To check submissions, run:');
  console.log(`  mcp__kobotoolbox__get_submissions({ form_uid: "${entry.formUid}" })`);
  console.log('To export data:');
  console.log(`  mcp__kobotoolbox__export_data({ form_uid: "${entry.formUid}" })`);
}

async function registerForm(
  projectName: string,
  formUid: string,
  formUrl: string,
  formName?: string,
  templateFile?: string
): Promise<void> {
  const registry = await loadRegistry();

  // Try to get template from project.json if not provided
  let template = templateFile || '';
  if (!template) {
    try {
      const project = await loadProject(projectName);
      template = project.kobo.template || '';
    } catch {
      // No project.json, that's fine
    }
  }

  registry.forms[projectName] = {
    projectName,
    templateFile: template,
    formUid,
    formUrl,
    formName: formName || '',
    deployedAt: new Date().toISOString(),
  };

  await saveRegistry(registry);
  console.log(`Registered form for "${projectName}":`);
  console.log(`  UID: ${formUid}`);
  console.log(`  URL: ${formUrl}`);

  // Also update project.json if it exists
  try {
    const projectPath = path.join(PROJECTS_DIR, projectName, 'project.json');
    const raw = await fs.readFile(projectPath, 'utf8');
    const project = JSON.parse(raw);
    project.kobo.formUid = formUid;
    project.kobo.formUrl = formUrl;
    await fs.writeFile(projectPath, JSON.stringify(project, null, 2) + '\n', 'utf8');
    console.log(`  Updated projects/${projectName}/project.json`);
  } catch {
    // No project.json to update
  }
}

async function syncRegistry(): Promise<void> {
  const registry = await loadRegistry();
  const dirs = (await fs.readdir(PROJECTS_DIR, { withFileTypes: true }))
    .filter(d => d.isDirectory())
    .map(d => d.name);
  let updated = 0;

  for (const name of dirs) {
    try {
      const project = await loadProject(name);
      if (project.kobo.formUid && project.kobo.formUrl) {
        if (!registry.forms[name] || registry.forms[name].formUid !== project.kobo.formUid) {
          registry.forms[name] = {
            projectName: name,
            templateFile: project.kobo.template || '',
            formUid: project.kobo.formUid,
            formUrl: project.kobo.formUrl,
            formName: '',
            deployedAt: new Date().toISOString(),
          };
          updated++;
          console.log(`  Synced: ${name} → ${project.kobo.formUid}`);
        }
      }
    } catch (err) {
      console.warn(`  Skipped ${name}: ${(err as Error).message}`);
    }
  }

  if (updated > 0) {
    await saveRegistry(registry);
    console.log(`\nRegistry updated with ${updated} form(s).`);
  } else {
    console.log('Registry already up to date.');
  }
}

// --- CLI ---

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'list':
      await listForms();
      break;

    case 'status':
      if (!args[0]) {
        console.error('Usage: manage-kobo.ts status <project-name>');
        process.exit(1);
      }
      await showStatus(args[0]);
      break;

    case 'register':
      if (args.length < 3) {
        console.error('Usage: manage-kobo.ts register <project-name> <form-uid> <form-url> [form-name] [template-file]');
        process.exit(1);
      }
      await registerForm(args[0], args[1], args[2], args[3], args[4]);
      break;

    case 'sync-registry':
      await syncRegistry();
      break;

    default:
      console.log(`manage-kobo.ts - Kobo form management for AI-MED projects

Commands:
  list                                          List registered forms
  status <project>                              Show form status for a project
  register <project> <uid> <url> [name] [tpl]   Register a deployed form
  sync-registry                                 Sync registry from project.json files

MCP Tools (use directly via Claude Code):
  mcp__kobotoolbox__list_forms                  List all Kobo forms
  mcp__kobotoolbox__get_form(uid)               Get form structure
  mcp__kobotoolbox__get_submissions(uid)         Get responses
  mcp__kobotoolbox__deploy_form(path)           Deploy new XLSForm
  mcp__kobotoolbox__replace_form(uid, path)     Update existing form
  mcp__kobotoolbox__export_data(uid)            Export data`);
      break;
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
