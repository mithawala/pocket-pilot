/**
 * Generation-checked handle to the underlying single-host {@link AhpClient}.
 *
 * Issued by {@link MultiHostClient.client}. Every dispatch through this
 * handle verifies that the host is still on the generation the handle
 * was minted at; if a reconnect has occurred, dispatching throws
 * {@link HostReconnectedError} instead of silently writing to the new
 * connection. Removing the host marks the handle as shut down and
 * subsequent calls throw {@link HostShutDownError}.
 *
 * @module client/hosts/host-client-handle
 */
import { HostReconnectedError, HostShutDownError, } from './types.js';
/**
 * Generation-checked wrapper around the per-host {@link AhpClient}.
 *
 * Acquired via {@link MultiHostClient.client}. Cheap to clone — the
 * underlying client and shared state are reference-shared.
 */
export class HostClientHandle {
    /** Host this handle was issued for. */
    hostId;
    /** Generation this handle was minted at. */
    generation;
    source;
    client;
    /** @internal */
    constructor(source, generation, client) {
        this.source = source;
        this.hostId = source.hostId;
        this.generation = generation;
        this.client = client;
    }
    /**
     * Validate this handle against the host's current generation and
     * shutdown state. Throws {@link HostShutDownError} or
     * {@link HostReconnectedError} on failure.
     */
    checkAlive() {
        if (this.source.shutdownReason !== null) {
            throw new HostShutDownError(this.hostId);
        }
        if (this.source.generation !== this.generation) {
            throw new HostReconnectedError(this.hostId, this.generation, this.source.generation);
        }
    }
    /**
     * Dispatch an action through this connection, refusing if the
     * connection has been replaced by a reconnect or the host has been
     * removed.
     */
    dispatch(channel, action, clientSeq) {
        this.checkAlive();
        return this.client.dispatch(channel, action, clientSeq);
    }
    /**
     * Issue an arbitrary typed JSON-RPC request through this connection,
     * refusing if the connection has been replaced by a reconnect or the
     * host has been removed.
     */
    async request(method, params) {
        this.checkAlive();
        return this.client.request(method, params);
    }
    /**
     * Borrow the underlying {@link AhpClient} for advanced use. The
     * caller is responsible for not holding it past the next reconnect —
     * the returned reference can become stale at any await point.
     */
    rawClient() {
        this.checkAlive();
        return this.client;
    }
}
