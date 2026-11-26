// Generated from types/*.ts — do not edit.
// Regenerate with: npm run generate:typescript
// ─── Standard JSON-RPC Codes ─────────────────────────────────────────────────
/**
 * Standard JSON-RPC 2.0 error codes.
 *
 * @category Standard JSON-RPC Codes
 */
export const JsonRpcErrorCodes = {
    /** Invalid JSON */
    ParseError: -32700,
    /** Not a valid JSON-RPC request */
    InvalidRequest: -32600,
    /** Unknown method name */
    MethodNotFound: -32601,
    /** Invalid method parameters */
    InvalidParams: -32602,
    /** Unspecified server error */
    InternalError: -32603,
};
// ─── AHP Application Codes ──────────────────────────────────────────────────
/**
 * AHP application-specific error codes.
 *
 * @category AHP Application Codes
 * @version 1
 */
export const AhpErrorCodes = {
    /** The referenced session URI does not exist */
    SessionNotFound: -32001,
    /** The requested agent provider is not registered */
    ProviderNotFound: -32002,
    /** A session with the given URI already exists */
    SessionAlreadyExists: -32003,
    /** The operation requires no active turn, but one is in progress */
    TurnInProgress: -32004,
    /**
     * The server cannot speak any of the protocol versions offered by the
     * client in `InitializeParams.protocolVersions`. The `data` field of the
     * JSON-RPC error MUST carry an `UnsupportedProtocolVersionErrorData`
     * advertising the protocol versions the server is willing to speak.
     */
    UnsupportedProtocolVersion: -32005,
    /**
     * A command failed because the client has not authenticated for a required
     * protected resource. The `data` field of the JSON-RPC error MUST be an
     * `AuthRequiredErrorData` describing the resources that require
     * authentication.
     *
     * @see {@link /specification/authentication | Authentication}
     */
    AuthRequired: -32007,
    /** The requested file, folder, or URI does not exist */
    NotFound: -32008,
    /**
     * The client is not permitted to access the requested resource.
     *
     * Servers SHOULD return this when a client attempts to read or browse
     * a path outside the allowed set (e.g. outside the session's working
     * directory or workspace roots).
     *
     * The `data` field of the JSON-RPC error MAY be a
     * `PermissionDeniedErrorData` advertising a `resourceRequest` that, if
     * granted, would unlock the operation.
     */
    PermissionDenied: -32009,
    /**
     * The target resource already exists and the operation does not allow
     * overwriting (e.g. `resourceWrite` with `createOnly: true`).
     */
    AlreadyExists: -32010,
    /**
     * An optimistic-concurrency precondition failed.
     *
     * Returned when a request carries a precondition token that no longer
     * matches the receiver's current state — for example, `resourceWrite`
     * with an `ifMatch` etag that has been superseded by a concurrent
     * write. Callers SHOULD re-read the resource (e.g. via
     * `resourceResolve`) and decide whether to retry the operation with the
     * fresh token or surface the conflict to the user.
     */
    Conflict: -32011,
};
