import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fitViewport, isEditing, trackViewport, fullScreenHeight, bottomInset, viewportStuck } from '../pwa/js/lib/viewport.js';

test('viewport: the app page sits below an opaque status bar (WebKit bug 301994)', () => {
  const html = fs.readFileSync(new URL('../pwa/index.html', import.meta.url), 'utf8');
  const viewport = html.match(/<meta name="viewport" content="([^"]+)"/)?.[1] || '';
  assert.ok(viewport.includes('width=device-width'), viewport);
  assert.doesNotMatch(viewport, /viewport-fit=cover/, 'drawn under the status bar, iOS 26.5+ leaves a band at the bottom of the screen');
  assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="black" \/>/, 'an opaque status bar, not black-translucent');
  assert.match(html, /<link rel="manifest" href="\.\/manifest\.webmanifest" \/>/, 'the manifest stays: iOS web push needs it');
});

/** A fake window: listeners, root style properties, and whatever a test sets on it. */
function fakeWindow({ standalone = false, screen, innerWidth = 393, innerHeight = 800, safeBottom = 34, shell = null } = {}) {
  const listeners = new Map();
  const on = (target) => (type, fn) => listeners.set(`${target}:${type}`, [...(listeners.get(`${target}:${type}`) || []), fn]);
  const fire = (target, type) => (listeners.get(`${target}:${type}`) || []).forEach((fn) => fn());
  const props = {};
  const body = { appendChild: (el) => { el.getBoundingClientRect = () => ({ height: /safe-area-inset-bottom/.test(el.style.cssText) ? safeBottom : 0 }); } };
  const doc = {
    activeElement: null, hidden: false, body,
    documentElement: { style: { setProperty: (k, v) => { props[k] = v; }, removeProperty: (k) => { delete props[k]; } } },
    createElement: () => ({ style: {}, setAttribute() {} }),
    addEventListener: on('doc'),
    querySelector: (s) => (s === '.shell' ? shell : null),
  };
  const win = {
    document: doc, navigator: { standalone }, screen, innerWidth, innerHeight, scrollX: 0, scrollY: 0,
    scrollTo() { this.scrollY = 0; },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    addEventListener: on('win'),
  };
  win.visualViewport = { height: innerHeight, offsetTop: 0, scale: 1, addEventListener: on('vv') };
  return { win, doc, props, fire };
}

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
  // A fake iPhone Safari tab in which animation frames never come and the keyboard closing fires no resize.
  const { win, doc, props, fire } = fakeWindow({ innerHeight: 800 });
  const vv = win.visualViewport;
  trackViewport(win);
  assert.equal(props['--app-h'], '800px');
  assert.equal(props['--safe-bottom'], undefined, 'a browser tab leaves the home indicator to CSS');

  doc.activeElement = { tagName: 'TEXTAREA' };
  vv.height = 460;
  vv.offsetTop = 40;
  fire('doc', 'focusin');
  assert.equal(props['--app-h'], '460px', 'the composer sits above the keyboard');
  assert.equal(props['--vv-top'], '40px');
  assert.equal(props['--safe-bottom'], '0px', 'right on the keyboard: it covers the home indicator');

  doc.activeElement = null;
  win.scrollY = 90;
  fire('doc', 'focusout');
  assert.equal(props['--app-h'], '800px', 'full height as soon as nothing is edited');
  assert.equal(props['--vv-top'], '0px');
  assert.equal(props['--safe-bottom'], undefined);
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

