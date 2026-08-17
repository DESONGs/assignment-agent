import { Type } from "typebox";
import { ContractValidationError, compileContractParser } from "./contract-validation.js";
export const SOURCE_CONTEXT_SCHEMA_VERSION = "source-context-v3/context-manifest";
export const SOURCE_CONTEXT_GATE_STATUSES = ["pass", "needs_fix", "blocked"];
const StringOrNumberOrNull = Type.Union([Type.String(), Type.Number(), Type.Null()]);
const UnknownObject = Type.Record(Type.String(), Type.Unknown());
const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const SourceRecordSchema = Type.Object({
    sourceId: Type.String({ minLength: 1 }),
    sourceType: Type.String({ minLength: 1 }),
    title: Type.String(),
    artifactPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    extractedTextPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    status: Type.String({ minLength: 1 }),
    extractionQuality: Type.Enum(["ready", "partial", "low", "missing"]),
    privacyClass: Type.String({ minLength: 1 }),
    metadata: UnknownObject,
}, { additionalProperties: false });
export const SourceRecordsArtifactSchema = Type.Object({
    schemaVersion: Type.Literal("source-context-v3/source-records"),
    generatedAt: Type.String({ minLength: 1 }),
    sourceCount: Type.Integer({ minimum: 1 }),
    sources: Type.Array(SourceRecordSchema, { minItems: 1 }),
    rawSecretsReturned: Type.Literal(false),
    rawMediaExternalUpload: Type.Literal(false),
}, { additionalProperties: false });
export const SourceSegmentSchema = Type.Object({
    segmentId: Type.String({ minLength: 1 }),
    sourceId: Type.String({ minLength: 1 }),
    sourceType: Type.String({ minLength: 1 }),
    title: Type.String(),
    text: Type.String({ minLength: 1, maxLength: 24_000 }),
    segmentKind: Type.Optional(Type.Enum(["text", "table", "mixed"])),
    charStart: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    charEnd: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    heading: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    page: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    sheet: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    startSec: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
    endSec: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
    speakerId: Type.Optional(StringOrNumberOrNull),
    speakerLabel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    channelId: Type.Optional(StringOrNumberOrNull),
    quality: Type.String({ minLength: 1 }),
    metadata: UnknownObject,
}, { additionalProperties: true });
export const SourceContextGateResultSchema = Type.Object({
    schemaVersion: Type.Literal("context-gate-result-v1"),
    status: Type.Enum(SOURCE_CONTEXT_GATE_STATUSES),
    reason: Type.String({ minLength: 1 }),
    warnings: Type.Array(Type.String()),
    missingOrStaleInputs: Type.Array(Type.String()),
    fieldPath: Type.Optional(Type.String()),
    recovery: Type.Optional(Type.String()),
    rawSecretsReturned: Type.Literal(false),
    rawMediaExternalUpload: Type.Literal(false),
}, { additionalProperties: false });
export const SourceContextWorkUnitSchema = Type.Object({
    workUnitId: Type.String({ minLength: 1 }),
    docType: Type.String({ minLength: 1 }),
    sections: Type.Array(Type.String({ minLength: 1 })),
    contextPackRef: Type.String({ minLength: 1 }),
    contextPackId: Type.String({ minLength: 1 }),
    contextPackHash: Type.String({ minLength: 1 }),
    sourceSegmentIds: Type.Array(Type.String({ minLength: 1 })),
    sourceBlockIds: Type.Array(Type.String({ minLength: 1 })),
    tableBlockCount: Type.Integer({ minimum: 0 }),
    promptBudgetChars: Type.Integer({ minimum: 1, maximum: 24_000 }),
    evidenceBudgetChars: Type.Integer({ minimum: 1, maximum: 12_000 }),
    retrievalReasons: Type.Array(Type.String()),
    outputContractVersion: Type.Literal("document-output-contract-v1"),
    documentIdentityConfidence: Type.Enum(["high", "medium", "low"]),
    taskStateRef: Type.String({ minLength: 1 }),
    sourceRecordsRef: Type.String({ minLength: 1 }),
    sourceSegmentsRef: Type.String({ minLength: 1 }),
    sourceStructureRef: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
export const ContextPackSchema = Type.Object({
    schemaVersion: Type.Literal("context-pack-v2"),
    contextPackId: Type.String({ minLength: 1 }),
    workUnitId: Type.String({ minLength: 1 }),
    docType: Type.String({ minLength: 1 }),
    sections: Type.Array(Type.String({ minLength: 1 })),
    operation: Type.String({ minLength: 1 }),
    promptBudgetChars: Type.Integer({ minimum: 1, maximum: 24_000 }),
    evidenceBudgetChars: Type.Integer({ minimum: 1, maximum: 12_000 }),
    sourceSegmentIds: Type.Array(Type.String({ minLength: 1 })),
    sourceBlockIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    tableBlockCount: Type.Optional(Type.Integer({ minimum: 0 })),
    retrievalReasons: Type.Array(Type.String()),
    selectedSegments: Type.Optional(Type.Array(SourceSegmentSchema)),
    selectedSourceBlocks: Type.Optional(Type.Array(UnknownObject)),
    taskState: Type.Optional(UnknownObject),
    artifactIndex: Type.Optional(UnknownObject),
    documentIdentity: Type.Optional(UnknownObject),
    outputContract: Type.Optional(UnknownObject),
    modelContext: Type.String(),
    rawSecretsReturned: Type.Literal(false),
    rawMediaExternalUpload: Type.Literal(false),
}, { additionalProperties: true });
export const SourceContextManifestSchema = Type.Object({
    schemaVersion: Type.Literal(SOURCE_CONTEXT_SCHEMA_VERSION),
    generatedAt: Type.String({ minLength: 1 }),
    contextPlane: Type.Literal("runtime-context-plane-v1"),
    runId: Type.String({ minLength: 1 }),
    operation: Type.String({ minLength: 1 }),
    requestedDocuments: Type.Array(Type.String({ minLength: 1 })),
    sourceRecordsPath: Type.String({ minLength: 1 }),
    sourceSegmentsPath: Type.String({ minLength: 1 }),
    sourceStructurePath: Type.String({ minLength: 1 }),
    taskStatePath: Type.String({ minLength: 1 }),
    retrievalPlanPath: Type.String({ minLength: 1 }),
    gatePath: Type.String({ minLength: 1 }),
    sourceCount: Type.Integer({ minimum: 0 }),
    segmentCount: Type.Integer({ minimum: 0 }),
    sourceStructureSummary: Type.Object({
        blockCount: Type.Integer({ minimum: 0 }),
        headingCount: Type.Integer({ minimum: 0 }),
        tableBlockCount: Type.Integer({ minimum: 0 }),
        rawHtmlTableCount: Type.Integer({ minimum: 0 }),
        markdownTableCount: Type.Integer({ minimum: 0 }),
        commentAnchorCount: Type.Integer({ minimum: 0 }),
    }, { additionalProperties: false }),
    documentIdentity: UnknownObject,
    meetingIntelligence: Type.Union([UnknownObject, Type.Null()]),
    outputContract: UnknownObject,
    workUnitCount: Type.Integer({ minimum: 0 }),
    contextPackCount: Type.Integer({ minimum: 0 }),
    artifactHashes: Type.Object({
        sourceRecords: Sha256Schema,
        sourceSegments: Sha256Schema,
        sourceStructure: Sha256Schema,
        retrievalPlan: Sha256Schema,
        gate: Sha256Schema,
    }, { additionalProperties: false }),
    sourceSetMode: Type.String({ minLength: 1 }),
    conflictPolicy: Type.String({ minLength: 1 }),
    budgetPolicy: Type.Object({
        sectionPromptHardCapChars: Type.Integer({ minimum: 1 }),
        evidenceHardCapChars: Type.Integer({ minimum: 1 }),
        segmentTargetChars: Type.Integer({ minimum: 1 }),
        segmentMaxChars: Type.Integer({ minimum: 1 }),
        deterministicRetrieval: Type.Literal(true),
        vectorStoreUsed: Type.Literal(false),
        contextStrategy: Type.Literal("hierarchical_control_plane_and_work_unit_data_plane"),
        repeatedFullTranscriptInjection: Type.Literal(false),
    }, { additionalProperties: false }),
    workUnits: Type.Array(SourceContextWorkUnitSchema),
    gate: SourceContextGateResultSchema,
    rawSecretsReturned: Type.Literal(false),
    rawMediaExternalUpload: Type.Literal(false),
    fullContentAvailableByArtifact: Type.Literal(true),
}, {
    $id: "https://meeting-agent.local/schemas/source-context.schema.json",
    title: "Runtime Source Context Plane",
    additionalProperties: false,
});
export const parseSourceSegment = compileContractParser(SourceSegmentSchema, {
    reason: "source_segment_contract_invalid",
    recovery: "重新解析来源并生成包含稳定 segmentId、sourceId、文本和质量信息的 segment。",
});
export const parseSourceRecordsArtifact = compileContractParser(SourceRecordsArtifactSchema, {
    reason: "source_records_contract_invalid",
    recovery: "重新运行 source_context_prepare，生成具有唯一 sourceId 的来源清单。",
});
export function parseSourceSegments(value) {
    if (!Array.isArray(value)) {
        throw new ContractValidationError({
            reason: "source_segments_contract_invalid",
            fieldPath: "selectedSegments",
            recovery: "提供结构化来源 segment 数组。",
        });
    }
    const segments = value.map((segment, index) => {
        try {
            return parseSourceSegment(segment);
        }
        catch (error) {
            if (error instanceof ContractValidationError) {
                throw new ContractValidationError({ ...error, fieldPath: `selectedSegments[${index}]${error.fieldPath === "$" ? "" : error.fieldPath}` }, error.message);
            }
            throw error;
        }
    });
    const seen = new Set();
    for (const [index, segment] of segments.entries()) {
        if (seen.has(segment.segmentId)) {
            throw new ContractValidationError({
                reason: "source_segment_duplicate_id",
                fieldPath: `selectedSegments[${index}].segmentId`,
                recovery: "重新分配当前 source pack 内唯一的 segmentId。",
            });
        }
        seen.add(segment.segmentId);
        if (segment.charStart !== null && segment.charEnd !== null && segment.charEnd < segment.charStart) {
            throw new ContractValidationError({
                reason: "source_segment_character_range_invalid",
                fieldPath: `selectedSegments[${index}].charEnd`,
                recovery: "修正字符范围，使 charEnd 不小于 charStart。",
            });
        }
        if (segment.startSec !== undefined && segment.startSec !== null && segment.endSec !== undefined && segment.endSec !== null && segment.endSec < segment.startSec) {
            throw new ContractValidationError({
                reason: "source_segment_timestamp_range_invalid",
                fieldPath: `selectedSegments[${index}].endSec`,
                recovery: "修正时间戳，使 endSec 不小于 startSec。",
            });
        }
    }
    return segments;
}
export const parseContextPack = compileContractParser(ContextPackSchema, {
    reason: "context_pack_contract_invalid",
    recovery: "由 source_context_prepare 重新生成 context pack。",
});
export const parseSourceContextManifest = compileContractParser(SourceContextManifestSchema, {
    reason: "source_context_manifest_contract_invalid",
    recovery: "重新运行 source_context_prepare，禁止信任手工构造的 gate。",
});
export const parseSourceContextGateResult = compileContractParser(SourceContextGateResultSchema, {
    reason: "source_context_gate_contract_invalid",
    recovery: "重新计算 Source Context Gate。",
});
//# sourceMappingURL=source-context-contracts.js.map