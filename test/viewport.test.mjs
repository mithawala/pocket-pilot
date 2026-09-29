import test from 'node:test';
import assert from 'node:assert/strict';
import { fitViewport, isEditing, trackViewport } from '../pwa/js/lib/viewport.js';

test('viewport: follows the on-screen keyboard only while something is edited', () => {
  const vv = (height, offsetTop = 0, scale = 1) => ({ height, offsetTop, scale });
  assert.deepEqual(fitViewport({ innerHeight: 800, vv: vv(800), editing: false }), { height: 800, top: 0, keyboard: false });
  assert.deepEqual(fitViewport({ innerHeight: 800, vv: vv(480, 120), editing: true }), { height: 480, top: 120, keyboard: true });
  // iOS didn't report the keyboard closing: nothing is edited any more, so the app takes the whole window.
  assert.deepEqual(fitViewport({ innerHeight: 800, vv: vv(480), editing: false }), { height: 800, top: 0, keyboard: false });
  assert.equal(fitViewport({ innerHeight: 800, vv: vv(400, 0, 2), editing: true }), null, 'pinch-zoomed: leave the layout alone');
  assert.deepEqual(fitViewport({ innerHeight: 700.4, vv: null, editing: true }), { height: 700, top: 0, keyboard: false });
});

test('viewport: only fields that bring up the keyboard count as editing', () => {
  const doc = (el) => ({ activeElement: el });
  assert.equal(isEditing(doc({ tagName: 'TEXTAREA' })), true);
  assert.equal(isEditing(doc({ tagName: 'INPUT', type: 'text' })), true);
  assert.equal(isEditing(doc({ tagName: 'INPUT', type: 'search' })), true);
  assert.equal(isEditing(doc({ tagName: 'INPUT', type: 'checkbox' })), false);
  assert.equal(isEditing(doc({ tagName: 'INPUT', type: 'text', readOnly: true })), false);
  assert.equal(isEditing(doc({ tagName: 'DIV', isContentEditable: true })), true);
  assert.equal(isEditing(doc({ tagName: 'BUTTON' })), false);
  assert.equal(isEditing(doc(null)), false);
});

test('viewport: the app gets its full height back when the keyboard closes, even without a resize', async () => {
  // A fake iPhone Safari in which animation frames never come and the keyboard closing fires no resize.
  const listeners = new Map();
  const on = (target) => (type, fn) => listeners.set(`${target}:${type}`, [...(listeners.get(`${target}:${type}`) || []), fn]);
  const fire = (target, type) => (listeners.get(`${target}:${type}`) || []).forEach((fn) => fn());
  const props = {};
  const doc = { activeElement: null, hidden: false, documentElement: { style: { setProperty: (k, v) => { props[k] = v; } } }, addEventListener: on('doc') };
  const vv = { height: 800, offsetTop: 0, scale: 1, addEventListener: on('vv') };
  const win = {
    document: doc, visualViewport: vv, innerHeight: 800, scrollX: 0, scrollY: 0,
    scrollTo() { this.scrollY = 0; },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    addEventListener: on('win'),
  };
  trackViewport(win);
  assert.equal(props['--app-h'], '800px');

  doc.activeElement = { tagName: 'TEXTAREA' };
  vv.height = 460;
  vv.offsetTop = 40;
  fire('doc', 'focusin');
  assert.equal(props['--app-h'], '460px', 'the composer sits above the keyboard');
  assert.equal(props['--vv-top'], '40px');

  doc.activeElement = null;
  win.scrollY = 90;
  fire('doc', 'focusout');
  assert.equal(props['--app-h'], '800px', 'full height as soon as nothing is edited');
  assert.equal(props['--vv-top'], '0px');
  assert.equal(win.scrollY, 0, 'and scrolled back into place');

  // A resize whose animation frame never comes still lands through the fallback timer.
  doc.activeElement = { tagName: 'TEXTAREA' };
  vv.height = 500;
  vv.offsetTop = 0;
  fire('vv', 'resize');
  await new Promise((r) => setTimeout(r, 220));
  assert.equal(props['--app-h'], '500px');
  await new Promise((r) => setTimeout(r, 900));
});
