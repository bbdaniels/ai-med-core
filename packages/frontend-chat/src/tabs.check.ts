// Standalone check: npx tsx packages/frontend-chat/src/tabs.check.ts
import assert from 'node:assert/strict';
import { mergeTabViews, pdfPageMapUrl, resolveI18n, resolveTabs, tabHasPdf, tabMarkdown, tabPdfUrl } from './chat/tabs.js';
import type { LanguagesJson, TabDefinition } from './chat/types.js';

let n = 0;
const check = (name: string, fn: () => void) => { fn(); n++; void name; };
const tab = (t: Partial<TabDefinition> & Pick<TabDefinition, 'id' | 'type'>): TabDefinition => ({ label: t.id, ...t });
const ids = (tabs: TabDefinition[] | null) => tabs?.map(t => `${t.id}:${t.type}`) ?? null;

check('no tab source at all is null', () => {
  assert.equal(resolveTabs(null, null, { vignetteKey: null, addFormTab: true }), null);
  assert.equal(resolveTabs([], { languages: [], ui: {} }, { vignetteKey: null, addFormTab: true }), null);
});

check('api tabs win over the languages-file tabs', () => {
  const langs: LanguagesJson = { languages: [], ui: {}, tabs: [tab({ id: 'legacy', type: 'content' })] };
  assert.deepEqual(ids(resolveTabs([tab({ id: 'api', type: 'content' })], langs, { vignetteKey: null, addFormTab: false })), ['api:content']);
  assert.deepEqual(ids(resolveTabs([], langs, { vignetteKey: null, addFormTab: false })), ['legacy:content']);
});

check('a form tab is added last only when asked and none is declared', () => {
  const src = [tab({ id: 'a', type: 'content' })];
  assert.deepEqual(ids(resolveTabs(src, null, { vignetteKey: null, addFormTab: true })), ['a:content', 'form:form']);
  assert.deepEqual(ids(resolveTabs(src, null, { vignetteKey: null, addFormTab: false })), ['a:content']);
  const withForm = [tab({ id: 'f', type: 'form', order: 1 }), tab({ id: 'a', type: 'content', order: 2 })];
  assert.deepEqual(ids(resolveTabs(withForm, null, { vignetteKey: null, addFormTab: true })), ['f:form', 'a:content']);
  assert.equal(src.length, 1, 'the source list is not mutated');
});

check('showForVignetteKeys hides a tab from other vignettes', () => {
  const src = [tab({ id: 'all', type: 'content' }), tab({ id: 'one', type: 'pdf', showForVignetteKeys: ['k1'] })];
  assert.deepEqual(ids(resolveTabs(src, null, { vignetteKey: 'k1', addFormTab: false })), ['all:content', 'one:pdf']);
  assert.deepEqual(ids(resolveTabs(src, null, { vignetteKey: 'k2', addFormTab: false })), ['all:content']);
  assert.deepEqual(ids(resolveTabs(src, null, { vignetteKey: null, addFormTab: false })), ['all:content']);
  assert.deepEqual(resolveTabs([src[1]], null, { vignetteKey: 'k2', addFormTab: false }), []);
});

check('tabs sort by order, unordered last, declaration order kept among equals', () => {
  const src = [tab({ id: 'c', type: 'content' }), tab({ id: 'b', type: 'content', order: 2 }), tab({ id: 'a', type: 'content', order: 1 })];
  assert.deepEqual(ids(resolveTabs(src, null, { vignetteKey: null, addFormTab: false })), ['a:content', 'b:content', 'c:content']);
});

check('one id declared as pdf then document folds into one tab, the first edition primary', () => {
  const merged = mergeTabViews([
    tab({ id: 'doc', type: 'pdf', content: { pdfUrl: '/x/doc-en.pdf' } }),
    tab({ id: 'doc', type: 'document', content: { markdown: '# A {#sec-1}' } }),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].type, 'pdf');
  assert.equal(merged[0].altView?.type, 'document');
  assert.equal(tabMarkdown(merged[0]), '# A {#sec-1}');
  assert.equal(tabPdfUrl(merged[0]), '/x/doc-en.pdf');
  assert.equal(tabHasPdf(merged[0]), true);
});

check('any other repeated id is dropped', () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const merged = mergeTabViews([tab({ id: 'x', type: 'content' }), tab({ id: 'x', type: 'pdf' }), tab({ id: 'x', type: 'content' })]);
    assert.deepEqual(ids(merged), ['x:content']);
    assert.equal(merged[0].altView, undefined);
  } finally { console.warn = warn; }
});

check('labels resolve by language, then English', () => {
  assert.equal(resolveI18n('Plain', 'vi'), 'Plain');
  assert.equal(resolveI18n({ en: 'Questions', vi: 'Câu hỏi' }, 'vi'), 'Câu hỏi');
  assert.equal(resolveI18n({ en: 'Questions' }, 'fr'), 'Questions');
  assert.equal(resolveI18n(undefined, 'en'), '');
});

check('a PDF page map sits beside its PDF', () => {
  assert.equal(pdfPageMapUrl('/api/project-content/a/eip-en.pdf'), '/api/project-content/a/eip-map.en.json');
  assert.equal(pdfPageMapUrl('/api/project-content/a/paper.pdf'), null);
});

console.log(`tabs checks: ${n}/${n} passed`);
