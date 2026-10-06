/**
 * Subscription events fanned out to consumers of {@link AhpClient}.
 *
 * `action` envelopes carry the write-ahead mutation stream; the remaining
 * variants carry channel-tagged protocol notifications the server emits as
 * top-level JSON-RPC methods (`root/sessionAdded`, `auth/required`, …).
 *
 * Mirrors the Rust `SubscriptionEvent` enum surface, expressed as a TS
 * discriminated union.
 *
 * @module client/events
 */
export {};
