// Generated from types/*.ts — do not edit.
// Regenerate with: npm run generate:typescript
import { ActionType } from '../common/actions.js';
import { softAssertNever } from '../common/reducer-helpers.js';
/** Pure reducer for automation catalogue state. */
export function automationReducer(state, action, log) {
    switch (action.type) {
        case ActionType.AutomationCreateRequested:
        case ActionType.AutomationUpdateRequested:
            return state;
        case ActionType.AutomationSet: {
            const idx = state.entries.findIndex(automation => automation.resource === action.automation.resource);
            if (idx < 0) {
                return {
                    ...state,
                    entries: [...state.entries, action.automation],
                };
            }
            const entries = state.entries.slice();
            entries[idx] = action.automation;
            return { ...state, entries };
        }
        case ActionType.AutomationRemoved: {
            const idx = state.entries.findIndex(automation => automation.resource === action.resource);
            if (idx < 0) {
                return state;
            }
            const entries = state.entries.slice();
            entries.splice(idx, 1);
            return { ...state, entries };
        }
        default:
            softAssertNever(action, log);
            return state;
    }
}
