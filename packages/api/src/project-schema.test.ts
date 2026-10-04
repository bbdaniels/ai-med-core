// Run: npm -w @ai-med/api test   (node:test under tsx)
//
// projects/project-schema.json, the rules a schema-only reader would miss.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'projects/project-schema.json'), 'utf8'));
// The same options tools/validate-projects.ts compiles the schema with.
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

/** A minimal formless project, valid apart from what a test changes. */
const project = (extra: Record<string, unknown>, vignettes: unknown[]) => ({
  name: 'temp',
  displayName: 'Temp',
  frontend: 'chat',
  cases: { systemPrompt: 'projects/temp/system-prompt.md', vignettes },
  languages: ['en'],
  formless: true,
  deployment: { tablePrefix: 'temp' },
  ...extra,
});
const one = [{ key: 'scene_1', template: 'scene', file: 'projects/temp/cases/scene/scene_1.md' }];

test('an empty vignette list is valid only with requireKnownVignette', () => {
  assert.equal(validate(project({ requireKnownVignette: true }, [])), true, JSON.stringify(validate.errors));

  for (const extra of [{}, { requireKnownVignette: false }]) {
    assert.equal(validate(project(extra, [])), false);
    assert.ok(validate.errors!.some(e => e.instancePath === '/cases/vignettes' && e.keyword === 'minItems'),
      JSON.stringify(validate.errors));
  }
});

test('a project with vignettes validates with or without the option', () => {
  for (const extra of [{}, { requireKnownVignette: false }, { requireKnownVignette: true }]) {
    assert.equal(validate(project(extra, one)), true, JSON.stringify(validate.errors));
  }
});

test('the list itself is still required', () => {
  const p = project({ requireKnownVignette: true }, []) as any;
  delete p.cases.vignettes;
  assert.equal(validate(p), false);
});
