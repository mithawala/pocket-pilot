// Generated from types/*.ts — do not edit.
// Regenerate with: npm run generate:typescript
import { IS_CLIENT_DISPATCHABLE } from '../action-origin.generated.js';
/**
 * Soft assertion for exhaustiveness checking. Place in the `default` branch of
 * a switch on a discriminated union so the compiler errors when a new variant
 * is added but not handled.
 *
 * At runtime, logs a warning instead of throwing so that forward-compatible
 * clients receiving unknown actions from a newer server degrade gracefully.
 */
export function softAssertNever(value, log) {
    const msg = `Unhandled action type: ${JSON.stringify(value)}`;
    (log ?? console.warn)(msg);
}
// ─── Dispatch Validation ─────────────────────────────────────────────────────
/**
 * Type guard that checks whether an action may be dispatched by a client.
 *
 * Servers SHOULD call this to validate incoming `dispatchAction` requests
 * and reject any action the client is not allowed to originate.
 */
export function isClientDispatchable(action) {
    return IS_CLIENT_DISPATCHABLE[action.type];
}
