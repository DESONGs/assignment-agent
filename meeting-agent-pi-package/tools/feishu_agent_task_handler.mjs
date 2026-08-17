#!/usr/bin/env node

/**
 * Feishu Agent task handler.
 * Marker: feishu_agent_task_handler.
 *
 * This is the local bridge between normalized Feishu events and the PI package.
 * The handler owns orchestration artifacts only: event, task, state, agent
 * prompt/output, publish plan/result, and reply result. It does not hardcode
 * document structures; the PI prompt forces document routing through the
 * prompt registry and section-batched document workers.
 */

import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { appendFileSync, copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { runViaLocalDockerDocumentWorker } from "./local_docker_runtime_queue.mjs";
import { runTaskExecutionPipeline, shouldUseTaskExecutionRunner } from "./task_execution_runner.mjs";
import { attachmentKind, buildFileContexts, fileExtension, sha256File } from "./im_file_context_helpers.mjs";
import { CLOUD_ASR_MEDIA_EXTENSIONS, readCloudAsrMediaHeader, validateCloudAsrMediaHeader } from "./asr_media_formats.mjs";
import { publishDocumentsToWiki, wikiPlanPath, wikiPublishPath, wikiTargetRegistryPath } from "./feishu_wiki_publish_helpers.mjs";
import { buildPublishTaxonomy, publishTaxonomyPath } from "./feishu_publish_taxonomy.mjs";
import { redactSensitiveUrlsInText } from "./public_url_security.mjs";
import {
  DESTRUCTIVE_REQUEST_PATTERN,
  FILE_REFERENCE_PATTERN,
  MODIFY_REQUEST_PATTERN,
  PUBLISH_REQUEST_PATTERN,
  UNSUPPORTED_FEATURE_REPLY,
  classifyTaskIntent,
  cleanUserPrompt,
} from "./task_router.mjs";
import {
  FAST_ANSWER_EXECUTION_PROFILE,
  FAST_REASONING_DEPTH,
  assertFeishuEvent,
  assertFeishuRunState,
  assertFeishuTask,
} from "../dist/index.js";

const toolDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(toolDir);
const workspaceDir = dirname(packageDir);
const runtimeStoreCliPath = join(toolDir, "runtime_store_cli.py");
const DEFAULT_OUTPUT_ROOT = join(workspaceDir, "runtime-runs", "feishu-agent");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8788;
const ATTACHMENT_CACHE_VERSION = "feishu-attachment-cache-v1";
const EXECUTION_LEDGER_THREAD_INDEX_VERSION = "execution-ledger-thread-index-v1";
const ATTACHMENT_CACHE_MAX_AGE_MS = 30 * 60 * 1000;
const DEFAULT_ATTACHMENT_DOWNLOAD_IDENTITIES = ["bot", "user"];
const DEFAULT_ATTACHMENT_DOWNLOAD_MAX_ATTEMPTS = 2;
const DEFAULT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 900000;
const AUDIO_MIN_READY_BYTES = 4096;
const AUDIO_EXTENSIONS = CLOUD_ASR_MEDIA_EXTENSIONS;
const FEISHU_FILE_URL_PATTERN = /https?:\/\/(?:[\w.-]+\.)?(?:feishu|larksuite)\.cn\/(file|doc|docx|sheets?|wiki|base|mindnotes|slides)\/([A-Za-z0-9_-]{8,})(?:[/?#][^\s<>"']*)?/gi;
const FEISHU_TOKEN_PATTERN = /(?:file[_\s-]?token|obj[_\s-]?token)\s*[:=：]\s*([A-Za-z0-9_-]{8,})/gi;
const FEISHU_BRIDGE_CLI_MARKERS = [
  "im +messages-resources-download",
  "drive +create-folder",
  "markdown +create",
  "markdown +overwrite",
  "drive +upload",
  "im +messages-reply",
];
const SECRET_PATTERNS = [
  /(app_secret|client_secret|refresh_token|access_token|authorization|cookie|session)\s*[:=]\s*["']?[^"',\s]+/gi,
  /bearer\s+[A-Za-z0-9._-]+/gi,
  /\b(FEISHU_APP_SECRET|DEEPSEEK_API_KEY|XIAOMI_TOKEN_PLAN_SGP_API_KEY)\b/gi,
];

/**
 * @typedef {Record<string, unknown>} UnknownRecord
 * @typedef {import("../dist/index.js").FeishuEvent} FeishuEvent
 * @typedef {import("../dist/index.js").FeishuTask} FeishuTask
 * @typedef {import("../dist/index.js").FeishuRunState} FeishuRunState
 * @typedef {{ _: string[], [key: string]: string | boolean | string[] | undefined }} CliArgs
 * @typedef {UnknownRecord & { resourceType?: string, fileKey?: string, file_key?: string, fileToken?: string, name?: string, fileName?: string, localPath?: string | null, mimeType?: string | null, sourceMessageId?: string, messageId?: string, explicitFileReference?: boolean, downloadStatus?: string | null, sourceReady?: boolean, sha256?: string | null, sizeBytes?: number | null }} HandlerAttachment
 * @typedef {UnknownRecord & { status?: string, unsupportedReason?: string, [key: string]: unknown }} HandlerFileContext
 * @typedef {FeishuEvent & { attachmentResolution?: UnknownRecord, ledgerSelection?: UnknownRecord, parentMessage?: unknown, rootMessage?: unknown, parentMessages?: unknown[], referencedMessages?: unknown[] }} HandlerEvent
 * @typedef {FeishuTask & { attachments?: HandlerAttachment[], fileContexts?: UnknownRecord & { contexts?: HandlerFileContext[] } }} HandlerTask
 * @typedef {{ runDir: string, inputsDir: string, attachmentsDir: string, fileContextsDir: string, fileContextPath: string, artifactsDir: string, eventPath: string, sourceEventsPath: string, taskPath: string, statePath: string, metricsPath: string, manifestPath: string, agentTaskPath: string, agentOutputPath: string, publishPath: string, replyPath: string, progressPath: string, runtimeStoreIndexPath: string, stdoutPath: string, stderrPath: string }} RunPaths
 * @typedef {{ exitCode: number, signal: NodeJS.Signals | null, stdout: string, stderr: string, error?: string, timedOut: boolean }} CommandResult
 * @typedef {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, stdin?: string }} CommandOptions
 * @typedef {{ outputRoot?: string, runId?: string, executionMode?: string, publishMode?: string, replyMode?: string, publishAs?: string, publishTarget?: string, folderToken?: string, dryRun?: boolean, mockAgent?: boolean, asyncMode?: boolean, asyncVisibleAck?: boolean, fileAckReplyMode?: string, progressReplyMode?: string, cliTimeoutMs?: number, piTimeoutMs?: number, piCliBin?: string, attachmentDownloadAs?: string | string[], attachmentDownloadMaxAttempts?: number, attachmentDownloadTimeoutMs?: number, historicalAttachmentScanLimit?: number, runtimeStoreMode?: string, runtimeStoreCas?: boolean, runtimeStoreTimeoutMs?: number, [key: string]: unknown }} HandlerOptions
 * @typedef {UnknownRecord & { status: string, summary?: string, documents?: UnknownRecord[], artifacts?: unknown[], qaGate?: UnknownRecord, policyGate?: UnknownRecord }} AgentOutput
 * @typedef {UnknownRecord & { status: string, documents?: UnknownRecord[] }} PublishResult
 * @typedef {UnknownRecord & { runId: string, taskType: string, summary: string, finishedAt: string | null, status: string, enabledCapabilities: string[], toolCalls: unknown[], externalCalls: unknown[], generatedArtifacts: unknown[], plannerDecisions: unknown[], policyDecisions: unknown[], workerDecisions: unknown[], capabilitySelections: unknown[], qaGate: unknown }} RunMetrics
 * @typedef {UnknownRecord & { scopeHash: string, runId: string, plannerEnvelopePath: string }} LedgerIndexEntry
 * @typedef {{ schemaVersion: string, entries: LedgerIndexEntry[] }} LedgerThreadIndex
 * @typedef {UnknownRecord & { messageId: string, chatId: string, senderId: string, threadKey: string, timestampMs: number, attachments: HandlerAttachment[] }} AttachmentCacheEntry
 * @typedef {{ schemaVersion: string, entries: AttachmentCacheEntry[] }} AttachmentCache
 * @typedef {UnknownRecord & { resourceType: string, fileKey: string, name: string, localPath: string, downloadStatus: string, reason: string, linkMode?: string, reuseSource?: unknown, downloadAs?: unknown, failureClass?: unknown, retryable?: unknown, downloadAttempts?: unknown, exitCode?: unknown, stderrTail?: unknown }} LocalReuseFields
 * @typedef {HandlerOptions & { kind: string, name: string, fileKey: string, sourceMessageId: string, index: number, targetPath: string, afterCliFailure: boolean, downloadAs?: unknown, failureClass?: unknown, retryable?: unknown, downloadAttempts?: unknown, exitCode?: unknown, stderrTail?: unknown }} ReuseSearchOptions
 * @typedef {{ schemaVersion: string, entries: Record<string, UnknownRecord>, projectEntries: Record<string, UnknownRecord>, legacySessionMappings: Record<string, UnknownRecord> }} PublishTargetRegistry
 * @typedef {PublishResult & { plannedCommands: string[][], documents: UnknownRecord[], folderToken: string | null, publishTarget: unknown, reason?: string | null }} HandlerPublishResult
 * @typedef {UnknownRecord & { status: string, reason?: string, markdown?: string }} ReplyResult
 * @typedef {UnknownRecord & { status: string, reason?: string }} ProgressResult
 * @typedef {{ status: string, output: AgentOutput, mode: string, rawSecretsReturned: false }} AgentRun
 * @typedef {UnknownRecord & { docType: string, title: string, fileName: string, localPath: string, markdown: string }} OutputDocument
 * @typedef {{ itemId: string, selectedOption: string, requestedDocuments: string[], sourceRunId: unknown, sourcePlanId: unknown, sourceRevision: unknown }} LedgerSelection
 * @typedef {UnknownRecord & { path: string, ledger: UnknownRecord }} PreviousThreadLedger
 * @typedef {UnknownRecord & { status: string, reason: string, attachments: HandlerAttachment[], sourceMessageId?: unknown, messageIds?: unknown[], parentResolution?: UnknownRecord, cacheResolution?: UnknownRecord }} AttachmentResolutionResult
 */

/** @param {unknown} value @returns {UnknownRecord} */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {UnknownRecord} */ (value)
    : {};
}

function nowIso() {
  return new Date().toISOString();
}

/** @param {string[]} argv @returns {CliArgs} */
function parseArgs(argv) {
  /** @type {CliArgs} */
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === undefined) continue;
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    if (["dry-run", "mock-agent", "execute", "once", "quiet", "async"].includes(key)) {
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

/** @param {string} parent @param {string} child */
function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** @param {unknown} value @param {string} [fallback] */
function safeSegment(value, fallback = "item") {
  const cleaned = String(value || fallback).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned;
}

/** @param {unknown} value @param {string} [fallback] */
function safeMarkdownFileName(value, fallback = "document.md") {
  const cleaned = String(value || fallback).replace(/[\/\\:*?"<>|]/g, "_").trim().slice(0, 160) || fallback;
  return cleaned.endsWith(".md") ? cleaned : `${cleaned}.md`;
}

/** @param {unknown} input */
function outputRoot(input) {
  const root = resolve(typeof input === "string" ? input : DEFAULT_OUTPUT_ROOT);
  if (!isInside(workspaceDir, root)) {
    throw new Error("feishu_agent_output_root_outside_workspace_blocked");
  }
  mkdirSync(root, { recursive: true });
  return root;
}

/** @param {unknown} value */
function redactString(value) {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[redacted]"), redactSensitiveUrlsInText(value));
}

/** @param {unknown} stderr */
function classifyFeishuFileReadFailure(stderr) {
  const text = String(stderr ?? "");
  if (/99991672|action_scope_required|drive:file:download|drive:file:readonly|drive:drive:readonly/i.test(text)) {
    return {
      reason: "feishu_drive_scope_missing",
      errorCode: "99991672",
      requiredScopes: ["drive:file:download", "drive:file:readonly"],
      userMessage: "当前机器人缺少飞书云文件读取权限，请在飞书开放平台为应用开通云空间文件读取/下载权限后重试。",
    };
  }
  if (/access denied|permission|forbidden|HTTP 403/i.test(text)) {
    return {
      reason: "feishu_file_permission_denied",
      errorCode: null,
      requiredScopes: [],
      userMessage: "当前机器人没有该文件的读取权限，请确认文件已共享给机器人或重新上传文件。",
    };
  }
  return {
    reason: "explicit_feishu_file_unreadable",
    errorCode: null,
    requiredScopes: [],
    userMessage: "当前文件无法读取，请重新上传或确认权限。",
  };
}

/** @param {unknown} resultValue */
function classifyFeishuImResourceDownloadFailure(resultValue) {
  const result = asRecord(resultValue);
  const text = `${result?.stderr ?? ""}\n${result?.stdout ?? ""}\n${result?.error ?? ""}`;
  if (result?.exitCode === 127 || /command not found|ENOENT|lark-cli not found/i.test(text)) {
    return {
      failureClass: "lark_cli_unavailable",
      retryable: false,
      userMessage: "本机 lark-cli 不可用，无法下载飞书音频附件。",
    };
  }
  if (result?.timedOut || /context deadline exceeded|deadline exceeded|timeout|timed out|i\/o timeout|ECONNRESET|ETIMEDOUT/i.test(text)) {
    return {
      failureClass: "feishu_resource_download_timeout",
      retryable: true,
      userMessage: "飞书附件下载超时，已尝试重试和本机用户身份兜底但仍未拿到本地文件。",
    };
  }
  if (/access denied|permission|forbidden|HTTP 403|no permission|not authorized/i.test(text)) {
    return {
      failureClass: "feishu_resource_permission_denied",
      retryable: true,
      userMessage: "当前身份没有该音频附件读取权限，已尝试机器人和本机用户身份。",
    };
  }
  if (/not found|resource.*missing|file.*missing|HTTP 404|invalid file[_-]?key/i.test(text)) {
    return {
      failureClass: "feishu_resource_not_found",
      retryable: false,
      userMessage: "飞书没有返回可下载的音频附件资源，可能文件已失效或 fileKey 不可用。",
    };
  }
  return {
    failureClass: "attachment_download_failed",
    retryable: true,
    userMessage: "音频附件下载失败，已尝试复用本地缓存和重试下载但仍未拿到本地文件。",
  };
}

/** @param {unknown} value */
function parseAttachmentDownloadIdentities(value) {
  const raw = String(value ?? "").trim();
  const values = raw
    ? raw.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_ATTACHMENT_DOWNLOAD_IDENTITIES;
  const allowed = new Set(["bot", "user"]);
  /** @type {string[]} */
  const output = [];
  for (const identity of values) {
    if (!allowed.has(identity) || output.includes(identity)) continue;
    output.push(identity);
  }
  return output.length > 0 ? output : DEFAULT_ATTACHMENT_DOWNLOAD_IDENTITIES;
}

/** @param {HandlerOptions} [options] */
function attachmentDownloadMaxAttempts(options = {}) {
  const value = Number(options.attachmentDownloadMaxAttempts ?? process.env.FEISHU_AGENT_ATTACHMENT_DOWNLOAD_MAX_ATTEMPTS ?? DEFAULT_ATTACHMENT_DOWNLOAD_MAX_ATTEMPTS);
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : DEFAULT_ATTACHMENT_DOWNLOAD_MAX_ATTEMPTS;
}

/** @param {HandlerOptions} [options] */
function attachmentDownloadTimeoutMs(options = {}) {
  const value = Number(options.attachmentDownloadTimeoutMs ?? process.env.FEISHU_AGENT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS ?? DEFAULT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.max(30000, Math.floor(value)) : DEFAULT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS;
}

/** @param {unknown} value @param {string} [key] @returns {unknown} */
function sanitize(value, key = "") {
  if (typeof value === "string") return redactString(value).slice(0, 20000);
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    /** @type {UnknownRecord} */
    const output = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (["rawSecretsReturned", "rawMediaExternalUpload", "rawMeetingContentIncluded", "tokensIncluded", "cookiesUsed"].includes(entryKey)) {
        output[entryKey] = entryValue;
      } else if (/secret|token|cookie|session|authorization/i.test(entryKey) && !/folderToken|fileToken|wikiToken/i.test(entryKey)) {
        output[entryKey] = "[redacted]";
      } else {
        output[entryKey] = sanitize(entryValue, entryKey);
      }
    }
    return output;
  }
  return value;
}

/** @param {string} path @param {unknown} value */
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sanitize(value), null, 2)}\n`, "utf8");
  return path;
}

/** @param {string} path @param {string} value */
function writeText(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
  return path;
}

/** @param {unknown} path */
function workspaceRelative(path) {
  if (!path) return null;
  if (typeof path !== "string") return "[outside-workspace]";
  const resolved = resolve(path);
  return isInside(workspaceDir, resolved) ? relative(workspaceDir, resolved) : "[outside-workspace]";
}

/** @param {unknown} value @param {number} [max] */
function safeShortText(value, max = 700) {
  return redactString(String(value ?? ""))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** @param {unknown} value */
function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** @param {unknown} value */
function hashText(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

/** @param {unknown} value @returns {unknown} */
function parseJsonMaybe(value) {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/** @param {unknown} content */
function parseText(content) {
  const parsed = asRecord(parseJsonMaybe(content));
  if (typeof parsed.text === "string") return parsed.text.trim();
  if (typeof content === "string") return content.trim();
  return "";
}

/** @param {unknown} inputValue @returns {HandlerEvent} */
function normalizeDirectEvent(inputValue) {
  const input = asRecord(inputValue);
  if (input.schemaVersion === "feishu-event-v1") return /** @type {HandlerEvent} */ (assertFeishuEvent(sanitize(input)));
  const data = asRecord(input.data);
  const envelope = asRecord(input.event ?? data.event ?? input.data ?? input);
  const message = asRecord(envelope.message ?? input.message);
  const sender = asRecord(envelope.sender ?? input.sender);
  const content = message.content ?? input.content ?? "";
  const parsed = asRecord(parseJsonMaybe(content));
  const fileKey = parsed.file_key ?? parsed.fileKey ?? input.fileKey;
  const imageKey = parsed.image_key ?? parsed.imageKey ?? input.imageKey;
  const attachments = Array.isArray(input?.attachments) ? input.attachments : [];
  if (fileKey) attachments.push({ resourceType: "file", fileKey: String(fileKey), name: String(parsed.file_name ?? parsed.name ?? fileKey) });
  if (imageKey) attachments.push({ resourceType: "image", fileKey: String(imageKey), name: String(parsed.file_name ?? parsed.name ?? imageKey) });
  const eventId = String(input?.eventId ?? input?.event_id ?? message?.message_id ?? hashJson(input).slice(0, 24));
  return assertFeishuEvent({
    schemaVersion: "feishu-event-v1",
    eventId,
    eventType: input?.eventType ?? input?.event_type ?? "im.message.receive_v1",
    source: input?.source ?? "handler-direct",
    receivedAt: input?.receivedAt ?? nowIso(),
    message: {
      messageId: String(input?.messageId ?? message?.message_id ?? message?.messageId ?? ""),
      chatId: String(input?.chatId ?? message?.chat_id ?? message?.chatId ?? ""),
      chatType: input?.chatType ?? message?.chat_type ?? message?.chatType ?? null,
      msgType: String(input?.msgType ?? message?.message_type ?? message?.msgType ?? "text"),
      rootId: input?.rootId ?? message?.root_id ?? message?.rootId ?? null,
      parentId: input?.parentId ?? message?.parent_id ?? message?.parentId ?? null,
      threadId: input?.threadId ?? message?.thread_id ?? message?.threadId ?? null,
      createTime: input?.createTime ?? message?.create_time ?? message?.createTime ?? null,
      text: String(input?.text ?? message?.text ?? parseText(content) ?? "").slice(0, 12000),
      contentPreview: typeof content === "string" ? redactString(content).slice(0, 500) : "",
      attachments,
    },
    sender: {
      senderType: sender?.sender_type ?? sender?.senderType ?? input?.senderType ?? null,
      senderId: sender?.sender_id ?? sender?.senderId ?? input?.senderId ?? null,
    },
    rawEventStored: true,
    rawEventPath: null,
    rawSecretsReturned: false,
  });
}

/** @param {HandlerEvent} event */
function runIdFor(event) {
  const seed = event.message?.messageId || event.eventId || randomUUID();
  const date = new Date().toISOString().replace(/[:.]/g, "-");
  return safeSegment(`feishu_${date}_${seed}`);
}

/** @param {string} root @param {string} runId @returns {RunPaths} */
function runPaths(root, runId) {
  const runDir = resolve(root, "runs", safeSegment(runId));
  if (!isInside(root, runDir)) throw new Error("feishu_run_dir_outside_output_root_blocked");
  return {
    runDir,
    inputsDir: join(runDir, "inputs"),
    attachmentsDir: join(runDir, "inputs", "attachments"),
    fileContextsDir: join(runDir, "inputs", "file-context"),
    fileContextPath: join(runDir, "inputs", "file-context.json"),
    artifactsDir: join(runDir, "artifacts"),
    eventPath: join(runDir, "event.json"),
    sourceEventsPath: join(runDir, "source-events.ndjson"),
    taskPath: join(runDir, "task.json"),
    statePath: join(runDir, "state.json"),
    metricsPath: join(runDir, "run.metrics.json"),
    manifestPath: join(runDir, "run-manifest.json"),
    agentTaskPath: join(runDir, "agent-task.md"),
    agentOutputPath: join(runDir, "agent-output.json"),
    publishPath: join(runDir, "publish.json"),
    replyPath: join(runDir, "reply.json"),
    progressPath: join(runDir, "progress-replies.ndjson"),
    runtimeStoreIndexPath: join(runDir, "runtime-store-index.json"),
    stdoutPath: join(runDir, "pi.stdout.txt"),
    stderrPath: join(runDir, "pi.stderr.txt"),
  };
}

/** @param {FeishuRunState} state @param {string} name @param {string} status @param {UnknownRecord} [details] */
function addStep(state, name, status, details = {}) {
  const { name: _detailName, status: _detailStatus, at: _detailAt, ...safeDetails } = details;
  state.steps.push({ ...safeDetails, name, status, at: nowIso() });
  state.status = status === "failed" ? "failed" : status === "blocked" ? "blocked" : status === "needs_fix" ? "needs_fix" : state.status;
  state.updatedAt = nowIso();
}

/** @param {RunPaths} paths @param {FeishuRunState} state */
function writeState(paths, state) {
  writeJson(paths.statePath, assertFeishuRunState(state));
}

/** @param {unknown} text */
function hasExplicitFeishuFileReferences(text) {
  return extractFeishuFileReferences(text).length > 0;
}

/** @param {unknown} text @returns {HandlerAttachment[]} */
function extractFeishuFileReferences(text) {
  const value = String(text ?? "");
  /** @type {HandlerAttachment[]} */
  const refs = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const match of value.matchAll(FEISHU_FILE_URL_PATTERN)) {
    const urlType = String(match[1] ?? "file").toLowerCase();
    const token = match[2];
    if (!token || seen.has(token)) continue;
    seen.add(token);
    refs.push({
      resourceType: "file",
      fileToken: token,
      fileKey: "",
      name: `feishu-file-${String(refs.length).padStart(2, "0")}-${token}.md`,
      sourceKind: "explicit_feishu_file_url",
      explicitFileReference: true,
      explicitFileUrl: match[0],
      explicitFileUrlType: urlType,
      sourceOrder: refs.length,
    });
  }
  for (const match of value.matchAll(FEISHU_TOKEN_PATTERN)) {
    const token = match[1];
    if (!token || seen.has(token)) continue;
    seen.add(token);
    refs.push({
      resourceType: "file",
      fileToken: token,
      fileKey: "",
      name: `feishu-file-${String(refs.length).padStart(2, "0")}-${token}.md`,
      sourceKind: "explicit_feishu_file_token",
      explicitFileReference: true,
      sourceOrder: refs.length,
    });
  }
  return refs;
}

/** @param {unknown} text @returns {Set<string>} */
function expectedCacheKindsForText(text) {
  const value = String(text ?? "");
  const audioCue = /录音|音频|转写|形成会议纪要|会议记录|minutes/i.test(value);
  const textCue = /文件|文档|pdf|word|excel|表格|prd|产品需求|架构|技术|checklist|清单|客户|会议纪要文件|纪要文件/i.test(value);
  if (audioCue && !textCue) return new Set(["audio"]);
  if (audioCue && textCue) return new Set(["audio", "file"]);
  if (textCue) return new Set(["file"]);
  return new Set(["file", "audio"]);
}

/** @param {HandlerAttachment[]} attachments @param {Set<string>} expectedKinds */
function filterAttachmentsByExpectedKinds(attachments, expectedKinds) {
  return attachments.filter((item) => expectedKinds.has(attachmentKind(item)));
}

/** @param {HandlerAttachment[]} attachments @returns {HandlerAttachment[]} */
function dedupeAttachments(attachments) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {HandlerAttachment[]} */
  const result = [];
  for (const attachment of attachments) {
    const key = [
      attachment.explicitFileReference ? "explicit" : "attachment",
      attachment.fileToken ?? "",
      attachment.fileKey ?? attachment.file_key ?? "",
      attachment.localPath ?? "",
      attachment.name ?? "",
      attachment.sourceMessageId ?? attachment.messageId ?? "",
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(attachment);
  }
  return result;
}

/** @param {string} command @param {string[]} args @param {CommandOptions} [options] @returns {Promise<CommandResult>} */
function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(command, args, {
      cwd: options.cwd ?? workspaceDir,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs ?? 120000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 5_000_000) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 5_000_000) child.kill("SIGTERM");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      const errorCode = "code" in error ? error.code : null;
      resolveCommand({ exitCode: errorCode === "ENOENT" ? 127 : 1, signal: null, stdout, stderr, error: error.message, timedOut });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolveCommand({ exitCode: code ?? (signal ? 128 : 1), signal, stdout, stderr, timedOut });
    });
    child.stdin.end(options.stdin ?? "");
  });
}

/** @param {string} text @returns {unknown} */
function parseJsonOutput(text) {
  try {
    return text.trim() ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** @param {unknown} raw */
function optionalPositiveNumber(raw) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** @param {unknown} senderValue */
function stableSenderId(senderValue) {
  const sender = asRecord(senderValue);
  const value = sender.senderId ?? senderValue;
  if (!value) return "";
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return String(record.open_id ?? record.openId ?? record.union_id ?? record.unionId ?? record.user_id ?? record.userId ?? hashJson(value).slice(0, 16));
}

/** @param {HandlerEvent} event */
function eventTimestampMs(event) {
  const raw = event.message?.createTime ?? event.createTime ?? event.receivedAt;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(String(raw ?? ""));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** @param {HandlerEvent} event */
function attachmentCacheTimestampMs(event) {
  const received = Date.parse(event.receivedAt ?? "");
  return Number.isFinite(received) ? received : eventTimestampMs(event);
}

/** @param {HandlerEvent} event */
function threadKey(event) {
  return String(event.message?.threadId ?? event.message?.rootId ?? event.message?.parentId ?? event.threadId ?? event.rootId ?? event.parentId ?? "");
}

/** @param {string} root */
function attachmentCachePath(root) {
  return join(root, ".feishu-attachment-cache.json");
}

/** @param {string} root */
function ledgerThreadIndexPath(root) {
  return join(root, ".execution-ledger-thread-index.json");
}

/** @param {string} root @returns {LedgerThreadIndex} */
function loadLedgerThreadIndex(root) {
  const path = ledgerThreadIndexPath(root);
  if (!existsSync(path)) return { schemaVersion: EXECUTION_LEDGER_THREAD_INDEX_VERSION, entries: [] };
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return { schemaVersion: EXECUTION_LEDGER_THREAD_INDEX_VERSION, entries: /** @type {LedgerIndexEntry[]} */ (Array.isArray(value.entries) ? value.entries : []) };
  } catch {
    return { schemaVersion: EXECUTION_LEDGER_THREAD_INDEX_VERSION, entries: [] };
  }
}

/** @param {HandlerEvent} event */
function threadScopeHash(event) {
  const thread = threadKey(event);
  const chat = event.message?.chatId ?? "";
  const sender = stableSenderId(event.sender);
  return thread || chat ? hashText(`${chat}:${thread || "chat"}:${sender || "unknown"}`).slice(0, 32) : "";
}

/** @param {string} root @param {HandlerEvent} event @param {string} runId @param {string} plannerEnvelopePath @param {AgentOutput} agentOutput */
function indexExecutionLedgerForThread(root, event, runId, plannerEnvelopePath, agentOutput) {
  if (!existsSync(plannerEnvelopePath)) return { status: "skipped", reason: "execution_ledger_missing" };
  const scopeHash = threadScopeHash(event);
  if (!scopeHash) return { status: "skipped", reason: "thread_scope_missing" };
  const index = loadLedgerThreadIndex(root);
  const entry = {
    scopeHash,
    runId,
    plannerEnvelopePath: workspaceRelative(plannerEnvelopePath) ?? "[missing-ledger]",
    sourceEventPath: workspaceRelative(join(dirname(plannerEnvelopePath), "event.json")) ?? "[missing-event]",
    updatedAt: nowIso(),
    status: agentOutput?.status ?? null,
  };
  index.entries = [entry, ...(index.entries ?? []).filter((item) => item.scopeHash !== scopeHash && item.runId !== runId)].slice(0, 300);
  writeJson(ledgerThreadIndexPath(root), { ...index, updatedAt: nowIso(), rawSecretsReturned: false });
  return { status: "indexed", entry };
}

/** @param {string} root @param {HandlerEvent} event */
/** @param {string} root @param {HandlerEvent} event @returns {PreviousThreadLedger | null} */
function selectPreviousThreadLedger(root, event) {
  const scopeHash = threadScopeHash(event);
  if (!scopeHash) return null;
  const index = loadLedgerThreadIndex(root);
  for (const entry of index.entries ?? []) {
    if (entry.scopeHash !== scopeHash) continue;
    const path = resolve(workspaceDir, String(entry.plannerEnvelopePath ?? ""));
    if (!isInside(workspaceDir, path) || !existsSync(path)) continue;
    try {
      const ledger = JSON.parse(readFileSync(path, "utf8"));
      if (ledger?.schemaVersion !== "adaptive-execution-ledger-v1") continue;
      return { ...entry, path, ledger };
    } catch {
      continue;
    }
  }
  return null;
}

/** @param {unknown} text @param {unknown} ledgerValue */
/** @param {unknown} text @param {unknown} ledgerValue @returns {LedgerSelection | null} */
export function resolveLedgerSelection(text, ledgerValue) {
  const ledger = asRecord(ledgerValue);
  const interactionItems = Array.isArray(ledger.interactionItems) ? ledger.interactionItems.map(asRecord) : [];
  const prompt = String(text ?? "").trim();
  if (!prompt || interactionItems.length === 0) return null;
  const optionMap = new Map([
    ["prd", "prd"], ["产品需求", "prd"],
    ["客户需求确认表", "customer-requirement-checklist"], ["客户确认表", "customer-requirement-checklist"], ["checklist", "customer-requirement-checklist"],
    ["技术架构", "tech-architecture"], ["架构", "tech-architecture"],
    ["运营方案", "ops-plan"],
    ["仅保留会议纪要", "keep-meeting-minutes-only"], ["只保留会议纪要", "keep-meeting-minutes-only"],
    ["审阅客户问题", "review-customer-questions"], ["先看问题", "review-customer-questions"],
    ["审阅 source pack", "review-source-pack"], ["先审阅 source pack", "review-source-pack"], ["查看 source pack", "review-source-pack"],
    ["仅保留本地 source pack", "keep-source-pack-local"], ["保留本地", "keep-source-pack-local"],
  ]);
  let selectedOption = null;
  for (const [term, option] of optionMap) {
    if (prompt.toLowerCase().includes(term.toLowerCase())) {
      selectedOption = option;
      break;
    }
  }
  if (!selectedOption) return null;
  const interaction = interactionItems.find((item) => item.status === "pending" && (
    (Array.isArray(item.options) ? item.options : []).includes(selectedOption) || (Array.isArray(item.suggestedDocuments) ? item.suggestedDocuments : []).includes(selectedOption)
  ));
  if (!interaction) return null;
  return {
    itemId: String(interaction.itemId ?? ""),
    selectedOption,
    requestedDocuments: ["prd", "tech-architecture", "ops-plan", "customer-requirement-checklist"].includes(selectedOption) ? [selectedOption] : [],
    sourceRunId: ledger.runId ?? null,
    sourcePlanId: ledger.planId ?? null,
    sourceRevision: ledger.revision ?? null,
  };
}

/** @param {string} root @returns {AttachmentCache} */
function loadAttachmentCache(root) {
  const path = attachmentCachePath(root);
  if (!existsSync(path)) return { schemaVersion: ATTACHMENT_CACHE_VERSION, entries: [] };
  try {
    const cache = JSON.parse(readFileSync(path, "utf8"));
    return {
      schemaVersion: ATTACHMENT_CACHE_VERSION,
      entries: /** @type {AttachmentCacheEntry[]} */ (Array.isArray(cache.entries) ? cache.entries : []),
    };
  } catch {
    return { schemaVersion: ATTACHMENT_CACHE_VERSION, entries: [] };
  }
}

/** @param {string} root @param {AttachmentCache} cache */
function saveAttachmentCache(root, cache) {
  const cutoff = Date.now() - ATTACHMENT_CACHE_MAX_AGE_MS;
  const entries = (cache.entries ?? [])
    .filter((entry) => Number(entry.timestampMs ?? 0) >= cutoff)
    .slice(-200);
  writeJson(attachmentCachePath(root), {
    schemaVersion: ATTACHMENT_CACHE_VERSION,
    updatedAt: nowIso(),
    maxAgeMs: ATTACHMENT_CACHE_MAX_AGE_MS,
    entries,
    rawSecretsReturned: false,
  });
}

/** @param {HandlerEvent} event @param {HandlerAttachment} attachment @returns {HandlerAttachment} */
function attachmentWithSource(event, attachment) {
  return {
    ...attachment,
    messageId: attachment.messageId ?? attachment.sourceMessageId ?? event.message?.messageId ?? "",
    sourceMessageId: attachment.sourceMessageId ?? attachment.messageId ?? event.message?.messageId ?? "",
    chatId: attachment.chatId ?? event.message?.chatId ?? "",
    senderId: attachment.senderId ?? stableSenderId(event.sender),
    rootId: attachment.rootId ?? event.message?.rootId ?? null,
    parentId: attachment.parentId ?? event.message?.parentId ?? null,
    threadId: attachment.threadId ?? event.message?.threadId ?? null,
  };
}

/** @param {unknown} messageValue @param {unknown} sourceMessageId @returns {HandlerAttachment[]} */
function collectAttachmentsFromMessageLike(messageValue, sourceMessageId) {
  const message = asRecord(messageValue);
  /** @type {HandlerAttachment[]} */
  const attachments = [];
  const rawContent = message.content ?? asRecord(message.body).content ?? "";
  const parsed = asRecord(parseJsonMaybe(rawContent));
  const directAttachments = Array.isArray(message.attachments)
    ? message.attachments
    : Array.isArray(asRecord(message.message).attachments)
      ? /** @type {unknown[]} */ (asRecord(message.message).attachments)
      : [];
  for (const [index, itemValue] of directAttachments.entries()) {
    const item = asRecord(itemValue);
    const fileKey = item.file_key ?? item.fileKey ?? item.key ?? item.image_key ?? item.imageKey;
    if (!fileKey) continue;
    attachments.push({
      resourceType: String(item.resource_type ?? item.resourceType ?? item.type ?? (item.image_key || item.imageKey ? "image" : "file")),
      fileKey: String(fileKey),
      name: String(item.file_name ?? item.fileName ?? item.name ?? fileKey ?? `attachment_${index}`),
      mimeType: typeof (item.mime_type ?? item.mimeType) === "string" ? String(item.mime_type ?? item.mimeType) : null,
      localPath: typeof item.localPath === "string" ? item.localPath : null,
      sourceMessageId: String(sourceMessageId ?? ""),
      messageId: String(sourceMessageId ?? ""),
      resolvedFromParentMessage: true,
    });
  }
  const xmlContent = typeof rawContent === "string" ? rawContent : "";
  for (const [index, match] of [...xmlContent.matchAll(/<file\b([^>]*)\/?>/gi)].entries()) {
    const attrs = Object.fromEntries(
      [...String(match[1] ?? "").matchAll(/([A-Za-z_:.-]+)=["']([^"']*)["']/g)].map((attr) => [attr[1], xmlDecode(attr[2])]),
    );
    const fileKey = attrs.key ?? attrs.file_key ?? attrs.fileKey;
    if (!fileKey) continue;
    attachments.push({
      resourceType: "file",
      fileKey: String(fileKey),
      name: String(attrs.name ?? attrs.file_name ?? attrs.fileName ?? fileKey ?? `file_${index}`),
      mimeType: attrs.mime_type ?? attrs.mimeType ?? null,
      sourceMessageId: String(sourceMessageId ?? ""),
      messageId: String(sourceMessageId ?? ""),
      resolvedFromParentMessage: true,
      resolvedFromXmlFileTag: true,
    });
  }
  for (const [index, match] of [...xmlContent.matchAll(/<img\b([^>]*)\/?>/gi)].entries()) {
    const attrs = Object.fromEntries(
      [...String(match[1] ?? "").matchAll(/([A-Za-z_:.-]+)=["']([^"']*)["']/g)].map((attr) => [attr[1], xmlDecode(attr[2])]),
    );
    const imageKey = attrs.key ?? attrs.image_key ?? attrs.imageKey;
    if (!imageKey) continue;
    attachments.push({
      resourceType: "image",
      fileKey: String(imageKey),
      name: String(attrs.name ?? attrs.file_name ?? attrs.fileName ?? imageKey ?? `image_${index}`),
      mimeType: attrs.mime_type ?? attrs.mimeType ?? null,
      sourceMessageId: String(sourceMessageId ?? ""),
      messageId: String(sourceMessageId ?? ""),
      resolvedFromParentMessage: true,
      resolvedFromXmlFileTag: true,
    });
  }
  const contentFileKey = parsed.file_key ?? parsed.fileKey ?? parsed.key;
  const contentImageKey = parsed.image_key ?? parsed.imageKey;
  if (contentFileKey) {
    attachments.push({
      resourceType: "file",
      fileKey: String(contentFileKey),
      name: String(parsed.file_name ?? parsed.fileName ?? parsed.name ?? contentFileKey),
      mimeType: typeof (parsed.mime_type ?? parsed.mimeType) === "string" ? String(parsed.mime_type ?? parsed.mimeType) : null,
      sourceMessageId: String(sourceMessageId ?? ""),
      messageId: String(sourceMessageId ?? ""),
      resolvedFromParentMessage: true,
    });
  }
  if (contentImageKey) {
    attachments.push({
      resourceType: "image",
      fileKey: String(contentImageKey),
      name: String(parsed.file_name ?? parsed.fileName ?? parsed.name ?? contentImageKey),
      mimeType: typeof (parsed.mime_type ?? parsed.mimeType) === "string" ? String(parsed.mime_type ?? parsed.mimeType) : null,
      sourceMessageId: String(sourceMessageId ?? ""),
      messageId: String(sourceMessageId ?? ""),
      resolvedFromParentMessage: true,
    });
  }
  return attachments;
}

/** @param {unknown} value @param {UnknownRecord[]} [results] @returns {UnknownRecord[]} */
function findMessageLikeObjects(value, results = []) {
  if (!value || typeof value !== "object") return results;
  if (!Array.isArray(value)) {
    const record = asRecord(value);
    const nestedMessage = asRecord(record.message);
    const messageId = record.message_id ?? record.messageId ?? nestedMessage.message_id ?? nestedMessage.messageId;
    const hasMessageShape = messageId || record.content || record.message_type || record.msgType || record.attachments;
    if (hasMessageShape) results.push(record);
  }
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    if (child && typeof child === "object") findMessageLikeObjects(child, results);
  }
  return results;
}

/** @param {HandlerEvent} event @returns {HandlerAttachment[]} */
function embeddedParentMessageAttachments(event) {
  const candidates = [
    event.parentMessage,
    event.rootMessage,
    ...(Array.isArray(event.parentMessages) ? event.parentMessages : []),
    ...(Array.isArray(event.referencedMessages) ? event.referencedMessages : []),
  ].filter(Boolean);
  /** @type {HandlerAttachment[]} */
  const attachments = [];
  for (const messageValue of candidates) {
    const message = asRecord(messageValue);
    const sourceMessageId = message.message_id ?? message.messageId ?? message.id ?? event.message?.parentId ?? event.message?.rootId ?? "";
    attachments.push(...collectAttachmentsFromMessageLike(message, sourceMessageId));
  }
  return attachments;
}

/** @param {unknown} payload @param {unknown[]} targetIds @returns {HandlerAttachment[]} */
function collectAttachmentsFromCliPayload(payload, targetIds) {
  const targetSet = new Set(targetIds.filter(Boolean));
  const messages = findMessageLikeObjects(payload);
  /** @type {HandlerAttachment[]} */
  const attachments = [];
  for (const message of messages) {
    const nestedMessage = asRecord(message.message);
    const messageId = String(message.message_id ?? message.messageId ?? nestedMessage.message_id ?? nestedMessage.messageId ?? "");
    if (targetSet.size > 0 && messageId && !targetSet.has(messageId)) continue;
    attachments.push(...collectAttachmentsFromMessageLike(message.message ?? message, messageId));
  }
  return attachments;
}

/** @param {string} root @param {HandlerEvent} event */
function rememberAttachments(root, event) {
  const attachments = (event.message?.attachments ?? []).filter((item) => item.fileKey || item.localPath);
  if (attachments.length === 0) return { status: "skipped", reason: "no_attachments" };
  const cache = loadAttachmentCache(root);
  const entry = {
    eventId: event.eventId,
    messageId: event.message?.messageId ?? "",
    chatId: event.message?.chatId ?? "",
    senderId: stableSenderId(event.sender),
    threadKey: threadKey(event),
    timestampMs: attachmentCacheTimestampMs(event),
    receivedAt: event.receivedAt ?? nowIso(),
    attachments: attachments.map((item) => attachmentWithSource(event, item)),
  };
  cache.entries = [...(cache.entries ?? []).filter((item) => item.messageId !== entry.messageId), entry];
  saveAttachmentCache(root, cache);
  return { status: "cached", attachments: entry.attachments.length, cachePath: attachmentCachePath(root) };
}

/** @param {string} root @param {HandlerEvent} event @param {HandlerAttachment[]} attachments */
function rememberDownloadedAttachments(root, event, attachments) {
  const reusable = (attachments ?? [])
    .filter((item) => typeof item.localPath === "string" && existsSync(resolve(item.localPath)))
    .filter((item) => !["failed", "blocked", "skipped"].includes(String(item.downloadStatus ?? "")));
  if (reusable.length === 0) {
    const failed = (attachments ?? []).filter((item) => ["failed", "blocked"].includes(String(item.downloadStatus ?? "")));
    if (failed.length === 0) return { status: "skipped", reason: "no_reusable_downloaded_attachments" };
    const failedForCache = failed.map((item) => {
      const { localPath, sourcePath, ...rest } = item;
      return {
        ...rest,
        attemptedLocalPath: localPath ?? sourcePath ?? null,
        sourceReady: false,
        lastFailureClass: item.failureClass ?? item.reason ?? "attachment_download_failed",
        lastDownloadAttempts: item.downloadAttempts ?? [],
      };
    });
    const cached = rememberAttachments(root, /** @type {HandlerEvent} */ ({
      ...event,
      message: {
        ...event.message,
        attachments: failedForCache,
      },
    }));
    return {
      ...cached,
      reason: "cached_failed_attachment_metadata",
      sourceReady: false,
    };
  }
  return rememberAttachments(root, /** @type {HandlerEvent} */ ({
    ...event,
    message: {
      ...event.message,
      attachments: reusable.map((item) => ({ ...item, sourceReady: true })),
    },
  }));
}

/** @param {string} root @param {HandlerEvent} event */
/** @param {string} root @param {HandlerEvent} event @returns {AttachmentResolutionResult} */
function resolveCachedAttachments(root, event) {
  if ((event.message?.attachments ?? []).length > 0) {
    return { status: "not_needed", reason: "event_has_attachments", attachments: /** @type {HandlerAttachment[]} */ (event.message.attachments ?? []) };
  }
  const text = event.message?.text ?? "";
  if (hasExplicitFeishuFileReferences(text)) {
    return { status: "not_needed", reason: "explicit_file_reference_present_no_cache_fallback", attachments: [] };
  }
  if (!FILE_REFERENCE_PATTERN.test(text)) {
    return { status: "not_needed", reason: "no_file_reference", attachments: [] };
  }
  const expectedKinds = expectedCacheKindsForText(text);
  const cache = loadAttachmentCache(root);
  const currentTs = attachmentCacheTimestampMs(event);
  const senderId = stableSenderId(event.sender);
  const currentThread = threadKey(event);
  const chatId = event.message?.chatId ?? "";
  if (!senderId) {
    return { status: "missing", reason: "sender_id_missing_for_cache_lookup", attachments: [] };
  }
  const candidates = (cache.entries ?? [])
    .filter((entry) => entry.chatId === chatId)
    .filter((entry) => entry.senderId === senderId)
    .filter((entry) => currentTs - Number(entry.timestampMs ?? 0) <= ATTACHMENT_CACHE_MAX_AGE_MS)
    .filter((entry) => !currentThread || !entry.threadKey || entry.threadKey === currentThread)
    .map((entry) => ({
      ...entry,
      attachments: filterAttachmentsByExpectedKinds(entry.attachments ?? [], expectedKinds),
    }))
    .filter((entry) => (entry.attachments ?? []).length > 0)
    .sort((a, b) => Number(b.timestampMs ?? 0) - Number(a.timestampMs ?? 0));
  const selected = candidates[0];
  if (!selected) {
    return { status: "missing", reason: "referenced_file_not_found_in_recent_cache_or_modality", expectedKinds: [...expectedKinds], attachments: [] };
  }
  const attachments = (selected.attachments ?? []).map((item) => ({
    ...item,
    resolvedFromCache: true,
    cacheSourceMessageId: selected.messageId,
  }));
  return {
    status: "resolved",
    reason: "recent_attachment_cache",
    sourceMessageId: selected.messageId,
    attachments,
  };
}

/** @param {HandlerEvent} event @param {HandlerOptions} options */
/** @param {HandlerEvent} event @param {HandlerOptions} options @returns {Promise<AttachmentResolutionResult>} */
async function resolveParentMessageAttachments(event, options) {
  const text = event.message?.text ?? "";
  if (!FILE_REFERENCE_PATTERN.test(text)) {
    return { status: "not_needed", reason: "no_file_reference", attachments: [] };
  }
  const embedded = embeddedParentMessageAttachments(event);
  if (embedded.length > 0) {
    return {
      status: "resolved",
      reason: "embedded_parent_message_attachment",
      attachments: embedded.map((item) => attachmentWithSource(event, item)),
      sourceMessageId: embedded[0]?.sourceMessageId ?? embedded[0]?.messageId ?? null,
    };
  }

  const ids = [...new Set([event.message?.parentId, event.message?.rootId].filter((id) => id && id !== event.message?.messageId))];
  if (ids.length === 0) {
    return { status: "missing", reason: "no_parent_or_root_message_id", attachments: [] };
  }
  if (options.dryRun) {
    return {
      status: "skipped",
      reason: "dry_run_parent_message_fetch_not_executed",
      messageIds: ids,
      attachments: [],
    };
  }

  const cli = await runCommand(
    "lark-cli",
    ["im", "+messages-mget", "--as", "bot", "--message-ids", ids.join(","), "--format", "json"],
    { timeoutMs: options.cliTimeoutMs ?? 120000 },
  );
  if (cli.exitCode !== 0) {
    return {
      status: "skipped",
      reason: "parent_message_fetch_failed",
      messageIds: ids,
      exitCode: cli.exitCode,
      stderrTail: redactString(cli.stderr).slice(-1200),
      attachments: [],
    };
  }
  const parsed = parseJsonOutput(cli.stdout);
  if (!parsed) {
    return {
      status: "skipped",
      reason: "parent_message_fetch_unparseable",
      messageIds: ids,
      attachments: [],
    };
  }
  const attachments = collectAttachmentsFromCliPayload(parsed, ids).map((item) => attachmentWithSource(event, item));
  if (attachments.length === 0) {
    return {
      status: "missing",
      reason: "parent_message_has_no_downloadable_file",
      messageIds: ids,
      attachments: [],
    };
  }
  return {
    status: "resolved",
    reason: "parent_message_resource",
    messageIds: ids,
    sourceMessageId: attachments[0]?.sourceMessageId ?? attachments[0]?.messageId ?? null,
    attachments,
  };
}

/** @param {string} root @param {HandlerEvent} event @param {HandlerOptions} options */
/** @param {string} root @param {HandlerEvent} event @param {HandlerOptions} options @returns {Promise<AttachmentResolutionResult>} */
async function resolveReferencedAttachments(root, event, options) {
  if ((event.message?.attachments ?? []).length > 0) {
    return { status: "not_needed", reason: "event_has_attachments", attachments: /** @type {HandlerAttachment[]} */ (event.message.attachments ?? []) };
  }
  if (hasExplicitFeishuFileReferences(event.message?.text ?? "")) {
    return { status: "not_needed", reason: "explicit_file_reference_present_no_cache_fallback", attachments: [] };
  }
  if (!FILE_REFERENCE_PATTERN.test(event.message?.text ?? "")) {
    return { status: "not_needed", reason: "no_file_reference", attachments: [] };
  }
  const parentResolution = await resolveParentMessageAttachments(event, options);
  if (parentResolution.attachments?.length > 0) return parentResolution;

  const cacheResolution = resolveCachedAttachments(root, event);
  if ((cacheResolution.attachments ?? []).length > 0) return cacheResolution;

  return {
    status: "missing",
    reason: "referenced_file_not_found_in_parent_or_recent_cache",
    parentResolution: {
      status: parentResolution.status,
      reason: parentResolution.reason,
      messageIds: parentResolution.messageIds ?? [],
      exitCode: parentResolution.exitCode ?? null,
    },
    cacheResolution: {
      status: cacheResolution.status,
      reason: cacheResolution.reason,
    },
    attachments: [],
  };
}

/** @param {unknown} value @param {string[]} keys @returns {string | null} */
function findToken(value, keys) {
  if (!value || typeof value !== "object") return null;
  const record = asRecord(value);
  for (const key of keys) {
    const entry = record[key];
    if (typeof entry === "string" && entry) return entry;
  }
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const token = findToken(item, keys);
        if (token) return token;
      }
    } else if (child && typeof child === "object") {
      const token = findToken(child, keys);
      if (token) return token;
    }
  }
  return null;
}

/** @param {HandlerAttachment} attachment */
function exportFormatForExplicitFile(attachment) {
  const type = String(attachment.explicitFileUrlType ?? "").toLowerCase();
  if (type === "doc" || type === "docx" || type === "wiki") return { docType: type === "doc" ? "doc" : "docx", extension: "markdown" };
  if (type === "sheet" || type === "sheets") return { docType: "sheet", extension: "xlsx" };
  if (type === "base") return { docType: "bitable", extension: "base" };
  return null;
}

/** @param {string} path */
function existingNonEmptyFile(path) {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0 ? stat : null;
  } catch {
    return null;
  }
}

/** @param {string} path */
function audioSignatureStatus(path) {
  const resolved = resolve(path);
  const stat = existingNonEmptyFile(resolved);
  if (!stat) return { ok: false, reason: "audio_file_missing" };
  const ext = fileExtension({ localPath: resolved });
  if (!AUDIO_EXTENSIONS.has(ext)) return { ok: true, reason: "non_audio_extension", sizeBytes: stat.size, extension: ext };
  if (stat.size < AUDIO_MIN_READY_BYTES) {
    return { ok: false, reason: "audio_file_too_small", sizeBytes: stat.size, minBytes: AUDIO_MIN_READY_BYTES, extension: ext };
  }
  let head = Buffer.alloc(0);
  try {
    head = readCloudAsrMediaHeader(resolved);
  } catch (error) {
    return { ok: false, reason: "audio_header_read_failed", error: redactString(error instanceof Error ? error.message : String(error)), extension: ext };
  }
  const validation = validateCloudAsrMediaHeader(ext, head);
  return { ...validation, sizeBytes: stat.size };
}

/** @param {string} path @param {string} kind */
function reusableLocalSourceReady(path, kind) {
  const stat = existingNonEmptyFile(path);
  if (!stat) return { ok: false, reason: "local_source_file_missing" };
  if (kind !== "audio" && kind !== "video") return { ok: true, stat };
  const validation = audioSignatureStatus(path);
  return validation.ok ? { ok: true, stat, audioValidation: validation } : { ok: false, reason: validation.reason, audioValidation: validation };
}

/** @param {string} path @param {string} kind @param {string} attachmentsDir */
function discardInvalidCurrentRunAttachment(path, kind, attachmentsDir) {
  const resolved = resolve(path);
  if (!isInside(attachmentsDir, resolved)) return null;
  const stat = existingNonEmptyFile(resolved);
  if (!stat) return null;
  const ready = reusableLocalSourceReady(resolved, kind);
  if (ready.ok) return null;
  try {
    unlinkSync(resolved);
    return { status: "removed_invalid_current_run_attachment", path: resolved, reason: ready.reason, audioValidation: ready.audioValidation ?? null };
  } catch (error) {
    return { status: "remove_invalid_current_run_attachment_failed", path: resolved, reason: ready.reason, error: redactString(error instanceof Error ? error.message : String(error)) };
  }
}

/** @param {unknown} runId */
function isFixtureLikeRunId(runId) {
  return /fixture|mock|dry[_-]?run|fake[_-]?lark/i.test(String(runId ?? ""));
}

/** @param {RunPaths} paths @param {HandlerAttachment} attachment @param {number} index @param {string} fallbackName */
function attachmentTargetPath(paths, attachment, index, fallbackName) {
  const rawName = attachment.name || attachment.fileName || (attachment.localPath ? basename(attachment.localPath) : "") || fallbackName || attachment.fileKey || `attachment_${index}`;
  return resolve(workspaceDir, relative(workspaceDir, join(paths.attachmentsDir, safeSegment(rawName))));
}

/** @param {string} sourcePath @param {string} targetPath */
function linkOrCopyLocalAttachment(sourcePath, targetPath) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const source = resolve(sourcePath);
  const target = resolve(targetPath);
  if (source === target) return "same_path";
  const existing = existingNonEmptyFile(target);
  if (existing) return "existing_target";
  try {
    linkSync(source, target);
    return "hardlink";
  } catch {
    try {
      symlinkSync(relative(dirname(target), source), target);
      return "symlink";
    } catch {
      copyFileSync(source, target);
      return "copy";
    }
  }
}

/** @param {HandlerAttachment} attachment @param {LocalReuseFields} fields */
async function buildLocalReuseAttachment(attachment, fields) {
  const sourceReady = reusableLocalSourceReady(fields.localPath, fields.resourceType);
  if (!sourceReady.ok) {
    return null;
  }
  const sourceStat = existingNonEmptyFile(fields.localPath);
  if (!sourceStat) return null;
  return {
    ...attachment,
    resourceType: fields.resourceType,
    fileKey: fields.fileKey,
    name: fields.name,
    localPath: fields.localPath,
    downloadStatus: fields.downloadStatus,
    reason: fields.reason,
    linkMode: fields.linkMode ?? null,
    reuseSource: fields.reuseSource ?? undefined,
    downloadAs: fields.downloadAs ?? undefined,
    failureClass: fields.failureClass ?? undefined,
    retryable: fields.retryable ?? undefined,
    downloadAttempts: fields.downloadAttempts ?? undefined,
    exitCode: fields.exitCode ?? undefined,
    stderrTail: fields.stderrTail ?? undefined,
    audioValidation: sourceReady.audioValidation ?? undefined,
    sha256: await sha256File(fields.localPath),
    sizeBytes: sourceStat.size,
    rawMediaExternalUpload: false,
  };
}

/** @param {unknown} value */
function resolveWorkspaceCandidatePath(value) {
  if (!value) return null;
  const resolved = isAbsolute(String(value)) ? resolve(String(value)) : resolve(workspaceDir, String(value));
  if (!isInside(workspaceDir, resolved)) return null;
  return existingNonEmptyFile(resolved) ? resolved : null;
}

/** @param {HandlerAttachment} attachment @param {unknown} eventMessageId */
function sourceMessageIdForAttachment(attachment, eventMessageId) {
  return attachment.messageId ?? attachment.sourceMessageId ?? attachment.cacheSourceMessageId ?? eventMessageId ?? "";
}

/** @param {string} kind */
function storeKindForAttachment(kind) {
  return ["audio", "video", "image"].includes(kind) ? "raw_media" : "raw_document_file";
}

/** @param {HandlerAttachment} attachment @param {string} kind @param {string} name @param {string} sourceMessageId @param {HandlerOptions} [options] */
async function findRuntimeStoreAttachmentCandidate(attachment, kind, name, sourceMessageId, options = {}) {
  if (!runtimeStoreCliPath || !existsSync(runtimeStoreCliPath)) return null;
  const fileKey = attachment.fileKey ?? attachment.file_key ?? "";
  const args = [
    runtimeStoreCliPath,
    "find-source",
    "--kind",
    storeKindForAttachment(kind),
    "--limit",
    "10",
  ];
  if (fileKey) args.push("--file-key", String(fileKey));
  if (sourceMessageId) args.push("--source-message-id", String(sourceMessageId));
  if (name) args.push("--name", String(name));
  if (attachment.sha256) args.push("--sha256", String(attachment.sha256));
  const cli = await runCommand("python3", args, { timeoutMs: options.runtimeStoreTimeoutMs ?? 120000 });
  if (cli.exitCode !== 0) {
    return {
      status: "blocked",
      reason: "runtime_store_find_source_failed",
      exitCode: cli.exitCode,
      stderrTail: redactString(cli.stderr).slice(-1000),
    };
  }
  const result = asRecord(parseJsonOutput(cli.stdout));
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  for (const candidateValue of candidates) {
    const candidate = asRecord(candidateValue);
    if (isFixtureLikeRunId(candidate.runId)) continue;
    const candidatePath = resolveWorkspaceCandidatePath(candidate.availablePath ?? candidate.objectPath ?? candidate.path);
    if (!candidatePath) continue;
    if (!reusableLocalSourceReady(candidatePath, kind).ok) continue;
    return {
      status: "found",
      reason: "runtime_store_ready_source",
      localPath: candidatePath,
      source: {
        type: "runtime_store",
        artifactId: candidate.artifactId,
        runId: candidate.runId,
        objectPath: candidate.objectPath ?? null,
        path: candidate.path ?? null,
        sha256: candidate.sha256 ?? null,
        sizeBytes: candidate.sizeBytes ?? null,
      },
    };
  }
  return { status: "missing", reason: "runtime_store_source_not_found" };
}

/** @param {HandlerAttachment} attachment @param {HandlerAttachment} indexedAttachment @param {unknown} expectedName */
function attachmentNamesMatch(attachment, indexedAttachment, expectedName) {
  const expected = safeSegment(expectedName ?? attachment.name ?? attachment.fileName ?? "");
  const values = [
    indexedAttachment.name,
    indexedAttachment.fileName,
    indexedAttachment.localPath ? basename(indexedAttachment.localPath) : "",
    typeof indexedAttachment.sourcePath === "string" ? basename(indexedAttachment.sourcePath) : "",
  ].filter(Boolean).map((value) => safeSegment(value));
  return !expected || values.includes(expected);
}

/** @param {HandlerAttachment} attachment @param {HandlerAttachment} indexedAttachment @param {unknown} expectedName */
function attachmentSourceMatches(attachment, indexedAttachment, expectedName) {
  const fileKey = attachment.fileKey ?? attachment.file_key ?? "";
  const sourceMessageId = attachment.sourceMessageId ?? attachment.messageId ?? attachment.cacheSourceMessageId ?? "";
  const indexedFileKey = indexedAttachment.fileKey ?? indexedAttachment.file_key ?? "";
  const indexedSourceMessageId = indexedAttachment.sourceMessageId ?? indexedAttachment.messageId ?? indexedAttachment.cacheSourceMessageId ?? "";
  const fileKeyMatches = fileKey && indexedFileKey && String(fileKey) === String(indexedFileKey);
  const messageMatches = sourceMessageId && indexedSourceMessageId && String(sourceMessageId) === String(indexedSourceMessageId);
  return fileKeyMatches || messageMatches || (attachmentNamesMatch(attachment, indexedAttachment, expectedName) && (fileKey || sourceMessageId));
}

/** @param {HandlerAttachment} attachment @param {RunPaths} paths @param {string} kind @param {unknown} expectedName @param {HandlerOptions} [options] */
function findHistoricalRunAttachmentCandidate(attachment, paths, kind, expectedName, options = {}) {
  const runsRoot = dirname(paths.runDir);
  if (!isInside(workspaceDir, runsRoot) || !existsSync(runsRoot)) return { status: "missing", reason: "historical_runs_root_missing" };
  const limit = Number(options.historicalAttachmentScanLimit ?? process.env.FEISHU_AGENT_ATTACHMENT_HISTORY_SCAN_LIMIT ?? 500);
  const runDirs = readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = join(runsRoot, entry.name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      return { path, mtimeMs };
    })
    .filter((entry) => resolve(entry.path) !== resolve(paths.runDir))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Math.max(1, limit));
  for (const runDir of runDirs) {
    if (isFixtureLikeRunId(basename(runDir.path))) continue;
    const taskPath = join(runDir.path, "task.json");
    if (!existsSync(taskPath)) continue;
    /** @type {UnknownRecord | null} */
    let task = null;
    try {
      task = asRecord(JSON.parse(readFileSync(taskPath, "utf8")));
    } catch {
      continue;
    }
    const candidates = Array.isArray(task?.attachments) ? task.attachments : [];
    for (const candidateValue of candidates) {
      const candidate = /** @type {HandlerAttachment} */ (asRecord(candidateValue));
      if (!candidate || typeof candidate !== "object") continue;
      if (attachmentKind(candidate) !== kind) continue;
      if (["failed", "blocked", "skipped"].includes(String(candidate.downloadStatus ?? ""))) continue;
      if (!attachmentSourceMatches(attachment, candidate, expectedName)) continue;
      const candidatePath = resolveWorkspaceCandidatePath(candidate.localPath ?? candidate.sourcePath);
      if (!candidatePath) continue;
      if (!reusableLocalSourceReady(candidatePath, kind).ok) continue;
      return {
        status: "found",
        reason: "historical_run_ready_source",
        localPath: candidatePath,
        source: {
          type: "historical_run",
          runId: task.runId ?? basename(runDir.path),
          downloadStatus: candidate.downloadStatus ?? null,
          sha256: candidate.sha256 ?? null,
          sizeBytes: candidate.sizeBytes ?? null,
        },
      };
    }
  }
  return { status: "missing", reason: "historical_run_source_not_found" };
}

/** @param {HandlerAttachment} attachment @param {UnknownRecord & { targetPath: string, sourcePath: string, resourceType: string, fileKey: string, name: string, downloadStatus: string, reason: string }} fields */
async function materializeReusableAttachment(attachment, fields) {
  const targetPath = fields.targetPath;
  const linkMode = linkOrCopyLocalAttachment(fields.sourcePath, targetPath);
  return await buildLocalReuseAttachment(attachment, {
    resourceType: fields.resourceType,
    fileKey: fields.fileKey,
    name: safeSegment(basename(targetPath) || fields.name),
    localPath: targetPath,
    downloadStatus: fields.downloadStatus,
    reason: fields.reason,
    linkMode,
    reuseSource: fields.reuseSource,
    downloadAs: fields.downloadAs,
    failureClass: fields.failureClass,
    retryable: fields.retryable,
    downloadAttempts: fields.downloadAttempts,
    exitCode: fields.exitCode,
    stderrTail: fields.stderrTail,
  });
}

/** @param {HandlerAttachment} attachment @param {RunPaths} paths @param {ReuseSearchOptions} options */
async function findAndMaterializeReusableAttachment(attachment, paths, options) {
  const { kind, name, fileKey, sourceMessageId, index, targetPath, afterCliFailure } = options;
  const storeCandidate = await findRuntimeStoreAttachmentCandidate(attachment, kind, name, sourceMessageId, options);
  if (storeCandidate?.status === "found" && typeof storeCandidate.localPath === "string") {
    return await materializeReusableAttachment(attachment, {
      resourceType: kind,
      fileKey,
      name,
      targetPath,
      sourcePath: storeCandidate.localPath,
      downloadStatus: "local_reuse_store_artifact",
      reason: afterCliFailure ? "runtime_store_reuse_after_cli_failed" : "runtime_store_ready_source_reused_before_download",
      reuseSource: storeCandidate.source,
      downloadAs: options.downloadAs,
      failureClass: options.failureClass,
      retryable: options.retryable,
      downloadAttempts: options.downloadAttempts,
      exitCode: options.exitCode,
      stderrTail: options.stderrTail,
    });
  }
  const historicalCandidate = findHistoricalRunAttachmentCandidate(attachment, paths, kind, name, options);
  if (historicalCandidate?.status === "found" && typeof historicalCandidate.localPath === "string") {
    return await materializeReusableAttachment(attachment, {
      resourceType: kind,
      fileKey,
      name,
      targetPath,
      sourcePath: historicalCandidate.localPath,
      downloadStatus: "local_reuse_historical_run_artifact",
      reason: afterCliFailure ? "historical_run_reuse_after_cli_failed" : "historical_run_ready_source_reused_before_download",
      reuseSource: historicalCandidate.source,
      downloadAs: options.downloadAs,
      failureClass: options.failureClass,
      retryable: options.retryable,
      downloadAttempts: options.downloadAttempts,
      exitCode: options.exitCode,
      stderrTail: options.stderrTail,
    });
  }
  return {
    status: "missing",
    reason: "long_term_attachment_reuse_miss",
    index,
    storeReason: storeCandidate?.reason ?? null,
    historicalReason: historicalCandidate?.reason ?? null,
  };
}

/** @param {{ sourceMessageId: string, fileKey: string, kind: string, outputRelative: string, localPath: string, options: HandlerOptions }} input */
async function downloadImResourceWithRetry({ sourceMessageId, fileKey, kind, outputRelative, localPath, options }) {
  const identities = parseAttachmentDownloadIdentities(options.attachmentDownloadAs);
  const maxAttempts = attachmentDownloadMaxAttempts(options);
  const timeoutMs = attachmentDownloadTimeoutMs(options);
  /** @type {UnknownRecord[]} */
  const attempts = [];
  let lastFailure = {
    failureClass: "attachment_download_failed",
    retryable: true,
    userMessage: "音频附件下载失败，已尝试复用本地缓存和重试下载但仍未拿到本地文件。",
  };
  for (const identity of identities) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const command = ["im", "+messages-resources-download", "--as", identity, "--message-id", sourceMessageId, "--file-key", fileKey, "--type", kind === "image" ? "image" : "file", "--output", outputRelative];
      const cli = await runCommand("lark-cli", command, { timeoutMs });
      const stat = existingNonEmptyFile(localPath);
      const ready = stat ? reusableLocalSourceReady(localPath, kind) : null;
      if (cli.exitCode === 0 && stat && ready?.ok) {
        const failureAttemptCount = attempts.length;
        attempts.push({
          identity,
          attempt,
          exitCode: cli.exitCode,
          signal: cli.signal ?? null,
          timedOut: Boolean(cli.timedOut),
          failureClass: null,
          retryable: false,
          status: "success",
          stderrTail: redactString(cli.stderr).slice(-1200),
        });
        return {
          ok: true,
          identity,
          attempts,
          cli,
          command,
          status: identity === identities[0] && failureAttemptCount === 0
            ? "downloaded"
            : identity === identities[0]
              ? "downloaded_after_retry"
              : "downloaded_identity_fallback",
          reason: identity === identities[0] && failureAttemptCount === 0
            ? null
            : identity === identities[0]
              ? "download_retry_after_previous_failure"
              : "download_identity_fallback_after_previous_failure",
          stat,
        };
      }
      lastFailure = cli.exitCode === 0 && stat && ready && !ready.ok
        ? {
            failureClass: ready.reason ?? "downloaded_audio_validation_failed",
            retryable: true,
            userMessage: "音频附件已下载但本地文件校验失败，正在重新尝试获取。",
          }
        : classifyFeishuImResourceDownloadFailure(cli);
      attempts.push({
        identity,
        attempt,
        exitCode: cli.exitCode,
        signal: cli.signal ?? null,
        timedOut: Boolean(cli.timedOut),
        failureClass: lastFailure.failureClass,
        retryable: lastFailure.retryable,
        status: "failed",
        audioValidation: ready?.audioValidation ?? null,
        stderrTail: redactString(cli.stderr).slice(-1200),
      });
      if (stat && ready?.ok) {
        return {
          ok: false,
          identity,
          attempts,
          cli,
          command,
          existingTargetReady: true,
          failure: lastFailure,
          stat,
        };
      }
      if (!lastFailure.retryable) break;
    }
  }
  return {
    ok: false,
    identity: attempts.at(-1)?.identity ?? identities[0] ?? "bot",
    attempts,
    failure: lastFailure,
    cli: {
      exitCode: attempts.at(-1)?.exitCode ?? 1,
      stderr: attempts.at(-1)?.stderrTail ?? "",
      timedOut: attempts.at(-1)?.timedOut ?? false,
      signal: attempts.at(-1)?.signal ?? null,
    },
  };
}

/** @param {HandlerEvent} event @param {RunPaths} paths @param {HandlerOptions} options @returns {Promise<HandlerAttachment[]>} */
async function downloadAttachments(event, paths, options) {
  mkdirSync(paths.attachmentsDir, { recursive: true });
  const messageId = event.message?.messageId;
  const attachments = event.message?.attachments ?? [];
  /** @type {HandlerAttachment[]} */
  const results = [];
  for (const [index, attachmentValue] of attachments.entries()) {
    const attachment = /** @type {HandlerAttachment} */ (asRecord(attachmentValue));
    const kind = attachmentKind(attachment);
    const name = safeSegment(attachment.name || attachment.fileKey || `attachment_${index}`);
    const fileKey = attachment.fileKey ?? attachment.file_key ?? "";
    const sourceMessageId = String(attachment.messageId ?? attachment.sourceMessageId ?? attachment.cacheSourceMessageId ?? messageId ?? "");
    if (attachment.localPath && attachment.sourceReady !== false && !["failed", "blocked"].includes(String(attachment.downloadStatus ?? ""))) {
      const sourceLocalPath = resolve(attachment.localPath);
      const sourceStat = existingNonEmptyFile(sourceLocalPath);
      if (!sourceStat) {
        results.push({
          ...attachment,
          resourceType: kind,
          fileKey,
          name,
          localPath: sourceLocalPath,
          downloadStatus: "blocked",
          reason: "local_attachment_missing",
          sha256: null,
          sizeBytes: null,
          rawMediaExternalUpload: false,
        });
        continue;
      }
      const targetPath = attachmentTargetPath(paths, attachment, index, name);
      const alreadyInCurrentRun = isInside(paths.attachmentsDir, sourceLocalPath);
      const currentTarget = existingNonEmptyFile(targetPath);
      const localPath = alreadyInCurrentRun ? sourceLocalPath : targetPath;
      const linkMode = alreadyInCurrentRun ? "same_path" : currentTarget ? "existing_target" : linkOrCopyLocalAttachment(sourceLocalPath, targetPath);
      const cachedReuse = await buildLocalReuseAttachment(attachment, {
        resourceType: kind,
        fileKey,
        name: safeSegment(basename(localPath) || name),
        localPath,
        downloadStatus: alreadyInCurrentRun ? "local" : "local_reuse_cached_attachment",
        reason: alreadyInCurrentRun ? "fixture_or_local_attachment" : "recent_attachment_cache_local_path_reused",
        linkMode,
      });
      if (cachedReuse) {
        results.push(cachedReuse);
        continue;
      }
    }
    if (attachment.explicitFileReference && attachment.fileToken) {
      const token = String(attachment.fileToken);
      const markdownPath = resolve(workspaceDir, relative(workspaceDir, join(paths.attachmentsDir, safeSegment(`${name}.md`))));
      const exportSpec = exportFormatForExplicitFile(attachment);
      const exportExt = exportSpec?.extension === "xlsx" ? "xlsx" : exportSpec?.extension === "base" ? "json" : "md";
      const exportName = safeSegment(`${name}.${exportExt}`);
      const exportPath = resolve(workspaceDir, relative(workspaceDir, join(paths.attachmentsDir, exportName)));
      if (options.dryRun) {
        results.push({
          ...attachment,
          resourceType: "file",
          fileKey,
          name,
          localPath: markdownPath,
          downloadStatus: "skipped",
          reason: "dry_run_explicit_file_download_not_executed",
          plannedCommands: [
            ["lark-cli", "markdown", "+fetch", "--as", "bot", "--file-token", token, "--output", relative(workspaceDir, markdownPath), "--overwrite"],
            exportSpec
              ? ["lark-cli", "drive", "+export", "--as", "bot", "--token", token, "--doc-type", exportSpec.docType, "--file-extension", exportSpec.extension, "--output-dir", relative(workspaceDir, paths.attachmentsDir), "--file-name", exportName, "--overwrite"]
              : ["lark-cli", "drive", "+download", "--as", "bot", "--file-token", token, "--output", relative(workspaceDir, exportPath), "--overwrite"],
          ],
          rawMediaExternalUpload: false,
        });
        continue;
      }
      let localPath = markdownPath;
      let cli = await runCommand("lark-cli", ["markdown", "+fetch", "--as", "bot", "--file-token", token, "--output", relative(workspaceDir, markdownPath), "--overwrite"], { timeoutMs: options.cliTimeoutMs ?? 120000 });
      let ok = cli.exitCode === 0 && existsSync(markdownPath);
      let downloadMethod = "markdown_fetch";
      let fallbackCli = null;
      if (!ok && exportSpec) {
        fallbackCli = await runCommand("lark-cli", ["drive", "+export", "--as", "bot", "--token", token, "--doc-type", exportSpec.docType, "--file-extension", exportSpec.extension, "--output-dir", relative(workspaceDir, paths.attachmentsDir), "--file-name", exportName, "--overwrite"], { timeoutMs: options.cliTimeoutMs ?? 120000 });
        localPath = exportPath;
        ok = fallbackCli.exitCode === 0 && existsSync(exportPath);
        downloadMethod = "drive_export";
      }
      if (!ok && !exportSpec) {
        fallbackCli = await runCommand("lark-cli", ["drive", "+download", "--as", "bot", "--file-token", token, "--output", relative(workspaceDir, exportPath), "--overwrite"], { timeoutMs: options.cliTimeoutMs ?? 120000 });
        localPath = exportPath;
        ok = fallbackCli.exitCode === 0 && existsSync(exportPath);
        downloadMethod = "drive_download";
      }
      const stat = ok ? statSync(localPath) : null;
      const failedCli = fallbackCli ?? cli;
      const failure = ok ? null : classifyFeishuFileReadFailure(failedCli.stderr);
      results.push({
        ...attachment,
        resourceType: "file",
        fileKey,
        name: ok ? safeSegment(basename(localPath)) : name,
        localPath,
        downloadStatus: ok ? "downloaded" : "failed",
        reason: ok ? null : failure?.reason ?? "explicit_feishu_file_unreadable",
        errorCode: failure?.errorCode ?? null,
        requiredScopes: failure?.requiredScopes ?? [],
        userMessage: failure?.userMessage ?? null,
        downloadMethod,
        exitCode: ok ? 0 : failedCli.exitCode,
        stderrTail: redactString(failedCli.stderr).slice(-2000),
        sha256: ok ? await sha256File(localPath) : null,
        sizeBytes: stat?.size ?? null,
        rawMediaExternalUpload: false,
      });
      continue;
    }
    const outputRelative = relative(workspaceDir, join(paths.attachmentsDir, name));
    const localPath = resolve(workspaceDir, outputRelative);
    const currentReuse = await buildLocalReuseAttachment(attachment, {
      resourceType: kind,
      fileKey,
      name,
      localPath,
      downloadStatus: "local_reuse_current_run",
      reason: "target_file_already_exists_before_download",
      linkMode: "same_path",
    });
    if (currentReuse) {
      results.push(currentReuse);
      continue;
    }
    const discardedInvalidTarget = discardInvalidCurrentRunAttachment(localPath, kind, paths.attachmentsDir);
    const longTermReuse = await findAndMaterializeReusableAttachment(attachment, paths, {
      ...options,
      kind,
      name,
      fileKey,
      sourceMessageId,
      index,
      targetPath: localPath,
      afterCliFailure: false,
      discardedInvalidTarget,
    });
    if (longTermReuse && "localPath" in longTermReuse && typeof longTermReuse.localPath === "string") {
      results.push(longTermReuse);
      continue;
    }
    if (options.dryRun) {
      const plannedIdentities = parseAttachmentDownloadIdentities(options.attachmentDownloadAs);
      results.push({
        ...attachment,
        resourceType: kind,
        fileKey,
        name,
        localPath,
        downloadStatus: "skipped",
        reason: "dry_run_download_not_executed",
        plannedCommand: ["lark-cli", "im", "+messages-resources-download", "--as", plannedIdentities[0], "--message-id", sourceMessageId, "--file-key", fileKey, "--type", kind === "image" ? "image" : "file", "--output", outputRelative],
        plannedDownloadIdentities: plannedIdentities,
        rawMediaExternalUpload: false,
      });
      continue;
    }
    if (!sourceMessageId || !fileKey) {
      results.push({ ...attachment, resourceType: kind, downloadStatus: "blocked", reason: "message_id_or_file_key_missing", rawMediaExternalUpload: false });
      continue;
    }
    const downloaded = await downloadImResourceWithRetry({ sourceMessageId, fileKey, kind, outputRelative, localPath, options });
    if (!downloaded.ok) {
      const fallbackReuse = await buildLocalReuseAttachment(attachment, {
        resourceType: kind,
        fileKey,
        name,
        localPath,
        downloadStatus: "local_reuse_after_cli_failed",
        reason: "cli_failed_existing_target_reused",
        linkMode: "same_path",
        downloadAs: downloaded.identity,
        failureClass: downloaded.failure?.failureClass,
        retryable: downloaded.failure?.retryable,
        downloadAttempts: downloaded.attempts,
        exitCode: downloaded.cli.exitCode,
        stderrTail: redactString(downloaded.cli.stderr).slice(-2000),
      });
      if (fallbackReuse) {
        results.push(fallbackReuse);
        continue;
      }
      const postFailureReuse = await findAndMaterializeReusableAttachment(attachment, paths, {
        ...options,
        kind,
        name,
        fileKey,
        sourceMessageId,
        index,
        targetPath: localPath,
        afterCliFailure: true,
        downloadAs: downloaded.identity,
        failureClass: downloaded.failure?.failureClass,
        retryable: downloaded.failure?.retryable,
        downloadAttempts: downloaded.attempts,
        exitCode: downloaded.cli.exitCode,
        stderrTail: redactString(downloaded.cli.stderr).slice(-2000),
      });
      if (postFailureReuse && "localPath" in postFailureReuse && typeof postFailureReuse.localPath === "string") {
        results.push(postFailureReuse);
        continue;
      }
    }
    if (downloaded.existingTargetReady) {
      const fallbackReuse = await buildLocalReuseAttachment(attachment, {
        resourceType: kind,
        fileKey,
        name,
        localPath,
        downloadStatus: "local_reuse_after_cli_failed",
        reason: "cli_failed_existing_target_reused",
        linkMode: "same_path",
        downloadAs: downloaded.identity,
        failureClass: downloaded.failure?.failureClass,
        retryable: downloaded.failure?.retryable,
        downloadAttempts: downloaded.attempts,
        exitCode: downloaded.cli.exitCode,
        stderrTail: redactString(downloaded.cli.stderr).slice(-2000),
      });
      if (fallbackReuse) {
        results.push(fallbackReuse);
        continue;
      }
    }
    const stat = downloaded.ok ? downloaded.stat : null;
    results.push(/** @type {HandlerAttachment} */ ({
      ...attachment,
      resourceType: kind,
      fileKey,
      name,
      localPath,
      downloadStatus: downloaded.ok ? downloaded.status : "failed",
      reason: downloaded.ok ? downloaded.reason : downloaded.failure?.failureClass ?? "attachment_download_failed",
      downloadAs: downloaded.identity,
      failureClass: downloaded.ok ? null : downloaded.failure?.failureClass ?? "attachment_download_failed",
      retryable: downloaded.ok ? undefined : downloaded.failure?.retryable ?? true,
      userMessage: downloaded.ok ? undefined : downloaded.failure?.userMessage,
      downloadAttempts: downloaded.attempts,
      exitCode: downloaded.cli.exitCode,
      stderrTail: redactString(downloaded.cli.stderr).slice(-2000),
      sha256: downloaded.ok ? await sha256File(localPath) : null,
      sizeBytes: stat?.size ?? null,
      rawMediaExternalUpload: false,
    }));
  }
  return results;
}

/** @param {unknown} value */
function xmlDecode(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** @param {HandlerTask} task @param {RunPaths} paths */
function buildAgentTaskMarkdown(task, paths) {
  const taskJson = JSON.stringify(task, null, 2);
  return [
    "# Feishu Agent Task",
    "",
    "你是本地 PI meeting-agent runtime。请按以下真实链路处理，不要绕过模块：",
    "",
    "1. 调用 Adaptive Execution Ledger，基于 Feishu inbound 事件、附件和用户文本建立权威任务状态并选择 capability。",
    "2. 通过 Capability Registry 选择 `feishu-agent-bridge`、`local-asr`、`meeting-minutes`、`doc-writer`、`document-worker-runtime`、`model-fallback` 等需要的能力。",
    "3. 若附件是云端 ASR 支持的音频或视频容器，优先使用 cloud ASR，并在转录后运行 Meeting Intelligence：生成 participant map、meeting profile、topic map、evidence map 和 agent plan。会议内容可由所选能力使用，但凭证、OSS 签名、Cookie 和 Authorization 不得进入模型。图片理解仍不支持。",
    "4. 若附件是 PDF/Word/Excel/Markdown/TXT/CSV 等文本型文件，可作为 file-context 发送给 LLM；若 provider 不支持原生文件输入，使用 file-context 的 extractedTextPath/contextPreview 做渐进披露。",
    "5. 短任务（如一句话总结）只需要返回 `summary`，`documents` 可为空；不要启动长文档 worker pool。",
    "6. 长文档执行走 document router -> Meeting Intelligence/Context -> document-prompt-registry -> document workers；章节内容和议题深度由当前证据与 agent plan 决定，不得硬编码行业议题。",
    "7. 生成结果必须运行 QA Gate 和 Policy Gate。Feishu 用户已明确请求创建、发布、保存、放到云端或修改时，非删除类 `write_private`/`publish_customer_visible` 可以视为已授权；QA blocking/needs_fix 或 Policy blocked 时不得发布。",
    "8. 删除、清空、移除、销毁类动作始终不支持，`summary` 必须直接写：目前暂不支持该功能。",
    "9. 用户请求当前不支持的能力时，`summary` 必须直接写：目前暂不支持该功能。",
    "10. 将最终机器可读 manifest 写入下面的 `agent-output.json` 路径。",
    "",
    "## Required output file",
    "",
    paths.agentOutputPath,
    "",
    "## Required manifest shape",
    "",
    "```json",
    JSON.stringify({
      status: "completed|needs_fix|blocked|failed",
      summary: "short Chinese summary",
      documents: [{ docType: "meeting-minutes", title: "title", fileName: "title.md", markdown: "# title\\n..." }],
      qaGate: { status: "pass|needs_fix|blocked", publishAllowed: true },
      policyGate: { status: "pass|needs_confirmation|blocked", actionIntent: "publish_customer_visible" },
      artifacts: [],
      rawSecretsReturned: false,
      rawMediaExternalUpload: false,
    }, null, 2),
    "```",
    "",
    "## Feishu task input",
    "",
    "```json",
    taskJson,
    "```",
  ].join("\n");
}

/** @param {HandlerTask} task @returns {AgentOutput} */
function createMockAgentOutput(task) {
  if (task.taskIntent?.responseMode === "unsupported") {
    return createImmediateAgentOutput(task);
  }
  if (task.taskIntent?.responseMode === "needs_file" || task.taskIntent?.responseMode === "ack_file_cached") {
    return createImmediateAgentOutput(task);
  }
  if (task.taskIntent?.responseMode === "direct_answer") {
    return {
      status: "completed",
      summary: task.fileContexts?.contexts?.length
        ? `mock direct answer for ${task.fileContexts.contexts.map((context) => context.fileName).join(", ")}`
        : "mock direct answer completed",
      documents: [],
      qaGate: { status: "pass", publishAllowed: false, issues: [] },
      policyGate: { status: "pass", actionIntent: "draft", reasons: ["mock_direct_answer_no_publish"] },
      artifacts: [],
      rawSecretsReturned: false,
      rawMediaExternalUpload: false,
    };
  }
  const title = `Feishu Agent Dry Run - ${task.runId}`;
  const docs = task.taskIntent.requestedDocuments.map((docType) => ({
    docType,
    title: `${title} - ${docType}`,
    fileName: `${safeSegment(docType)}-${safeSegment(task.runId)}.md`,
    markdown: [
      `# ${title} - ${docType}`,
      "",
      "## 已确认事实",
      "",
      "- 已收到 Feishu 事件，并生成本地 run artifact。",
      "- 本次为 mock agent QA 路径，不外发原始媒体。",
      "",
      "## 推断",
      "",
      "- 真实执行模式会调用 PI package 的 planner、prompt registry、document workers、QA Gate 和 Policy Gate。",
      "",
      "## 待确认",
      "",
      "- 真实 Feishu auth、目标 folder token、发布权限需要 live smoke 验证。",
    ].join("\n"),
  }));
  return {
    status: "completed",
    summary: "mock agent completed; no raw media uploaded",
    documents: docs,
    qaGate: { status: "pass", publishAllowed: true, issues: [] },
    policyGate: { status: "pass", actionIntent: "publish_customer_visible", reasons: ["mock_agent_dry_run_policy_pass"] },
    artifacts: [],
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  };
}

/** @param {HandlerTask} task @returns {AgentOutput} */
function createImmediateAgentOutput(task) {
  const mode = task.taskIntent?.responseMode;
  const taskIntent = asRecord(task.taskIntent);
  const summary = task.taskIntent?.immediateResponse ?? (mode === "unsupported" ? UNSUPPORTED_FEATURE_REPLY : "");
  const status = mode === "unsupported" ? "blocked" : "completed";
  return {
    status,
    summary,
    documents: [],
    qaGate: {
      status: mode === "unsupported" ? "blocked" : "pass",
      publishAllowed: false,
      issues: mode === "unsupported" ? [String(taskIntent.unsupportedReason ?? "unsupported")] : [],
    },
    policyGate: { status: "pass", actionIntent: "draft", reasons: ["immediate_handler_response_no_publish"] },
    artifacts: [],
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  };
}

/** @param {HandlerAttachment[]} [attachments] */
function firstAttachmentDownloadFailure(attachments = []) {
  return (attachments ?? []).find((item) => item.downloadStatus === "failed" || item.downloadStatus === "blocked") ?? null;
}

/** @param {string} reason @param {HandlerAttachment[]} [attachments] */
function sourceAcquisitionFailureSummary(reason, attachments = []) {
  if (reason === "attachment_download_failed") {
    const failed = firstAttachmentDownloadFailure(attachments);
    const classified = failed?.failureClass
      ? { userMessage: failed.userMessage ?? classifyFeishuImResourceDownloadFailure({ stderr: failed.stderrTail, exitCode: failed.exitCode }).userMessage }
      : failed?.stderrTail
        ? classifyFeishuImResourceDownloadFailure({ stderr: failed.stderrTail, exitCode: failed.exitCode })
        : { userMessage: "Feishu 下载超时或网络异常" };
    const detail = String(classified.userMessage ?? "Feishu 下载超时或网络异常").replace(/[。.\s]+$/u, "");
    return `音视频附件下载失败，暂时无法转写。已尝试复用本地缓存但未命中。失败原因：${detail}。`;
  }
  if (reason === "local_source_file_missing") {
    return "音视频本地文件不可读，暂时无法转写。请重新上传文件或稍后重试。";
  }
  return "音视频 source acquisition 未通过，暂时无法转写。";
}

/** @param {HandlerTask} task @param {HandlerAttachment[]} attachments @param {unknown} fileContextsValue */
function sourceAcquisitionGate(task, attachments, fileContextsValue) {
  const fileContexts = asRecord(fileContextsValue);
  if (task.taskIntent?.executionProfile !== "audio_minutes" && task.taskIntent?.requiresLocalAsr !== true) {
    return { status: "pass", reason: "not_audio_minutes" };
  }
  const audioAttachments = (attachments ?? []).filter((item) => ["audio", "video"].includes(attachmentKind(item)));
  if (audioAttachments.length === 0) return { status: "blocked", reason: "local_source_file_missing", audioAttachmentCount: 0 };
  const sourceChecks = audioAttachments.map((item) => {
    const localPath = item.localPath ? resolve(item.localPath) : null;
    const ready = localPath ? reusableLocalSourceReady(localPath, attachmentKind(item)) : { ok: false, reason: "local_source_file_missing" };
    return { attachment: item, localPath, ready };
  });
  const readable = sourceChecks.filter((item) => item.ready.ok);
  if (readable.length > 0) return { status: "pass", reason: "audio_sources_ready", audioAttachmentCount: audioAttachments.length, readableAudioCount: readable.length };
  const failed = audioAttachments.some((item) => item.downloadStatus === "failed" || item.downloadStatus === "blocked");
  const firstFailure = firstAttachmentDownloadFailure(audioAttachments);
  const contextStatuses = Array.isArray(fileContexts?.contexts) ? fileContexts.contexts.map((item) => item.status) : [];
  const firstInvalidSource = sourceChecks.find((item) => item.localPath && !item.ready.ok);
  return {
    status: "blocked",
    reason: failed ? "attachment_download_failed" : "local_source_file_missing",
    failureClass: firstFailure?.failureClass ?? firstInvalidSource?.ready?.reason ?? (failed ? "attachment_download_failed" : "local_source_file_missing"),
    retryable: firstFailure?.retryable ?? true,
    downloadAs: firstFailure?.downloadAs ?? null,
    downloadAttempts: firstFailure?.downloadAttempts ?? [],
    failedAttachmentName: firstFailure?.name ?? null,
    failedFileKey: firstFailure?.fileKey ?? firstFailure?.file_key ?? null,
    failedSourceMessageId: firstFailure?.sourceMessageId ?? firstFailure?.messageId ?? firstFailure?.cacheSourceMessageId ?? null,
    audioAttachmentCount: audioAttachments.length,
    readableAudioCount: 0,
    attachmentStatuses: audioAttachments.map((item) => item.downloadStatus ?? "unknown"),
    fileContextStatuses: contextStatuses,
    audioValidation: firstInvalidSource?.ready?.audioValidation ?? null,
    rawMediaExternalUpload: false,
  };
}

/** @param {HandlerTask} task @param {UnknownRecord & {reason: string}} gate @param {HandlerAttachment[]} attachments @returns {AgentOutput} */
function createSourceAcquisitionBlockedOutput(task, gate, attachments) {
  const summary = sourceAcquisitionFailureSummary(gate.reason, attachments);
  const failureClass = gate.failureClass ?? gate.reason;
  return {
    status: "blocked",
    summary,
    finalFailureReport: {
      terminalReason: failureClass,
      sourceAcquisitionReason: gate.reason,
      failureClass,
      downloadAs: gate.downloadAs ?? null,
      downloadAttempts: gate.downloadAttempts ?? [],
      nextAction: gate.reason === "attachment_download_failed"
        ? "等待 Feishu 下载恢复后重试，或重新上传音频；如果 bot 下载失败，可由本机 user 登录态兜底。"
        : "重新上传音频或确认本地 source 文件仍存在。",
      retryable: gate.retryable ?? true,
    },
    documents: [],
    qaGate: {
      status: "blocked",
      publishAllowed: false,
      issues: [...new Set([gate.reason, failureClass].filter(Boolean))],
    },
    policyGate: {
      status: "pass",
      actionIntent: "draft",
      reasons: ["source_acquisition_blocked_before_model_or_publish"],
    },
    artifacts: [],
    details: {
      ...gate,
      sourceAcquisitionGate: true,
      taskType: task.taskIntent?.taskType ?? null,
      executionProfile: task.taskIntent?.executionProfile ?? null,
      rawMediaExternalUpload: false,
    },
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  };
}

/** @param {HandlerTask} task @param {RunPaths} paths @param {HandlerOptions} options */
/** @param {HandlerTask} task @param {RunPaths} paths @param {HandlerOptions} options @returns {Promise<AgentRun>} */
async function runPiAgent(task, paths, options) {
  writeText(paths.agentTaskPath, buildAgentTaskMarkdown(task, paths));
  if (task.taskIntent?.immediateResponse) {
    const output = createImmediateAgentOutput(task);
    writeJson(paths.agentOutputPath, output);
    return { status: output.status, output, mode: "immediate", rawSecretsReturned: false };
  }
  if (options.executionMode === "mock") {
    const output = createMockAgentOutput(task);
    writeJson(paths.agentOutputPath, output);
    return { status: "completed", output, mode: "mock", rawSecretsReturned: false };
  }
  const sessionDir = resolve(process.env.PI_CODING_AGENT_DIR ?? "/private/tmp/assignment-agent-pi-feishu");
  const piCliBin = options.piCliBin ?? process.env.PI_CLI_BIN ?? "pi";
  const baseCommand = [
    "--no-session",
    "--session-dir",
    sessionDir,
    "-e",
    packageDir,
    "-p",
    `@${paths.agentTaskPath}`,
  ];
  /** @type {Array<UnknownRecord & {name: string, provider: string | null, model: string | null, piCliBin: string, exitCode: number, failureClass: string | null, stdout: string, stderr: string}>} */
  const attempts = [];
  /** @param {string | null} provider @param {string | null} model */
  const commandFor = (provider, model) => [
    ...(provider ? ["--provider", provider] : []),
    ...(model ? ["--model", model] : []),
    ...baseCommand,
  ];
  /** @param {CommandResult} result */
  const classifyPiFailure = (result) => {
    const text = `${result.stderr}\n${result.stdout}`;
    if (/Unknown provider/i.test(text)) return "provider_cli_unsupported";
    if (/\b402\b|insufficient balance|quota|billing/i.test(text)) return "quota_or_billing";
    if (/\b403\b|forbidden|Request not allowed|membership/i.test(text)) return "auth_or_membership_blocked";
    if (result.exitCode === 127) return "pi_cli_not_found";
    if (result.timedOut) return "pi_cli_timeout";
    return "pi_cli_failed";
  };
  /** @param {string} name @param {NodeJS.ProcessEnv} [env] */
  const runAttempt = async (name, env = {}) => {
    const provider = env.PI_PROVIDER ?? process.env.PI_PROVIDER ?? null;
    const model = env.PI_MODEL ?? process.env.PI_MODEL ?? null;
    const result = await runCommand(piCliBin, commandFor(provider, model), {
      cwd: workspaceDir,
      timeoutMs: options.piTimeoutMs ?? 900000,
      env: { PI_CODING_AGENT_DIR: sessionDir, ...env },
    });
    attempts.push({
      name,
      provider,
      model,
      piCliBin: piCliBin === "pi" ? "pi" : piCliBin,
      exitCode: result.exitCode,
      failureClass: result.exitCode === 0 ? null : classifyPiFailure(result),
      stdout: result.stdout,
      stderr: result.stderr,
    });
    return result;
  };
  let pi = await runAttempt("primary");
  const reviewProvider = process.env.PI_REVIEW_PROVIDER;
  const reviewModel = process.env.PI_REVIEW_MODEL;
  const primaryDenied = /403|forbidden|Request not allowed|Unknown provider|402|quota|billing|membership/i.test(`${pi.stderr}\n${pi.stdout}`) || pi.exitCode !== 0;
  const reviewIsDifferent = reviewProvider && reviewModel && (reviewProvider !== process.env.PI_PROVIDER || reviewModel !== process.env.PI_MODEL);
  if (!existsSync(paths.agentOutputPath) && primaryDenied && reviewIsDifferent) {
    pi = await runAttempt("review_fallback", { PI_PROVIDER: reviewProvider, PI_MODEL: reviewModel });
  }
  writeText(paths.stdoutPath, attempts.map((attempt) => `## ${attempt.name} ${attempt.provider ?? "unknown"}/${attempt.model ?? "unknown"}\n${redactString(attempt.stdout)}`).join("\n\n"));
  writeText(paths.stderrPath, attempts.map((attempt) => `## ${attempt.name} ${attempt.provider ?? "unknown"}/${attempt.model ?? "unknown"} exit=${attempt.exitCode}\n${redactString(attempt.stderr)}`).join("\n\n"));
  if (!existsSync(paths.agentOutputPath)) {
    const output = {
      status: "blocked",
      summary: "PI agent did not write agent-output.json",
      piExitCode: pi.exitCode,
      piAttempts: attempts.map((attempt) => ({
        name: attempt.name,
        provider: attempt.provider,
        model: attempt.model,
        piCliBin: attempt.piCliBin,
        exitCode: attempt.exitCode,
        failureClass: attempt.failureClass,
        stdoutTail: redactString(attempt.stdout).slice(-2000),
        stderrTail: redactString(attempt.stderr).slice(-2000),
      })),
      rawSecretsReturned: false,
      rawMediaExternalUpload: false,
    };
    writeJson(paths.agentOutputPath, output);
    return { status: "blocked", output, mode: "execute", rawSecretsReturned: false };
  }
  const output = /** @type {AgentOutput} */ (asRecord(sanitize(JSON.parse(readFileSync(paths.agentOutputPath, "utf8")))));
  return { status: pi.exitCode === 0 ? "completed" : "failed", output, mode: "execute", rawSecretsReturned: false };
}

/** @param {AgentOutput} output */
function qaAllowsPublish(output) {
  const qa = asRecord(output.qaGate);
  return qa.publishAllowed === true || qa.status === "pass" || qa.status === "ready";
}

/** @param {AgentOutput} output */
function policyAllowsPublish(output) {
  const policy = asRecord(output.policyGate);
  return policy.status === "pass";
}

/** @param {HandlerTask} task @param {boolean} hasDocuments */
function feishuUserWriteAllowed(task, hasDocuments) {
  const prompt = cleanUserPrompt(task.sourceEvent?.message?.text ?? "");
  if (DESTRUCTIVE_REQUEST_PATTERN.test(prompt)) return false;
  if (hasDocuments) return true;
  return PUBLISH_REQUEST_PATTERN.test(prompt) || MODIFY_REQUEST_PATTERN.test(prompt);
}

/** @param {RunPaths} paths */
function publishTargetRegistryPath(paths) {
  return join(dirname(dirname(paths.runDir)), "feishu-publish-targets.json");
}

/** @param {RunPaths} paths @returns {PublishTargetRegistry} */
function loadPublishTargetRegistry(paths) {
  const path = publishTargetRegistryPath(paths);
  if (!existsSync(path)) {
    return {
      schemaVersion: "feishu-publish-target-registry-v2",
      entries: {},
      projectEntries: {},
      legacySessionMappings: {},
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
      schemaVersion: "feishu-publish-target-registry-v2",
      entries: /** @type {Record<string, UnknownRecord>} */ (asRecord(parsed?.entries)),
      projectEntries: /** @type {Record<string, UnknownRecord>} */ (asRecord(parsed?.projectEntries)),
      legacySessionMappings: /** @type {Record<string, UnknownRecord>} */ (asRecord(parsed?.legacySessionMappings)),
    };
  } catch {
    return {
      schemaVersion: "feishu-publish-target-registry-v2",
      entries: {},
      projectEntries: {},
      legacySessionMappings: {},
    };
  }
}

/** @param {RunPaths} paths @param {PublishTargetRegistry} registry */
function savePublishTargetRegistry(paths, registry) {
  writeJson(publishTargetRegistryPath(paths), {
    schemaVersion: "feishu-publish-target-registry-v2",
    updatedAt: nowIso(),
    entries: registry.entries ?? {},
    projectEntries: registry.projectEntries ?? {},
    legacySessionMappings: registry.legacySessionMappings ?? {},
    rawSecretsReturned: false,
  });
}

/** @param {HandlerTask} task */
function sessionPublishKey(task) {
  const message = task.sourceEvent?.message ?? {};
  const seed = [
    message.chatId || "unknown_chat",
    message.threadId || message.rootId || message.parentId || message.chatId || "default_thread",
  ].join(":");
  return hashText(seed).slice(0, 20);
}

/** @param {unknown} text */
function extractFeishuFileToken(text) {
  const value = String(text ?? "");
  const explicit = value.match(/(?:file[_\s-]?token|obj[_\s-]?token|token)\s*[:=：]\s*([A-Za-z0-9_-]{8,})/i);
  if (explicit) return explicit[1];
  const query = value.match(/[?&](?:file_token|obj_token|token)=([A-Za-z0-9_-]{8,})/i);
  if (query) return query[1];
  const pathToken = value.match(/\/(?:docx?|wiki|file|mindnotes|sheets?|base)\/([A-Za-z0-9_-]{10,})/i);
  if (pathToken) return pathToken[1];
  return null;
}

/** @param {HandlerTask} task @param {AgentOutput} agentOutput @param {PublishResult} publish */
function userFacingSummary(task, agentOutput, publish) {
  const details = asRecord(agentOutput.details);
  if (task.taskIntent?.immediateResponse) return task.taskIntent.immediateResponse;
  if (details.sourceAcquisitionGate === true && typeof agentOutput.summary === "string") {
    return agentOutput.summary.trim();
  }
  const finalFailureReport = asRecord(details.finalFailureReport ?? agentOutput.finalFailureReport);
  if (Object.keys(finalFailureReport).length > 0 && ["blocked", "failed", "needs_fix"].includes(String(agentOutput.status ?? ""))) {
    const reason = userFacingFailureReason(finalFailureReport);
    const pendingDocs = Array.isArray(finalFailureReport.pendingDocs)
      ? finalFailureReport.pendingDocs
          .map((docValue) => {
            const doc = asRecord(docValue);
            return `${String(doc.docType ?? "document")}${Array.isArray(doc.missingSections) && doc.missingSections.length ? ` 缺失 ${doc.missingSections.length} 个章节` : ""}`;
          })
          .slice(0, 3)
          .join("；")
      : "";
    const retryText = Number(finalFailureReport.retryCount ?? 0) > 0 ? `已按最近检查点重试 ${finalFailureReport.retryCount} 次。` : "已保留最近检查点。";
    return [
      `本次文档任务未能最终交付：${reason}。`,
      retryText,
      pendingDocs ? `未完成：${pendingDocs}。` : "",
      finalFailureReport.nextAction ? `下一步：${safeShortText(finalFailureReport.nextAction, 240)}` : "",
    ].filter(Boolean).join("");
  }
  let summary = typeof agentOutput?.summary === "string" ? agentOutput.summary.trim() : "";
  const generatedReply = summary.match(/已生成回复[：:]\s*[「"]([^」"]{1,1000})[」"]/);
  if (generatedReply) summary = (generatedReply[1] ?? "").trim();
  summary = summary
    .split(/\n+/)
    .filter((line) => !/(runId|Policy Gate|QA Gate|agent-output|publish_customer_visible|PI agent|handler|本地 run artifact)/i.test(line))
    .join("\n")
    .trim();
  if (task.taskIntent?.responseMode === "source_pack" && agentOutput?.status === "completed") {
    const handoffPath = details.readableSourcePackPath ?? details.sourcePackPath ?? null;
    if (handoffPath) summary = [summary, `本地交接包：${safeShortText(handoffPath, 500)}`].filter(Boolean).join("\n");
  }
  if (!summary && agentOutput?.status === "blocked") return publish?.reason === "qa_gate_not_publishable" ? "任务处理暂未完成，请稍后重试。" : UNSUPPORTED_FEATURE_REPLY;
  return summary;
}

/** @param {AgentOutput} agentOutput @returns {UnknownRecord[]} */
function userFacingTodo(agentOutput) {
  const projection = asRecord(asRecord(agentOutput.details).todo ?? agentOutput.todo);
  if (!Array.isArray(projection.items)) return [];
  return projection.items.map(asRecord)
    .filter((item) => item?.interactive === true && item?.status === "pending")
    .sort((left, right) => {
      const rank = /** @type {Record<string, number>} */ ({ high: 0, medium: 1, low: 2 });
      return (rank[String(left.priority ?? "")] ?? 3) - (rank[String(right.priority ?? "")] ?? 3);
    })
    .slice(0, 5);
}

/** @param {AgentOutput} agentOutput @returns {string[]} */
function todoMarkdownLines(agentOutput) {
  const items = userFacingTodo(agentOutput);
  if (items.length === 0) return [];
  const lines = ["", "下一步与待确认："];
  for (const item of items) {
    lines.push(`- ${item.label}${item.description ? `：${safeShortText(item.description, 180)}` : ""}`);
    if (Array.isArray(item.options) && item.options.length > 0) {
      const labels = item.options.map((option) => /** @type {Record<string, string>} */ ({
        prd: "生成 PRD",
        "customer-requirement-checklist": "生成客户需求确认表",
        "tech-architecture": "生成技术架构",
        "ops-plan": "生成运营方案",
        "review-customer-questions": "先审阅客户问题",
        "keep-meeting-minutes-only": "仅保留会议纪要",
        "review-source-pack": "先审阅 source pack",
        "keep-source-pack-local": "仅保留本地交接包",
      })[String(option)] ?? String(option));
      lines.push(`  可选：${labels.join(" / ")}`);
    }
  }
  lines.push("你可以直接回复选择，也可以补充或重排自己的下一步。");
  return lines;
}

/** @param {unknown} reportValue */
function userFacingFailureReason(reportValue) {
  const report = asRecord(reportValue);
  const lastProviderAttempt = asRecord(report.lastProviderAttempt);
  const lastReason = String(lastProviderAttempt.reason ?? report.terminalReason ?? "document_workflow_not_completed");
  if (lastReason === "model_provider_unavailable") return "模型 provider 未配置或当前不可用";
  if (lastReason === "model_provider_request_timeout" || lastReason === "document_worker_deadline_exhausted") return "模型生成多次超时";
  if (lastReason === "model_provider_empty_response") return "模型返回为空";
  if (lastReason === "model_provider_http_error") return `模型服务返回 HTTP ${lastProviderAttempt.httpStatus ?? "错误"}`;
  if (lastReason === "document_sections_missing_after_repair") return "文档章节修复后仍有缺失";
  if (lastReason === "qa_gate_not_publishable") return "QA 检查未通过";
  if (lastReason === "policy_gate_not_publishable") return "发布边界检查未通过";
  if (lastReason === "local_docker_worker_timeout") return "本地 Docker 文档 worker 未在限定时间内完成";
  if (lastReason === "local_docker_worker_unavailable") return "本地 Docker 文档 worker 不可用";
  if (lastReason === "no_section_batch_completed") return "没有章节生成成功";
  return safeShortText(lastReason, 160);
}

/** @param {HandlerEvent} event @param {HandlerTask} task @param {string} text @param {RunPaths} paths @param {HandlerOptions} options @param {string} stage @returns {Promise<ProgressResult>} */
async function sendProgressReply(event, task, text, paths, options, stage) {
  const messageId = event.message?.messageId;
  /** @type {ProgressResult} */
  const progress = {
    stage,
    at: nowIso(),
    replyMode: options.replyMode,
    messageIdPresent: Boolean(messageId),
    text: safeShortText(text, 500),
    status: "planned",
    rawSecretsReturned: false,
  };
  if (!messageId || options.replyMode === "silent") {
    progress.status = "skipped";
    progress.reason = !messageId ? "message_id_missing" : "silent_reply_mode";
    appendFileSync(paths.progressPath, `${JSON.stringify(sanitize(progress))}\n`, "utf8");
    return progress;
  }
  const idempotencyKey = hashText(`${task.runId}:${stage}:${text}`).slice(0, 48);
  progress.idempotencyKey = idempotencyKey;
  if (options.replyMode === "dry-run") {
    progress.status = "dry_run";
    progress.plannedCommand = ["lark-cli", "im", "+messages-reply", "--as", "bot", "--message-id", messageId, "--text", text, "--idempotency-key", idempotencyKey];
    appendFileSync(paths.progressPath, `${JSON.stringify(sanitize(progress))}\n`, "utf8");
    return progress;
  }
  const cli = await runCommand("lark-cli", ["im", "+messages-reply", "--as", "bot", "--message-id", messageId, "--text", String(text).slice(0, 1200), "--idempotency-key", idempotencyKey], { timeoutMs: options.cliTimeoutMs ?? 120000 });
  progress.status = cli.exitCode === 0 ? "sent" : "failed";
  progress.exitCode = cli.exitCode;
  progress.stderrTail = redactString(cli.stderr).slice(-1200);
  appendFileSync(paths.progressPath, `${JSON.stringify(sanitize(progress))}\n`, "utf8");
  return progress;
}

/** @param {HandlerTask} task @param {AgentOutput} agentOutput @param {RunPaths} paths @param {HandlerOptions} options @returns {Promise<HandlerPublishResult>} */
async function publishResults(task, agentOutput, paths, options) {
  const documents = (Array.isArray(agentOutput.documents) ? agentOutput.documents : []).map((documentValue, index) => {
    const document = asRecord(documentValue);
    const docType = String(document.docType ?? "document");
    const title = String(document.title ?? document.fileName ?? docType);
    const fileName = safeMarkdownFileName(document.fileName ?? title ?? `${docType}-${index}.md`);
    const localPath = typeof document.localPath === "string" ? resolve(document.localPath) : join(paths.artifactsDir, fileName);
    return /** @type {OutputDocument} */ ({ ...document, docType, title, fileName, localPath, markdown: String(document.markdown ?? "") });
  });
  const qaPass = qaAllowsPublish(agentOutput);
  const policyPass = policyAllowsPublish(agentOutput);
  const policyGate = asRecord(agentOutput.policyGate);
  const policyBlocked = policyGate.status === "blocked";
  const userWriteAllowed = feishuUserWriteAllowed(task, documents.length > 0);
  const effectivePolicyPass = policyPass || (!policyBlocked && userWriteAllowed);
  /** @type {string[][]} */
  const plannedCommands = [];
  const publishAs = options.publishAs ?? "bot";
  /** @type {HandlerPublishResult} */
  const result = {
    schemaVersion: "feishu-publish-v1",
    runId: task.runId,
    status: "blocked",
    publishMode: options.publishMode,
    publishAs,
    qaPass,
    policyPass: effectivePolicyPass,
    policyGateStatus: policyGate.status ?? null,
    policyOverride: !policyPass && !policyBlocked && userWriteAllowed
      ? {
          status: "pass",
          reason: "feishu_user_requested_document_write_or_publish",
          deleteActionsAllowed: false,
        }
      : null,
    documents: [],
    plannedCommands,
    folderToken: null,
    publishTarget: options.publishTarget ?? "auto",
    wikiPublishPath: workspaceRelative(wikiPublishPath(paths)),
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  };
  if (documents.length === 0 && task.taskIntent?.responseMode === "direct_answer") {
    result.status = "skipped";
    result.reason = "direct_answer_no_document_publish";
    result.policyPass = true;
    writeJson(paths.publishPath, result);
    return result;
  }
  if (!qaPass) {
    result.reason = "qa_gate_not_publishable";
    writeJson(paths.publishPath, result);
    return result;
  }
  if (!effectivePolicyPass && options.publishMode === "live") {
    result.reason = "policy_gate_not_passed";
    writeJson(paths.publishPath, result);
    return result;
  }
  if (documents.length === 0) {
    result.status = "skipped";
    result.reason = "direct_answer_no_document_publish";
    writeJson(paths.publishPath, result);
    return result;
  }

  for (const document of documents) writeText(document.localPath, document.markdown);

  const legacySessionKey = sessionPublishKey(task);
  const taxonomy = buildPublishTaxonomy({
    task,
    documents,
    paths,
    options,
    workspaceDir,
    legacySessionKey,
    writeFile: true,
  });
  result.publishTaxonomyPath = workspaceRelative(publishTaxonomyPath(paths));
  result.publishTaxonomy = {
    projectTitle: taxonomy.projectTitle,
    projectKey: taxonomy.projectKey,
    projectConfidence: taxonomy.projectConfidence,
    projectBasis: taxonomy.projectBasis,
    sourceThreadKey: taxonomy.sourceThreadKey,
    driveFolderName: taxonomy.drive?.folderName ?? null,
    wikiRootTitle: taxonomy.wiki?.rootTitle ?? null,
    rawSecretsReturned: false,
  };

  const promptTargetToken = extractFeishuFileToken(task.sourceEvent?.message?.text ?? "");
  const shouldOverwriteAny = documents.some((doc) =>
    Boolean((doc.targetFileToken ?? doc.fileToken ?? promptTargetToken) && MODIFY_REQUEST_PATTERN.test(cleanUserPrompt(task.sourceEvent?.message?.text ?? ""))),
  );
  const publishTarget = options.publishTarget ?? "auto";
  if (!shouldOverwriteAny && ["auto", "wiki"].includes(publishTarget)) {
    const wikiPublish = await publishDocumentsToWiki({
      task,
      documents,
      paths,
      options: {
        publishMode: options.publishMode ?? "dry-run",
        ...(typeof options.publishAs === "string" ? { publishAs: options.publishAs } : {}),
        publishTarget,
        cliTimeoutMs: options.cliTimeoutMs ?? 120000,
        ...(typeof options.folderToken === "string" ? { folderToken: options.folderToken } : {}),
      },
      workspaceDir,
      runCommand,
      writeText,
      taxonomyPlan: taxonomy,
    });
    result.wikiPublish = wikiPublish;
    result.wikiPublishPath = workspaceRelative(wikiPublishPath(paths));
    result.wikiPlanPath = workspaceRelative(wikiPlanPath(paths));
    result.wikiTargetRegistryPath = workspaceRelative(wikiTargetRegistryPath(paths));
    if (["published", "dry_run"].includes(wikiPublish.status)) {
      result.status = wikiPublish.status;
      result.reason = null;
      result.publishTarget = "wiki";
      result.documents = wikiPublish.documents ?? [];
      result.plannedCommands.push(...(wikiPublish.plannedCommands ?? []));
      writeJson(paths.publishPath, result);
      return result;
    }
    if (publishTarget === "wiki") {
      result.status = "blocked";
      result.reason = String(wikiPublish.reason ?? "wiki_publish_failed");
      result.publishTarget = "wiki";
      result.documents = wikiPublish.documents ?? [];
      result.plannedCommands.push(...(wikiPublish.plannedCommands ?? []));
      writeJson(paths.publishPath, result);
      return result;
    }
    result.reason = "wiki_publish_blocked_drive_fallback";
    result.publishTarget = "drive";
    result.wikiFallback = {
      status: "fallback_to_drive",
      reason: wikiPublish.reason ?? "wiki_publish_failed",
      fallbackReason: wikiPublish.fallbackReason ?? "wiki_publish_blocked_drive_fallback",
    };
  } else {
    result.publishTarget = "drive";
  }

  const registry = loadPublishTargetRegistry(paths);
  const parentFolderToken = options.folderToken ?? null;
  const existingProjectTarget = registry.projectEntries[taxonomy.projectKey] ?? null;
  let folderToken = typeof existingProjectTarget?.folderToken === "string" ? existingProjectTarget.folderToken : null;
  const folderName = taxonomy.drive?.folderName ?? `项目｜${taxonomy.projectTitle}`;
  result.publishTarget = {
    mode: "project_workspace",
    projectKey: taxonomy.projectKey,
    projectTitle: taxonomy.projectTitle,
    sourceThreadKey: taxonomy.sourceThreadKey,
    legacySessionKey,
    folderName,
    reused: Boolean(folderToken),
    registryPath: workspaceRelative(publishTargetRegistryPath(paths)),
    parentFolderConfigured: Boolean(parentFolderToken),
  };

  if (!folderToken) {
    const createFolderCommand = ["lark-cli", "drive", "+create-folder", "--as", publishAs, "--name", folderName];
    if (parentFolderToken) createFolderCommand.push("--folder-token", parentFolderToken);
    plannedCommands.push(createFolderCommand);
  }

  if (options.publishMode === "live" && !folderToken) {
    const folderArgs = ["drive", "+create-folder", "--as", publishAs, "--name", folderName];
    if (parentFolderToken) folderArgs.push("--folder-token", parentFolderToken);
    const folder = await runCommand("lark-cli", folderArgs, { timeoutMs: options.cliTimeoutMs ?? 120000 });
    const folderJson = parseJsonOutput(folder.stdout);
    folderToken = findToken(folderJson, ["folder_token", "token", "file_token"]) ?? folderToken;
    result.folderCreate = { exitCode: folder.exitCode, stderrTail: redactString(folder.stderr).slice(-2000) };
    if (folder.exitCode !== 0 || !folderToken) {
      result.folderCreateFallback = {
        status: "using_existing_target",
        reason: "feishu_folder_create_failed",
        target: parentFolderToken ? "configured_parent_folder" : "default_root_folder",
      };
      folderToken = parentFolderToken ?? null;
    } else {
      registry.projectEntries ??= {};
      registry.legacySessionMappings ??= {};
      const legacySessionKeys = Array.from(new Set([...(Array.isArray(existingProjectTarget?.legacySessionKeys) ? existingProjectTarget.legacySessionKeys.map(String) : []), legacySessionKey].filter(Boolean)));
      registry.projectEntries[taxonomy.projectKey] = {
        folderToken,
        folderName,
        projectTitle: taxonomy.projectTitle,
        projectKey: taxonomy.projectKey,
        sourceThreadKey: taxonomy.sourceThreadKey,
        legacySessionKeys,
        chatIdHash: hashText(task.sourceEvent?.message?.chatId ?? "").slice(0, 16),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      registry.legacySessionMappings[legacySessionKey] = {
        projectKey: taxonomy.projectKey,
        folderName,
        mappedAt: nowIso(),
      };
      savePublishTargetRegistry(paths, registry);
    }
    result.folderToken = folderToken;
  } else if (options.publishMode === "live" && folderToken) {
    registry.projectEntries ??= {};
    registry.legacySessionMappings ??= {};
    const legacySessionKeys = Array.from(new Set([...(Array.isArray(existingProjectTarget?.legacySessionKeys) ? existingProjectTarget.legacySessionKeys.map(String) : []), legacySessionKey].filter(Boolean)));
    registry.projectEntries[taxonomy.projectKey] = {
      ...existingProjectTarget,
      folderToken,
      folderName: typeof existingProjectTarget?.folderName === "string" ? existingProjectTarget.folderName : folderName,
      projectTitle: taxonomy.projectTitle,
      projectKey: taxonomy.projectKey,
      sourceThreadKey: taxonomy.sourceThreadKey,
      legacySessionKeys,
      updatedAt: nowIso(),
    };
    registry.legacySessionMappings[legacySessionKey] = {
      projectKey: taxonomy.projectKey,
      folderName: typeof existingProjectTarget?.folderName === "string" ? existingProjectTarget.folderName : folderName,
      mappedAt: nowIso(),
    };
    savePublishTargetRegistry(paths, registry);
  }
  result.folderToken = folderToken;

  for (const [index, doc] of documents.entries()) {
    const fileName = safeMarkdownFileName(doc.fileName || doc.title || `${doc.docType || "document"}-${index}.md`);
    const markdownPath = join(paths.artifactsDir, fileName.endsWith(".md") ? fileName : `${fileName}.md`);
    writeText(markdownPath, String(doc.markdown ?? ""));
    const targetFileTokenValue = doc.targetFileToken ?? doc.fileToken ?? promptTargetToken;
    const targetFileToken = typeof targetFileTokenValue === "string" ? targetFileTokenValue : null;
    const shouldOverwrite = Boolean(targetFileToken && MODIFY_REQUEST_PATTERN.test(cleanUserPrompt(task.sourceEvent?.message?.text ?? "")));
    /** @type {string[]} */
    const command = shouldOverwrite
      ? ["lark-cli", "markdown", "+overwrite", "--as", publishAs, "--file", relative(workspaceDir, markdownPath), "--file-token", targetFileToken ?? "", "--name", fileName.endsWith(".md") ? fileName : `${fileName}.md`]
      : ["lark-cli", "markdown", "+create", "--as", publishAs, "--file", relative(workspaceDir, markdownPath), "--name", fileName.endsWith(".md") ? fileName : `${fileName}.md`];
    if (!shouldOverwrite && folderToken) command.push("--folder-token", folderToken);
    plannedCommands.push(command);
    /** @type {UnknownRecord & {status: string}} */
    const docResult = {
      docType: doc.docType ?? "document",
      title: doc.title ?? fileName,
      fileName,
      localPath: markdownPath,
      action: shouldOverwrite ? "overwrite" : "create",
      targetFileToken: shouldOverwrite ? targetFileToken : null,
      status: "planned",
    };
    if (options.publishMode === "live") {
      const cliArgs = command.slice(1).concat(["--format", "json"]);
      const created = await runCommand("lark-cli", cliArgs, { timeoutMs: options.cliTimeoutMs ?? 120000 });
      const json = parseJsonOutput(created.stdout);
      docResult.status = created.exitCode === 0 ? (shouldOverwrite ? "overwritten" : "published") : "failed";
      docResult.exitCode = created.exitCode;
      docResult.fileToken = findToken(json, ["file_token", "token", "obj_token"]) ?? null;
      docResult.url = findToken(json, ["url", "link"]) ?? null;
      docResult.stderrTail = redactString(created.stderr).slice(-2000);
    }
    result.documents.push(docResult);
  }

  if (options.publishMode === "live" && result.documents.some((doc) => !["published", "overwritten"].includes(String(doc.status ?? "")))) {
    result.status = "blocked";
    result.reason = "feishu_markdown_create_failed";
    writeJson(paths.publishPath, result);
    return result;
  }

  for (const artifactValue of agentOutput.artifacts ?? []) {
    const artifact = asRecord(artifactValue);
    if (typeof artifact.localPath !== "string") continue;
    const command = ["lark-cli", "drive", "+upload", "--as", publishAs, "--file", relative(workspaceDir, resolve(artifact.localPath)), "--name", safeSegment(artifact.name || artifact.localPath)];
    if (folderToken) command.push("--folder-token", folderToken);
    plannedCommands.push(command);
  }

  result.status = options.publishMode === "live" ? "published" : "dry_run";
  writeJson(paths.publishPath, result);
  return result;
}

/** @param {HandlerEvent} event @param {HandlerTask} task @param {AgentOutput} agentOutput @param {HandlerPublishResult} publish @param {RunPaths} paths @param {HandlerOptions} options @returns {Promise<ReplyResult>} */
async function replyToFeishu(event, task, agentOutput, publish, paths, options) {
  const messageId = event.message?.messageId;
  const documentLines = (publish.documents ?? []).map((doc) => `- ${doc.title}: ${doc.status}${doc.url ? ` ${doc.url}` : ""}`);
  const summary = userFacingSummary(task, agentOutput, publish);
  const markdown = documentLines.length === 0 && summary
    ? [summary, ...todoMarkdownLines(agentOutput)].filter(Boolean).join("\n")
    : [
        publish.status === "published" ? "已完成处理，并已发布文档。" : "已完成处理。",
        "",
        summary ? `摘要：${summary}` : "",
        publish.reason && publish.reason !== "direct_answer_no_document_publish" ? `原因：${publish.reason}` : "",
        "",
        ...documentLines,
        ...todoMarkdownLines(agentOutput),
      ].filter(Boolean).join("\n");
  /** @type {ReplyResult} */
  const reply = {
    runId: task.runId,
    replyMode: options.replyMode,
    messageIdPresent: Boolean(messageId),
    markdown,
    status: "planned",
    rawSecretsReturned: false,
  };
  if (task.taskIntent?.responseMode === "ack_file_cached" && options.fileAckReplyMode !== "live") {
    reply.status = "skipped";
    reply.reason = "ack_file_cached_silent";
    reply.fileAckReplyMode = options.fileAckReplyMode ?? "silent";
    writeJson(paths.replyPath, reply);
    return reply;
  }
  if (!messageId || options.replyMode === "silent") {
    reply.status = "skipped";
    reply.reason = !messageId ? "message_id_missing" : "silent_reply_mode";
    writeJson(paths.replyPath, reply);
    return reply;
  }
  if (options.replyMode === "dry-run") {
    reply.idempotencyKey = replyIdempotencyKey(task.runId);
    reply.plannedCommand = ["lark-cli", "im", "+messages-reply", "--as", "bot", "--message-id", messageId, "--markdown", markdown, "--idempotency-key", reply.idempotencyKey];
    reply.status = "dry_run";
    writeJson(paths.replyPath, reply);
    return reply;
  }
  const idempotencyKey = replyIdempotencyKey(task.runId);
  reply.idempotencyKey = idempotencyKey;
  const command = ["im", "+messages-reply", "--as", "bot", "--message-id", messageId, "--markdown", markdown, "--idempotency-key", idempotencyKey];
  const cli = await runCommand("lark-cli", command, { timeoutMs: options.cliTimeoutMs ?? 120000 });
  let finalCli = cli;
  if (cli.exitCode !== 0 && /field validation failed/i.test(cli.stderr)) {
    const textFallback = markdown.replace(/\*\*/g, "").slice(0, 3500);
    const textCommand = ["im", "+messages-reply", "--as", "bot", "--message-id", messageId, "--text", textFallback, "--idempotency-key", `${idempotencyKey.slice(0, 42)}-text`];
    finalCli = await runCommand("lark-cli", textCommand, { timeoutMs: options.cliTimeoutMs ?? 120000 });
    reply.fallback = {
      reason: "markdown_field_validation_failed",
      attempted: "text",
      exitCode: finalCli.exitCode,
    };
  }
  reply.status = finalCli.exitCode === 0 ? "sent" : "failed";
  reply.exitCode = finalCli.exitCode;
  reply.stderrTail = redactString(finalCli.stderr).slice(-2000);
  writeJson(paths.replyPath, reply);
  return reply;
}

/** @param {string} runId */
function replyIdempotencyKey(runId) {
  return createHash("sha256").update(String(runId)).digest("hex").slice(0, 48);
}

/** @param {HandlerTask} task @param {AgentOutput} agentOutput @param {HandlerPublishResult} publish @param {string} stateStatus */
function buildHandlerResponseText(task, agentOutput, publish, stateStatus) {
  const documents = Array.isArray(publish?.documents) ? publish.documents : [];
  const summary = userFacingSummary(task, agentOutput, publish);
  const details = asRecord(agentOutput.details);
  if (
    stateStatus === "blocked"
    && ["audio_transcoder_unavailable", "audio_normalize_failed"].includes(String(details.reason ?? ""))
  ) {
    return (summary || "目前音频格式暂不支持自动转码。").slice(0, 3500);
  }
  if (
    stateStatus === "blocked"
    && details.sourceAcquisitionGate === true
    && summary
  ) {
    return summary.slice(0, 3500);
  }
  if (documents.length === 0 && summary && ["direct_answer", "unsupported", "needs_file", "ack_file_cached"].includes(String(task.taskIntent?.responseMode ?? ""))) {
    return summary.slice(0, 3500);
  }
  const lines = [];
  if (stateStatus === "completed") {
    if (publish.status === "published") {
      lines.push("已完成 Agent 处理，并已发布到飞书。");
    } else if (publish.status === "dry_run") {
      lines.push("已完成 Agent 本地处理；当前是 dry-run，未真正发布飞书文档。");
    } else {
      lines.push("已完成 Agent 本地处理。");
    }
  } else if (stateStatus === "blocked") {
    lines.push("Agent 处理已阻塞，未发布飞书文档。");
  } else if (stateStatus === "needs_fix") {
    lines.push("Agent 处理完成但 QA 仍需要修复，未发布飞书文档。");
  } else if (stateStatus === "failed") {
    lines.push("Agent 处理失败，请查看本地 run artifact。");
  } else {
    lines.push(`Agent 任务状态：${stateStatus}`);
  }

  if (summary) lines.push(`摘要：${summary}`);
  if (publish?.reason) lines.push(`原因：${publish.reason}`);
  lines.push(`发布状态：${publish?.status ?? "unknown"}`);

  if (documents.length > 0) {
    lines.push("");
    lines.push("文档：");
    for (const doc of documents.slice(0, 6)) {
      const title = doc.title || doc.fileName || doc.docType || "document";
      lines.push(`- ${title}: ${doc.status || "ready"}${doc.url ? ` ${doc.url}` : ""}`);
    }
  }

  lines.push(...todoMarkdownLines(agentOutput));

  return lines.join("\n").slice(0, 3500);
}

/** @param {string} runId @param {string} [taskType] @returns {RunMetrics} */
function baseRunMetrics(runId, taskType = "feishu_agent") {
  return {
    runId,
    taskType,
    summary: "",
    startedAt: nowIso(),
    finishedAt: null,
    status: "running",
    enabledCapabilities: ["feishu-agent-bridge"],
    modelCalls: [],
    toolCalls: [],
    externalCalls: [],
    tokenUsage: { prompt: 0, completion: 0, cached: 0, total: 0 },
    contextBudget: { estimatedInputTokens: 0, retainedEvidenceItems: 0, offloadedEvidenceItems: 0 },
    generatedArtifacts: [],
    qaGate: { status: "not_run", issues: [] },
    plannerDecisions: [],
    policyDecisions: [],
    workerDecisions: [],
    capabilitySelections: [],
    packageAudits: [],
    rawSecretsReturned: false,
    meetingContentAllowed: true,
    contentTruncationChars: 20000,
  };
}

/** @param {RunMetrics} metrics @param {string} kind @param {unknown} payload */
function appendMetric(metrics, kind, payload) {
  const sanitizedPayload = sanitize(payload);
  if (kind === "tool") metrics.toolCalls.push(sanitizedPayload);
  if (kind === "external") metrics.externalCalls.push(sanitizedPayload);
  if (kind === "artifact") metrics.generatedArtifacts.push(sanitizedPayload);
  if (kind === "qaGate") metrics.qaGate = sanitizedPayload;
  if (kind === "planner") metrics.plannerDecisions.push(sanitizedPayload);
  if (kind === "policy") metrics.policyDecisions.push(sanitizedPayload);
  if (kind === "workerDecision") metrics.workerDecisions.push(sanitizedPayload);
  if (kind === "capabilitySelection") metrics.capabilitySelections.push(sanitizedPayload);
}

/** @param {RunPaths} paths @param {RunMetrics} metrics */
function writeRunMetrics(paths, metrics) {
  writeJson(paths.metricsPath, metrics);
}

/** @param {string} status */
function metricsStatusFromState(status) {
  if (status === "completed") return "pass";
  if (status === "blocked") return "blocked";
  if (status === "failed") return "failed";
  return "needs_fix";
}

/** @param {HandlerAttachment} attachment */
function summarizeAttachmentForLearning(attachment) {
  return {
    name: attachment.name ?? null,
    resourceType: attachment.resourceType ?? attachmentKind(attachment),
    extension: fileExtension(attachment) || null,
    downloadStatus: attachment.downloadStatus ?? null,
    sizeBytes: attachment.sizeBytes ?? null,
    sha256: attachment.sha256 ?? null,
    sourceMessageId: attachment.sourceMessageId ?? attachment.messageId ?? attachment.cacheSourceMessageId ?? null,
    resolvedFromCache: Boolean(attachment.resolvedFromCache),
    resolvedFromParentMessage: Boolean(attachment.resolvedFromParentMessage),
    rawMediaExternalUpload: false,
  };
}

/** @param {HandlerFileContext} context */
function summarizeFileContextForLearning(context) {
  const extraction = asRecord(context.extraction);
  return {
    fileName: context.fileName ?? null,
    fileType: context.fileType ?? null,
    extension: context.extension ?? null,
    status: context.status ?? null,
    contextMode: context.contextMode ?? null,
    extraction: Object.keys(extraction).length > 0
      ? {
          status: extraction.status ?? null,
          method: extraction.method ?? null,
          reason: extraction.reason ?? null,
          chars: extraction.chars ?? 0,
          previewChars: extraction.previewChars ?? 0,
        }
      : null,
    extractedTextPath: workspaceRelative(context.extractedTextPath),
    unsupportedReason: context.unsupportedReason ?? null,
    externalLlmAllowed: Boolean(context.externalLlmAllowed),
  };
}

/** @param {{event: HandlerEvent, task: HandlerTask, state: FeishuRunState, agentOutput: AgentOutput, publish: HandlerPublishResult, reply: ReplyResult, paths: RunPaths, metrics: RunMetrics}} input */
function buildRunManifest({ event, task, state, agentOutput, publish, reply, paths, metrics }) {
  const attachments = Array.isArray(task.attachments) ? task.attachments : [];
  const contexts = Array.isArray(task.fileContexts?.contexts) ? task.fileContexts.contexts : [];
  const agentDetails = asRecord(agentOutput.details);
  const wikiPublish = asRecord(publish.wikiPublish);
  const wikiFallback = asRecord(publish.wikiFallback);
  return {
    schemaVersion: "feishu-run-manifest-v1",
    runId: task.runId,
    status: state.status,
    generatedAt: nowIso(),
    source: {
      eventType: event.eventType,
      source: event.source,
      msgType: event.message?.msgType,
      chatType: event.message?.chatType ?? null,
      messageIdHash: event.message?.messageId ? hashText(event.message.messageId).slice(0, 16) : null,
      hasText: Boolean(event.message?.text),
      textHash: event.message?.text ? hashText(event.message.text) : null,
      rootIdPresent: Boolean(event.message?.rootId),
      parentIdPresent: Boolean(event.message?.parentId),
      attachmentResolution: event.attachmentResolution ?? null,
    },
    task: {
      taskType: task.taskIntent?.taskType ?? task.taskIntent?.responseMode ?? "unknown",
      responseMode: task.taskIntent?.responseMode ?? null,
      executionProfile: task.taskIntent?.executionProfile ?? null,
      reasoningDepth: task.taskIntent?.reasoningDepth ?? null,
      requestedDocuments: task.taskIntent?.requestedDocuments ?? [],
      requiredStages: task.taskIntent?.requiredStages ?? [],
      skipStages: task.taskIntent?.skipStages ?? [],
      requiresLocalAsr: Boolean(task.taskIntent?.requiresLocalAsr),
      hasAttachments: Boolean(task.taskIntent?.hasAttachments),
      hasFileContexts: Boolean(task.taskIntent?.hasFileContexts),
    },
    inputs: {
      attachments: attachments.map(summarizeAttachmentForLearning),
      fileContexts: contexts.map(summarizeFileContextForLearning),
    },
    outputs: {
      summary: safeShortText(agentOutput?.summary, 900),
      documents: (Array.isArray(agentOutput?.documents) ? agentOutput.documents : []).map((doc) => ({
        docType: doc.docType ?? "document",
        title: safeShortText(doc.title ?? doc.fileName ?? doc.docType, 160),
        fileName: doc.fileName ?? null,
        markdownHash: doc.markdown ? hashText(doc.markdown) : null,
        markdownChars: typeof doc.markdown === "string" ? doc.markdown.length : 0,
      })),
      artifacts: (agentOutput.artifacts ?? []).map((artifactValue) => {
        const artifact = asRecord(artifactValue);
        return ({
          kind: artifact.kind ?? artifact.type ?? "artifact",
          name: artifact.name ?? null,
          localPath: workspaceRelative(artifact.localPath),
        });
      }),
      todo: agentDetails.todo ?? agentOutput.todo ?? null,
      interactionItems: agentDetails.interactionItems ?? agentOutput.interactionItems ?? [],
    },
    gates: {
      qaGate: agentOutput?.qaGate ?? { status: "not_run", issues: [] },
      policyGate: agentOutput?.policyGate ?? { status: "not_run" },
    },
    publish: {
      status: publish?.status ?? null,
      reason: publish?.reason ?? null,
      publishTarget: publish?.publishTarget ?? null,
      publishTaxonomy: publish?.publishTaxonomy ?? null,
      wikiPublishStatus: wikiPublish.status ?? null,
      wikiFallbackReason: wikiFallback.reason ?? wikiPublish.fallbackReason ?? null,
      documentCount: Array.isArray(publish?.documents) ? publish.documents.length : 0,
    },
    reply: {
      status: reply?.status ?? null,
      reason: reply?.reason ?? null,
      markdownHash: reply?.markdown ? hashText(reply.markdown) : null,
      markdownChars: typeof reply?.markdown === "string" ? reply.markdown.length : 0,
    },
    artifacts: {
      event: workspaceRelative(paths.eventPath),
      task: workspaceRelative(paths.taskPath),
      state: workspaceRelative(paths.statePath),
      metrics: workspaceRelative(paths.metricsPath),
      agentTask: workspaceRelative(paths.agentTaskPath),
      agentOutput: workspaceRelative(paths.agentOutputPath),
      fileContext: workspaceRelative(paths.fileContextPath),
      publish: workspaceRelative(paths.publishPath),
      publishTaxonomy: workspaceRelative(publishTaxonomyPath(paths)),
      wikiPublish: workspaceRelative(wikiPublishPath(paths)),
      wikiPublishPlan: workspaceRelative(wikiPlanPath(paths)),
      meetingMemoryCuration: existsSync(join(paths.artifactsDir, "meeting-memory", "curation-result.json"))
        ? workspaceRelative(join(paths.artifactsDir, "meeting-memory", "curation-result.json"))
        : null,
      reply: workspaceRelative(paths.replyPath),
    },
    metrics: {
      status: metrics.status,
      enabledCapabilities: metrics.enabledCapabilities,
      toolCalls: metrics.toolCalls.length,
      externalCalls: metrics.externalCalls.length,
      generatedArtifacts: metrics.generatedArtifacts.length,
      qaGate: metrics.qaGate,
    },
    privacy: {
      rawSecretsReturned: false,
      rawMediaExternalUpload: Boolean(agentOutput?.rawMediaExternalUpload),
      rawMeetingContentIncluded: task.taskIntent?.taskType === "meeting_minutes",
      tokensIncluded: false,
    },
  };
}

/** @param {{event: HandlerEvent, task: HandlerTask, state: FeishuRunState, agentOutput: AgentOutput, publish: HandlerPublishResult, reply: ReplyResult, paths: RunPaths, metrics: RunMetrics}} input */
function writeRunArtifacts({ event, task, state, agentOutput, publish, reply, paths, metrics }) {
  metrics.status = metricsStatusFromState(state.status);
  metrics.finishedAt = nowIso();
  metrics.summary = safeShortText(agentOutput?.summary || publish?.reason || state.status, 500);
  metrics.qaGate = agentOutput?.qaGate ?? metrics.qaGate;
  writeRunMetrics(paths, metrics);
  const manifest = buildRunManifest({ event, task, state, agentOutput, publish, reply, paths, metrics });
  writeJson(paths.manifestPath, manifest);
  state.manifestPath = paths.manifestPath;
  state.metricsPath = paths.metricsPath;
  state.rawSecretsReturned = false;
  state.rawMediaExternalUpload = false;
  writeState(paths, state);
  return { manifest };
}

/** @param {unknown} mode */
function runtimeStoreModeEnabled(mode) {
  return !/^(0|false|off|disabled|none)$/i.test(String(mode ?? "index").trim());
}

/** @param {RunPaths} paths @param {HandlerOptions} options @param {FeishuRunState} state @param {RunMetrics} metrics */
async function indexRuntimeStoreRun(paths, options, state, metrics) {
  const mode = options.runtimeStoreMode ?? "index";
  const baseResult = {
    schemaVersion: "runtime-store-index-result-v1",
    mode,
    status: "skipped",
    runDir: workspaceRelative(paths.runDir),
    runtimeStoreCli: workspaceRelative(runtimeStoreCliPath),
    rawSecretsReturned: false,
  };
  if (!runtimeStoreModeEnabled(mode)) {
    const result = { ...baseResult, reason: "runtime_store_disabled" };
    writeJson(paths.runtimeStoreIndexPath, result);
    addStep(state, "runtime_store_index_run", "skipped", { artifact: paths.runtimeStoreIndexPath, reason: result.reason });
    appendMetric(metrics, "tool", { name: "runtime_store_index_run", status: "skipped", reason: result.reason });
    writeRunMetrics(paths, metrics);
    writeState(paths, state);
    return result;
  }
  if (!/^(1|true|yes|on)$/i.test(String(process.env.FEISHU_AGENT_INDEX_FIXTURES ?? "")) && (isFixtureLikeRunId(basename(paths.runDir)) || options.dryRun || options.mockAgent)) {
    const result = { ...baseResult, reason: "runtime_store_fixture_mock_dry_run_index_skipped" };
    writeJson(paths.runtimeStoreIndexPath, result);
    addStep(state, "runtime_store_index_run", "skipped", { artifact: paths.runtimeStoreIndexPath, reason: result.reason });
    appendMetric(metrics, "tool", { name: "runtime_store_index_run", status: "skipped", reason: result.reason });
    writeRunMetrics(paths, metrics);
    writeState(paths, state);
    return result;
  }
  if (!existsSync(runtimeStoreCliPath)) {
    const result = { ...baseResult, status: "failed", reason: "runtime_store_cli_missing" };
    writeJson(paths.runtimeStoreIndexPath, result);
    addStep(state, "runtime_store_index_run", "skipped", { artifact: paths.runtimeStoreIndexPath, indexStatus: result.status, reason: result.reason });
    appendMetric(metrics, "tool", { name: "runtime_store_index_run", status: "failed", reason: result.reason });
    writeRunMetrics(paths, metrics);
    writeState(paths, state);
    return result;
  }
  const args = [runtimeStoreCliPath, "index-run", "--run-dir", paths.runDir];
  if (options.runtimeStoreCas !== false) args.push("--cas");
  const cli = await runCommand("python3", args, { timeoutMs: options.runtimeStoreTimeoutMs ?? 120000 });
  const parsed = asRecord(parseJsonOutput(cli.stdout));
  const ok = cli.exitCode === 0 && parsed.status === "indexed";
  const result = {
    ...baseResult,
    status: ok ? "completed" : "failed",
    exitCode: cli.exitCode,
    cas: options.runtimeStoreCas !== false,
    stdout: parsed ? undefined : safeShortText(cli.stdout, 1200),
    stderrTail: redactString(cli.stderr).slice(-1200),
    result: parsed,
  };
  writeJson(paths.runtimeStoreIndexPath, result);
  addStep(state, "runtime_store_index_run", ok ? "completed" : "skipped", {
    artifact: paths.runtimeStoreIndexPath,
    indexStatus: result.status,
    exitCode: cli.exitCode,
    cas: result.cas,
  });
  appendMetric(metrics, "tool", {
    name: "runtime_store_index_run",
    status: result.status,
    exitCode: cli.exitCode,
    cas: result.cas,
    artifact: workspaceRelative(paths.runtimeStoreIndexPath),
    runtimeStoreCli: workspaceRelative(runtimeStoreCliPath),
  });
  writeRunMetrics(paths, metrics);
  writeState(paths, state);
  return result;
}

/** @param {unknown} input @param {HandlerOptions} options */
export async function handleEvent(input, options) {
  const event = normalizeDirectEvent(input);
  const root = outputRoot(options.outputRoot);
  const previousThreadLedger = selectPreviousThreadLedger(root, event);
  const ledgerSelection = resolveLedgerSelection(event.message?.text ?? "", previousThreadLedger?.ledger);
  if (ledgerSelection && previousThreadLedger) {
    const selected = previousThreadLedger.ledger;
    const interactionItems = (Array.isArray(selected.interactionItems) ? selected.interactionItems : []).map((itemValue) => {
      const item = asRecord(itemValue);
      return item.itemId === ledgerSelection.itemId
        ? { ...item, status: "answered", answer: ledgerSelection.selectedOption }
        : item;
    });
    const revision = Number(selected.revision ?? 1) + 1;
    /** @type {UnknownRecord} */
    const updatedLedger = {
      ...selected,
      revision,
      status: "active",
      interactionItems,
      openQuestions: interactionItems.filter((item) => item.kind === "question" && item.status === "pending").map((item) => item.itemId),
      updatedAt: nowIso(),
      events: [
        ...(Array.isArray(selected.events) ? selected.events : []),
        { eventId: `event-${hashText(`${selected.planId}:${revision}:${ledgerSelection.itemId}`).slice(0, 10)}`, type: "user_selection_recorded", at: nowIso(), actor: "user", operationId: `feishu-selection:${event.eventId}` },
      ].slice(-500),
    };
    updatedLedger.userTodoProjection = {
      ...asRecord(selected.userTodoProjection),
      revision,
      awaitingUser: interactionItems.some((item) => item.status === "pending" && ["decision", "question"].includes(String(item.kind ?? ""))),
      items: (Array.isArray(asRecord(selected.userTodoProjection).items) ? /** @type {unknown[]} */ (asRecord(selected.userTodoProjection).items) : []).map((itemValue) => {
        const item = asRecord(itemValue);
        return item.itemId === ledgerSelection.itemId
          ? { ...item, status: "answered", interactive: false }
          : item;
      }),
    };
    writeJson(previousThreadLedger.path, updatedLedger);
    previousThreadLedger.ledger = updatedLedger;
    event.ledgerSelection = {
      ...ledgerSelection,
      sourceLedgerPath: workspaceRelative(previousThreadLedger.path),
    };
  }
  // Source resolution rule: current attachments and explicit URLs outrank parent/root lookup and recent cache.
  const explicitFileReferences = extractFeishuFileReferences(event.message?.text ?? "");
  if (explicitFileReferences.length > 0) {
    event.message.attachments = /** @type {import("../dist/index.js").FeishuAttachment[]} */ (dedupeAttachments([...(event.message?.attachments ?? []), ...explicitFileReferences]));
  }
  const attachmentResolution = await resolveReferencedAttachments(root, event, options);
  if ((event.message?.attachments ?? []).length === 0 && attachmentResolution.attachments.length > 0) {
    event.message.attachments = /** @type {import("../dist/index.js").FeishuAttachment[]} */ (dedupeAttachments(attachmentResolution.attachments));
  }
  event.attachmentResolution = {
    status: attachmentResolution.status,
    reason: attachmentResolution.reason,
    sourceMessageId: attachmentResolution.sourceMessageId ?? null,
    messageIds: attachmentResolution.messageIds ?? [],
    parentStatus: asRecord(attachmentResolution.parentResolution).status ?? null,
    parentReason: asRecord(attachmentResolution.parentResolution).reason ?? null,
    parentExitCode: asRecord(attachmentResolution.parentResolution).exitCode ?? null,
    cacheStatus: asRecord(attachmentResolution.cacheResolution).status ?? null,
    cacheReason: asRecord(attachmentResolution.cacheResolution).reason ?? null,
    explicitFileReferenceCount: explicitFileReferences.length,
  };
  const runId = options.runId ?? runIdFor(event);
  const paths = runPaths(root, runId);
  mkdirSync(paths.runDir, { recursive: true });
  const metrics = baseRunMetrics(runId);
  appendMetric(metrics, "capabilitySelection", {
    capabilityId: "feishu-agent-bridge",
    reason: "Feishu inbound event accepted by handler",
  });
  appendMetric(metrics, "tool", {
    name: "feishu_agent_task_handler",
    eventType: event.eventType,
    msgType: event.message?.msgType,
    attachmentResolution: event.attachmentResolution,
  });
  writeRunMetrics(paths, metrics);
  /** @type {FeishuRunState} */
  const state = {
    schemaVersion: "feishu-run-state-v1",
    runId,
    status: "accepted",
    updatedAt: nowIso(),
    steps: [],
    sourceEventPath: paths.eventPath,
    taskPath: paths.taskPath,
    agentOutputPath: paths.agentOutputPath,
    metricsPath: paths.metricsPath,
    manifestPath: paths.manifestPath,
    publishPath: paths.publishPath,
    replyPath: paths.replyPath,
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  };
  addStep(state, "event_normalized", "completed", { artifact: paths.eventPath });
  writeJson(paths.eventPath, event);
  writeText(paths.sourceEventsPath, `${JSON.stringify(sanitize(input))}\n`);
  appendMetric(metrics, "artifact", { kind: "event", path: workspaceRelative(paths.eventPath) });
  writeRunMetrics(paths, metrics);
  writeState(paths, state);

  const cacheResult = rememberAttachments(root, event);
  addStep(state, "attachment_cache_checked", cacheResult.status === "cached" || cacheResult.status === "skipped" ? "completed" : "needs_fix", { cacheStatus: cacheResult.status, reason: cacheResult.reason });
  writeState(paths, state);

  const attachments = await downloadAttachments(event, paths, { ...options, runId });
  addStep(state, "attachments_resolved", attachments.some((item) => item.downloadStatus === "failed" || item.downloadStatus === "blocked") ? "needs_fix" : "completed", { artifact: paths.inputsDir });
  const downloadedCacheResult = rememberDownloadedAttachments(root, event, attachments);
  addStep(state, "attachment_artifact_cache_updated", downloadedCacheResult.status === "cached" || downloadedCacheResult.status === "skipped" ? "completed" : "needs_fix", {
    cacheStatus: downloadedCacheResult.status,
    reason: downloadedCacheResult.reason,
  });
  appendMetric(metrics, "tool", {
    name: "feishu_attachment_resolution",
    count: attachments.length,
    statuses: attachments.map((item) => item.downloadStatus ?? "unknown"),
    rawMediaExternalUpload: false,
  });
  appendMetric(metrics, "tool", {
    name: "feishu_attachment_artifact_cache",
    status: downloadedCacheResult.status,
    reason: downloadedCacheResult.reason ?? null,
  });
  appendMetric(metrics, "artifact", { kind: "attachments", path: workspaceRelative(paths.inputsDir), count: attachments.length });
  writeRunMetrics(paths, metrics);
  writeState(paths, state);

  const fileContexts = await buildFileContexts(event, attachments, paths);
  writeJson(paths.fileContextPath, fileContexts);
  addStep(state, "file_context_built", fileContexts.contexts.some((item) => item.status === "unsupported" || item.status === "blocked") ? "needs_fix" : "completed", { artifact: paths.fileContextPath });
  appendMetric(metrics, "tool", {
    name: "file_context_built",
    count: fileContexts.contexts.length,
    statuses: fileContexts.contexts.map((item) => item.status),
    contextModes: fileContexts.contexts.map((item) => item.contextMode),
  });
  appendMetric(metrics, "artifact", { kind: "file-context", path: workspaceRelative(paths.fileContextPath) });
  writeRunMetrics(paths, metrics);
  writeState(paths, state);

  const taskIntent = classifyTaskIntent(event, attachments, fileContexts, attachmentResolution);
  if (ledgerSelection && previousThreadLedger && ledgerSelection.requestedDocuments.length > 0) {
    taskIntent.taskType = "doc_writer";
    taskIntent.responseMode = "document_pipeline";
    taskIntent.executionProfile = "document_generation";
    taskIntent.reasoningDepth = "deep";
    taskIntent.requestedDocuments = ledgerSelection.requestedDocuments;
    taskIntent.sourcePreparation = {
      ...(taskIntent.sourcePreparation ?? {}),
      requestedDocuments: ledgerSelection.requestedDocuments,
      sourceSetMode: "consolidated",
      sourceRunId: ledgerSelection.sourceRunId,
      sourcePlanId: ledgerSelection.sourcePlanId,
      sourceLedgerPath: workspaceRelative(previousThreadLedger.path),
      conflictPolicy: "source_attribution",
    };
  } else if (ledgerSelection?.selectedOption === "review-customer-questions" && previousThreadLedger) {
    const questions = (Array.isArray(previousThreadLedger.ledger.interactionItems) ? previousThreadLedger.ledger.interactionItems : []).map(asRecord)
      .filter((item) => item.kind === "question" && item.status === "pending")
      .sort((left, right) => {
        const rank = /** @type {Record<string, number>} */ ({ high: 0, medium: 1, low: 2 });
        return (rank[String(left.priority ?? "")] ?? 3) - (rank[String(right.priority ?? "")] ?? 3);
      })
      .slice(0, 10);
    taskIntent.taskType = "task_management";
    taskIntent.responseMode = "direct_answer";
    taskIntent.executionProfile = FAST_ANSWER_EXECUTION_PROFILE;
    taskIntent.reasoningDepth = FAST_REASONING_DEPTH;
    taskIntent.immediateResponse = questions.length > 0
      ? ["建议下一轮优先向客户确认：", ...questions.map((item, index) => `${index + 1}. ${String(item.label ?? "待确认问题")}${item.description ? `（${safeShortText(item.description, 160)}）` : ""}`)].join("\n")
      : "当前 Execution Ledger 没有尚待确认的客户问题。";
  } else if (ledgerSelection?.selectedOption === "keep-meeting-minutes-only") {
    taskIntent.taskType = "task_management";
    taskIntent.responseMode = "direct_answer";
    taskIntent.executionProfile = FAST_ANSWER_EXECUTION_PROFILE;
    taskIntent.reasoningDepth = FAST_REASONING_DEPTH;
    taskIntent.immediateResponse = "已记录：本轮仅保留会议纪要，不继续生成 PRD、技术架构或客户需求确认表。";
  } else if (ledgerSelection?.selectedOption === "review-source-pack" && previousThreadLedger) {
    const sourcePackPath = join(dirname(previousThreadLedger.path), "artifacts", "public-source", "source-pack", "source-pack.readable.md");
    const sourcePackPreview = existsSync(sourcePackPath) ? readFileSync(sourcePackPath, "utf8").slice(0, 2600).trim() : "";
    taskIntent.taskType = "task_management";
    taskIntent.responseMode = "direct_answer";
    taskIntent.executionProfile = FAST_ANSWER_EXECUTION_PROFILE;
    taskIntent.reasoningDepth = FAST_REASONING_DEPTH;
    taskIntent.immediateResponse = sourcePackPreview
      ? [`以下是 source pack 的有界预览：`, sourcePackPreview, `本地交接包：${workspaceRelative(sourcePackPath)}`].join("\n\n")
      : "未找到上一轮 source pack 的本地文件，请重新处理原 URL。";
  } else if (ledgerSelection?.selectedOption === "keep-source-pack-local" && previousThreadLedger) {
    const sourcePackPath = join(dirname(previousThreadLedger.path), "artifacts", "public-source", "source-pack", "source-pack.readable.md");
    taskIntent.taskType = "task_management";
    taskIntent.responseMode = "direct_answer";
    taskIntent.executionProfile = FAST_ANSWER_EXECUTION_PROFILE;
    taskIntent.reasoningDepth = FAST_REASONING_DEPTH;
    taskIntent.immediateResponse = `已记录：本轮仅保留本地 source pack，不执行外部知识库写入。交接路径：${workspaceRelative(sourcePackPath)}`;
  }
  /** @type {HandlerTask} */
  const task = /** @type {HandlerTask} */ ({
    schemaVersion: "feishu-task-v1",
    runId,
    status: "running",
    sourceEvent: event,
    requestedAt: nowIso(),
    executionMode: options.executionMode,
    publishMode: options.publishMode,
    replyMode: options.replyMode,
    taskIntent,
    attachments,
    fileContexts,
    fileContextPath: paths.fileContextPath,
    agentTaskPath: paths.agentTaskPath,
    agentOutputPath: paths.agentOutputPath,
    qaGatePath: null,
    policyGatePath: null,
    publishPath: paths.publishPath,
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  });
  writeJson(paths.taskPath, assertFeishuTask(task));
  addStep(state, "task_created", "completed", { artifact: paths.taskPath });
  metrics.taskType = taskIntent.taskType ?? "feishu_agent";
  appendMetric(metrics, "planner", {
    decision: "classified_feishu_task",
    taskType: taskIntent.taskType,
    responseMode: taskIntent.responseMode,
    executionProfile: taskIntent.executionProfile,
    reasoningDepth: taskIntent.reasoningDepth,
    requestedDocuments: taskIntent.requestedDocuments ?? [],
    requiredStages: taskIntent.requiredStages ?? [],
    skipStages: taskIntent.skipStages ?? [],
    sourcePreparation: {
      sourceSetMode: taskIntent.sourcePreparation?.sourceSetMode ?? null,
      inputModalities: taskIntent.sourcePreparation?.inputModalities ?? [],
      sourceCount: taskIntent.sourcePreparation?.sourceReferences?.length ?? 0,
      conflictPolicy: taskIntent.sourcePreparation?.conflictPolicy ?? null,
      explicitFileReferenceCount: taskIntent.sourcePreparation?.explicitFileReferenceCount ?? 0,
    },
  });
  appendMetric(metrics, "artifact", { kind: "task", path: workspaceRelative(paths.taskPath) });
  writeRunMetrics(paths, metrics);
  writeState(paths, state);

  const mergeLatestStateFromDisk = () => {
    if (!existsSync(paths.statePath)) return;
    try {
      const latest = JSON.parse(readFileSync(paths.statePath, "utf8"));
      if (latest?.runId && latest.runId !== state.runId) return;
      const latestSteps = Array.isArray(latest?.steps) ? latest.steps : [];
      if (latestSteps.length > state.steps.length) {
        state.steps = latestSteps;
        state.status = latest.status ?? state.status;
        state.updatedAt = latest.updatedAt ?? state.updatedAt;
      }
    } catch {
      // Keep the in-memory state if the worker is mid-write.
    }
  };

  const runnerOptions = {
    ...options,
    /** @param {string} text @param {string} stage */
    progressReply: async (text, stage) => {
      if (options.progressReplyMode !== "live") {
        const progress = { stage, status: "skipped", reason: "progress_reply_disabled_for_two_phase_stable_runtime", replyMode: options.replyMode, rawSecretsReturned: false };
        appendFileSync(paths.progressPath, `${JSON.stringify(sanitize(progress))}\n`, "utf8");
        appendMetric(metrics, "external", {
          name: "feishu_progress_reply",
          stage,
          mode: options.replyMode,
          status: progress.status,
          reason: progress.reason,
        });
        writeRunMetrics(paths, metrics);
        return progress;
      }
      const progress = await sendProgressReply(event, task, text, paths, options, stage);
      appendMetric(metrics, "external", {
        name: "feishu_progress_reply",
        stage,
        mode: options.replyMode,
        status: progress.status,
        reason: progress.reason ?? null,
      });
      writeRunMetrics(paths, metrics);
      return progress;
    },
    /** @param {string} name @param {string} status @param {UnknownRecord} [details] */
    onStep: async (name, status, details = {}) => {
      mergeLatestStateFromDisk();
      if (status === "running") state.status = "running";
      addStep(state, name, status, details);
      appendMetric(metrics, "tool", {
        name,
        status,
        mode: details?.dockerWorker === true ? "local-docker-document-worker" : "task-execution-runner",
        ...asRecord(sanitize(details)),
      });
      writeRunMetrics(paths, metrics);
      writeState(paths, state);
    },
  };

  /** @type {AgentRun | undefined} */
  let agent;
  const sourceGate = sourceAcquisitionGate(task, attachments, fileContexts);
  if (sourceGate.status === "blocked") {
    const output = createSourceAcquisitionBlockedOutput(task, sourceGate, attachments);
    writeJson(paths.agentOutputPath, output);
    await runnerOptions.onStep("source_acquisition_gate", "blocked", {
      ...sourceGate,
      artifact: paths.agentOutputPath,
    });
    agent = { status: "blocked", output, mode: "source-acquisition-gate", rawSecretsReturned: false };
  } else {
    await runnerOptions.onStep("source_acquisition_gate", "completed", sourceGate);
  }
  if (!agent && options.executionMode === "execute" && shouldUseTaskExecutionRunner(task)) {
    const dockerAgent = await runViaLocalDockerDocumentWorker(task, paths, runnerOptions);
    if (dockerAgent) agent = /** @type {AgentRun} */ ({ ...dockerAgent, output: /** @type {AgentOutput} */ (asRecord(dockerAgent.output)), rawSecretsReturned: false });
    if (!agent) {
      const runnerAgent = await runTaskExecutionPipeline(task, paths, runnerOptions);
      agent = /** @type {AgentRun} */ ({ ...runnerAgent, output: /** @type {AgentOutput} */ (asRecord(runnerAgent.output)), rawSecretsReturned: false });
    }
  } else if (!agent) {
    agent = await runPiAgent(task, paths, options);
  }
  if (!agent) throw new Error("agent_execution_result_missing");
  if (!["task-execution-runner", "local-docker-document-worker"].includes(agent.mode)) {
    addStep(state, "pi_agent_pipeline", agent.status === "completed" ? "completed" : agent.status, { artifact: paths.agentOutputPath });
    appendMetric(metrics, "tool", {
      name: "pi_agent_pipeline",
      mode: agent.mode,
      status: agent.status,
      outputStatus: agent.output?.status ?? null,
    });
  }
  appendMetric(metrics, "artifact", { kind: "agent-output", path: workspaceRelative(paths.agentOutputPath) });
  if (agent.output?.qaGate) appendMetric(metrics, "qaGate", agent.output.qaGate);
  if (agent.output?.policyGate) appendMetric(metrics, "policy", agent.output.policyGate);
  writeRunMetrics(paths, metrics);
  writeState(paths, state);

  const publish = await publishResults(task, agent.output, paths, options);
  addStep(state, "feishu_publish", ["published", "dry_run", "skipped"].includes(publish.status) ? "completed" : "blocked", { artifact: paths.publishPath, reason: publish.reason });
  appendMetric(metrics, "external", {
    name: "feishu_publish",
    mode: options.publishMode,
    status: publish.status,
    reason: publish.reason ?? null,
    documentCount: publish.documents?.length ?? 0,
  });
  appendMetric(metrics, "artifact", { kind: "publish", path: workspaceRelative(paths.publishPath) });
  writeRunMetrics(paths, metrics);
  writeState(paths, state);

  const reply = await replyToFeishu(event, task, agent.output, publish, paths, options);
  addStep(state, "feishu_reply", reply.status === "sent" || reply.status === "dry_run" || reply.status === "skipped" ? "completed" : "failed", { artifact: paths.replyPath, reason: reply.reason });
  appendMetric(metrics, "external", {
    name: "feishu_reply",
    mode: options.replyMode,
    status: reply.status,
    reason: reply.reason ?? null,
  });
  appendMetric(metrics, "artifact", { kind: "reply", path: workspaceRelative(paths.replyPath) });
  state.status = agent.output?.status === "blocked"
    ? "blocked"
    : ["published", "dry_run", "skipped"].includes(publish.status)
      ? "completed"
      : publish.status === "blocked"
        ? "blocked"
        : "needs_fix";
  const ledgerIndex = indexExecutionLedgerForThread(root, event, task.runId, join(paths.runDir, "planner-envelope.json"), agent.output);
  addStep(state, "execution_ledger_thread_index", ledgerIndex.status === "indexed" ? "completed" : "skipped", {
    reason: ledgerIndex.reason ?? null,
    sourceRunId: ledgerSelection?.sourceRunId ?? null,
    selectedOption: ledgerSelection?.selectedOption ?? null,
  });
  writeRunArtifacts({ event, task, state, agentOutput: agent.output, publish, reply, paths, metrics });
  await indexRuntimeStoreRun(paths, options, state, metrics);
  writeState(paths, state);

  const responseText = buildHandlerResponseText(task, agent.output, publish, state.status);

  return {
    status: state.status,
    runId,
    text: responseText,
    summary: agent.output?.summary ?? null,
    runDir: paths.runDir,
    taskPath: paths.taskPath,
    agentOutputPath: paths.agentOutputPath,
    publishPath: paths.publishPath,
    replyPath: paths.replyPath,
    publishStatus: publish.status,
    replyStatus: reply.status,
    documents: (publish.documents ?? []).map((doc) => ({
      docType: doc.docType,
      title: doc.title,
      fileName: doc.fileName,
      status: doc.status,
      url: doc.url ?? null,
      localPath: doc.localPath ?? null,
    })),
    suppressGatewayReply: reply.status === "sent",
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  };
}

/** @param {CliArgs} args @returns {HandlerOptions} */
function optionsFromArgs(args) {
  /** @param {string} key @param {string} fallback */
  const stringArg = (key, fallback) => typeof args[key] === "string" ? args[key] : fallback;
  const executionMode = args.execute ? "execute" : args["mock-agent"] ? "mock" : process.env.FEISHU_AGENT_EXEC_MODE || "mock";
  const publishMode = stringArg("publish-mode", args["dry-run"] ? "dry-run" : process.env.FEISHU_AGENT_PUBLISH_MODE ?? "dry-run");
  const replyMode = stringArg("reply-mode", args["dry-run"] ? "dry-run" : process.env.FEISHU_AGENT_REPLY_MODE ?? "dry-run");
  const modelTimeoutMs = optionalPositiveNumber(args["model-timeout-ms"] ?? process.env.FEISHU_AGENT_MODEL_TIMEOUT_MS);
  const folderToken = typeof args["folder-token"] === "string" ? args["folder-token"] : process.env.FEISHU_AGENT_FOLDER_TOKEN;
  const piCliBin = typeof args["pi-cli-bin"] === "string" ? args["pi-cli-bin"] : process.env.PI_CLI_BIN;
  return {
    outputRoot: stringArg("output-root", process.env.FEISHU_AGENT_OUTPUT_ROOT ?? DEFAULT_OUTPUT_ROOT),
    executionMode,
    publishMode,
    replyMode,
    publishTarget: stringArg("publish-target", process.env.FEISHU_AGENT_PUBLISH_TARGET ?? "auto"),
    publishAs: stringArg("publish-as", process.env.FEISHU_AGENT_PUBLISH_AS ?? "bot"),
    ...(folderToken ? { folderToken } : {}),
    ...(typeof args["wiki-space-id"] === "string" ? { wikiSpaceId: args["wiki-space-id"] } : process.env.FEISHU_WIKI_SPACE_ID ? { wikiSpaceId: process.env.FEISHU_WIKI_SPACE_ID } : {}),
    ...(typeof args["wiki-root-node-token"] === "string" ? { wikiRootNodeToken: args["wiki-root-node-token"] } : process.env.FEISHU_WIKI_ROOT_NODE_TOKEN ? { wikiRootNodeToken: process.env.FEISHU_WIKI_ROOT_NODE_TOKEN } : {}),
    cliTimeoutMs: Number(args["cli-timeout-ms"] ?? process.env.FEISHU_AGENT_CLI_TIMEOUT_MS ?? 120000),
    attachmentDownloadAs: stringArg("attachment-download-as", process.env.FEISHU_AGENT_ATTACHMENT_DOWNLOAD_AS ?? DEFAULT_ATTACHMENT_DOWNLOAD_IDENTITIES.join(",")),
    attachmentDownloadMaxAttempts: Number(args["attachment-download-max-attempts"] ?? process.env.FEISHU_AGENT_ATTACHMENT_DOWNLOAD_MAX_ATTEMPTS ?? DEFAULT_ATTACHMENT_DOWNLOAD_MAX_ATTEMPTS),
    attachmentDownloadTimeoutMs: Number(args["attachment-download-timeout-ms"] ?? process.env.FEISHU_AGENT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS ?? DEFAULT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS),
    piTimeoutMs: Number(args["pi-timeout-ms"] ?? process.env.FEISHU_AGENT_PI_TIMEOUT_MS ?? 900000),
    ...(modelTimeoutMs ? { modelTimeoutMs } : {}),
    captureModelStream: !/^(0|false|no|off)$/i.test(String(args["capture-model-stream"] ?? process.env.FEISHU_AGENT_CAPTURE_MODEL_STREAM ?? "1")),
    ...(piCliBin ? { piCliBin } : {}),
    dryRun: args["dry-run"] === true || /^(1|true|yes|on)$/i.test(process.env.FEISHU_AGENT_DRY_RUN ?? ""),
    asyncMode: args.async === true || /^(1|true|yes|on)$/i.test(process.env.FEISHU_AGENT_ASYNC ?? ""),
    asyncVisibleAck: /^(1|true|yes|on)$/i.test(String(args["async-visible-ack"] ?? process.env.FEISHU_AGENT_ASYNC_VISIBLE_ACK ?? "0")),
    fileAckReplyMode: stringArg("file-ack-reply-mode", process.env.FEISHU_AGENT_FILE_ACK_REPLY_MODE ?? "silent"),
    progressReplyMode: stringArg("progress-reply-mode", process.env.FEISHU_AGENT_PROGRESS_REPLY_MODE ?? "silent"),
    documentWorkerMode: stringArg("document-worker-mode", process.env.FEISHU_AGENT_DOCUMENT_WORKER_MODE ?? "host"),
    ...(typeof args["docker-queue-host"] === "string" ? { dockerQueueHost: args["docker-queue-host"] } : process.env.FEISHU_AGENT_DOCKER_QUEUE_HOST ? { dockerQueueHost: process.env.FEISHU_AGENT_DOCKER_QUEUE_HOST } : {}),
    dockerQueuePort: Number(args["docker-queue-port"] ?? process.env.FEISHU_AGENT_DOCKER_QUEUE_PORT ?? 6379),
    ...(typeof args["docker-queue-name"] === "string" ? { dockerQueueName: args["docker-queue-name"] } : process.env.FEISHU_AGENT_DOCKER_QUEUE_NAME ? { dockerQueueName: process.env.FEISHU_AGENT_DOCKER_QUEUE_NAME } : {}),
    dockerWorkerWaitTimeoutMs: Number(args["docker-worker-wait-timeout-ms"] ?? args["docker-worker-timeout-ms"] ?? process.env.FEISHU_AGENT_DOCKER_WORKER_WAIT_TIMEOUT_MS ?? process.env.FEISHU_AGENT_DOCKER_WORKER_TIMEOUT_MS ?? process.env.FEISHU_AGENT_LONG_DOCUMENT_JOB_TIMEOUT_MS ?? 7_200_000),
    dockerQueueMaxDepth: Number(args["docker-queue-max-depth"] ?? process.env.FEISHU_AGENT_DOCKER_QUEUE_MAX_DEPTH ?? 100),
    documentWorkerTimeoutMs: Number(args["document-worker-timeout-ms"] ?? process.env.FEISHU_AGENT_DOCUMENT_WORKER_TIMEOUT_MS ?? 1_800_000),
    longDocumentJobTimeoutMs: Number(args["long-document-job-timeout-ms"] ?? process.env.FEISHU_AGENT_LONG_DOCUMENT_JOB_TIMEOUT_MS ?? 7_200_000),
    documentWorkerDeadlineReserveMs: Number(args["document-worker-deadline-reserve-ms"] ?? process.env.FEISHU_AGENT_DOCUMENT_WORKER_DEADLINE_RESERVE_MS ?? 30_000),
    documentQualityMode: stringArg("document-quality-mode", process.env.FEISHU_AGENT_DOCUMENT_QUALITY_MODE ?? "stable"),
    documentWorkerMaxAttemptsPerUnit: Number(args["document-worker-max-attempts-per-unit"] ?? process.env.FEISHU_AGENT_DOCUMENT_WORKER_MAX_ATTEMPTS_PER_UNIT ?? 3),
    documentWorkerMaxRetryUnits: Number(args["document-worker-max-retry-units"] ?? process.env.FEISHU_AGENT_DOCUMENT_WORKER_MAX_RETRY_UNITS ?? 12),
    runtimeStoreMode: stringArg("runtime-store-mode", process.env.FEISHU_AGENT_RUNTIME_STORE_MODE ?? "index"),
    runtimeStoreCas: /^(1|true|yes|on)$/i.test(String(args["runtime-store-cas"] ?? process.env.FEISHU_AGENT_RUNTIME_STORE_CAS ?? "1")),
    runtimeStoreTimeoutMs: Number(args["runtime-store-timeout-ms"] ?? process.env.FEISHU_AGENT_RUNTIME_STORE_TIMEOUT_MS ?? 120000),
  };
}

/** @param {import("node:http").IncomingMessage} req @returns {Promise<string>} */
async function readRequestBody(req) {
  return await new Promise((resolveBody, rejectBody) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10_000_000) {
        rejectBody(new Error("request_body_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => resolveBody(body));
    req.on("error", rejectBody);
  });
}

/** @param {import("node:http").ServerResponse} res @param {number} status @param {unknown} payload */
function sendJson(res, status, payload) {
  const body = `${JSON.stringify(sanitize(payload), null, 2)}\n`;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

/** @param {HandlerOptions} options @param {string} host @param {number} port */
function startServer(options, host, port) {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        sendJson(res, 200, { status: "ok", component: "feishu-agent-task-handler", rawSecretsReturned: false });
        return;
      }
      if (req.method !== "POST" || (req.url !== "/feishu/events" && req.url !== "/feishu/tasks")) {
        sendJson(res, 404, { status: "not_found", rawSecretsReturned: false });
        return;
      }
      const body = await readRequestBody(req);
      const payload = body.trim() ? JSON.parse(body) : {};
      if (options.asyncMode) {
        const event = normalizeDirectEvent(payload);
        const root = outputRoot(options.outputRoot);
        const runId = runIdFor(event);
        handleEvent(event, { ...options, runId }).catch((error) => {
          console.error(JSON.stringify({ status: "async_failed", runId, reason: redactString(error instanceof Error ? error.message : error), rawSecretsReturned: false }, null, 2));
        });
        sendJson(res, 202, {
          status: "accepted",
          ingressMode: "ack_only",
          finalReplyMode: "runner_live_reply",
          runId,
          userVisibleRunId: false,
          summary: "accepted; background Agent pipeline is running",
          text: "已接受任务，正在处理。",
          documents: [],
          publishStatus: "pending",
          replyStatus: "pending",
          runDir: runPaths(root, runId).runDir,
          suppressGatewayReply: !options.asyncVisibleAck,
          asyncVisibleAck: options.asyncVisibleAck,
          rawSecretsReturned: false,
          rawMediaExternalUpload: false,
        });
        return;
      }
      const result = await handleEvent(payload, options);
      sendJson(res, result.status === "blocked" ? 202 : 200, result);
    } catch (error) {
      sendJson(res, 500, { status: "failed", reason: redactString(error instanceof Error ? error.message : error), rawSecretsReturned: false });
    }
  });
  server.listen(port, host, () => {
    console.log(JSON.stringify({ status: "started", component: "feishu-agent-task-handler", host, port, executionMode: options.executionMode, publishMode: options.publishMode, replyMode: options.replyMode, asyncMode: options.asyncMode, rawSecretsReturned: false }));
  });
  return server;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const options = optionsFromArgs(args);
  if (args.fixture) {
    if (typeof args.fixture !== "string") throw new Error("feishu_agent_fixture_path_invalid");
    const input = JSON.parse(readFileSync(resolve(args.fixture), "utf8"));
    const runId = typeof args["run-id"] === "string" ? args["run-id"] : undefined;
    const result = await handleEvent(input, { ...options, ...(runId ? { runId } : {}) });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const host = typeof args.host === "string" ? args.host : process.env.FEISHU_AGENT_HANDLER_HOST ?? DEFAULT_HOST;
  const port = Number(args.port ?? process.env.FEISHU_AGENT_HANDLER_PORT ?? DEFAULT_PORT);
  startServer(options, host, port);
}

export { addStep, normalizeDirectEvent, optionsFromArgs };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: "failed", reason: redactString(error instanceof Error ? error.message : error), rawSecretsReturned: false }, null, 2));
    process.exit(2);
  });
}
