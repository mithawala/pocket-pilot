// Generated from types/*.ts — do not edit.
// Regenerate with: npm run generate:typescript
/**
 * Reason why authentication is required.
 *
 * @category Protocol Notifications
 * @nonexhaustive
 */
export var AuthRequiredReason;
(function (AuthRequiredReason) {
    /** The client has not yet authenticated for the resource */
    AuthRequiredReason["Required"] = "required";
    /**
     * A previously valid token has expired or been revoked. The client must
     * acquire or renew the credential rather than replaying the challenged token.
     */
    AuthRequiredReason["Expired"] = "expired";
})(AuthRequiredReason || (AuthRequiredReason = {}));
