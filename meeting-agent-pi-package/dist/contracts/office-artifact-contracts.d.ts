import { Type, type Static } from "typebox";
export declare const OFFICE_CHANNELS: readonly ["feishu", "wechat", "local"];
export declare const OFFICE_OBJECT_TYPES: readonly ["document", "file", "meeting", "transcript_summary", "task", "calendar_event", "contact", "project", "customer", "preference", "run"];
export declare const DOCUMENT_LIFECYCLE_STATES: readonly ["draft", "review", "published", "revision_requested", "blocked", "archived"];
export declare const OfficeContextSchema: Type.TObject<{
    contextId: Type.TString;
    actor: Type.TRecord<"^.*$", Type.TUnknown>;
    conversation: Type.TRecord<"^.*$", Type.TUnknown>;
    workspace: Type.TRecord<"^.*$", Type.TUnknown>;
    replyTarget: Type.TOptional<Type.TUnknown>;
    permissions: Type.TRecord<"^.*$", Type.TUnknown>;
}>;
export declare const OfficeSourceRunSchema: Type.TObject<{
    runId: Type.TString;
    version: Type.TString;
    artifactPointer: Type.TUnion<[Type.TString, Type.TNull]>;
}>;
export declare const RetrievalPointersSchema: Type.TObject<{
    artifactPointer: Type.TString;
    summaryPointer: Type.TUnion<[Type.TString, Type.TNull]>;
    metadataPointer: Type.TUnion<[Type.TString, Type.TNull]>;
    embeddingPointer: Type.TUnion<[Type.TString, Type.TNull]>;
}>;
export declare const RetrievalEntrySchema: Type.TObject<{
    entryId: Type.TString;
    objectType: Type.TEnum<["document", "file", "meeting", "transcript_summary", "task", "calendar_event", "contact", "project", "customer", "preference", "run"]>;
    channel: Type.TEnum<["feishu", "wechat", "local"]>;
    context: Type.TObject<{
        contextId: Type.TString;
        actor: Type.TRecord<"^.*$", Type.TUnknown>;
        conversation: Type.TRecord<"^.*$", Type.TUnknown>;
        workspace: Type.TRecord<"^.*$", Type.TUnknown>;
        replyTarget: Type.TOptional<Type.TUnknown>;
        permissions: Type.TRecord<"^.*$", Type.TUnknown>;
    }>;
    sourceRun: Type.TObject<{
        runId: Type.TString;
        version: Type.TString;
        artifactPointer: Type.TUnion<[Type.TString, Type.TNull]>;
    }>;
    version: Type.TString;
    title: Type.TString;
    summary: Type.TString;
    boundedPreview: Type.TString;
    tags: Type.TArray<Type.TString>;
    pointers: Type.TObject<{
        artifactPointer: Type.TString;
        summaryPointer: Type.TUnion<[Type.TString, Type.TNull]>;
        metadataPointer: Type.TUnion<[Type.TString, Type.TNull]>;
        embeddingPointer: Type.TUnion<[Type.TString, Type.TNull]>;
    }>;
    pointerOnly: Type.TLiteral<true>;
}>;
export declare const RetrievalIndexSchema: Type.TObject<{
    schemaVersion: Type.TLiteral<"retrieval-index-v1">;
    version: Type.TString;
    indexId: Type.TString;
    generatedAt: Type.TString;
    channel: Type.TEnum<["feishu", "wechat", "local"]>;
    context: Type.TObject<{
        contextId: Type.TString;
        actor: Type.TRecord<"^.*$", Type.TUnknown>;
        conversation: Type.TRecord<"^.*$", Type.TUnknown>;
        workspace: Type.TRecord<"^.*$", Type.TUnknown>;
        replyTarget: Type.TOptional<Type.TUnknown>;
        permissions: Type.TRecord<"^.*$", Type.TUnknown>;
    }>;
    sourceRun: Type.TObject<{
        runId: Type.TString;
        version: Type.TString;
        artifactPointer: Type.TUnion<[Type.TString, Type.TNull]>;
    }>;
    pointerOnly: Type.TLiteral<true>;
    entries: Type.TArray<Type.TObject<{
        entryId: Type.TString;
        objectType: Type.TEnum<["document", "file", "meeting", "transcript_summary", "task", "calendar_event", "contact", "project", "customer", "preference", "run"]>;
        channel: Type.TEnum<["feishu", "wechat", "local"]>;
        context: Type.TObject<{
            contextId: Type.TString;
            actor: Type.TRecord<"^.*$", Type.TUnknown>;
            conversation: Type.TRecord<"^.*$", Type.TUnknown>;
            workspace: Type.TRecord<"^.*$", Type.TUnknown>;
            replyTarget: Type.TOptional<Type.TUnknown>;
            permissions: Type.TRecord<"^.*$", Type.TUnknown>;
        }>;
        sourceRun: Type.TObject<{
            runId: Type.TString;
            version: Type.TString;
            artifactPointer: Type.TUnion<[Type.TString, Type.TNull]>;
        }>;
        version: Type.TString;
        title: Type.TString;
        summary: Type.TString;
        boundedPreview: Type.TString;
        tags: Type.TArray<Type.TString>;
        pointers: Type.TObject<{
            artifactPointer: Type.TString;
            summaryPointer: Type.TUnion<[Type.TString, Type.TNull]>;
            metadataPointer: Type.TUnion<[Type.TString, Type.TNull]>;
            embeddingPointer: Type.TUnion<[Type.TString, Type.TNull]>;
        }>;
        pointerOnly: Type.TLiteral<true>;
    }>>;
    rawSecretsReturned: Type.TLiteral<false>;
    rawMediaExternalUpload: Type.TLiteral<false>;
}>;
export declare const DocumentLifecycleEventSchema: Type.TObject<{
    eventId: Type.TString;
    action: Type.TEnum<["created", "revised", "section_rewritten", "diff_generated", "comment_added", "template_applied", "merged", "published", "blocked"]>;
    sourceRun: Type.TObject<{
        runId: Type.TString;
        version: Type.TString;
        artifactPointer: Type.TUnion<[Type.TString, Type.TNull]>;
    }>;
    version: Type.TString;
    artifactPointer: Type.TString;
    diffPointer: Type.TUnion<[Type.TString, Type.TNull]>;
    summaryPointer: Type.TUnion<[Type.TString, Type.TNull]>;
    requiresConfirmation: Type.TBoolean;
    confirmationStatus: Type.TEnum<["not_required", "pending", "confirmed", "denied"]>;
}>;
export declare const DocumentLifecycleSchema: Type.TObject<{
    schemaVersion: Type.TLiteral<"document-lifecycle-v1">;
    version: Type.TString;
    documentId: Type.TString;
    channel: Type.TEnum<["feishu", "wechat", "local"]>;
    context: Type.TObject<{
        contextId: Type.TString;
        actor: Type.TRecord<"^.*$", Type.TUnknown>;
        conversation: Type.TRecord<"^.*$", Type.TUnknown>;
        workspace: Type.TRecord<"^.*$", Type.TUnknown>;
        replyTarget: Type.TOptional<Type.TUnknown>;
        permissions: Type.TRecord<"^.*$", Type.TUnknown>;
    }>;
    sourceRun: Type.TObject<{
        runId: Type.TString;
        version: Type.TString;
        artifactPointer: Type.TUnion<[Type.TString, Type.TNull]>;
    }>;
    currentState: Type.TEnum<["draft", "review", "published", "revision_requested", "blocked", "archived"]>;
    target: Type.TRecord<"^.*$", Type.TUnknown>;
    lifecycleEvents: Type.TArray<Type.TObject<{
        eventId: Type.TString;
        action: Type.TEnum<["created", "revised", "section_rewritten", "diff_generated", "comment_added", "template_applied", "merged", "published", "blocked"]>;
        sourceRun: Type.TObject<{
            runId: Type.TString;
            version: Type.TString;
            artifactPointer: Type.TUnion<[Type.TString, Type.TNull]>;
        }>;
        version: Type.TString;
        artifactPointer: Type.TString;
        diffPointer: Type.TUnion<[Type.TString, Type.TNull]>;
        summaryPointer: Type.TUnion<[Type.TString, Type.TNull]>;
        requiresConfirmation: Type.TBoolean;
        confirmationStatus: Type.TEnum<["not_required", "pending", "confirmed", "denied"]>;
    }>>;
    destructiveActionsAllowed: Type.TLiteral<false>;
    rawSecretsReturned: Type.TLiteral<false>;
    rawMediaExternalUpload: Type.TLiteral<false>;
}>;
export declare const OfficeObjectSchema: Type.TObject<{
    schemaVersion: Type.TLiteral<"office-object-v1">;
    version: Type.TLiteral<"v1">;
    objectId: Type.TString;
    objectType: Type.TEnum<["document", "file", "meeting", "transcript_summary", "task", "calendar_event", "contact", "project", "customer", "preference", "run"]>;
    title: Type.TUnion<[Type.TString, Type.TNull]>;
    channel: Type.TEnum<["feishu", "wechat", "local"]>;
    context: Type.TObject<{
        contextId: Type.TString;
        actor: Type.TRecord<"^.*$", Type.TUnknown>;
        conversation: Type.TRecord<"^.*$", Type.TUnknown>;
        workspace: Type.TRecord<"^.*$", Type.TUnknown>;
        replyTarget: Type.TOptional<Type.TUnknown>;
        permissions: Type.TRecord<"^.*$", Type.TUnknown>;
    }>;
    sourceRun: Type.TObject<{
        runId: Type.TString;
        version: Type.TString;
        artifactPointer: Type.TUnion<[Type.TString, Type.TNull]>;
    }>;
    visibility: Type.TEnum<["private", "conversation", "workspace", "customer_visible"]>;
    pointers: Type.TRecord<"^.*$", Type.TUnknown>;
    rawSecretsReturned: Type.TLiteral<false>;
    rawMediaExternalUpload: Type.TLiteral<false>;
}>;
export type OfficeContext = Static<typeof OfficeContextSchema>;
export type OfficeSourceRun = Static<typeof OfficeSourceRunSchema>;
export type RetrievalEntry = Static<typeof RetrievalEntrySchema>;
export type RetrievalIndex = Static<typeof RetrievalIndexSchema>;
export type DocumentLifecycle = Static<typeof DocumentLifecycleSchema>;
export type OfficeObject = Static<typeof OfficeObjectSchema>;
export declare const parseRetrievalEntry: (value: unknown) => {
    title: string;
    version: string;
    entryId: string;
    objectType: "file" | "document" | "meeting" | "transcript_summary" | "task" | "calendar_event" | "contact" | "project" | "customer" | "preference" | "run";
    channel: "feishu" | "wechat" | "local";
    context: {
        replyTarget?: unknown;
        contextId: string;
        actor: Record<string, unknown>;
        conversation: Record<string, unknown>;
        workspace: Record<string, unknown>;
        permissions: Record<string, unknown>;
    };
    sourceRun: {
        runId: string;
        version: string;
        artifactPointer: string | null;
    };
    summary: string;
    boundedPreview: string;
    tags: string[];
    pointers: {
        artifactPointer: string;
        summaryPointer: string | null;
        metadataPointer: string | null;
        embeddingPointer: string | null;
    };
    pointerOnly: true;
};
export declare const parseRetrievalIndex: (value: unknown) => {
    entries: {
        title: string;
        version: string;
        entryId: string;
        objectType: "file" | "document" | "meeting" | "transcript_summary" | "task" | "calendar_event" | "contact" | "project" | "customer" | "preference" | "run";
        channel: "feishu" | "wechat" | "local";
        context: {
            replyTarget?: unknown;
            contextId: string;
            actor: Record<string, unknown>;
            conversation: Record<string, unknown>;
            workspace: Record<string, unknown>;
            permissions: Record<string, unknown>;
        };
        sourceRun: {
            runId: string;
            version: string;
            artifactPointer: string | null;
        };
        summary: string;
        boundedPreview: string;
        tags: string[];
        pointers: {
            artifactPointer: string;
            summaryPointer: string | null;
            metadataPointer: string | null;
            embeddingPointer: string | null;
        };
        pointerOnly: true;
    }[];
    schemaVersion: "retrieval-index-v1";
    rawSecretsReturned: false;
    rawMediaExternalUpload: false;
    version: string;
    generatedAt: string;
    channel: "feishu" | "wechat" | "local";
    context: {
        replyTarget?: unknown;
        contextId: string;
        actor: Record<string, unknown>;
        conversation: Record<string, unknown>;
        workspace: Record<string, unknown>;
        permissions: Record<string, unknown>;
    };
    sourceRun: {
        runId: string;
        version: string;
        artifactPointer: string | null;
    };
    pointerOnly: true;
    indexId: string;
};
export declare const parseDocumentLifecycle: (value: unknown) => {
    schemaVersion: "document-lifecycle-v1";
    rawSecretsReturned: false;
    rawMediaExternalUpload: false;
    version: string;
    channel: "feishu" | "wechat" | "local";
    context: {
        replyTarget?: unknown;
        contextId: string;
        actor: Record<string, unknown>;
        conversation: Record<string, unknown>;
        workspace: Record<string, unknown>;
        permissions: Record<string, unknown>;
    };
    sourceRun: {
        runId: string;
        version: string;
        artifactPointer: string | null;
    };
    documentId: string;
    currentState: "draft" | "review" | "blocked" | "published" | "revision_requested" | "archived";
    target: Record<string, unknown>;
    lifecycleEvents: {
        eventId: string;
        version: string;
        artifactPointer: string;
        summaryPointer: string | null;
        sourceRun: {
            runId: string;
            version: string;
            artifactPointer: string | null;
        };
        action: "blocked" | "published" | "created" | "revised" | "section_rewritten" | "diff_generated" | "comment_added" | "template_applied" | "merged";
        diffPointer: string | null;
        requiresConfirmation: boolean;
        confirmationStatus: "pending" | "not_required" | "confirmed" | "denied";
    }[];
    destructiveActionsAllowed: false;
};
export declare const parseOfficeObject: (value: unknown) => {
    schemaVersion: "office-object-v1";
    title: string | null;
    rawSecretsReturned: false;
    rawMediaExternalUpload: false;
    version: "v1";
    objectType: "file" | "document" | "meeting" | "transcript_summary" | "task" | "calendar_event" | "contact" | "project" | "customer" | "preference" | "run";
    channel: "feishu" | "wechat" | "local";
    context: {
        replyTarget?: unknown;
        contextId: string;
        actor: Record<string, unknown>;
        conversation: Record<string, unknown>;
        workspace: Record<string, unknown>;
        permissions: Record<string, unknown>;
    };
    sourceRun: {
        runId: string;
        version: string;
        artifactPointer: string | null;
    };
    pointers: Record<string, unknown>;
    objectId: string;
    visibility: "conversation" | "workspace" | "private" | "customer_visible";
};
//# sourceMappingURL=office-artifact-contracts.d.ts.map