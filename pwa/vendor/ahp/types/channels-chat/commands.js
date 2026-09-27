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
