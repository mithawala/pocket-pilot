// Generated from types/*.ts — do not edit.
// Regenerate with: npm run generate:typescript
// ─── reconnect ───────────────────────────────────────────────────────────────
/**
 * Discriminant for reconnect result types.
 *
 * @category Commands
 * @exhaustive
 */
export var ReconnectResultType;
(function (ReconnectResultType) {
    ReconnectResultType["Replay"] = "replay";
    ReconnectResultType["Snapshot"] = "snapshot";
})(ReconnectResultType || (ReconnectResultType = {}));
// ─── resourceRead ────────────────────────────────────────────────────────
/**
 * Encoding of fetched content data.
 *
 * @category Commands
 * @exhaustive
 */
export var ContentEncoding;
(function (ContentEncoding) {
    ContentEncoding["Base64"] = "base64";
    ContentEncoding["Utf8"] = "utf-8";
})(ContentEncoding || (ContentEncoding = {}));
// ─── resourceWrite ───────────────────────────────────────────────────────────
/**
 * How {@link ResourceWriteParams.data} is placed within the target file.
 *
 * Each mode interprets {@link ResourceWriteParams.position} differently:
 *
 * - `truncate` (default): rooted at the **start** of the file. The file is
 *   truncated at `position` (0 by default) and `data` is written from that
 *   offset, so the resulting file is `existing[0..position] + data`. With
 *   `position` omitted this is a full overwrite.
 * - `append`: rooted at the **end** of the file. `position` counts bytes
 *   backwards from EOF, so `position: 0` (the default) writes at EOF —
 *   POSIX append — and `position: 5` inserts `data` 5 bytes before the
 *   current EOF, shifting those trailing 5 bytes after the inserted region.
 *   The server MUST evaluate the effective EOF and write atomically with
 *   respect to other appenders so concurrent `append` writes do not
 *   clobber each other.
 * - `insert`: rooted at the **start** of the file. `position` (0 by default)
 *   is the byte offset at which `data` is spliced in; bytes at or after
 *   `position` are shifted right by `data.length`. `insert` always grows
 *   the file — use `truncate` to overwrite bytes in place.
 *
 * @category Commands
 * @exhaustive
 */
export var ResourceWriteMode;
(function (ResourceWriteMode) {
    ResourceWriteMode["Truncate"] = "truncate";
    ResourceWriteMode["Append"] = "append";
    ResourceWriteMode["Insert"] = "insert";
})(ResourceWriteMode || (ResourceWriteMode = {}));
// ─── resourceResolve ─────────────────────────────────────────────────────────
/**
 * Discriminant for {@link ResourceResolveResult.type}.
 *
 * @category Commands
 * @nonexhaustive
 */
export var ResourceType;
(function (ResourceType) {
    ResourceType["File"] = "file";
    ResourceType["Directory"] = "directory";
    ResourceType["Symlink"] = "symlink";
})(ResourceType || (ResourceType = {}));
