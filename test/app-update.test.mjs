import test from 'node:test';
import assert from 'node:assert/strict';
import { keepCurrent, restorePairing, isBusy } from '../pwa/js/lib/app-update.js';

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

function fakeDoc({ focused = null, texts = [], selectors = [] } = {}) {
  const listeners = {};
  return {
    visibilityState: 'visible',
    activeElement: focused,
    querySelector: (sel) => (sel.split(',').some((s) => selectors.includes(s.trim())) ? {} : null),
    querySelectorAll: (sel) => (sel === 'textarea' ? texts.map((value) => ({ value })) : []),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    fire: (type) => listeners[type]?.(),
  };
}

function fakeWindow({ controller = true, doc = fakeDoc() } = {}) {
  const swListeners = {};
  const reg = { updates: 0, update() { this.updates++; return Promise.resolve(); } };
  const win = {
    document: doc,
    sessionStorage: fakeStorage(),
    reloads: 0,
    location: { reload() { win.reloads++; } },
    navigator: {
      serviceWorker: {
        controller: controller ? {} : null,
        register: () => Promise.resolve(reg),
        addEventListener: (type, fn) => { swListeners[type] = fn; },
      },
    },
    newRelease: () => swListeners.controllerchange?.(),
    reg,
  };
  return win;
}

test('app update: the first install never reloads; a new release reloads an idle app right away', async () => {
  const first = fakeWindow({ controller: false });
  keepCurrent({ app: {}, win: first });
  first.newRelease();
  assert.equal(first.reloads, 0, 'the page came from the network: already the newest code');

  const win = fakeWindow();
  keepCurrent({ app: {}, win });
  win.newRelease();
  assert.equal(win.reloads, 1);
});

test('app update: a busy app waits for its next return to the screen, and a pairing comes along', async () => {
  const doc = fakeDoc({ selectors: ['.progress-steps'] });
  const win = fakeWindow({ doc });
  const app = { pendingFragment: '#pair=1.abc.def.ghi.' };
  const ctl = keepCurrent({ app, win });
  win.newRelease();
  assert.equal(win.reloads, 0, 'a pairing under way is never cut off');
  assert.equal(ctl.pending, true);
  doc.fire('visibilitychange');
  assert.equal(win.reloads, 0, 'still pairing');
  doc.querySelector = () => null;
  doc.fire('visibilitychange');
  assert.equal(win.reloads, 1, 'reloads once nothing is going on');
  const saved = JSON.parse(win.sessionStorage.getItem('pp:pairing'));
  assert.equal(saved.fragment, app.pendingFragment);
  assert.equal(restorePairing(win.sessionStorage), app.pendingFragment, 'the new release picks the pairing up');
  assert.equal(restorePairing(win.sessionStorage), null, 'only once');
});

test('app update: coming back to the screen looks for a new release at most once a minute', async () => {
  const win = fakeWindow();
  keepCurrent({ app: {}, win });
  await Promise.resolve();
  const realNow = Date.now;
  try {
    let now = realNow() + 61_000;
    Date.now = () => now;
    win.document.fire('visibilitychange');
    win.document.fire('visibilitychange');
    assert.equal(win.reg.updates, 1);
    now += 61_000;
    win.document.visibilityState = 'hidden';
    win.document.fire('visibilitychange');
    assert.equal(win.reg.updates, 1, 'not while hidden');
    win.document.visibilityState = 'visible';
    win.document.fire('visibilitychange');
    assert.equal(win.reg.updates, 2);
  } finally {
    Date.now = realNow;
  }
});

test('app update: what counts as busy', () => {
  assert.equal(isBusy({}, fakeDoc()), false);
  assert.equal(isBusy({ sheet: {} }, fakeDoc()), true, 'a confirmation sheet');
  assert.equal(isBusy({ active: { conn: { state: 'code' } } }, fakeDoc()), true, 'waiting for a code');
  assert.equal(isBusy({ active: { conn: { state: 'online' } } }, fakeDoc()), false);
  assert.equal(isBusy({}, fakeDoc({ selectors: ['.scanner'] })), true, 'the QR scanner');
  assert.equal(isBusy({}, fakeDoc({ focused: { tagName: 'TEXTAREA' } })), true, 'typing');
  assert.equal(isBusy({}, fakeDoc({ focused: { tagName: 'INPUT', type: 'checkbox' } })), false);
  assert.equal(isBusy({}, fakeDoc({ texts: ['half a message'] })), true, 'an unsent message');
  assert.equal(isBusy({}, fakeDoc({ texts: ['   '] })), false);
});

test('app update: stale or broken saved pairings are ignored', () => {
  const s = fakeStorage();
  s.setItem('pp:pairing', JSON.stringify({ fragment: '#pair=x', at: Date.now() - 11 * 60 * 1000 }));
  assert.equal(restorePairing(s), null, 'older than 10 minutes');
  s.setItem('pp:pairing', 'not json');
  assert.equal(restorePairing(s), null);
  assert.equal(restorePairing(fakeStorage()), null);
});
