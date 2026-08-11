#!/usr/bin/env npx tsx
/**
 * generate-case.ts
 *
 * Validate and register medical case vignettes for AI-MED projects.
 *
 * Commands:
 *   npx tsx tools/generate-case.ts templates
 *   npx tsx tools/generate-case.ts validate <case-file>
 *   npx tsx tools/generate-case.ts validate-project <project-name>
 *   npx tsx tools/generate-case.ts register <template> <profile-id> <project> <file-path> [--title "..."]
 *
 * Examples:
 *   npx tsx tools/generate-case.ts templates
 *   npx tsx tools/generate-case.ts validate cases/my-project/fall_case.md
 *   npx tsx tools/generate-case.ts validate-project my-project
 *   npx tsx tools/generate-case.ts register fall_elderly assisted-living-male-71 demo variant.md --title "Fall (Assisted Living)"
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const TEMPLATES_DIR = path.resolve('cases');

// Required sections for validation (shared across all case types)
const REQUIRED_SECTIONS: string[] = [
  'Case Title',
  'Patient Background',
  'Chief Complaint',
  'History of Present Illness',
  'Past Medical History',
  'Medications',
  'Provider Questions and Scripted',
  'Physical Examination Findings',
  'Assessment',
  'Management Plan',
  'Learning Objectives',
];

// Sections that should be validated for the raw vignette format (as stored in DB)
// These match what the existing vignettes.json uses -- no markdown headers, just text blocks
const VIGNETTE_CONTENT_MARKERS = [
  'Patient Background',
  'Chief Complaint',
  'History of Present Illness',
  'Physical Examination Findings',
];

interface ValidationResult {
  valid: boolean;
  file: string;
  missingRequired: string[];
  foundSections: string[];
  warnings: string[];
  charCount: number;
  lineCount: number;
}

async function listTemplates(): Promise<void> {
  const entries = await fs.readdir(TEMPLATES_DIR, { withFileTypes: true });

  // List scaffold templates (.md files)
  const scaffolds = entries.filter(e => e.isFile() && e.name.endsWith('.md') && e.name !== 'generation-instructions.md');
  if (scaffolds.length > 0) {
    console.log('Scaffold templates:\n');
    for (const entry of scaffolds) {
      const name = entry.name.replace('.md', '');
      const content = await fs.readFile(path.join(TEMPLATES_DIR, entry.name), 'utf8');
      const firstLine = content.split('\n').find(l => l.startsWith('# '));
      const title = firstLine?.replace(/^#\s+/, '') || name;
      console.log(`  ${name}`);
      console.log(`    Title: ${title}`);
      console.log(`    File: cases/${entry.name}`);
      console.log('');
    }
  }

  // List base case templates (directories with meta.json)
  const dirs = entries.filter(e => e.isDirectory());
  if (dirs.length > 0) {
    console.log('Base case templates:\n');
    for (const dir of dirs) {
      try {
        const meta = JSON.parse(await fs.readFile(path.join(TEMPLATES_DIR, dir.name, 'meta.json'), 'utf8'));
        console.log(`  ${meta.name}`);
        console.log(`    Title: ${meta.title}`);
        console.log(`    Type: ${meta.templateType}`);
        console.log(`    Dir: cases/${dir.name}/`);
        console.log('');
      } catch {
        // Skip directories without meta.json
      }
    }
  }
}

function validateContent(content: string, file: string, templateName?: string): ValidationResult {
  const lines = content.split('\n');
  const lineCount = lines.length;
  const charCount = content.length;
  const warnings: string[] = [];
  const foundSections: string[] = [];
  const missingRequired: string[] = [];

  // Check for required sections (case-insensitive search in content)
  for (const section of REQUIRED_SECTIONS) {
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'i');
    let found = pattern.test(content);

    // For "Case Title", also accept a markdown H1 header (# ...) as the case title
    if (!found && section === 'Case Title') {
      found = /^#\s+\S/m.test(content);
    }

    if (found) {
      foundSections.push(section);
    } else {
      missingRequired.push(section);
    }
  }

  // Content quality warnings
  if (charCount < 1000) {
    warnings.push(`Very short case (${charCount} chars). Most cases are 3,000-10,000 chars.`);
  }

  if (!content.includes('"') && !content.includes('\u201c')) {
    warnings.push('No quoted dialogue found. Cases should include scripted patient responses in quotes.');
  }

  // Check for unfilled placeholders
  const placeholders = content.match(/\[([A-Z][A-Z\s]+)\]/g);
  if (placeholders && placeholders.length > 0) {
    warnings.push(`Found ${placeholders.length} unfilled placeholder(s): ${placeholders.slice(0, 5).join(', ')}${placeholders.length > 5 ? '...' : ''}`);
  }

  // Check for medication list
  if (!/mg\s/i.test(content) && !/daily/i.test(content)) {
    warnings.push('No medication dosages found (expected patterns like "mg daily").');
  }

  // Check for vitals
  if (!/BP\s/i.test(content) && !/blood pressure/i.test(content)) {
    warnings.push('No blood pressure / vitals found in physical examination.');
  }

  return {
    valid: missingRequired.length === 0,
    file,
    missingRequired,
    foundSections,
    warnings,
    charCount,
    lineCount,
  };
}

async function validate(filePath: string): Promise<ValidationResult> {
  const resolved = path.resolve(filePath);
  const content = await fs.readFile(resolved, 'utf8');
  return validateContent(content, filePath);
}

async function validateProject(projectName: string): Promise<void> {
  const projectPath = path.resolve('projects', projectName, 'project.json');
  let project: any;

  try {
    const raw = await fs.readFile(projectPath, 'utf8');
    project = JSON.parse(raw);
  } catch {
    console.error(`Could not read project: ${projectPath}`);
    process.exit(1);
  }

  console.log(`Validating cases for project "${projectName}":\n`);

  // Validate system prompt exists
  if (project.cases?.systemPrompt) {
    try {
      const content = await fs.readFile(path.resolve(project.cases.systemPrompt), 'utf8');
      console.log(`  System prompt: ${project.cases.systemPrompt} (${content.length} chars) OK`);
    } catch {
      console.log(`  System prompt: ${project.cases.systemPrompt} MISSING`);
    }
  }

  // Validate each vignette
  const results: ValidationResult[] = [];
  for (const vignette of project.cases?.vignettes || []) {
    try {
      const result = await validate(vignette.file);
      results.push(result);

      const status = result.valid ? 'OK' : 'ISSUES';
      console.log(`  ${vignette.key}: ${vignette.file} (${result.charCount} chars) ${status}`);

      if (result.missingRequired.length > 0) {
        console.log(`    Missing: ${result.missingRequired.join(', ')}`);
      }
      if (result.warnings.length > 0) {
        for (const w of result.warnings) {
          console.log(`    Warning: ${w}`);
        }
      }
    } catch {
      console.log(`  ${vignette.key}: ${vignette.file} FILE NOT FOUND`);
    }
  }

  const allValid = results.every(r => r.valid);
  console.log(`\n${allValid ? 'All cases valid.' : 'Some cases have issues. Fix missing sections and re-validate.'}`);
}

function printResult(result: ValidationResult): void {
  console.log(`Validation: ${result.file}`);
  console.log(`  Lines: ${result.lineCount}, Characters: ${result.charCount}`);
  console.log(`  Sections found: ${result.foundSections.length}`);

  if (result.valid) {
    console.log(`  Status: VALID`);
  } else {
    console.log(`  Status: INCOMPLETE`);
    console.log(`  Missing sections:`);
    for (const s of result.missingRequired) {
      console.log(`    - ${s}`);
    }
  }

  if (result.warnings.length > 0) {
    console.log(`  Warnings:`);
    for (const w of result.warnings) {
      console.log(`    - ${w}`);
    }
  }
}

interface VariantEntry {
  uuid: string;
  key: string;
  profileId: string;
  file: string;
  title: string;
  generatedAt: string;
}

interface VariantsJson {
  template: string;
  variants: VariantEntry[];
}

async function register(
  templateName: string,
  profileId: string,
  projectName: string,
  filePath: string,
  title?: string,
): Promise<void> {
  // 1. Verify template exists
  const templateDir = path.join(TEMPLATES_DIR, templateName);
  const metaPath = path.join(templateDir, 'meta.json');
  // Profiles are project-specific, not in the template
  const profilesPath = path.resolve('projects', projectName, 'cases', templateName, 'profiles.json');

  let meta: any;
  try {
    meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  } catch {
    console.error(`Template "${templateName}" not found at ${templateDir}/meta.json`);
    process.exit(1);
  }

  // 2. Verify profile exists
  let profiles: any[];
  try {
    profiles = JSON.parse(await fs.readFile(profilesPath, 'utf8'));
  } catch {
    console.error(`No profiles.json found at projects/${projectName}/cases/${templateName}/profiles.json`);
    process.exit(1);
  }

  const profile = profiles.find((p: any) => p.id === profileId);
  if (!profile) {
    const available = profiles.map((p: any) => p.id).join(', ');
    console.error(`Profile "${profileId}" not found. Available: ${available}`);
    process.exit(1);
  }

  // 3. Read and validate the case file
  const resolvedFile = path.resolve(filePath);
  let content: string;
  try {
    content = await fs.readFile(resolvedFile, 'utf8');
  } catch {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const validation = validateContent(content, filePath, meta.templateType);
  if (!validation.valid) {
    console.error(`Validation failed for ${filePath}:`);
    for (const s of validation.missingRequired) {
      console.error(`  Missing: ${s}`);
    }
    process.exit(1);
  }
  if (validation.warnings.length > 0) {
    for (const w of validation.warnings) {
      console.warn(`  Warning: ${w}`);
    }
  }
  console.log(`Validation: OK (${validation.charCount} chars, ${validation.foundSections.length} sections)`);

  // 4. Generate UUID
  const uuid = crypto.randomUUID();
  const key = uuid.replace(/-/g, '');

  // 5. Move file to project cases directory
  const projectCasesDir = path.resolve('projects', projectName, 'cases', templateName);
  await fs.mkdir(projectCasesDir, { recursive: true });
  const newFilePath = path.join(projectCasesDir, `${uuid}.md`);
  await fs.copyFile(resolvedFile, newFilePath);

  // If the source file was NOT already in the target directory, remove it
  if (path.resolve(filePath) !== path.resolve(newFilePath)) {
    await fs.unlink(resolvedFile).catch(() => {});
  }

  const relativeFile = path.relative(path.resolve('.'), newFilePath);
  console.log(`File: ${relativeFile}`);
  console.log(`UUID: ${uuid}`);
  console.log(`Key: ${key}`);

  // 6. Derive title
  const variantTitle = title || `${meta.title} (${profileId})`;

  // 7. Update variants.json
  const variantsPath = path.join(projectCasesDir, 'variants.json');
  let variantsJson: VariantsJson;
  try {
    variantsJson = JSON.parse(await fs.readFile(variantsPath, 'utf8'));
  } catch {
    variantsJson = { template: templateName, variants: [] };
  }

  variantsJson.variants.push({
    uuid,
    key,
    profileId,
    file: relativeFile,
    title: variantTitle,
    generatedAt: new Date().toISOString(),
  });

  await fs.writeFile(variantsPath, JSON.stringify(variantsJson, null, 2) + '\n', 'utf8');
  console.log(`Updated: ${path.relative(path.resolve('.'), variantsPath)}`);

  // 8. Update project.json
  const projectJsonPath = path.resolve('projects', projectName, 'project.json');
  let project: any;
  try {
    project = JSON.parse(await fs.readFile(projectJsonPath, 'utf8'));
  } catch {
    console.error(`Could not read project.json for "${projectName}"`);
    process.exit(1);
  }

  // Add vignette entry (template is per-vignette)
  project.cases.vignettes.push({
    key,
    template: templateName,
    title: variantTitle,
    file: relativeFile,
    profileId,
  });

  await fs.writeFile(projectJsonPath, JSON.stringify(project, null, 2) + '\n', 'utf8');
  console.log(`Updated: projects/${projectName}/project.json`);
  console.log(`\nRegistered variant: ${variantTitle}`);
}

// --- CLI ---

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'templates':
      await listTemplates();
      break;

    case 'validate': {
      if (!args[0]) {
        console.error('Usage: generate-case.ts validate <case-file>');
        process.exit(1);
      }
      const result = await validate(args[0]);
      printResult(result);
      process.exit(result.valid ? 0 : 1);
      break;
    }

    case 'validate-project': {
      if (!args[0]) {
        console.error('Usage: generate-case.ts validate-project <project-name>');
        process.exit(1);
      }
      await validateProject(args[0]);
      break;
    }

    case 'register': {
      const templateName = args[0];
      const profileId = args[1];
      const projectName = args[2];
      const filePath = args[3];
      if (!templateName || !profileId || !projectName || !filePath) {
        console.error('Usage: generate-case.ts register <template> <profile-id> <project> <file-path> [--title "..."]');
        process.exit(1);
      }
      const titleIdx = args.indexOf('--title');
      const titleArg = titleIdx !== -1 ? args[titleIdx + 1] : undefined;
      await register(templateName, profileId, projectName, filePath, titleArg);
      break;
    }

    default:
      console.log(`generate-case.ts - Case generation and validation for AI-MED

Commands:
  templates                                     List available templates
  validate <case-file>                          Validate a case file
  validate-project <project-name>               Validate all cases in a project
  register <template> <profile-id> <project> <file> Register a variant`);
      break;
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
