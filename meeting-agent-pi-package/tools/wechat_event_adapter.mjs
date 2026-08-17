#!/usr/bin/env node

/**
 * WeChat adapter skeleton.
 *
 * This is a channel adapter only. It maps fixture/local WeChat input into the
 * unified IM contracts and can optionally invoke the same local handler path in
 * mock/dry-run mode. It does not connect to a live WeChat client and does not own
 * Planner, Model Router, Prompt Registry, Document Worker, QA Gate, or Policy
 * decisions.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleEvent } from "./feishu_agent_task_handler.mjs";
import { attachmentKind, buildFileContexts, sha256File } from "./im_file_context_helpers.mjs";

const toolDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(toolDir);
const workspaceDir = dirname(packageDir);
const DEFAULT_OUTPUT_ROOT = join(workspaceDir, "runtime-runs", "wechat-adapter");
const UNSUPPORTED_FEATURE_REPLY = "目前暂不支持该功能";
const SECRET_PATTERNS = [
  /(app_secret|client_secret|refresh_token|access_token|authorization|cookie|session)\s*[:=]\s*["']?[^"',\s]+/gi,
  /bearer\s+[A-Za-z0-9._-]+/gi,
  /\b(FEISHU_APP_SECRET|DEEPSEEK_API_KEY|XIAOMI_TOKEN_PLAN_SGP_API_KEY)\b/gi,
];

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    if (["invoke-handler", "dry-run", "mock-agent", "execute-local-asr", "pipeline-mock-model"].includes(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeSegment(value, fallback = "item") {
  const cleaned = String(value || fallback).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned;
}

function outputRoot(input) {
  const root = resolve(input ?? DEFAULT_OUTPUT_ROOT);
  if (!isInside(workspaceDir, root)) throw new Error("wechat_adapter_output_root_outside_workspace_blocked");
  mkdirSync(root, { recursive: true });
  return root;
}

function hashText(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function stableId(value, fallback) {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value && typeof value === "object") {
    return String(value.open_id ?? value.openId ?? value.union_id ?? value.unionId ?? value.user_id ?? value.userId ?? value.id ?? hashText(JSON.stringify(value)).slice(0, 16));
  }
  return fallback;
}

function parseJsonMaybe(value) {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function parseText(content) {
  const parsed = parseJsonMaybe(content);
  if (typeof parsed?.text === "string") return parsed.text.trim();
  if (typeof content === "string") return content.trim();
  return "";
}

function redactString(value) {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[redacted]"), String(value ?? ""));
}

function sanitize(value) {
  if (typeof value === "string") return redactString(value).slice(0, 20000);
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, entryValue] of Object.entries(value)) {
      if (["rawSecretsReturned", "rawMediaExternalUpload", "userVisibleRunId"].includes(key)) {
        output[key] = entryValue;
      } else if (/secret|token|cookie|session|authorization/i.test(key) && !/folderToken|fileToken|wikiToken/i.test(key)) {
        output[key] = "[redacted]";
      } else {
        output[key] = sanitize(entryValue);
      }
    }
    return output;
  }
  return value;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sanitize(value), null, 2)}\n`, "utf8");
  return path;
}

async function normalizeInput(input) {
  const message = input.message ?? input;
  const attachments = Array.isArray(input.attachments)
    ? input.attachments
    : Array.isArray(message.attachments)
      ? message.attachments
      : [];
  const normalizedAttachments = [];
  for (const [index, attachment] of attachments.entries()) {
    normalizedAttachments.push(await normalizeImAttachment(attachment, index));
  }
  const messageText = String(input.messageText ?? input.text ?? message.text ?? parseText(message.content) ?? "");
  const eventId = String(input.eventId ?? input.event_id ?? message.messageId ?? message.message_id ?? `wechat_${hashText(JSON.stringify(input)).slice(0, 16)}`);
  const actorId = stableId(
    input.senderId ?? message.senderId ?? input.sender?.senderId ?? input.sender?.sender_id ?? input.sender?.id ?? input.contactId,
    "unknown_wechat_sender",
  );
  const conversationType = input.conversationType ?? input.chatType ?? message.chatType ?? message.chat_type ?? (input.groupId ? "group" : "direct");
  return {
    schemaVersion: "im-event-v1",
    channel: "wechat",
    eventId,
    actor: {
      actorId,
      displayName: input.senderName ?? message.senderName ?? null,
    },
    conversation: {
      conversationId: input.conversationId ?? input.chatId ?? message.chatId ?? message.chat_id ?? input.groupId ?? input.contactId ?? "unknown_wechat_conversation",
      conversationType,
      threadId: input.threadId ?? null,
      rootId: input.rootId ?? null,
    },
    messageText,
    attachments: normalizedAttachments,
    parentMessage: input.parentMessage ?? null,
    rootMessage: input.rootMessage ?? null,
    replyTarget: {
      messageId: input.messageId ?? message.messageId ?? message.message_id ?? eventId,
      channel: "wechat",
    },
    permissions: {
      fixtureOnly: true,
      liveIntegrationAllowed: false,
      rawMediaExternalUploadAllowed: false,
      imageVideoSupported: false,
      audioProcessing: "local_asr_only",
      publishCapabilities: ["reply"],
      destructiveActionsAllowed: false,
    },
    timestamp: input.timestamp ?? nowIso(),
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  };
}

async function normalizeImAttachment(input, index = 0) {
  const localPath = input?.localPath ?? input?.sourcePath ?? null;
  const resolvedLocalPath = localPath ? resolve(localPath) : null;
  const kind = attachmentKind({ ...input, localPath: resolvedLocalPath });
  const exists = resolvedLocalPath ? existsSync(resolvedLocalPath) : false;
  const stat = exists ? statSync(resolvedLocalPath) : null;
  return {
    schemaVersion: "im-attachment-v1",
    channel: "wechat",
    attachmentId: String(input?.attachmentId ?? input?.fileKey ?? input?.sourcePath ?? input?.localPath ?? `attachment_${index}`),
    resourceType: kind,
    fileName: String(input?.fileName ?? input?.name ?? input?.sourcePath ?? input?.localPath ?? `attachment_${index}`),
    name: String(input?.name ?? input?.fileName ?? input?.sourcePath ?? input?.localPath ?? `attachment_${index}`),
    mimeType: input?.mimeType ?? input?.mime_type ?? null,
    sourcePath: input?.sourcePath ?? input?.localPath ?? null,
    localPath: resolvedLocalPath,
    fileKey: input?.fileKey ?? null,
    sha256: input?.sha256 ?? (exists ? await sha256File(resolvedLocalPath) : null),
    sizeBytes: input?.sizeBytes ?? stat?.size ?? null,
    downloadStatus: exists ? "local" : resolvedLocalPath ? "blocked" : "missing_local_path",
    unsupportedReason: kind === "image"
      ? "image_understanding_not_supported"
      : kind === "video"
        ? "video_understanding_not_supported"
        : null,
    fixtureOnly: true,
    rawMediaExternalUpload: false,
    rawSecretsReturned: false,
  };
}

function buildOfficeState(runId, imEvent, fileContexts) {
  const unsupported = fileContexts.find((context) => context.status === "unsupported");
  return {
    schemaVersion: "office-task-state-v2",
    planId: null,
    planRevision: null,
    objective: imEvent.messageText || "处理微信输入",
    operation: imEvent.attachments.length > 0 ? "analyze_source" : "respond",
    requestedDocuments: [],
    sourceCount: fileContexts.length,
    segmentCount: 0,
    meetingState: null,
    phase: unsupported ? "blocked" : "pending",
    completedDocuments: [],
    pendingDocuments: [],
    completedWorkUnits: [],
    openQuestions: unsupported?.unsupportedReason ? [unsupported.unsupportedReason] : [],
    updatedAt: nowIso(),
    taskId: runId,
    channel: "wechat",
    status: unsupported ? "unsupported" : "accepted",
    steps: [
      { name: "wechat_event_normalized", status: "completed", at: nowIso() },
      { name: "file_context_planned", status: unsupported ? "blocked" : "completed", at: nowIso(), unsupportedReason: unsupported?.unsupportedReason ?? null },
      { name: "shared_runner_path_selected", status: unsupported ? "skipped" : "completed", at: nowIso(), runner: "feishu_agent_task_handler_fixture_dry_run" },
    ],
    rawMediaExternalUpload: false,
    rawSecretsReturned: false,
  };
}

function toHandlerFixture(imEvent, fileContexts) {
  const unsupported = fileContexts.find((context) => context.status === "unsupported");
  return {
    schemaVersion: "feishu-event-v1",
    eventId: imEvent.eventId,
    eventType: "im.message.receive_v1",
    source: "wechat-adapter-fixture",
    receivedAt: nowIso(),
    message: {
      messageId: imEvent.replyTarget?.messageId ?? imEvent.eventId,
      chatId: imEvent.conversation.conversationId,
      chatType: imEvent.conversation.conversationType === "group" ? "group" : "p2p",
      msgType: imEvent.attachments.length > 0 ? "file" : "text",
      rootId: imEvent.conversation.rootId,
      parentId: null,
      threadId: imEvent.conversation.threadId,
      createTime: Date.now(),
      text: unsupported ? UNSUPPORTED_FEATURE_REPLY : imEvent.messageText,
      contentPreview: imEvent.messageText.slice(0, 500),
      attachments: imEvent.attachments.map((attachment) => ({
        resourceType: attachment.resourceType,
        name: attachment.fileName ?? attachment.name,
        mimeType: attachment.mimeType,
        localPath: attachment.localPath,
        fileKey: attachment.fileKey,
        sha256: attachment.sha256,
        sizeBytes: attachment.sizeBytes,
        rawMediaExternalUpload: false,
      })),
    },
    sender: {
      senderType: "wechat",
      senderId: imEvent.actor.actorId,
    },
    rawEventStored: true,
    rawEventPath: null,
    rawSecretsReturned: false,
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripRunArtifacts(text, runId = "") {
  const runIdPattern = runId ? new RegExp(escapeRegExp(runId), "i") : null;
  const lines = String(text ?? "")
    .split(/\n+/)
    .filter((line) => !/(runId|run id|runDir|runtime-runs|agent-output|handler|本地 run artifact|Feishu Agent Dry Run|\b(?:feishu|wechat)_\d{4}-\d{2}-\d{2}T)/i.test(line))
    .filter((line) => !(runIdPattern && runIdPattern.test(line)));
  while (lines.length > 0 && /^文档[：:]\s*$/.test(lines[lines.length - 1])) {
    lines.pop();
  }
  return lines.join("\n").trim();
}

function localAttachmentPreflight(imEvent) {
  const missing = imEvent.attachments.filter((attachment) => !attachment.localPath || !existsSync(attachment.localPath));
  if (missing.length === 0) return { status: "ready" };
  return {
    status: "blocked",
    reason: "attachment_local_path_required",
    attachmentIds: missing.map((attachment) => attachment.attachmentId),
  };
}

async function invokeSharedHandler(handlerFixture, outputRootPath, runId, args) {
  const hasAudio = handlerFixture.message.attachments.some((attachment) => attachment.resourceType === "audio");
  const executionMode = args["execute-local-asr"] && hasAudio ? "execute" : "mock";
  const result = await handleEvent(handlerFixture, {
    outputRoot: outputRootPath,
    runId,
    executionMode,
    publishMode: "dry-run",
    replyMode: "dry-run",
    dryRun: true,
    pipelineMockModel: args["pipeline-mock-model"] === true || args["execute-local-asr"] === true,
    cliTimeoutMs: Number(args["cli-timeout-ms"] ?? 120000),
    piTimeoutMs: Number(args["pi-timeout-ms"] ?? 900000),
    runtimeToolTimeoutMs: Number(args["runtime-tool-timeout-ms"] ?? 600000),
    localAsrServiceUrl: args["local-asr-service-url"] ?? process.env.LOCAL_ASR_SERVICE_URL,
    localAsrTimeoutMs: Number(args["local-asr-timeout-ms"] ?? 7200000),
  });
  return {
    invoked: true,
    status: result.status,
    executionMode,
    publishStatus: result.publishStatus,
    replyStatus: result.replyStatus,
    userReplyText: stripRunArtifacts(result.text || result.summary || "", runId),
    documents: result.documents ?? [],
    artifacts: {
      runDir: result.runDir ?? null,
      taskPath: result.taskPath ?? null,
      agentOutputPath: result.agentOutputPath ?? null,
      publishPath: result.publishPath ?? null,
      replyPath: result.replyPath ?? null,
    },
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.fixture) throw new Error("wechat_adapter_fixture_required");
  const fixture = JSON.parse(readFileSync(resolve(args.fixture), "utf8"));
  const root = outputRoot(args["output-root"]);
  const runId = safeSegment(args["run-id"] ?? `wechat_${nowIso().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`);
  const runDir = resolve(root, "runs", runId);
  if (!isInside(root, runDir)) throw new Error("wechat_adapter_run_dir_outside_root_blocked");
  mkdirSync(runDir, { recursive: true });

  const imEvent = await normalizeInput(fixture);
  const fileContextBatch = await buildFileContexts(
    { message: { text: imEvent.messageText, messageId: imEvent.replyTarget?.messageId }, messageText: imEvent.messageText },
    imEvent.attachments,
    { fileContextsDir: join(runDir, "file-context") },
    { nativeFileInputSupported: false },
  );
  const fileContexts = fileContextBatch.contexts;
  const state = buildOfficeState(runId, imEvent, fileContexts);
  const imEventPath = writeJson(join(runDir, "im-event.json"), imEvent);
  const fileContextPath = writeJson(join(runDir, "file-context-plan.json"), {
    schemaVersion: "file-context-batch-v1",
    channel: "wechat",
    contexts: fileContexts,
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  });
  const statePath = writeJson(join(runDir, "office-task-state.json"), state);
  const handlerFixture = toHandlerFixture(imEvent, fileContexts);
  const handlerFixturePath = writeJson(join(runDir, "handler-fixture.json"), handlerFixture);

  let handler = null;
  const hasUnsupported = fileContexts.some((context) => context.status === "unsupported");
  const preflight = localAttachmentPreflight(imEvent);
  if (args["invoke-handler"] && !hasUnsupported && preflight.status === "ready") {
    const handlerRoot = resolve(root, "shared-handler");
    handler = await invokeSharedHandler(handlerFixture, handlerRoot, runId, args);
  }
  const handlerBlockedReason = hasUnsupported
    ? "unsupported_file_context"
    : preflight.status !== "ready"
      ? preflight.reason
      : "invoke_handler_not_requested";
  const handlerReplyText = handler?.userReplyText || "";
  const localPathRequiredReply = "当前仅支持本地 fixture 附件路径，请提供 localPath 后重试。";
  const userReplyText = handlerReplyText
    || (hasUnsupported
      ? UNSUPPORTED_FEATURE_REPLY
      : args["invoke-handler"] && preflight.status !== "ready"
        ? localPathRequiredReply
        : "已接受任务，正在处理。");
  const resultStatus = hasUnsupported
    ? "unsupported"
    : args["invoke-handler"] && preflight.status !== "ready"
      ? "blocked"
      : handler?.status ?? "accepted";

  const result = {
    status: resultStatus,
    channel: "wechat",
    userReplyText,
    userVisibleRunId: false,
    runDir,
    artifacts: {
      imEventPath,
      fileContextPath,
      officeTaskStatePath: statePath,
      handlerFixturePath,
    },
    sharedHandler: handler
      ? handler
      : { invoked: false, reason: handlerBlockedReason, attachmentIds: preflight.attachmentIds ?? [] },
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  };
  writeJson(join(runDir, "wechat-adapter-result.json"), result);
  console.log(JSON.stringify(sanitize(result), null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "failed", reason: redactString(error instanceof Error ? error.message : String(error)), rawSecretsReturned: false }, null, 2));
  process.exit(2);
});
