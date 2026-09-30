import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const css = read('pwa', 'css', 'app.css');
/** The declarations of a one-line rule in app.css, by its exact selector. */
const rule = (selector) => {
  const line = css.split('\n').find((l) => l.startsWith(`${selector} {`));
  assert.ok(line, `app.css has a rule for ${selector}`);
  return line;
};

test('queued messages: however long, they leave the chat in view', () => {
  // The list and an opened message scroll on their own, sized to the visible screen (keyboard included).
  const list = rule('.pending-list');
  assert.match(list, /max-height: calc\(var\(--app-h, 100dvh\) \* 0\.4\)/);
  assert.match(list, /overflow-y: auto/);
  const open = rule('.pending-item .pt.open');
  assert.match(open, /max-height: calc\(var\(--app-h, 100dvh\) \* 0\.28\)/);
  assert.match(open, /overflow-y: auto/);
  // Closed: two lines, with a max-height in case the clamp isn't applied.
  const closed = rule('.pending-item .pt');
  assert.match(closed, /-webkit-line-clamp: 2/);
  assert.match(closed, /max-height: calc\(2\.9em \+ 6px\)/);
  // The edit box fits in the list together with its Save bar.
  assert.match(rule('.pending-item .pe textarea'), /max-height: min\(240px, calc\(var\(--app-h, 100dvh\) \* 0\.4 - 60px\)\)/);
});

test('queued messages: the clamped text is not a <button> (Safari ignores line clamping on buttons)', () => {
  const js = read('pwa', 'js', 'ui', 'composer.js');
  assert.match(js, /<div ref=\$\{shown\} class=\$\{`pt /, 'the text is a div');
  assert.doesNotMatch(js, /<button[^>]*class=\$\{`pt /, 'not a button');
  // Show all is offered when the text is actually cut off, not by its length in characters.
  assert.match(js, /setLong\(el\.scrollHeight > el\.clientHeight \+ 1\)/);
  assert.match(js, /\(long \|\| open\) && html`<button onClick=\$\{\(\) => setOpen\(!open\)\}/);
});
