/**
 * Host-aware reducer façade for multi-host consumers.
 *
 * Wraps the existing pure reducers (`rootReducer`, `sessionReducer`,
 * `terminalReducer`, `changesetReducer`) the way a single-host
 * consumer would, but keys session/terminal/changeset state by
 * `(hostId, uri)` so URIs that legitimately collide across hosts (the
 * normal case for session URIs) don't clobber each other.
 *
 * # Event sources are lossy today
 *
 * Both event surfaces the TypeScript SDK exposes are
 * {@link AsyncBroadcastQueue}-backed and **drop envelopes on slow
 * consumers** once their buffer fills:
 *
 * - {@link MultiHostClient.events} — the cross-host fan-in.
 * - {@link AhpClient.subscribe} / {@link AhpClient.attachSubscription}
 *   — per-channel {@link Subscription}.
 *
 * Neither survives a reconnect's replayed envelopes the way the Swift
 * SDK's per-channel `events(host:uri:)` does. A dropped envelope (or
 * a missed-because-reconnected envelope) permanently desyncs the
 * mirror for that `(host, channel)` until it's re-seeded from a fresh
 * snapshot via {@link MultiHostStateMirror.applySnapshot}. Consume
 * with that in mind — the mirror is the right shape for multi-host UI
 * state, but the SDK doesn't yet ship a lossless feeder.
 *
 * @module client/hosts/state-mirror
 */
import { changesetReducer } from '../../types/channels-changeset/reducer.js';
import { rootReducer } from '../../types/channels-root/reducer.js';
import { sessionReducer } from '../../types/channels-session/reducer.js';
import { terminalReducer } from '../../types/channels-terminal/reducer.js';
import { automationReducer } from '../../types/channels-automation/reducer.js';
import { automationRunReducer } from '../../types/channels-automation-run/reducer.js';
import { ROOT_RESOURCE_URI } from './types.js';
const INITIAL_ROOT = { agents: [] };
const AUTOMATIONS_URI = 'ahp-automations://';
/**
 * Build a Map-stable key string from a {@link HostedResourceKey}.
 *
 * The encoding is length-prefixed so it stays unambiguous even when
 * a {@link HostId} contains `\0` or other characters that would
 * otherwise collide with the separator.
 */
export function hostedResourceKey(hostId, uri) {
    return `${hostId.length}\x00${hostId}${uri}`;
}
/** @internal Length-prefixed `hostId` prefix shared by all of a host's resource keys. */
function hostedResourceKeyPrefix(hostId) {
    return `${hostId.length}\x00${hostId}`;
}
/**
 * In-memory mirror of per-host root/session/terminal/changeset state,
 * fed by {@link ActionEnvelope}s and snapshot states tagged with their
 * host of origin.
 *
 * Single-host consumers should keep using {@link AhpStateMirror}; this
 * type adds the host dimension necessary for multi-host UIs.
 *
 * See the module-level docs for a warning about lossy event sources.
 */
