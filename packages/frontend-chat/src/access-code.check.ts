// Standalone check: npx tsx packages/frontend-chat/src/access-code.check.ts
import assert from 'node:assert/strict';
import { accessCodeFromHash, hashWithoutAccessCode } from './access-code.js';

// read: with or without the leading #, trimmed, URL-decoded
assert.equal(accessCodeFromHash('#code=smallwins'), 'smallwins');
assert.equal(accessCodeFromHash('code=smallwins'), 'smallwins');
assert.equal(accessCodeFromHash('#code=two%20words'), 'two words');
assert.equal(accessCodeFromHash('#code=%20padded%20'), 'padded');
assert.equal(accessCodeFromHash('#sec-4&code=x'), 'x');
// nothing to read
assert.equal(accessCodeFromHash(''), null);
assert.equal(accessCodeFromHash('#'), null);
assert.equal(accessCodeFromHash('#code='), null);
assert.equal(accessCodeFromHash('#sec-4'), null);
assert.equal(accessCodeFromHash('#barcode=x'), null);

// strip: the code goes, the rest of the fragment stays
assert.equal(hashWithoutAccessCode('#code=smallwins'), '');
assert.equal(hashWithoutAccessCode('#code='), '');
assert.equal(hashWithoutAccessCode('#tab=pdf&code=x'), '#tab=pdf');
assert.equal(hashWithoutAccessCode('#code=x&tab=pdf'), '#tab=pdf');
// no code: null, so the address bar is left alone
assert.equal(hashWithoutAccessCode(''), null);
assert.equal(hashWithoutAccessCode('#tab=pdf'), null);
// what was stripped can no longer be read
assert.equal(accessCodeFromHash(hashWithoutAccessCode('#code=x&tab=pdf')!), null);

console.log('access-code checks: 17/17 passed');
