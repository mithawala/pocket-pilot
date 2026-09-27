/**
 * Public-facing types for the multi-host SDK.
 *
 * @module client/hosts/types
 */
import { AhpClientError } from '../error.js';
import { defaultReconnectPolicy } from './policy.js';
/**
 * Convenience predicate: is the host currently connected?
 */
export function isConnected(state) {
    return state.status === 'connected';
}
/**
 * Convenience predicate: is the host in a terminal failure state?
 */
export function isFailed(state) {
    return state.status === 'failed';
}
/** The protocol's root channel URI. */
export const ROOT_RESOURCE_URI = 'ahp-root://';
/**
 * Apply defaults to a {@link HostConfig}, including the default
 * `['ahp-root://']` subscription and the default reconnect policy.
 *
 * @internal
 */
export function resolveConfig(config) {
    return {
        id: config.id,
        label: config.label,
        clientId: config.clientId ?? null,
        initialSubscriptions: config.initialSubscriptions
            ? [...config.initialSubscriptions]
            : [ROOT_RESOURCE_URI],
        clientConfig: config.clientConfig ?? {},
        transportFactory: config.transportFactory,
        reconnectPolicy: config.reconnectPolicy ?? defaultReconnectPolicy(),
    };
}
/** @internal */
export function tagClientEvent(hostId, event) {
    return { hostId, channel: event.channel, event: event.event };
}
// ─── Errors ──────────────────────────────────────────────────────────────────
/**
 * Base class for every error thrown by the multi-host SDK layer that
 * isn't already an {@link AhpClientError} (RPC failures, transport
 * errors, etc. still surface from the underlying {@link AhpClient}
 * unmodified).
 *
 * Extends {@link AhpClientError} so consumers can catch every multi-host
 * SDK error with a single `instanceof` check.
 */
export class HostMultiError extends AhpClientError {
    constructor(message, options) {
        super(message, options);
        this.name = 'HostMultiError';
    }
}
/** No host with that id is currently registered. */
export class UnknownHostError extends HostMultiError {
    hostId;
    constructor(hostId) {
        super(`no host registered with id "${hostId}"`);
        this.name = 'UnknownHostError';
        this.hostId = hostId;
    }
}
/**
 * A host with this id is already registered. Remove the existing host
 * first if you want to replace it.
 */
export class DuplicateHostError extends HostMultiError {
    hostId;
    constructor(hostId) {
        super(`a host with id "${hostId}" is already registered`);
        this.name = 'DuplicateHostError';
        this.hostId = hostId;
    }
}
/**
 * The {@link HostClientHandle} was issued for a connection that has
 * since been replaced by a reconnect. Acquire a fresh handle via
 * {@link MultiHostClient.client}.
 *
 * Both generations are reported so consumers can log a clean "stale
 * handle at gen N, host is now gen M" breadcrumb and retry against the
 * fresh handle.
 */
export class HostReconnectedError extends HostMultiError {
    hostId;
    /** Generation the stale handle was minted at. */
    handleGeneration;
    /** Generation the host is currently on. */
    currentGeneration;
    constructor(hostId, handleGeneration, currentGeneration) {
        super(`host "${hostId}" reconnected (generation ${handleGeneration} -> ${currentGeneration}); request a fresh client handle`);
        this.name = 'HostReconnectedError';
        this.hostId = hostId;
        this.handleGeneration = handleGeneration;
        this.currentGeneration = currentGeneration;
    }
}
/**
 * The host's runtime has been torn down — the host was removed via
 * {@link MultiHostClient.removeHost} or the entire {@link MultiHostClient}
 * was shut down. This is a **permanent** failure; the host is not
 * coming back. Use {@link HostNotConnectedError} to distinguish the
 * transient "registered but currently disconnected/reconnecting" case.
 */
export class HostShutDownError extends HostMultiError {
    hostId;
    constructor(hostId) {
        super(`host "${hostId}" runtime is no longer active`);
        this.name = 'HostShutDownError';
        this.hostId = hostId;
    }
}
/**
 * The host is registered but has no active client connection right now
 * (the supervisor is `connecting`, `reconnecting`, `disconnected`, or
 * `failed`). This is **recoverable**: the supervisor will keep retrying
 * per its {@link ReconnectPolicy}, or the caller can force a fresh
 * attempt via {@link MultiHostClient.reconnectHost}. Subscriptions
 * issued in this state are still tracked locally and replayed on the
 * next successful connect.
 *
 * Use {@link HostShutDownError} to distinguish permanent teardown.
 */
export class HostNotConnectedError extends HostMultiError {
    hostId;
    constructor(hostId) {
        super(`host "${hostId}" is not currently connected`);
        this.name = 'HostNotConnectedError';
        this.hostId = hostId;
    }
}
/**
 * The configured {@link ClientIdStore} failed to load or persist a
 * host's `clientId`.
 *
 * Surfaced from {@link MultiHostClient.addHost} when the underlying
 * store I/O fails (e.g. a file-backed store can't write its directory).
 */
export class ClientIdStoreError extends HostMultiError {
    hostId;
    constructor(hostId, message, options) {
        super(`client id store error for host "${hostId}": ${message}`, options);
        this.name = 'ClientIdStoreError';
        this.hostId = hostId;
    }
}
// ─── ID generation ───────────────────────────────────────────────────────────
/**
 * Generate a fresh UUID-shaped `clientId`. Prefers
 * `crypto.randomUUID()` (Node 19+, modern browsers); falls back to
 * `crypto.getRandomValues()` for the 16 random bytes when only that is
 * available (older browsers / non-secure contexts); and only falls
 * back to `Math.random()` as a last resort for environments where no
 * Web Crypto API is exposed at all.
 *
 * @internal
 */
export function generateClientId() {
    const cryptoObj = globalThis.crypto;
    if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
        return cryptoObj.randomUUID();
    }
    const bytes = new Uint8Array(16);
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
        cryptoObj.getRandomValues(bytes);
    }
    else {
        // Last-resort fallback. `Math.random()` is not cryptographically
        // strong, but consumers that need cross-launch identity should
        // persist the value through a ClientIdStore anyway.
        for (let i = 0; i < 16; i++)
            bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = (n) => n.toString(16).padStart(2, '0');
    const h = Array.from(bytes, hex).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
