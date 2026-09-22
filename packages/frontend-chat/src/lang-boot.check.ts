// Standalone check: npx tsx packages/frontend-chat/src/lang-boot.check.ts
import assert from 'node:assert/strict';
import { resolveInitialLanguage } from './lang-boot.js';

// 1. ?lang= wins over everything
assert.equal(resolveInitialLanguage('?lang=vi', 'en', ['en-US']), 'vi');
// 2. ?lang= is case/whitespace-normalized, junk rejected (falls through)
assert.equal(resolveInitialLanguage('?lang=VI', null, []), 'vi');
assert.equal(resolveInitialLanguage('?lang=<script>', 'en', []), 'en');
// 3. saved localStorage choice beats browser locale
assert.equal(resolveInitialLanguage('', 'vi', ['en-US', 'en']), 'vi');
// 4. browser locale primary subtag used when nothing else set
assert.equal(resolveInitialLanguage('', null, ['vi-VN', 'en-US']), 'vi');
assert.equal(resolveInitialLanguage('', null, ['pt-BR']), 'pt');
// 5. nothing anywhere → 'en'
assert.equal(resolveInitialLanguage('', null, []), 'en');
// 6. other params don't confuse it
assert.equal(resolveInitialLanguage('?values=d%5Buid%5D%3Dx&lang=vi', null, []), 'vi');

// 7. with the project's list: each step must be offered, else fall through
const L = ['en', 'es', 'fr', 'vi'];
assert.equal(resolveInitialLanguage('?lang=vi', 'fr', ['es'], L), 'vi');
assert.equal(resolveInitialLanguage('?lang=th', 'fr', ['es'], L), 'fr');
assert.equal(resolveInitialLanguage('?lang=th', 'de', ['de-DE', 'es-MX'], L), 'es');
assert.equal(resolveInitialLanguage('', null, ['de-DE', 'ja'], L), 'en');
assert.equal(resolveInitialLanguage('', null, [], ['vi', 'en']), 'vi');

console.log('lang-boot checks: 13/13 passed');
