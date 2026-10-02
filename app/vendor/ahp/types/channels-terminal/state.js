// Generated from types/*.ts — do not edit.
// Regenerate with: npm run generate:typescript
/**
 * Lifecycle status of a terminal process.
 *
 * @category Terminal Types
 * @exhaustive
 */
export var TerminalLifecycleStatus;
(function (TerminalLifecycleStatus) {
    TerminalLifecycleStatus["Running"] = "running";
    TerminalLifecycleStatus["Exited"] = "exited";
})(TerminalLifecycleStatus || (TerminalLifecycleStatus = {}));
/**
 * Discriminant for terminal claim kinds.
 *
 * @category Terminal Types
 * @exhaustive
 */
export var TerminalClaimKind;
(function (TerminalClaimKind) {
    TerminalClaimKind["Client"] = "client";
    TerminalClaimKind["Session"] = "session";
})(TerminalClaimKind || (TerminalClaimKind = {}));
