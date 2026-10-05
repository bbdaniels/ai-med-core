// Run: npm -w @ai-med/api test   (node:test under tsx)
//
// Every project.json flag the API acts on is read through chat-core's
// resolveProjectFlags (project-config.ts), so a talk project's implied flags
// and an explicit flag mean the same thing on every route. A route that read
// `config.requireAccessCode === true` itself would agree with the resolver
// today and silently stop agreeing the day a flag gains an implied value. This
// test fails on any such read in the API's source: a flag name read as a
// property of anything but a resolved `flags` object or a direct
// resolveProjectFlags(...) call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProjectFlags } from '@ai-med/chat-core';

const SRC = path.dirname(fileURLToPath(import.meta.url));

/** The boolean flags and passthrough strings ResolvedFlags carries (not app, not docRefs, not the talkManifest path). */
const FLAGS = Object.entries(resolveProjectFlags({}))
  .filter(([k, v]) => typeof v === 'boolean' || k === 'talkPublicUrl')
  .map(([k]) => k);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

test('the flag list covers the gate, the refusal and the voice switches', () => {
  for (const f of ['requireAccessCode', 'requireKnownVignette', 'enableVoice', 'enableRealtime', 'talkManifest', 'talkPublicUrl']) {
    assert.ok(FLAGS.includes(f), f);
  }
});

test('no API source reads a project flag except through resolveProjectFlags', () => {
  const read = new RegExp(`([A-Za-z_$][\\w$]*|\\))\\s*\\.\\s*(${FLAGS.join('|')})\\b`, 'g');
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;            // comments
      for (const m of line.matchAll(read)) {
        const receiver = m[1];
        if (receiver === 'flags') continue;
        if (receiver === ')' && /resolveProjectFlags\(|readProjectFlags\(/.test(line.slice(0, m.index))) continue;
        offenders.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], 'read these through resolveProjectFlags:\n' + offenders.join('\n'));
});
