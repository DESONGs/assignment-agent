/**
 * Canonical task-control literals and public TypeScript contracts.
 *
 * Runtime tools import the emitted ESM constants from dist/. JSON Schema files
 * remain compatibility artifacts and are checked against these values before
 * tests and packing, so a router/status change cannot silently drift from the
 * published contract.
 */
export declare const TASK_TYPES: readonly ["meeting_minutes", "doc_writer", "document_revision", "feishu_bot", "wechat_adapter", "document_lifecycle", "retrieval", "calendar", "task_management", "research", "knowledge_source", "mixed"];
export declare const ACTION_INTENTS: readonly ["read", "draft", "interact", "review", "write_private", "publish_customer_visible", "notify_people", "mutate_calendar", "assign_task", "external_web", "install_dependency"];
export declare const TASK_EXECUTION_PROFILES: readonly ["unsupported", "fast_answer", "file_summary", "audio_minutes", "document_generation", "document_revision", "multi_source_synthesis", "url_source_pack", "publish_only"];
export declare const RUNNER_EXECUTION_PROFILES: readonly ["fast_answer", "file_summary", "audio_minutes", "document_generation", "document_revision", "multi_source_synthesis", "url_source_pack"];
export declare const FULL_DOCUMENT_EXECUTION_PROFILES: readonly ["audio_minutes", "document_generation", "document_revision", "multi_source_synthesis"];
export declare const DEEP_REASONING_EXECUTION_PROFILES: readonly ["audio_minutes", "document_generation", "document_revision", "url_source_pack"];
export declare const TASK_REASONING_DEPTHS: readonly ["fast", "deep"];
export declare const TASK_RUN_STATUSES: readonly ["accepted", "running", "completed", "needs_fix", "blocked", "failed"];
export declare const TASK_RUN_STEP_STATUSES: readonly ["pending", "running", "completed", "needs_fix", "blocked", "failed", "skipped"];
export declare const LEDGER_STATUSES: readonly ["active", "awaiting_user", "blocked", "completed", "cancelled"];
export declare const LEDGER_STEP_STATUSES: readonly ["pending", "ready", "in_progress", "completed", "blocked", "failed", "cancelled", "skipped"];
export declare const INTERACTION_KINDS: readonly ["progress", "decision", "question", "suggestion"];
export declare const INTERACTION_STATUSES: readonly ["pending", "answered", "dismissed"];
export declare const INTERACTION_PRIORITIES: readonly ["high", "medium", "low"];
export declare const TODO_ITEM_STATUSES: readonly ["pending", "ready", "in_progress", "completed", "blocked", "failed", "cancelled", "skipped", "answered", "dismissed"];
export declare const TERMINAL_TODO_STATUSES: readonly ["completed", "answered", "dismissed", "skipped", "cancelled"];
export type TaskType = (typeof TASK_TYPES)[number];
export type ActionIntent = (typeof ACTION_INTENTS)[number];
export type TaskExecutionProfile = (typeof TASK_EXECUTION_PROFILES)[number];
export type TaskReasoningDepth = (typeof TASK_REASONING_DEPTHS)[number];
export type TaskRunStatus = (typeof TASK_RUN_STATUSES)[number];
export type TaskRunStepStatus = (typeof TASK_RUN_STEP_STATUSES)[number];
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];
export type LedgerStepStatus = (typeof LEDGER_STEP_STATUSES)[number];
export type InteractionKind = (typeof INTERACTION_KINDS)[number];
export type InteractionStatus = (typeof INTERACTION_STATUSES)[number];
export type InteractionPriority = (typeof INTERACTION_PRIORITIES)[number];
export type TodoItemStatus = (typeof TODO_ITEM_STATUSES)[number];
export declare const FAST_ANSWER_EXECUTION_PROFILE = "fast_answer";
export declare const FAST_REASONING_DEPTH = "fast";
export interface CapabilityNeed {
    capabilityId: string;
    reason: string;
    loadMode: "always_on" | "lazy";
    contextCost: "low" | "medium" | "high";
}
export interface ToolPlanItem {
    toolIntent: ActionIntent;
    toolName: string;
    reason: string;
    policyCheckRequired: boolean;
}
export interface PolicyRisk {
    actionIntent: string;
    reason: string;
}
export interface ParallelizableWorker {
    component: string;
    reason: string;
    writeScope: string;
}
export interface LedgerEvent {
    eventId: string;
    type: string;
    at: string;
    actor: string;
    operationId?: string | null;
}
export interface LedgerStep {
    stepId: string;
    title: string;
    description: string;
    status: LedgerStepStatus;
    dependsOn: string[];
    owner: string;
    capabilityId: string | null;
    acceptance: string[];
    inputRefs: string[];
    resultRefs: string[];
    attempts: number;
    blockedReason: string | null;
    completedAt?: string | null;
}
export interface InteractionItem {
    itemId: string;
    kind: InteractionKind;
    label: string;
    description: string;
    status: InteractionStatus;
    priority: InteractionPriority;
    order: number;
    options: string[];
    blocks: string[];
    evidenceSegmentIds: string[];
    suggestedDocuments: string[];
    answer?: string | null;
}
export interface TodoProjectionItem {
    itemId: string;
    kind: InteractionKind;
    label: string;
    description?: string;
    status: TodoItemStatus;
    priority?: InteractionPriority;
    interactive: boolean;
    options: string[];
    blocks: string[];
}
export interface TodoProjection {
    schemaVersion: "execution-todo-projection-v1";
    planId: string | null;
    revision: number;
    completed: number;
    total: number;
    awaitingUser: boolean;
    items: TodoProjectionItem[];
}
export interface AdaptiveExecutionLedger {
    schemaVersion: "adaptive-execution-ledger-v1";
    planId: string;
    runId: string | null;
    revision: number;
    status: LedgerStatus;
    goal: string;
    taskType: TaskType;
    successCriteria: string[];
    constraints: string[];
    capabilitiesNeeded: CapabilityNeed[];
    toolPlan: ToolPlanItem[];
    steps: LedgerStep[];
    currentStepIds: string[];
    nextStepIds: string[];
    interactionItems: InteractionItem[];
    userTodoProjection: TodoProjection;
    parallelizableWorkers: ParallelizableWorker[];
    policyRisks: PolicyRisk[];
    requiredArtifacts: string[];
    stopConditions: string[];
    artifactIndex: Record<string, string>;
    checkpointRefs: string[];
    openQuestions: string[];
    events: LedgerEvent[];
    fixedWorkflow: false;
    plannerMode: "adaptive_execution_ledger";
    createdAt: string;
    updatedAt: string;
    rawSecretsReturned: false;
    meetingContentAccess: "allowed";
}
export interface TaskIntent {
    schemaVersion: "task-intent-v1";
    taskType: string;
    requestedDocuments: string[];
    executionProfile: TaskExecutionProfile;
    reasoningDepth: TaskReasoningDepth;
    responseMode?: string;
    operation?: string;
    requiredStages?: string[];
    skipStages?: string[];
    hasAttachments?: boolean;
    hasFileContexts?: boolean;
    requiresAsr?: boolean;
    requiresLocalAsr?: boolean;
    sourcePreparation?: unknown;
    immediateResponse?: string;
}
export declare function isTaskType(value: unknown): value is TaskType;
export declare function isTaskExecutionProfile(value: unknown): value is TaskExecutionProfile;
export declare function isTaskReasoningDepth(value: unknown): value is TaskReasoningDepth;
export declare function isTaskRunStatus(value: unknown): value is TaskRunStatus;
export declare function isTaskRunStepStatus(value: unknown): value is TaskRunStepStatus;
export declare function isLedgerStepStatus(value: unknown): value is LedgerStepStatus;
export declare function isLedgerStatus(value: unknown): value is LedgerStatus;
export declare function isInteractionKind(value: unknown): value is InteractionKind;
export declare function isInteractionStatus(value: unknown): value is InteractionStatus;
export declare function isInteractionPriority(value: unknown): value is InteractionPriority;
export declare function isAdaptiveExecutionLedger(value: unknown): value is AdaptiveExecutionLedger;
//# sourceMappingURL=task-contracts.d.ts.map