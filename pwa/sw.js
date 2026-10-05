/* Pocket Pilot service worker: offline app shell, push notifications, notification clicks. */
const VERSION = 'pp-v1';
// Every file of this release (stamped by scripts/build-site.mjs; empty when served from the sources).
const FILES = [];
const DEV = !FILES.length;
const SHELL = ['./', './index.html', './css/app.css', './js/boot.js', './js/main.js', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/badge-96.png'];
const scoped = (u) => new URL(u, self.registration.scope).href;

/**
 * A release is installed whole, or not at all: every one of its files is fetched before this worker takes
 * over, and only then served. Fetched one by one later, an app could mix two releases' files (a module of
 * the new one calling into one of the old), from the browser's HTTP cache or from a CDN edge that still has
 * the previous release. The release's name in the query misses both; the file is kept under its own name.
 */
async function installRelease() {
  const cache = await caches.open(VERSION);
  const files = DEV ? SHELL : FILES;
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++];
      const url = new URL(scoped(file));
      if (!DEV) url.searchParams.set('r', VERSION);
      const res = await fetch(new Request(url.href, { cache: 'reload' }));
      if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
      await cache.put(scoped(file), res);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

self.addEventListener('install', (event) => {
  event.waitUntil(installRelease().then(() => self.skipWaiting()));
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
        if (res.ok) cache.put(isDoc ? scoped('./index.html') : isBoot ? scoped('./js/boot.js') : req, res.clone());
        return res;
      } catch {
        return (await caches.match(isDoc ? scoped('./index.html') : isBoot ? scoped('./js/boot.js') : req)) || Response.error();
      }
    })());
    return;
  }
  // Everything else is this release's own, as installed with it (see installRelease).
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    return (await cache.match(req, { ignoreSearch: true })) || fetch(req, { cache: 'no-cache' });
  })());
});

/**
 * A paired computer moved to a new address (a new tunnel) and has no auto-reconnect gist: it said so
 * in an end-to-end encrypted notification. Only the computer this device takes notifications from can
 * send one, and the connection still checks the computer's key, so a wrong address can't impersonate it.
 * True when the address is for that computer, and stored.
 */
async function rememberAddress(hostId, url) {
  if (typeof hostId !== 'string' || !/^https:\/\/[^/\s?#]+$/.test(url || '')) return false;
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('pocket-pilot', 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('hosts')) req.result.createObjectStore('hosts', { keyPath: 'hostId' });
      if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction('hosts', 'readwrite');
      const store = t.objectStore('hosts');
      let accepted = false;
      const get = store.get(hostId);
      get.onsuccess = () => {
        const host = get.result;
        if (!host?.pushEnabled) return;
        accepted = true;
        if (host.url !== url) {
          host.url = url;
          store.put(host);
        }
      };
      t.oncomplete = () => resolve(accepted);
      t.onerror = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Pocket Pilot', body: event.data ? event.data.text() : '' };
  }
  const urgent = data.kind === 'input';
  event.waitUntil((async () => {
    if (data.kind === 'address' && (await rememberAddress(data.hostId, data.url).catch(() => false))) {
      for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) client.postMessage({ type: 'host-address', hostId: data.hostId, url: data.url });
    }
    await self.registration.showNotification(data.title || 'Pocket Pilot', {
      body: data.body || '',
      icon: './icons/icon-192.png',
      badge: './icons/badge-96.png',
      tag: data.tag || 'pocket-pilot',
      renotify: data.kind !== 'address',
      silent: data.kind === 'address',
      requireInteraction: urgent,
      vibrate: urgent ? [90, 50, 90] : [60],
      timestamp: data.ts || Date.now(),
      data: { hostId: data.hostId, session: data.session },
    });
  })());
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
