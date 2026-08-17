import { Type, type Static } from "typebox";
import { compileContractParser } from "./contract-validation.js";

export const QA_PROFILES = ["source_pack", "meeting_minutes", "office_document", "document_revision"] as const;
export const QA_GATE_STATUSES = ["pass", "needs_fix", "blocked"] as const;
export const QA_ISSUE_SEVERITIES = ["info", "warning", "needs_fix", "blocking"] as const;
export const QA_GATE_SCHEMA_VERSION = "qa-gate-v2" as const;

const UnknownObject = Type.Record(Type.String(), Type.Unknown());
const UnknownArray = Type.Array(Type.Unknown());

export const QaProfileSchema = Type.Enum(QA_PROFILES);
export const QaSecurityCheckSchema = Type.Object({
  rawSecretsReturned: Type.Boolean(),
  secretsLeaked: Type.Boolean(),
}, { additionalProperties: true });

export const QaSourcePackCheckSchema = Type.Object({
  required: Type.Literal(true),
  completeTranscriptAvailable: Type.Boolean(),
  failedChapterCount: Type.Integer({ minimum: 0 }),
  allClaimsHaveEvidence: Type.Boolean(),
  partialResultsPublished: Type.Boolean(),
  qualityDisclosureRequired: Type.Boolean(),
  qualityDisclosed: Type.Boolean(),
  provenancePath: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: true });

export const QaDocumentOutputSchema = Type.Object({
  docType: Type.String({ minLength: 1 }),
  markdown: Type.String(),
  status: Type.Optional(Type.Enum(["completed", "needs_fix", "blocked"] as const)),
  requiredSections: Type.Optional(Type.Array(Type.String())),
  missingSections: Type.Optional(Type.Array(Type.String())),
  unsupportedClaims: Type.Optional(UnknownArray),
  openQuestions: Type.Optional(UnknownArray),
}, { additionalProperties: true });

export const QaChecksSchema = Type.Object({
  security: QaSecurityCheckSchema,
  privacy: Type.Optional(QaSecurityCheckSchema),
  evidence: Type.Optional(UnknownObject),
  topicCoverage: Type.Optional(UnknownObject),
  entitySafety: Type.Optional(UnknownObject),
  asrEvidence: Type.Optional(UnknownObject),
  titleSync: Type.Optional(UnknownObject),
  feishuReadiness: Type.Optional(UnknownObject),
  webAccess: Type.Optional(UnknownObject),
  contextBudget: Type.Optional(UnknownObject),
  sourcePack: Type.Optional(QaSourcePackCheckSchema),
  reviewContext: Type.Optional(Type.Union([UnknownObject, Type.Null()])),
  documentOutputs: Type.Optional(Type.Array(QaDocumentOutputSchema)),
  documents: Type.Optional(Type.Array(QaDocumentOutputSchema)),
  sourceStructureSummary: Type.Optional(UnknownObject),
  documentIdentity: Type.Optional(Type.Union([UnknownObject, Type.Null()])),
  outputContract: Type.Optional(Type.Union([UnknownObject, Type.Null()])),
  issues: Type.Optional(UnknownArray),
}, { additionalProperties: true });

export const QaEvaluationInputSchema = Type.Object({
  profile: QaProfileSchema,
  checks: QaChecksSchema,
  publishIntent: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export const QaIssueSchema = Type.Object({
  code: Type.String({ minLength: 1 }),
  severity: Type.Enum(QA_ISSUE_SEVERITIES),
  message: Type.String({ minLength: 1 }),
  suggestedFix: Type.Optional(Type.String()),
  evidence: Type.Optional(Type.Unknown()),
  artifactType: Type.Optional(Type.String()),
  priority: Type.Optional(Type.Enum(["primary", "follow_up", "optional"] as const)),
  blocksDelivery: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export const QaGateResultSchema = Type.Object({
  schemaVersion: Type.Literal(QA_GATE_SCHEMA_VERSION),
  evaluationId: Type.String({ minLength: 1 }),
  inputHash: Type.String({ minLength: 64, maxLength: 64 }),
  profile: QaProfileSchema,
  publishIntent: Type.Boolean(),
  status: Type.Enum(QA_GATE_STATUSES),
  reason: Type.Union([Type.String(), Type.Null()]),
  fieldPath: Type.Optional(Type.String()),
  recovery: Type.Optional(Type.String()),
  primaryDeliveryStatus: Type.Enum(["ready", "needs_fix", "blocked"] as const),
  followUpDeliveryStatus: Type.Enum(["pass", "needs_fix", "blocked", "not_applicable"] as const),
  overallStatus: Type.Enum(["ready", "partial_ready", "blocked"] as const),
  publishAllowed: Type.Boolean(),
  evaluatedAt: Type.String({ minLength: 1 }),
  artifacts: Type.Array(UnknownObject),
  checks: QaChecksSchema,
  issues: Type.Array(QaIssueSchema),
  rawSecretsReturned: Type.Literal(false),
}, {
  $id: "https://meeting-agent.local/schemas/qa-gate.schema.json",
  title: "Assignment Agent QA Gate",
  additionalProperties: false,
});

export type QaProfile = Static<typeof QaProfileSchema>;
export type QaChecks = Static<typeof QaChecksSchema>;
export type QaEvaluationInput = Static<typeof QaEvaluationInputSchema>;
export type QaIssue = Static<typeof QaIssueSchema>;
export type QaGateResult = Static<typeof QaGateResultSchema>;

export const parseQaEvaluationInput = compileContractParser(QaEvaluationInputSchema, {
  reason: "qa_checks_contract_invalid",
  recovery: "按当前 QA profile 补齐必检项后重新评估。",
});

export const parseQaGateResult = compileContractParser(QaGateResultSchema, {
  reason: "qa_gate_result_contract_invalid",
  recovery: "重新运行 qa_gate_evaluate，禁止写入手工构造的 pass 结果。",
});

export function qaProfileRequirementFailure(input: QaEvaluationInput): { fieldPath: string; reason: string; recovery: string } | null {
  if (input.profile === "source_pack" && input.checks.sourcePack === undefined) {
    return {
      fieldPath: "checks.sourcePack",
      reason: "qa_source_pack_checks_required",
      recovery: "补齐转写完整性、章节、provenance 与质量披露检查。",
    };
  }
  if ((input.profile === "meeting_minutes" || input.profile === "office_document") && !input.checks.documentOutputs?.length) {
    return {
      fieldPath: "checks.documentOutputs",
      reason: "qa_document_outputs_required",
      recovery: "提供待验收文档及其 requiredSections、证据和状态。",
    };
  }
  if (input.profile === "meeting_minutes" && (input.checks.topicCoverage === undefined || input.checks.entitySafety === undefined || input.checks.asrEvidence === undefined)) {
    return {
      fieldPath: "checks.topicCoverage",
      reason: "qa_meeting_intelligence_checks_required",
      recovery: "补齐议题覆盖、实体安全和 ASR 证据检查。",
    };
  }
  if (input.profile === "document_revision" && (!input.checks.documentOutputs?.length || input.checks.reviewContext === undefined || input.checks.reviewContext === null)) {
    return {
      fieldPath: "checks.reviewContext",
      reason: "qa_document_revision_checks_required",
      recovery: "补齐 review context 和待验收修订文档。",
    };
  }
  return null;
}
