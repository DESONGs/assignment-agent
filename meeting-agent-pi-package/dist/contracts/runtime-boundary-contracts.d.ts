import { type TaskIntent, type TaskRunStatus } from "./task-contracts.js";
export declare const RUNTIME_CONTRACT_SCHEMA_VERSION: "assignment-agent-runtime-contracts-v1";
export declare const MODEL_PROVIDER_PROTOCOLS: readonly ["openai-chat-completions", "mock"];
export declare const MODEL_GENERATION_STATUSES: readonly ["completed", "blocked"];
export declare const MODEL_ROUTE_STATUSES: readonly ["selected", "blocked"];
export declare const CLOUD_ASR_SUMMARY_STATUSES: readonly ["complete", "needs_review"];
export declare const CLOUD_ASR_INPUT_MODES: readonly ["file", "realtime"];
export declare const FEISHU_EVENT_SOURCES: readonly ["lark-cli-event-consume", "sdk-gateway", "sdk-long-connection", "fixture", "stdin", "handler-direct"];
export declare const RUNTIME_STORE_SCHEMA_VERSION: "runtime-store-v1";
export declare const RUNTIME_STORE_RESULT_STATUSES: readonly ["blocked", "clean", "completed", "deleted", "error", "failed", "found", "indexed", "initialized", "kept_shared_cas_object", "missing", "moved", "not_found", "pinned", "planned", "polluted", "quarantined", "stored", "unpinned", "would_move"];
export type JsonObject = {
    [key: string]: unknown;
};
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
    modelRoute?: {
        selected?: ModelRouteCandidate;
    };
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
export declare function parseModelProviderRegistry(value: unknown): ModelProviderRegistry;
export declare function isModelRouteSelection(value: unknown, provider?: string, model?: string): value is ModelRouteSelection;
export declare function assertModelGenerationResult(value: unknown): ModelGenerationResult;
export declare function assertCloudAsrSummary(value: unknown): CloudAsrSummary;
export declare function assertFeishuEvent(value: unknown): FeishuEvent;
export declare function assertFeishuTask(value: unknown): FeishuTask;
export declare function assertFeishuRunState(value: unknown): FeishuRunState;
export declare function isRuntimeStoreResultStatus(value: unknown): value is RuntimeStoreResultStatus;
//# sourceMappingURL=runtime-boundary-contracts.d.ts.map