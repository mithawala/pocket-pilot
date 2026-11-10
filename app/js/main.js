import { html, render } from './lib/ui.js';
import { App, AppController, applyTheme } from './ui/app.js';
import { isPairingFragment } from './core/secure-channel.js';
import { trackViewport } from './lib/viewport.js';
import { keepCurrent, restorePairing } from './lib/app-update.js';

let savedTheme = null;
try {
  savedTheme = localStorage.getItem('pp:theme');
} catch {
  /* storage unavailable */
}
applyTheme(savedTheme || 'dark');
// With "System", keep the browser chrome colour in step when the OS switches light/dark.
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => {
  if (document.documentElement.getAttribute('data-theme') === 'system') applyTheme('system');
});

trackViewport(window);

// Take the pairing token out of the address bar (and history) before anything else runs.
let pendingFragment = null;
if (isPairingFragment(location.hash)) {
  pendingFragment = location.hash;
} else {
  // A pairing link carried across a reload into a new release.
  pendingFragment = restorePairing();
}
if (pendingFragment) history.replaceState(null, '', `${location.pathname}${location.search}#/pair`);

const demo = new URLSearchParams(location.search).has('demo');
const app = new AppController({ pendingFragment: demo ? null : pendingFragment, demo });
if (['localhost', '127.0.0.1'].includes(location.hostname)) window.__pocketPilot = app;
render(html`<${App} app=${app} />`, document.getElementById('app'));
app.init();
keepCurrent({ app });
