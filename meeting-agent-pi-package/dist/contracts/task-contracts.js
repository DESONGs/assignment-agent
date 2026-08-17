/**
 * Canonical task-control literals and public TypeScript contracts.
 *
 * Runtime tools import the emitted ESM constants from dist/. JSON Schema files
 * remain compatibility artifacts and are checked against these values before
 * tests and packing, so a router/status change cannot silently drift from the
 * published contract.
 */
export const TASK_TYPES = [
    "meeting_minutes",
    "doc_writer",
    "document_revision",
    "feishu_bot",
    "wechat_adapter",
    "document_lifecycle",
    "retrieval",
    "calendar",
    "task_management",
    "research",
    "knowledge_source",
    "mixed",
];
export const ACTION_INTENTS = [
    "read",
    "draft",
    "interact",
    "review",
    "write_private",
    "publish_customer_visible",
    "notify_people",
    "mutate_calendar",
    "assign_task",
    "external_web",
    "install_dependency",
];
export const TASK_EXECUTION_PROFILES = [
    "unsupported",
    "fast_answer",
    "file_summary",
    "audio_minutes",
    "document_generation",
    "document_revision",
    "multi_source_synthesis",
    "url_source_pack",
    "publish_only",
];
export const RUNNER_EXECUTION_PROFILES = [
    "fast_answer",
    "file_summary",
    "audio_minutes",
    "document_generation",
    "document_revision",
    "multi_source_synthesis",
    "url_source_pack",
];
export const FULL_DOCUMENT_EXECUTION_PROFILES = [
    "audio_minutes",
    "document_generation",
    "document_revision",
    "multi_source_synthesis",
];
export const DEEP_REASONING_EXECUTION_PROFILES = [
    "audio_minutes",
    "document_generation",
    "document_revision",
    "url_source_pack",
];
export const TASK_REASONING_DEPTHS = ["fast", "deep"];
export const TASK_RUN_STATUSES = ["accepted", "running", "completed", "needs_fix", "blocked", "failed"];
export const TASK_RUN_STEP_STATUSES = ["pending", "running", "completed", "needs_fix", "blocked", "failed", "skipped"];
export const LEDGER_STATUSES = ["active", "awaiting_user", "blocked", "completed", "cancelled"];
export const LEDGER_STEP_STATUSES = ["pending", "ready", "in_progress", "completed", "blocked", "failed", "cancelled", "skipped"];
export const INTERACTION_KINDS = ["progress", "decision", "question", "suggestion"];
export const INTERACTION_STATUSES = ["pending", "answered", "dismissed"];
export const INTERACTION_PRIORITIES = ["high", "medium", "low"];
export const TODO_ITEM_STATUSES = ["pending", "ready", "in_progress", "completed", "blocked", "failed", "cancelled", "skipped", "answered", "dismissed"];
export const TERMINAL_TODO_STATUSES = ["completed", "answered", "dismissed", "skipped", "cancelled"];
export const FAST_ANSWER_EXECUTION_PROFILE = "fast_answer";
export const FAST_REASONING_DEPTH = "fast";
function isLiteralValue(values, value) {
    return typeof value === "string" && values.includes(value);
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}
export function isTaskType(value) {
    return isLiteralValue(TASK_TYPES, value);
}
export function isTaskExecutionProfile(value) {
    return isLiteralValue(TASK_EXECUTION_PROFILES, value);
}
export function isTaskReasoningDepth(value) {
    return isLiteralValue(TASK_REASONING_DEPTHS, value);
}
export function isTaskRunStatus(value) {
    return isLiteralValue(TASK_RUN_STATUSES, value);
}
export function isTaskRunStepStatus(value) {
    return isLiteralValue(TASK_RUN_STEP_STATUSES, value);
}
export function isLedgerStepStatus(value) {
    return isLiteralValue(LEDGER_STEP_STATUSES, value);
}
export function isLedgerStatus(value) {
    return isLiteralValue(LEDGER_STATUSES, value);
}
export function isInteractionKind(value) {
    return isLiteralValue(INTERACTION_KINDS, value);
}
export function isInteractionStatus(value) {
    return isLiteralValue(INTERACTION_STATUSES, value);
}
export function isInteractionPriority(value) {
    return isLiteralValue(INTERACTION_PRIORITIES, value);
}
export function isAdaptiveExecutionLedger(value) {
    if (!isObject(value))
        return false;
    if (value.schemaVersion !== "adaptive-execution-ledger-v1")
        return false;
    if (typeof value.planId !== "string" || !Number.isInteger(value.revision))
        return false;
    if (!isLedgerStatus(value.status) || !isTaskType(value.taskType))
        return false;
    if (!Array.isArray(value.steps) || !value.steps.every((step) => {
        if (!isObject(step))
            return false;
        return typeof step.stepId === "string" &&
            typeof step.title === "string" &&
            isLedgerStepStatus(step.status) &&
            isStringArray(step.dependsOn) &&
            isStringArray(step.acceptance) &&
            isStringArray(step.inputRefs) &&
            isStringArray(step.resultRefs);
    }))
        return false;
    if (!Array.isArray(value.interactionItems) || !value.interactionItems.every((item) => {
        if (!isObject(item))
            return false;
        return typeof item.itemId === "string" &&
            isInteractionKind(item.kind) &&
            isInteractionStatus(item.status) &&
            isInteractionPriority(item.priority);
    }))
        return false;
    return isObject(value.userTodoProjection) && value.userTodoProjection.schemaVersion === "execution-todo-projection-v1";
}
//# sourceMappingURL=task-contracts.js.map