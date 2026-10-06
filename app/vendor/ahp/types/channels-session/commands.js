// Generated from types/*.ts — do not edit.
// Regenerate with: npm run generate:typescript
// ─── completions ─────────────────────────────────────────────────────────────
/**
 * The kind of completion items being requested.
 *
 * @category Commands
 * @nonexhaustive
 */
export var CompletionItemKind;
(function (CompletionItemKind) {
    /**
     * Completions for the text of a {@link Message} the user is composing.
     * Each returned item carries an attachment that gets associated with the
     * message when accepted.
     */
    CompletionItemKind["UserMessage"] = "userMessage";
})(CompletionItemKind || (CompletionItemKind = {}));
