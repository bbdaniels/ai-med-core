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
 *   npx tsx tools/manage-kobo.ts register <project-name> <form-uid> <form-url>  # Update project.json, print the registry entry
 *   npx tsx tools/manage-kobo.ts sync-registry           # Report registry/project.json disagreements (read-only)
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

// The shape below is the shape kobo/registry.json actually has on disk: a form
// *family* (one XLSForm template) keyed by form name, each with one deployment
// per project slug.
//
//   { "forms": { "macy-hms-diagnosis": {
//       "template": "projects/macy_hms/forms/diagnosis.json",
//       "deployments": { "macy_hms": { "uid": "...", "name": "...", "owner": "..." } } } } }
//
// This file previously declared a flat, unrelated shape — projectName /
// templateFile / formUid / formUrl / deployedAt keyed by project slug. Nothing
// on disk ever had those fields, so `list` printed `undefined` for every value
// and `status` reported every project as unregistered, while `register` and
// `sync-registry` wrote flat entries alongside the real nested ones and left
// the file incoherent.
//
// Note what the on-disk shape does NOT carry: a form URL, or a deployment
// timestamp. `register` and `sync-registry` were built to persist both, so they
// cannot round-trip into this file without changing its schema. Rather than
// invent a schema here, they now refuse to write and print exactly what to add.
interface KoboDeployment {
  uid: string;
  name: string;
  owner: string;
}

interface KoboFormEntry {
  template: string;
  deployments: Record<string, KoboDeployment>;
}

interface KoboRegistry {
  forms: Record<string, KoboFormEntry>;
}

/** Locate a project's deployment. Deployments are keyed by project slug, nested under a form family. */
function findDeployment(
  registry: KoboRegistry,
  projectSlug: string
): { formKey: string; form: KoboFormEntry; deployment: KoboDeployment } | null {
  for (const [formKey, form] of Object.entries(registry.forms || {})) {
    const deployment = (form.deployments || {})[projectSlug];
    if (deployment) return { formKey, form, deployment };
  }
  return null;
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
  for (const [formKey, form] of entries) {
    console.log(`  ${formKey}`);
    console.log(`    Template: ${form.template || '(none)'}`);
    const deployments = Object.entries(form.deployments || {});
    if (deployments.length === 0) {
      console.log('    Deployments: (none)');
    } else {
      for (const [slug, deployment] of deployments) {
        console.log(`    ${slug}: ${deployment.uid}`);
        console.log(`      Name:  ${deployment.name || '(unnamed)'}`);
        console.log(`      Owner: ${deployment.owner || '(unknown)'}`);
      }
    }
    console.log('');
  }
}

