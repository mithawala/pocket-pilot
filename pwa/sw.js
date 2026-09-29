/* Pocket Pilot service worker: offline app shell, push notifications, notification clicks. */
const VERSION = 'pp-v1';
const DEV = ['localhost', '127.0.0.1'].includes(self.location.hostname);
const SHELL = ['./', './index.html', './css/app.css', './js/boot.js', './js/main.js', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/badge-96.png'];

self.addEventListener('install', (event) => {
  // Straight from the server: the browser's HTTP cache may still hold the previous release's files.
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

// A starting page asks which release this worker serves (js/boot.js), to catch up if it's an older one.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'pp-version' && event.ports?.[0]) event.ports[0].postMessage({ version: VERSION });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/health')) return;
  const isDoc = req.mode === 'navigate' || url.pathname.endsWith('/index.html') || url.pathname.endsWith('/');
  const isBoot = url.pathname.endsWith('/js/boot.js');
  if (isDoc || isBoot || DEV) {
    // Network first for the document and the boot script (and everything during local development) so new
    // releases show up immediately.
    event.respondWith((async () => {
      try {
        const res = await fetch(req, isDoc || isBoot ? { cache: 'no-cache' } : undefined);
        const cache = await caches.open(VERSION);
        if (res.ok) cache.put(isDoc ? './index.html' : isBoot ? './js/boot.js' : req, res.clone());
        return res;
      } catch {
        return (await caches.match(isDoc ? './index.html' : isBoot ? './js/boot.js' : req)) || Response.error();
      }
    })());
    return;
  }
  // Stale-while-revalidate for everything else (scripts, styles, icons, vendored libraries). The refresh asks
  // the server (`no-cache`), not the HTTP cache, so a new release never takes files from the one before.
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req);
    const network = fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => cached);
    return cached || network;
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Pocket Pilot', body: event.data ? event.data.text() : '' };
  }
  const urgent = data.kind === 'input';
  event.waitUntil(self.registration.showNotification(data.title || 'Pocket Pilot', {
    body: data.body || '',
    icon: './icons/icon-192.png',
    badge: './icons/badge-96.png',
    tag: data.tag || 'pocket-pilot',
    renotify: true,
    requireInteraction: urgent,
    vibrate: urgent ? [90, 50, 90] : [60],
    timestamp: data.ts || Date.now(),
    data: { hostId: data.hostId, session: data.session },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { hostId, session } = event.notification.data || {};
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = all.find((c) => c.url.startsWith(self.registration.scope));
    if (client) {
      await client.focus();
      client.postMessage({ type: 'open-session', hostId, session });
      return;
    }
    const target = hostId && session ? `./#/open/${encodeURIComponent(hostId)}/${encodeURIComponent(session)}` : './';
    await self.clients.openWindow(target);
  })());
});
