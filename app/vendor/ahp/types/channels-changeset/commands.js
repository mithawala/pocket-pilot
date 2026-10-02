// Generated from types/*.ts — do not edit.
// Regenerate with: npm run generate:typescript
// ─── invokeChangesetOperation ────────────────────────────────────────────────
/**
 * Discriminator for {@link ChangesetOperationTarget}. Mirrors the
 * non-`Changeset` members of {@link ChangesetOperationScope} — the
 * `Changeset` scope has no target.
 *
 * @category Commands
 * @nonexhaustive
 */
export var ChangesetOperationTargetKind;
(function (ChangesetOperationTargetKind) {
    /** Operation acts on a single file. */
    ChangesetOperationTargetKind["Resource"] = "resource";
    /** Operation acts on a line range within a single file. */
    ChangesetOperationTargetKind["Range"] = "range";
})(ChangesetOperationTargetKind || (ChangesetOperationTargetKind = {}));