test('viewport: which Home Screen apps fill the screen, how much room the home indicator needs, and when the viewport shrank', () => {
  const iphone = { width: 402, height: 874 };
  assert.equal(fullScreenHeight({ standalone: true, innerWidth: 402, innerHeight: 812, screen: iphone }), 874);
  assert.equal(fullScreenHeight({ standalone: true, innerWidth: 874, innerHeight: 402, screen: iphone }), 402, 'landscape');
  assert.equal(fullScreenHeight({ standalone: false, innerWidth: 402, innerHeight: 700, screen: iphone }), 0, 'Safari has toolbars');
  assert.equal(fullScreenHeight({ standalone: true, innerWidth: 507, innerHeight: 1300, screen: { width: 1024, height: 1366 } }), 0, 'iPad Split View');

  assert.equal(bottomInset({ keyboard: false, full: 874, innerHeight: 874, safeBottom: 34 }), 34, 'the whole screen: room for the home indicator');
  assert.equal(bottomInset({ keyboard: false, full: 874, innerHeight: 812, safeBottom: 34 }), 0, 'iOS 26.5+ left the app 62pt short: it stops above the home indicator');
  assert.equal(bottomInset({ keyboard: false, full: 874, innerHeight: 854, safeBottom: 34 }), 14, 'partly short: only the part it still covers');
  assert.equal(bottomInset({ keyboard: true, full: 874, innerHeight: 874, safeBottom: 34 }), 0, 'the keyboard covers the home indicator');
  assert.equal(bottomInset({ keyboard: false, full: 0, innerHeight: 700, safeBottom: 34 }), null, 'not a full-screen Home Screen app: CSS decides');

  assert.equal(viewportStuck({ tallest: 852, innerHeight: 793, editing: false }), true, 'shrank after the keyboard');
  assert.equal(viewportStuck({ tallest: 852, innerHeight: 793, editing: true }), false, 'the keyboard is up');
  assert.equal(viewportStuck({ tallest: 812, innerHeight: 812, editing: false }), false, 'short from launch (iOS 26.5+): nothing to measure again');
  assert.equal(viewportStuck({ tallest: 852, innerHeight: 500, editing: false }), false, 'not the status bar case');
  assert.equal(viewportStuck({ tallest: 0, innerHeight: 793, editing: false }), false);
});

test('viewport: iOS 26.5+ makes a Home Screen app short from launch: the app ends at the bottom of what it gets', async () => {
  // WebKit bug 301994: a 402×874 iPhone gets a 812pt web view; iOS still reports a 34pt home indicator inset.
  const shell = { style: { display: '' }, querySelectorAll: () => [], offsetHeight: 812 };
  const { win, doc, props, fire } = fakeWindow({ standalone: true, screen: { width: 402, height: 874 }, innerWidth: 402, innerHeight: 812, shell });
  let flips = 0;
  Object.defineProperty(shell.style, 'display', { get: () => '', set: (v) => { if (v === 'none') flips++; } });
  trackViewport(win);
  assert.equal(props['--app-h'], '812px');
  assert.equal(props['--safe-bottom'], '0px', 'no room kept for a home indicator the app never reaches');
  fire('doc', 'focusout');
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(flips, 0, 'nothing to measure again: every value agrees');

  // Rotating to landscape and back gives the app the whole screen again (reported on iOS 26.6).
  win.innerHeight = 874;
  win.visualViewport.height = 874;
  fire('win', 'resize');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(props['--app-h'], '874px');
  assert.equal(props['--safe-bottom'], '34px', 'room for the home indicator again');
});

test('viewport: when the viewport shrinks after the keyboard (iOS 17/18), the app measures again once and keeps its scroll position', async () => {
  const list = { scrollTop: 420 };
  const shell = {
    style: { display: '' },
    querySelectorAll: () => [list],
  };
  const { win, doc, props, fire } = fakeWindow({ standalone: true, screen: { width: 393, height: 852 }, innerWidth: 393, innerHeight: 852, shell });
  Object.defineProperty(shell, 'offsetHeight', {
    get() {
      if (shell.style.display === 'none') {
        list.scrollTop = 0;
        win.innerHeight = 852;
      }
      return win.innerHeight;
    },
  });
  trackViewport(win);
  assert.equal(props['--app-h'], '852px');

  // The keyboard opens and closes; WebKit leaves the viewport 59px short.
  doc.activeElement = { tagName: 'TEXTAREA' };
  fire('doc', 'focusin');
  doc.activeElement = null;
  win.innerHeight = 793;
  win.visualViewport.height = 793;
  fire('doc', 'focusout');
  assert.equal(props['--app-h'], '793px');
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(props['--app-h'], '852px', 'the whole screen again');
  assert.equal(props['--safe-bottom'], '34px');
  assert.equal(shell.style.display, '');
  assert.equal(list.scrollTop, 420, 'the list stays where it was');
  await new Promise((r) => setTimeout(r, 700));
});
