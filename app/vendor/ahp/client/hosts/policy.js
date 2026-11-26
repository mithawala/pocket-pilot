/**
 * Reconnect policy used by the per-host supervisor.
 *
 * Mirrors the Rust `ahp::hosts::ReconnectPolicy` surface.
 *
 * @module client/hosts/policy
 */
/** Compute the delay before the `attempt`-th retry (1-based), in milliseconds. */
export function backoffDelayForAttempt(backoff, attempt) {
    const safeAttempt = Math.max(1, Math.floor(attempt));
    switch (backoff.kind) {
        case 'immediate':
            return 0;
        case 'constant':
            return Math.max(0, backoff.delayMs);
        case 'exponential': {
            const multiplier = Math.max(1, backoff.multiplier);
            const exp = safeAttempt - 1;
            const scaled = backoff.initialMs * Math.pow(multiplier, exp);
            return Math.min(Math.max(0, scaled), backoff.maxMs);
        }
    }
}
/**
 * Compute the delay before the `attempt`-th retry, applying jitter via
 * the supplied random sample in `[0, 1]`.
 *
 * Exposed so tests can drive it deterministically; the runtime passes a
 * real `Math.random()` sample.
 */
export function delayWithJitter(policy, attempt, sample) {
    const base = backoffDelayForAttempt(policy.backoff, attempt);
    if (policy.jitter <= 0 || base === 0)
        return base;
    const jitter = Math.min(1, Math.max(0, policy.jitter));
    const clamped = Math.min(1, Math.max(0, sample));
    const factor = 1 + (clamped * 2 - 1) * jitter;
    return Math.max(0, base * factor);
}
/** Whether `attempt` exceeds the policy's `maxAttempts`. */
export function attemptsExhausted(policy, attempt) {
    return policy.maxAttempts !== null && attempt > policy.maxAttempts;
}
/**
 * Disable reconnects entirely. Use this when the consumer wants to
 * drive reconnect logic itself.
 */
export function disabledPolicy() {
    return {
        backoff: { kind: 'immediate' },
        jitter: 0,
        maxAttempts: 0,
        resetOnSuccess: true,
    };
}
/** Retry forever with no backoff. Useful for tests; not production. */
export function immediateForeverPolicy() {
    return {
        backoff: { kind: 'immediate' },
        jitter: 0,
        maxAttempts: null,
        resetOnSuccess: true,
    };
}
/**
 * Sensible default: exponential backoff from 250 ms up to 30 s,
 * 25% jitter, retry forever, reset on success.
 */
export function exponentialPolicy() {
    return {
        backoff: {
            kind: 'exponential',
            initialMs: 250,
            maxMs: 30_000,
            multiplier: 2,
        },
        jitter: 0.25,
        maxAttempts: null,
        resetOnSuccess: true,
    };
}
/** Default policy used by {@link HostConfig} when none is supplied. */
export function defaultReconnectPolicy() {
    return exponentialPolicy();
}