async function showStatus(projectName: string): Promise<void> {
  const registry = await loadRegistry();
  const found = findDeployment(registry, projectName);

  if (!found) {
    console.log(`No Kobo form registered for project "${projectName}".`);
    console.log('Use mcp__kobotoolbox__deploy_form to deploy a form, then register it.');
    return;
  }

  const { formKey, form, deployment } = found;
  console.log(`Kobo form for "${projectName}":`);
  console.log(`  Form key:  ${formKey}`);
  console.log(`  Name:      ${deployment.name || '(unnamed)'}`);
  console.log(`  UID:       ${deployment.uid}`);
  console.log(`  Owner:     ${deployment.owner || '(unknown)'}`);
  console.log(`  Template:  ${form.template || '(none)'}`);
  console.log('');
  console.log('To check submissions, run:');
  console.log(`  mcp__kobotoolbox__get_submissions({ form_uid: "${deployment.uid}" })`);
  console.log('To export data:');
  console.log(`  mcp__kobotoolbox__export_data({ form_uid: "${deployment.uid}" })`);
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

  // kobo/registry.json is NOT written here. Its nested form-family shape has no
  // field for a form URL or a deployment timestamp, and guessing which form
  // family a new deployment belongs to would be exactly the kind of invention
  // that corrupted this file before. project.json is updated below (it is the
  // real source of truth, and it does carry formUrl); the registry entry is
  // printed for you to paste.
  const existing = findDeployment(registry, projectName);
  console.log(`Registering form for "${projectName}":`);
  console.log(`  UID: ${formUid}`);
  console.log(`  URL: ${formUrl}`);
  console.log('');
  if (existing) {
    console.log(`kobo/registry.json already lists "${projectName}" under form "${existing.formKey}"`);
    console.log(`with UID ${existing.deployment.uid}.`);
    if (existing.deployment.uid !== formUid) {
      console.log(`That UID differs from the one given. Update it by hand:`);
      console.log(`  forms.${existing.formKey}.deployments.${projectName}.uid = "${formUid}"`);
    }
  } else {
    console.log('Add this deployment to kobo/registry.json by hand, under the form');
    console.log(`family that uses template "${template || '<template>'}":`);
    console.log('');
    console.log(`  "deployments": {`);
    console.log(`    "${projectName}": {`);
    console.log(`      "uid": "${formUid}",`);
    console.log(`      "name": "${formName || ''}",`);
    console.log(`      "owner": "<kobo-account>"`);
    console.log(`    }`);
    console.log(`  }`);
  }
  console.log('');

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

/**
 * Report where kobo/registry.json disagrees with the project.json files.
 *
 * This used to WRITE the registry, and it wrote the wrong shape: it keyed
 * entries by project slug and gave them flat formUid/formUrl/deployedAt fields.
 * The real file keys by form family with a nested `deployments` map, so the
 * lookup guarding each write never matched and every project got a bogus entry
 * appended on every run, leaving the file half nested and half flat.
 *
 * It reports now, and does not write. Deriving the nested shape from
 * project.json is not possible: project.json knows nothing about which form
 * family a deployment belongs to, nor the owning Kobo account.
 */
async function syncRegistry(): Promise<void> {
  const registry = await loadRegistry();
  const dirs = (await fs.readdir(PROJECTS_DIR, { withFileTypes: true }))
    .filter(d => d.isDirectory())
    .map(d => d.name);

  const missing: string[] = [];
  const mismatched: string[] = [];

  for (const name of dirs) {
    try {
      const project = await loadProject(name);
      if (!project.kobo?.formUid) continue;
      const found = findDeployment(registry, name);
      if (!found) {
        missing.push(`  ${name}: not in registry (project.json has ${project.kobo.formUid})`);
      } else if (found.deployment.uid !== project.kobo.formUid) {
        mismatched.push(
          `  ${name}: registry has ${found.deployment.uid} under "${found.formKey}", ` +
          `project.json has ${project.kobo.formUid}`
        );
      }
    } catch (err) {
      console.warn(`  Skipped ${name}: ${(err as Error).message}`);
    }
  }

  if (missing.length === 0 && mismatched.length === 0) {
    console.log('Registry agrees with every project.json.');
    return;
  }

  if (missing.length > 0) {
    console.log('Deployments in project.json but not in kobo/registry.json:');
    missing.forEach(line => console.log(line));
    console.log('');
  }
  if (mismatched.length > 0) {
    console.log('Deployments whose UID disagrees:');
    mismatched.forEach(line => console.log(line));
    console.log('');
  }

  console.log('This command reports only; it does not write kobo/registry.json.');
  console.log('The registry nests deployments under a form family and records the');
  console.log('owning Kobo account, neither of which project.json knows. Edit');
  console.log('kobo/registry.json by hand to resolve the differences above.');
  process.exitCode = 1;
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
  register <project> <uid> <url> [name] [tpl]   Update project.json, print the registry entry to add
  sync-registry                                 Report where the registry and project.json disagree

kobo/registry.json is maintained by hand. It nests deployments under a form
family and records the owning Kobo account, neither of which project.json
carries, so neither command writes to it.

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
