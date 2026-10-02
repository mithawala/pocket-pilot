// Generated from types/*.ts — do not edit.
// Regenerate with: npm run generate:typescript
/**
 * Operations the host currently permits for an automation.
 *
 * The list on {@link AutomationEntry.operations} is authoritative and may
 * change over time. Clients MUST NOT infer permission from capabilities alone:
 * capabilities describe what the host implementation can support, while
 * operations describe what is allowed for this particular automation now.
 *
 * @category Automation State
 * @nonexhaustive
 */
export var AutomationOperation;
(function (AutomationOperation) {
    /** Replace editable fields using {@link AutomationUpdateRequestedAction | `automation/updateRequested`}. */
    AutomationOperation["Update"] = "update";
    /** Permanently remove the automation using {@link AutomationRemovedAction | `automation/removed`}. */
    AutomationOperation["Remove"] = "remove";
    /** Start a manual run using {@link RunAutomationParams | runAutomation}. */
    AutomationOperation["Run"] = "run";
})(AutomationOperation || (AutomationOperation = {}));
/**
 * How a host handles schedule occurrences missed while automatic execution was
 * unavailable.
 *
 * @category Automation State
 * @nonexhaustive
 */
export var AutomationMisfirePolicy;
(function (AutomationMisfirePolicy) {
    /** Discard missed occurrences and wait for the next future occurrence. */
    AutomationMisfirePolicy["Skip"] = "skip";
    /**
     * Start at most one catch-up run when execution becomes available, regardless
     * of how many occurrences were missed.
     */
    AutomationMisfirePolicy["RunOnce"] = "runOnce";
})(AutomationMisfirePolicy || (AutomationMisfirePolicy = {}));
/**
 * Discriminant for automatic trigger definitions.
 *
 * @category Automation State
 * @exhaustive
 */
export var AutomationTriggerKind;
(function (AutomationTriggerKind) {
    /** A portable recurring {@link AutomationSchedule}. */
    AutomationTriggerKind["Schedule"] = "schedule";
    /** A host-defined external event discovered from trigger definitions. */
    AutomationTriggerKind["Event"] = "event";
})(AutomationTriggerKind || (AutomationTriggerKind = {}));
