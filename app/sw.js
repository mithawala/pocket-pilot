/* Pocket Pilot service worker: offline app shell, push notifications, notification clicks. */
const VERSION = 'pp-6329fe12c88e';
// Every file of this release (stamped by scripts/build-site.mjs; empty when served from the sources).
const FILES = ["./css/app.css","./favicon.png","./icons/apple-touch-icon.png","./icons/badge-96.png","./icons/bot.svg","./icons/icon-192.png","./icons/icon-512.png","./icons/icon.svg","./icons/maskable-512.png","./icons/maskable.svg","./index.html","./js/boot.js","./js/core/bytes.js","./js/core/protocol.js","./js/core/secure-channel.js","./js/core/totp.js","./js/demo/demo.js","./js/lib/app-update.js","./js/lib/asks.js","./js/lib/attachments.js","./js/lib/db.js","./js/lib/format.js","./js/lib/highlight.js","./js/lib/markdown.js","./js/lib/push.js","./js/lib/ui.js","./js/lib/uploads.js","./js/lib/viewport.js","./js/lib/webauthn.js","./js/main.js","./js/model/host-store.js","./js/net/host-connection.js","./js/net/rendezvous.js","./js/net/socket.js","./js/ui/app.js","./js/ui/authenticator.js","./js/ui/chat.js","./js/ui/common.js","./js/ui/composer.js","./js/ui/model-picker.js","./js/ui/pair.js","./js/ui/parts.js","./js/ui/scanner.js","./js/ui/sessions.js","./js/ui/settings.js","./js/ui/viewer.js","./manifest.webmanifest","./vendor/ahp/LICENSE","./vendor/ahp/client/async-queue.js","./vendor/ahp/client/canvas-state.js","./vendor/ahp/client/client.js","./vendor/ahp/client/error.js","./vendor/ahp/client/events.js","./vendor/ahp/client/hosts/client-id-store.js","./vendor/ahp/client/hosts/factory.js","./vendor/ahp/client/hosts/host-client-handle.js","./vendor/ahp/client/hosts/index.js","./vendor/ahp/client/hosts/multi.js","./vendor/ahp/client/hosts/policy.js","./vendor/ahp/client/hosts/runtime.js","./vendor/ahp/client/hosts/state-mirror.js","./vendor/ahp/client/hosts/types.js","./vendor/ahp/client/index.js","./vendor/ahp/client/managed-subscriptions.js","./vendor/ahp/client/state-mirror.js","./vendor/ahp/client/transport.js","./vendor/ahp/types/action-origin.generated.js","./vendor/ahp/types/actions.js","./vendor/ahp/types/channels-annotations/actions.js","./vendor/ahp/types/channels-annotations/reducer.js","./vendor/ahp/types/channels-annotations/state.js","./vendor/ahp/types/channels-automation-run/actions.js","./vendor/ahp/types/channels-automation-run/reducer.js","./vendor/ahp/types/channels-automation-run/state.js","./vendor/ahp/types/channels-automation/actions.js","./vendor/ahp/types/channels-automation/commands.js","./vendor/ahp/types/channels-automation/reducer.js","./vendor/ahp/types/channels-automation/state.js","./vendor/ahp/types/channels-canvas/actions.js","./vendor/ahp/types/channels-canvas/reducer.js","./vendor/ahp/types/channels-canvas/state.js","./vendor/ahp/types/channels-changeset/actions.js","./vendor/ahp/types/channels-changeset/commands.js","./vendor/ahp/types/channels-changeset/reducer.js","./vendor/ahp/types/channels-changeset/state.js","./vendor/ahp/types/channels-chat/actions.js","./vendor/ahp/types/channels-chat/commands.js","./vendor/ahp/types/channels-chat/reducer.js","./vendor/ahp/types/channels-chat/state.js","./vendor/ahp/types/channels-otlp/notifications.js","./vendor/ahp/types/channels-otlp/state.js","./vendor/ahp/types/channels-resource-watch/actions.js","./vendor/ahp/types/channels-resource-watch/commands.js","./vendor/ahp/types/channels-resource-watch/reducer.js","./vendor/ahp/types/channels-resource-watch/state.js","./vendor/ahp/types/channels-root/actions.js","./vendor/ahp/types/channels-root/commands.js","./vendor/ahp/types/channels-root/notifications.js","./vendor/ahp/types/channels-root/reducer.js","./vendor/ahp/types/channels-root/state.js","./vendor/ahp/types/channels-session/actions.js","./vendor/ahp/types/channels-session/commands.js","./vendor/ahp/types/channels-session/reducer.js","./vendor/ahp/types/channels-session/state.js","./vendor/ahp/types/channels-terminal/actions.js","./vendor/ahp/types/channels-terminal/commands.js","./vendor/ahp/types/channels-terminal/reducer.js","./vendor/ahp/types/channels-terminal/state.js","./vendor/ahp/types/commands.js","./vendor/ahp/types/common/actions.js","./vendor/ahp/types/common/commands.js","./vendor/ahp/types/common/errors.js","./vendor/ahp/types/common/messages.js","./vendor/ahp/types/common/notifications.js","./vendor/ahp/types/common/reducer-helpers.js","./vendor/ahp/types/common/state.js","./vendor/ahp/types/common/timestamps.js","./vendor/ahp/types/errors.js","./vendor/ahp/types/index.js","./vendor/ahp/types/messages.js","./vendor/ahp/types/notifications.js","./vendor/ahp/types/reducers.js","./vendor/ahp/types/state.js","./vendor/ahp/types/version/message-checks.js","./vendor/ahp/types/version/registry.js","./vendor/ahp/ws/index.js","./vendor/ahp/ws/transport.js","./vendor/dompurify/LICENSE","./vendor/dompurify/purify.es.js","./vendor/hljs/LICENSE","./vendor/hljs/core.min.js","./vendor/hljs/languages/bash.min.js","./vendor/hljs/languages/c.min.js","./vendor/hljs/languages/cpp.min.js","./vendor/hljs/languages/csharp.min.js","./vendor/hljs/languages/css.min.js","./vendor/hljs/languages/diff.min.js","./vendor/hljs/languages/dockerfile.min.js","./vendor/hljs/languages/go.min.js","./vendor/hljs/languages/ini.min.js","./vendor/hljs/languages/java.min.js","./vendor/hljs/languages/javascript.min.js","./vendor/hljs/languages/json.min.js","./vendor/hljs/languages/kotlin.min.js","./vendor/hljs/languages/markdown.min.js","./vendor/hljs/languages/php.min.js","./vendor/hljs/languages/plaintext.min.js","./vendor/hljs/languages/powershell.min.js","./vendor/hljs/languages/python.min.js","./vendor/hljs/languages/ruby.min.js","./vendor/hljs/languages/rust.min.js","./vendor/hljs/languages/shell.min.js","./vendor/hljs/languages/sql.min.js","./vendor/hljs/languages/swift.min.js","./vendor/hljs/languages/typescript.min.js","./vendor/hljs/languages/xml.min.js","./vendor/hljs/languages/yaml.min.js","./vendor/htm/LICENSE","./vendor/htm/htm.module.js","./vendor/jsqr/LICENSE","./vendor/jsqr/jsQR.js","./vendor/marked/LICENSE","./vendor/marked/marked.esm.js","./vendor/preact/LICENSE","./vendor/preact/hooks.module.js","./vendor/preact/preact.module.js","./vendor/qrcode/LICENSE","./vendor/qrcode/qrcode.mjs"];
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
