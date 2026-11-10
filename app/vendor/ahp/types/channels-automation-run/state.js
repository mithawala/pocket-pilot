// Generated from types/*.ts — do not edit.
// Regenerate with: npm run generate:typescript
/**
 * Lifecycle status of one automation run.
 *
 * `completed`, `failed`, and `cancelled` are terminal. A run remains `running`
 * while any linked session awaits input or client-side work; linked session
 * state is authoritative for those interactions.
 *
 * @category Automation Run State
 * @exhaustive
 */
export var AutomationRunStatus;
(function (AutomationRunStatus) {
    /** The durable run record exists but execution has not started. */
    AutomationRunStatus["Pending"] = "pending";
    /** One or more linked sessions are executing or awaiting interaction. */
    AutomationRunStatus["Running"] = "running";
    /** Execution finished successfully. */
    AutomationRunStatus["Completed"] = "completed";
    /** Execution ended with an error. */
    AutomationRunStatus["Failed"] = "failed";
    /** Execution ended because cancellation was accepted. */
    AutomationRunStatus["Cancelled"] = "cancelled";
})(AutomationRunStatus || (AutomationRunStatus = {}));
/**
 * Discriminant describing what created an automation run.
 *
 * @category Automation Run State
 * @exhaustive
 */
export var AutomationRunOriginKind;
(function (AutomationRunOriginKind) {
    /** A client explicitly invoked {@link RunAutomationParams | runAutomation}. */
    AutomationRunOriginKind["Manual"] = "manual";
    /** An automatic schedule or event trigger fired. */
    AutomationRunOriginKind["Trigger"] = "trigger";
})(AutomationRunOriginKind || (AutomationRunOriginKind = {}));
