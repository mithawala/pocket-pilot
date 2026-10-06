// Generated from types/*.ts — do not edit.
// Regenerate with: npm run generate:typescript
/**
 * Kind of {@link BackgroundWork}.
 *
 * This is a general/typological union (not a lifecycle), so the discriminant is
 * a `*Kind`.
 *
 * @category Background Work
 * @nonexhaustive
 */
export var BackgroundWorkKind;
(function (BackgroundWorkKind) {
    /** A shell command that continues after its initiating tool call returns. */
    BackgroundWorkKind["Shell"] = "shell";
    /** A subagent running in the background. */
    BackgroundWorkKind["Subagent"] = "subagent";
})(BackgroundWorkKind || (BackgroundWorkKind = {}));
/**
 * Discriminant for {@link ChatOrigin} — how a chat came into existence.
 *
 * @category Chat State
 * @nonexhaustive
 */
export var ChatOriginKind;
(function (ChatOriginKind) {
    /** User created the chat explicitly (e.g. via the host UI). */
    ChatOriginKind["User"] = "user";
    /** Forked from an existing chat at a specific turn. */
    ChatOriginKind["Fork"] = "fork";
    /** Created as an independent side conversation from a specific turn. */
    ChatOriginKind["SideChat"] = "sideChat";
    /** Spawned by a tool call running in another chat (e.g. a sub-agent delegation). */
    ChatOriginKind["Tool"] = "tool";
})(ChatOriginKind || (ChatOriginKind = {}));
/**
 * How a user can interact with a chat.
 *
 * - `Full` — user can send messages and watch (default when absent)
 * - `ReadOnly` — user can watch but not send messages (e.g. agent team workers)
 * - `Hidden` — internal worker not shown in UI at all
 *
 * Supports the agent-team pattern where a lead chat is fully interactive and
 * worker chats are read-only (visible for observability) or hidden (internal
 * implementation detail). The harness sets this based on the chat's role;
 * the UI uses it to show appropriate controls.
 *
 * @category Chat State
 * @exhaustive
 */
export var ChatInteractivity;
(function (ChatInteractivity) {
    /** User can send messages and watch (default when absent) */
    ChatInteractivity["Full"] = "full";
    /** User can watch but not send messages */
    ChatInteractivity["ReadOnly"] = "read-only";
    /** Internal worker not shown in UI at all */
    ChatInteractivity["Hidden"] = "hidden";
})(ChatInteractivity || (ChatInteractivity = {}));
// ─── Pending Message Types ───────────────────────────────────────────────────
/**
 * Discriminant for pending message kinds.
 *
 * @category Pending Message Types
 * @exhaustive
 */
export var PendingMessageKind;
(function (PendingMessageKind) {
    /** Injected into the current turn at a convenient point */
    PendingMessageKind["Steering"] = "steering";
    /** Sent automatically as a new turn after the current turn finishes */
    PendingMessageKind["Queued"] = "queued";
})(PendingMessageKind || (PendingMessageKind = {}));
// ─── Chat Input Types ────────────────────────────────────────────────────
/**
 * How a client completed an input request.
 *
 * @category Chat Input Types
 * @exhaustive
 */
export var ChatInputResponseKind;
(function (ChatInputResponseKind) {
    ChatInputResponseKind["Accept"] = "accept";
    ChatInputResponseKind["Decline"] = "decline";
    ChatInputResponseKind["Cancel"] = "cancel";
})(ChatInputResponseKind || (ChatInputResponseKind = {}));
/**
 * Question/input control kind.
 *
 * @category Chat Input Types
 * @nonexhaustive
 */
export var ChatInputQuestionKind;
(function (ChatInputQuestionKind) {
    ChatInputQuestionKind["Text"] = "text";
    ChatInputQuestionKind["Number"] = "number";
    ChatInputQuestionKind["Integer"] = "integer";
    ChatInputQuestionKind["Boolean"] = "boolean";
    ChatInputQuestionKind["SingleSelect"] = "single-select";
    ChatInputQuestionKind["MultiSelect"] = "multi-select";
})(ChatInputQuestionKind || (ChatInputQuestionKind = {}));
/**
 * Answer value kind.
 *
 * @category Chat Input Types
 * @nonexhaustive
 */
