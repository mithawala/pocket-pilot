// Generated from types/*.ts — do not edit.
// Regenerate with: npm run generate:typescript
/**
 * Resource-Watch Channel Reducer — Pure reducer for `ResourceWatchState`.
 *
 * @module channels-resource-watch/reducer
 */
import { ActionType } from '../common/actions.js';
/**
 * Pure reducer for resource-watch state. Handles every
 * {@link ResourceWatchAction} variant.
 *
 * Watches are intentionally event-pass-through: change events are
 * delivered via `resourceWatch/changed` actions but the reducer keeps no
 * history of them. The state therefore tracks only the watch descriptor,
 * which is set at subscription time and never mutates over the life of
 * the watch.
 *
 * The reducer uses an `if`/else shape rather than `switch`/`softAssertNever`
 * because `ResourceWatchAction` currently has a single variant — TypeScript
 * does not narrow single-variant discriminated unions to `never` after the
 * sole case branch, so the usual exhaustiveness pattern would not compile.
 * Unknown action types degrade gracefully (mirroring `softAssertNever`'s
 * runtime behaviour) so a client speaking an older protocol stays correct
 * if the server adds new `resourceWatch/*` actions in a future version.
 */
export function resourceWatchReducer(state, action, log) {
    if (action.type === ActionType.ResourceWatchChanged) {
        return state;
    }
    (log ?? console.warn)(`Unhandled action type: ${JSON.stringify(action)}`);
    return state;
}
