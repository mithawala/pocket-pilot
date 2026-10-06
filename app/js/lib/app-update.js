// Moves an open app onto a new release. When the app comes back to the screen it asks for a new service
// worker; once a new release has taken over, the page still runs the code it started with, so it reloads as
// soon as that loses nothing: right away, or the next time the app comes back to the screen. A pairing in
// progress comes along.

const PAIR_KEY = 'pp:pairing';
const PAIR_TTL_MS = 10 * 60 * 1000;
const CHECK_EVERY_MS = 60 * 1000;
const WAITING_ON_YOU = ['passkey', 'code', 'approval', 'setup'];

/** The pairing link carried across a reload into a new release, if any (read once). */
export function restorePairing(storage = globalThis.sessionStorage, now = Date.now()) {
  try {
    const saved = JSON.parse(storage.getItem(PAIR_KEY) || 'null');
    storage.removeItem(PAIR_KEY);
    return saved && typeof saved.fragment === 'string' && now - saved.at < PAIR_TTL_MS ? saved.fragment : null;
  } catch {
    return null;
  }
}

/** Whether reloading now would lose something: a confirmation, pairing or scan under way, or text being typed. */
export function isBusy(app, doc = globalThis.document) {
  if (app?.sheet || WAITING_ON_YOU.includes(app?.active?.conn?.state)) return true;
  if (doc.querySelector('.scanner, .progress-steps, .authn')) return true;
  const el = doc.activeElement;
  if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable || (el.tagName === 'INPUT' && !/^(button|checkbox|radio|submit)$/i.test(el.type || '')))) return true;
  return [...doc.querySelectorAll('textarea')].some((t) => t.value.trim() !== '');
}

/** Registers the service worker and keeps the page on the newest release. */
export function keepCurrent({ app, win = globalThis.window }) {
  const sw = win.navigator?.serviceWorker;
  if (!sw) return null;
  const doc = win.document;
  let hadController = !!sw.controller;
  let pending = false;
  let lastCheck = Date.now();
  let reg = null;
  sw.register('./sw.js', { scope: './' }).then((r) => {
    reg = r;
  }, (err) => console.warn('Service worker registration failed', err));
  const reload = () => {
    if (!pending || isBusy(app, doc)) return false;
    pending = false;
    if (app.pendingFragment) {
      try {
        win.sessionStorage.setItem(PAIR_KEY, JSON.stringify({ fragment: app.pendingFragment, at: Date.now() }));
      } catch {
        /* storage unavailable: the pairing link has to be scanned again */
      }
    }
    win.location.reload();
    return true;
  };
  sw.addEventListener('controllerchange', () => {
    if (!hadController) {
      // The first install: this page came from the network and already runs the newest code.
      hadController = true;
      return;
    }
    pending = true;
    if (doc.visibilityState === 'visible') reload();
  });
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState !== 'visible' || reload()) return;
    if (reg && Date.now() - lastCheck > CHECK_EVERY_MS) {
      lastCheck = Date.now();
      reg.update().catch(() => {});
    }
  });
  return {
    reload,
    get pending() {
      return pending;
    },
  };
}
