/**
 * Async JSON-RPC client for the Agent Host Protocol.
 *
 * Mirrors the surface of the Rust `ahp::Client`: a transport-agnostic
 * client that runs a background receive loop over a pluggable
 * {@link AhpTransport}, exposes typed `initialize` / `reconnect` /
 * `subscribe` / `dispatch` helpers, and fans inbound notifications out to
 * per-URI {@link Subscription}s and a top-level {@link AhpClient.events}
 * stream.
 *
 * @module client/client
 */
import { JsonRpcErrorCodes } from '../types/common/errors.js';
import { AsyncBroadcastQueue } from './async-queue.js';
import { ClientClosedError, RpcError, RpcTimeoutError, TransportError, } from './error.js';
import { decodeMessage, } from './transport.js';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SUBSCRIPTION_BUFFER = 4096;
/** Silently discard a rejected promise. */
function noop() { }
// ─── Handles ─────────────────────────────────────────────────────────────────
/**
 * Handle to a single resource subscription. Iterate to receive
 * {@link SubscriptionEvent}s. Call {@link Subscription.close} to terminate
 * this consumer's iterator (the server-side subscription is released only
 * when {@link AhpClient.unsubscribe} is called for this URI).
 */
export class Subscription {
    /** Channel URI this subscription is bound to. */
    uri;
    /** @internal */
    inner;
    /** @internal */
    constructor(uri, inner) {
        this.uri = uri;
        this.inner = inner;
    }
    next() {
        return this.inner.next();
    }
    return() {
        return this.inner.return ? this.inner.return() : Promise.resolve({ value: undefined, done: true });
    }
    [Symbol.asyncIterator]() {
        return this;
    }
    /** Terminate this consumer's iterator. Does not unsubscribe server-side. */
    async close() {
        await this.return();
    }
}
/**
 * Compose a set of typed per-method {@link ResourceRequestHandlers} into a
 * single {@link ServerRequestHandler} suitable for
 * {@link AhpClient.setServerRequestHandler}. Requests whose method has no
 * registered handler reject with a JSON-RPC `MethodNotFound` {@link RpcError}.
 */
export function createResourceRequestHandler(handlers) {
    return (async (method, params) => {
        const handler = handlers[method];
        if (!handler) {
            throw new RpcError(JsonRpcErrorCodes.MethodNotFound, `no handler for server method "${method}"`);
        }
        return handler(params);
    });
}
// ─── Client ──────────────────────────────────────────────────────────────────
/**
 * Async JSON-RPC client driving a pluggable {@link AhpTransport}.
 *
 * The receive loop is started by {@link AhpClient.connect} and runs until
 * the transport closes or {@link AhpClient.shutdown} is called. In-flight
 * requests reject with {@link ClientClosedError} when the client is shut
 * down.
 */
