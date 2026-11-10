/**
 * Pluggable transport factory used by {@link MultiHostClient} to open a
 * fresh {@link AhpTransport} for a host on every connect attempt
 * (including reconnects).
 *
 * Consumers refresh tokens, rotate URLs, or pick different backends per
 * attempt by inspecting `hostId`. The supplied `AbortSignal` is aborted
 * when the host is being removed, manually reconnected, or shut down;
 * factories SHOULD propagate the signal into any underlying networking
 * primitives that accept one (e.g. `fetch`, `WebSocket` opens via a
 * helper that bails on abort) so a slow handshake doesn't block teardown.
 *
 * @module client/hosts/factory
 */
export {};
