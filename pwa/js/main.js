import { html, render } from './lib/ui.js';
import { App, AppController, applyTheme } from './ui/app.js';
import { isPairingFragment } from './core/secure-channel.js';

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

// Fit the app to the *visible* viewport, so the composer sits right above the on-screen keyboard
// (iOS shrinks the visual viewport and pans it instead of resizing the page).
function trackViewport() {
  const style = document.documentElement.style;
  const vv = window.visualViewport;
  let frame = 0;
  const apply = () => {
    frame = 0;
    if (vv && Math.abs(vv.scale - 1) > 0.01) return; // pinch-zoomed: leave the layout alone
    style.setProperty('--app-h', `${Math.round(vv ? vv.height : window.innerHeight)}px`);
    style.setProperty('--vv-top', `${Math.round(vv ? vv.offsetTop : 0)}px`);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(apply);
  };
  (vv || window).addEventListener('resize', schedule);
  vv?.addEventListener('scroll', schedule);
  window.addEventListener('orientationchange', schedule);
  apply();
}
trackViewport();

// Take the pairing token out of the address bar (and history) before anything else runs.
let pendingFragment = null;
if (isPairingFragment(location.hash)) {
  pendingFragment = location.hash;
  history.replaceState(null, '', `${location.pathname}${location.search}#/pair`);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', { scope: './' }).catch((err) => console.warn('Service worker registration failed', err));
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !sessionStorage.getItem('pp-sw-updated')) return;
    reloading = true;
    sessionStorage.removeItem('pp-sw-updated');
    location.reload();
  });
}

const demo = new URLSearchParams(location.search).has('demo');
const app = new AppController({ pendingFragment: demo ? null : pendingFragment, demo });
if (['localhost', '127.0.0.1'].includes(location.hostname)) window.__pocketPilot = app;
render(html`<${App} app=${app} />`, document.getElementById('app'));
app.init();