export class MultiHostStateMirror {
    rootStatesMap = new Map();
    sessionsMap = new Map();
    terminalsMap = new Map();
    changesetsMap = new Map();
    automationCatalogsMap = new Map();
    automationsMap = new Map();
    automationRunsMap = new Map();
    /** All known root states keyed by host. */
    get rootStates() {
        return this.rootStatesMap;
    }
    /** All known session states keyed by `hostedResourceKey(hostId, uri)`. */
    get sessions() {
        return this.sessionsMap;
    }
    /** All known terminal states keyed by `hostedResourceKey(hostId, uri)`. */
    get terminals() {
        return this.terminalsMap;
    }
    /** All known changeset states keyed by `hostedResourceKey(hostId, uri)`. */
    get changesets() {
        return this.changesetsMap;
    }
    /** Automation catalogue state keyed by host. */
    get automationCatalogs() {
        return this.automationCatalogsMap;
    }
    /** Catalogued automations keyed by `hostedResourceKey(hostId, resource)`. */
    get automations() {
        return this.automationsMap;
    }
    get automationRuns() {
        return this.automationRunsMap;
    }
    /** Look up the root state for `hostId`. */
    getRoot(hostId) {
        return this.rootStatesMap.get(hostId);
    }
    /** Look up a session by `(hostId, uri)`. */
    getSession(hostId, uri) {
        return this.sessionsMap.get(hostedResourceKey(hostId, uri));
    }
    /** Look up a terminal by `(hostId, uri)`. */
    getTerminal(hostId, uri) {
        return this.terminalsMap.get(hostedResourceKey(hostId, uri));
    }
    /** Look up a changeset by `(hostId, uri)`. */
    getChangeset(hostId, uri) {
        return this.changesetsMap.get(hostedResourceKey(hostId, uri));
    }
    /** Look up a catalogued automation by `(hostId, uri)`. */
    getAutomation(hostId, uri) {
        return this.automationsMap.get(hostedResourceKey(hostId, uri));
    }
    /**
     * Convenience: apply a {@link HostSubscriptionEvent} produced by
     * {@link MultiHostClient.events}. Action envelopes are routed through
     * the matching reducer; non-action events (session-summary
     * notifications, auth challenges) are ignored — they don't move any
     * of the reducer-tracked state shapes.
     */
    applyEvent(event) {
        if (event.event.type === 'action') {
            this.applyEnvelope(event.hostId, event.event.params);
        }
    }
    /**
     * Apply a single action envelope scoped to `hostId`. Routing uses
     * `envelope.channel`: {@link ROOT_RESOURCE_URI} is the root channel,
     * every other URI is identified by the channel the server announces.
     */
    applyEnvelope(hostId, envelope) {
        const { channel, action } = envelope;
        if (channel === ROOT_RESOURCE_URI) {
            const root = this.rootStatesMap.get(hostId) ?? INITIAL_ROOT;
            this.rootStatesMap.set(hostId, rootReducer(root, action));
            return;
        }
        if (channel.startsWith('ahp-session:')) {
            const key = hostedResourceKey(hostId, channel);
            const current = this.sessionsMap.get(key);
            if (!current)
                return;
            this.sessionsMap.set(key, sessionReducer(current, action));
            return;
        }
        if (channel.startsWith('ahp-terminal:')) {
            const key = hostedResourceKey(hostId, channel);
            const current = this.terminalsMap.get(key);
            if (!current)
                return;
            this.terminalsMap.set(key, terminalReducer(current, action));
            return;
        }
        if (channel.startsWith('ahp-changeset:')) {
            const key = hostedResourceKey(hostId, channel);
            const current = this.changesetsMap.get(key);
            if (!current)
                return;
            this.changesetsMap.set(key, changesetReducer(current, action));
            return;
        }
        if (channel === AUTOMATIONS_URI) {
            const current = this.automationCatalogsMap.get(hostId);
            if (!current)
                return;
            this.setAutomationCatalog(hostId, automationReducer(current, action));
            return;
        }
        if (channel.startsWith('ahp-automation-run:')) {
            const key = hostedResourceKey(hostId, channel);
            const current = this.automationRunsMap.get(key);
            if (!current)
                return;
            this.automationRunsMap.set(key, automationRunReducer(current, action));
            return;
        }
    }
    /**
     * Seed the mirror from a {@link Snapshot} scoped to `hostId` — root,
     * session, terminal, or changeset as the snapshot's `state` shape
     * dictates.
     */
    applySnapshot(hostId, snapshot) {
        const { resource } = snapshot;
        if (resource === ROOT_RESOURCE_URI) {
            this.rootStatesMap.set(hostId, snapshot.state);
            return;
        }
        const key = hostedResourceKey(hostId, resource);
        if (resource.startsWith('ahp-session:')) {
            this.sessionsMap.set(key, snapshot.state);
            return;
        }
        if (resource.startsWith('ahp-terminal:')) {
            this.terminalsMap.set(key, snapshot.state);
            return;
        }
        if (resource.startsWith('ahp-changeset:')) {
            this.changesetsMap.set(key, snapshot.state);
            return;
        }
        if (resource === AUTOMATIONS_URI) {
            this.setAutomationCatalog(hostId, snapshot.state);
            return;
        }
        if (resource.startsWith('ahp-automation-run:')) {
            this.automationRunsMap.set(key, snapshot.state);
            return;
        }
    }
    /** Drop every slot keyed under `hostId` — root, sessions, terminals, changesets. */
    resetHost(hostId) {
        this.rootStatesMap.delete(hostId);
        this.automationCatalogsMap.delete(hostId);
        const prefix = hostedResourceKeyPrefix(hostId);
        for (const key of this.sessionsMap.keys()) {
            if (key.startsWith(prefix))
                this.sessionsMap.delete(key);
        }
        for (const key of this.terminalsMap.keys()) {
            if (key.startsWith(prefix))
                this.terminalsMap.delete(key);
        }
        for (const key of this.changesetsMap.keys()) {
            if (key.startsWith(prefix))
                this.changesetsMap.delete(key);
        }
        for (const key of this.automationsMap.keys()) {
            if (key.startsWith(prefix))
                this.automationsMap.delete(key);
        }
        for (const key of this.automationRunsMap.keys()) {
            if (key.startsWith(prefix))
                this.automationRunsMap.delete(key);
        }
    }
    /** Drop every host's state. */
    reset() {
        this.rootStatesMap.clear();
        this.sessionsMap.clear();
        this.terminalsMap.clear();
        this.changesetsMap.clear();
        this.automationCatalogsMap.clear();
        this.automationsMap.clear();
        this.automationRunsMap.clear();
    }
    setAutomationCatalog(hostId, state) {
        this.automationCatalogsMap.set(hostId, state);
        const prefix = hostedResourceKeyPrefix(hostId);
        for (const key of this.automationsMap.keys()) {
            if (key.startsWith(prefix))
                this.automationsMap.delete(key);
        }
        for (const automation of state.entries) {
            this.automationsMap.set(hostedResourceKey(hostId, automation.resource), automation);
        }
    }
}
