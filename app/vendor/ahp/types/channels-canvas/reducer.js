// Generated from types/*.ts — do not edit.
// Regenerate with: npm run generate:typescript
/**
 * Canvas Channel Reducer — Pure reducer for `CanvasState`.
 *
 * @module channels-canvas/reducer
 */
import { ActionType } from '../common/actions.js';
/**
 * Pure reducer for canvas state.
 *
 * The channel currently has one full-replacement action. The `if` form keeps
 * unknown future actions forward-compatible because TypeScript cannot narrow a
 * single-variant action union to `never` for the usual exhaustiveness helper.
 */
export function canvasReducer(state, action, log) {
    if (action.type === ActionType.CanvasStateChanged) {
        return action.canvas;
    }
    (log ?? console.warn)(`Unhandled action type: ${JSON.stringify(action)}`);
    return state;
}