export var ChatInputAnswerValueKind;
(function (ChatInputAnswerValueKind) {
    ChatInputAnswerValueKind["Text"] = "text";
    ChatInputAnswerValueKind["Number"] = "number";
    ChatInputAnswerValueKind["Boolean"] = "boolean";
    ChatInputAnswerValueKind["Selected"] = "selected";
    ChatInputAnswerValueKind["SelectedMany"] = "selected-many";
})(ChatInputAnswerValueKind || (ChatInputAnswerValueKind = {}));
/**
 * Answer lifecycle state.
 *
 * @category Chat Input Types
 * @exhaustive
 */
export var ChatInputAnswerState;
(function (ChatInputAnswerState) {
    ChatInputAnswerState["Draft"] = "draft";
    ChatInputAnswerState["Submitted"] = "submitted";
    ChatInputAnswerState["Skipped"] = "skipped";
})(ChatInputAnswerState || (ChatInputAnswerState = {}));
// ─── Turn Types ──────────────────────────────────────────────────────────────
/**
 * How a turn ended.
 *
 * @category Turn Types
 * @exhaustive
 */
export var TurnState;
(function (TurnState) {
    TurnState["Complete"] = "complete";
    TurnState["Cancelled"] = "cancelled";
    TurnState["Error"] = "error";
})(TurnState || (TurnState = {}));
/**
 * Discriminant for {@link MessageAttachment} variants.
 *
 * @category Turn Types
 * @nonexhaustive
 */
export var MessageAttachmentKind;
(function (MessageAttachmentKind) {
    /** A simple, opaque attachment whose representation is described by the producer. */
    MessageAttachmentKind["Simple"] = "simple";
    /** An attachment whose data is embedded inline as a base64 string. */
    MessageAttachmentKind["EmbeddedResource"] = "embeddedResource";
    /** An attachment that references a resource by URI. */
    MessageAttachmentKind["Resource"] = "resource";
    /** An attachment that references annotations on an annotations channel. */
    MessageAttachmentKind["Annotations"] = "annotations";
    /** An attachment that references a bounded transcript from another chat. */
    MessageAttachmentKind["Chat"] = "chat";
})(MessageAttachmentKind || (MessageAttachmentKind = {}));
/**
 * Discriminant for {@link MessageOrigin} — identifies who produced a message.
 *
 * @category Turn Types
 * @nonexhaustive
 */
export var MessageKind;
(function (MessageKind) {
    /** Sent directly by the user. */
    MessageKind["User"] = "user";
    /**
     * Produced by the agent itself rather than the user — for example, an agent
     * that seeds the first message of a chat it spawned.
     */
    MessageKind["Agent"] = "agent";
    /**
     * Produced by a tool rather than the user — for example, a tool that spawns a
     * worker chat whose first message carries a seed prompt.
     */
    MessageKind["Tool"] = "tool";
    /** Emitted automatically when an automation run starts a session. */
    MessageKind["Automation"] = "automation";
    /** A system-generated notification rather than a direct user message. */
    MessageKind["SystemNotification"] = "systemNotification";
})(MessageKind || (MessageKind = {}));
// ─── Response Parts ──────────────────────────────────────────────────────────
/**
 * Discriminant for response part types.
 *
 * @category Response Parts
 * @nonexhaustive
 */
export var ResponsePartKind;
(function (ResponsePartKind) {
    ResponsePartKind["Markdown"] = "markdown";
    ResponsePartKind["ContentRef"] = "contentRef";
    ResponsePartKind["ToolCall"] = "toolCall";
    ResponsePartKind["Reasoning"] = "reasoning";
    ResponsePartKind["SystemNotification"] = "systemNotification";
    ResponsePartKind["InputRequest"] = "inputRequest";
    ResponsePartKind["Error"] = "error";
})(ResponsePartKind || (ResponsePartKind = {}));
// ─── Tool Call Types ─────────────────────────────────────────────────────────
/**
 * Status of a tool call in the lifecycle state machine.
 *
 * @category Tool Call Types
 * @nonexhaustive
 */
