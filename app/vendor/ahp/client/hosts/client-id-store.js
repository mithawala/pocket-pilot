/**
 * Pluggable persistence for stable per-host `clientId`s.
 *
 * The AHP `reconnect` flow uses `clientId` to identify a logical client
 * across reconnects. Apps that need cross-launch identity (i.e. resume
 * an in-progress turn after the user kills the app) must persist the
 * `clientId` somewhere durable and surface it through a {@link ClientIdStore}.
 *
 * The default in-memory store ({@link InMemoryClientIdStore}) keeps ids
 * stable within a single process but resets on restart — fine for
 * tests and ephemeral CLIs. Production apps wrap their platform's
 * secure storage (Keychain, `localStorage`, IndexedDB, Node `fs`,
 * Electron `safeStorage`, …) in a custom {@link ClientIdStore}.
 *
 * @module client/hosts/client-id-store
 */
/**
 * In-process {@link ClientIdStore} backed by a `Map`.
 *
 * Survives reconnects within the same process but not restarts. Fine
 * for tests, ephemeral CLIs, and as a starting point.
 */
export class InMemoryClientIdStore {
    inner = new Map();
    load(hostId) {
        return Promise.resolve(this.inner.get(hostId) ?? null);
    }
    store(hostId, clientId) {
        this.inner.set(hostId, clientId);
        return Promise.resolve();
    }
}
