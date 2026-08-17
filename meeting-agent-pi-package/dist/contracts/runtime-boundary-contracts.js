import { isTaskExecutionProfile, isTaskReasoningDepth, isTaskRunStatus, isTaskRunStepStatus, } from "./task-contracts.js";
export const RUNTIME_CONTRACT_SCHEMA_VERSION = "assignment-agent-runtime-contracts-v1";
export const MODEL_PROVIDER_PROTOCOLS = ["openai-chat-completions", "mock"];
export const MODEL_GENERATION_STATUSES = ["completed", "blocked"];
export const MODEL_ROUTE_STATUSES = ["selected", "blocked"];
export const CLOUD_ASR_SUMMARY_STATUSES = ["complete", "needs_review"];
export const CLOUD_ASR_INPUT_MODES = ["file", "realtime"];
export const FEISHU_EVENT_SOURCES = [
    "lark-cli-event-consume",
    "sdk-gateway",
    "sdk-long-connection",
    "fixture",
    "stdin",
    "handler-direct",
];
export const RUNTIME_STORE_SCHEMA_VERSION = "runtime-store-v1";
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
];
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isLiteralValue(values, value) {
    return typeof value === "string" && values.includes(value);
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function requireObject(value, reason) {
    if (!isObject(value))
        throw new Error(reason);
    return value;
}
export function parseModelProviderRegistry(value) {
    const registry = requireObject(value, "model_provider_registry_invalid");
    if (typeof registry.version !== "string" || !Array.isArray(registry.providers)) {
        throw new Error("model_provider_registry_invalid");
    }
    const providers = registry.providers.map((entry) => {
        const record = requireObject(entry, "model_provider_record_invalid");
        if (typeof record.provider !== "string" ||
            !isLiteralValue(MODEL_PROVIDER_PROTOCOLS, record.protocol) ||
            !(typeof record.apiKeyEnv === "string" || record.apiKeyEnv === null) ||
            !(typeof record.baseUrlEnv === "string" || record.baseUrlEnv === null) ||
            !(typeof record.defaultBaseUrl === "string" || record.defaultBaseUrl === null) ||
            !(typeof record.chatCompletionsPath === "string" || record.chatCompletionsPath === null) ||
            !isStringArray(record.requiredEnv) ||
            record.requestBodyReturned !== false ||
            (record.rawSecretsReturned !== undefined && record.rawSecretsReturned !== false)) {
            throw new Error(`model_provider_record_invalid:${String(record.provider ?? "unknown")}`);
        }
        if (record.allowedModels !== undefined && !isStringArray(record.allowedModels)) {
            throw new Error(`model_provider_allowed_models_invalid:${record.provider}`);
        }
        return record;
    });
    if (new Set(providers.map((record) => record.provider.toLowerCase())).size !== providers.length) {
        throw new Error("model_provider_registry_duplicate_provider");
    }
    return { version: registry.version, providers };
}
export function isModelRouteSelection(value, provider, model) {
    if (!isObject(value) || value.status !== "selected")
        return false;
    const selected = isObject(value.selected)
        ? value.selected
        : isObject(value.modelRoute) && isObject(value.modelRoute.selected)
            ? value.modelRoute.selected
            : null;
    if (!selected || typeof selected.provider !== "string" || typeof selected.model !== "string")
        return false;
    return (provider === undefined || selected.provider === provider) && (model === undefined || selected.model === model);
}
export function assertModelGenerationResult(value) {
    const result = requireObject(value, "model_generation_result_invalid");
    if (!isLiteralValue(MODEL_GENERATION_STATUSES, result.status))
        throw new Error("model_generation_status_invalid");
    if (typeof result.provider !== "string" || typeof result.model !== "string")
        throw new Error("model_generation_identity_invalid");
    if (result.rawSecretsReturned !== false || result.requestBodyReturned !== false)
        throw new Error("model_generation_secret_contract_invalid");
    if (result.status === "completed") {
        if (typeof result.content !== "string" || result.content.length === 0)
            throw new Error("model_generation_content_invalid");
    }
    else if (typeof result.reason !== "string" || result.reason.length === 0) {
        throw new Error("model_generation_block_reason_invalid");
    }
    return result;
}
export function assertCloudAsrSummary(value) {
    const summary = requireObject(value, "cloud_asr_summary_invalid");
    if (!isLiteralValue(CLOUD_ASR_SUMMARY_STATUSES, summary.status))
        throw new Error("cloud_asr_summary_status_invalid");
    if (summary.provider !== "aliyun_dashscope_paraformer")
        throw new Error("cloud_asr_summary_provider_invalid");
    if (typeof summary.meetingId !== "string" || typeof summary.model !== "string")
        throw new Error("cloud_asr_summary_identity_invalid");
    if (!Array.isArray(summary.inputModes) || !summary.inputModes.every((mode) => isLiteralValue(CLOUD_ASR_INPUT_MODES, mode))) {
        throw new Error("cloud_asr_summary_input_modes_invalid");
    }
    for (const field of ["sourceCount", "transcriptSegments", "failedChunks"]) {
        if (!Number.isInteger(summary[field]) || Number(summary[field]) < 0)
            throw new Error(`cloud_asr_summary_${field}_invalid`);
    }
    if (typeof summary.partial !== "boolean" || typeof summary.rawMediaExternalUpload !== "boolean" || !isObject(summary.outputs)) {
        throw new Error("cloud_asr_summary_shape_invalid");
    }
    const shouldBeComplete = Number(summary.failedChunks) === 0 && Number(summary.transcriptSegments) > 0 && summary.partial === false;
    if ((summary.status === "complete") !== shouldBeComplete)
        throw new Error("cloud_asr_summary_completeness_conflict");
    return summary;
}
export function assertFeishuEvent(value) {
    const event = requireObject(value, "feishu_event_invalid");
    const message = requireObject(event.message, "feishu_event_message_invalid");
    if (event.schemaVersion !== "feishu-event-v1" ||
        typeof event.eventId !== "string" || event.eventId.length === 0 ||
        typeof event.eventType !== "string" ||
        typeof event.receivedAt !== "string" ||
        typeof message.messageId !== "string" ||
        typeof message.chatId !== "string" ||
        typeof message.msgType !== "string" ||
        event.rawSecretsReturned !== false) {
        throw new Error("feishu_event_contract_invalid");
    }
    if (event.source !== undefined && !isLiteralValue(FEISHU_EVENT_SOURCES, event.source))
        throw new Error("feishu_event_source_invalid");
    return event;
}
export function assertFeishuTask(value) {
    const task = requireObject(value, "feishu_task_invalid");
    const intent = requireObject(task.taskIntent, "feishu_task_intent_invalid");
    if (task.schemaVersion !== "feishu-task-v1" ||
        typeof task.runId !== "string" || task.runId.length === 0 ||
        !isTaskRunStatus(task.status) ||
        !isTaskExecutionProfile(intent.executionProfile) ||
        !isTaskReasoningDepth(intent.reasoningDepth) ||
        task.rawSecretsReturned !== false) {
        throw new Error("feishu_task_contract_invalid");
    }
    assertFeishuEvent(task.sourceEvent);
    return task;
}
export function assertFeishuRunState(value) {
    const state = requireObject(value, "feishu_run_state_invalid");
    if (state.schemaVersion !== "feishu-run-state-v1" ||
        typeof state.runId !== "string" || state.runId.length === 0 ||
        !isTaskRunStatus(state.status) ||
        typeof state.updatedAt !== "string" ||
        !Array.isArray(state.steps) ||
        state.rawSecretsReturned !== false) {
        throw new Error("feishu_run_state_contract_invalid");
    }
    for (const entry of state.steps) {
        const step = requireObject(entry, "feishu_run_state_step_invalid");
        if (typeof step.name !== "string" || !isTaskRunStepStatus(step.status) || typeof step.at !== "string") {
            throw new Error(`feishu_run_state_step_invalid:${String(step.name ?? "unknown")}`);
        }
    }
    return state;
}
export function isRuntimeStoreResultStatus(value) {
    return isLiteralValue(RUNTIME_STORE_RESULT_STATUSES, value);
}
//# sourceMappingURL=runtime-boundary-contracts.js.map