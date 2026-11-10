// Tiny IndexedDB wrapper. Host records keep their device key pair as CryptoKey objects:
// IndexedDB stores them natively and the private key stays non-extractable.
const DB_NAME = 'pocket-pilot';
const DB_VERSION = 1;
let dbp;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('hosts')) db.createObjectStore('hosts', { keyPath: 'hostId' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export const db = {
  async hosts() {
    const all = await tx('hosts', 'readonly', (s) => wrap(s.getAll()));
    return (all || []).sort((a, b) => (a.pairedAt || 0) - (b.pairedAt || 0));
  },
  putHost(host) {
    return tx('hosts', 'readwrite', (s) => wrap(s.put(host)));
  },
  deleteHost(hostId) {
    return tx('hosts', 'readwrite', (s) => wrap(s.delete(hostId)));
  },
  get(key) {
    return tx('kv', 'readonly', (s) => wrap(s.get(key)));
  },
  set(key, value) {
    return tx('kv', 'readwrite', (s) => wrap(s.put(value, key)));
  },
};

/** Asks the browser not to evict our storage (keys!) under storage pressure. */
export async function persistStorage() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* best effort */
  }
}
