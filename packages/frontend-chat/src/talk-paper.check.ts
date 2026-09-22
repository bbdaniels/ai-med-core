// Standalone check: npx tsx packages/frontend-chat/src/talk-paper.check.ts
import assert from 'node:assert/strict';
import { normalizeDoi, doiSlug, fillTalkPublicUrl, publicRedirectUrl, requestedVignette, type TalkPaper } from './talk-paper.js';

const papers: TalkPaper[] = [
  { doi: '10.1371/journal.pmed.1002653', title: 'Variations', vignette: 'kwan2018variations' },
  { doi: '10.1016/S2214-109X(19)30031-2', title: 'Gender', vignette: 'daniels2019gender' },
  { doi: null, title: 'No DOI', vignette: 'legovini2019science' },
];

assert.equal(normalizeDoi('https://doi.org/10.1016/S2214-109X(19)30031-2'), '10.1016/s2214-109x(19)30031-2');
assert.equal(normalizeDoi('doi:10.1371/X'), '10.1371/x');
assert.equal(normalizeDoi('http://dx.doi.org/10.1/A'), '10.1/a');
// ?paper= matches case-insensitively, URL-encoded or not, with or without a doi.org prefix
assert.equal(requestedVignette('?paper=10.1016%2Fs2214-109x(19)30031-2', papers), 'daniels2019gender');
assert.equal(requestedVignette('?paper=' + encodeURIComponent('https://doi.org/10.1371/JOURNAL.PMED.1002653'), papers), 'kwan2018variations');
// unknown or empty ?paper= names nothing
assert.equal(requestedVignette('?paper=10.9999/nope', papers), null);
assert.equal(requestedVignette('?paper=', papers), null);
assert.equal(requestedVignette('', papers), null);
// ?vignette= wins over ?paper=, and junk is rejected
assert.equal(requestedVignette('?vignette=legovini2019science&paper=10.1371/journal.pmed.1002653', papers), 'legovini2019science');
assert.equal(requestedVignette('?vignette=<x>', papers), null);


// talkPublicUrl: slugs match orcid-display's slugForWork, the redirect fills the template
const tpl = 'https://www.benjaminbdaniels.com/publications/#talk-doi-{slug}';
assert.equal(doiSlug('10.1093/wbro/lkag002'), '10-1093-wbro-lkag002');
assert.equal(doiSlug('https://doi.org/10.1016/S2214-109X(19)30031-2'), '10-1016-s2214-109x-19-30031-2');
assert.equal(fillTalkPublicUrl('https://x.org/p?d={doi}#t-{slug}', '10.1016/S2214-109X(19)30031-2'),
  'https://x.org/p?d=10.1016%2Fs2214-109x(19)30031-2#t-10-1016-s2214-109x-19-30031-2');
assert.equal(publicRedirectUrl(tpl, '?paper=10.1016%2Fs2214-109x(19)30031-2', papers),
  'https://www.benjaminbdaniels.com/publications/#talk-doi-10-1016-s2214-109x-19-30031-2');
assert.equal(publicRedirectUrl(tpl, '?vignette=kwan2018variations', papers),
  'https://www.benjaminbdaniels.com/publications/#talk-doi-10-1371-journal-pmed-1002653');
// no paper, an unknown paper, or a paper with no DOI: the page with no popout
assert.equal(publicRedirectUrl(tpl, '', papers), 'https://www.benjaminbdaniels.com/publications/');
assert.equal(publicRedirectUrl(tpl, '?paper=10.9999/nope', papers), 'https://www.benjaminbdaniels.com/publications/');
assert.equal(publicRedirectUrl(tpl, '?vignette=legovini2019science', papers), 'https://www.benjaminbdaniels.com/publications/');

console.log('talk-paper checks: 18/18 passed');
