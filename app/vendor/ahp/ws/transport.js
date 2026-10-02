/**
 * WebSocket transport adapter for the {@link AhpClient}.
 *
 * Built on the global {@link WebSocket} constructor, so it works in
 * browsers and in Node 21+ without additional dependencies.
 *
 * @module ws/transport
 */
import { TransportError } from '../client/error.js';
import { encodeMessage } from '../client/transport.js';
/**
 * An {@link AhpTransport} backed by the global {@link WebSocket}.
 *
 * Browser caveats this transport exposes:
 *
 * - {@link send} only queues data; it does not wait for the bytes to be
 *   flushed to the socket. Use {@link bufferedAmount} to detect
 *   backpressure if needed.
 * - Browsers cannot send WebSocket ping frames. Use {@link AhpClient.ping}
 *   for protocol-level liveness.
 * - Custom HTTP headers are not supported; use subprotocols or
 *   query-string parameters for auth.
 */
export class WebSocketTransport {
    socket;
    inbox = [];
    waiters = [];
    closeInfo = null;
    error = null;
    closed = false;
    /**
     * Open a new WebSocket connection.
     *
     * Resolves once the socket emits `open`. Rejects with a
     * {@link TransportError} on early failure — either an `error` event or a
     * `close` event before `open`.
     */
    static connect(url, options = {}) {
        return new Promise((resolve, reject) => {
            const SocketCtor = globalThis.WebSocket;
            if (!SocketCtor) {
                reject(new TransportError('io', 'global WebSocket is not available; install or polyfill it'));
                return;
            }
            let socket;
            try {
                socket = options.protocols !== undefined
                    ? new SocketCtor(url, options.protocols)
                    : new SocketCtor(url);
            }
            catch (err) {
                reject(new TransportError('io', `failed to construct WebSocket: ${err.message}`, { cause: err }));
                return;
            }
            const cleanup = () => {
                socket.removeEventListener('open', onOpen);
                socket.removeEventListener('error', onErrorBeforeOpen);
                socket.removeEventListener('close', onCloseBeforeOpen);
            };
            const onOpen = () => {
                cleanup();
                resolve(new WebSocketTransport(socket));
            };
            const onErrorBeforeOpen = () => {
                cleanup();
                reject(new TransportError('io', 'websocket failed to open'));
            };
            const onCloseBeforeOpen = (ev) => {
                cleanup();
                reject(new TransportError('closed', `websocket closed before open (code=${ev.code})`));
            };
            socket.addEventListener('open', onOpen);
            socket.addEventListener('error', onErrorBeforeOpen);
            socket.addEventListener('close', onCloseBeforeOpen);
        });
    }
    /**
     * Wrap an already-open WebSocket. Use this when you need to control
     * the handshake (custom subprotocols, query params, an existing
     * connection from another library).
     *
     * The socket MUST already be in the `OPEN` state.
     */
    static fromSocket(socket) {
        if (socket.readyState !== socket.OPEN) {
            throw new TransportError('io', 'socket is not OPEN');
        }
        return new WebSocketTransport(socket);
    }
    constructor(socket) {
        this.socket = socket;
        socket.binaryType = 'arraybuffer';
        socket.addEventListener('message', ev => {
            const data = ev.data;
            if (typeof data === 'string') {
                this.deliver({ kind: 'text', text: data });
            }
            else if (data instanceof ArrayBuffer) {
                this.deliver({ kind: 'binary', data: new Uint8Array(data) });
            }
            else if (data instanceof Uint8Array) {
                this.deliver({ kind: 'binary', data });
            }
            else {
                // Defensive: we set `binaryType = 'arraybuffer'` above, so a Blob
                // (or any other unexpected payload type) indicates a transport
                // misconfiguration. Tearing down on this would be worse than
                // surfacing it as a protocol error to the next `recv()`.
                const err = new TransportError('protocol', 'unsupported WebSocket message payload (expected string or ArrayBuffer)');
                this.error = err;
                this.drainWithError(err);
            }
        });
        socket.addEventListener('error', () => {
            this.error = new TransportError('io', 'websocket error');
            this.drainWithError(this.error);
        });
        socket.addEventListener('close', ev => {
            this.closeInfo = { code: ev.code, reason: ev.reason, wasClean: ev.wasClean };
            this.closed = true;
            if (!ev.wasClean) {
                // Abnormal close — surface as a transport error so consumers
                // can distinguish unplanned drops from a clean EOF. The
                // `AhpTransport.recv` contract says `recv()` throws on
                // abnormal closure; the `null` return is reserved for clean
                // close.
                const err = new TransportError('closed', `websocket closed abnormally (code=${ev.code})`);
                this.error = err;
                this.drainWithError(err);
            }
            else {
                // Clean close — drain every pending `recv()` waiter with
                // `null`, not just the head of the queue.
                this.drainWithNull();
            }
        });
    }
    /** Bytes still queued in the underlying socket's send buffer. */
    get bufferedAmount() {
        return this.socket.bufferedAmount;
    }
    /**
     * Information about the most recent close, set once the socket emits
     * `close`. `null` while the connection is open.
     */
    get lastClose() {
        return this.closeInfo;
    }
    send(message) {
        if (this.closed)
            throw new TransportError('closed', 'transport closed');
        if (this.error)
            throw this.error;
        const payload = typeof message === 'string' ? message : encodeMessage(message);
        try {
            this.socket.send(payload);
        }
        catch (err) {
            throw new TransportError('io', `websocket send failed: ${err.message}`, { cause: err });
        }
    }
    recv() {
        if (this.error)
            return Promise.reject(this.error);
        if (this.inbox.length > 0) {
            const frame = this.inbox.shift() ?? null;
            return Promise.resolve(frame);
        }
        if (this.closed)
            return Promise.resolve(null);
        return new Promise((resolve, reject) => {
            this.waiters.push({ resolve, reject });
        });
    }
    close() {
        if (this.socket.readyState === this.socket.OPEN || this.socket.readyState === this.socket.CONNECTING) {
            try {
                this.socket.close();
            }
            catch {
                // best-effort
            }
        }
        return Promise.resolve();
    }
    deliver(frame) {
        if (this.waiters.length > 0) {
            const w = this.waiters.shift();
            if (w)
                w.resolve(frame);
            return;
        }
        this.inbox.push(frame);
    }
    drainWithError(error) {
        const waiters = this.waiters;
        this.waiters = [];
        for (const w of waiters)
            w.reject(error);
    }
    drainWithNull() {
        const waiters = this.waiters;
        this.waiters = [];
        for (const w of waiters)
            w.resolve(null);
    }
}
