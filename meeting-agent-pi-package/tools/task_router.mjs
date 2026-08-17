import { existsSync, readFileSync } from "node:fs";
import { attachmentKind } from "./im_file_context_helpers.mjs";
import { extractPublicUrls } from "./public_url_security.mjs";
import {
  DEEP_REASONING_EXECUTION_PROFILES,
  FAST_REASONING_DEPTH,
  TASK_EXECUTION_PROFILES,
} from "../dist/index.js";

export const TASK_INTENT_SCHEMA_VERSION = "task-intent-v1";
export const UNSUPPORTED_FEATURE_REPLY = "目前暂不支持该功能";
export const FILE_REFERENCE_PATTERN =
  /文件内容|总结文件|分析文件|该文件|这个文件|这份文件|上面的文件|上传的文件|刚才的文件|刚才.*(文件|文档|附件|录音|音频)|最近.*(文件|文档|附件|录音|音频)|上一个.*(文件|文档|附件|录音|音频)|前面.*(文件|文档|附件|录音|音频)|附件|文档|这份文档|这个文档|该文档|pdf|word|excel|表格|这个表格|该表格|会议纪要|形成会议纪要|会议记录|录音|音频|转写|minutes/i;
export const DESTRUCTIVE_REQUEST_PATTERN = /删除|移除|清空|销毁|作废|delete|remove|destroy|purge/i;
export const PUBLISH_REQUEST_PATTERN = /发布|保存|放到|上传到|云端|文件夹|飞书文档|创建文档|生成文档|撰写|写一份|输出文档|归档|publish|save|create|folder/i;
export const MODIFY_REQUEST_PATTERN = /修改|改写|更新|覆盖|overwrite|update|edit/i;

const ONE_SENTENCE_PATTERN = /一句话|一段话|简短|简要|快速|summary|summarize|总结|摘要|概括/i;
const UNSUPPORTED_REQUEST_PATTERN = /日历|calendar|创建任务|分配任务|assign|提醒|reminder|转发给|发给某人|图片分析|识图|视频理解|看图/i;
const DOCUMENT_REVISION_REQUEST_PATTERN = /批注|评论|修改内容|修订|修正|重新优化|优化下|优化一下|根据.*(修改|批注|评论|建议)|review|comment|suggestion|revision|redline/i;
const DOCUMENT_PIPELINE_STAGES = ["evidence_pack", "planner_envelope", "prompt_registry", "document_workers", "qa_gate", "policy_gate", "publish", "reply"];
const NON_DOCUMENT_STAGES = ["audio_normalize", "asr_provider_resolved", "asr_transcribe", "local_asr", "cloud_asr", "evidence_pack", "planner_envelope", "prompt_registry", "document_workers", "qa_gate", "policy_gate", "publish"];
export const KNOWN_EXECUTION_PROFILES = [...TASK_EXECUTION_PROFILES];
/** @type {Set<string>} */
const DEEP_REASONING_EXECUTION_PROFILE_SET = new Set(DEEP_REASONING_EXECUTION_PROFILES);

/**
 * @typedef {import("../dist/index.js").TaskExecutionProfile} TaskExecutionProfile
 * @typedef {{
 *   name?: unknown,
 *   fileName?: unknown,
 *   fileToken?: unknown,
 *   fileKey?: unknown,
 *   file_key?: unknown,
 *   sha256?: unknown,
 *   sourceKind?: unknown,
 *   resolvedFromCache?: unknown,
 *   resolvedFromParentMessage?: unknown,
 *   explicitFileReference?: unknown,
 *   sourceMessageId?: unknown,
 *   messageId?: unknown,
 *   downloadStatus?: unknown,
 *   userMessage?: unknown,
 *   reason?: unknown
 * }} Attachment
 * @typedef {{ fileName?: unknown, contextPreview?: unknown, extractedTextPath?: unknown, status?: unknown, unsupportedReason?: unknown }} FileContext
 * @typedef {{ message?: { text?: unknown } }} RouterEvent
 * @typedef {{ status?: unknown, reason?: unknown }} AttachmentResolution
 * @typedef {{ sourceReferences?: unknown[], [key: string]: unknown }} SourcePreparation
 * @typedef {{
 *   taskType: string,
 *   requestedDocuments: string[],
 *   responseMode?: string,
 *   operation?: string,
 *   hasAttachments?: boolean,
 *   hasFileContexts?: boolean,
 *   requiresAsr?: boolean,
 *   requiresLocalAsr?: boolean,
 *   sourcePreparation?: SourcePreparation,
 *   immediateResponse?: string,
 *   unsupportedReason?: string,
 *   [key: string]: unknown
 * }} RouterIntent
 */