export var ToolCallStatus;
(function (ToolCallStatus) {
    ToolCallStatus["Streaming"] = "streaming";
    ToolCallStatus["PendingConfirmation"] = "pending-confirmation";
    ToolCallStatus["Running"] = "running";
    /**
     * Running paused because the MCP server backing this call needs
     * authentication (typically step-up auth for insufficient scope,
     * surfacing mid-execution). See {@link ToolCallAuthRequiredState}.
     */
    ToolCallStatus["AuthRequired"] = "auth-required";
    ToolCallStatus["PendingResultConfirmation"] = "pending-result-confirmation";
    ToolCallStatus["Completed"] = "completed";
    ToolCallStatus["Cancelled"] = "cancelled";
})(ToolCallStatus || (ToolCallStatus = {}));
/**
 * How a tool call was confirmed for execution.
 *
 * - `NotNeeded` — No confirmation required (auto-approved)
 * - `UserAction` — User explicitly approved
 * - `Setting` — Approved by a persistent user setting
 *
 * @category Tool Call Types
 * @nonexhaustive
 */
export var ToolCallConfirmationReason;
(function (ToolCallConfirmationReason) {
    ToolCallConfirmationReason["NotNeeded"] = "not-needed";
    ToolCallConfirmationReason["UserAction"] = "user-action";
    ToolCallConfirmationReason["Setting"] = "setting";
})(ToolCallConfirmationReason || (ToolCallConfirmationReason = {}));
/**
 * Identifies a model judge as the source of a confirmation requirement.
 *
 * @category Tool Call Types
 * @nonexhaustive
 */
export var ToolCallRiskAssessmentKind;
(function (ToolCallRiskAssessmentKind) {
    ToolCallRiskAssessmentKind["Judge"] = "judge";
})(ToolCallRiskAssessmentKind || (ToolCallRiskAssessmentKind = {}));
/**
 * Lifecycle status of an asynchronous model-judge confirmation decision.
 *
 * @category Tool Call Types
 * @nonexhaustive
 */
export var ToolCallRiskAssessmentStatus;
(function (ToolCallRiskAssessmentStatus) {
    ToolCallRiskAssessmentStatus["Loading"] = "loading";
    ToolCallRiskAssessmentStatus["Complete"] = "complete";
})(ToolCallRiskAssessmentStatus || (ToolCallRiskAssessmentStatus = {}));
/**
 * Why a tool call was cancelled.
 *
 * @category Tool Call Types
 * @exhaustive
 */
export var ToolCallCancellationReason;
(function (ToolCallCancellationReason) {
    ToolCallCancellationReason["Denied"] = "denied";
    ToolCallCancellationReason["Skipped"] = "skipped";
    ToolCallCancellationReason["ResultDenied"] = "result-denied";
})(ToolCallCancellationReason || (ToolCallCancellationReason = {}));
/**
 * Whether a confirmation option represents an approval or denial action.
 *
 * @category Tool Call Types
 * @nonexhaustive
 */
export var ConfirmationOptionKind;
(function (ConfirmationOptionKind) {
    ConfirmationOptionKind["Approve"] = "approve";
    ConfirmationOptionKind["Deny"] = "deny";
})(ConfirmationOptionKind || (ConfirmationOptionKind = {}));
/**
 * Identifies the source of a tool call's implementation.
 *
 * @category Tool Call Types
 * @nonexhaustive
 */
export var ToolCallContributorKind;
(function (ToolCallContributorKind) {
    ToolCallContributorKind["Client"] = "client";
    ToolCallContributorKind["MCP"] = "mcp";
})(ToolCallContributorKind || (ToolCallContributorKind = {}));
// ─── Tool Result Content ─────────────────────────────────────────────────────
/**
 * Discriminant for tool result content types.
 *
 * @category Tool Result Content
 * @nonexhaustive
 */
export var ToolResultContentType;
(function (ToolResultContentType) {
    ToolResultContentType["Text"] = "text";
    ToolResultContentType["EmbeddedResource"] = "embeddedResource";
    ToolResultContentType["Resource"] = "resource";
    ToolResultContentType["FileEdit"] = "fileEdit";
    ToolResultContentType["Terminal"] = "terminal";
    ToolResultContentType["Subagent"] = "subagent";
})(ToolResultContentType || (ToolResultContentType = {}));
