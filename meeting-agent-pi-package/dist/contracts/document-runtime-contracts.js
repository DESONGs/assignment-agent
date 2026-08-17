import { Type } from "typebox";
import { compileContractParser } from "./contract-validation.js";
export const DOCUMENT_WORKER_STATUSES = ["completed", "needs_fix", "blocked"];
export const DOCUMENT_CHECKPOINT_STATUSES = ["running", "completed", "needs_fix", "blocked", "failed"];
export const DOCUMENT_UNIT_STATUSES = ["completed", "failed"];
export const DOCUMENT_CHECKPOINT_SCHEMA_VERSION = "document-workflow-checkpoint-v2";
const UnknownObject = Type.Record(Type.String(), Type.Unknown());
export const DocumentWorkUnitSchema = Type.Object({
    workUnitId: Type.String({ minLength: 1 }),
    docType: Type.String({ minLength: 1 }),
    sections: Type.Array(Type.String({ minLength: 1 })),
    contextPackRef: Type.String({ minLength: 1 }),
    contextPackId: Type.Optional(Type.String({ minLength: 1 })),
    contextPackHash: Type.Optional(Type.String({ minLength: 1 })),
    sourceSegmentIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    sourceBlockIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    tableBlockCount: Type.Optional(Type.Integer({ minimum: 0 })),
    promptBudgetChars: Type.Optional(Type.Integer({ minimum: 1 })),
    evidenceBudgetChars: Type.Optional(Type.Integer({ minimum: 1 })),
    retrievalReasons: Type.Optional(Type.Array(Type.String())),
    outputContractVersion: Type.Optional(Type.String()),
    documentIdentityConfidence: Type.Optional(Type.Enum(["high", "medium", "low"])),
    taskStateRef: Type.Optional(Type.String()),
    sourceRecordsRef: Type.Optional(Type.String()),
    sourceSegmentsRef: Type.Optional(Type.String()),
    sourceStructureRef: Type.Optional(Type.String()),
}, { additionalProperties: false });
export const DocumentWorkItemSchema = Type.Object({
    docType: Type.String({ minLength: 1 }),
    promptFile: Type.Optional(Type.String()),
    promptPath: Type.Optional(Type.String()),
    promptInstructions: Type.Optional(Type.String()),
    promptInstructionChars: Type.Optional(Type.Integer({ minimum: 0 })),
    contextPlane: Type.Optional(Type.Union([UnknownObject, Type.Null()])),
    workUnits: Type.Array(DocumentWorkUnitSchema, { minItems: 1 }),
    upstreamDependencyContext: Type.Optional(Type.Unknown()),
    requiredSections: Type.Array(Type.String({ minLength: 1 })),
    dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    audience: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    upstreamDocumentsUsed: Type.Optional(Type.Array(Type.String())),
    missingUpstreamDocuments: Type.Optional(Type.Array(Type.String())),
    absentUpstreamDocuments: Type.Optional(Type.Array(Type.String())),
}, { additionalProperties: false });
export const DocumentCheckpointUnitSchema = Type.Object({
    status: Type.Enum(DOCUMENT_UNIT_STATUSES),
    stage: Type.String({ minLength: 1 }),
    sections: Type.Array(Type.String()),
    batchIndex: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Literal("full")])),
    repairIndex: Type.Optional(Type.Integer({ minimum: 0 })),
    repairRound: Type.Optional(Type.Integer({ minimum: 0 })),
    artifactPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    artifactRelativePath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    artifactHash: Type.Optional(Type.Union([Type.String({ minLength: 64, maxLength: 64 }), Type.Null()])),
    idempotencyKey: Type.String({ minLength: 64, maxLength: 64 }),
    contextPackHash: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    provider: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    workUnitId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    contextPackId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    reason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    retryCount: Type.Optional(Type.Integer({ minimum: 0 })),
    attempts: Type.Optional(Type.Integer({ minimum: 1 })),
    retryExhausted: Type.Optional(Type.Boolean()),
    retryBudgetExhausted: Type.Optional(Type.Boolean()),
    lastProviderAttempt: Type.Optional(Type.Union([UnknownObject, Type.Null()])),
    updatedAt: Type.String({ minLength: 1 }),
}, { additionalProperties: true });
export const DocumentCheckpointArtifactSchema = Type.Object({
    status: Type.String({ minLength: 1 }),
    artifactPath: Type.String({ minLength: 1 }),
    artifactRelativePath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    artifactHash: Type.Optional(Type.String({ minLength: 64, maxLength: 64 })),
    contentChars: Type.Optional(Type.Integer({ minimum: 0 })),
    missingSections: Type.Optional(Type.Array(Type.String())),
    updatedAt: Type.String({ minLength: 1 }),
}, { additionalProperties: true });
export const DocumentCheckpointDocumentSchema = Type.Object({
    taskIndex: Type.Integer({ minimum: 0 }),
    docType: Type.String({ minLength: 1 }),
    promptFile: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    dependsOn: Type.Optional(Type.Array(Type.String())),
    status: Type.Enum(DOCUMENT_CHECKPOINT_STATUSES),
    createdAt: Type.String({ minLength: 1 }),
    updatedAt: Type.String({ minLength: 1 }),
    sections: Type.Record(Type.String(), DocumentCheckpointUnitSchema),
    repairs: Type.Record(Type.String(), DocumentCheckpointUnitSchema),
    blueprint: Type.Optional(Type.Union([DocumentCheckpointArtifactSchema, Type.Null()])),
    assembly: Type.Optional(Type.Union([DocumentCheckpointArtifactSchema, Type.Null()])),
    review: Type.Optional(Type.Union([DocumentCheckpointArtifactSchema, Type.Null()])),
    completedSections: Type.Array(Type.String()),
    missingSections: Type.Array(Type.String()),
    reason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
}, { additionalProperties: true });
export const DocumentWorkflowCheckpointSchema = Type.Object({
    schemaVersion: Type.Literal(DOCUMENT_CHECKPOINT_SCHEMA_VERSION),
    runId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    inputHash: Type.String({ minLength: 64, maxLength: 64 }),
    createdAt: Type.String({ minLength: 1 }),
    updatedAt: Type.String({ minLength: 1 }),
    workflowStrategy: Type.Enum(["checkpointed", "single_pass"]),
    qualityMode: Type.Enum(["stable", "balanced", "fast"]),
    publishPartial: Type.Literal(false),
    retry: Type.Object({ unitsUsed: Type.Integer({ minimum: 0 }) }, { additionalProperties: true }),
    docs: Type.Record(Type.String(), DocumentCheckpointDocumentSchema),
    rawSecretsReturned: Type.Literal(false),
}, {
    $id: "https://meeting-agent.local/schemas/document-workflow-checkpoint.schema.json",
    title: "Document Workflow Checkpoint",
    additionalProperties: true,
});
export const DocumentWorkerResultSchema = Type.Object({
    taskIndex: Type.Integer({ minimum: 0 }),
    docType: Type.String({ minLength: 1 }),
    title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    promptFile: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    status: Type.Enum(DOCUMENT_WORKER_STATUSES),
    reason: Type.Union([Type.String(), Type.Null()]),
    markdown: Type.Optional(Type.String()),
    completedSections: Type.Optional(Type.Array(Type.String())),
    missingSections: Type.Optional(Type.Array(Type.String())),
    sectionAttempts: Type.Optional(Type.Array(UnknownObject)),
    repairAttempts: Type.Optional(Type.Array(UnknownObject)),
    qaInput: Type.Optional(UnknownObject),
    dependsOn: Type.Optional(Type.Array(Type.String())),
    upstreamDocumentsUsed: Type.Optional(Type.Array(Type.String())),
    missingUpstreamDocuments: Type.Optional(Type.Array(Type.String())),
    absentUpstreamDocuments: Type.Optional(Type.Array(Type.String())),
    modelRoute: Type.Optional(Type.Union([UnknownObject, Type.Null()])),
    sectionBatches: Type.Optional(Type.Array(UnknownObject)),
    attemptFailures: Type.Optional(Type.Array(UnknownObject)),
    rawSecretsReturned: Type.Literal(false),
}, { additionalProperties: true });
export const parseDocumentWorkItem = compileContractParser(DocumentWorkItemSchema, {
    reason: "document_work_item_contract_invalid",
    recovery: "由 source_context_prepare 和 prompt registry 重新生成 document work item。",
});
export const parseDocumentWorkflowCheckpoint = compileContractParser(DocumentWorkflowCheckpointSchema, {
    reason: "document_workflow_checkpoint_invalid",
    recovery: "保留旧 checkpoint 诊断副本并创建新的 v2 checkpoint。",
});
export const parseDocumentWorkerResult = compileContractParser(DocumentWorkerResultSchema, {
    reason: "document_worker_result_contract_invalid",
    recovery: "阻断当前文档结果并从最近有效 checkpoint 重新运行。",
});
//# sourceMappingURL=document-runtime-contracts.js.map