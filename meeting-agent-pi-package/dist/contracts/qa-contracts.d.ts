import { Type, type Static } from "typebox";
export declare const QA_PROFILES: readonly ["source_pack", "meeting_minutes", "office_document", "document_revision"];
export declare const QA_GATE_STATUSES: readonly ["pass", "needs_fix", "blocked"];
export declare const QA_ISSUE_SEVERITIES: readonly ["info", "warning", "needs_fix", "blocking"];
export declare const QA_GATE_SCHEMA_VERSION: "qa-gate-v2";
export declare const QaProfileSchema: Type.TEnum<["source_pack", "meeting_minutes", "office_document", "document_revision"]>;
export declare const QaSecurityCheckSchema: Type.TObject<{
    rawSecretsReturned: Type.TBoolean;
    secretsLeaked: Type.TBoolean;
}>;
export declare const QaSourcePackCheckSchema: Type.TObject<{
    required: Type.TLiteral<true>;
    completeTranscriptAvailable: Type.TBoolean;
    failedChapterCount: Type.TInteger;
    allClaimsHaveEvidence: Type.TBoolean;
    partialResultsPublished: Type.TBoolean;
    qualityDisclosureRequired: Type.TBoolean;
    qualityDisclosed: Type.TBoolean;
    provenancePath: Type.TUnion<[Type.TString, Type.TNull]>;
}>;
export declare const QaDocumentOutputSchema: Type.TObject<{
    docType: Type.TString;
    markdown: Type.TString;
    status: Type.TOptional<Type.TEnum<["completed", "needs_fix", "blocked"]>>;
    requiredSections: Type.TOptional<Type.TArray<Type.TString>>;
    missingSections: Type.TOptional<Type.TArray<Type.TString>>;
    unsupportedClaims: Type.TOptional<Type.TArray<Type.TUnknown>>;
    openQuestions: Type.TOptional<Type.TArray<Type.TUnknown>>;
}>;
export declare const QaChecksSchema: Type.TObject<{
    security: Type.TObject<{
        rawSecretsReturned: Type.TBoolean;
        secretsLeaked: Type.TBoolean;
    }>;
    privacy: Type.TOptional<Type.TObject<{
        rawSecretsReturned: Type.TBoolean;
        secretsLeaked: Type.TBoolean;
    }>>;
    evidence: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
    topicCoverage: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
    entitySafety: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
    asrEvidence: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
    titleSync: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
    feishuReadiness: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
    webAccess: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
    contextBudget: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
    sourcePack: Type.TOptional<Type.TObject<{
        required: Type.TLiteral<true>;
        completeTranscriptAvailable: Type.TBoolean;
        failedChapterCount: Type.TInteger;
        allClaimsHaveEvidence: Type.TBoolean;
        partialResultsPublished: Type.TBoolean;
        qualityDisclosureRequired: Type.TBoolean;
        qualityDisclosed: Type.TBoolean;
        provenancePath: Type.TUnion<[Type.TString, Type.TNull]>;
    }>>;
    reviewContext: Type.TOptional<Type.TUnion<[Type.TRecord<"^.*$", Type.TUnknown>, Type.TNull]>>;
    documentOutputs: Type.TOptional<Type.TArray<Type.TObject<{
        docType: Type.TString;
        markdown: Type.TString;
        status: Type.TOptional<Type.TEnum<["completed", "needs_fix", "blocked"]>>;
        requiredSections: Type.TOptional<Type.TArray<Type.TString>>;
        missingSections: Type.TOptional<Type.TArray<Type.TString>>;
        unsupportedClaims: Type.TOptional<Type.TArray<Type.TUnknown>>;
        openQuestions: Type.TOptional<Type.TArray<Type.TUnknown>>;
    }>>>;
    documents: Type.TOptional<Type.TArray<Type.TObject<{
        docType: Type.TString;
        markdown: Type.TString;
        status: Type.TOptional<Type.TEnum<["completed", "needs_fix", "blocked"]>>;
        requiredSections: Type.TOptional<Type.TArray<Type.TString>>;
        missingSections: Type.TOptional<Type.TArray<Type.TString>>;
        unsupportedClaims: Type.TOptional<Type.TArray<Type.TUnknown>>;
        openQuestions: Type.TOptional<Type.TArray<Type.TUnknown>>;
    }>>>;
    sourceStructureSummary: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
    documentIdentity: Type.TOptional<Type.TUnion<[Type.TRecord<"^.*$", Type.TUnknown>, Type.TNull]>>;
    outputContract: Type.TOptional<Type.TUnion<[Type.TRecord<"^.*$", Type.TUnknown>, Type.TNull]>>;
    issues: Type.TOptional<Type.TArray<Type.TUnknown>>;
}>;
export declare const QaEvaluationInputSchema: Type.TObject<{
    profile: Type.TEnum<["source_pack", "meeting_minutes", "office_document", "document_revision"]>;
    checks: Type.TObject<{
        security: Type.TObject<{
            rawSecretsReturned: Type.TBoolean;
            secretsLeaked: Type.TBoolean;
        }>;
        privacy: Type.TOptional<Type.TObject<{
            rawSecretsReturned: Type.TBoolean;
            secretsLeaked: Type.TBoolean;
        }>>;
        evidence: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
        topicCoverage: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
        entitySafety: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
        asrEvidence: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
        titleSync: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
        feishuReadiness: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
        webAccess: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
        contextBudget: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
        sourcePack: Type.TOptional<Type.TObject<{
            required: Type.TLiteral<true>;
            completeTranscriptAvailable: Type.TBoolean;
            failedChapterCount: Type.TInteger;
            allClaimsHaveEvidence: Type.TBoolean;
            partialResultsPublished: Type.TBoolean;
            qualityDisclosureRequired: Type.TBoolean;
            qualityDisclosed: Type.TBoolean;
            provenancePath: Type.TUnion<[Type.TString, Type.TNull]>;
        }>>;
        reviewContext: Type.TOptional<Type.TUnion<[Type.TRecord<"^.*$", Type.TUnknown>, Type.TNull]>>;
        documentOutputs: Type.TOptional<Type.TArray<Type.TObject<{
            docType: Type.TString;
            markdown: Type.TString;
            status: Type.TOptional<Type.TEnum<["completed", "needs_fix", "blocked"]>>;
            requiredSections: Type.TOptional<Type.TArray<Type.TString>>;
            missingSections: Type.TOptional<Type.TArray<Type.TString>>;
            unsupportedClaims: Type.TOptional<Type.TArray<Type.TUnknown>>;
            openQuestions: Type.TOptional<Type.TArray<Type.TUnknown>>;
        }>>>;
        documents: Type.TOptional<Type.TArray<Type.TObject<{
            docType: Type.TString;
            markdown: Type.TString;
            status: Type.TOptional<Type.TEnum<["completed", "needs_fix", "blocked"]>>;
            requiredSections: Type.TOptional<Type.TArray<Type.TString>>;
            missingSections: Type.TOptional<Type.TArray<Type.TString>>;
            unsupportedClaims: Type.TOptional<Type.TArray<Type.TUnknown>>;
            openQuestions: Type.TOptional<Type.TArray<Type.TUnknown>>;
        }>>>;
        sourceStructureSummary: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
        documentIdentity: Type.TOptional<Type.TUnion<[Type.TRecord<"^.*$", Type.TUnknown>, Type.TNull]>>;
        outputContract: Type.TOptional<Type.TUnion<[Type.TRecord<"^.*$", Type.TUnknown>, Type.TNull]>>;
        issues: Type.TOptional<Type.TArray<Type.TUnknown>>;
    }>;
    publishIntent: Type.TOptional<Type.TBoolean>;
}>;
export declare const QaIssueSchema: Type.TObject<{
    code: Type.TString;
    severity: Type.TEnum<["info", "warning", "needs_fix", "blocking"]>;
    message: Type.TString;
    suggestedFix: Type.TOptional<Type.TString>;
    evidence: Type.TOptional<Type.TUnknown>;
    artifactType: Type.TOptional<Type.TString>;
    priority: Type.TOptional<Type.TEnum<["primary", "follow_up", "optional"]>>;
    blocksDelivery: Type.TOptional<Type.TBoolean>;
}>;
export declare const QaGateResultSchema: Type.TObject<{
    schemaVersion: Type.TLiteral<"qa-gate-v2">;
    evaluationId: Type.TString;
    inputHash: Type.TString;
    profile: Type.TEnum<["source_pack", "meeting_minutes", "office_document", "document_revision"]>;
    publishIntent: Type.TBoolean;
    status: Type.TEnum<["pass", "needs_fix", "blocked"]>;
    reason: Type.TUnion<[Type.TString, Type.TNull]>;
    fieldPath: Type.TOptional<Type.TString>;
    recovery: Type.TOptional<Type.TString>;
    primaryDeliveryStatus: Type.TEnum<["ready", "needs_fix", "blocked"]>;
    followUpDeliveryStatus: Type.TEnum<["pass", "needs_fix", "blocked", "not_applicable"]>;
    overallStatus: Type.TEnum<["ready", "partial_ready", "blocked"]>;
    publishAllowed: Type.TBoolean;
    evaluatedAt: Type.TString;
    artifacts: Type.TArray<Type.TRecord<"^.*$", Type.TUnknown>>;
    checks: Type.TObject<{
        security: Type.TObject<{
            rawSecretsReturned: Type.TBoolean;
            secretsLeaked: Type.TBoolean;
        }>;
        privacy: Type.TOptional<Type.TObject<{
            rawSecretsReturned: Type.TBoolean;
            secretsLeaked: Type.TBoolean;
        }>>;
        evidence: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
        topicCoverage: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
        entitySafety: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
        asrEvidence: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
        titleSync: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
        feishuReadiness: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
        webAccess: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
        contextBudget: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
        sourcePack: Type.TOptional<Type.TObject<{
            required: Type.TLiteral<true>;
            completeTranscriptAvailable: Type.TBoolean;
            failedChapterCount: Type.TInteger;
            allClaimsHaveEvidence: Type.TBoolean;
            partialResultsPublished: Type.TBoolean;
            qualityDisclosureRequired: Type.TBoolean;
            qualityDisclosed: Type.TBoolean;
            provenancePath: Type.TUnion<[Type.TString, Type.TNull]>;
        }>>;
        reviewContext: Type.TOptional<Type.TUnion<[Type.TRecord<"^.*$", Type.TUnknown>, Type.TNull]>>;
        documentOutputs: Type.TOptional<Type.TArray<Type.TObject<{
            docType: Type.TString;
            markdown: Type.TString;
            status: Type.TOptional<Type.TEnum<["completed", "needs_fix", "blocked"]>>;
            requiredSections: Type.TOptional<Type.TArray<Type.TString>>;
            missingSections: Type.TOptional<Type.TArray<Type.TString>>;
            unsupportedClaims: Type.TOptional<Type.TArray<Type.TUnknown>>;
            openQuestions: Type.TOptional<Type.TArray<Type.TUnknown>>;
        }>>>;
        documents: Type.TOptional<Type.TArray<Type.TObject<{
            docType: Type.TString;
            markdown: Type.TString;
            status: Type.TOptional<Type.TEnum<["completed", "needs_fix", "blocked"]>>;
            requiredSections: Type.TOptional<Type.TArray<Type.TString>>;
            missingSections: Type.TOptional<Type.TArray<Type.TString>>;
            unsupportedClaims: Type.TOptional<Type.TArray<Type.TUnknown>>;
            openQuestions: Type.TOptional<Type.TArray<Type.TUnknown>>;
        }>>>;
        sourceStructureSummary: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
        documentIdentity: Type.TOptional<Type.TUnion<[Type.TRecord<"^.*$", Type.TUnknown>, Type.TNull]>>;
        outputContract: Type.TOptional<Type.TUnion<[Type.TRecord<"^.*$", Type.TUnknown>, Type.TNull]>>;
        issues: Type.TOptional<Type.TArray<Type.TUnknown>>;
    }>;
    issues: Type.TArray<Type.TObject<{
        code: Type.TString;
        severity: Type.TEnum<["info", "warning", "needs_fix", "blocking"]>;
        message: Type.TString;
        suggestedFix: Type.TOptional<Type.TString>;
        evidence: Type.TOptional<Type.TUnknown>;
        artifactType: Type.TOptional<Type.TString>;
        priority: Type.TOptional<Type.TEnum<["primary", "follow_up", "optional"]>>;
        blocksDelivery: Type.TOptional<Type.TBoolean>;
    }>>;
    rawSecretsReturned: Type.TLiteral<false>;
}>;
export type QaProfile = Static<typeof QaProfileSchema>;
export type QaChecks = Static<typeof QaChecksSchema>;
export type QaEvaluationInput = Static<typeof QaEvaluationInputSchema>;
export type QaIssue = Static<typeof QaIssueSchema>;
export type QaGateResult = Static<typeof QaGateResultSchema>;
export declare const parseQaEvaluationInput: (value: unknown) => {
    publishIntent?: boolean;
    profile: "meeting_minutes" | "document_revision" | "source_pack" | "office_document";
    checks: {
        privacy?: {
            rawSecretsReturned: boolean;
            secretsLeaked: boolean;
        };
        evidence?: Record<string, unknown>;
        topicCoverage?: Record<string, unknown>;
        entitySafety?: Record<string, unknown>;
        asrEvidence?: Record<string, unknown>;
        titleSync?: Record<string, unknown>;
        feishuReadiness?: Record<string, unknown>;
        webAccess?: Record<string, unknown>;
        contextBudget?: Record<string, unknown>;
        sourcePack?: {
            required: true;
            completeTranscriptAvailable: boolean;
            failedChapterCount: number;
            allClaimsHaveEvidence: boolean;
            partialResultsPublished: boolean;
            qualityDisclosureRequired: boolean;
            qualityDisclosed: boolean;
            provenancePath: string | null;
        };
        reviewContext?: Record<string, unknown> | null;
        documentOutputs?: {
            status?: "completed" | "needs_fix" | "blocked";
            requiredSections?: string[];
            missingSections?: string[];
            unsupportedClaims?: unknown[];
            openQuestions?: unknown[];
            docType: string;
            markdown: string;
        }[];
        documents?: {
            status?: "completed" | "needs_fix" | "blocked";
            requiredSections?: string[];
            missingSections?: string[];
            unsupportedClaims?: unknown[];
            openQuestions?: unknown[];
            docType: string;
            markdown: string;
        }[];
        sourceStructureSummary?: Record<string, unknown>;
        documentIdentity?: Record<string, unknown> | null;
        outputContract?: Record<string, unknown> | null;
        issues?: unknown[];
        security: {
            rawSecretsReturned: boolean;
            secretsLeaked: boolean;
        };
    };
};
export declare const parseQaGateResult: (value: unknown) => {
    recovery?: string;
    fieldPath?: string;
    schemaVersion: "qa-gate-v2";
    status: "needs_fix" | "blocked" | "pass";
    reason: string | null;
    rawSecretsReturned: false;
    issues: {
        priority?: "primary" | "follow_up" | "optional";
        evidence?: unknown;
        suggestedFix?: string;
        artifactType?: string;
        blocksDelivery?: boolean;
        message: string;
        code: string;
        severity: "needs_fix" | "info" | "warning" | "blocking";
    }[];
    profile: "meeting_minutes" | "document_revision" | "source_pack" | "office_document";
    checks: {
        privacy?: {
            rawSecretsReturned: boolean;
            secretsLeaked: boolean;
        };
        evidence?: Record<string, unknown>;
        topicCoverage?: Record<string, unknown>;
        entitySafety?: Record<string, unknown>;
        asrEvidence?: Record<string, unknown>;
        titleSync?: Record<string, unknown>;
        feishuReadiness?: Record<string, unknown>;
        webAccess?: Record<string, unknown>;
        contextBudget?: Record<string, unknown>;
        sourcePack?: {
            required: true;
            completeTranscriptAvailable: boolean;
            failedChapterCount: number;
            allClaimsHaveEvidence: boolean;
            partialResultsPublished: boolean;
            qualityDisclosureRequired: boolean;
            qualityDisclosed: boolean;
            provenancePath: string | null;
        };
        reviewContext?: Record<string, unknown> | null;
        documentOutputs?: {
            status?: "completed" | "needs_fix" | "blocked";
            requiredSections?: string[];
            missingSections?: string[];
            unsupportedClaims?: unknown[];
            openQuestions?: unknown[];
            docType: string;
            markdown: string;
        }[];
        documents?: {
            status?: "completed" | "needs_fix" | "blocked";
            requiredSections?: string[];
            missingSections?: string[];
            unsupportedClaims?: unknown[];
            openQuestions?: unknown[];
            docType: string;
            markdown: string;
        }[];
        sourceStructureSummary?: Record<string, unknown>;
        documentIdentity?: Record<string, unknown> | null;
        outputContract?: Record<string, unknown> | null;
        issues?: unknown[];
        security: {
            rawSecretsReturned: boolean;
            secretsLeaked: boolean;
        };
    };
    publishIntent: boolean;
    evaluationId: string;
    inputHash: string;
    primaryDeliveryStatus: "needs_fix" | "blocked" | "ready";
    followUpDeliveryStatus: "needs_fix" | "blocked" | "pass" | "not_applicable";
    overallStatus: "blocked" | "ready" | "partial_ready";
    publishAllowed: boolean;
    evaluatedAt: string;
    artifacts: Record<string, unknown>[];
};
export declare function qaProfileRequirementFailure(input: QaEvaluationInput): {
    fieldPath: string;
    reason: string;
    recovery: string;
} | null;
//# sourceMappingURL=qa-contracts.d.ts.map