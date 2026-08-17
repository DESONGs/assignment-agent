import { Type, type Static } from "typebox";
import { compileContractParser } from "./contract-validation.js";

export const OFFICE_CHANNELS = ["feishu", "wechat", "local"] as const;
export const OFFICE_OBJECT_TYPES = ["document", "file", "meeting", "transcript_summary", "task", "calendar_event", "contact", "project", "customer", "preference", "run"] as const;
export const DOCUMENT_LIFECYCLE_STATES = ["draft", "review", "published", "revision_requested", "blocked", "archived"] as const;

const UnknownObject = Type.Record(Type.String(), Type.Unknown());

export const OfficeContextSchema = Type.Object({
  contextId: Type.String({ minLength: 1 }),
  actor: UnknownObject,
  conversation: UnknownObject,
  workspace: UnknownObject,
  replyTarget: Type.Optional(Type.Unknown()),
  permissions: UnknownObject,
}, { additionalProperties: true });

export const OfficeSourceRunSchema = Type.Object({
  runId: Type.String({ minLength: 1 }),
  version: Type.String({ minLength: 1 }),
  artifactPointer: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });

export const RetrievalPointersSchema = Type.Object({
  artifactPointer: Type.String({ minLength: 1 }),
  summaryPointer: Type.Union([Type.String(), Type.Null()]),
  metadataPointer: Type.Union([Type.String(), Type.Null()]),
  embeddingPointer: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });

export const RetrievalEntrySchema = Type.Object({
  entryId: Type.String({ minLength: 1 }),
  objectType: Type.Enum(OFFICE_OBJECT_TYPES),
  channel: Type.Enum(OFFICE_CHANNELS),
  context: OfficeContextSchema,
  sourceRun: OfficeSourceRunSchema,
  version: Type.String({ minLength: 1 }),
  title: Type.String(),
  summary: Type.String(),
  boundedPreview: Type.String(),
  tags: Type.Array(Type.String()),
  pointers: RetrievalPointersSchema,
  pointerOnly: Type.Literal(true),
}, { additionalProperties: false });

export const RetrievalIndexSchema = Type.Object({
  schemaVersion: Type.Literal("retrieval-index-v1"),
  version: Type.String({ minLength: 1 }),
  indexId: Type.String({ minLength: 1 }),
  generatedAt: Type.String({ minLength: 1 }),
  channel: Type.Enum(OFFICE_CHANNELS),
  context: OfficeContextSchema,
  sourceRun: OfficeSourceRunSchema,
  pointerOnly: Type.Literal(true),
  entries: Type.Array(RetrievalEntrySchema),
  rawSecretsReturned: Type.Literal(false),
  rawMediaExternalUpload: Type.Literal(false),
}, {
  $id: "https://meeting-agent.local/schemas/retrieval-index.schema.json",
  title: "Retrieval Index",
  additionalProperties: false,
});

export const DocumentLifecycleEventSchema = Type.Object({
  eventId: Type.String({ minLength: 1 }),
  action: Type.Enum(["created", "revised", "section_rewritten", "diff_generated", "comment_added", "template_applied", "merged", "published", "blocked"] as const),
  sourceRun: OfficeSourceRunSchema,
  version: Type.String({ minLength: 1 }),
  artifactPointer: Type.String({ minLength: 1 }),
  diffPointer: Type.Union([Type.String(), Type.Null()]),
  summaryPointer: Type.Union([Type.String(), Type.Null()]),
  requiresConfirmation: Type.Boolean(),
  confirmationStatus: Type.Enum(["not_required", "pending", "confirmed", "denied"] as const),
}, { additionalProperties: false });

export const DocumentLifecycleSchema = Type.Object({
  schemaVersion: Type.Literal("document-lifecycle-v1"),
  version: Type.String({ minLength: 1 }),
  documentId: Type.String({ minLength: 1 }),
  channel: Type.Enum(OFFICE_CHANNELS),
  context: OfficeContextSchema,
  sourceRun: OfficeSourceRunSchema,
  currentState: Type.Enum(DOCUMENT_LIFECYCLE_STATES),
  target: UnknownObject,
  lifecycleEvents: Type.Array(DocumentLifecycleEventSchema),
  destructiveActionsAllowed: Type.Literal(false),
  rawSecretsReturned: Type.Literal(false),
  rawMediaExternalUpload: Type.Literal(false),
}, {
  $id: "https://meeting-agent.local/schemas/document-lifecycle.schema.json",
  title: "Document Lifecycle",
  additionalProperties: false,
});

export const OfficeObjectSchema = Type.Object({
  schemaVersion: Type.Literal("office-object-v1"),
  version: Type.Literal("v1"),
  objectId: Type.String({ minLength: 1 }),
  objectType: Type.Enum(OFFICE_OBJECT_TYPES),
  title: Type.Union([Type.String(), Type.Null()]),
  channel: Type.Enum(OFFICE_CHANNELS),
  context: OfficeContextSchema,
  sourceRun: OfficeSourceRunSchema,
  visibility: Type.Enum(["private", "conversation", "workspace", "customer_visible"] as const),
  pointers: UnknownObject,
  rawSecretsReturned: Type.Literal(false),
  rawMediaExternalUpload: Type.Literal(false),
}, {
  $id: "https://meeting-agent.local/schemas/office-object.schema.json",
  title: "Office Object",
  additionalProperties: false,
});

export type OfficeContext = Static<typeof OfficeContextSchema>;
export type OfficeSourceRun = Static<typeof OfficeSourceRunSchema>;
export type RetrievalEntry = Static<typeof RetrievalEntrySchema>;
export type RetrievalIndex = Static<typeof RetrievalIndexSchema>;
export type DocumentLifecycle = Static<typeof DocumentLifecycleSchema>;
export type OfficeObject = Static<typeof OfficeObjectSchema>;

export const parseRetrievalEntry = compileContractParser(RetrievalEntrySchema, {
  reason: "retrieval_entry_contract_invalid",
  recovery: "补齐 artifact pointer、source run 和 bounded preview 后重建检索条目。",
});
export const parseRetrievalIndex = compileContractParser(RetrievalIndexSchema, {
  reason: "retrieval_index_contract_invalid",
  recovery: "由 retrieval_index_write 重新生成 pointer-only 索引。",
});
export const parseDocumentLifecycle = compileContractParser(DocumentLifecycleSchema, {
  reason: "document_lifecycle_contract_invalid",
  recovery: "重新规划文档目标、来源 run 和 lifecycle event。",
});
export const parseOfficeObject = compileContractParser(OfficeObjectSchema, {
  reason: "office_object_contract_invalid",
  recovery: "重新生成包含有效 context、source run 和 artifact pointers 的 office object。",
});
