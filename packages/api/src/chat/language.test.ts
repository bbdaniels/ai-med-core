// Run: npm -w @ai-med/api test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { languageCode, parseLanguageList, sameLanguage } from './language.js';

// The shape of a languages.json, as /api/languages serves it.
const list = parseLanguageList(JSON.stringify({
  languages: [
    { code: 'en', name: 'English', flag: 'x' },
    { code: 'es', name: 'Español' },
    { code: 'vi', name: 'Tiếng Việt' },
    { code: 'zh', name: '中文' },
  ],
  ui: {},
}));

test('the list is read from a languages.json text', () => {
  assert.deepEqual(list.map(l => l.code), ['en', 'es', 'vi', 'zh']);
  assert.deepEqual(parseLanguageList(null), []);
  assert.deepEqual(parseLanguageList('not json'), []);
  assert.deepEqual(parseLanguageList('{"languages": "x"}'), []);
});

test('both spellings of a language resolve to its code', () => {
  for (const name of ['Tiếng Việt', 'Vietnamese', 'tieng viet', 'TIẾNG  VIỆT', 'vi']) {
    assert.equal(languageCode(name, list), 'vi', name);
  }
  for (const name of ['Español', 'Spanish', 'espanol']) assert.equal(languageCode(name, list), 'es', name);
  assert.equal(languageCode('中文', list), 'zh');
  assert.equal(languageCode('Chinese', list), 'zh');
  assert.equal(languageCode('English', list), 'en');
});

test('a language the list does not hold resolves to nothing', () => {
  assert.equal(languageCode('Swahili', list), null);
  assert.equal(languageCode('', list), null);
  assert.equal(languageCode(null, list), null);
  assert.equal(languageCode('Vietnamese', []), null);
});

test('sameLanguage compares codes, and folded names when the list cannot say', () => {
  assert.equal(sameLanguage('Tiếng Việt', 'Vietnamese', list), true);
  assert.equal(sameLanguage('Español', 'Spanish', list), true);
  assert.equal(sameLanguage('Español', 'English', list), false);
  assert.equal(sameLanguage('English', 'Vietnamese', list), false);
  assert.equal(sameLanguage(' vietnamese ', 'Vietnamese', []), true);
  assert.equal(sameLanguage('Tiếng Việt', 'Vietnamese', []), false);
  assert.equal(sameLanguage(null, 'Vietnamese', list), false);
});
