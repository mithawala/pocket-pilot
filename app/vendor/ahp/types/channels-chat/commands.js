// Generated from types/*.ts — do not edit.
// Regenerate with: npm run generate:typescript
// ─── createChat ──────────────────────────────────────────────────────────────
/**
 * How a new chat uses its source chat and turn.
 * @nonexhaustive
 */
export var ChatSourceKind;
(function (ChatSourceKind) {
    /** Copy source history through the referenced turn into the new chat. */
    ChatSourceKind["Fork"] = "fork";
    /** Supply source context without copying it into the new chat's visible history. */
    ChatSourceKind["SideChat"] = "sideChat";
})(ChatSourceKind || (ChatSourceKind = {}));
// ─── moveChat ────────────────────────────────────────────────────────────────
/**
 * Destination kind for an atomic chat move.
 *
 * @category Commands
 * @nonexhaustive
 */
export var ChatMoveDestinationKind;
(function (ChatMoveDestinationKind) {
    /** Move the source chat subtree into an existing session. */
    ChatMoveDestinationKind["Session"] = "session";
    /** Move the source chat subtree into a newly allocated session. */
    ChatMoveDestinationKind["NewSession"] = "newSession";
})(ChatMoveDestinationKind || (ChatMoveDestinationKind = {}));
