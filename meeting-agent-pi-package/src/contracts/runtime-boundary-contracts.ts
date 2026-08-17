import {
  isTaskExecutionProfile,
  isTaskReasoningDepth,
  isTaskRunStatus,
  isTaskRunStepStatus,
  type TaskIntent,
  type TaskRunStatus,
} from "./task-contracts.js";

export const RUNTIME_CONTRACT_SCHEMA_VERSION = "assignment-agent-runtime-contracts-v1" as const;

export const MODEL_PROVIDER_PROTOCOLS = ["openai-chat-completions", "mock"] as const;
export const MODEL_GENERATION_STATUSES = ["completed", "blocked"] as const;
export const MODEL_ROUTE_STATUSES = ["selected", "blocked"] as const;
export const CLOUD_ASR_SUMMARY_STATUSES = ["complete", "needs_review"] as const;
export const CLOUD_ASR_INPUT_MODES = ["file", "realtime"] as const;
export const FEISHU_EVENT_SOURCES = [
  "lark-cli-event-consume",
  "sdk-gateway",
  "sdk-long-connection",
  "fixture",
  "stdin",
  "handler-direct",
] as const;
export const RUNTIME_STORE_SCHEMA_VERSION = "runtime-store-v1" as const;
export const RUNTIME_STORE_RESULT_STATUSES = [
  "blocked",
  "clean",
  "completed",
  "deleted",
  "error",
  "failed",
  "found",
  "indexed",
  "initialized",
  "kept_shared_cas_object",
  "missing",
  "moved",
  "not_found",
  "pinned",
  "planned",
  "polluted",
  "quarantined",
  "stored",
  "unpinned",
  "would_move",
] as const;

export type JsonObject = { [key: string]: unknown };
export type ModelProviderProtocol = (typeof MODEL_PROVIDER_PROTOCOLS)[number];
export type ModelGenerationStatus = (typeof MODEL_GENERATION_STATUSES)[number];
export type ModelRouteStatus = (typeof MODEL_ROUTE_STATUSES)[number];
export type CloudAsrSummaryStatus = (typeof CLOUD_ASR_SUMMARY_STATUSES)[number];
export type CloudAsrInputMode = (typeof CLOUD_ASR_INPUT_MODES)[number];
export type FeishuEventSource = (typeof FEISHU_EVENT_SOURCES)[number];
export type RuntimeStoreResultStatus = (typeof RUNTIME_STORE_RESULT_STATUSES)[number];

export interface ModelProviderRecord {
  provider: string;
  protocol: ModelProviderProtocol;
  apiKeyEnv: string | null;
  baseUrlEnv: string | null;
  defaultBaseUrl: string | null;
  chatCompletionsPath: string | null;
  requiredEnv: string[];
  allowedModels?: string[];
  supportsFileInput?: boolean;
  supportsTextFallback?: boolean;
  requestBodyReturned: false;
  rawSecretsReturned?: false;
}

export interface ModelProviderRegistry {
  version: string;
  providers: ModelProviderRecord[];
}

export interface ModelRouteCandidate {
  provider: string;
  model: string;
  strength?: string;
}

export interface ModelRouteSelection {
  status: "selected";
  selected: ModelRouteCandidate;
  modelRoute?: { selected?: ModelRouteCandidate };
}

export interface ModelUsage {
  prompt?: number;
  completion?: number;
  total?: number;
  [key: string]: unknown;
}

export interface ModelGenerationCompleted {
  status: "completed";
  reason?: never;
  provider: string;
  model: string;
  content: string;
  usage: ModelUsage | null;
  finishReason?: string | null;
  httpStatus?: never;
  mockProvider?: boolean;
  streamTracePath?: string | null;
  streamTraceSummaryPath?: string | null;
  rawSecretsReturned: false;
  requestBodyReturned: false;
}

export interface ModelGenerationBlocked {
  status: "blocked";
  reason: string;
  provider: string;
  model: string;
  error?: string;
  httpStatus?: number;
  timeoutMs?: number;
  durationMs?: number;
  firstByteAt?: string | null;
  chunkCount?: number;
  rawSecretsReturned: false;
  requestBodyReturned: false;
  [key: string]: unknown;
}

export type ModelGenerationResult = ModelGenerationCompleted | ModelGenerationBlocked;

export interface CloudAsrSummary {
  status: CloudAsrSummaryStatus;
  meetingId: string;
  provider: "aliyun_dashscope_paraformer";
  model: string;
  inputModes: CloudAsrInputMode[];
  sourceCount: number;
  transcriptSegments: number;
  failedChunks: number;
  partial: boolean;
  rawMediaExternalUpload: boolean;
  outputs: {
    sources: string;
    transcript: string;
    readableTranscript: string;
    evidenceIndex: string;
    summary: string;
    singleMixAnalysis?: string | null;
  };
  [key: string]: unknown;
}

