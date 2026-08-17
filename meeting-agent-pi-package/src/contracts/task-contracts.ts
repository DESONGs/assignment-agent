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
] as const;

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
] as const;

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
] as const;

export const RUNNER_EXECUTION_PROFILES = [
  "fast_answer",
  "file_summary",
  "audio_minutes",
  "document_generation",
  "document_revision",
  "multi_source_synthesis",
  "url_source_pack",
] as const satisfies readonly TaskExecutionProfile[];

export const FULL_DOCUMENT_EXECUTION_PROFILES = [
  "audio_minutes",
  "document_generation",
  "document_revision",
  "multi_source_synthesis",
] as const satisfies readonly TaskExecutionProfile[];

export const DEEP_REASONING_EXECUTION_PROFILES = [
  "audio_minutes",
  "document_generation",
  "document_revision",
  "url_source_pack",
] as const satisfies readonly TaskExecutionProfile[];

export const TASK_REASONING_DEPTHS = ["fast", "deep"] as const;
export const TASK_RUN_STATUSES = ["accepted", "running", "completed", "needs_fix", "blocked", "failed"] as const;
export const TASK_RUN_STEP_STATUSES = ["pending", "running", "completed", "needs_fix", "blocked", "failed", "skipped"] as const;
export const LEDGER_STATUSES = ["active", "awaiting_user", "blocked", "completed", "cancelled"] as const;
export const LEDGER_STEP_STATUSES = ["pending", "ready", "in_progress", "completed", "blocked", "failed", "cancelled", "skipped"] as const;
export const INTERACTION_KINDS = ["progress", "decision", "question", "suggestion"] as const;
export const INTERACTION_STATUSES = ["pending", "answered", "dismissed"] as const;
export const INTERACTION_PRIORITIES = ["high", "medium", "low"] as const;
export const TODO_ITEM_STATUSES = ["pending", "ready", "in_progress", "completed", "blocked", "failed", "cancelled", "skipped", "answered", "dismissed"] as const;
export const TERMINAL_TODO_STATUSES = ["completed", "answered", "dismissed", "skipped", "cancelled"] as const;

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

export const FAST_ANSWER_EXECUTION_PROFILE = "fast_answer" satisfies TaskExecutionProfile;
export const FAST_REASONING_DEPTH = "fast" satisfies TaskReasoningDepth;

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

function isLiteralValue<const Values extends readonly string[]>(values: Values, value: unknown): value is Values[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isTaskType(value: unknown): value is TaskType {
  return isLiteralValue(TASK_TYPES, value);
}

export function isTaskExecutionProfile(value: unknown): value is TaskExecutionProfile {
  return isLiteralValue(TASK_EXECUTION_PROFILES, value);
}

export function isTaskReasoningDepth(value: unknown): value is TaskReasoningDepth {
  return isLiteralValue(TASK_REASONING_DEPTHS, value);
}

export function isTaskRunStatus(value: unknown): value is TaskRunStatus {
  return isLiteralValue(TASK_RUN_STATUSES, value);
}

export function isTaskRunStepStatus(value: unknown): value is TaskRunStepStatus {
  return isLiteralValue(TASK_RUN_STEP_STATUSES, value);
}

export function isLedgerStepStatus(value: unknown): value is LedgerStepStatus {
  return isLiteralValue(LEDGER_STEP_STATUSES, value);
}

export function isLedgerStatus(value: unknown): value is LedgerStatus {
  return isLiteralValue(LEDGER_STATUSES, value);
}

export function isInteractionKind(value: unknown): value is InteractionKind {
  return isLiteralValue(INTERACTION_KINDS, value);
}

export function isInteractionStatus(value: unknown): value is InteractionStatus {
  return isLiteralValue(INTERACTION_STATUSES, value);
}

export function isInteractionPriority(value: unknown): value is InteractionPriority {
  return isLiteralValue(INTERACTION_PRIORITIES, value);
}

export function isAdaptiveExecutionLedger(value: unknown): value is AdaptiveExecutionLedger {
  if (!isObject(value)) return false;
  if (value.schemaVersion !== "adaptive-execution-ledger-v1") return false;
  if (typeof value.planId !== "string" || !Number.isInteger(value.revision)) return false;
  if (!isLedgerStatus(value.status) || !isTaskType(value.taskType)) return false;
  if (!Array.isArray(value.steps) || !value.steps.every((step) => {
    if (!isObject(step)) return false;
    return typeof step.stepId === "string" &&
      typeof step.title === "string" &&
      isLedgerStepStatus(step.status) &&
      isStringArray(step.dependsOn) &&
      isStringArray(step.acceptance) &&
      isStringArray(step.inputRefs) &&
      isStringArray(step.resultRefs);
  })) return false;
  if (!Array.isArray(value.interactionItems) || !value.interactionItems.every((item) => {
    if (!isObject(item)) return false;
    return typeof item.itemId === "string" &&
      isInteractionKind(item.kind) &&
      isInteractionStatus(item.status) &&
      isInteractionPriority(item.priority);
  })) return false;
  return isObject(value.userTodoProjection) && value.userTodoProjection.schemaVersion === "execution-todo-projection-v1";
}