export class AhpClient {
    transport;
    requestTimeoutMs;
    subscriptionBuffer;
    pending = new Map();
    subscriptions = new Map();
    allEvents = new AsyncBroadcastQueue();
    stateQueue = new AsyncBroadcastQueue();
    nextRequestId = 1;
    nextClientSeq = 1;
    state = { status: 'idle' };
    receiveLoop = null;
    serverRequestHandler = null;
    constructor(transport, config = {}) {
        this.transport = transport;
        const timeout = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        this.requestTimeoutMs = timeout > 0 ? timeout : 0;
        const buffer = config.subscriptionBuffer ?? DEFAULT_SUBSCRIPTION_BUFFER;
        // Clamp to >= 1 so the queue can deliver at least one value to
        // already-parked readers without immediately being trimmed.
        this.subscriptionBuffer = buffer >= 1 ? Math.floor(buffer) : 1;
    }
    /** Current connection state. */
    get connectionState() {
        return this.state;
    }
    /** AsyncIterable stream of connection-state transitions. */
    stateChanges() {
        return this.stateQueue.reader();
    }
    /**
     * Top-level fan-in stream of every inbound event from this client.
     *
     * Each call returns a fresh independent iterator. Events are also
     * delivered to the matching per-URI {@link Subscription}.
     */
    events() {
        return this.allEvents.reader();
    }
    /**
     * Install a handler for server-initiated requests
     * ({@link ServerCommandMap}). If no handler is installed, the client
     * responds with a JSON-RPC `MethodNotFound` error so the server does
     * not leak pending requests.
     */
    setServerRequestHandler(handler) {
        this.serverRequestHandler = handler;
    }
    /**
     * Install typed per-method handlers for inbound server-initiated resource
     * requests ({@link ServerCommandMap}). Sugar over
     * {@link AhpClient.setServerRequestHandler} +
     * {@link createResourceRequestHandler}: a method left undefined is reported
     * to the peer as JSON-RPC `MethodNotFound`. Pass `null` to clear the
     * installed handler.
     */
    setResourceRequestHandlers(handlers) {
        this.setServerRequestHandler(handlers ? createResourceRequestHandler(handlers) : null);
    }
    /**
     * Start the inbound receive loop. Idempotent — calling more than once
     * is a no-op.
     */
    connect() {
        if (this.receiveLoop)
            return;
        this.setState({ status: 'connected' });
        this.receiveLoop = this.driveTransport();
    }
    /**
     * Gracefully shut down the client. Closes the transport, rejects every
     * pending request with {@link ClientClosedError}, and terminates all
     * subscription and event streams.
     */
    async shutdown() {
        if (this.state.status === 'closing' || this.state.status === 'closed')
            return;
        this.setState({ status: 'closing' });
        // Tear down first so pending requests reject with ClientClosedError
        // rather than racing against the receive loop seeing the transport
        // close (which would reject with TransportError instead).
        this.tearDown({ type: 'shutdown' });
        try {
            await this.transport.close();
        }
        catch {
            // best-effort close
        }
        if (this.receiveLoop) {
            try {
                await this.receiveLoop;
            }
            catch {
                // already surfaced via tearDown
            }
        }
    }
    // ─── Typed protocol helpers ────────────────────────────────────────────────
    /**
     * Send the `initialize` handshake. MUST be the first request after
     * {@link AhpClient.connect}.
     */
    async initialize(args) {
        const params = {
            channel: 'ahp-root://',
            clientId: args.clientId,
            protocolVersions: [...args.protocolVersions],
            ...(args.initialSubscriptions && args.initialSubscriptions.length > 0
                ? { initialSubscriptions: [...args.initialSubscriptions] }
                : {}),
            ...(args.locale !== undefined ? { locale: args.locale } : {}),
        };
        return this.request('initialize', params);
    }
    /** Re-establish a dropped connection. */
    async reconnect(args) {
        const params = {
            channel: 'ahp-root://',
            clientId: args.clientId,
            lastSeenServerSeq: args.lastSeenServerSeq,
            subscriptions: [...args.subscriptions],
        };
        return this.request('reconnect', params);
    }
    /**
     * Subscribe to a URI and obtain a {@link Subscription} that streams
     * subsequent events. The returned subscription is registered locally
     * before the `subscribe` request is sent, so no events delivered during
     * the round-trip are missed.
     */
    async subscribe(uri, options = {}) {
        const subscription = this.attachSubscription(uri);
        try {
            const params = {
                channel: uri,
                ...(options.delivery ? { delivery: options.delivery } : {}),
                ...(options.view ? { view: options.view } : {}),
            };
            const result = await this.request('subscribe', params);
            return { result, subscription };
        }
        catch (err) {
            await subscription.close();
            throw err;
        }
    }
    /**
     * Attach a new local {@link Subscription} without sending a `subscribe`
     * request — use this when the URI was included in `initialSubscriptions`
     * during {@link AhpClient.initialize}, or to add an additional consumer
     * for a URI that is already subscribed.
     *
     * Throws {@link ClientClosedError} after the client has been shut down.
     */
    attachSubscription(uri) {
        this.assertOpen();
        let queue = this.subscriptions.get(uri);
        if (!queue) {
            queue = new AsyncBroadcastQueue(this.subscriptionBuffer);
            this.subscriptions.set(uri, queue);
        }
        return new Subscription(uri, queue.reader());
    }
    /**
     * Send an `unsubscribe` notification and drop the local fan-out for
     * this URI. Any active {@link Subscription} iterators terminate.
     *
     * No-op after the client has been shut down.
     */
    async unsubscribe(uri) {
        if (this.isClosed())
            return;
        const queue = this.subscriptions.get(uri);
        if (queue) {
            this.subscriptions.delete(uri);
            queue.close();
        }
        const params = { channel: uri };
        this.notify('unsubscribe', params);
        return Promise.resolve();
    }
    /**
     * Fire a write-ahead `dispatchAction` notification.
     *
     * If `clientSeq` is omitted, the client uses its internal monotonic
     * counter. If supplied, the counter advances to `max(current,
     * clientSeq + 1)` so subsequent auto-assigned sequences remain
     * monotonic.
     *
     * Throws {@link ClientClosedError} after the client has been shut down.
     */
    dispatch(channel, action, clientSeq) {
        this.assertOpen();
        const seq = clientSeq ?? this.nextClientSeq;
        if (clientSeq !== undefined) {
            if (seq + 1 > this.nextClientSeq)
                this.nextClientSeq = seq + 1;
        }
        else {
            this.nextClientSeq = seq + 1;
        }
        const params = { channel, clientSeq: seq, action };
        this.notify('dispatchAction', params);
        return { clientSeq: seq };
    }
    /**
     * Protocol-level liveness ping. Useful in browsers, which cannot send
     * WebSocket ping frames directly.
     *
     * `ping` is a connection-level command; its channel is always
     * `ahp-root://`.
     */
    async ping() {
        const params = { channel: 'ahp-root://' };
        await this.request('ping', params);
    }
    // ─── Resource commands ─────────────────────────────────────────────────────
    //
    // Typed convenience wrappers over the symmetrical `resource*` family. Each
    // targets the root channel (`ahp-root://`), so callers omit `channel`. The
    // reverse direction — a server calling these on the client — is handled via
    // {@link AhpClient.setResourceRequestHandlers}.
    /** Read the content of a resource by URI (`resourceRead`). */
    async resourceRead(params) {
        return this.request('resourceRead', { ...params, channel: 'ahp-root://' });
    }
    /** Write content to a file on the receiver's filesystem (`resourceWrite`). */
    async resourceWrite(params) {
        return this.request('resourceWrite', { ...params, channel: 'ahp-root://' });
    }
    /** List directory entries at a file URI (`resourceList`). */
    async resourceList(params) {
        return this.request('resourceList', { ...params, channel: 'ahp-root://' });
    }
    /** Copy a resource from one URI to another (`resourceCopy`). */
    async resourceCopy(params) {
        return this.request('resourceCopy', { ...params, channel: 'ahp-root://' });
    }
    /** Delete a resource at a URI (`resourceDelete`). */
    async resourceDelete(params) {
        return this.request('resourceDelete', { ...params, channel: 'ahp-root://' });
    }
    /** Move (rename) a resource from one URI to another (`resourceMove`). */
    async resourceMove(params) {
        return this.request('resourceMove', { ...params, channel: 'ahp-root://' });
    }
    /** Resolve a resource — `stat` + `realpath` (`resourceResolve`). */
    async resourceResolve(params) {
        return this.request('resourceResolve', { ...params, channel: 'ahp-root://' });
    }
    /** Create a directory with `mkdir -p` semantics (`resourceMkdir`). */
    async resourceMkdir(params) {
        return this.request('resourceMkdir', { ...params, channel: 'ahp-root://' });
    }
    /** Request permission to access a resource (`resourceRequest`). */
    async resourceRequest(params) {
        return this.request('resourceRequest', { ...params, channel: 'ahp-root://' });
    }
    /**
     * Create a resource watcher (`createResourceWatch`). Returns the
     * `ahp-resource-watch:/<id>` channel URI; {@link AhpClient.subscribe} to it
     * to receive change events, and {@link AhpClient.unsubscribe} to release the
     * watcher.
     */
    async createResourceWatch(params) {
        return this.request('createResourceWatch', {
            ...params,
            channel: 'ahp-root://',
        });
    }
    // ─── Completions commands ──────────────────────────────────────────────────
    /**
     * Request inline completion items for a partially-typed input
     * (`completions`), e.g. to power `@`-mention pickers. Unlike the `resource*`
     * wrappers, the caller-supplied `channel` (the chat URI the completion is
     * scoped to) is preserved. Debounce calls to avoid flooding the server on
     * every keystroke.
     */
    async completions(params) {
        return this.request('completions', params);
    }
    /**
     * Query the server for allowed values of a dynamic session config property
     * (`sessionConfigCompletions`). Targets the root channel, so callers omit
     * `channel`.
     */
    async sessionConfigCompletions(params) {
        return this.request('sessionConfigCompletions', {
            ...params,
            channel: 'ahp-root://',
        });
    }
    // ─── Lower-level JSON-RPC ──────────────────────────────────────────────────
    /** Send a JSON-RPC request and await its result. */
    async request(method, params) {
        this.assertOpen();
        const id = this.nextRequestId++;
        const msg = {
            jsonrpc: '2.0',
            id,
            method: method,
            params,
        };
        return new Promise((resolve, reject) => {
            const pending = {
                resolve: value => resolve(value),
                reject,
                method: method,
                timer: null,
            };
            this.pending.set(id, pending);
            if (this.requestTimeoutMs > 0) {
                pending.timer = setTimeout(() => {
                    if (this.pending.delete(id)) {
                        reject(new RpcTimeoutError(method, this.requestTimeoutMs));
                    }
                }, this.requestTimeoutMs);
            }
            this.sendMessage(msg).catch(err => {
                if (this.pending.delete(id)) {
                    if (pending.timer)
                        clearTimeout(pending.timer);
                    reject(err);
                }
            });
        });
    }
    /**
     * Send a JSON-RPC notification (fire-and-forget).
     *
     * Throws {@link ClientClosedError} after the client has been shut down.
     * Transport-level send failures surface synchronously via
     * {@link AhpClient.connectionState} (the receive loop also tears down
     * on the next inbound failure).
     */
    notify(method, params) {
        this.assertOpen();
        const msg = {
            jsonrpc: '2.0',
            method: method,
            params,
        };
        // Send failures tear down the client via `sendMessage`; swallow the
        // rejection here so a fire-and-forget notify never produces an
        // unhandled promise rejection.
        this.sendMessage(msg).catch(noop);
    }
    // ─── Internals ─────────────────────────────────────────────────────────────
    isClosed() {
        return this.state.status === 'closing' || this.state.status === 'closed';
    }
    assertOpen() {
        if (this.isClosed())
            throw new ClientClosedError();
    }
    async sendMessage(msg) {
        try {
            await this.transport.send(msg);
        }
        catch (err) {
            const te = err instanceof TransportError
                ? err
                : new TransportError('io', `transport send failed: ${err.message}`, { cause: err });
            this.tearDown({ type: 'transport', error: te });
            throw te;
        }
    }
    setState(next) {
        this.state = next;
        this.stateQueue.publish(next);
    }
    tearDown(reason) {
        if (this.state.status === 'closed')
            return;
        this.setState({ status: 'closed', reason });
        // Fail every pending request.
        const failure = reason.type === 'shutdown' ? new ClientClosedError() : reason.error;
        for (const [id, pending] of this.pending) {
            if (pending.timer)
                clearTimeout(pending.timer);
            try {
                pending.reject(failure);
            }
            catch {
                // ignore listener errors
            }
            this.pending.delete(id);
        }
        for (const queue of this.subscriptions.values())
            queue.close();
        this.subscriptions.clear();
        this.allEvents.close();
        this.stateQueue.close();
    }
    async driveTransport() {
        try {
            while (this.state.status === 'connected') {
                const frame = await this.transport.recv();
                if (frame === null) {
                    this.tearDown({ type: 'transport', error: new TransportError('closed', 'transport closed') });
                    return;
                }
                this.handleFrame(frame);
            }
        }
        catch (err) {
            const te = err instanceof TransportError
                ? err
                : new TransportError('io', `transport recv failed: ${err.message}`, { cause: err });
            this.tearDown({ type: 'transport', error: te });
        }
    }
    handleFrame(frame) {
        let message;
        try {
            switch (frame.kind) {
                case 'parsed':
                    message = frame.message;
                    break;
                case 'text':
                    message = decodeMessage(frame.text);
                    break;
                case 'binary': {
                    const text = new TextDecoder('utf-8').decode(frame.data);
                    message = decodeMessage(text);
                    break;
                }
            }
        }
        catch (err) {
            // A single malformed frame doesn't tear down the channel — a
            // well-behaved server should not send them, and a transient bad
            // frame from a peer that recovers shouldn't kill in-flight
            // requests. Surface it via `console.warn` so consumers have a
            // breadcrumb when requests later time out.
            // eslint-disable-next-line no-console
            console.warn(`AhpClient: malformed inbound frame: ${err.message}`);
            return;
        }
        this.dispatchInbound(message);
    }
    dispatchInbound(message) {
        // Response: { id, result } or { id, error }
        if ('id' in message && 'result' in message) {
            const success = message;
            const pending = this.pending.get(success.id);
            if (pending) {
                this.pending.delete(success.id);
                if (pending.timer)
                    clearTimeout(pending.timer);
                pending.resolve(success.result);
            }
            return;
        }
        if ('id' in message && 'error' in message) {
            const failure = message;
            const pending = this.pending.get(failure.id);
            if (pending) {
                this.pending.delete(failure.id);
                if (pending.timer)
                    clearTimeout(pending.timer);
                pending.reject(new RpcError(failure.error.code, failure.error.message, failure.error.data));
            }
            return;
        }
        // Server-initiated request: { id, method }
        if ('id' in message && 'method' in message) {
            void this.handleServerRequest(message);
            return;
        }
        // Notification: { method } no id
        if ('method' in message) {
            this.handleNotification(message);
            return;
        }
    }
    async handleServerRequest(req) {
        if (this.serverRequestHandler) {
            try {
                // The dynamic cast here is unavoidable — the runtime method name
                // narrows to ServerCommandMap externally.
                const handler = this.serverRequestHandler;
                const result = await handler(req.method, req.params);
                const response = {
                    jsonrpc: '2.0',
                    id: req.id,
                    result,
                };
                this.sendMessage(response).catch(noop);
            }
            catch (err) {
                const code = err instanceof RpcError ? err.code : JsonRpcErrorCodes.InternalError;
                const message = err instanceof Error ? err.message : String(err);
                const data = err instanceof RpcError ? err.data : undefined;
                const response = {
                    jsonrpc: '2.0',
                    id: req.id,
                    error: data !== undefined ? { code, message, data } : { code, message },
                };
                this.sendMessage(response).catch(noop);
            }
            return;
        }
        // No handler installed — respond with MethodNotFound so the server
        // does not leak a pending request.
        const response = {
            jsonrpc: '2.0',
            id: req.id,
            error: {
                code: JsonRpcErrorCodes.MethodNotFound,
                message: `no handler for server method "${req.method}"`,
            },
        };
        this.sendMessage(response).catch(noop);
    }
    handleNotification(n) {
        const params = (n.params ?? {});
        const channel = params.channel;
        switch (n.method) {
            case 'action': {
                const env = n.params;
                this.fanOut(env.channel, { type: 'action', params: env });
                break;
            }
            case 'root/sessionAdded': {
                const p = n.params;
                this.fanOut(p.channel, { type: 'sessionAdded', params: p });
                break;
            }
            case 'root/sessionRemoved': {
                const p = n.params;
                this.fanOut(p.channel, { type: 'sessionRemoved', params: p });
                break;
            }
            case 'root/sessionSummaryChanged': {
                const p = n.params;
                this.fanOut(p.channel, { type: 'sessionSummaryChanged', params: p });
                break;
            }
            case 'auth/required': {
                const p = n.params;
                this.fanOut(p.channel, { type: 'authRequired', params: p });
                break;
            }
            default:
                // Unhandled notification (e.g. `otlp/exportLogs`). Channel is
                // available in params for consumers who route via `events()`,
                // but these are not surfaced as `SubscriptionEvent`s to mirror
                // the Rust/Swift clients.
                void channel;
                break;
        }
    }
    fanOut(channel, event) {
        const queue = this.subscriptions.get(channel);
        if (queue)
            queue.publish(event);
        this.allEvents.publish({ channel, event });
    }
}
