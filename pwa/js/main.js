import { html, render } from './lib/ui.js';
import { App, AppController } from './ui/app.js';

// Take the pairing token out of the address bar (and history) before anything else runs.
let pendingFragment = null;
if (/(?:^|[#&])pair=1\./.test(location.hash)) {
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

const app = new AppController({ pendingFragment });
if (['localhost', '127.0.0.1'].includes(location.hostname)) window.__pocketPilot = app;
render(html`<${App} app=${app} />`, document.getElementById('app'));
app.init();
