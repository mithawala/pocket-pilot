// Generated from types/*.ts — do not edit.
// Regenerate with: npm run generate:typescript
// ─── Session State ───────────────────────────────────────────────────────────
/**
 * Session initialization state.
 *
 * @category Session State
 * @nonexhaustive
 */
export var SessionLifecycle;
(function (SessionLifecycle) {
    SessionLifecycle["Creating"] = "creating";
    SessionLifecycle["Ready"] = "ready";
    SessionLifecycle["Failed"] = "failed";
})(SessionLifecycle || (SessionLifecycle = {}));
/**
 * Bitset of summary-level session status flags.
 *
 * Use bitwise checks instead of equality for non-terminal activity. For example,
 * `status & SessionStatus.InProgress` matches both ordinary in-progress turns
 * and turns that are paused waiting for input.
 *
 * @category Session State
 * @nonexhaustive
 */
export var SessionStatus;
(function (SessionStatus) {
    /** Session is idle — no turn is active. */
    SessionStatus[SessionStatus["Idle"] = 1] = "Idle";
    /** Session ended with an error. */
    SessionStatus[SessionStatus["Error"] = 2] = "Error";
    /** A turn is actively streaming. */
    SessionStatus[SessionStatus["InProgress"] = 8] = "InProgress";
    /** A turn is in progress but blocked waiting for user input or tool confirmation. */
    SessionStatus[SessionStatus["InputNeeded"] = 24] = "InputNeeded";
    /** The client has viewed this session since its last modification. */
    SessionStatus[SessionStatus["IsRead"] = 32] = "IsRead";
    /** The session has been archived by the client. */
    SessionStatus[SessionStatus["IsArchived"] = 64] = "IsArchived";
})(SessionStatus || (SessionStatus = {}));
/**
 * Discriminant describing the durable provenance of a session.
 *
 * @category Session State
 * @nonexhaustive
 */
export var SessionOriginKind;
(function (SessionOriginKind) {
    /** The session was created as part of an automation run. */
    SessionOriginKind["Automation"] = "automation";
})(SessionOriginKind || (SessionOriginKind = {}));
// ─── Session Input Requests ──────────────────────────────────────────────────
/**
 * Discriminant for the kinds of outstanding input a session can surface in
 * {@link SessionState.inputNeeded}.
 *
 * This is a general/typological union (not a lifecycle), so the discriminant is
 * a `*Kind`.
 *
 * @category Session Input Types
 * @nonexhaustive
 */
export var SessionInputRequestKind;
(function (SessionInputRequestKind) {
    /** A user-facing elicitation mirrored from an unresolved chat response part. */
    SessionInputRequestKind["ChatInput"] = "chatInput";
    /** A tool call awaiting parameter- or result-confirmation. */
    SessionInputRequestKind["ToolConfirmation"] = "toolConfirmation";
    /** A running tool the session wants an active client to execute. */
    SessionInputRequestKind["ToolClientExecution"] = "toolClientExecution";
    /** A tool call blocked on MCP authentication mid-execution. */
    SessionInputRequestKind["ToolAuthentication"] = "toolAuthentication";
})(SessionInputRequestKind || (SessionInputRequestKind = {}));
// ─── Customization Types ─────────────────────────────────────────────────────
/**
 * Discriminant for the kind of customization.
 *
 * Top-level entries in {@link SessionState.customizations} and
 * {@link AgentInfo.customizations} are either container customizations
 * ({@link CustomizationType.Plugin | `Plugin`} or
 * {@link CustomizationType.Directory | `Directory`}) or
 * {@link CustomizationType.McpServer | `McpServer`} entries surfaced
 * directly by the host. The remaining types appear only as children of
 * a container.
 *
 * @category Customization Types
 * @nonexhaustive
 */