/** @param {unknown} text */
export function cleanUserPrompt(text) {
  return String(text ?? "")
    .replace(/@\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** @param {unknown} value */
function isFeishuWorkspaceUrl(value) {
  try {
    const host = new URL(String(value)).hostname.toLowerCase().replace(/\.$/, "");
    return ["feishu.cn", "feishu.com", "larksuite.cn", "larksuite.com"].some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

/** @param {Attachment[]} attachments */
function requiresAsr(attachments) {
  return attachments.some((item) => ["audio", "video"].includes(attachmentKind(item)));
}

/** @param {Attachment[]} attachments */
function hasAudioAttachments(attachments) {
  return attachments.some((item) => ["audio", "video"].includes(attachmentKind(item)));
}

/** @param {unknown} text */
function hasActionablePrompt(text) {
  const clean = cleanUserPrompt(text);
  return clean.length >= 2 && !/^\d+$/.test(clean);
}

/** @param {Attachment[]} attachments */
function sourceReferencesFromAttachments(attachments) {
  return attachments.map((attachment, index) => ({
    sourceId: `source-${String(index + 1).padStart(2, "0")}`,
    kind: attachmentKind(attachment),
    fileName: attachment.name ?? attachment.fileName ?? attachment.fileToken ?? attachment.fileKey ?? `source-${index + 1}`,
    fileToken: attachment.fileToken ?? null,
    fileKey: attachment.fileKey ?? attachment.file_key ?? null,
    sha256: attachment.sha256 ?? null,
    sourceKind: attachment.sourceKind ?? (attachment.resolvedFromCache ? "recent_attachment_cache" : attachment.resolvedFromParentMessage ? "parent_message_resource" : "message_attachment"),
    explicitFileReference: Boolean(attachment.explicitFileReference),
    resolvedFromCache: Boolean(attachment.resolvedFromCache),
    sourceMessageId: attachment.sourceMessageId ?? attachment.messageId ?? null,
  }));
}

/** @param {unknown} text @param {Attachment[]} [attachments] @returns {string[]} */
export function requestedDocumentsFromText(text, attachments = []) {
  const normalized = String(text ?? "").toLowerCase();
  /** @type {Set<string>} */
  const docs = new Set();
  if (/prd|产品|需求|mvp/.test(normalized)) docs.add("prd");
  if (/ops|运营|sop|指标|触点/.test(normalized)) docs.add("ops-plan");
  if (/architecture|架构|技术|模块|runtime/.test(normalized)) docs.add("tech-architecture");
  if (/checklist|清单|问题|待确认/.test(normalized)) docs.add("customer-requirement-checklist");
  if (/多文档|全套|完整文档|prd.*运营.*架构|架构.*运营.*prd/.test(normalized)) {
    ["prd", "ops-plan", "tech-architecture", "customer-requirement-checklist"].forEach((doc) => docs.add(doc));
  }
  if (docs.size === 0 && /会议|纪要|录音|音频|转写|minutes/.test(normalized)) {
    docs.add("meeting-minutes");
  }
  return [...docs];
}

/** @param {FileContext} context */
function readContextTextForInference(context) {
  const preview = String(context?.contextPreview ?? "");
  if (preview.trim()) return preview.slice(0, 6000);
  const extractedPath = context?.extractedTextPath;
  try {
    if (typeof extractedPath === "string" && extractedPath && existsSync(extractedPath)) {
      return readFileSync(extractedPath, "utf8").slice(0, 6000);
    }
  } catch {
    return "";
  }
  return "";
}

/** @param {FileContext[] | null | undefined} contexts @returns {string[]} */
export function inferRequestedDocumentsFromContexts(contexts) {
  /** @type {Set<string>} */
  const docs = new Set();
  for (const context of contexts ?? []) {
    const text = [context?.fileName, readContextTextForInference(context)].join("\n").toLowerCase();
    if (/prd|产品需求|产品化方案|mvp/.test(text)) docs.add("prd");
    if (/技术架构|architecture|runtime flow|模块边界/.test(text)) docs.add("tech-architecture");
    if (/运营方案|运营计划|ops|sop|指标体系/.test(text)) docs.add("ops-plan");
    if (/checklist|需求确认|客户需求确认|问题清单|待确认/.test(text)) docs.add("customer-requirement-checklist");
    if (/会议纪要|meeting minutes|会议主题|行动项/.test(text)) docs.add("meeting-minutes");
  }
  return [...docs];
}

/** @param {RouterIntent} intent @returns {TaskExecutionProfile} */
function executionProfileForIntent(intent) {
  if (intent.responseMode === "unsupported" || intent.taskType === "unsupported") return "unsupported";
  if (intent.taskType === "publish_only") return "publish_only";
  if (intent.operation === "document_revision" || intent.taskType === "document_revision") return "document_revision";
  if (intent.taskType === "knowledge_source" || intent.responseMode === "source_pack") return "url_source_pack";
  if (intent.taskType === "meeting_minutes" && intent.requiresLocalAsr) return "audio_minutes";
  if (
    intent.responseMode === "document_pipeline" &&
    (intent.sourcePreparation?.sourceReferences?.length ?? 0) > 1
  ) {
    return "multi_source_synthesis";
  }
  if (intent.responseMode === "document_pipeline") return "document_generation";
  if ((intent.taskType === "document_analysis" && intent.hasFileContexts) || (intent.responseMode === "direct_answer" && intent.hasFileContexts)) return "file_summary";
  return "fast_answer";
}

/** @param {TaskExecutionProfile} profile */
function reasoningDepthForProfile(profile) {
  return DEEP_REASONING_EXECUTION_PROFILE_SET.has(profile) ? "deep" : FAST_REASONING_DEPTH;
}

/** @param {Array<string | null | undefined>} stages */
function dedupeStages(stages) {
  return [...new Set(stages.filter(isNonEmptyString))];
}

/** @param {string | null | undefined} value @returns {value is string} */
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/** @param {RouterIntent} intent @param {TaskExecutionProfile} profile */
function stagePlanForIntent(intent, profile) {
  if (profile === "unsupported") {
    return {
      requiredStages: ["immediate_response", "reply"],
      skipStages: [...NON_DOCUMENT_STAGES, "direct_answer"],
    };
  }
  if (intent.responseMode === "needs_file") {
    return {
      requiredStages: ["missing_input_reply", "reply"],
      skipStages: [...NON_DOCUMENT_STAGES, "direct_answer"],
    };
  }
  if (intent.responseMode === "ack_file_cached") {
    return {
      requiredStages: ["file_context_cache", "acknowledge_file", "reply"],
      skipStages: [...NON_DOCUMENT_STAGES, "direct_answer"],
    };
  }
  if (profile === "fast_answer") {
    return {
      requiredStages: ["direct_answer", "reply"],
      skipStages: [...NON_DOCUMENT_STAGES],
    };
  }
  if (profile === "file_summary") {
    return {
      requiredStages: dedupeStages([intent.hasFileContexts ? "file_context" : null, "direct_answer", "reply"]),
      skipStages: [...NON_DOCUMENT_STAGES],
    };
  }
  if (profile === "audio_minutes") {
    return {
      requiredStages: ["asr_provider_resolved", "audio_normalize", "asr_transcribe", ...DOCUMENT_PIPELINE_STAGES],
      skipStages: ["direct_answer"],
    };
  }
  if (profile === "url_source_pack") {
    return {
      requiredStages: ["policy_gate", "public_url_resolve", "official_transcript_or_media", "cloud_asr_if_needed", "chapter_analysis", "source_pack", "provenance", "qa_gate", "reply"],
      skipStages: ["meeting_intelligence", "meeting_minutes", "document_workers", "publish"],
    };
  }
  if (profile === "document_revision") {
    return {
      requiredStages: dedupeStages([
        intent.requiresLocalAsr ? "asr_transcribe" : null,
        "file_context",
        "review_context",
        "evidence_pack",
        "planner_envelope",
        "prompt_registry",
        "document_workers",
        "qa_gate",
        "policy_gate",
        "publish",
        "reply",
      ]),
      skipStages: dedupeStages([intent.requiresLocalAsr ? null : "asr_transcribe", intent.requiresLocalAsr ? null : "local_asr", "direct_answer"]),
    };
  }
  return {
    requiredStages: dedupeStages([intent.requiresLocalAsr ? "asr_transcribe" : null, ...DOCUMENT_PIPELINE_STAGES]),
    skipStages: dedupeStages([intent.requiresLocalAsr ? null : "asr_transcribe", intent.requiresLocalAsr ? null : "local_asr", "direct_answer"]),
  };
}

/** @param {RouterIntent} intent @returns {import("../dist/index.js").TaskIntent & RouterIntent} */
function finalizeTaskIntent(intent) {
  const executionProfile = executionProfileForIntent(intent);
  const stagePlan = stagePlanForIntent(intent, executionProfile);
  return {
    schemaVersion: TASK_INTENT_SCHEMA_VERSION,
    ...intent,
    executionProfile,
    reasoningDepth: reasoningDepthForProfile(executionProfile),
    requiredStages: stagePlan.requiredStages,
    skipStages: stagePlan.skipStages,
  };
}

/**
 * @param {RouterEvent} event
 * @param {Attachment[]} [attachments]
 * @param {{ contexts?: FileContext[] }} [fileContextBatch]
 * @param {AttachmentResolution} [attachmentResolution]
 * @returns {import("../dist/index.js").TaskIntent & RouterIntent}
 */
export function classifyTaskIntent(event, attachments = [], fileContextBatch = {}, attachmentResolution = {}) {
  const rawText = String(event.message?.text ?? "");
  const prompt = cleanUserPrompt(rawText);
  const publicUrls = extractPublicUrls(rawText).filter((value) => !isFeishuWorkspaceUrl(value));
  const explicitDocs = requestedDocumentsFromText(prompt, attachments);
  const contexts = fileContextBatch.contexts ?? [];
  const inferredDocs = inferRequestedDocumentsFromContexts(contexts);
  const docs = explicitDocs.length > 0 ? explicitDocs : inferredDocs;
  const hasAttachments = attachments.length > 0;
  const hasFileContexts = contexts.length > 0;
  const requiresAudioAsr = requiresAsr(attachments);
  const isRevisionRequest = DOCUMENT_REVISION_REQUEST_PATTERN.test(prompt) || (MODIFY_REQUEST_PATTERN.test(prompt) && hasFileContexts);
  const sourceReferences = sourceReferencesFromAttachments(attachments);
  const inputModalities = [...new Set(attachments.map((item) => attachmentKind(item)))];
  const sourcePreparation = {
    sourceSetMode: "consolidated",
    inputModalities,
    sourceReferences,
    requiresAsr: requiresAudioAsr,
    requiresLocalAsr: requiresAudioAsr,
    requestedDocuments: docs,
    conflictPolicy: "source_attribution",
    attachmentResolutionReason: attachmentResolution?.reason ?? null,
    explicitFileReferenceCount: sourceReferences.filter((item) => item.explicitFileReference).length,
  };
  const unsupportedContext = contexts.find((context) => context.status === "unsupported");
  const failedExplicitFile = attachments.find((attachment) => attachment.explicitFileReference && !["downloaded", "local"].includes(String(attachment.downloadStatus ?? "")));
  const failedExplicitFileMessage = typeof failedExplicitFile?.userMessage === "string"
    ? failedExplicitFile.userMessage
    : "当前文件无法读取，请重新上传或确认权限。";

  if (DESTRUCTIVE_REQUEST_PATTERN.test(prompt)) {
    return finalizeTaskIntent({
      taskType: "unsupported",
      requestedDocuments: [],
      hasAttachments,
      hasFileContexts,
      requiresAsr: requiresAudioAsr,
      requiresLocalAsr: requiresAudioAsr,
      sourcePreparation,
      responseMode: "unsupported",
      unsupportedReason: "destructive_action_not_supported",
      immediateResponse: UNSUPPORTED_FEATURE_REPLY,
    });
  }
  if (publicUrls.length > 0) {
    return finalizeTaskIntent({
      taskType: "knowledge_source",
      requestedDocuments: [],
      hasAttachments,
      hasFileContexts,
      requiresAsr: false,
      requiresLocalAsr: false,
      sourcePreparation: {
        ...sourcePreparation,
        inputModalities: [...new Set([...sourcePreparation.inputModalities, "public_url"])],
        publicUrls,
        sourceSetMode: "explicit_public_url",
        requestedDocuments: [],
      },
      responseMode: "source_pack",
    });
  }
  if (UNSUPPORTED_REQUEST_PATTERN.test(prompt)) {
    return finalizeTaskIntent({
      taskType: "unsupported",
      requestedDocuments: [],
      hasAttachments,
      hasFileContexts,
      requiresAsr: requiresAudioAsr,
      requiresLocalAsr: requiresAudioAsr,
      sourcePreparation,
      responseMode: "unsupported",
      unsupportedReason: "unsupported_user_request",
      immediateResponse: UNSUPPORTED_FEATURE_REPLY,
    });
  }
  if (failedExplicitFile) {
    return finalizeTaskIntent({
      taskType: "missing_file_attachment",
      requestedDocuments: docs,
      hasAttachments,
      hasFileContexts,
      requiresLocalAsr: false,
      sourcePreparation,
      responseMode: "needs_file",
      missingInput: failedExplicitFile.reason ?? "explicit_feishu_file_unreadable",
      immediateResponse: failedExplicitFileMessage,
    });
  }
  if (unsupportedContext) {
    return finalizeTaskIntent({
      taskType: "unsupported",
      requestedDocuments: [],
      hasAttachments,
      hasFileContexts,
      requiresAsr: requiresAudioAsr,
      requiresLocalAsr: requiresAudioAsr,
      sourcePreparation,
      responseMode: "unsupported",
      unsupportedReason: typeof unsupportedContext.unsupportedReason === "string" ? unsupportedContext.unsupportedReason : "unsupported_file_context",
      immediateResponse: UNSUPPORTED_FEATURE_REPLY,
    });
  }
  if (FILE_REFERENCE_PATTERN.test(rawText) && !hasAttachments && attachmentResolution?.status === "missing") {
    return finalizeTaskIntent({
      taskType: "missing_file_attachment",
      requestedDocuments: docs,
      hasAttachments: false,
      hasFileContexts: false,
      requiresLocalAsr: false,
      sourcePreparation,
      responseMode: "needs_file",
      missingInput: "referenced_file_not_found_in_parent_or_recent_cache",
      immediateResponse: "当前消息未关联到音频或文件，请在同一条消息中附带文件，或回复文件消息后重试。",
    });
  }
  if (hasAttachments && !hasActionablePrompt(rawText)) {
    return finalizeTaskIntent({
      taskType: "file_context_cached",
      requestedDocuments: [],
      hasAttachments,
      hasFileContexts,
      requiresAsr: requiresAudioAsr,
      requiresLocalAsr: requiresAudioAsr,
      sourcePreparation,
      responseMode: "ack_file_cached",
      immediateResponse: hasAudioAttachments(attachments) ? "已收到音视频文件，可继续发送转写或纪要要求。" : "已收到文件，可继续发送分析要求。",
    });
  }
  if (isRevisionRequest && hasFileContexts) {
    const requested = docs.length > 0 ? docs : ["prd"];
    return finalizeTaskIntent({
      taskType: "document_revision",
      requestedDocuments: requested,
      hasAttachments,
      hasFileContexts,
      requiresAsr: requiresAudioAsr,
      requiresLocalAsr: requiresAudioAsr,
      sourcePreparation: {
        ...sourcePreparation,
        requestedDocuments: requested,
        operation: "document_revision",
        revisionSource: "feishu_document_body_plus_review_context",
        reviewContextRequired: true,
      },
      operation: "document_revision",
      responseMode: "document_pipeline",
    });
  }
  if (requiresAudioAsr || docs.length > 0) {
    const requested = docs.length > 0 ? docs : ["meeting-minutes"];
    const onlyMeetingMinutes = requested.length === 1 && requested[0] === "meeting-minutes";
    return finalizeTaskIntent({
      taskType: onlyMeetingMinutes ? "meeting_minutes" : "doc_writer",
      requestedDocuments: requested,
      hasAttachments,
      hasFileContexts,
      requiresAsr: requiresAudioAsr,
      requiresLocalAsr: requiresAudioAsr,
      sourcePreparation: { ...sourcePreparation, requestedDocuments: requested },
      responseMode: "document_pipeline",
    });
  }
  if (hasFileContexts || ONE_SENTENCE_PATTERN.test(prompt)) {
    return finalizeTaskIntent({
      taskType: "document_analysis",
      requestedDocuments: [],
      hasAttachments,
      hasFileContexts,
      requiresLocalAsr: false,
      sourcePreparation,
      responseMode: "direct_answer",
    });
  }
  return finalizeTaskIntent({
    taskType: "general_chat",
    requestedDocuments: [],
    hasAttachments,
    hasFileContexts,
    requiresLocalAsr: false,
    sourcePreparation,
    responseMode: "direct_answer",
  });
}

export const routeTaskIntent = classifyTaskIntent;
