// Standalone check: npx tsx packages/frontend-chat/src/frame-escape.check.ts
import assert from 'node:assert/strict';
import { closesFrame, listenForFrameEscape } from './frame-escape.js';

const key = (k: string, extra: Partial<{ isComposing: boolean; keyCode: number; defaultPrevented: boolean }> = {}) =>
  ({ key: k, defaultPrevented: false, ...extra });

// a plain Escape closes, wherever it was typed (the predicate never looks at the target)
assert.equal(closesFrame(key('Escape')), true);
// other keys do not
assert.equal(closesFrame(key('Enter')), false);
assert.equal(closesFrame(key('Esc')), false);
// an Escape that ends an IME composition belongs to the input method
assert.equal(closesFrame(key('Escape', { isComposing: true })), false);
assert.equal(closesFrame(key('Escape', { keyCode: 229 })), false);
// an Escape something else consumed (an open menu, a find box) is left alone
assert.equal(closesFrame(key('Escape', { defaultPrevented: true })), false);

// the listener: fires on Escape, ignores a consumed one, and tears down
const target = new EventTarget();
let closed = 0;
const fire = (k: string, consumed = false) => {
  const ev = new Event('keydown', { cancelable: true });
  Object.defineProperty(ev, 'key', { value: k });
  if (consumed) ev.preventDefault();
  target.dispatchEvent(ev);
};
const stop = listenForFrameEscape(target, () => { closed += 1; });
fire('Escape');
assert.equal(closed, 1);
fire('a');
fire('Escape', true);
assert.equal(closed, 1);
stop();
fire('Escape');
assert.equal(closed, 1);

console.log('frame-escape checks: 10/10 passed');
