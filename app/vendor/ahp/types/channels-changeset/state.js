// Generated from types/*.ts — do not edit.
// Regenerate with: npm run generate:typescript
/**
 * Computation lifecycle of a {@link ChangesetState}.
 *
 * @category Changesets
 * @nonexhaustive
 */
export var ChangesetStatus;
(function (ChangesetStatus) {
    /** The server is computing this changeset for the first time. */
    ChangesetStatus["Computing"] = "computing";
    /**
     * The server is recomputing this changeset. {@link ChangesetState.files}
     * remains the previous completed result while recomputation is in progress,
     * including when that result is an empty array.
     */
    ChangesetStatus["Recomputing"] = "recomputing";
    /** The changeset has been fully computed and is up-to-date. */
    ChangesetStatus["Ready"] = "ready";
    /**
     * Computation failed. The cause is described by
     * {@link ChangesetState.error}.
     */
    ChangesetStatus["Error"] = "error";
})(ChangesetStatus || (ChangesetStatus = {}));
/**
 * Execution lifecycle of a {@link ChangesetOperation}.
 *
 * An operation is invoked imperatively via `invokeChangesetOperation`, but
 * its progress and outcome are reflected back into changeset state so that
 * every subscriber observes a consistent view (e.g. a spinner on a "Create
 * Pull Request" button, or an inline error after a failed "revert").
 *
 * @category Changesets
 * @nonexhaustive
 */
export var ChangesetOperationStatus;
(function (ChangesetOperationStatus) {
    /**
     * The operation is ready to be invoked. This is the default when
     * {@link ChangesetOperation.status} is omitted.
     */
    ChangesetOperationStatus["Idle"] = "idle";
    /** An invocation of this operation is currently in flight. */
    ChangesetOperationStatus["Running"] = "running";
    /**
     * The most recent invocation failed. The cause is described by
     * {@link ChangesetOperation.error}.
     */
    ChangesetOperationStatus["Error"] = "error";
    /**
     * The operation is currently disabled and cannot be invoked.
     */
    ChangesetOperationStatus["Disabled"] = "disabled";
})(ChangesetOperationStatus || (ChangesetOperationStatus = {}));
/**
 * Where a {@link ChangesetOperation} can be invoked.
 *
 * @category Changesets
 * @nonexhaustive
 */
export var ChangesetOperationScope;
(function (ChangesetOperationScope) {
    /** Applies to the whole changeset. */
    ChangesetOperationScope["Changeset"] = "changeset";
    /** Applies to a single file within the changeset. */
    ChangesetOperationScope["Resource"] = "resource";
    /** Applies to a line range within a single file. */
    ChangesetOperationScope["Range"] = "range";
})(ChangesetOperationScope || (ChangesetOperationScope = {}));
