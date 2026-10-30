/**
 * Pluggable transport abstraction.
 *
 * The client is transport-agnostic. Any framed message stream — a WebSocket,
 * a Unix socket, stdio, or an in-memory pair for tests — can back an
 * {@link AhpTransport}. The client consumes typed {@link TransportFrame}s and
 * leaves framing/TLS/auth to the transport.
 *
 * @module client/transport
 */
import { TransportError } from './error.js';
/**
 * Wire format helpers used by the client and transports.
 *
 * @internal
 */
export function encodeMessage(message) {
    return JSON.stringify(message);
}
/** Decode an inbound text payload into a {@link ProtocolMessage}. @internal */
export function decodeMessage(text) {
    try {
        return JSON.parse(text);
    }
    catch (cause) {
        throw new TransportError('protocol', `invalid JSON: ${cause.message}`, { cause });
    }
}
// ─── In-memory transport (for tests) ─────────────────────────────────────────
class InMemoryHalf {
    inbox = [];
    waiter = null;
    closed = false;
    /** @internal */
    peer;
    send(message) {
        if (this.closed) {
            throw new TransportError('closed', 'transport closed');
        }
        const text = typeof message === 'string' ? message : encodeMessage(message);
        this.peer.deliver({ kind: 'text', text });
    }
    recv() {
        if (this.inbox.length > 0) {
            return Promise.resolve(this.inbox.shift() ?? null);
        }
        if (this.closed) {
            return Promise.resolve(null);
        }
        return new Promise(resolve => {
            this.waiter = resolve;
        });
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        // Wake any pending receiver with a clean close, then propagate to the peer.
        this.deliver(null);
        this.peer.deliver(null);
    }
    /** @internal */
    deliver(frame) {
        if (this.waiter) {
            const w = this.waiter;
            this.waiter = null;
            w(frame);
        }
        else {
            this.inbox.push(frame);
        }
    }
}
/**
 * A bidirectional in-memory transport pair, primarily for tests.
 *
 * Each half implements {@link AhpTransport}. A {@link AhpTransport.send}
 * on one half delivers to the other half's {@link AhpTransport.recv} as a
 * text frame.
 *
 * ```ts
 * const [client, server] = InMemoryTransport.pair();
 * const c = new AhpClient(client);
 * c.connect();
 * // The test harness drives `server.recv()` / `server.send(...)` directly.
 * ```
 */
export const InMemoryTransport = {
    /** Returns a connected `[a, b]` pair. */
    pair() {
        const a = new InMemoryHalf();
        const b = new InMemoryHalf();
        a.peer = b;
        b.peer = a;
        return [a, b];
    },
};
