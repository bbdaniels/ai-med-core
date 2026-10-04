// Run: npm -w @ai-med/chat-core test
//
// What chat-core may depend on. The engine sits below the apps: the API (and
// the simulator code in it) imports chat-core, never the reverse. chat-core
// also reaches no web framework or database driver of its own; the API owns
// the HTTP routes and the connection, and hands the pipeline a ChatStore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.dirname(SRC);
const ROOTS = [SRC, path.join(PKG, 'test-support')];

function files(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : files(p);
    return /\.(ts|tsx|js|mjs)$/.test(e.name) ? [p] : [];
  });
}

/** Every module specifier a file names: static and dynamic imports, re-exports. */
function specifiers(src: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s;])(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]|(?:^|[\s;])import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of src.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const packageName = (spec: string) =>
  spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];

// This file plants forbidden imports in strings (last test), so it is not scanned.
const SELF = fileURLToPath(import.meta.url);
const all = ROOTS.flatMap(files).filter(f => f !== SELF);

test('the scan sees the engine', () => {
  assert.ok(all.some(f => f.endsWith(path.join('chat', 'pipeline.ts'))), 'chat/pipeline.ts not found');
  assert.ok(all.length > 20, `only ${all.length} files scanned`);
});

test('nothing in chat-core imports the API, a web framework or a database driver', () => {
  const forbidden = new Set(['express', 'pg', '@ai-med/api', '@ai-med/frontend-chat']);
  const offenders: string[] = [];
  for (const f of all) {
    for (const spec of specifiers(fs.readFileSync(f, 'utf8'))) {
      const rel = path.relative(PKG, f);
      if (spec.startsWith('.')) {
        // A relative import must stay inside this package.
        const target = path.resolve(path.dirname(f), spec);
        if (path.relative(PKG, target).startsWith('..')) offenders.push(`${rel}: ${spec}`);
      } else if (forbidden.has(packageName(spec))) {
        offenders.push(`${rel}: ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('every package chat-core imports is declared in its own package.json', () => {
  // The API's bundle inlines @ai-med/* source and leaves every other package
  // external (packages/api/build.mjs), so what chat-core needs at runtime must
  // be a dependency here, not something it happens to find hoisted.
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
  const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
  const builtins = new Set(builtinModules);
  const undeclared: string[] = [];
  for (const f of all) {
    for (const spec of specifiers(fs.readFileSync(f, 'utf8'))) {
      if (spec.startsWith('.') || spec.startsWith('node:')) continue;
      const name = packageName(spec);
      if (builtins.has(name) || name === pkg.name) continue;
      if (!declared.has(name)) undeclared.push(`${path.relative(PKG, f)}: ${spec}`);
    }
  }
  assert.deepEqual(undeclared, []);
});

test('the pipeline is handed its client: nothing under src/chat builds or fetches one', () => {
  for (const f of files(path.join(SRC, 'chat')).filter(n => !n.endsWith('.test.ts'))) {
    const src = fs.readFileSync(f, 'utf8');
    const name = path.relative(SRC, f);
    assert.doesNotMatch(src, /openaiClients\s*\(/, `${name} calls openaiClients()`);
    assert.doesNotMatch(src, /clientForPaymentSource\s*\(/, `${name} chooses a client`);
    assert.doesNotMatch(src, /new OpenAI\s*\(/, `${name} builds a client`);
    assert.doesNotMatch(src, /openai-clients/, `${name} imports openai-clients`);
  }
});

test('the guards fire: a planted import of each kind is caught', () => {
  assert.deepEqual(specifiers(`import express from 'express';`), ['express']);
  assert.deepEqual(specifiers(`import type { Pool } from 'pg';`), ['pg']);
  assert.deepEqual(specifiers(`export { x } from '../../api/src/server.js';`), ['../../api/src/server.js']);
  assert.deepEqual(specifiers(`const m = await import('@ai-med/api');`), ['@ai-med/api']);
  assert.deepEqual(specifiers(`import {\n  a,\n  b,\n} from 'openai';`), ['openai']);
  assert.equal(packageName('@ai-med/api/src/x'), '@ai-med/api');
  assert.equal(packageName('pg/lib/client'), 'pg');
});