export interface FeishuAttachment {
  resourceType: "file" | "image" | "audio" | "video" | "unknown";
  fileKey: string;
  name?: string;
  localPath?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface FeishuEvent {
  schemaVersion: "feishu-event-v1";
  eventId: string;
  eventType: string;
  source?: FeishuEventSource;
  receivedAt: string;
  message: {
    messageId: string;
    chatId: string;
    chatType?: string | null;
    msgType: string;
    text?: string;
    attachments?: FeishuAttachment[];
    [key: string]: unknown;
  };
  sender?: JsonObject;
  rawSecretsReturned: false;
  [key: string]: unknown;
}

export interface FeishuTask {
  schemaVersion: "feishu-task-v1";
  runId: string;
  status: TaskRunStatus;
  sourceEvent: FeishuEvent;
  taskIntent: TaskIntent;
  rawSecretsReturned: false;
  [key: string]: unknown;
}

export interface FeishuRunStateStep {
  name: string;
  status: string;
  at: string;
  [key: string]: unknown;
}

export interface FeishuRunState {
  schemaVersion: "feishu-run-state-v1";
  runId: string;
  status: TaskRunStatus;
  updatedAt: string;
  steps: FeishuRunStateStep[];
  rawSecretsReturned: false;
  [key: string]: unknown;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLiteralValue<const Values extends readonly string[]>(values: Values, value: unknown): value is Values[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function requireObject(value: unknown, reason: string): JsonObject {
  if (!isObject(value)) throw new Error(reason);
  return value;
}

export function parseModelProviderRegistry(value: unknown): ModelProviderRegistry {
  const registry = requireObject(value, "model_provider_registry_invalid");
  if (typeof registry.version !== "string" || !Array.isArray(registry.providers)) {
    throw new Error("model_provider_registry_invalid");
  }
  const providers = registry.providers.map((entry) => {
    const record = requireObject(entry, "model_provider_record_invalid");
    if (
      typeof record.provider !== "string" ||
      !isLiteralValue(MODEL_PROVIDER_PROTOCOLS, record.protocol) ||
      !(typeof record.apiKeyEnv === "string" || record.apiKeyEnv === null) ||
      !(typeof record.baseUrlEnv === "string" || record.baseUrlEnv === null) ||
      !(typeof record.defaultBaseUrl === "string" || record.defaultBaseUrl === null) ||
      !(typeof record.chatCompletionsPath === "string" || record.chatCompletionsPath === null) ||
      !isStringArray(record.requiredEnv) ||
      record.requestBodyReturned !== false ||
      (record.rawSecretsReturned !== undefined && record.rawSecretsReturned !== false)
    ) {
      throw new Error(`model_provider_record_invalid:${String(record.provider ?? "unknown")}`);
    }
    if (record.allowedModels !== undefined && !isStringArray(record.allowedModels)) {
      throw new Error(`model_provider_allowed_models_invalid:${record.provider}`);
    }
    return record as unknown as ModelProviderRecord;
  });
  if (new Set(providers.map((record) => record.provider.toLowerCase())).size !== providers.length) {
    throw new Error("model_provider_registry_duplicate_provider");
  }
  return { version: registry.version, providers };
}

export function isModelRouteSelection(value: unknown, provider?: string, model?: string): value is ModelRouteSelection {
  if (!isObject(value) || value.status !== "selected") return false;
  const selected = isObject(value.selected)
    ? value.selected
    : isObject(value.modelRoute) && isObject(value.modelRoute.selected)
      ? value.modelRoute.selected
      : null;
  if (!selected || typeof selected.provider !== "string" || typeof selected.model !== "string") return false;
  return (provider === undefined || selected.provider === provider) && (model === undefined || selected.model === model);
}

export function assertModelGenerationResult(value: unknown): ModelGenerationResult {
  const result = requireObject(value, "model_generation_result_invalid");
  if (!isLiteralValue(MODEL_GENERATION_STATUSES, result.status)) throw new Error("model_generation_status_invalid");
  if (typeof result.provider !== "string" || typeof result.model !== "string") throw new Error("model_generation_identity_invalid");
  if (result.rawSecretsReturned !== false || result.requestBodyReturned !== false) throw new Error("model_generation_secret_contract_invalid");
  if (result.status === "completed") {
    if (typeof result.content !== "string" || result.content.length === 0) throw new Error("model_generation_content_invalid");
  } else if (typeof result.reason !== "string" || result.reason.length === 0) {
    throw new Error("model_generation_block_reason_invalid");
  }
  return result as unknown as ModelGenerationResult;
}

export function assertCloudAsrSummary(value: unknown): CloudAsrSummary {
  const summary = requireObject(value, "cloud_asr_summary_invalid");
  if (!isLiteralValue(CLOUD_ASR_SUMMARY_STATUSES, summary.status)) throw new Error("cloud_asr_summary_status_invalid");
  if (summary.provider !== "aliyun_dashscope_paraformer") throw new Error("cloud_asr_summary_provider_invalid");
  if (typeof summary.meetingId !== "string" || typeof summary.model !== "string") throw new Error("cloud_asr_summary_identity_invalid");
  if (!Array.isArray(summary.inputModes) || !summary.inputModes.every((mode) => isLiteralValue(CLOUD_ASR_INPUT_MODES, mode))) {
    throw new Error("cloud_asr_summary_input_modes_invalid");
  }
  for (const field of ["sourceCount", "transcriptSegments", "failedChunks"] as const) {
    if (!Number.isInteger(summary[field]) || Number(summary[field]) < 0) throw new Error(`cloud_asr_summary_${field}_invalid`);
  }
  if (typeof summary.partial !== "boolean" || typeof summary.rawMediaExternalUpload !== "boolean" || !isObject(summary.outputs)) {
    throw new Error("cloud_asr_summary_shape_invalid");
  }
  const shouldBeComplete = Number(summary.failedChunks) === 0 && Number(summary.transcriptSegments) > 0 && summary.partial === false;
  if ((summary.status === "complete") !== shouldBeComplete) throw new Error("cloud_asr_summary_completeness_conflict");
  return summary as unknown as CloudAsrSummary;
}

export function assertFeishuEvent(value: unknown): FeishuEvent {
  const event = requireObject(value, "feishu_event_invalid");
  const message = requireObject(event.message, "feishu_event_message_invalid");
  if (
    event.schemaVersion !== "feishu-event-v1" ||
    typeof event.eventId !== "string" || event.eventId.length === 0 ||
    typeof event.eventType !== "string" ||
    typeof event.receivedAt !== "string" ||
    typeof message.messageId !== "string" ||
    typeof message.chatId !== "string" ||
    typeof message.msgType !== "string" ||
    event.rawSecretsReturned !== false
  ) {
    throw new Error("feishu_event_contract_invalid");
  }
  if (event.source !== undefined && !isLiteralValue(FEISHU_EVENT_SOURCES, event.source)) throw new Error("feishu_event_source_invalid");
  return event as unknown as FeishuEvent;
}

export function assertFeishuTask(value: unknown): FeishuTask {
  const task = requireObject(value, "feishu_task_invalid");
  const intent = requireObject(task.taskIntent, "feishu_task_intent_invalid");
  if (
    task.schemaVersion !== "feishu-task-v1" ||
    typeof task.runId !== "string" || task.runId.length === 0 ||
    !isTaskRunStatus(task.status) ||
    !isTaskExecutionProfile(intent.executionProfile) ||
    !isTaskReasoningDepth(intent.reasoningDepth) ||
    task.rawSecretsReturned !== false
  ) {
    throw new Error("feishu_task_contract_invalid");
  }
  assertFeishuEvent(task.sourceEvent);
  return task as unknown as FeishuTask;
}

export function assertFeishuRunState(value: unknown): FeishuRunState {
  const state = requireObject(value, "feishu_run_state_invalid");
  if (
    state.schemaVersion !== "feishu-run-state-v1" ||
    typeof state.runId !== "string" || state.runId.length === 0 ||
    !isTaskRunStatus(state.status) ||
    typeof state.updatedAt !== "string" ||
    !Array.isArray(state.steps) ||
    state.rawSecretsReturned !== false
  ) {
    throw new Error("feishu_run_state_contract_invalid");
  }
  for (const entry of state.steps) {
    const step = requireObject(entry, "feishu_run_state_step_invalid");
    if (typeof step.name !== "string" || !isTaskRunStepStatus(step.status) || typeof step.at !== "string") {
      throw new Error(`feishu_run_state_step_invalid:${String(step.name ?? "unknown")}`);
    }
  }
  return state as unknown as FeishuRunState;
}

export function isRuntimeStoreResultStatus(value: unknown): value is RuntimeStoreResultStatus {
  return isLiteralValue(RUNTIME_STORE_RESULT_STATUSES, value);
}
