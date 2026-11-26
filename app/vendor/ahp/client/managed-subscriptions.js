/**
 * Shared, reference-counted ownership for AHP subscriptions.
 *
 * @module client/managed-subscriptions
 */
import { AsyncBroadcastQueue } from './async-queue.js';
import { ClientClosedError } from './error.js';
class ManagedSubscriptionState {
    uri;
    ready;
    statusValue = 'pending';
    resultValue;
    errorValue;
    resolveReady;
    rejectReady;
    constructor(uri) {
        this.uri = uri;
        let resolveReady;
        let rejectReady;
        this.ready = new Promise((resolve, reject) => {
            resolveReady = resolve;
            rejectReady = reject;
        });
        // A consumer may prefer status/error inspection over awaiting `ready`.
        // Observe the rejection here so that path never creates an unhandled one.
        void this.ready.catch(() => undefined);
        this.resolveReady = resolveReady;
        this.rejectReady = rejectReady;
    }
    get status() {
        return this.statusValue;
    }
    get result() {
        return this.resultValue;
    }
    get error() {
        return this.errorValue;
    }
    activate(result) {
        if (this.statusValue !== 'pending')
            return;
        this.resultValue = result;
        this.statusValue = 'active';
        this.resolveReady(result);
    }
    fail(error) {
        if (this.statusValue !== 'pending')
            return;
        this.errorValue = error;
        this.statusValue = 'failed';
        this.rejectReady(error);
    }
    close(message = 'managed subscription closed') {
        if (this.statusValue === 'failed' || this.statusValue === 'closed')
            return;
        if (this.statusValue === 'pending') {
            this.rejectReady(new ClientClosedError(message));
        }
        this.statusValue = 'closed';
    }
}
/**
 * Owns one wire-level subscription per URI and shares it across named leases.
 *
 * Concurrent acquires coalesce onto the same request. A failed request is
 * removed from the manager after its local attachment is cleaned up, so the
 * next acquire deterministically makes a fresh request. Releasing the last
 * lease tears down both local fan-out and the server subscription.
 */
export class ManagedSubscriptionManager {
    client;
    eventBuffer;
    entries = new Map();
    nextHolderId = 1;
    closed = false;
    constructor(client, options = {}) {
        this.client = client;
        const buffer = options.eventBuffer ?? 4096;
        this.eventBuffer = buffer >= 1 ? Math.floor(buffer) : 1;
    }
    /**
     * Acquire a named lease for `uri`.
     *
     * The first acquire starts the wire request. Later acquires share its result
     * and event fan-out. All holders for a URI must use the same subscribe
     * options; conflicting options throw rather than silently changing the
     * already-active server subscription.
     */
    acquire(uri, owner, options = {}) {
        if (this.closed) {
            throw new ClientClosedError('managed subscription manager closed');
        }
        const optionsKey = subscriptionOptionsKey(options);
        let entry = this.entries.get(uri);
        if (entry && entry.optionsKey !== optionsKey) {
            throw new TypeError(`subscription options for "${uri}" differ from the active subscription`);
        }
        if (!entry) {
            entry = {
                uri,
                optionsKey,
                subscription: new ManagedSubscriptionState(uri),
                events: new AsyncBroadcastQueue(this.eventBuffer),
                holders: new Map(),
            };
            this.entries.set(uri, entry);
        }
        const lease = this.createLease(entry, owner);
        if (entry.holders.size === 1) {
            void this.start(entry, options);
        }
        return lease;
    }
    /** Current managed subscription without acquiring another lease. */
    get(uri) {
        return this.entries.get(uri)?.subscription;
    }
    /** Active subscription URIs, in deterministic lexical order. */
    currentSubscriptionUris() {
        return [...this.entries.keys()].sort();
    }
    /** Read-only lifecycle and ownership snapshot for diagnostics. */
    activeSubscriptions() {
        return [...this.entries.values()]
            .sort((a, b) => a.uri.localeCompare(b.uri))
            .map(entry => ({
            uri: entry.uri,
            status: entry.subscription.status,
            refCount: entry.holders.size,
            holders: summarizeHolders(entry.holders),
        }));
    }
    /** Release every managed subscription and reject future acquires. */
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        const entries = [...this.entries.values()];
        this.entries.clear();
        await Promise.all(entries.map(entry => this.disposeEntry(entry, 'managed subscription manager closed')));
    }
    createLease(entry, owner) {
        const holderId = this.nextHolderId++;
        entry.holders.set(holderId, owner);
        const events = entry.events.reader();
        let released = false;
        return {
            subscription: entry.subscription,
            events: events,
            [Symbol.dispose]: () => {
                if (released)
                    return;
                released = true;
                void events.return?.();
                entry.holders.delete(holderId);
                if (entry.holders.size === 0 && this.entries.get(entry.uri) === entry) {
                    this.entries.delete(entry.uri);
                    void this.disposeEntry(entry, 'managed subscription released before ready');
                }
            },
        };
    }
    async start(entry, options) {
        try {
            const { result, subscription } = await this.client.subscribe(entry.uri, options);
            if (this.entries.get(entry.uri) !== entry || entry.holders.size === 0) {
                await subscription.close();
                return;
            }
            entry.source = subscription;
            entry.subscription.activate(result);
            void this.pump(entry, subscription);
        }
        catch (cause) {
            if (this.entries.get(entry.uri) !== entry)
                return;
            this.entries.delete(entry.uri);
            const error = cause instanceof Error ? cause : new Error(String(cause));
            entry.subscription.fail(error);
            entry.events.close();
            await this.client.unsubscribe(entry.uri);
        }
    }
    async pump(entry, source) {
        try {
            for await (const event of source) {
                entry.events.publish(event);
            }
        }
        finally {
            if (this.entries.get(entry.uri) === entry) {
                this.entries.delete(entry.uri);
                entry.subscription.close('managed subscription event stream closed');
                entry.events.close();
            }
        }
    }
    async disposeEntry(entry, message) {
        entry.subscription.close(message);
        entry.events.close();
        await this.client.unsubscribe(entry.uri);
        await entry.source?.close();
    }
}
function subscriptionOptionsKey(options) {
    return JSON.stringify({
        maxLatencyMs: options.delivery?.maxLatencyMs ?? null,
        turns: options.view?.turns ?? null,
    });
}
function summarizeHolders(holders) {
    const counts = new Map();
    for (const owner of holders.values()) {
        counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
    return [...counts.entries()]
        .map(([owner, count]) => ({ owner, count }))
        .sort((a, b) => b.count - a.count || a.owner.localeCompare(b.owner));
}