export var CustomizationType;
(function (CustomizationType) {
    CustomizationType["Plugin"] = "plugin";
    CustomizationType["Directory"] = "directory";
    CustomizationType["Agent"] = "agent";
    CustomizationType["Skill"] = "skill";
    CustomizationType["Prompt"] = "prompt";
    CustomizationType["Rule"] = "rule";
    CustomizationType["Hook"] = "hook";
    CustomizationType["McpServer"] = "mcpServer";
})(CustomizationType || (CustomizationType = {}));
/**
 * Scope at which customization enablement is decided.
 *
 * @category Customization Types
 * @nonexhaustive
 */
export var CustomizationEnablementKind;
(function (CustomizationEnablementKind) {
    CustomizationEnablementKind["Global"] = "global";
    CustomizationEnablementKind["Workspace"] = "workspace";
    CustomizationEnablementKind["Session"] = "session";
})(CustomizationEnablementKind || (CustomizationEnablementKind = {}));
/**
 * Discriminant values for {@link CustomizationLoadState}.
 *
 * @category Customization Types
 * @exhaustive
 */
export var CustomizationLoadStatus;
(function (CustomizationLoadStatus) {
    CustomizationLoadStatus["Loading"] = "loading";
    CustomizationLoadStatus["Loaded"] = "loaded";
    CustomizationLoadStatus["Degraded"] = "degraded";
    CustomizationLoadStatus["Error"] = "error";
})(CustomizationLoadStatus || (CustomizationLoadStatus = {}));
// ─── MCP Server State ────────────────────────────────────────────────────────
/**
 * Discriminant for the {@link McpServerState} union.
 *
 * @category MCP Server State
 * @nonexhaustive
 */
export var McpServerStatus;
(function (McpServerStatus) {
    /** Server has been registered but is not yet running. */
    McpServerStatus["Starting"] = "starting";
    /** Server is running and serving requests. */
    McpServerStatus["Ready"] = "ready";
    /**
     * Server is reachable but requires additional authentication before it
     * can start, or before it can serve a particular request. Carries the
     * RFC 9728 Protected Resource Metadata the client needs to obtain a
     * token; the client then pushes the token via the existing
     * `authenticate` command.
     */
    McpServerStatus["AuthRequired"] = "authRequired";
    /** Server failed to start, crashed, or otherwise transitioned to a fatal error. */
    McpServerStatus["Error"] = "error";
    /** Server has been shut down. */
    McpServerStatus["Stopped"] = "stopped";
})(McpServerStatus || (McpServerStatus = {}));
/**
 * Why an MCP server is currently in the {@link McpServerStatus.AuthRequired}
 * state. Mirrors the three failure modes defined by the
 * [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization.md).
 *
 * @category MCP Server State
 * @nonexhaustive
 */
export var McpAuthRequiredReason;
(function (McpAuthRequiredReason) {
    /** No token has been provided yet (HTTP 401, no prior token). */
    McpAuthRequiredReason["Required"] = "required";
    /** A previously valid token expired or was revoked (HTTP 401). */
    McpAuthRequiredReason["Expired"] = "expired";
    /**
     * Step-up auth: a token is present but its scopes are insufficient for
     * the requested operation (HTTP 403 with
     * `WWW-Authenticate: Bearer error="insufficient_scope"`).
     *
     * Unlike {@link Required} and {@link Expired} — which typically surface
     * before any tool work is in flight — `InsufficientScope` is almost
     * always triggered by an MCP request issued mid-turn (a `tools/call`,
     * `resources/read`, etc.). The host SHOULD pair the
     * {@link McpServerAuthRequiredState} transition with
     * {@link SessionStatus.InputNeeded} on
     * {@link SessionSummary.status | the session} so the activity becomes
     * visible at the session-summary level, and clients SHOULD watch for
     * this kind on any
     * {@link McpServerCustomization | MCP server} backing a running tool
     * call so they can present an explicit "grant more access" affordance
     * tied to the blocked tool call.
     */
    McpAuthRequiredReason["InsufficientScope"] = "insufficientScope";
})(McpAuthRequiredReason || (McpAuthRequiredReason = {}));
