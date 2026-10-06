/**
 * Convenience reducer-driven state store, mirroring the Swift
 * `AHPStateMirror` and the Rust reducers example.
 *
 * Tracks root, session, canvas, terminal, changeset, automation catalogue, and
 * automation-run state. Apply {@link Snapshot}s and {@link ActionEnvelope}s and
 * the mirror keeps those resources up to date via the generated reducers.
 *
 * Useful for simple clients. Larger apps will usually keep their own
 * state and call the reducers directly.
 *
 * @module client/state-mirror
 */
import { ActionType } from '../types/common/actions.js';
import { changesetReducer } from '../types/channels-changeset/reducer.js';
import { canvasReducer } from '../types/channels-canvas/reducer.js';
import { rootReducer } from '../types/channels-root/reducer.js';
import { sessionReducer } from '../types/channels-session/reducer.js';
import { terminalReducer } from '../types/channels-terminal/reducer.js';
import { automationReducer } from '../types/channels-automation/reducer.js';
import { automationRunReducer } from '../types/channels-automation-run/reducer.js';
import { isCanvasState } from './canvas-state.js';
const ROOT_URI = 'ahp-root://';
const AUTOMATIONS_URI = 'ahp-automations://';
const INITIAL_ROOT = { agents: [] };
const INITIAL_AUTOMATION_CATALOG = { entries: [] };
/** Reducer-driven state container synchronised with server events. */
export class AhpStateMirror {
    rootState = INITIAL_ROOT;
    sessionsMap = new Map();
    canvasesMap = new Map();
    terminalsMap = new Map();
    changesetsMap = new Map();
    automationCatalogState = INITIAL_AUTOMATION_CATALOG;
    automationsMap = new Map();
    automationRunsMap = new Map();
    /** Current root state. */
    get root() {
        return this.rootState;
    }
    /** All known sessions keyed by URI. */
    get sessions() {
        return this.sessionsMap;
    }
    /** All known live canvases keyed by their channel URI. */
    get canvases() {
        return this.canvasesMap;
    }
    /** All known terminals keyed by URI. */
    get terminals() {
        return this.terminalsMap;
    }
    /** All known changesets keyed by URI. */
    get changesets() {
        return this.changesetsMap;
    }
    /** Current automation catalogue state. */
    get automationCatalog() {
        return this.automationCatalogState;
    }
    /** All catalogued automations keyed by their stable resource URI. */
    get automations() {
        return this.automationsMap;
    }
    get automationRuns() {
        return this.automationRunsMap;
    }
    /** Look up a session by URI. */
    getSession(uri) {
        return this.sessionsMap.get(uri);
    }
    getCanvas(uri) {
        return this.canvasesMap.get(uri);
    }
    /** Look up a terminal by URI. */
    getTerminal(uri) {
        return this.terminalsMap.get(uri);
    }
    /** Look up a catalogued automation by URI. */
    getAutomation(uri) {
        return this.automationsMap.get(uri);
    }
    /**
     * Apply a server snapshot, replacing the state for the resource the
     * snapshot covers.
     */
    applySnapshot(snapshot) {
        const resource = snapshot.resource;
        if (resource === ROOT_URI) {
            this.rootState = snapshot.state;
            return;
        }
        if (resource.startsWith('ahp-session:')) {
            this.sessionsMap.set(resource, snapshot.state);
            return;
        }
        if (resource.startsWith('ahp-canvas:')) {
            if (!isCanvasState(snapshot.state)) {
                throw new Error('Invalid canvas snapshot state');
            }
            this.canvasesMap.set(resource, snapshot.state);
            return;
        }
        if (resource.startsWith('ahp-terminal:')) {
            this.terminalsMap.set(resource, snapshot.state);
            return;
        }
        if (resource.startsWith('ahp-changeset:')) {
            this.changesetsMap.set(resource, snapshot.state);
            return;
        }
        if (resource === AUTOMATIONS_URI) {
            this.setAutomationCatalog(snapshot.state);
            return;
        }
        if (resource.startsWith('ahp-automation-run:')) {
            this.automationRunsMap.set(resource, snapshot.state);
            return;
        }
    }
    /**
     * Apply a server-pushed {@link ActionEnvelope}, routing through the
     * matching reducer. Unknown channels are ignored.
     *
     * The channel-based routing here discriminates which reducer applies;
     * the action is cast to the appropriate per-channel subset (the
     * `RootAction` / `SessionAction` / `TerminalAction` / `ChangesetAction`
     * unions generated from `@clientDispatchable` annotations) because
     * TypeScript cannot infer that narrowing from the channel string alone.
     */
    apply(envelope) {
        const { channel, action } = envelope;
        if (channel === ROOT_URI) {
            this.rootState = rootReducer(this.rootState, action);
            return;
        }
        if (channel.startsWith('ahp-session:')) {
            const current = this.sessionsMap.get(channel);
            if (!current)
                return;
            this.sessionsMap.set(channel, sessionReducer(current, action));
            return;
        }
        if (channel.startsWith('ahp-canvas:')) {
            const current = this.canvasesMap.get(channel);
            if (current === undefined || action.type !== ActionType.CanvasStateChanged)
                return;
            this.canvasesMap.set(channel, canvasReducer(current, action));
            return;
        }
        if (channel.startsWith('ahp-terminal:')) {
            const current = this.terminalsMap.get(channel);
            if (!current)
                return;
            this.terminalsMap.set(channel, terminalReducer(current, action));
            return;
        }
        if (channel.startsWith('ahp-changeset:')) {
            const current = this.changesetsMap.get(channel);
            if (!current)
                return;
            this.changesetsMap.set(channel, changesetReducer(current, action));
            return;
        }
        if (channel === AUTOMATIONS_URI) {
            this.setAutomationCatalog(automationReducer(this.automationCatalogState, action));
            return;
        }
        if (channel.startsWith('ahp-automation-run:')) {
            const current = this.automationRunsMap.get(channel);
            if (!current)
                return;
            this.automationRunsMap.set(channel, automationRunReducer(current, action));
            return;
        }
    }
    setAutomationCatalog(state) {
        this.automationCatalogState = state;
        this.automationsMap.clear();
        for (const automation of state.entries) {
            this.automationsMap.set(automation.resource, automation);
        }
    }
}
