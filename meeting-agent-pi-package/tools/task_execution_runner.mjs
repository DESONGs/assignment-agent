import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { AUDIO_NORMALIZE_VERSION, TARGET_AUDIO_SPEC, normalizeAudioBatch } from "./audio_normalize_helpers.mjs";
import { cloudAsrMediaKind, isCloudAsrMedia, mediaExtension } from "./asr_media_formats.mjs";
import { fetchFeishuDocumentReviewContext } from "./feishu_document_review_context_helpers.mjs";
import {
  buildFallbackMeetingAnalysis,
  buildMeetingAnalysisPrompt,
  buildMeetingQaFindings,
  buildParticipantMap,
  normalizeMeetingAnalysisResponse,
  normalizeMeetingSegments,
} from "./meeting_intelligence_helpers.mjs";
import { buildMeetingOrchestrationPlan } from "./meeting_workflow_helpers.mjs";
import {
  buildPiMeetingOrchestrationInvocation,
  loadPiMeetingOrchestrationEnv,
  parsePiMeetingOrchestrationOutput,
  reconcilePiMeetingOrchestrationResult,
  shouldRunPiMeetingOrchestration,
} from "./pi_meeting_orchestration_helpers.mjs";
import {
  buildMeetingMemoryCuratorPlan,
  buildPiMeetingMemoryInvocation,
  extractMeetingMemoryPayload,
  persistMeetingMemory,
  reconcileMeetingMemoryCandidates,
} from "./meeting_memory_helpers.mjs";
import { extractPublicUrls, redactSensitiveUrlsInText, sanitizeUrlForArtifact } from "./public_url_security.mjs";
import { resolvePublicMediaSource, resolutionArtifactView } from "./public_url_source_helpers.mjs";
import {
  buildKnowledgeSourcePack,
  buildProvenanceIndex,
  buildSourceChapterPrompt,
  normalizeSourceChapterAnalysis,
  normalizeSourceSegments,
  partitionSourceSegments,
  renderKnowledgeSourcePack,
  writeOfficialTranscriptArtifacts,
} from "./public_url_source_pack_helpers.mjs";
import {
  assertFeishuTask,
  FULL_DOCUMENT_EXECUTION_PROFILES as FULL_DOCUMENT_EXECUTION_PROFILE_VALUES,
  RUNNER_EXECUTION_PROFILES as RUNNER_EXECUTION_PROFILE_VALUES,
} from "../dist/index.js";

/**
 * Thin task execution runner.
 *
 * This module is intentionally not a second orchestrator. It executes observable
 * stages for a task that has already been classified by the IM adapter and uses
 * the existing PI runtime tools for Planner, Model Router, Prompt Registry,
 * Document Worker, QA Gate, and Policy Gate decisions.
 */

const toolDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(toolDir);
const workspaceDir = dirname(packageDir);
const runtimeToolCli = join(toolDir, "runtime_tool_cli.mjs");
const dashscopeAsrClient = join(toolDir, "dashscope_asr_client.mjs");
const executionProfilesPath = join(packageDir, "runtime", "execution-profiles.json");
const DEFAULT_RUNTIME_TOOL_TIMEOUT_MS = 600_000;
const DEFAULT_DOCUMENT_WORKER_TIMEOUT_MS = 1_800_000;
const DEFAULT_LONG_DOCUMENT_JOB_TIMEOUT_MS = 7_200_000;
const DOCUMENT_WORKER_KILL_MARGIN_MS = 30_000;
const DEFAULT_DOCUMENT_WORKER_DEADLINE_RESERVE_MS = 30_000;
const DEFAULT_CLOUD_ASR_TIMEOUT_MS = 1_800_000;
const DEFAULT_CLOUD_ASR_MODEL = "paraformer-realtime-v2";
const DEFAULT_CLOUD_ASR_FILE_MODEL = "fun-asr";
const DEFAULT_CLOUD_ASR_SINGLE_MIX_REVIEW_MODEL = "paraformer-v2";
const DEFAULT_CLOUD_ASR_LANGUAGE_HINTS = ["yue", "zh", "en"];
const DEFAULT_MEETING_AGENTIC_DELEGATION_TIMEOUT_MS = 1_800_000;
const DEFAULT_MEETING_AGENTIC_EVENT_MAX_CHARS = 25_000_000;
const DEFAULT_MEETING_MEMORY_TIMEOUT_MS = 900_000;

/** @type {Set<string>} */
const RUNNER_EXECUTION_PROFILES = new Set(RUNNER_EXECUTION_PROFILE_VALUES);
/** @type {Set<string>} */
const FULL_DOCUMENT_EXECUTION_PROFILES = new Set(FULL_DOCUMENT_EXECUTION_PROFILE_VALUES);
const DEFAULT_FILE_SUMMARY_CONTEXT_POLICY = {
  maxSources: 6,
  previewCharsPerSource: 4000,
  extractedSliceChars: 5000,
  maxExtractedSlicesPerSource: 2,
  maxPromptChars: 30000,
};

/**
 * @typedef {Record<string, unknown>} UnknownRecord
 * @typedef {import("../dist/index.js").FeishuTask} FeishuTask
 * @typedef {UnknownRecord & { resourceType?: string, localPath?: string, fileName?: string, name?: string, sha256?: string, sizeBytes?: number, [key: string]: unknown }} RunnerAttachment
 * @typedef {UnknownRecord & { status?: string, fileName?: string, fileType?: string, extension?: string, contextPreview?: string, extractedTextPath?: string, localPath?: string, contextMode?: string, [key: string]: unknown }} RunnerFileContext
 * @typedef {FeishuTask & { attachments?: RunnerAttachment[], fileContexts?: UnknownRecord & { contexts?: RunnerFileContext[] } }} RunnerTask
 * @typedef {{ runDir: string, inputsDir: string, artifactsDir: string, agentOutputPath: string, [key: string]: string }} RunnerPaths
 * @typedef {{ exitCode: number, stdout: string, stderr: string, timedOut: boolean, error?: string }} CommandResult
 * @typedef {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, stdin?: string, maxOutputChars?: number }} CommandOptions
 * @typedef {{ ok: boolean, statusCode: number, body: unknown, text: string, error?: string }} HttpJsonResult
 * @typedef {HttpJsonResult & { timeoutMs: number, modelLoaded: boolean, lastStatus: unknown, serviceBusy: boolean, healthStatus: unknown, tcpReachable: boolean }} LocalAsrHealth
 * @typedef {{ onStep?: (name: string, status: string, details?: UnknownRecord) => Promise<unknown> | unknown, onMetric?: (kind: string, payload: UnknownRecord) => Promise<unknown> | unknown, progressReply?: (text: string, stage: string) => Promise<unknown> | unknown }} RunnerHooks
 * @typedef {RunnerHooks & { runtimeToolTimeoutMs?: number, modelTimeoutMs?: number, cliTimeoutMs?: number, documentWorkerTimeoutMs?: number, longDocumentJobTimeoutMs?: number, documentWorkerDeadlineReserveMs?: number, cloudAsrTimeoutMs?: number, localAsrTimeoutMs?: number, localAsrHealthTimeoutMs?: number, localAsrServiceUrl?: string, localAsrChunkSeconds?: number, localAsrMaxNewTokens?: number, localAsrModelDir?: string, audioNormalizeTimeoutMs?: number, audioTranscoder?: string, asrProvider?: string, asrFallbackProvider?: string, aliyunAsrModel?: string, aliyunAsrFileModel?: string, aliyunAsrSingleMixReviewModel?: string, aliyunAsrEndpoint?: string, aliyunAsrFileEndpoint?: string, aliyunAsrInputMode?: string, aliyunAsrSampleRate?: number, aliyunAsrLanguageHints?: string | string[], aliyunAsrVocabularyId?: string, aliyunDashscopeWorkspaceId?: string, aliyunAsrDiarizationEnabled?: unknown, aliyunAsrSpeakerCount?: unknown, aliyunAsrTimestampAlignmentEnabled?: unknown, aliyunAsrSingleMixMode?: unknown, cloudAsrMockFileProvider?: boolean, cloudAsrMockFileSentences?: UnknownRecord[], pipelineMockModel?: boolean, captureModelStream?: boolean, fastAnswerMaxTokens?: number, fileSummaryMaxTokens?: number, meetingMaxTokens?: number, meetingAnalysisMaxPromptChars?: number, meetingAnalysisMaxTokens?: number, meetingAnalysis?: unknown, meetingAgenticDelegation?: unknown, meetingAgenticDelegationTimeoutMs?: number, meetingAgenticEventMaxChars?: number, meetingMemoryCuration?: unknown, meetingMemoryTimeoutMs?: number, sectionsPerBatch?: number, sectionsPerUnit?: number, documentQualityMode?: string, documentWorkerMaxAttemptsPerUnit?: number, documentWorkerMaxRetryUnits?: number, publicUrlChapterChars?: number, publicUrlChapterDurationMs?: number, publicUrlChapterMaxTokens?: number, publicUrlMaxDurationSec?: number, publicUrlMaxMediaBytes?: number, publicUrlMaxPageBytes?: number, publicUrlMaxTranscriptBytes?: number, publicUrlMediaTimeoutMs?: number, publicUrlTimeoutMs?: number, publicUrlResolveOnly?: boolean, publicUrlResolver?: typeof resolvePublicMediaSource, ytDlpBin?: string, [key: string]: unknown }} RunnerOptions
 * @typedef {UnknownRecord & { status: string, summary?: string, documents?: UnknownRecord[], artifacts?: unknown[], details?: UnknownRecord, qaGate?: UnknownRecord, policyGate?: UnknownRecord }} PipelineOutput
 * @typedef {{ status: string, output: PipelineOutput, mode: string, rawSecretsReturned: false }} PipelineRun
 * @typedef {{ id: string, config: UnknownRecord }} ExecutionProfileSelection
 * @typedef {{ originType: unknown, sourceUrl: unknown, sourceFile: unknown, sourceHashSha256: unknown }} SourceSegmentProvenance
 * @typedef {{ segmentId: string, startMs: number, endMs: number, text: string, speaker: unknown, language: unknown, quality: unknown, provenance: SourceSegmentProvenance }} SourceSegment
 * @typedef {{ chapterId: string, order: number, officialTitle?: string, startMs: number, endMs: number, segmentIds: string[], segments: SourceSegment[], charCount: number, bounded: boolean }} SourceChapter
 * @typedef {ReturnType<typeof normalizeSourceChapterAnalysis>} ChapterAnalysis
 * @typedef {{ path: string, sha256?: string, name?: unknown, sizeBytes?: unknown, resourceType: string, ext: string }} AudioSource
 * @typedef {UnknownRecord & { provider: string, model: string, fileModel: string, inputMode: string, singleMixMode: string, singleMixReviewModel: string, diarizationEnabled: unknown, speakerCount: unknown, languageHints: string[], vocabularyId: string, timestampAlignmentEnabled: unknown, endpoint: string, fileEndpoint: string, workspaceId: string }} AsrProviderConfig
 */

/** @param {unknown} value @returns {UnknownRecord} */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {UnknownRecord} */ (value)
    : {};
}

/** @param {unknown} value @returns {unknown[]} */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** @param {RunnerOptions} options @returns {RunnerHooks} */
function runnerHooks(options) {
  return {
    ...(typeof options.onStep === "function" ? { onStep: options.onStep } : {}),
    ...(typeof options.onMetric === "function" ? { onMetric: options.onMetric } : {}),
    ...(typeof options.progressReply === "function" ? { progressReply: options.progressReply } : {}),
  };
}

/** @param {string} status @param {PipelineOutput} output @param {string} [mode] @returns {PipelineRun} */
function createPipelineRun(status, output, mode = "task-execution-runner") {
  return { status, output, mode, rawSecretsReturned: false };
}
function nowIso() {
  return new Date().toISOString();
}

/** @param {string} parent @param {string} child */
function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** @param {string} path @param {unknown} value */
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sanitize(value), null, 2)}\n`, "utf8");
  return path;
}

/** @param {string} path @param {unknown} value */
function writeRawJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

/** @param {string} path @param {string} value */
function writeText(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
  return path;
}

/** @param {string} path @returns {UnknownRecord} */
function loadJson(path) {
  return asRecord(JSON.parse(readFileSync(path, "utf8")));
}

/** @type {UnknownRecord | null} */
let executionProfilesCache = null;

/** @returns {UnknownRecord} */
function defaultExecutionProfiles() {
  return {
    version: "execution-profiles-v1",
    profiles: {
      fast_answer: { runnerEligible: true, pipeline: "fast_answer", routeTaskType: "fast_draft", reasoningDepth: "fast" },
      file_summary: {
        runnerEligible: true,
        pipeline: "file_summary",
        routeTaskType: "fast_draft",
        reasoningDepth: "fast",
        contextPolicy: DEFAULT_FILE_SUMMARY_CONTEXT_POLICY,
      },
      audio_minutes: { runnerEligible: true, pipeline: "full_document", routeTaskType: "meeting_minutes", reasoningDepth: "deep" },
      document_generation: { runnerEligible: true, pipeline: "full_document", routeTaskType: "document_shard", reasoningDepth: "deep" },
      document_revision: { runnerEligible: true, pipeline: "full_document", routeTaskType: "document_shard", reasoningDepth: "deep", operation: "document_revision" },
      multi_source_synthesis: { runnerEligible: true, pipeline: "full_document", routeTaskType: "document_shard", reasoningDepth: "deep" },
      url_source_pack: { runnerEligible: true, pipeline: "url_source_pack", routeTaskType: "document_shard", reasoningDepth: "deep" },
      publish_only: { runnerEligible: false, pipeline: "immediate" },
      unsupported: { runnerEligible: false, pipeline: "immediate" },
    },
  };
}

/** @returns {UnknownRecord} */
function loadExecutionProfiles() {
  if (executionProfilesCache) return executionProfilesCache;
  try {
    executionProfilesCache = loadJson(executionProfilesPath);
  } catch {
    executionProfilesCache = defaultExecutionProfiles();
  }
  return executionProfilesCache;
}

/** @param {unknown} value */
function normalizeExecutionProfile(value) {
  const profile = String(value ?? "").trim();
  return profile || null;
}

/** @param {RunnerTask} task @returns {ExecutionProfileSelection | null} */
function executionProfileForTask(task) {
  const id = normalizeExecutionProfile(task.taskIntent?.executionProfile);
  if (!id) return null;
  const config = asRecord(asRecord(loadExecutionProfiles().profiles)[id]);
  return { id, config };
}

/** @param {unknown} value @param {string} [fallback] */
function safeSegment(value, fallback = "item") {
  const cleaned = String(value || fallback).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned;
}

/** @param {unknown} value @param {string} [fallback] */
function safeFileName(value, fallback = "meeting-minutes.md") {
  const name = String(value || fallback).replace(/[\/\\:*?"<>|]/g, "_").trim().slice(0, 120) || fallback;
  return name.endsWith(".md") ? name : `${name}.md`;
}

/** @param {string} artifactsDir */
function titlePlanPath(artifactsDir) {
  return join(artifactsDir, "document-title-plan.json");
}

/** @param {unknown} value */
function redactString(value) {
  return redactSensitiveUrlsInText(String(value ?? ""))
    .replace(/(app_secret|client_secret|refresh_token|access_token|authorization|cookie|session)\s*[:=]\s*["']?[^"',\s]+/gi, "[redacted]")
    .replace(/bearer\s+[A-Za-z0-9._-]+/gi, "[redacted]");
}

/** @param {unknown} value @returns {unknown} */
function sanitize(value) {
  if (typeof value === "string") return redactString(value).slice(0, 20000);
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    /** @type {UnknownRecord} */
    const output = {};
    for (const [key, entryValue] of Object.entries(value)) {
      if (/secret|cookie|session|authorization/i.test(key) && !["rawSecretsReturned", "cookiesUsed"].includes(key) && !/folderToken|fileToken|wikiToken/i.test(key)) {
        output[key] = "[redacted]";
      } else {
        output[key] = sanitize(entryValue);
      }
    }
    return output;
  }
  return value;
}

/** @param {unknown} value */
function hashText(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

/** @param {unknown} values @param {number} [limit] @returns {string[]} */
function uniqueStrings(values, limit = 100) {
  return [...new Set(asArray(values).map((value) => String(value ?? "").trim()).filter(Boolean))].slice(0, limit);
}

/** @param {unknown} path */
function workspaceRelative(path) {
  if (!path) return null;
  if (typeof path !== "string") return "[outside-workspace]";
  const resolved = resolve(path);
  return isInside(workspaceDir, resolved) ? relative(workspaceDir, resolved) : "[outside-workspace]";
}

/** @param {unknown} text */
function cleanUserPrompt(text) {
  return String(text ?? "")
    .replace(/@\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** @param {unknown} text */
function cleanPromptForTitle(text) {
  return cleanUserPrompt(text)
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\[[^\]]+\]\([^)]+\)/g, " ")
    .replace(/[\[\]【】（）()]/g, " ")
    .replace(/\b(file|doc|docx|sheet|wiki|token)[_-]?[A-Za-z0-9_-]{8,}\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** @param {string} command @param {string[]} args @param {CommandOptions} [options] @returns {Promise<CommandResult>} */
function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const maxOutputChars = Number(options.maxOutputChars ?? 5_000_000);
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
      if (stdout.length > maxOutputChars) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > maxOutputChars) child.kill("SIGTERM");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      const errorCode = "code" in error ? error.code : null;
      resolveCommand({ exitCode: errorCode === "ENOENT" ? 127 : 1, stdout, stderr, timedOut, error: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolveCommand({ exitCode: code ?? (signal ? 128 : 1), stdout, stderr, timedOut });
    });
    child.stdin.end(options.stdin ?? "");
  });
}

/** @param {unknown} raw */
function optionalPositiveNumber(raw) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** @param {RunnerOptions} [options] */
function documentWorkerTimeoutMs(options = {}) {
  return optionalPositiveNumber(
    options.longDocumentJobTimeoutMs ??
    process.env.FEISHU_AGENT_LONG_DOCUMENT_JOB_TIMEOUT_MS ??
    options.documentWorkerTimeoutMs ??
    process.env.FEISHU_AGENT_DOCUMENT_WORKER_TIMEOUT_MS,
  ) ?? DEFAULT_LONG_DOCUMENT_JOB_TIMEOUT_MS ?? DEFAULT_DOCUMENT_WORKER_TIMEOUT_MS;
}

/** @param {RunnerOptions} [options] */
function documentWorkerDeadlineReserveMs(options = {}) {
  return optionalPositiveNumber(options.documentWorkerDeadlineReserveMs ?? process.env.FEISHU_AGENT_DOCUMENT_WORKER_DEADLINE_RESERVE_MS) ?? DEFAULT_DOCUMENT_WORKER_DEADLINE_RESERVE_MS;
}

/** @param {RunnerOptions} [options] */
function documentWorkerDeadlineParams(options = {}) {
  const runtimeBudgetMs = documentWorkerTimeoutMs(options);
  const deadlineReserveMs = documentWorkerDeadlineReserveMs(options);
  return {
    runtimeBudgetMs,
    deadlineReserveMs,
    deadlineAt: new Date(Date.now() + runtimeBudgetMs).toISOString(),
  };
}

/** @param {string} root @param {(path: string) => boolean} [predicate] @param {number} [limit] @returns {string[]} */
function listFilesRecursive(root, predicate = (_path) => true, limit = 200) {
  if (!existsSync(root) || limit <= 0) return [];
  /** @type {string[]} */
  const files = [];
  /** @param {string} dir */
  function visit(dir) {
    if (files.length >= limit) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (predicate(path)) {
        files.push(path);
      }
      if (files.length >= limit) return;
    }
  }
  visit(root);
  return files;
}

/** @param {string} path @param {number} [limit] @returns {UnknownRecord[]} */
function readNdjson(path, limit = 200) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return asRecord(JSON.parse(line));
      } catch {
        return { event: "parse_error", rawPreview: line.slice(0, 200) };
      }
    });
}

/** @param {RunnerPaths} paths @param {CommandResult} result @param {UnknownRecord} [details] */
function documentWorkerTimeoutDiagnostic(paths, result, details = {}) {
  const traceRoot = join(paths.runDir, "artifacts", "model-streams", "document_workers_run");
  const attemptsPath = join(traceRoot, "attempts.ndjson");
  const attempts = readNdjson(attemptsPath);
  const partials = listFilesRecursive(join(traceRoot, "partials"), (path) => path.endsWith(".md"));
  const streamSummaries = listFilesRecursive(join(traceRoot, "streams"), (path) => path.endsWith(".summary.json"));
  return {
    status: "blocked",
    reason: "document_worker_timeout_diagnostic",
    originalReason: "runtime_tool_failed",
    tool: "document_workers_run",
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    timeoutBudgetMs: details.timeoutMs ?? null,
    traceRoot,
    attemptsPath: existsSync(attemptsPath) ? attemptsPath : null,
    attemptCount: attempts.length,
    partialCount: partials.length,
    streamSummaryCount: streamSummaries.length,
    lastAttempt: attempts.at(-1) ?? null,
    partialPaths: partials.slice(0, 24),
    streamSummaryPaths: streamSummaries.slice(0, 24),
    stderrTail: redactString(result.stderr ?? "").slice(-1600),
    stdoutTail: redactString(result.stdout ?? "").slice(-1200),
    rawSecretsReturned: false,
  };
}

/** @param {unknown} workerRunValue */
function lastAttemptFromWorkerRun(workerRunValue) {
  const workerRun = asRecord(workerRunValue);
  if (workerRun.lastAttempt) return workerRun.lastAttempt;
  const finalFailureReport = asRecord(workerRun.finalFailureReport);
  if (finalFailureReport.lastProviderAttempt) return finalFailureReport.lastProviderAttempt;
  const results = asArray(workerRun.results).map(asRecord);
  for (const result of [...results].reverse()) {
    const attempts = [
      ...(Array.isArray(result?.repairAttempts) ? result.repairAttempts : []),
      ...(Array.isArray(result?.sectionAttempts) ? result.sectionAttempts : []),
    ];
    for (const attemptValue of attempts.reverse()) {
      const attempt = asRecord(attemptValue);
      const failures = Array.isArray(attempt?.attemptFailures) ? attempt.attemptFailures : [];
      const last = asRecord(failures.at(-1));
      if (Object.keys(last).length > 0) {
        return {
          docType: result.docType ?? null,
          batchIndex: attempt.batchIndex ?? attempt.repairIndex ?? null,
          provider: last.provider ?? attempt.provider ?? null,
          model: last.model ?? attempt.model ?? null,
          status: last.status ?? attempt.status ?? null,
          reason: last.reason ?? attempt.reason ?? null,
          httpStatus: last.httpStatus ?? null,
          timeoutMs: last.timeoutMs ?? null,
        };
      }
    }
  }
  return null;
}

/** @param {unknown} reason @param {unknown} [lastAttemptValue] */
function chineseFailureReason(reason, lastAttemptValue = null) {
  const lastAttempt = asRecord(lastAttemptValue);
  const finalReason = String(lastAttempt.reason ?? reason ?? "document_workflow_not_completed");
  if (finalReason === "model_provider_unavailable") return "模型 provider 未配置或当前不可用";
  if (finalReason === "model_provider_request_timeout" || finalReason === "document_worker_deadline_exhausted") return "模型生成多次超时";
  if (finalReason === "model_provider_empty_response") return "模型返回为空";
  if (finalReason === "model_provider_http_error") return `模型服务返回 HTTP ${lastAttempt?.httpStatus ?? "错误"}`;
  if (finalReason === "document_sections_missing_after_repair") return "文档章节修复后仍有缺失";
  if (finalReason === "no_section_batch_completed") return "没有任何章节生成成功";
  if (finalReason === "local_docker_worker_timeout") return "本地 Docker 文档 worker 未在限定时间内完成";
  if (finalReason === "local_docker_worker_unavailable") return "本地 Docker 文档 worker 不可用";
  return finalReason;
}

/** @param {unknown} workerRunValue @param {string} [fallbackReason] */
function finalFailureReportFromWorkerRun(workerRunValue, fallbackReason = "document_workflow_not_completed") {
  const workerRun = asRecord(workerRunValue);
  const workflow = asRecord(workerRun.workflow);
  const existing = workerRun.finalFailureReport;
  if (existing && typeof existing === "object") return existing;
  const results = asArray(workerRun.results).map(asRecord);
  const lastAttempt = lastAttemptFromWorkerRun(workerRun);
  const pendingDocs = results
    .filter((result) => result?.status !== "completed")
    .map((result) => ({
      docType: result.docType,
      status: result.status,
      reason: result.reason ?? null,
      missingSections: asArray(result.missingSections),
    }));
  return {
    schemaVersion: "document-workflow-final-failure-v1",
    terminalReason: workerRun?.reason ?? fallbackReason,
    status: workerRun?.status ?? "blocked",
    completedDocs: results.filter((result) => result?.status === "completed").map((result) => result.docType).filter(Boolean),
    pendingDocs,
    failedStage: pendingDocs[0]?.missingSections?.length ? "review" : "section_draft",
    retryCount: Number(workflow.retryUnitsUsed ?? 0),
    retryExhausted: Boolean(workflow.retryExhausted),
    lastProviderAttempt: lastAttempt,
    nextAction: workflow.checkpointPath ? "已保留本地 checkpoint，可修复阻塞原因后继续未完成章节。" : "修复阻塞原因后重新运行任务。",
    publishPartial: false,
    rawSecretsReturned: false,
  };
}

/** @param {unknown} reportValue */
function finalFailureSummary(reportValue) {
  const report = asRecord(reportValue);
  const reasonText = chineseFailureReason(report?.terminalReason, report?.lastProviderAttempt);
  const pending = Array.isArray(report?.pendingDocs) && report.pendingDocs.length > 0
    ? report.pendingDocs.map((doc) => `${doc.docType}${doc.missingSections?.length ? ` 缺失 ${doc.missingSections.length} 个章节` : ""}`).slice(0, 3).join("；")
    : "无可发布文档";
  const retryText = Number(report?.retryCount ?? 0) > 0 ? `已按 checkpoint 重试 ${report.retryCount} 次。` : "已检查 checkpoint，暂无可发布结果。";
  return `文档生成未能最终交付：${reasonText}。${retryText}未发布阶段稿。未完成：${pending}。下一步：${report?.nextAction ?? "修复阻塞原因后继续运行。"}`;
}

/** @param {string} tool @param {UnknownRecord} params @param {RunnerPaths} paths @param {RunnerOptions} options @param {string} [profile] @param {{timeoutMs?: number}} [callOptions] @returns {Promise<UnknownRecord>} */
async function callRuntimeTool(tool, params, paths, options, profile = "", callOptions = {}) {
  const paramsDir = join(paths.runDir, "runtime-tool-params");
  const outDir = join(paths.runDir, "runtime-tool-results");
  mkdirSync(paramsDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  const paramsPath = join(paramsDir, `${safeSegment(tool)}-${hashText(JSON.stringify(params)).slice(0, 12)}.json`);
  const outPath = join(outDir, `${safeSegment(tool)}-${Date.now()}.json`);
  writeRawJson(paramsPath, params);
  const args = ["--experimental-strip-types", runtimeToolCli];
  if (profile) args.push("--profile", profile);
  args.push("--tool", tool, "--params-file", paramsPath, "--out", outPath);
  const timeoutMs = callOptions.timeoutMs ?? options.runtimeToolTimeoutMs ?? DEFAULT_RUNTIME_TOOL_TIMEOUT_MS;
  const result = await runCommand(process.execPath, args, { timeoutMs });
  if (result.exitCode !== 0 || !existsSync(outPath)) {
    if (tool === "document_workers_run") {
      return documentWorkerTimeoutDiagnostic(paths, result, { timeoutMs });
    }
    return {
      status: "blocked",
      reason: "runtime_tool_failed",
      tool,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      timeoutMs,
      stderrTail: redactString(result.stderr).slice(-1600),
      stdoutTail: redactString(result.stdout).slice(-1200),
      rawSecretsReturned: false,
    };
  }
  return loadJson(outPath);
}

/** @param {unknown} taskValue */
export function shouldUseTaskExecutionRunner(taskValue) {
  let task;
  try {
    task = /** @type {RunnerTask} */ (assertFeishuTask(taskValue));
  } catch {
    return false;
  }
  if (typeof task.taskIntent.responseMode === "string" && ["unsupported", "needs_file", "ack_file_cached"].includes(task.taskIntent.responseMode)) return false;
  if (typeof task?.taskIntent?.immediateResponse === "string" && task.taskIntent.immediateResponse.trim()) return false;
  const profile = executionProfileForTask(task);
  if (!profile) return false;
  if (!RUNNER_EXECUTION_PROFILES.has(profile.id)) return false;
  return profile.config?.runnerEligible !== false;
}

/** @param {UnknownRecord} params @param {RunnerPaths} paths @param {RunnerOptions} options @param {string} [profile] @returns {Promise<UnknownRecord>} */
async function callModelGenerateText(params, paths, options, profile = "") {
  return await callRuntimeTool("model_generate_text", params, paths, options, profile);
}

/** @param {unknown} value */
function normalizeAsrServiceUrl(value) {
  let url;
  try {
    url = new URL(typeof value === "string" && value ? value : process.env.LOCAL_ASR_SERVICE_URL || "http://127.0.0.1:8765");
  } catch {
    throw new Error("local_asr_service_url_invalid");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("local_asr_service_url_scheme_blocked");
  if (url.username || url.password) throw new Error("local_asr_service_url_credentials_blocked");
  const host = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  const isLoopback = host === "localhost" || host === "::1" || /^127\.(\d{1,3}\.){2}\d{1,3}$/.test(host);
  if (!isLoopback) throw new Error("local_asr_service_url_non_loopback_blocked");
  return url.origin;
}

/** @param {string} url @param {unknown} payload @param {number} timeoutMs @param {string | null | undefined} bearerToken @returns {Promise<HttpJsonResult>} */
function postJson(url, payload, timeoutMs, bearerToken) {
  return new Promise((/** @type {(value: HttpJsonResult) => void} */ resolveRequest) => {
    const parsed = new URL("/v1/transcriptions", url.endsWith("/") ? url : `${url}/`);
    const body = JSON.stringify(payload);
    const requestImpl = parsed.protocol === "https:" ? httpsRequest : httpRequest;
    const req = requestImpl(
      parsed,
      {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
          if (Buffer.byteLength(text, "utf8") > 20 * 1024 * 1024) req.destroy(new Error("local ASR response exceeded 20MB"));
        });
        res.on("end", () => {
          let bodyJson = null;
          try {
            bodyJson = text ? JSON.parse(text) : null;
          } catch {
            bodyJson = null;
          }
          resolveRequest({ ok: Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300), statusCode: res.statusCode ?? 0, body: bodyJson, text });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("local ASR request timed out")));
    req.on("error", (error) => resolveRequest({ ok: false, statusCode: 0, body: null, text: "", error: error.message }));
    req.write(body);
    req.end();
  });
}

/** @param {string} url @param {string} path @param {number} timeoutMs @param {string | null} bearerToken @returns {Promise<HttpJsonResult>} */
function getJson(url, path, timeoutMs, bearerToken) {
  return new Promise((/** @type {(value: HttpJsonResult) => void} */ resolveRequest) => {
    const parsed = new URL(path, url.endsWith("/") ? url : `${url}/`);
    const requestImpl = parsed.protocol === "https:" ? httpsRequest : httpRequest;
    const req = requestImpl(
      parsed,
      {
        method: "GET",
        headers: {
          ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
          if (Buffer.byteLength(text, "utf8") > 1024 * 1024) req.destroy(new Error("local ASR health response exceeded 1MB"));
        });
        res.on("end", () => {
          let bodyJson = null;
          try {
            bodyJson = text ? JSON.parse(text) : null;
          } catch {
            bodyJson = null;
          }
          resolveRequest({ ok: Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300), statusCode: res.statusCode ?? 0, body: bodyJson, text });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("local ASR health request timed out")));
    req.on("error", (error) => resolveRequest({ ok: false, statusCode: 0, body: null, text: "", error: error.message }));
    req.end();
  });
}

/** @param {string} url @param {number} [timeoutMs] */
function tcpReachable(url, timeoutMs = 1000) {
  return new Promise((/** @type {(value: boolean) => void} */ resolveReachable) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      resolveReachable(false);
      return;
    }
    const socket = netConnect({
      host: parsed.hostname,
      port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
    });
    /** @param {boolean} reachable */
    const finish = (reachable) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveReachable(reachable);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** @param {string | null} serviceUrl @param {RunnerOptions} [options] */
function localAsrServiceCommand(serviceUrl, options = {}) {
  const url = serviceUrl ? new URL(serviceUrl) : new URL("http://127.0.0.1:8765");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const modelDir = options.localAsrModelDir ?? process.env.LOCAL_ASR_MODEL_DIR ?? "models/Qwen3-ASR-1.7B-MLX-4bit";
  return `.venv-qwen3-asr/bin/python meeting-agent-pi-package/tools/local_asr_http_service.py --host ${url.hostname} --port ${port} --model-dir ${modelDir} --preload`;
}

/** @param {string | null} serviceUrl @param {UnknownRecord} [details] @param {RunnerOptions} [options] */
function localAsrServiceNotRunning(serviceUrl, details = {}, options = {}) {
  const statusCommand = "python3 meeting-agent-pi-package/tools/local_asr_service_ctl.py status";
  const startCommand = localAsrServiceCommand(serviceUrl, options);
  return {
    status: "blocked",
    reason: "local_asr_service_not_running",
    userMessage: `本机 ASR 服务未运行，暂时无法转写音频。请在本机启动后重试：${startCommand}；状态检查：${statusCommand}`,
    serviceUrl,
    startCommand,
    statusCommand,
    statusAlias: "status-local-asr",
    ...details,
    rawMediaExternalUpload: false,
  };
}

/** @param {string} serviceUrl @param {RunnerOptions} [options] @returns {Promise<LocalAsrHealth>} */
async function preflightLocalAsrService(serviceUrl, options = {}) {
  const timeoutMs = Number(options.localAsrHealthTimeoutMs ?? process.env.FEISHU_AGENT_LOCAL_ASR_HEALTH_TIMEOUT_MS ?? 5000);
  const bearerToken = process.env.LOCAL_ASR_BEARER_TOKEN?.trim() || null;
  const health = await getJson(serviceUrl, "/health", timeoutMs, bearerToken);
  const healthBody = asRecord(health.body);
  const timedOut = /timed out|timeout/i.test(String(health.error ?? ""));
  const tcpReachableAfterTimeout = !health.ok && timedOut
    ? await tcpReachable(serviceUrl, Math.min(timeoutMs, 1000))
    : false;
  return {
    ...health,
    timeoutMs,
    modelLoaded: Boolean(healthBody.modelLoaded),
    lastStatus: healthBody.lastStatus ?? null,
    serviceBusy: Boolean(healthBody.busy) || tcpReachableAfterTimeout,
    healthStatus: tcpReachableAfterTimeout ? "health_timeout_while_tcp_reachable" : healthBody.status ?? null,
    tcpReachable: tcpReachableAfterTimeout,
  };
}

/** @param {string} outputDir */
function asrSummaryPath(outputDir) {
  return join(outputDir, "summary.json");
}

/** @param {string} outputDir */
function transcriptPath(outputDir) {
  return join(outputDir, "transcripts", "transcript.full.json");
}

/** @param {string} outputDir */
function evidenceIndexPath(outputDir) {
  return join(outputDir, "evidence", "evidence-index.json");
}

/** @param {string} outputDir */
function audioNormalizePath(outputDir) {
  return join(outputDir, "audio-normalize.json");
}

/** @param {string} outputDir */
function cloudAsrParamsPath(outputDir) {
  return join(outputDir, "asr", "cloud-asr-params.json");
}

/** @param {string} outputDir */
function cloudAsrResultPath(outputDir) {
  return join(outputDir, "asr", "cloud-asr-result.json");
}

/** @param {string} outputDir */
function cloudAsrRunPath(outputDir) {
  return join(outputDir, "asr", "cloud-asr-run.json");
}

/** @param {string} outputDir */
function cloudAsrEventsPath(outputDir) {
  return join(outputDir, "asr", "cloud-asr-events.ndjson");
}

/** @param {string} outputDir */
function evidencePackPath(outputDir) {
  return join(outputDir, "evidence-pack.json");
}

/** @param {string} outputDir */
function fileSummaryContextPath(outputDir) {
  return join(outputDir, "file-summary-context.json");
}

/** @param {string} outputDir */
function publicSourceDir(outputDir) {
  return join(outputDir, "public-source");
}

/** @param {string} outputDir */
function publicSourceResolutionPath(outputDir) {
  return join(publicSourceDir(outputDir), "source-resolution.json");
}

/** @param {string} outputDir */
function publicSourceMetadataPath(outputDir) {
  return join(publicSourceDir(outputDir), "source-metadata.json");
}

/** @param {string} outputDir */
function publicSourcePackDir(outputDir) {
  return join(publicSourceDir(outputDir), "source-pack");
}

/** @param {string} outputDir */
function publicSourcePackPath(outputDir) {
  return join(publicSourcePackDir(outputDir), "source-pack.json");
}

/** @param {string} outputDir */
function publicSourcePackReadablePath(outputDir) {
  return join(publicSourcePackDir(outputDir), "source-pack.readable.md");
}

/** @param {string} outputDir */
function publicSourceProvenancePath(outputDir) {
  return join(publicSourceDir(outputDir), "provenance", "evidence-index.json");
}

/** @param {SourceChapter} chapter */
function sourceChapterEvidenceHash(chapter) {
  return createHash("sha256")
    .update(JSON.stringify(chapter.segments.map((segment) => [segment.segmentId, segment.startMs, segment.endMs, segment.text])))
    .digest("hex");
}

/** @param {string} path @param {SourceChapter} chapter */
function reusableSourceChapterAnalysis(path, chapter) {
  if (!existsSync(path)) return null;
  try {
    const existing = loadJson(path);
    const expectedIds = chapter.segmentIds.map(String);
    const actualIds = Array.isArray(existing?.evidenceSegmentIds) ? existing.evidenceSegmentIds.map(String) : [];
    const validIds = new Set(expectedIds);
    const claimsValid = Array.isArray(existing?.claims) && existing.claims.length > 0 && existing.claims.every((claim) =>
      Array.isArray(claim?.evidenceSegmentIds) &&
      claim.evidenceSegmentIds.length > 0 &&
      claim.evidenceSegmentIds.every((/** @type {unknown} */ id) => validIds.has(String(id))),
    );
    const evidenceIdsMatch = actualIds.length === expectedIds.length && actualIds.every((id, index) => id === expectedIds[index]);
    const evidenceHash = sourceChapterEvidenceHash(chapter);
    if (
      existing?.status !== "completed" ||
      existing?.chapterId !== chapter.chapterId ||
      Number(existing?.startMs) !== Number(chapter.startMs) ||
      Number(existing?.endMs) !== Number(chapter.endMs) ||
      !evidenceIdsMatch ||
      !claimsValid ||
      (existing?.evidenceHash && existing.evidenceHash !== evidenceHash)
    ) return null;
    const normalized = normalizeSourceChapterAnalysis({
      chapterTitle: existing.title,
      summary: existing.summary,
      claims: existing.claims,
      suggestedRelatedTopics: existing.suggestedRelatedTopics,
    }, chapter);
    if (normalized.status !== "completed") return null;
    return {
      ...normalized,
      evidenceHash,
      analysisAttempts: Array.isArray(existing.analysisAttempts) ? existing.analysisAttempts : [],
      reusedFromCheckpoint: true,
      checkpointNormalized: true,
    };
  } catch {
    return null;
  }
}

/** @param {string} outputDir */
function reviewContextPath(outputDir) {
  return join(outputDir, "review-context.json");
}

/** @param {string} outputDir */
function meetingIntelligenceDir(outputDir) {
  return join(outputDir, "meeting-intelligence");
}

/** @param {string} outputDir */
function meetingAnalysisPath(outputDir) {
  return join(meetingIntelligenceDir(outputDir), "meeting-analysis.json");
}

/** @param {string} outputDir */
function meetingProfilePath(outputDir) {
  return join(meetingIntelligenceDir(outputDir), "meeting-profile.json");
}

/** @param {string} outputDir */
function participantMapPath(outputDir) {
  return join(meetingIntelligenceDir(outputDir), "participant-map.json");
}

/** @param {string} outputDir */
function topicMapPath(outputDir) {
  return join(meetingIntelligenceDir(outputDir), "topic-map.json");
}

/** @param {string} outputDir */
function internalEvidenceMapPath(outputDir) {
  return join(meetingIntelligenceDir(outputDir), "evidence-map.json");
}

/** @param {string} outputDir */
function agentPlanPath(outputDir) {
  return join(meetingIntelligenceDir(outputDir), "agent-plan.json");
}

/** @param {string} outputDir */
function productDiscoveryPath(outputDir) {
  return join(meetingIntelligenceDir(outputDir), "product-discovery.json");
}

/** @param {string} outputDir */
function nextStepOptionsPath(outputDir) {
  return join(meetingIntelligenceDir(outputDir), "next-step-options.json");
}

/** @param {string} outputDir */
function agenticOrchestrationPath(outputDir) {
  return join(meetingIntelligenceDir(outputDir), "agentic-orchestration.json");
}

/** @param {string} outputDir */
function agenticOrchestrationResultPath(outputDir) {
  return join(meetingIntelligenceDir(outputDir), "agentic-orchestration-result.json");
}

/** @param {string} outputDir */
function agenticOrchestrationEventsPath(outputDir) {
  return join(meetingIntelligenceDir(outputDir), "agentic-orchestration-events.ndjson");
}

/** @param {string} outputDir */
function meetingMemoryDir(outputDir) {
  return join(outputDir, "meeting-memory");
}

/** @param {string} outputDir */
function meetingMemoryPlanPath(outputDir) {
  return join(meetingMemoryDir(outputDir), "curation-plan.json");
}

/** @param {string} outputDir */
function meetingMemoryResultPath(outputDir) {
  return join(meetingMemoryDir(outputDir), "curation-result.json");
}

/** @param {string} outputDir */
function meetingMemoryEventsPath(outputDir) {
  return join(meetingMemoryDir(outputDir), "curation-events.ndjson");
}

/** @param {string} outputDir @returns {UnknownRecord | null} */
function completeAsrSummary(outputDir) {
  if (!existsSync(asrSummaryPath(outputDir)) || !existsSync(transcriptPath(outputDir)) || !existsSync(evidenceIndexPath(outputDir))) return null;
  try {
    const summary = loadJson(asrSummaryPath(outputDir));
    if (summary.status === "complete" && summary.partial === false && Number(summary.failedChunks ?? 0) === 0) return summary;
  } catch {
    return null;
  }
  return null;
}

/** @param {string} sourceDir @param {string} targetDir */
function copyAsrArtifacts(sourceDir, targetDir) {
  for (const name of ["transcripts", "evidence"]) {
    const from = join(sourceDir, name);
    if (existsSync(from)) cpSync(from, join(targetDir, name), { recursive: true, force: true });
  }
  if (existsSync(join(sourceDir, "summary.json"))) cpSync(join(sourceDir, "summary.json"), join(targetDir, "summary.json"), { force: true });
}

/** @param {RunnerPaths} paths @param {string} key */
function asrCacheDir(paths, key) {
  return join(dirname(dirname(paths.runDir)), "asr-cache", safeSegment(key));
}

/** @param {RunnerTask} task @returns {AudioSource[]} */
function sourceAudioPaths(task) {
  return (task.attachments ?? [])
    .map((attachment) => ({
      path: typeof attachment.localPath === "string" && attachment.localPath ? resolve(attachment.localPath) : null,
      ...(typeof attachment.sha256 === "string" ? { sha256: attachment.sha256 } : {}),
      ...(attachment.name !== undefined ? { name: attachment.name } : {}),
      ...(attachment.sizeBytes !== undefined ? { sizeBytes: attachment.sizeBytes } : {}),
      resourceType: String(attachment.resourceType ?? "").toLowerCase(),
      ext: mediaExtension(attachment.name) || mediaExtension(attachment.localPath) || "",
    }))
    .filter((item) => typeof item.path === "string" && existsSync(item.path) && (isCloudAsrMedia(item.ext) || ["audio", "video"].includes(item.resourceType)))
    .map((item) => /** @type {AudioSource} */ ({ ...item, path: String(item.path) }));
}

/** @param {AudioSource[]} audios @param {UnknownRecord} [providerConfig] */
function audioCacheKey(audios, providerConfig = {}) {
  return hashText(JSON.stringify({
    normalizerVersion: AUDIO_NORMALIZE_VERSION,
    targetSpec: TARGET_AUDIO_SPEC,
    asrProvider: providerConfig.provider ?? "local_qwen3",
    asrModel: providerConfig.model ?? null,
    asrFileModel: providerConfig.fileModel ?? null,
    asrInputMode: providerConfig.inputMode ?? null,
    singleMixMode: providerConfig.singleMixMode ?? null,
    singleMixReviewModel: providerConfig.singleMixReviewModel ?? null,
    speakerDiarization: providerConfig.diarizationEnabled ?? null,
    speakerCount: providerConfig.speakerCount ?? null,
    languageHints: providerConfig.languageHints ?? null,
    vocabularyId: providerConfig.vocabularyId ?? null,
    sources: audios.map((item) => ({
      sha256: item.sha256 ?? null,
      ext: item.ext,
      sizeBytes: item.sizeBytes ?? (item.path ? statSync(item.path).size : null),
      pathHash: item.sha256 ? null : hashText(item.path),
    })),
  }));
}

/** @param {RunnerPaths} paths @param {unknown} artifact */
function writeAudioNormalizeArtifact(paths, artifact) {
  return writeJson(audioNormalizePath(paths.artifactsDir), artifact);
}

/** @param {unknown} value */
function normalizeAsrProvider(value) {
  const provider = String(value ?? "").trim().toLowerCase();
  if (!provider || provider === "auto") return "auto";
  if (["local", "local-qwen3", "local_qwen3", "qwen3", "qwen3_asr"].includes(provider)) return "local_qwen3";
  if (["cloud", "aliyun", "dashscope", "paraformer", "aliyun_dashscope_paraformer"].includes(provider)) return "aliyun_dashscope_paraformer";
  return provider;
}

function cloudAsrApiKeyConfigured() {
  return Boolean(process.env.ALIYUN_DASHSCOPE_API_KEY?.trim() || process.env.DASHSCOPE_API_KEY?.trim());
}

/** @param {unknown} value @returns {string[]} */
function parseLanguageHints(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value ?? process.env.ALIYUN_ASR_LANGUAGE_HINTS ?? DEFAULT_CLOUD_ASR_LANGUAGE_HINTS.join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** @param {RunnerOptions} [options] @returns {AsrProviderConfig} */
function resolveAsrProvider(options = {}) {
  const requested = normalizeAsrProvider(options.asrProvider ?? process.env.MEETING_ASR_PROVIDER ?? "auto");
  const provider = requested === "auto"
    ? cloudAsrApiKeyConfigured() ? "aliyun_dashscope_paraformer" : "local_qwen3"
    : requested;
  const fallback = normalizeAsrProvider(options.asrFallbackProvider ?? process.env.MEETING_ASR_FALLBACK_PROVIDER ?? "local_qwen3");
  const model = String(options.aliyunAsrModel ?? process.env.ALIYUN_ASR_MODEL ?? DEFAULT_CLOUD_ASR_MODEL);
  const fileModel = String(options.aliyunAsrFileModel ?? process.env.ALIYUN_ASR_FILE_MODEL ?? DEFAULT_CLOUD_ASR_FILE_MODEL);
  const languageHints = parseLanguageHints(options.aliyunAsrLanguageHints);
  const vocabularyId = String(options.aliyunAsrVocabularyId ?? process.env.ALIYUN_ASR_VOCABULARY_ID ?? "");
  return {
    requested,
    provider,
    fallbackProvider: fallback === "auto" ? "local_qwen3" : fallback,
    model,
    fileModel,
    singleMixMode: String(options.aliyunAsrSingleMixMode ?? process.env.ALIYUN_ASR_SINGLE_MIX_MODE ?? "robust"),
    singleMixReviewModel: String(options.aliyunAsrSingleMixReviewModel ?? process.env.ALIYUN_ASR_SINGLE_MIX_REVIEW_MODEL ?? DEFAULT_CLOUD_ASR_SINGLE_MIX_REVIEW_MODEL),
    inputMode: String(options.aliyunAsrInputMode ?? process.env.ALIYUN_ASR_INPUT_MODE ?? "auto"),
    diarizationEnabled: options.aliyunAsrDiarizationEnabled ?? process.env.ALIYUN_ASR_DIARIZATION_ENABLED ?? "auto",
    speakerCount: options.aliyunAsrSpeakerCount ?? process.env.ALIYUN_ASR_SPEAKER_COUNT ?? "",
    timestampAlignmentEnabled: options.aliyunAsrTimestampAlignmentEnabled ?? process.env.ALIYUN_ASR_TIMESTAMP_ALIGNMENT_ENABLED ?? "true",
    languageHints,
    vocabularyId,
    endpoint: String(options.aliyunAsrEndpoint ?? process.env.ALIYUN_ASR_ENDPOINT ?? "wss://dashscope.aliyuncs.com/api-ws/v1/inference"),
    fileEndpoint: String(options.aliyunAsrFileEndpoint ?? process.env.ALIYUN_ASR_FILE_ENDPOINT ?? "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription"),
    workspaceId: String(options.aliyunDashscopeWorkspaceId ?? process.env.ALIYUN_DASHSCOPE_WORKSPACE_ID ?? ""),
  };
}

/** @param {unknown} asrValue */
function userMessageForAsrFailure(asrValue) {
  const asr = asRecord(asrValue);
  const reason = String(asr.reason ?? asr.failureClass ?? "asr_all_providers_failed");
  /** @type {Record<string, string>} */
  const messages = {
    cloud_asr_api_key_missing: "云端 ASR 未配置百炼 API Key，暂时无法转写音频。",
    cloud_asr_auth_failed: "云端 ASR 鉴权失败，请检查百炼 API Key 或模型权限。",
    cloud_asr_network_unreachable: "云端 ASR 网络连接失败，请稍后重试或切换本机 ASR。",
    cloud_asr_provider_timeout: "云端 ASR 转写超时，请稍后重试或切换本机 ASR。",
    cloud_asr_model_unavailable: "云端 ASR 模型不可用，请检查百炼模型配置。",
    cloud_asr_audio_format_rejected: "云端 ASR 拒绝当前音频格式，自动转码后仍未完成转写。",
    cloud_asr_media_format_not_supported: "当前文件不在云端 ASR 支持的音视频格式范围内。",
    cloud_asr_file_transport_unavailable: "云端文件转录需要可访问的 OSS 文件地址；当前 OSS 传输未配置，自动转码后仍未完成转写。",
    cloud_asr_file_upload_failed: "音视频上传到 OSS 失败，暂时无法启动云端文件转录。",
    cloud_asr_file_size_exceeded: "音视频文件超过云端文件转录的 2 GB 上限。",
    cloud_asr_file_task_failed: "云端录音文件转录任务失败，请稍后重试。",
    cloud_asr_diarization_preparation_failed: "云端说话人分离要求单声道，但当前文件无法完成单声道准备。",
    cloud_asr_speaker_count_invalid: "说话人数提示必须是 2 到 100 之间的整数。",
    cloud_asr_audio_stream_missing: "当前文件中没有可供云端 ASR 转写的音轨。",
    cloud_asr_partial_result: "云端 ASR 只返回了部分转写结果，暂时无法生成可靠会议纪要。",
    local_asr_service_not_running: typeof asr.userMessage === "string" ? asr.userMessage : "本机 ASR 服务未运行，暂时无法转写音频。",
    local_asr_service_unavailable: "本机 ASR 服务不可用，暂时无法转写音频。",
    local_asr_output_incomplete: "本机 ASR 输出不完整，暂时无法生成会议纪要。",
    asr_all_providers_failed: "本地和云端 ASR 均未完成转写，暂时无法生成会议纪要。",
  };
  return messages[reason] ?? `ASR 转写失败：${reason}`;
}

/** @param {RunnerTask} task @param {RunnerPaths} paths @param {RunnerOptions} options @param {RunnerHooks} hooks */
async function ensureLocalAsr(task, paths, options, hooks) {
  const audios = sourceAudioPaths(task);
  if (audios.length === 0) return { status: "skipped", reason: "no_audio_sources", rawMediaExternalUpload: false };
  await hooks.onStep?.("audio_downloaded", "completed", {
    audioCount: audios.length,
    extensions: [...new Set(audios.map((item) => item.ext).filter(Boolean))],
    rawMediaExternalUpload: false,
  });
  const key = audioCacheKey(audios, {
    provider: "local_qwen3",
    model: "mlx-community/Qwen3-ASR-1.7B-4bit",
    languageHints: ["Chinese"],
  });
  const existing = completeAsrSummary(paths.artifactsDir);
  if (existing) {
    writeAudioNormalizeArtifact(paths, {
      schemaVersion: AUDIO_NORMALIZE_VERSION,
      version: AUDIO_NORMALIZE_VERSION,
      status: "completed",
      reason: "current_run_artifact",
      cacheKey: key,
      targetSpec: TARGET_AUDIO_SPEC,
      normalizedAudios: [],
      rawSecretsReturned: false,
      rawMediaExternalUpload: false,
    });
    await hooks.onStep?.("audio_normalized", "completed", { artifact: audioNormalizePath(paths.artifactsDir), cacheStatus: "current_run_artifact", cacheKey: key });
    await hooks.onStep?.("local_asr_started", "skipped", { cacheStatus: "current_run_artifact", rawMediaExternalUpload: false });
    await hooks.onStep?.("local_asr_completed", "completed", { artifact: asrSummaryPath(paths.artifactsDir), cacheStatus: "current_run_artifact" });
    return { status: "completed", summary: existing, cacheStatus: "current_run_artifact" };
  }

  const cacheDir = asrCacheDir(paths, key);
  const cached = completeAsrSummary(cacheDir);
  if (cached) {
    mkdirSync(paths.artifactsDir, { recursive: true });
    copyAsrArtifacts(cacheDir, paths.artifactsDir);
    writeAudioNormalizeArtifact(paths, {
      schemaVersion: AUDIO_NORMALIZE_VERSION,
      version: AUDIO_NORMALIZE_VERSION,
      status: "completed",
      reason: "asr_cache_hit",
      cacheKey: key,
      targetSpec: TARGET_AUDIO_SPEC,
      normalizedAudios: [],
      rawSecretsReturned: false,
      rawMediaExternalUpload: false,
    });
    await hooks.onStep?.("audio_normalized", "completed", { artifact: audioNormalizePath(paths.artifactsDir), cacheStatus: "asr_cache_hit", cacheKey: key });
    await hooks.onStep?.("local_asr_started", "skipped", { cacheStatus: "asr_cache_hit", rawMediaExternalUpload: false });
    await hooks.onStep?.("local_asr_completed", "completed", { artifact: asrSummaryPath(paths.artifactsDir), cacheStatus: "asr_cache_hit", cacheKey: key });
    await hooks.progressReply?.("录音已转写完成，正在生成文档。", "local_asr_completed");
    return { status: "completed", summary: cached, cacheStatus: "asr_cache_hit", cacheKey: key };
  }

  let serviceUrl;
  try {
    serviceUrl = normalizeAsrServiceUrl(options.localAsrServiceUrl);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const blocked = localAsrServiceNotRunning(null, {
      healthStatus: "invalid_service_url",
      error: errorMessage,
    }, options);
    await hooks.onStep?.("local_asr_preflight", "blocked", {
      reason: blocked.reason,
      healthStatus: "invalid_service_url",
      error: errorMessage,
      rawMediaExternalUpload: false,
    });
    return blocked;
  }
  const health = await preflightLocalAsrService(serviceUrl, options);
  const healthBody = asRecord(health.body);
  if ((!health.ok || healthBody.status !== "ok") && !health.tcpReachable) {
    const blocked = localAsrServiceNotRunning(serviceUrl, {
      healthStatus: "down",
      httpStatus: health.statusCode,
      healthError: health.error ?? null,
      healthTimeoutMs: health.timeoutMs,
    }, options);
    await hooks.onStep?.("local_asr_preflight", "blocked", {
      reason: blocked.reason,
      serviceUrl,
      httpStatus: health.statusCode,
      healthError: health.error ?? null,
      rawMediaExternalUpload: false,
    });
    return blocked;
  }
  await hooks.onStep?.("local_asr_preflight", "completed", {
    serviceUrl,
    modelLoaded: health.modelLoaded,
    healthStatus: health.healthStatus ?? healthBody.status ?? null,
    serviceBusy: health.serviceBusy,
    healthError: health.error ?? null,
    tcpReachable: health.tcpReachable,
    lastStatus: health.lastStatus,
    rawMediaExternalUpload: false,
  });

  const normalized = await normalizeAudioBatch(audios, join(paths.artifactsDir, "audio-normalized"), {
    workspaceDir,
    timeoutMs: Number(options.audioNormalizeTimeoutMs ?? process.env.FEISHU_AGENT_AUDIO_NORMALIZE_TIMEOUT_MS ?? 1_200_000),
    ...(typeof (options.audioTranscoder ?? process.env.FEISHU_AGENT_AUDIO_TRANSCODER) === "string"
      ? { transcoder: String(options.audioTranscoder ?? process.env.FEISHU_AGENT_AUDIO_TRANSCODER) }
      : {}),
  });
  writeAudioNormalizeArtifact(paths, normalized);
  if (normalized.status !== "completed") {
    const userMessage = "userMessage" in normalized ? normalized.userMessage : null;
    const reason = "reason" in normalized ? normalized.reason : null;
    await hooks.progressReply?.(userMessage ?? "目前音频格式暂不支持自动转码。", "audio_normalized");
    await hooks.onStep?.("audio_normalized", "blocked", {
      artifact: audioNormalizePath(paths.artifactsDir),
      reason: reason ?? "audio_normalize_failed",
      rawMediaExternalUpload: false,
    });
    return { ...normalized, rawMediaExternalUpload: false };
  }
  const normalizedPaths = normalized.normalizedAudios.map((item) => item.normalizedPath);
  await hooks.onStep?.("audio_normalized", "completed", {
    artifact: audioNormalizePath(paths.artifactsDir),
    audioCount: normalizedPaths.length,
    targetSpec: TARGET_AUDIO_SPEC,
    transcoder: "transcoder" in normalized ? normalized.transcoder?.tool ?? null : null,
    rawMediaExternalUpload: false,
  });

  await hooks.progressReply?.("已收到音频，正在转写。", "local_asr_started");
  await hooks.onStep?.("local_asr_started", "running", { audioCount: normalizedPaths.length, rawMediaExternalUpload: false });
  const modelDir = resolve(options.localAsrModelDir ?? process.env.LOCAL_ASR_MODEL_DIR ?? join(workspaceDir, "models/Qwen3-ASR-1.7B-MLX-4bit"));
  const service = await postJson(
    serviceUrl,
    {
      paths: normalizedPaths,
      meetingId: task.runId,
      meetingTitle: `会议录音 ${new Date().toISOString().slice(0, 10)}`,
      outputDir: paths.artifactsDir,
      modelDir,
      chunkSeconds: Number(options.localAsrChunkSeconds ?? process.env.FEISHU_AGENT_ASR_CHUNK_SECONDS ?? 30),
      language: "Chinese",
      context: "会议录音，中文为主，可能夹杂英文术语、人名、产品名。",
      maxNewTokens: Number(options.localAsrMaxNewTokens ?? process.env.FEISHU_AGENT_ASR_MAX_NEW_TOKENS ?? 512),
      source: "feishu",
      privacy: "internal",
    },
    Number(options.localAsrTimeoutMs ?? process.env.FEISHU_AGENT_LOCAL_ASR_TIMEOUT_MS ?? 7_200_000),
    process.env.LOCAL_ASR_BEARER_TOKEN?.trim() || null,
  );
  if (!service.ok) {
    await hooks.onStep?.("local_asr_completed", "blocked", { reason: "local_asr_service_unavailable", httpStatus: service.statusCode, rawMediaExternalUpload: false });
    return { status: "blocked", reason: "local_asr_service_unavailable", httpStatus: service.statusCode, response: service.body, rawMediaExternalUpload: false };
  }
  const summary = completeAsrSummary(paths.artifactsDir);
  if (!summary) return { status: "blocked", reason: "local_asr_output_incomplete", response: service.body, rawMediaExternalUpload: false };
  mkdirSync(cacheDir, { recursive: true });
  copyAsrArtifacts(paths.artifactsDir, cacheDir);
  await hooks.onStep?.("local_asr_completed", "completed", { artifact: asrSummaryPath(paths.artifactsDir), cacheStatus: "asr_cache_miss_completed", cacheKey: key });
  await hooks.progressReply?.("录音已转写完成，正在生成文档。", "local_asr_completed");
  return { status: "completed", summary, cacheStatus: "asr_cache_miss_completed", cacheKey: key };
}

/** @param {UnknownRecord} params @param {RunnerPaths} paths @param {RunnerOptions} options */
async function runDashScopeAsrClient(params, paths, options) {
  writeJson(cloudAsrParamsPath(paths.artifactsDir), params);
  const result = await runCommand(
    process.execPath,
    [dashscopeAsrClient, "--params-file", cloudAsrParamsPath(paths.artifactsDir), "--out", cloudAsrResultPath(paths.artifactsDir)],
    {
      cwd: workspaceDir,
      timeoutMs: Number(options.cloudAsrTimeoutMs ?? process.env.ALIYUN_ASR_TIMEOUT_MS ?? DEFAULT_CLOUD_ASR_TIMEOUT_MS) + 30_000,
    },
  );
  if (existsSync(cloudAsrResultPath(paths.artifactsDir))) {
    try {
      return loadJson(cloudAsrResultPath(paths.artifactsDir));
    } catch {
      // Fall through to stdout/stderr parsing.
    }
  }
  try {
    return result.stdout ? JSON.parse(result.stdout) : null;
  } catch {
    return {
      status: "blocked",
      reason: result.timedOut ? "cloud_asr_provider_timeout" : "cloud_asr_client_failed",
      provider: "aliyun_dashscope_paraformer",
      exitCode: result.exitCode,
      stderrTail: redactString(result.stderr).slice(-2000),
      rawMediaExternalUpload: true,
      rawSecretsReturned: false,
    };
  }
}

/** @param {RunnerTask} task @param {RunnerPaths} paths @param {RunnerOptions} options @param {RunnerHooks} hooks @param {AudioSource[]} audios @param {AsrProviderConfig} providerConfig @param {string[]} inputPaths @param {string} uploadMode */
async function ensureCloudAsrWithPaths(task, paths, options, hooks, audios, providerConfig, inputPaths, uploadMode) {
  const policy = await callRuntimeTool("policy_gate_check", {
    actionIntent: "audio_transcription",
    capabilityId: "cloud-asr",
    provider: "aliyun_dashscope_paraformer",
    asrStage: true,
    audience: "asr_provider",
    payloadClass: "audio_transcription",
    riskLevel: "medium",
    rawMediaExternalUpload: true,
    rawTranscriptIncluded: false,
    explicitUserRequest: true,
    userRequestedAction: true,
    destructiveAction: false,
  }, paths, options);
  if (policy.status === "blocked") {
    return {
      status: "blocked",
      reason: "raw_media_external_upload_not_allowed",
      policy,
      rawMediaExternalUpload: true,
    };
  }

  await hooks.progressReply?.("已收到音频，正在使用云端 ASR 转写。", "cloud_asr_started");
  await hooks.onStep?.("cloud_asr_started", "running", {
    provider: providerConfig.provider,
    model: providerConfig.model,
    fileModel: providerConfig.fileModel,
    singleMixMode: providerConfig.singleMixMode,
    singleMixReviewModel: providerConfig.singleMixReviewModel,
    inputMode: providerConfig.inputMode,
    diarizationEnabled: providerConfig.diarizationEnabled,
    speakerCount: providerConfig.speakerCount || null,
    audioCount: inputPaths.length,
    uploadMode,
    rawMediaExternalUpload: true,
  });
  const result = await runDashScopeAsrClient({
    paths: inputPaths,
    meetingId: task.runId,
    meetingTitle: `会议录音 ${new Date().toISOString().slice(0, 10)}`,
    outputDir: paths.artifactsDir,
    model: providerConfig.model,
    fileModel: providerConfig.fileModel,
    singleMixMode: providerConfig.singleMixMode,
    singleMixReviewModel: providerConfig.singleMixReviewModel,
    inputMode: providerConfig.inputMode,
    fileEndpoint: providerConfig.fileEndpoint,
    diarizationEnabled: providerConfig.diarizationEnabled,
    speakerCount: providerConfig.speakerCount || undefined,
    timestampAlignmentEnabled: providerConfig.timestampAlignmentEnabled,
    endpoint: providerConfig.endpoint,
    languageHints: providerConfig.languageHints,
    vocabularyId: providerConfig.vocabularyId,
    workspaceId: providerConfig.workspaceId,
    sampleRate: Number(options.aliyunAsrSampleRate ?? process.env.ALIYUN_ASR_SAMPLE_RATE ?? 16000),
    source: "feishu",
    privacy: "internal",
    timeoutMs: Number(options.cloudAsrTimeoutMs ?? process.env.ALIYUN_ASR_TIMEOUT_MS ?? DEFAULT_CLOUD_ASR_TIMEOUT_MS),
    audioNormalizeTimeoutMs: Number(options.audioNormalizeTimeoutMs ?? process.env.FEISHU_AGENT_AUDIO_NORMALIZE_TIMEOUT_MS ?? 1_200_000),
    audioTranscoder: options.audioTranscoder ?? process.env.FEISHU_AGENT_AUDIO_TRANSCODER,
    mockFileProvider: options.cloudAsrMockFileProvider === true,
    mockFileSentences: options.cloudAsrMockFileSentences,
  }, paths, options);
  if (result?.status !== "completed") {
    const reason = result?.reason ?? result?.failureClass ?? "cloud_asr_provider_error";
    await hooks.onStep?.("cloud_asr_completed", "blocked", {
      reason,
      failureClass: result?.failureClass ?? reason,
      artifact: workspaceRelative(cloudAsrRunPath(paths.artifactsDir)),
      events: workspaceRelative(cloudAsrEventsPath(paths.artifactsDir)),
      rawMediaExternalUpload: true,
    });
    return {
      status: "blocked",
      reason,
      failureClass: result?.failureClass ?? reason,
      response: result,
      rawMediaExternalUpload: true,
    };
  }
  const summary = completeAsrSummary(paths.artifactsDir);
  if (!summary) {
    return {
      status: "blocked",
      reason: "cloud_asr_output_incomplete",
      response: result,
      rawMediaExternalUpload: true,
    };
  }
  await hooks.onStep?.("cloud_asr_completed", "completed", {
    artifact: asrSummaryPath(paths.artifactsDir),
    runArtifact: workspaceRelative(cloudAsrRunPath(paths.artifactsDir)),
    events: workspaceRelative(cloudAsrEventsPath(paths.artifactsDir)),
    uploadMode,
    rawMediaExternalUpload: true,
  });
  await hooks.progressReply?.("录音已转写完成，正在生成文档。", "cloud_asr_completed");
  return { status: "completed", summary, cacheStatus: "asr_cache_miss_completed", rawMediaExternalUpload: true };
}

/** @param {RunnerTask} task @param {RunnerPaths} paths @param {RunnerOptions} options @param {RunnerHooks} hooks @param {AudioSource[]} audios @param {AsrProviderConfig} providerConfig */
async function ensureCloudAsr(task, paths, options, hooks, audios, providerConfig) {
  const key = audioCacheKey(audios, {
    provider: providerConfig.provider,
    model: providerConfig.model,
    fileModel: providerConfig.fileModel,
    singleMixMode: providerConfig.singleMixMode,
    singleMixReviewModel: providerConfig.singleMixReviewModel,
    inputMode: providerConfig.inputMode,
    diarizationEnabled: providerConfig.diarizationEnabled,
    speakerCount: providerConfig.speakerCount || null,
    languageHints: providerConfig.languageHints,
    vocabularyId: providerConfig.vocabularyId || null,
  });
  const existing = completeAsrSummary(paths.artifactsDir);
  if (existing) {
    writeAudioNormalizeArtifact(paths, {
      schemaVersion: AUDIO_NORMALIZE_VERSION,
      version: AUDIO_NORMALIZE_VERSION,
      status: "completed",
      reason: "current_run_artifact",
      cacheKey: key,
      targetSpec: "cloud_asr_provider_native",
      normalizedAudios: [],
      rawSecretsReturned: false,
      rawMediaExternalUpload: true,
      provider: providerConfig.provider,
    });
    await hooks.onStep?.("cloud_asr_started", "skipped", { cacheStatus: "current_run_artifact", rawMediaExternalUpload: true });
    await hooks.onStep?.("cloud_asr_completed", "completed", { artifact: asrSummaryPath(paths.artifactsDir), cacheStatus: "current_run_artifact", rawMediaExternalUpload: true });
    return { status: "completed", summary: existing, cacheStatus: "current_run_artifact", cacheKey: key, rawMediaExternalUpload: true };
  }

  const cacheDir = asrCacheDir(paths, key);
  const cached = completeAsrSummary(cacheDir);
  if (cached) {
    mkdirSync(paths.artifactsDir, { recursive: true });
    copyAsrArtifacts(cacheDir, paths.artifactsDir);
    writeAudioNormalizeArtifact(paths, {
      schemaVersion: AUDIO_NORMALIZE_VERSION,
      version: AUDIO_NORMALIZE_VERSION,
      status: "completed",
      reason: "asr_cache_hit",
      cacheKey: key,
      targetSpec: "cloud_asr_provider_native",
      normalizedAudios: [],
      rawSecretsReturned: false,
      rawMediaExternalUpload: true,
      provider: providerConfig.provider,
    });
    await hooks.onStep?.("cloud_asr_started", "skipped", { cacheStatus: "asr_cache_hit", rawMediaExternalUpload: true });
    await hooks.onStep?.("cloud_asr_completed", "completed", { artifact: asrSummaryPath(paths.artifactsDir), cacheStatus: "asr_cache_hit", cacheKey: key, rawMediaExternalUpload: true });
    await hooks.progressReply?.("录音已转写完成，正在生成文档。", "cloud_asr_completed");
    return { status: "completed", summary: cached, cacheStatus: "asr_cache_hit", cacheKey: key, rawMediaExternalUpload: true };
  }

  writeAudioNormalizeArtifact(paths, {
    schemaVersion: AUDIO_NORMALIZE_VERSION,
    version: AUDIO_NORMALIZE_VERSION,
    status: "completed",
    reason: "cloud_asr_raw_input",
    cacheKey: key,
    targetSpec: "cloud_asr_provider_native",
    normalizedAudios: [],
    rawSecretsReturned: false,
    rawMediaExternalUpload: true,
    provider: providerConfig.provider,
  });
  await hooks.onStep?.("audio_normalized", "skipped", {
    artifact: audioNormalizePath(paths.artifactsDir),
    reason: "cloud_asr_raw_input",
    rawMediaExternalUpload: true,
  });
  const direct = await ensureCloudAsrWithPaths(task, paths, options, hooks, audios, providerConfig, audios.map((item) => item.path), "raw_attachment");
  if (direct.status === "completed") {
    mkdirSync(cacheDir, { recursive: true });
    copyAsrArtifacts(paths.artifactsDir, cacheDir);
    return { ...direct, cacheKey: key };
  }
  if (!["cloud_asr_audio_format_rejected", "cloud_asr_realtime_format_not_supported", "cloud_asr_file_transport_unavailable"].includes(direct.reason)) return direct;

  const normalized = await normalizeAudioBatch(audios, join(paths.artifactsDir, "audio-normalized"), {
    workspaceDir,
    timeoutMs: Number(options.audioNormalizeTimeoutMs ?? process.env.FEISHU_AGENT_AUDIO_NORMALIZE_TIMEOUT_MS ?? 1_200_000),
    ...(typeof (options.audioTranscoder ?? process.env.FEISHU_AGENT_AUDIO_TRANSCODER) === "string"
      ? { transcoder: String(options.audioTranscoder ?? process.env.FEISHU_AGENT_AUDIO_TRANSCODER) }
      : {}),
  });
  writeAudioNormalizeArtifact(paths, {
    ...normalized,
    provider: providerConfig.provider,
    rawMediaExternalUpload: true,
    reason: normalized.status === "completed"
      ? "cloud_asr_format_retry_normalized"
      : "reason" in normalized
        ? normalized.reason
        : "audio_normalize_failed",
  });
  if (normalized.status !== "completed") {
    const reason = "reason" in normalized ? normalized.reason : null;
    await hooks.onStep?.("audio_normalized", "blocked", {
      artifact: audioNormalizePath(paths.artifactsDir),
      reason: reason ?? "audio_normalize_failed",
      rawMediaExternalUpload: true,
    });
    return { ...normalized, rawMediaExternalUpload: true };
  }
  const normalizedPaths = normalized.normalizedAudios.map((item) => String(item.normalizedPath ?? "")).filter(Boolean);
  await hooks.onStep?.("audio_normalized", "completed", {
    artifact: audioNormalizePath(paths.artifactsDir),
    audioCount: normalizedPaths.length,
    targetSpec: TARGET_AUDIO_SPEC,
    reason: "cloud_asr_format_retry_normalized",
    rawMediaExternalUpload: true,
  });
  const retry = await ensureCloudAsrWithPaths(task, paths, options, hooks, audios, providerConfig, normalizedPaths, "normalized_retry");
  if (retry.status === "completed") {
    mkdirSync(cacheDir, { recursive: true });
    copyAsrArtifacts(paths.artifactsDir, cacheDir);
    return { ...retry, cacheKey: key };
  }
  return retry;
}

/** @param {RunnerTask} task @param {RunnerPaths} paths @param {RunnerOptions} options @param {RunnerHooks} hooks */
async function ensureAsrTranscription(task, paths, options, hooks) {
  const audios = sourceAudioPaths(task);
  if (audios.length === 0) return { status: "skipped", reason: "no_audio_sources", rawMediaExternalUpload: false };
  const providerConfig = resolveAsrProvider(options);
  await hooks.onStep?.("asr_provider_resolved", "completed", {
    requestedProvider: providerConfig.requested,
    provider: providerConfig.provider,
    fallbackProvider: providerConfig.fallbackProvider,
    model: providerConfig.provider === "aliyun_dashscope_paraformer" ? providerConfig.model : null,
    fileModel: providerConfig.provider === "aliyun_dashscope_paraformer" ? providerConfig.fileModel : null,
    inputMode: providerConfig.provider === "aliyun_dashscope_paraformer" ? providerConfig.inputMode : null,
    speakerDiarization: providerConfig.provider === "aliyun_dashscope_paraformer" ? providerConfig.diarizationEnabled : null,
    speakerCountHint: providerConfig.provider === "aliyun_dashscope_paraformer" ? providerConfig.speakerCount || null : null,
    languageHints: providerConfig.provider === "aliyun_dashscope_paraformer" ? providerConfig.languageHints : null,
    apiKeyConfigured: providerConfig.provider === "aliyun_dashscope_paraformer" ? cloudAsrApiKeyConfigured() : null,
    rawMediaExternalUpload: providerConfig.provider === "aliyun_dashscope_paraformer",
  });

  if (providerConfig.provider === "local_qwen3") return ensureLocalAsr(task, paths, options, hooks);
  if (providerConfig.provider !== "aliyun_dashscope_paraformer") {
    return {
      status: "blocked",
      reason: "asr_provider_unsupported",
      provider: providerConfig.provider,
      rawMediaExternalUpload: false,
    };
  }

  await hooks.onStep?.("audio_downloaded", "completed", {
    audioCount: audios.length,
    extensions: [...new Set(audios.map((item) => item.ext).filter(Boolean))],
    rawMediaExternalUpload: true,
  });
  const cloud = await ensureCloudAsr(task, paths, options, hooks, audios, providerConfig);
  if (cloud.status === "completed") return cloud;

  const cloudReason = "reason" in cloud ? cloud.reason : null;
  const fallbackAllowed = providerConfig.fallbackProvider === "local_qwen3" && !["cloud_asr_api_key_missing", "cloud_asr_auth_failed"].includes(String(cloudReason ?? ""));
  if (!fallbackAllowed) return cloud;

  await hooks.onStep?.("asr_provider_fallback_used", "running", {
    from: providerConfig.provider,
    to: "local_qwen3",
    primaryReason: cloudReason,
    rawMediaExternalUpload: false,
  });
  const local = await ensureLocalAsr(task, paths, options, hooks);
  if (local.status === "completed") return { ...local, fallbackFrom: providerConfig.provider };
  return {
    status: "blocked",
    reason: "asr_all_providers_failed",
    primaryFailure: cloud,
    fallbackFailure: local,
    rawMediaExternalUpload: true,
  };
}

/** @param {string} path @param {number} [maxChars] */
function readTextIfAvailable(path, maxChars = 30000) {
  if (!path || !existsSync(path)) return "";
  return readFileSync(path, "utf8").slice(0, maxChars);
}

/** @param {unknown} path @param {number} [maxChars] */
function readWorkspaceTextIfAvailable(path, maxChars = 30000) {
  const pathText = typeof path === "string" ? path : "";
  if (!pathText) return "";
  const candidates = [
    pathText,
    isAbsolute(pathText) ? pathText : resolve(workspaceDir, pathText),
    isAbsolute(pathText) ? pathText : resolve(process.cwd(), pathText),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return readTextIfAvailable(candidate, maxChars);
  }
  return "";
}

const DOC_TITLE_PREFIX = {
  "meeting-minutes": "会议纪要",
  prd: "PRD",
  "tech-architecture": "技术架构",
  "ops-plan": "运营方案",
  "customer-requirement-checklist": "客户需求确认表",
};

const DOC_TITLE_FOCUS = {
  "meeting-minutes": "会议讨论",
  prd: "产品化方案",
  "tech-architecture": "技术实现方案",
  "ops-plan": "运营落地方案",
  "customer-requirement-checklist": "需求澄清",
};

/** @param {unknown} docType */
function documentTitleForFallback(docType) {
  const normalizedDocType = String(docType ?? "");
  /** @type {Record<string, string>} */
  const prefixes = DOC_TITLE_PREFIX;
  /** @type {Record<string, string>} */
  const focuses = DOC_TITLE_FOCUS;
  const prefix = prefixes[normalizedDocType] ?? cleanTitlePart(normalizedDocType, "文档");
  const focus = focuses[normalizedDocType] ?? "文档输出";
  return normalizedDocType === "meeting-minutes"
    ? `${prefix}｜待确认项目｜${focus}｜待确认`
    : `${prefix}｜待确认项目｜${focus}`;
}

/** @param {unknown} value @param {string} [fallback] */
function cleanTitlePart(value, fallback = "待确认") {
  const cleaned = String(value ?? "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\.(md|markdown|txt|csv|pdf|docx?|xlsx?|xls|wav|mp3|m4a|aac|flac|ogg)$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/[\/\\:*?"<>|#`~]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^.*进行/, "")
    .replace(/^(进行|生成|撰写|输出|形成|整理|分析|总结|基于|结合|关于)/, "")
    .replace(/^(这个|该)?(文档|文件|材料|内容)(和|与)?(我)?(整理|梳理)?(的)?/, "")
    .replace(/(的)?(PRD|技术架构文档?|客户\s*Checklist|客户需求确认表|会议纪要|运营方案|文档撰写)$/i, "")
    .trim();
  if (!cleaned || cleaned.length < 2) return fallback;
  return cleaned.slice(0, 36);
}

/** @param {unknown} fileName */
function stripExtensionForTitle(fileName) {
  return cleanTitlePart(String(fileName ?? "").split(/[\\/]/).pop() ?? "", "");
}

/** @param {unknown} value */
function looksLikeGenericUploadName(value) {
  const text = String(value ?? "").toLowerCase();
  const hasLongAlphaNumericToken = /[a-z0-9]{14,}/i.test(text) && /[a-z]/i.test(text) && /\d/.test(text);
  return !text ||
    /^record[-_\s]?\d/.test(text) ||
    /^audio[-_\s]?\d/.test(text) ||
    /^file[-_\s]?\d/.test(text) ||
    /^source[-_\s]?\d/.test(text) ||
    /feishu[-_\s]?file[-_\s]?\d/.test(text) ||
    (/^(file|doc|docx|markdown|md|feishu)[-_\s.]?/i.test(text) && hasLongAlphaNumericToken) ||
    hasLongAlphaNumericToken;
}

/** @param {unknown} text */
function extractFirstMarkdownH1(text) {
  return String(text ?? "").match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() ?? "";
}

/** @param {unknown} title */
function projectTitleFromDocumentTitle(title) {
  const raw = String(title ?? "").trim();
  if (!raw || looksLikeGenericUploadName(raw)) return "";
  const parts = raw.split(/[｜|]/).map((part) => cleanTitlePart(part, "")).filter(Boolean);
  const firstPart = parts[0] ?? "";
  const secondPart = parts[1] ?? "";
  if (parts.length >= 2 && /^(PRD|技术架构|运营方案|客户需求确认表|会议纪要)$/i.test(firstPart)) {
    return looksLikeGenericUploadName(secondPart) ? "" : secondPart;
  }
  const withoutDocType = raw
    .replace(/^(PRD|技术架构|运营方案|客户需求确认表|会议纪要)[：:\s｜|-]*/i, "")
    .replace(/[｜|]\s*(产品化方案|技术实现方案|运营落地方案|需求澄清|会议讨论|待确认)\s*$/i, "");
  const cleaned = cleanTitlePart(withoutDocType, "");
  return cleaned && !looksLikeGenericUploadName(cleaned) ? cleaned : "";
}

/** @param {unknown} sourceValue */
function inferProjectTitleFromSourceBody(sourceValue) {
  const source = asRecord(sourceValue);
  const text = readWorkspaceTextIfAvailable(source.extractedTextPath ?? source.sourcePath, 20000);
  const h1 = extractFirstMarkdownH1(text);
  return projectTitleFromDocumentTitle(h1);
}

/** @param {unknown} text */
function inferProjectTitleFromPrompt(text) {
  const prompt = cleanPromptForTitle(text);
  const candidates = [];
  const patterns = [
    /进行\s*([^，。；\n]{2,48}?)(?:的)?(?:PRD|技术架构文档?|客户\s*Checklist|客户需求确认表|会议纪要|运营方案|文档撰写)/gi,
    /(?:生成|撰写|输出|形成)\s*([^，。；\n]{2,48}?)(?:的)?(?:PRD|技术架构文档?|客户\s*Checklist|客户需求确认表|会议纪要|运营方案)/gi,
    /关于\s*([^，。；\n]{2,48}?)(?:的)?(?:PRD|技术架构文档?|客户\s*Checklist|客户需求确认表|会议纪要|运营方案)/gi,
    /([^，。；\n]{2,48}?)(?:的)?(?:PRD|技术架构文档?|客户\s*Checklist|客户需求确认表|会议纪要|运营方案)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of prompt.matchAll(pattern)) {
      const candidate = cleanTitlePart(match[1], "");
      if (candidate && !/^(这个文档|该文件|文件内容|文档内容|内容)$/.test(candidate)) candidates.push(candidate);
    }
  }
  return candidates
    .map((candidate, index) => ({
      candidate,
      score:
        (/(AI|Agent|智能|自动化|工作流|系统|平台|产品|项目|方案|流程)/i.test(candidate) ? 20 : 0) +
        Math.min(candidate.length, 24) -
        (/^(文档|文件|内容|材料)$/.test(candidate) ? 50 : 0) +
        index / 100,
    }))
    .sort((a, b) => b.score - a.score)[0]?.candidate ?? "";
}

/** @param {unknown[]} sources */
function inferProjectTitleFromSources(sources) {
  for (const source of sources) {
    const candidate = inferProjectTitleFromSourceBody(source);
    if (candidate) return { title: candidate, source: "source_heading" };
  }
  for (const source of sources) {
    const sourceRecord = asRecord(source);
    const candidate = stripExtensionForTitle(sourceRecord.fileName ?? sourceRecord.basename ?? sourceRecord.source ?? sourceRecord.type);
    if (candidate && !looksLikeGenericUploadName(candidate) && !/^(audio|file|source|text|markdown|pdf)$/i.test(candidate)) {
      return { title: candidate, source: "source_filename" };
    }
  }
  return { title: "", source: "" };
}

/** @param {unknown} meetingAnalysisValue */
function meetingTitleFromAnalysis(meetingAnalysisValue) {
  const meetingAnalysis = asRecord(meetingAnalysisValue);
  const participantResolution = asRecord(meetingAnalysis.participantResolution);
  const participants = asArray(participantResolution.participants).map(asRecord);
  const participantPart = participants.length <= 3
    ? participants.map((participant) => participant.displayName ?? participant.alias).filter(Boolean).join("与")
    : `${participants.slice(0, 2).map((participant) => participant.displayName ?? participant.alias).filter(Boolean).join("、")}等${participants.length}人`;
  const firstTopic = asRecord(asArray(meetingAnalysis.topicMap)[0]);
  const topicPart = cleanTitlePart(firstTopic.title, "会议主题待确认").slice(0, 28);
  const supportedDecision = asArray(meetingAnalysis.evidenceMap).map(asRecord).find((claim) => claim.claimType === "decision" && claim.status === "supported");
  const conclusionPart = cleanTitlePart(supportedDecision?.text ?? firstTopic.coreJudgment, "结论待确认").slice(0, 32);
  return {
    title: `会议纪要｜${participantPart || "参会人待确认"}｜${topicPart}｜${conclusionPart}`,
    participantPart: participantPart || "参会人待确认",
    topicPart,
    conclusionPart,
  };
}

/** @param {RunnerTask} task @param {string[]} requestedDocuments @param {UnknownRecord[]} sources @param {unknown} [documentIdentity] @param {unknown} [meetingAnalysis] */
function buildDocumentTitlePlan(task, requestedDocuments, sources, documentIdentity = null, meetingAnalysis = null) {
  const userPrompt = task.sourceEvent?.message?.text ?? "";
  const userPromptPreview = cleanPromptForTitle(userPrompt).slice(0, 160);
  const analyzedMeetingTitle = meetingTitleFromAnalysis(meetingAnalysis);
  const identity = asRecord(documentIdentity);
  const titleByDocType = asRecord(identity.titleByDocType);
  /** @type {Record<string, string>} */
  const prefixes = DOC_TITLE_PREFIX;
  /** @type {Record<string, string>} */
  const focuses = DOC_TITLE_FOCUS;
  if (Object.keys(titleByDocType).length > 0) {
    const projectTitle = cleanTitlePart(identity.normalizedTitleBase ?? identity.projectName ?? identity.subject, "待确认项目");
    const documents = requestedDocuments.map((docType) => {
      const identityTitle = asRecord(titleByDocType[docType]);
      const prefix = prefixes[docType] ?? cleanTitlePart(docType, "文档");
      const focus = focuses[docType] ?? "文档输出";
      const title = docType === "meeting-minutes" && analyzedMeetingTitle
        ? analyzedMeetingTitle.title
        : looksLikeGenericUploadName(identityTitle.title)
        ? (docType === "meeting-minutes" ? `${prefix}｜${projectTitle}｜${focus}｜待确认` : `${prefix}｜${projectTitle}｜${focus}`)
        : identityTitle.title;
      return {
        docType,
        title,
        feishuFileName: identityTitle.feishuFileName ?? safeFileName(title),
        titleBasis: {
          projectTitle,
          focus,
          source: docType === "meeting-minutes" && analyzedMeetingTitle ? "meeting_intelligence" : "document_identity",
          participants: analyzedMeetingTitle?.participantPart ?? null,
          topic: analyzedMeetingTitle?.topicPart ?? null,
          conclusion: analyzedMeetingTitle?.conclusionPart ?? null,
          identityBasis: identityTitle.identityBasis ?? identity.basis ?? [],
          identityConfidence: identityTitle.identityConfidence ?? identity.confidence ?? "low",
          sourceTitle: identity.sourceTitle ?? null,
          userPromptPreview,
        },
      };
    });
    return {
      schemaVersion: "document-title-plan-v1",
      generatedAt: nowIso(),
      projectTitle,
      sourceCount: sources.length,
      identityOwner: "source-context-runtime",
      documentIdentity: identity,
      documents,
      rawSecretsReturned: false,
    };
  }
  const promptProject = inferProjectTitleFromPrompt(userPrompt);
  const sourceProject = inferProjectTitleFromSources(sources);
  const projectTitle = cleanTitlePart(promptProject || sourceProject.title, "待确认项目");
  const documents = requestedDocuments.map((docType) => {
    const prefix = prefixes[docType] ?? cleanTitlePart(docType, "文档");
    const focus = focuses[docType] ?? "文档输出";
    const title = docType === "meeting-minutes" && analyzedMeetingTitle
      ? analyzedMeetingTitle.title
      : docType === "meeting-minutes"
      ? `${prefix}｜${projectTitle}｜${focus}｜待确认`
      : `${prefix}｜${projectTitle}｜${focus}`;
    return {
      docType,
      title,
      feishuFileName: safeFileName(title),
      titleBasis: {
        projectTitle,
        focus,
        source: promptProject ? "user_prompt" : sourceProject.source || "fallback",
        participants: analyzedMeetingTitle?.participantPart ?? null,
        topic: analyzedMeetingTitle?.topicPart ?? null,
        conclusion: analyzedMeetingTitle?.conclusionPart ?? null,
        userPromptPreview,
      },
    };
  });
  return {
    schemaVersion: "document-title-plan-v1",
    generatedAt: nowIso(),
    projectTitle,
    sourceCount: sources.length,
    documents,
    rawSecretsReturned: false,
  };
}

/** @param {RunnerTask} task */
function isDocumentRevisionTask(task) {
  const sourcePreparation = asRecord(task.taskIntent.sourcePreparation);
  return task?.taskIntent?.executionProfile === "document_revision" ||
    task?.taskIntent?.operation === "document_revision" ||
    task?.taskIntent?.taskType === "document_revision" ||
    sourcePreparation.operation === "document_revision";
}

/** @param {unknown} text */
function extractReviewSignals(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /批注|评论|修改意见|修订|建议|TODO|comment|suggestion|review/i.test(line))
    .slice(0, 80)
    .map((line, index) => ({
      commentId: `detected-${String(index + 1).padStart(2, "0")}`,
      status: "detected_from_exported_body",
      anchorPreview: line.slice(0, 240),
      commentText: line.slice(0, 500),
      author: null,
      createdAt: null,
      resolved: null,
    }));
}

/** @param {unknown} value */
function normalizeMatchText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。、“”‘’；：！？,.()[\]{}<>《》:;!?'"`~_-]+/g, "");
}

/** @param {string} text @param {string} needle */
function countOccurrences(text, needle) {
  const source = String(text ?? "");
  const query = String(needle ?? "");
  if (!query) return 0;
  let count = 0;
  let index = source.indexOf(query);
  while (index !== -1) {
    count += 1;
    index = source.indexOf(query, index + Math.max(1, query.length));
  }
  return count;
}

/** @param {string} text @param {unknown} quote */
function bodyAnchorPreview(text, quote) {
  const source = String(text ?? "");
  const query = String(quote ?? "");
  const index = query ? source.indexOf(query) : -1;
  if (index < 0) return query.slice(0, 300);
  const start = Math.max(0, index - 120);
  const end = Math.min(source.length, index + query.length + 120);
  return source.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 360);
}

/** @param {unknown} commentValue @param {string} bodyText */
function matchApiCommentToBody(commentValue, bodyText) {
  const comment = asRecord(commentValue);
  const quote = String(comment?.quote ?? "").trim();
  const base = {
    ...comment,
    sourceId: comment.sourceId,
    quote,
    replies: Array.isArray(comment.replies) ? comment.replies : [],
    bodyAnchorPreview: "",
    bodyAnchorHash: null,
    matchCount: 0,
  };
  if (!quote) {
    return {
      ...base,
      matchStatus: "unmatched",
      matchReason: "comment_quote_missing",
    };
  }
  const exactCount = countOccurrences(bodyText, quote);
  const anchorPreview = bodyAnchorPreview(bodyText, quote);
  if (exactCount === 1) {
    return {
      ...base,
      matchStatus: "exact_unique",
      matchReason: "quote_appears_once_in_source_body",
      matchCount: exactCount,
      bodyAnchorPreview: anchorPreview,
      bodyAnchorHash: hashText(anchorPreview),
    };
  }
  if (exactCount > 1) {
    return {
      ...base,
      matchStatus: "exact_multiple",
      matchReason: "quote_appears_multiple_times_in_source_body",
      matchCount: exactCount,
      bodyAnchorPreview: anchorPreview,
      bodyAnchorHash: hashText(anchorPreview),
    };
  }
  const normalizedQuote = normalizeMatchText(quote);
  const normalizedBody = normalizeMatchText(bodyText);
  if (normalizedQuote.length >= 8 && normalizedBody.includes(normalizedQuote)) {
    return {
      ...base,
      matchStatus: "fuzzy",
      matchReason: "normalized_quote_matches_source_body",
      matchCount: 1,
      bodyAnchorPreview: quote.slice(0, 300),
      bodyAnchorHash: hashText(quote),
    };
  }
  return {
    ...base,
    matchStatus: "unmatched",
    matchReason: "quote_not_found_in_source_body",
  };
}

/** @param {unknown} signalValue @param {unknown} sourceValue */
function exportedSignalToComment(signalValue, sourceValue) {
  const signal = asRecord(signalValue);
  const source = asRecord(sourceValue);
  const text = String(signal.commentText ?? signal.anchorPreview ?? "").trim();
  return {
    commentId: signal.commentId,
    sourceId: source.sourceId,
    fileName: source.fileName,
    fileType: source.fileType,
    quote: text.slice(0, 500),
    commentText: text.slice(0, 500),
    commentTextHash: text ? hashText(text) : null,
    replies: [],
    replyCount: 0,
    isSolved: null,
    matchStatus: "exported_body_detected",
    matchReason: "review_like_marker_detected_in_exported_body_without_independent_comment_thread",
    bodyAnchorPreview: text.slice(0, 360),
    bodyAnchorHash: text ? hashText(text) : null,
    matchCount: 1,
    rawSecretsReturned: false,
  };
}

/** @param {UnknownRecord[]} comments @param {UnknownRecord[]} [sourceDocuments] */
function summarizeMatchedComments(comments, sourceDocuments = []) {
  const totalComments = comments.length;
  const matchedExact = comments.filter((comment) => comment.matchStatus === "exact_unique").length;
  const weakMatched = comments.filter((comment) => ["exact_multiple", "fuzzy"].includes(String(comment.matchStatus ?? ""))).length;
  const unmatched = comments.filter((comment) => comment.matchStatus === "unmatched").length;
  const exportedBodyDetected = comments.filter((comment) => comment.matchStatus === "exported_body_detected").length;
  const sourcesWithUnavailableComments = sourceDocuments
    .filter((source) => !["cli", "sdk"].includes(String(asRecord(source.commentAccess).method ?? "")))
    .map((source) => source.sourceId);
  return {
    totalComments,
    matchedExact,
    weakMatched,
    unmatched,
    exportedBodyDetected,
    sourcesWithUnavailableComments,
  };
}

/** @param {RunnerTask} task @param {RunnerPaths} paths @param {UnknownRecord[]} sources @param {RunnerFileContext[]} contexts @param {RunnerOptions} [options] */
async function buildReviewContext(task, paths, sources, contexts, options = {}) {
  const userInstruction = cleanUserPrompt(task.sourceEvent?.message?.text ?? "");
  const apiContext = await fetchFeishuDocumentReviewContext({
    task,
    contexts,
    runCommand,
    options: {
      dryRun: options.dryRun === true,
      ...(typeof options.cliTimeoutMs === "number" ? { timeoutMs: options.cliTimeoutMs } : {}),
    },
  });
  const apiSourceResults = new Map(asArray(apiContext.sourceResults).map(asRecord).map((item) => [String(item.sourceId ?? ""), item]));
  const sourceDocuments = contexts.map((context, index) => {
    const sourceId = `file-${String(index + 1).padStart(2, "0")}`;
    const attachment = task.attachments?.[index] ?? {};
    const text = readTextIfAvailable(typeof context.extractedTextPath === "string" ? context.extractedTextPath : "", 30000) || String(context.contextPreview ?? "").slice(0, 30000);
    const apiSource = asRecord(apiSourceResults.get(sourceId));
    const detectedReviewSignals = extractReviewSignals(text);
    const apiComments = asArray(apiSource.comments).map(asRecord);
    const comments = apiComments.length > 0
      ? apiComments.map((comment) => matchApiCommentToBody(comment, text))
      : !["cli", "sdk"].includes(String(apiSource.method ?? ""))
        ? detectedReviewSignals.map((signal) => exportedSignalToComment(signal, {
          sourceId,
          fileName: context.fileName,
          fileType: attachment.explicitFileUrlType ?? attachment.fileType ?? context.fileType ?? null,
        }))
        : [];
    const commentAccess = {
      status: apiSource.status ?? "body_ready_comments_not_available",
      method: apiSource.method ?? "unavailable",
      reason: apiSource.reason ?? null,
      apiStatus: apiSource.apiStatus ?? "not_attempted",
      identityTried: apiSource.identityTried ?? [],
      requiredScopes: apiSource.requiredScopes ?? apiContext.requiredScopes ?? [],
      commentThreadCount: apiSource.commentThreadCount ?? apiComments.length,
      replyCount: apiSource.replyCount ?? comments.reduce((sum, comment) => sum + Number(asRecord(comment).replyCount ?? 0), 0),
      unresolvedCount: apiSource.unresolvedCount ?? comments.filter((comment) => asRecord(comment).isSolved === false || asRecord(comment).isSolved == null).length,
      plannedCommands: apiSource.plannedCommands ?? [],
      errors: apiSource.errors ?? [],
      exportedBodyDetectedCount: comments.filter((comment) => asRecord(comment).matchStatus === "exported_body_detected").length,
    };
    return {
      sourceId,
      fileName: context.fileName,
      fileTokenPresent: Boolean(attachment.fileToken),
      fileTokenHash: attachment.fileToken ? hashText(attachment.fileToken).slice(0, 16) : null,
      fileType: attachment.explicitFileUrlType ?? attachment.fileType ?? context.fileType ?? null,
      documentBodyPointer: workspaceRelative(context.extractedTextPath),
      bodyHash: hashText(text),
      bodyPreview: text.slice(0, 1200),
      commentAccess,
      comments,
      detectedReviewSignals,
    };
  });
  const comments = sourceDocuments.flatMap((source) => source.comments);
  const matchSummary = summarizeMatchedComments(comments, sourceDocuments);
  const status = apiContext.status === "ready" || apiContext.status === "partial_ready"
    ? apiContext.status
    : apiContext.status === "comment_api_permission_blocked"
      ? "comment_api_permission_blocked"
      : "body_ready_comments_not_available";
  const independentMethod = apiContext.status === "ready" || apiContext.status === "partial_ready";
  const reviewContext = {
    schemaVersion: "document-review-context-v1",
    generatedAt: nowIso(),
    operation: "document_revision",
    sourceRun: task.runId,
    status,
    userInstruction,
    sourceDocuments,
    comments,
    matchSummary,
    commentAccess: {
      status: apiContext.status,
      method: independentMethod
        ? apiContext.method
        : matchSummary.exportedBodyDetected > 0
          ? "export_body_detected"
          : "unavailable",
      reason: independentMethod
        ? "Feishu comment API returned bounded review context"
        : apiContext.reason || (matchSummary.exportedBodyDetected > 0
          ? "review-like markers were detected in exported document body"
          : "Feishu body export succeeded, but independent comment thread access is unavailable"),
      apiStatus: apiContext.apiStatus,
      identityTried: apiContext.identityTried,
      requiredScopes: apiContext.requiredScopes,
      commentThreadCount: apiContext.commentThreadCount,
      replyCount: apiContext.replyCount,
      unresolvedCount: apiContext.unresolvedCount,
      matchSummary,
      plannedCommands: apiContext.plannedCommands,
      errors: apiContext.errors,
      nextCapability: "feishu-document-review-context",
    },
    contextPolicy: {
      progressiveDisclosureRequired: true,
      fullDocumentInlineInMetrics: false,
      rawSecretsReturned: false,
      rawMediaExternalUpload: false,
      },
      rawSecretsReturned: false,
      rawMediaExternalUpload: false,
    };
  writeJson(reviewContextPath(paths.artifactsDir), reviewContext);
  return reviewContext;
}

/** @param {unknown} titlePlanValue @param {string} docType */
function titlePlanForDoc(titlePlanValue, docType) {
  const titlePlan = asRecord(titlePlanValue);
  return asArray(titlePlan.documents).map(asRecord).find((item) => item.docType === docType) ?? null;
}

/** @param {unknown} markdown */
function extractMarkdownH1(markdown) {
  return String(markdown ?? "").match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() ?? "";
}

/** @param {unknown} title @param {string} docType */
function isGenericTitle(title, docType) {
  const text = String(title ?? "").trim();
  if (!text) return true;
  if (/Mock\s+/i.test(text)) return true;
  if (looksLikeGenericUploadName(text)) return true;
  if (/产品\/项目名称或待确认|系统\/项目名称或待确认|客户\/项目名称或待确认/.test(text)) return true;
  if (docType === "meeting-minutes" && /^会议纪要｜参会方｜会议讨论｜待确认$/.test(text)) return true;
  return false;
}

/** @param {unknown} value */
function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

/** @param {unknown} value */
function cleanHtmlTableCell(value) {
  return decodeHtmlEntities(value)
    .replace(/<br\s*\/?>/gi, "； ")
    .replace(/<\/?(b|strong|em|i|p|span|div)[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
}

/** @param {string} tableHtml */
function htmlTableToMarkdown(tableHtml) {
  const rows = [...String(tableHtml ?? "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((rowMatch) => [...String(rowMatch[1] ?? "").matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((cellMatch) => cleanHtmlTableCell(cellMatch[1])))
    .filter((cells) => cells.length > 0);
  if (rows.length === 0) return tableHtml;
  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) => Array.from({ length: columnCount }, (_, index) => row[index] ?? ""));
  const header = normalizedRows[0] ?? [];
  const separator = Array.from({ length: columnCount }, () => "---");
  const body = normalizedRows.slice(1);
  return [header, separator, ...body].map((row) => `| ${row.join(" | ")} |`).join("\n");
}

/** @param {unknown} markdown */
function normalizeMarkdownTables(markdown) {
  return String(markdown ?? "").replace(/<table\b[\s\S]*?<\/table>/gi, (tableHtml) => htmlTableToMarkdown(tableHtml));
}

/** @param {unknown} markdown @param {string} title */
function syncMarkdownTitle(markdown, title) {
  const body = normalizeMarkdownTables(markdown).trim();
  if (!body) return `# ${title}\n`;
  if (/^#\s+.+?\s*$/m.test(body)) {
    return body.replace(/^#\s+.+?\s*$/m, `# ${title}`);
  }
  return `# ${title}\n\n${body}`;
}

/** @param {unknown} planValue @param {RunnerTask} task @param {RunnerPaths} paths @param {RunnerOptions} options @param {RunnerHooks} hooks @returns {Promise<UnknownRecord>} */
async function executeMeetingAgenticOrchestration(planValue, task, paths, options, hooks) {
  const plan = asRecord(planValue);
  const executor = asRecord(plan.executor);
  const executorTool = String(executor.tool ?? "subagent");
  const decision = shouldRunPiMeetingOrchestration(plan, options);
  if (pipelineMockModelEnabled(options)) {
    const skipped = {
      status: "skipped",
      reason: "pipeline_mock_model",
      mode: plan?.mode ?? "direct",
      expectedTool: executor.tool ?? null,
      rawSecretsReturned: false,
    };
    writeJson(agenticOrchestrationResultPath(paths.artifactsDir), skipped);
    return skipped;
  }
  if (!decision.run) {
    const skipped = {
      status: "skipped",
      reason: decision.reason,
      mode: plan?.mode ?? "direct",
      expectedTool: executor.tool ?? null,
      rawSecretsReturned: false,
    };
    writeJson(agenticOrchestrationResultPath(paths.artifactsDir), skipped);
    return skipped;
  }

  const envConfig = loadPiMeetingOrchestrationEnv(workspaceDir);
  const piCodingAgentDir = join(paths.runDir, ".pi-agentic");
  await hooks.onStep?.("meeting_agentic_delegation_started", "running", {
    mode: plan.mode,
    tool: executorTool,
    modelCandidates: envConfig.candidates.map((candidate) => ({ provider: candidate.provider, model: candidate.model, role: candidate.role })),
    authorizationSource: decision.reason,
  });
  const startedAt = Date.now();
  const attempts = [];
  const eventStreams = [];
  let completedAttempt = null;
  const timeoutMs = Number(options.meetingAgenticDelegationTimeoutMs ?? process.env.MEETING_AGENTIC_DELEGATION_TIMEOUT_MS ?? DEFAULT_MEETING_AGENTIC_DELEGATION_TIMEOUT_MS);
  for (const [index, candidate] of envConfig.candidates.entries()) {
    const invocation = buildPiMeetingOrchestrationInvocation({
      workspaceDir,
      packageDir,
      planPath: agenticOrchestrationPath(paths.artifactsDir),
      provider: candidate.provider,
      model: candidate.model,
      piCodingAgentDir: join(piCodingAgentDir, `attempt-${index + 1}`),
    });
    const commandResult = await runCommand(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: { ...envConfig.env, ...invocation.env },
      timeoutMs,
      maxOutputChars: Number(options.meetingAgenticEventMaxChars ?? process.env.MEETING_AGENTIC_EVENT_MAX_CHARS ?? DEFAULT_MEETING_AGENTIC_EVENT_MAX_CHARS),
    });
    eventStreams.push(commandResult.stdout);
    const parsed = parsePiMeetingOrchestrationOutput(commandResult.stdout, executorTool);
    const completed = commandResult.exitCode === 0 && parsed.status === "completed";
    const attempt = {
      provider: candidate.provider,
      model: candidate.model,
      role: candidate.role,
      status: completed ? "completed" : "blocked",
      reason: completed
        ? null
        : commandResult.timedOut
          ? "pi_meeting_agentic_delegation_timeout"
          : commandResult.exitCode !== 0
            ? "pi_meeting_agentic_process_failed"
            : parsed.reason,
      exitCode: commandResult.exitCode,
      timedOut: commandResult.timedOut,
      observedTools: parsed.observedTools ?? [],
      assistantSummary: parsed.assistantSummary ?? "",
      errorMessages: parsed.errorMessages ?? [],
      result: parsed.result ?? null,
      eventCount: parsed.eventCount ?? 0,
      parseErrors: parsed.parseErrors ?? [],
      stderrTail: redactString(commandResult.stderr).slice(-2000),
    };
    attempts.push(attempt);
    if (completed) {
      completedAttempt = attempt;
      break;
    }
  }
  writeText(agenticOrchestrationEventsPath(paths.artifactsDir), eventStreams.filter(Boolean).join("\n"));
  const finalAttempt = completedAttempt ?? attempts.at(-1);
  const status = completedAttempt ? "completed" : "blocked";
  const result = {
    schemaVersion: "meeting-agentic-orchestration-result-v1",
    status,
    reason: status === "completed" ? null : finalAttempt?.reason ?? "pi_meeting_agentic_delegation_failed",
    mode: plan.mode,
    expectedTool: executorTool,
    provider: finalAttempt?.provider ?? null,
    model: finalAttempt?.model ?? null,
    authorizationSource: decision.reason,
    durationMs: Date.now() - startedAt,
    exitCode: finalAttempt?.exitCode ?? null,
    timedOut: finalAttempt?.timedOut ?? false,
    loadedEnvKeys: envConfig.loadedKeys,
    attempts: attempts.map((attempt) => ({
      provider: attempt.provider,
      model: attempt.model,
      role: attempt.role,
      status: attempt.status,
      reason: attempt.reason,
      exitCode: attempt.exitCode,
      timedOut: attempt.timedOut,
      observedTools: attempt.observedTools,
      errorMessages: attempt.errorMessages,
      eventCount: attempt.eventCount,
    })),
    observedTools: finalAttempt?.observedTools ?? [],
    assistantSummary: finalAttempt?.assistantSummary ?? "",
    result: finalAttempt?.result ?? null,
    eventCount: attempts.reduce((total, attempt) => total + Number(attempt.eventCount ?? 0), 0),
    parseErrors: attempts.flatMap((attempt) => attempt.parseErrors ?? []),
    eventsArtifact: workspaceRelative(agenticOrchestrationEventsPath(paths.artifactsDir)),
    stderrTail: finalAttempt?.stderrTail ?? "",
    rawSecretsReturned: false,
  };
  writeJson(agenticOrchestrationResultPath(paths.artifactsDir), result);
  await hooks.onStep?.("meeting_agentic_delegation_completed", status, {
    mode: plan.mode,
    tool: executorTool,
    status,
    reason: result.reason,
    artifact: workspaceRelative(agenticOrchestrationResultPath(paths.artifactsDir)),
  });
  return result;
}

/** @param {RunnerOptions} [options] */
function meetingMemorySetting(options = {}) {
  return String(options.meetingMemoryCuration ?? process.env.MEETING_MEMORY_CURATION ?? "auto").trim().toLowerCase();
}

/** @param {RunnerOptions} [options] */
function meetingMemoryEnabled(options = {}) {
  return !["0", "false", "off", "disabled"].includes(meetingMemorySetting(options));
}

/** @param {{task: RunnerTask, paths: RunnerPaths, options: RunnerOptions, hooks: RunnerHooks, meetingAnalysis: unknown, documents: UnknownRecord[], qaGate: unknown}} input */
async function runMeetingMemoryCuration({ task, paths, options, hooks, meetingAnalysis, documents, qaGate }) {
  /** @param {string} reason */
  const skip = async (reason) => {
    const result = {
      schemaVersion: "meeting-memory-curation-result-v1",
      status: "skipped",
      reason,
      persistedCount: 0,
      rawSecretsReturned: false,
    };
    writeJson(meetingMemoryResultPath(paths.artifactsDir), result);
    await hooks.onStep?.("meeting_memory_curation_completed", "skipped", {
      reason,
      artifact: workspaceRelative(meetingMemoryResultPath(paths.artifactsDir)),
    });
    return result;
  };

  if (!meetingMemoryEnabled(options)) return skip("meeting_memory_curation_disabled");
  if (executionProfileForTask(task)?.id !== "audio_minutes") return skip("meeting_memory_only_runs_for_audio_minutes");
  if (pipelineMockModelEnabled(options)) return skip("pipeline_mock_model");
  const meetingAnalysisRecord = asRecord(meetingAnalysis);
  const qaGateRecord = asRecord(qaGate);
  if (meetingAnalysisRecord.status !== "complete" || meetingAnalysisRecord.analysisMode !== "model_reasoned_validated") {
    return skip("meeting_intelligence_not_model_validated");
  }
  if (qaGateRecord.status !== "pass") return skip("meeting_qa_not_passed");
  const minutes = documents.find((document) => document.docType === "meeting-minutes" && typeof document.localPath === "string");
  if (!minutes) return skip("final_meeting_minutes_missing");
  if (!existsSync(transcriptPath(paths.artifactsDir)) || !existsSync(participantMapPath(paths.artifactsDir))) {
    return skip("meeting_memory_sources_incomplete");
  }

  const plan = buildMeetingMemoryCuratorPlan({
    runId: task.runId,
    meetingAnalysisPath: workspaceRelative(meetingAnalysisPath(paths.artifactsDir)) ?? "",
    meetingMinutesPath: workspaceRelative(minutes.localPath) ?? "",
    qaGatePath: workspaceRelative(join(paths.runDir, "qa-gate.json")) ?? "",
    transcriptPath: workspaceRelative(transcriptPath(paths.artifactsDir)) ?? "",
    participantMapPath: workspaceRelative(participantMapPath(paths.artifactsDir)) ?? "",
  });
  writeJson(meetingMemoryPlanPath(paths.artifactsDir), plan);
  const envConfig = loadPiMeetingOrchestrationEnv(workspaceDir);
  const piCodingAgentDir = join(paths.runDir, ".pi-memory-curator");
  await hooks.onStep?.("meeting_memory_curation_started", "running", {
    mode: "single_subagent",
    agent: "meeting-memory-curator",
    modelCandidates: envConfig.candidates.map((candidate) => ({ provider: candidate.provider, model: candidate.model, role: candidate.role })),
    artifact: workspaceRelative(meetingMemoryPlanPath(paths.artifactsDir)),
  });
  const startedAt = Date.now();
  const attempts = [];
  const eventStreams = [];
  let completedAttempt = null;
  const timeoutMs = Number(options.meetingMemoryTimeoutMs ?? process.env.MEETING_MEMORY_TIMEOUT_MS ?? DEFAULT_MEETING_MEMORY_TIMEOUT_MS);
  for (const [index, candidate] of envConfig.candidates.entries()) {
    const invocation = buildPiMeetingMemoryInvocation({
      workspaceDir,
      packageDir,
      planPath: meetingMemoryPlanPath(paths.artifactsDir),
      provider: candidate.provider,
      model: candidate.model,
      piCodingAgentDir: join(piCodingAgentDir, `attempt-${index + 1}`),
    });
    const commandResult = await runCommand(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: { ...envConfig.env, ...invocation.env },
      timeoutMs,
      maxOutputChars: Number(options.meetingAgenticEventMaxChars ?? process.env.MEETING_AGENTIC_EVENT_MAX_CHARS ?? DEFAULT_MEETING_AGENTIC_EVENT_MAX_CHARS),
    });
    eventStreams.push(commandResult.stdout);
    const parsed = parsePiMeetingOrchestrationOutput(commandResult.stdout, "subagent");
    const payload = extractMeetingMemoryPayload(parsed.result);
    const completed = commandResult.exitCode === 0 && parsed.status === "completed" && payload !== null;
    const attempt = {
      provider: candidate.provider,
      model: candidate.model,
      role: candidate.role,
      status: completed ? "completed" : "blocked",
      reason: completed
        ? null
        : commandResult.timedOut
          ? "pi_meeting_memory_timeout"
          : commandResult.exitCode !== 0
            ? "pi_meeting_memory_process_failed"
            : parsed.status !== "completed"
              ? parsed.reason
              : "meeting_memory_structured_payload_missing",
      exitCode: commandResult.exitCode,
      timedOut: commandResult.timedOut,
      observedTools: parsed.observedTools ?? [],
      errorMessages: parsed.errorMessages ?? [],
      eventCount: parsed.eventCount ?? 0,
      parseErrors: parsed.parseErrors ?? [],
      payload,
      stderrTail: redactString(commandResult.stderr).slice(-2000),
    };
    attempts.push(attempt);
    if (completed) {
      completedAttempt = attempt;
      break;
    }
  }
  writeText(meetingMemoryEventsPath(paths.artifactsDir), eventStreams.filter(Boolean).join("\n"));
  const finalAttempt = completedAttempt ?? attempts.at(-1);
  if (!completedAttempt) {
    const result = {
      schemaVersion: "meeting-memory-curation-result-v1",
      status: "blocked",
      reason: finalAttempt?.reason ?? "meeting_memory_subagent_failed",
      durationMs: Date.now() - startedAt,
      attempts: attempts.map(({ payload, stderrTail, parseErrors, ...attempt }) => attempt),
      persistedCount: 0,
      eventsArtifact: workspaceRelative(meetingMemoryEventsPath(paths.artifactsDir)),
      stderrTail: finalAttempt?.stderrTail ?? "",
      rawSecretsReturned: false,
    };
    writeJson(meetingMemoryResultPath(paths.artifactsDir), result);
    await hooks.onStep?.("meeting_memory_curation_completed", "blocked", {
      reason: result.reason,
      artifact: workspaceRelative(meetingMemoryResultPath(paths.artifactsDir)),
    });
    return result;
  }

  const transcript = loadJson(transcriptPath(paths.artifactsDir));
  const knownSegmentIds = normalizeMeetingSegments(transcript?.transcriptSegments ?? []).map((segment) => segment.segmentId);
  const reconciliation = reconcileMeetingMemoryCandidates(completedAttempt.payload, {
    meetingAnalysis,
    knownSegmentIds,
    runId: task.runId,
  });
  const persistence = persistMeetingMemory(reconciliation, { workspaceDir });
  const status = persistence.conflicts.length > 0 || reconciliation.status === "needs_review" ? "needs_review" : "completed";
  const result = {
    schemaVersion: "meeting-memory-curation-result-v1",
    status,
    reason: persistence.conflicts.length > 0
      ? "memory_conflict_requires_review"
      : reconciliation.status === "needs_review"
        ? "some_memory_candidates_rejected"
        : null,
    mode: "single_subagent",
    agent: "meeting-memory-curator",
    provider: completedAttempt.provider,
    model: completedAttempt.model,
    durationMs: Date.now() - startedAt,
    attempts: attempts.map(({ payload, stderrTail, parseErrors, ...attempt }) => attempt),
    reconciliation,
    persistence: {
      status: persistence.status,
      persistedCount: persistence.persisted.length,
      duplicateCount: persistence.duplicates.length,
      conflictCount: persistence.conflicts.length,
      conflicts: persistence.conflicts,
      memoryPath: workspaceRelative(persistence.memoryPath),
      ledgerPath: workspaceRelative(persistence.ledgerPath),
    },
    eventsArtifact: workspaceRelative(meetingMemoryEventsPath(paths.artifactsDir)),
    rawSecretsReturned: false,
  };
  writeJson(meetingMemoryResultPath(paths.artifactsDir), result);
  await hooks.onStep?.("meeting_memory_curation_completed", status, {
    reason: result.reason,
    persistedCount: persistence.persisted.length,
    rejectedCount: reconciliation.rejected.length,
    conflictCount: persistence.conflicts.length,
    artifact: workspaceRelative(meetingMemoryResultPath(paths.artifactsDir)),
  });
  return result;
}

/** @param {{task: RunnerTask, paths: RunnerPaths, options: RunnerOptions, hooks: RunnerHooks, meetingAnalysis: unknown, documents: UnknownRecord[], qaGate: unknown}} input */
async function runMeetingMemoryCurationSafely(input) {
  try {
    return await runMeetingMemoryCuration(input);
  } catch (error) {
    const result = {
      schemaVersion: "meeting-memory-curation-result-v1",
      status: "blocked",
      reason: "meeting_memory_curation_failed",
      error: redactString(error instanceof Error ? error.message : String(error)).slice(0, 1200),
      persistedCount: 0,
      rawSecretsReturned: false,
    };
    writeJson(meetingMemoryResultPath(input.paths.artifactsDir), result);
    await input.hooks.onStep?.("meeting_memory_curation_completed", "blocked", {
      reason: result.reason,
      artifact: workspaceRelative(meetingMemoryResultPath(input.paths.artifactsDir)),
    });
    return result;
  }
}

/** @param {RunnerTask} task @param {RunnerPaths} paths @param {RunnerOptions} options @param {RunnerHooks} hooks */
async function ensureMeetingIntelligence(task, paths, options, hooks) {
  if (!existsSync(transcriptPath(paths.artifactsDir))) {
    return { status: "skipped", reason: "transcript_not_available", analysis: null };
  }
  const transcript = loadJson(transcriptPath(paths.artifactsDir));
  const segments = normalizeMeetingSegments(transcript?.transcriptSegments ?? []);
  if (segments.length === 0) return { status: "skipped", reason: "transcript_segments_empty", analysis: null };
  const userPrompt = cleanUserPrompt(task.sourceEvent?.message?.text ?? "");
  const participantMap = buildParticipantMap(segments, userPrompt);
  const asrSummary = existsSync(asrSummaryPath(paths.artifactsDir)) ? loadJson(asrSummaryPath(paths.artifactsDir)) : null;
  const prompt = buildMeetingAnalysisPrompt({
    segments,
    participantMap,
    asrSummary,
    userPrompt,
    maxChars: Number(options.meetingAnalysisMaxPromptChars ?? process.env.FEISHU_AGENT_MEETING_ANALYSIS_MAX_PROMPT_CHARS ?? 140_000),
  });

  /** @type {UnknownRecord | null} */
  let analysis = null;
  /** @type {UnknownRecord | null} */
  let routePlan = null;
  /** @type {UnknownRecord | null} */
  let generation = null;
  if (!pipelineMockModelEnabled(options)) {
    routePlan = await callRuntimeTool("model_route_plan", {
      taskType: "meeting_analysis",
      docType: "meeting-minutes",
      reasoningDepth: "deep",
      estimatedComplexity: segments.length >= 120 ? "high" : "medium",
    }, paths, options);
    const candidate = routePlan.status === "selected" ? asRecord(routePlan.selected) : null;
    if (candidate && typeof candidate.provider === "string" && typeof candidate.model === "string") {
      generation = await callModelGenerateText({
        provider: candidate.provider,
        model: candidate.model,
        prompt: prompt.prompt,
        systemPrompt: [
          "你是 Meeting Intelligence Agent。你的任务是从带时间戳、匿名参会人和 ASR 质量标签的当前会议证据中建立结构化会议状态。",
          "你自主识别会议类型、议题、分歧、共识、行动和开放问题。允许从自我介绍、明确称呼、上下文关系或已登记声纹匹配提出姓名候选，但必须保留 alias、证据与置信度，不能把候选身份用于确定 owner 或承诺。",
          "不要把未知声纹聚类凭空解释为真实姓名，也不要把低质量语音升级为确定决定。",
          "只输出符合用户 Prompt 中 contract 的 JSON。",
        ].join(""),
        temperature: 0.1,
        maxTokens: Number(options.meetingAnalysisMaxTokens ?? process.env.FEISHU_AGENT_MEETING_ANALYSIS_MAX_TOKENS ?? 7000),
        timeoutMs: Number(options.modelTimeoutMs ?? process.env.FEISHU_AGENT_MODEL_TIMEOUT_MS ?? 180_000),
        modelRoute: routePlan,
      }, paths, options, executionProfileForTask(task)?.id ?? "audio_minutes");
      if (generation?.status === "completed") {
        analysis = normalizeMeetingAnalysisResponse({
          content: generation.content,
          segments,
          participantMap,
          asrSummary,
        });
      }
    }
  }
  if (!analysis) {
    analysis = buildFallbackMeetingAnalysis({
      segments,
      participantMap,
      asrSummary,
      reason: String(pipelineMockModelEnabled(options)
        ? "pipeline_mock_model"
        : generation?.reason ?? routePlan?.reason ?? "meeting_analysis_response_invalid"),
    });
  }
  analysis = {
    ...asRecord(analysis),
    generatedAt: nowIso(),
    source: {
      transcriptPath: workspaceRelative(transcriptPath(paths.artifactsDir)),
      segmentCount: segments.length,
      timelineTruncated: prompt.timeline.truncated,
      timelineIncludedSegmentCount: prompt.timeline.includedSegmentIds.length,
    },
    model: generation?.status === "completed"
      ? { provider: generation.provider, model: generation.model, status: generation.status }
      : {
          provider: asRecord(routePlan?.selected).provider ?? null,
          model: asRecord(routePlan?.selected).model ?? null,
          status: generation?.status ?? routePlan?.status ?? "fallback",
        },
  };
  const orchestration = buildMeetingOrchestrationPlan(analysis, {
    meetingAnalysisPath: workspaceRelative(meetingAnalysisPath(paths.artifactsDir)),
    transcriptPath: workspaceRelative(transcriptPath(paths.artifactsDir)),
    participantMapPath: workspaceRelative(participantMapPath(paths.artifactsDir)),
  });
  analysis.agentPlan = {
    ...asRecord(analysis.agentPlan),
    orchestrationMode: orchestration.mode,
    specialistCount: orchestration.specialists.length,
  };
  let agentPlan = asRecord(analysis.agentPlan);
  const productDiscovery = asRecord(analysis.productDiscovery);
  writeJson(meetingAnalysisPath(paths.artifactsDir), analysis);
  writeJson(meetingProfilePath(paths.artifactsDir), analysis.meetingProfile);
  writeJson(participantMapPath(paths.artifactsDir), analysis.participantResolution);
  writeJson(topicMapPath(paths.artifactsDir), { schemaVersion: "meeting-topic-map-v1", topics: analysis.topicMap });
  writeJson(internalEvidenceMapPath(paths.artifactsDir), { schemaVersion: "meeting-evidence-map-v1", claims: analysis.evidenceMap });
  writeJson(agentPlanPath(paths.artifactsDir), { schemaVersion: "meeting-agent-plan-v1", ...agentPlan });
  writeJson(productDiscoveryPath(paths.artifactsDir), analysis.productDiscovery ?? {
    schemaVersion: "meeting-product-discovery-v1",
    status: "not_available",
    clarificationQuestions: [],
    nextStepOptions: [],
  });
  writeJson(nextStepOptionsPath(paths.artifactsDir), {
    schemaVersion: "meeting-next-step-options-v1",
    prdReadiness: productDiscovery.prdReadiness ?? null,
    options: productDiscovery.nextStepOptions ?? agentPlan.nextStepOptions ?? [],
    clarificationQuestions: productDiscovery.clarificationQuestions ?? [],
    suggestedFollowUpDocuments: agentPlan.suggestedFollowUpDocuments ?? [],
    rawSecretsReturned: false,
  });
  writeJson(agenticOrchestrationPath(paths.artifactsDir), orchestration);
  const delegatedReview = await executeMeetingAgenticOrchestration(orchestration, task, paths, options, hooks);
  const delegationReconciliation = reconcilePiMeetingOrchestrationResult(
    delegatedReview,
    segments.map((segment) => segment.segmentId),
  );
  writeJson(agenticOrchestrationResultPath(paths.artifactsDir), {
    ...delegatedReview,
    reconciliation: delegationReconciliation,
  });
  Object.assign(analysis, { delegatedReview: {
    status: delegationReconciliation.status,
    toolRunStatus: delegatedReview.status,
    reason: delegatedReview.reason,
    mode: orchestration.mode,
    tool: orchestration.executor?.tool ?? null,
    evidenceScopeSatisfied: delegationReconciliation.evidenceScopeSatisfied,
    referencedSegmentIds: delegationReconciliation.referencedSegmentIds,
    invalidSegmentIds: delegationReconciliation.invalidSegmentIds,
    missingEvidencePaths: delegationReconciliation.missingEvidencePaths,
    qaPriorities: delegationReconciliation.qaPriorities,
    assistantSummary: delegationReconciliation.evidenceScopeSatisfied ? delegatedReview.assistantSummary ?? "" : "",
    result: delegationReconciliation.result,
    artifact: workspaceRelative(agenticOrchestrationResultPath(paths.artifactsDir)),
  } });
  analysis.agentPlan = {
    ...asRecord(analysis.agentPlan),
    delegationStatus: delegationReconciliation.status,
    delegationReason: delegatedReview.reason,
  };
  agentPlan = asRecord(analysis.agentPlan);
  const meetingProfile = asRecord(analysis.meetingProfile);
  const participantResolution = asRecord(analysis.participantResolution);
  writeJson(meetingAnalysisPath(paths.artifactsDir), analysis);
  writeJson(agentPlanPath(paths.artifactsDir), { schemaVersion: "meeting-agent-plan-v1", ...agentPlan });
  await hooks.onStep?.("meeting_intelligence_completed", "completed", {
    analysisMode: analysis.analysisMode,
    meetingType: meetingProfile.meetingType ?? null,
    participantCount: participantResolution.participantCount ?? 0,
    unresolvedParticipantCount: participantResolution.unresolvedCount ?? 0,
    topicCount: asArray(analysis.topicMap).length,
    reviewStrategy: agentPlan.reviewStrategy ?? null,
    orchestrationMode: orchestration.mode,
    specialistCount: orchestration.specialists.length,
    delegationStatus: delegationReconciliation.status,
    delegationToolRunStatus: delegatedReview.status,
    delegationReason: delegatedReview.reason,
    artifact: workspaceRelative(meetingAnalysisPath(paths.artifactsDir)),
  });
  if (typeof participantResolution.question === "string" && participantResolution.question) {
    await hooks.progressReply?.(participantResolution.question, "participant_names_requested");
  }
  return { status: "completed", analysis, orchestration, delegatedReview, routePlan, generation };
}

/** @param {RunnerTask} task @param {RunnerPaths} paths @param {RunnerOptions} [options] */
async function buildEvidencePack(task, paths, options = {}) {
  const sourcePreparation = asRecord(task.taskIntent.sourcePreparation);
  const requestedDocuments = Array.isArray(task.taskIntent?.requestedDocuments) && task.taskIntent.requestedDocuments.length > 0
    ? task.taskIntent.requestedDocuments
    : ["meeting-minutes"];
  const sources = [];
  const contexts = Array.isArray(task.fileContexts?.contexts) ? task.fileContexts.contexts : [];
  for (const [index, context] of contexts.entries()) {
    const sourceId = `file-${String(index + 1).padStart(2, "0")}`;
    sources.push({
      sourceId,
      type: context.fileType,
      fileName: context.fileName,
      extension: context.extension,
      contextMode: context.contextMode,
      status: context.status,
      sourcePath: workspaceRelative(context.sourcePath),
      extractedTextPath: workspaceRelative(context.extractedTextPath),
      externalLlmAllowed: context.externalLlmAllowed,
    });
  }
  if (existsSync(evidenceIndexPath(paths.artifactsDir))) {
    const evidence = loadJson(evidenceIndexPath(paths.artifactsDir));
    const sourceSummary = asArray(evidence.sources).map(asRecord).map((source, index) => ({
      sourceId: `audio-${String(index + 1).padStart(2, "0")}`,
      type: source.type ?? "audio_transcript",
      fileName: source.basename ?? null,
      durationSec: source.durationSec,
      chunkCount: source.chunkCount,
      privacy: source.privacy,
    }));
    sources.push(...sourceSummary);
  }

  const sourceRunId = String(sourcePreparation.sourceRunId ?? "").trim();
  if (sourceRunId) {
    const sourceRunDir = resolve(dirname(paths.runDir), safeSegment(sourceRunId));
    if (isInside(dirname(paths.runDir), sourceRunDir) && existsSync(sourceRunDir)) {
      const reusable = [
        ["meeting_analysis", join(sourceRunDir, "artifacts", "meeting-intelligence", "meeting-analysis.json")],
        ["meeting_minutes", ...(() => {
          const artifactsDir = join(sourceRunDir, "artifacts");
          if (!existsSync(artifactsDir)) return [""];
          const file = readdirSync(artifactsDir).find((name) => name.endsWith(".md") && /会议纪要/u.test(name));
          return [file ? join(artifactsDir, file) : ""];
        })()],
        ["source_planner", join(sourceRunDir, "planner-envelope.json")],
      ];
      for (const [kind, path] of reusable) {
        if (!path || !existsSync(path)) continue;
        contexts.push({
          fileType: kind === "meeting_minutes" ? "markdown" : "json",
          fileName: basename(path),
          extension: kind === "meeting_minutes" ? ".md" : ".json",
          contextMode: "source_run_artifact",
          status: "ready",
          sourcePath: path,
          extractedTextPath: path,
          externalLlmAllowed: true,
          sourceRunId,
        });
      }
    }
  }

  const reviewContext = isDocumentRevisionTask(task) ? await buildReviewContext(task, paths, sources, contexts, options) : null;
  const meetingAnalysis = options.meetingAnalysis ?? null;
  const sourceContext = await callRuntimeTool("source_context_prepare", {
    runId: task.runId,
    outputRoot: dirname(paths.runDir),
    taskPrompt: cleanUserPrompt(task.sourceEvent?.message?.text ?? ""),
    requestedDocuments,
    sourcePreparation,
    fileContexts: task.fileContexts ?? null,
    transcriptPath: existsSync(transcriptPath(paths.artifactsDir)) ? transcriptPath(paths.artifactsDir) : undefined,
    evidenceIndexPath: existsSync(evidenceIndexPath(paths.artifactsDir)) ? evidenceIndexPath(paths.artifactsDir) : undefined,
    asrSummaryPath: existsSync(asrSummaryPath(paths.artifactsDir)) ? asrSummaryPath(paths.artifactsDir) : undefined,
    reviewContext,
    meetingAnalysis,
    operation: isDocumentRevisionTask(task) ? "document_revision" : requestedDocuments.includes("meeting-minutes") ? "meeting_minutes" : "create_document",
    sectionsPerUnit: options.sectionsPerUnit ?? options.sectionsPerBatch ?? 2,
  }, paths, options, executionProfileForTask(task)?.id ?? "");
  const sourceEvidenceSummary = asRecord(sourceContext.evidenceSummary);
  const meetingAnalysisRecord = asRecord(meetingAnalysis);
  const titlePlan = buildDocumentTitlePlan(task, requestedDocuments, sources, sourceContext.documentIdentity, meetingAnalysisRecord);
  writeJson(titlePlanPath(paths.artifactsDir), titlePlan);

  const pack = {
    schemaVersion: "office-evidence-pack-v2",
    generatedAt: nowIso(),
    sourceSetMode: sourcePreparation.sourceSetMode ?? "consolidated",
    conflictPolicy: sourcePreparation.conflictPolicy ?? "source_attribution",
    requestedDocuments,
    titlePlan: titlePlan.documents.map((item) => ({
      docType: item.docType,
      title: item.title,
      feishuFileName: item.feishuFileName,
      titleBasis: item.titleBasis,
    })),
    sourceCount: sourceEvidenceSummary.sourceCount ?? sources.length,
    segmentCount: sourceEvidenceSummary.segmentCount ?? 0,
    audioSegmentCount: sourceEvidenceSummary.audioSegmentCount ?? 0,
    sources: sourceEvidenceSummary.sourceSummary ?? sources,
    contextPlane: {
      schemaVersion: sourceContext.schemaVersion ?? "source-context-v2",
      manifestPath: workspaceRelative(sourceContext.manifestPath),
      sourceRecordsPath: workspaceRelative(sourceContext.sourceRecordsPath),
      sourceSegmentsPath: workspaceRelative(sourceContext.sourceSegmentsPath),
      sourceStructurePath: workspaceRelative(sourceContext.sourceStructurePath),
      taskStatePath: workspaceRelative(sourceContext.taskStatePath),
      retrievalPlanPath: workspaceRelative(sourceContext.retrievalPlanPath),
      gatePath: workspaceRelative(sourceContext.gatePath),
      workUnitCount: asArray(sourceContext.workUnits).length,
      contextGate: sourceContext.gate ?? null,
      documentIdentity: sourceContext.documentIdentity ?? null,
      sourceStructureSummary: sourceContext.sourceStructureSummary ?? null,
      outputContract: sourceContext.outputContract ?? null,
      fullContentAvailableByArtifact: true,
    },
    reviewContext: reviewContext
      ? {
          status: reviewContext.status,
          operation: reviewContext.operation,
          commentCount: reviewContext.comments.length,
          matchSummary: reviewContext.matchSummary,
          commentAccess: reviewContext.commentAccess,
          artifact: workspaceRelative(reviewContextPath(paths.artifactsDir)),
        }
      : null,
    meetingIntelligence: Object.keys(meetingAnalysisRecord).length > 0
      ? {
          status: meetingAnalysisRecord.status,
          analysisMode: meetingAnalysisRecord.analysisMode,
          meetingType: asRecord(meetingAnalysisRecord.meetingProfile).meetingType ?? null,
          participantCount: asRecord(meetingAnalysisRecord.participantResolution).participantCount ?? 0,
          unresolvedParticipantCount: asRecord(meetingAnalysisRecord.participantResolution).unresolvedCount ?? 0,
          topicCount: asArray(meetingAnalysisRecord.topicMap).length,
          delegationStatus: asRecord(meetingAnalysisRecord.delegatedReview).status ?? "skipped",
          delegationArtifact: asRecord(meetingAnalysisRecord.delegatedReview).artifact ?? null,
          suggestedFollowUpDocuments: asArray(asRecord(meetingAnalysisRecord.agentPlan).suggestedFollowUpDocuments),
          artifact: workspaceRelative(meetingAnalysisPath(paths.artifactsDir)),
        }
      : null,
    sourceMediaExternalUpload: false,
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
    fullContentAvailableByArtifact: true,
  };
  writeJson(evidencePackPath(paths.artifactsDir), pack);
  return {
    evidenceSummary: {
      schemaVersion: "office-evidence-summary-v2",
      sourceSetMode: pack.sourceSetMode,
      conflictPolicy: pack.conflictPolicy,
      sourceCount: pack.sourceCount,
      segmentCount: pack.segmentCount,
      audioSegmentCount: pack.audioSegmentCount,
      requestedDocuments,
      titlePlan: titlePlan.documents.map((item) => ({
        docType: item.docType,
        title: item.title,
        feishuFileName: item.feishuFileName,
        titleBasis: item.titleBasis,
      })),
      sourceSummary: pack.sources,
      contextPlane: pack.contextPlane,
      contextGate: sourceContext.gate ?? null,
      documentIdentity: sourceContext.documentIdentity ?? null,
      sourceStructureSummary: sourceContext.sourceStructureSummary ?? null,
      outputContract: sourceContext.outputContract ?? null,
      sourceMediaExternalUpload: false,
      textEvidenceExternalLlmDefault: "allow",
      fullContentAvailableByArtifact: true,
      reviewContext: reviewContext
        ? {
            status: reviewContext.status,
            operation: reviewContext.operation,
            commentCount: reviewContext.comments.length,
            matchSummary: reviewContext.matchSummary,
            commentAccess: reviewContext.commentAccess,
            artifact: workspaceRelative(reviewContextPath(paths.artifactsDir)),
          }
        : null,
      meetingIntelligence: pack.meetingIntelligence,
    },
    titlePlan,
    reviewContext,
    sourceContext,
  };
}

/** @param {unknown} markdown */
function extractTitle(markdown) {
  return extractMarkdownH1(markdown);
}

/** @param {RunnerPaths} paths */
function modelRoutePath(paths) {
  return join(paths.runDir, "model-route.json");
}

/** @param {RunnerOptions} options */
function pipelineMockModelEnabled(options) {
  return options.pipelineMockModel === true || /^(1|true|yes|on)$/i.test(process.env.FEISHU_AGENT_PIPELINE_MOCK_MODEL ?? "");
}

/** @param {string} status @param {string} summary @param {UnknownRecord} [details] @param {unknown[]} [artifacts] @param {string | null} [executionProfile] @returns {PipelineOutput} */
function directOutput(status, summary, details = {}, artifacts = [], executionProfile = null) {
  /** @type {PipelineOutput} */
  const output = {
    status,
    summary: redactString(summary).slice(0, 3500),
    documents: [],
    artifacts,
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  };
  if (executionProfile) output.executionProfile = executionProfile;
  if (Object.keys(details).length > 0) output.details = asRecord(sanitize(details));
  return output;
}

/** @param {unknown} text @param {string} fallback */
function cleanGeneratedText(text, fallback) {
  const cleaned = redactString(String(text ?? "").trim()).replace(/\n{3,}/g, "\n\n").trim();
  return (cleaned || fallback).slice(0, 3500).trim();
}

/** @param {string} kind */
function directSystemPrompt(kind) {
  if (kind === "file_summary") {
    return [
      "你是一个中文文件总结助手。",
      "只根据用户提供的有界文件预览和摘录回答；不要声称读取了被省略的全文。",
      "如果证据不足，直接说明缺口。不要调用外部工具，不要输出发布或 QA 状态。",
    ].join("");
  }
  return [
    "你是一个中文 IM 快速回复助手。",
    "直接回答用户问题，保持简洁、具体、可执行。",
    "不要编造未提供的事实，不要输出发布或 QA 状态。",
  ].join("");
}

/** @param {RunnerTask} task */
function directUserPrompt(task) {
  const prompt = cleanUserPrompt(task.sourceEvent?.message?.text ?? "");
  return [
    "## User Request",
    "",
    redactString(prompt || "请直接回复。"),
    "",
    "## Output",
    "",
    "请输出可直接发送给用户的中文回复，不要包裹 JSON。",
  ].join("\n");
}

/** @param {UnknownRecord} [profileConfig] */
function fileSummaryPolicy(profileConfig = {}) {
  return {
    ...DEFAULT_FILE_SUMMARY_CONTEXT_POLICY,
    ...(profileConfig.contextPolicy ?? {}),
  };
}

/** @param {string} text @param {number} sliceChars @param {number} maxSlices */
function boundedTextSlices(text, sliceChars, maxSlices) {
  const clean = redactString(String(text ?? "").replace(/\u0000/g, "").trim());
  if (!clean || sliceChars <= 0 || maxSlices <= 0) return [];
  if (clean.length <= sliceChars || maxSlices === 1) {
    return [{ label: "start", text: clean.slice(0, sliceChars), omittedChars: Math.max(0, clean.length - sliceChars) }];
  }
  const slices = [{ label: "start", text: clean.slice(0, sliceChars), omittedChars: 0 }];
  if (maxSlices > 2) {
    const middleStart = Math.max(0, Math.floor(clean.length / 2) - Math.floor(sliceChars / 2));
    slices.push({ label: "middle", text: clean.slice(middleStart, middleStart + sliceChars), omittedChars: 0 });
  }
  slices.push({ label: "end", text: clean.slice(-sliceChars), omittedChars: 0 });
  return slices.slice(0, maxSlices).map((slice) => ({
    ...slice,
    omittedChars: Math.max(0, clean.length - slices.reduce((sum, item) => sum + item.text.length, 0)),
  }));
}

/** @param {string[]} parts @param {unknown} text @param {number} budget */
function appendWithinBudget(parts, text, budget) {
  const value = String(text ?? "");
  if (!value) return budget;
  const clipped = value.slice(0, Math.max(0, budget));
  if (clipped) parts.push(clipped);
  return Math.max(0, budget - clipped.length);
}

/** @param {RunnerTask} task @param {RunnerPaths} paths @param {UnknownRecord} [profileConfig] */
function buildFileSummaryContext(task, paths, profileConfig = {}) {
  const policy = fileSummaryPolicy(profileConfig);
  const contexts = (Array.isArray(task.fileContexts?.contexts) ? task.fileContexts.contexts : [])
    .filter((context) => context?.status === "ready")
    .slice(0, policy.maxSources);
  const sources = contexts.map((context, index) => {
    const externalLlmAllowed = true;
    const preview = redactString(String(context.contextPreview ?? "").slice(0, policy.previewCharsPerSource));
    const extractedText = readTextIfAvailable(typeof context.extractedTextPath === "string" ? context.extractedTextPath : "", policy.extractedSliceChars * Math.max(1, policy.maxExtractedSlicesPerSource) * 4);
    return {
      sourceId: `file-${String(index + 1).padStart(2, "0")}`,
      fileName: context.fileName ?? null,
      fileType: context.fileType ?? null,
      extension: context.extension ?? null,
      contextMode: context.contextMode ?? null,
      status: context.status,
      externalLlmAllowed,
      sourcePath: workspaceRelative(context.sourcePath),
      extractedTextPath: workspaceRelative(context.extractedTextPath),
      preview,
      extractedSlices: boundedTextSlices(extractedText, policy.extractedSliceChars, policy.maxExtractedSlicesPerSource),
      fullContentIncluded: false,
    };
  });
  const fileContext = {
    schemaVersion: "file-summary-context-v1",
    generatedAt: nowIso(),
    sourceCount: sources.length,
    contextPolicy: policy,
    sources,
    sourceMediaExternalUpload: false,
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
    fullContentAvailableByArtifact: true,
  };
  writeJson(fileSummaryContextPath(paths.artifactsDir), fileContext);
  return fileContext;
}

/** @param {RunnerTask} task @param {unknown} fileContextValue */
function renderFileSummaryPrompt(task, fileContextValue) {
  const fileContext = asRecord(fileContextValue);
  const contextPolicy = asRecord(fileContext.contextPolicy);
  const parts = [
    "## User Request",
    "",
    redactString(cleanUserPrompt(task.sourceEvent?.message?.text ?? "请总结文件内容。")),
    "",
    "## Context Policy",
    "",
    "Only bounded previews and extracted slices are included. Omitted content must be treated as unknown.",
    "",
    "## Sources",
    "",
  ];
  let budget = Number(contextPolicy.maxPromptChars ?? DEFAULT_FILE_SUMMARY_CONTEXT_POLICY.maxPromptChars);
  for (const source of asArray(fileContext.sources).map(asRecord)) {
    const sourceParts = [
      `### ${source.sourceId}: ${source.fileName ?? "unnamed file"}`,
      "",
      JSON.stringify({
        fileType: source.fileType,
        extension: source.extension,
        contextMode: source.contextMode,
        externalLlmAllowed: source.externalLlmAllowed,
        fullContentIncluded: false,
      }, null, 2),
      "",
    ];
    if (source.preview) sourceParts.push("#### Preview", "", String(source.preview), "");
    for (const slice of asArray(source.extractedSlices).map(asRecord)) {
      sourceParts.push(`#### Extracted Slice: ${String(slice.label ?? "slice")}`, "", String(slice.text ?? ""), "");
    }
    budget = appendWithinBudget(parts, sourceParts.join("\n"), budget);
    if (budget <= 0) break;
  }
  parts.push(
    "",
    "## Output",
    "",
    "用中文输出简洁总结，包含：核心内容、关键信息、用户应注意的限制或待确认项。不要输出 JSON。",
  );
  return parts.join("\n").slice(0, Number(contextPolicy.maxPromptChars ?? DEFAULT_FILE_SUMMARY_CONTEXT_POLICY.maxPromptChars) + 2000);
}

/** @param {unknown} routePlanValue @param {string} executionProfile @param {RunnerOptions} options @returns {UnknownRecord | null} */
function generationCandidate(routePlanValue, executionProfile, options) {
  const routePlan = asRecord(routePlanValue);
  if (pipelineMockModelEnabled(options)) {
    return { provider: "mock", model: `mock-${safeSegment(executionProfile, "fast-answer")}`, strength: "test" };
  }
  return routePlan.status === "selected" ? asRecord(routePlan.selected) : null;
}

/** @param {RunnerTask} task @param {RunnerPaths} paths @param {RunnerOptions} options @param {RunnerHooks} hooks @param {string} executionProfile @param {UnknownRecord} [profileConfig] */
async function planFastDraftRoute(task, paths, options, hooks, executionProfile, profileConfig = {}) {
  const routePlan = await callRuntimeTool("model_route_plan", {
    taskType: profileConfig.routeTaskType ?? "fast_draft",
    reasoningDepth: profileConfig.reasoningDepth ?? "fast",
  }, paths, options);
  const candidate = generationCandidate(routePlan, executionProfile, options);
  const selected = asRecord(routePlan.selected);
  await callRuntimeTool("model_route_record", {
    runId: task.runId,
    route: {
      ...routePlan,
      executionProfile,
      directGenerationCandidate: candidate,
    },
    outputRoot: dirname(paths.runDir),
  }, paths, options);
  await hooks.onStep?.("model_route_planned", routePlan.status === "selected" ? "completed" : "blocked", {
    artifact: modelRoutePath(paths),
    selectedProvider: candidate?.provider ?? selected.provider ?? null,
    selectedModel: candidate?.model ?? selected.model ?? null,
    executionProfile,
  });
  return { routePlan, candidate };
}

/** @param {{task: RunnerTask, paths: RunnerPaths, options: RunnerOptions, hooks: RunnerHooks, executionProfile: string, profileConfig: UnknownRecord, prompt: string, systemPrompt: string, maxTokens: number, mockResponse: string}} input */
async function generateDirectReply({ task, paths, options, hooks, executionProfile, profileConfig, prompt, systemPrompt, maxTokens, mockResponse }) {
  const { routePlan, candidate } = await planFastDraftRoute(task, paths, options, hooks, executionProfile, profileConfig);
  if (routePlan.status !== "selected" || !candidate || typeof candidate.provider !== "string" || typeof candidate.model !== "string") {
    return {
      status: "blocked",
      output: directOutput("blocked", "当前没有可用模型生成回复。", routePlan, [
        { kind: "model-route", name: "model-route.json", localPath: modelRoutePath(paths) },
      ], executionProfile),
      mode: "task-execution-runner",
      rawSecretsReturned: false,
    };
  }
  const generation = await callModelGenerateText({
    provider: candidate.provider,
    model: candidate.model,
    prompt,
    systemPrompt,
    temperature: 0.2,
    maxTokens,
    timeoutMs: options.modelTimeoutMs ?? options.runtimeToolTimeoutMs ?? 600000,
    mockResponse,
    ...(candidate.provider === "mock" ? {} : { modelRoute: routePlan }),
  }, paths, options, executionProfile);
  await hooks.onStep?.("model_text_generated", generation.status === "completed" ? "completed" : String(generation.status ?? "blocked"), {
    provider: candidate.provider,
    model: candidate.model,
    executionProfile,
    reason: generation.reason ?? null,
  });
  if (generation.status !== "completed") {
    return {
      status: "blocked",
      output: directOutput("blocked", "模型生成回复失败，可重试。", generation, [
        { kind: "model-route", name: "model-route.json", localPath: modelRoutePath(paths) },
      ], executionProfile),
      mode: "task-execution-runner",
      rawSecretsReturned: false,
    };
  }
  return {
    status: "completed",
    content: generation.content,
    generation,
    routePlan,
    candidate,
  };
}

/** @param {string} summary @param {UnknownRecord} [details] @returns {PipelineOutput} */
function blockedOutput(summary, details = {}) {
  return {
    status: "blocked",
    summary,
    finalFailureReport: details?.finalFailureReport ?? null,
    documents: [],
    qaGate: { status: "blocked", publishAllowed: false, issues: [details.reason ?? "blocked"] },
    policyGate: { status: "pass", actionIntent: "draft", reasons: ["task_execution_runner_blocked_before_publish"] },
    artifacts: [],
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
    details: asRecord(sanitize(details)),
  };
}

/** @param {RunnerPaths} paths */
function publicSourceArtifacts(paths) {
  return [
    existsSync(publicSourceResolutionPath(paths.artifactsDir)) ? { kind: "public-source-resolution", name: "source-resolution.json", localPath: publicSourceResolutionPath(paths.artifactsDir) } : null,
    existsSync(publicSourceMetadataPath(paths.artifactsDir)) ? { kind: "public-source-metadata", name: "source-metadata.json", localPath: publicSourceMetadataPath(paths.artifactsDir) } : null,
    existsSync(transcriptPath(paths.artifactsDir)) ? { kind: "public-source-transcript", name: "transcript.full.json", localPath: transcriptPath(paths.artifactsDir) } : null,
    existsSync(join(paths.artifactsDir, "transcripts", "transcript.readable.md")) ? { kind: "public-source-readable-transcript", name: "transcript.readable.md", localPath: join(paths.artifactsDir, "transcripts", "transcript.readable.md") } : null,
    existsSync(publicSourceProvenancePath(paths.artifactsDir)) ? { kind: "public-source-provenance", name: "evidence-index.json", localPath: publicSourceProvenancePath(paths.artifactsDir) } : null,
    existsSync(publicSourcePackPath(paths.artifactsDir)) ? { kind: "knowledge-source-pack", name: "source-pack.json", localPath: publicSourcePackPath(paths.artifactsDir) } : null,
    existsSync(publicSourcePackReadablePath(paths.artifactsDir)) ? { kind: "knowledge-source-pack-readable", name: "source-pack.readable.md", localPath: publicSourcePackReadablePath(paths.artifactsDir) } : null,
    existsSync(join(paths.runDir, "qa-gate.json")) ? { kind: "qa-gate", name: "qa-gate.json", localPath: join(paths.runDir, "qa-gate.json") } : null,
    existsSync(join(paths.runDir, "policy-gate.json")) ? { kind: "policy-gate", name: "policy-gate.json", localPath: join(paths.runDir, "policy-gate.json") } : null,
  ].filter(Boolean);
}

/** @param {RunnerTask} task @param {RunnerPaths} paths @param {RunnerOptions} [options] @param {UnknownRecord} [profileConfig] @returns {Promise<PipelineRun>} */
async function runUrlSourcePackPipeline(task, paths, options = {}, profileConfig = {}) {
  const hooks = runnerHooks(options);
  const executionProfile = "url_source_pack";
  const outputRoot = dirname(paths.runDir);
  const sourcePreparation = asRecord(task.taskIntent.sourcePreparation);
  const urls = uniqueStrings([
    ...asArray(sourcePreparation.publicUrls),
    ...extractPublicUrls(task.sourceEvent?.message?.text ?? ""),
  ], 4);
  const sourceUrl = urls[0] ?? null;
  /** @type {UnknownRecord | null} */
  let activeLedger = null;
  /** @type {UnknownRecord | null} */
  let externalWebPolicy = null;

  /** @type {(summary: string, reason: string, stepId: string | null, details?: UnknownRecord) => Promise<PipelineRun>} */
  const finishBlocked = async (summary, reason, stepId, details = {}) => {
    if (activeLedger && stepId) {
      const reconciled = await callRuntimeTool("execution_ledger_reconcile", {
        runId: task.runId,
        outputRoot,
        expectedRevision: activeLedger.revision,
        operationId: `public-source-blocked:${stepId}:${reason}`,
        actor: "task-execution-runner",
        stepUpdates: [{ stepId, status: "blocked", blockedReason: reason }],
        interactionAdditions: [{
          kind: "question",
          label: summary,
          description: typeof details.recovery === "string" ? details.recovery : "修复来源、网络或配置后可重试同一 URL。",
          priority: "high",
          options: ["retry-public-url", "provide-alternate-public-url"],
          blocks: [stepId],
        }],
      }, paths, options);
      if (reconciled?.schemaVersion === "adaptive-execution-ledger-v1") activeLedger = reconciled;
    }
    const output = blockedOutput(summary, {
      reason,
      ...details,
      todo: activeLedger?.userTodoProjection ?? null,
      interactionItems: activeLedger?.interactionItems ?? [],
    });
    output.executionProfile = executionProfile;
    output.artifacts = publicSourceArtifacts(paths);
    if (externalWebPolicy) output.policyGate = externalWebPolicy;
    if (details.qaGate) output.qaGate = asRecord(details.qaGate);
    if (details.policyGate) output.policyGate = asRecord(details.policyGate);
    writeJson(paths.agentOutputPath, output);
    await hooks.onStep?.("task_execution_runner_completed", "blocked", { artifact: paths.agentOutputPath, executionProfile, reason });
    return createPipelineRun("blocked", output);
  };

  /** @param {string} operationId @param {UnknownRecord[]} stepUpdates @param {UnknownRecord[]} [interactionAdditions] */
  const transition = async (operationId, stepUpdates, interactionAdditions = []) => {
    const reconciled = await callRuntimeTool("execution_ledger_reconcile", {
      runId: task.runId,
      outputRoot,
      expectedRevision: activeLedger?.revision ?? 0,
      operationId,
      actor: "task-execution-runner",
      stepUpdates,
      interactionAdditions,
    }, paths, options);
    if (reconciled?.schemaVersion === "adaptive-execution-ledger-v1") activeLedger = reconciled;
    return reconciled;
  };

  try {
    await hooks.onStep?.("task_execution_runner_started", "running", { taskType: task.taskIntent?.taskType, executionProfile, runnerRole: "profile_dispatch" });
    if (!sourceUrl) return await finishBlocked("没有检测到可处理的公开 URL。", "public_url_missing", null);

    const planner = await callRuntimeTool("planner_envelope_plan", {
      runId: task.runId,
      goal: "解析用户提供的公开音视频来源，优先取得官方文稿，否则使用云端 ASR，并生成可交接的知识 source pack。",
      taskType: "knowledge_source",
      taskDescription: "公开 URL 知识来源处理",
      requestedOutputs: [],
      availableArtifacts: [],
      successCriteria: ["来源解析完整", "完整带时间戳转写可用", "source pack 所有判断可追溯", "部分结果不冒充完整知识"],
      constraints: ["不绕过登录、付费墙、DRM、地区限制或平台访问控制", "不使用 Cookie 或 Authorization", "长媒体只分章分析转写证据"],
    }, paths, options);
    if (planner.status === "blocked") return await finishBlocked("公开 URL 任务计划未通过。", String(planner.reason ?? "public_url_plan_blocked"), null, planner);
    await callRuntimeTool("planner_envelope_write", { runId: task.runId, envelope: planner, outputRoot }, paths, options);
    activeLedger = planner;
    await transition("public-source-resolution-started", [{ stepId: "resolve-public-url", status: "in_progress" }]);
    externalWebPolicy = await callRuntimeTool("policy_gate_check", {
      actionIntent: "external_web",
      capabilityId: "public-url-source",
      audience: "explicit_public_source",
      payloadClass: "public_media_source",
      riskLevel: "medium",
      artifacts: [sanitizeUrlForArtifact(sourceUrl)],
      externalWebAllowed: true,
      sourceRecordRequired: true,
      containsSecrets: false,
      rawMediaExternalUpload: false,
      rawTranscriptIncluded: false,
      channel: task.sourceEvent?.eventType?.startsWith("im.") ? "feishu" : "local",
      feishuInbound: task.sourceEvent?.eventType?.startsWith("im."),
      explicitUserRequest: true,
      userRequestedAction: true,
      destructiveAction: false,
      targetSpecified: true,
    }, paths, options);
    await callRuntimeTool("policy_gate_write", { runId: task.runId, decision: externalWebPolicy, outputRoot }, paths, options);
    await hooks.onStep?.("policy_gate_completed", externalWebPolicy.status === "pass" ? "completed" : String(externalWebPolicy.status ?? "blocked"), { artifact: join(paths.runDir, "policy-gate.json"), status: externalWebPolicy.status, actionIntent: "external_web" });
    if (externalWebPolicy.status !== "pass") {
      return await finishBlocked("公开 URL 获取未通过外部访问边界检查。", "public_url_policy_gate_not_passed", "resolve-public-url", { policyGate: externalWebPolicy, recovery: externalWebPolicy.safeAlternative ?? "请确认来源 URL 与访问范围后重试。" });
    }
    await hooks.progressReply?.("正在安全解析公开 URL。", "public_url_resolving");
    await hooks.onStep?.("public_url_resolving", "running", { url: sanitizeUrlForArtifact(sourceUrl) });

    const sourceResolver = options.publicUrlResolver ?? resolvePublicMediaSource;
    const rawResolution = await sourceResolver(sourceUrl, {
      ...options,
      resolveOnly: options.publicUrlResolveOnly === true,
      inputDir: paths.inputsDir,
      ...(typeof options.publicUrlMaxPageBytes === "number" ? { maxPageBytes: options.publicUrlMaxPageBytes } : {}),
      ...(typeof options.publicUrlMaxTranscriptBytes === "number" ? { maxTranscriptBytes: options.publicUrlMaxTranscriptBytes } : {}),
      ...(typeof options.publicUrlMaxMediaBytes === "number" ? { maxMediaBytes: options.publicUrlMaxMediaBytes } : {}),
      ...(typeof options.publicUrlMaxDurationSec === "number" ? { maxDurationSec: options.publicUrlMaxDurationSec } : {}),
      ...(typeof options.publicUrlTimeoutMs === "number" ? { timeoutMs: options.publicUrlTimeoutMs } : {}),
      ...(typeof options.publicUrlMediaTimeoutMs === "number" ? { mediaTimeoutMs: options.publicUrlMediaTimeoutMs } : {}),
      ...(typeof options.ytDlpBin === "string" ? { ytDlpBin: options.ytDlpBin } : {}),
    });
    const resolution = asRecord(rawResolution);
    const rawSource = asRecord(resolution.source);
    const source = {
      originalUrl: rawSource.originalUrl,
      finalSourceUrl: rawSource.finalSourceUrl,
      platform: rawSource.platform,
      title: rawSource.title,
      author: rawSource.author,
      program: rawSource.program,
      publishedAt: rawSource.publishedAt,
      durationSec: rawSource.durationSec,
      language: rawSource.language,
      acquisitionMethod: rawSource.acquisitionMethod,
      processedAt: rawSource.processedAt,
      chapters: rawSource.chapters,
    };
    const media = asRecord(resolution.media);
    const sourceTranscript = asRecord(resolution.transcript);
    const fallback = asRecord(resolution.fallback);
    writeJson(publicSourceResolutionPath(paths.artifactsDir), resolutionArtifactView(rawResolution));
    if (resolution.status !== "resolved") {
      await hooks.onStep?.("public_url_resolving", "blocked", { reason: resolution.reason, artifact: publicSourceResolutionPath(paths.artifactsDir) });
      return await finishBlocked("公开来源解析失败，未生成不完整知识包。", String(resolution.reason ?? "public_url_resolution_failed"), "resolve-public-url", resolution);
    }
    writeJson(publicSourceMetadataPath(paths.artifactsDir), { schemaVersion: "public-source-metadata-v1", ...source, rawSecretsReturned: false });
    await transition("public-source-resolution-completed", [{ stepId: "resolve-public-url", status: "completed", resultRefs: [workspaceRelative(publicSourceResolutionPath(paths.artifactsDir)), workspaceRelative(publicSourceMetadataPath(paths.artifactsDir))], acceptancePassed: true }]);
    await hooks.onStep?.("public_url_resolving", "completed", { platform: source.platform, title: source.title, artifact: publicSourceResolutionPath(paths.artifactsDir) });

    await transition("public-source-acquisition-started", [{ stepId: "acquire-source-content", status: "in_progress" }]);
    const acquisitionRefs = [workspaceRelative(publicSourceMetadataPath(paths.artifactsDir))];
    if (typeof media.localPath === "string") acquisitionRefs.push(workspaceRelative(media.localPath));
    await transition("public-source-acquisition-completed", [{ stepId: "acquire-source-content", status: "completed", resultRefs: acquisitionRefs, acceptancePassed: true }]);

    if (options.publicUrlResolveOnly === true) {
      await transition("public-source-resolve-only-transcription-skipped", [{ stepId: "transcribe-source-media", status: "skipped" }]);
      await transition("public-source-resolve-only-analysis-skipped", [{ stepId: "analyze-source-content", status: "skipped" }]);
      await transition("public-source-resolve-only-verification-skipped", [{ stepId: "verify-source-pack", status: "skipped" }]);
      const output = directOutput("completed", `已解析公开来源：${source.title ?? source.platform}。当前为 resolve-only，未下载媒体、未启动 ASR、未生成 source pack。`, {
        source,
        sourceResolutionPath: workspaceRelative(publicSourceResolutionPath(paths.artifactsDir)),
        sourcePackPath: null,
        fallbackRequired: fallback.required === true,
        todo: activeLedger.userTodoProjection,
      }, publicSourceArtifacts(paths), executionProfile);
      writeJson(paths.agentOutputPath, output);
      await hooks.onStep?.("task_execution_runner_completed", "completed", { artifact: paths.agentOutputPath, executionProfile, resolveOnly: true });
      return createPipelineRun("completed", output);
    }

    /** @type {{ fullPath: string, readablePath: string, summaryPath: string, summary: unknown, segments?: SourceSegment[] }} */
    let transcriptInfo;
    let transcriptMethod = "official_transcript";
    /** @type {SourceSegment[]} */
    let normalizedSegments = [];
    if (sourceTranscript.status === "completed") {
      transcriptInfo = writeOfficialTranscriptArtifacts({ outputDir: paths.artifactsDir, runId: task.runId, source, transcript: sourceTranscript });
      transcriptMethod = String(sourceTranscript.origin ?? "official_transcript");
      normalizedSegments = transcriptInfo.segments ?? [];
      await transition("public-source-transcription-official", [{ stepId: "transcribe-source-media", status: "skipped", resultRefs: [workspaceRelative(transcriptInfo.fullPath)] }]);
      await hooks.progressReply?.("已取得官方带时间戳文稿，正在分章整理。", "public_source_official_transcript");
    } else {
      if (typeof media.localPath !== "string" || !existsSync(media.localPath)) {
        return await finishBlocked("来源没有可靠官方文稿，也未能取得可转写媒体。", "public_source_media_missing_for_asr", "transcribe-source-media", resolution);
      }
      await transition("public-source-cloud-asr-started", [{ stepId: "transcribe-source-media", status: "in_progress" }]);
      const mediaName = basename(media.localPath);
      const mediaTask = {
        ...task,
        attachments: [{
          resourceType: /video\//i.test(String(media.contentType ?? "")) || cloudAsrMediaKind(media.localPath) === "video" ? "video" : "audio",
          name: mediaName,
          localPath: media.localPath,
          ...(typeof media.sha256 === "string" ? { sha256: media.sha256 } : {}),
          sizeBytes: Number(media.sizeBytes ?? statSync(media.localPath).size),
          sourceKind: "public_url_media",
        }],
      };
      const asr = await ensureAsrTranscription(mediaTask, paths, {
        ...options,
        asrProvider: "aliyun_dashscope_paraformer",
        asrFallbackProvider: "none",
      }, hooks);
      if (asr.status !== "completed") {
        const reason = "reason" in asr ? asr.reason : null;
        return await finishBlocked(userMessageForAsrFailure(asr), reason ?? "public_source_cloud_asr_failed", "transcribe-source-media", asr);
      }
      const fullTranscript = loadJson(transcriptPath(paths.artifactsDir));
      transcriptMethod = "aliyun_dashscope_paraformer";
      normalizedSegments = normalizeSourceSegments(fullTranscript, {
        originType: transcriptMethod,
        sourceUrl: source.finalSourceUrl,
        language: source.language,
      });
      transcriptInfo = {
        fullPath: transcriptPath(paths.artifactsDir),
        readablePath: join(paths.artifactsDir, "transcripts", "transcript.readable.md"),
        summaryPath: asrSummaryPath(paths.artifactsDir),
        summary: completeAsrSummary(paths.artifactsDir),
      };
      await transition("public-source-cloud-asr-completed", [{ stepId: "transcribe-source-media", status: "completed", resultRefs: [workspaceRelative(transcriptInfo.fullPath), workspaceRelative(transcriptInfo.summaryPath)], acceptancePassed: true }]);
    }

    if (!normalizedSegments?.length) return await finishBlocked("完整转写没有可用的时间戳片段。", "public_source_timestamped_transcript_missing", "transcribe-source-media");
    const provenance = buildProvenanceIndex(source, normalizedSegments, transcriptMethod);
    writeJson(publicSourceProvenancePath(paths.artifactsDir), provenance);
    await transition("public-source-analysis-started", [{ stepId: "analyze-source-content", status: "in_progress" }]);
    await hooks.progressReply?.("完整转写已就绪，正在按时间章节分析，不会把长转写整体重复发送给模型。", "public_source_chapter_analysis");

    const chapters = partitionSourceSegments(normalizedSegments, {
      maxChapterDurationMs: options.publicUrlChapterDurationMs,
      maxChapterChars: options.publicUrlChapterChars,
      chapterMarkers: source.chapters,
    });
    if (chapters.length === 0) return await finishBlocked("完整转写无法形成可分析章节。", "public_source_chapters_missing", "analyze-source-content");
    const oversizedChapter = chapters.find((chapter) => chapter.bounded === false);
    if (oversizedChapter) {
      return await finishBlocked("来源存在超出单章上下文上限的异常长片段，未直接发送给模型。", "public_source_chapter_size_limit_exceeded", "analyze-source-content", { chapterId: oversizedChapter.chapterId, charCount: oversizedChapter.charCount });
    }
    const { routePlan, candidate } = await planFastDraftRoute(task, paths, options, hooks, executionProfile, profileConfig);
    if (routePlan.status !== "selected" || !candidate || typeof candidate.provider !== "string" || typeof candidate.model !== "string") return await finishBlocked("当前没有可用模型分析来源转写。", "public_source_model_unavailable", "analyze-source-content", routePlan);
    /** @type {Array<ChapterAnalysis & UnknownRecord>} */
    const chapterAnalyses = [];
    for (const chapter of chapters) {
      const chapterPath = join(publicSourcePackDir(paths.artifactsDir), "chapters", `${chapter.chapterId}.json`);
      const reusable = reusableSourceChapterAnalysis(chapterPath, chapter);
      if (reusable) {
        chapterAnalyses.push(/** @type {ChapterAnalysis & UnknownRecord} */ (reusable));
        writeJson(chapterPath, reusable);
        await hooks.onStep?.("public_source_chapter_reused", "completed", { chapterId: chapter.chapterId, artifact: chapterPath });
        continue;
      }
      const mockClaim = chapter.segments[0];
      const analysisAttempts = [];
      /** @type {ChapterAnalysis | null} */
      let normalized = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const generation = await callModelGenerateText({
          provider: candidate.provider,
          model: candidate.model,
          prompt: buildSourceChapterPrompt(chapter, source, { maxClaims: attempt === 1 ? 12 : 8 }),
          systemPrompt: "你是知识来源分析器。只输出严格 JSON 对象；每个判断必须引用当前章节给出的 segmentId。",
          temperature: attempt === 1 ? 0.1 : 0,
          maxTokens: Number(options.publicUrlChapterMaxTokens ?? 2400),
          thinkingMode: "disabled",
          responseFormat: "json_object",
          timeoutMs: options.modelTimeoutMs ?? options.runtimeToolTimeoutMs ?? 600000,
          mockResponse: JSON.stringify({ chapterTitle: `第 ${chapter.order} 章`, summary: mockClaim?.text ?? "测试章节", claims: [{ claimType: "author_view", text: mockClaim?.text ?? "测试观点", evidenceSegmentIds: [mockClaim?.segmentId], confidence: "medium" }], suggestedRelatedTopics: [source.program ?? source.title ?? "公开来源"] }),
          ...(candidate.provider === "mock" ? {} : { modelRoute: routePlan }),
        }, paths, options, executionProfile);
        normalized = generation.status === "completed"
          ? normalizeSourceChapterAnalysis(generation.content, chapter)
          : { status: "blocked", reason: String(generation.reason ?? "source_chapter_generation_failed"), chapterId: chapter.chapterId };
        const normalizedRecord = asRecord(normalized);
        analysisAttempts.push({
          attempt,
          status: normalizedRecord.status,
          reason: normalizedRecord.reason ?? null,
          provider: generation.provider ?? candidate.provider,
          model: generation.model ?? candidate.model,
          usage: generation.usage ?? null,
          finishReason: generation.finishReason ?? null,
        });
        if (normalizedRecord.status === "completed") break;
        if (attempt < 2) await hooks.onStep?.("public_source_chapter_retry", "running", { chapterId: chapter.chapterId, reason: normalizedRecord.reason });
      }
      if (!normalized) normalized = { status: "blocked", reason: "source_chapter_generation_missing", chapterId: chapter.chapterId };
      /** @type {ChapterAnalysis & UnknownRecord} */
      const persistedAnalysis = {
        ...normalized,
        evidenceHash: sourceChapterEvidenceHash(chapter),
        analysisAttempts,
      };
      chapterAnalyses.push(persistedAnalysis);
      writeJson(chapterPath, persistedAnalysis);
      if (persistedAnalysis.status !== "completed") break;
    }

    const sourceForPack = {
      ...source,
      acquisitionMethod: transcriptMethod === "aliyun_dashscope_paraformer"
        ? `${source.acquisitionMethod}+cloud_asr`
        : source.acquisitionMethod,
    };
    writeJson(publicSourceMetadataPath(paths.artifactsDir), { schemaVersion: "public-source-metadata-v1", ...sourceForPack, rawSecretsReturned: false });
    const asrSummary = asRecord(transcriptInfo.summary);
    const speakerDiarization = asRecord(asrSummary.speakerDiarization);
    const singleMixSummary = asRecord(asrSummary.singleMix ?? speakerDiarization.singleMix);
    const highSeverityReviewItemCount = Number(singleMixSummary.highSeverityCount ?? 0);
    const reviewItemCount = Number(singleMixSummary.reviewItemCount ?? 0);
    const transcriptQuality = transcriptMethod === "aliyun_dashscope_paraformer"
      ? {
          status: asrSummary?.status ?? "complete",
          partial: asrSummary?.partial === true,
          failedChunks: Number(asrSummary?.failedChunks ?? 0),
          diarizationEnabled: speakerDiarization.enabled === true,
          speakerLabelsAvailable: speakerDiarization.speakerLabelsAvailable === true,
          singleMixStatus: Array.isArray(singleMixSummary.statuses) ? singleMixSummary.statuses[0] ?? null : singleMixSummary.status ?? null,
          reviewItemCount,
          highSeverityReviewItemCount,
          reviewRequired: reviewItemCount > 0 || highSeverityReviewItemCount > 0,
          sourceSeparationPerformed: singleMixSummary.sourceSeparationPerformed === true,
        }
      : {
          status: sourceTranscript.quality ?? "official_timestamped",
          partial: false,
          failedChunks: 0,
          reviewRequired: false,
        };
    const pack = buildKnowledgeSourcePack({
      source: sourceForPack,
      transcript: {
        status: "complete",
        quality: transcriptQuality,
        fullTranscriptPath: workspaceRelative(transcriptInfo.fullPath),
        readableTranscriptPath: workspaceRelative(transcriptInfo.readablePath),
      },
      segments: normalizedSegments,
      chapterAnalyses,
      transcriptMethod,
      provenancePath: workspaceRelative(publicSourceProvenancePath(paths.artifactsDir)) ?? "",
    });
    if (pack.status !== "complete") return await finishBlocked("分章分析未完整完成，未把部分结果标记为可交接知识包。", String(asRecord(pack).reason ?? "source_pack_incomplete"), "analyze-source-content", asRecord(pack));
    const qaGate = await callRuntimeTool("qa_gate_evaluate", {
      profile: "source_pack",
      publishIntent: false,
      checks: {
        security: { rawSecretsReturned: false, secretsLeaked: false },
        webAccess: {
          used: true,
          allowed: true,
          sources: [source.finalSourceUrl ?? source.originalUrl].filter(Boolean),
        },
        evidence: {
          missingEvidenceClaims: pack.provenance.allClaimsHaveEvidence ? [] : ["source_pack_claim_without_evidence"],
        },
        sourcePack: {
          required: true,
          completeTranscriptAvailable: pack.quality.completeTranscriptAvailable,
          failedChapterCount: pack.quality.failedChapterCount,
          allClaimsHaveEvidence: pack.provenance.allClaimsHaveEvidence,
          partialResultsPublished: pack.quality.partialResultsPublished,
          qualityDisclosureRequired: pack.quality.transcriptReviewRequired,
          qualityDisclosed: pack.quality.transcriptQualityDisclosed,
          provenancePath: workspaceRelative(publicSourceProvenancePath(paths.artifactsDir)),
        },
      },
    }, paths, options);
    await callRuntimeTool("qa_gate_write", { runId: task.runId, gate: qaGate, outputRoot }, paths, options);
    await hooks.onStep?.("qa_gate_completed", qaGate.status === "pass" ? "completed" : String(qaGate.status ?? "blocked"), { artifact: join(paths.runDir, "qa-gate.json"), status: qaGate.status });
    if (qaGate.status !== "pass") {
      return await finishBlocked("source pack 未通过完整性与证据验收，未生成可交接结果。", "source_pack_qa_not_passed", "analyze-source-content", { qaGate, recovery: "修复缺失转写、章节或 provenance 后重试。" });
    }
    const packClaims = [
      ...pack.explicitFacts,
      ...pack.authorViews,
      ...pack.agentInferences,
      ...pack.controversiesOrRisks,
      ...pack.openQuestions,
    ];
    writeJson(publicSourceProvenancePath(paths.artifactsDir), {
      ...provenance,
      claimCount: packClaims.length,
      claims: packClaims.map((claim) => ({
        claimId: claim.claimId,
        claimType: claim.claimType,
        chapterId: pack.chapters.find((chapter) => chapter.claimIds.includes(claim.claimId))?.chapterId ?? null,
        evidenceSegmentIds: claim.evidenceSegmentIds,
        transcriptOrigin: transcriptMethod,
      })),
    });
    writeJson(publicSourcePackPath(paths.artifactsDir), pack);
    writeText(publicSourcePackReadablePath(paths.artifactsDir), renderKnowledgeSourcePack(pack));
    await transition("public-source-analysis-completed", [{ stepId: "analyze-source-content", status: "completed", resultRefs: [workspaceRelative(publicSourcePackPath(paths.artifactsDir)), workspaceRelative(publicSourcePackReadablePath(paths.artifactsDir))], acceptancePassed: true }]);
    await transition("public-source-verification-completed", [{ stepId: "verify-source-pack", status: "completed", resultRefs: [workspaceRelative(publicSourceProvenancePath(paths.artifactsDir)), workspaceRelative(publicSourcePackPath(paths.artifactsDir))], acceptancePassed: pack.provenance.allClaimsHaveEvidence && pack.quality.failedChapterCount === 0 }], [{
      kind: "suggestion",
      label: "选择 source pack 的下一步",
      description: "可先在当前对话审阅交接包，或仅保留本地文件，之后再由知识库 Agent 决定是否入库。",
      priority: "medium",
      options: ["review-source-pack", "keep-source-pack-local"],
    }]);

    const keyPointPreview = pack.keyPoints.slice(0, 3).map((claim) => `- ${claim.text}`).join("\n");

    const output = {
      status: "completed",
      executionProfile,
      summary: [`已完成公开来源解析与知识整理：${sourceForPack.title ?? sourceForPack.platform}。共 ${pack.chapters.length} 章、${normalizedSegments.length} 个时间戳片段；source pack 已生成，但未写入任何外部知识库。`, keyPointPreview ? `关键观点预览：\n${keyPointPreview}` : ""].filter(Boolean).join("\n"),
      documents: [],
      artifacts: publicSourceArtifacts(paths),
      qaGate,
      policyGate: externalWebPolicy,
      details: {
        source: sourceForPack,
        sourcePackPath: workspaceRelative(publicSourcePackPath(paths.artifactsDir)),
        readableSourcePackPath: workspaceRelative(publicSourcePackReadablePath(paths.artifactsDir)),
        provenancePath: workspaceRelative(publicSourceProvenancePath(paths.artifactsDir)),
        transcriptMethod,
        transcriptSegmentCount: normalizedSegments.length,
        chapterCount: pack.chapters.length,
        todo: activeLedger?.userTodoProjection ?? null,
        interactionItems: activeLedger?.interactionItems ?? [],
        knowledgeBaseWritePerformed: false,
      },
      rawSecretsReturned: false,
      rawMediaExternalUpload: transcriptMethod === "aliyun_dashscope_paraformer",
    };
    writeJson(paths.agentOutputPath, output);
    await hooks.onStep?.("public_source_pack_generated", "completed", { artifact: publicSourcePackPath(paths.artifactsDir), chapterCount: pack.chapters.length, transcriptMethod });
    await hooks.onStep?.("task_execution_runner_completed", "completed", { artifact: paths.agentOutputPath, executionProfile });
    return createPipelineRun("completed", /** @type {PipelineOutput} */ (output));
  } catch (error) {
    return await finishBlocked("公开来源处理失败，可修复后重试。", "public_url_source_pipeline_failed", activeLedger ? String(asArray(activeLedger.currentStepIds)[0] ?? "") || null : null, { error: error instanceof Error ? error.message : String(error) });
  }
}

/** @param {unknown} taskValue @param {RunnerPaths} paths @param {RunnerOptions} [options] @returns {Promise<PipelineRun>} */
export async function runTaskExecutionPipeline(taskValue, paths, options = {}) {
  /** @type {RunnerTask} */
  let task;
  try {
    task = /** @type {RunnerTask} */ (assertFeishuTask(taskValue));
  } catch (error) {
    const output = directOutput("blocked", "任务输入不完整，无法安全启动执行。", {
      reason: "task_contract_invalid",
      fieldPath: "task",
      recovery: "请通过飞书入口或本地 URL CLI 重新提交任务。",
      error: error instanceof Error ? error.message : String(error),
    }, [], "unknown");
    writeJson(paths.agentOutputPath, output);
    return createPipelineRun("blocked", output);
  }
  const profile = executionProfileForTask(task);
  const executionProfile = profile?.id ?? "unknown";
  const profileConfig = profile?.config ?? {};
  if (executionProfile === "fast_answer") return runFastAnswerPipeline(task, paths, options, profileConfig);
  if (executionProfile === "file_summary") return runFileSummaryPipeline(task, paths, options, profileConfig);
  if (executionProfile === "url_source_pack") return runUrlSourcePackPipeline(task, paths, options, profileConfig);
  if (FULL_DOCUMENT_EXECUTION_PROFILES.has(executionProfile)) return runFullDocumentPipeline(task, paths, options, profileConfig);

  const output = directOutput("blocked", "当前执行 profile 不支持任务执行 Runner。", {
    reason: "execution_profile_not_runner_eligible",
    executionProfile,
  }, [], executionProfile);
  writeJson(paths.agentOutputPath, output);
  return createPipelineRun("blocked", output);
}

/** @param {RunnerTask} task @param {RunnerPaths} paths @param {RunnerOptions} [options] @param {UnknownRecord} [profileConfig] @returns {Promise<PipelineRun>} */
async function runFastAnswerPipeline(task, paths, options = {}, profileConfig = {}) {
  const hooks = runnerHooks(options);
  const executionProfile = "fast_answer";
  try {
    await hooks.onStep?.("task_execution_runner_started", "running", {
      taskType: task.taskIntent?.taskType,
      executionProfile,
      runnerRole: "profile_dispatch",
    });
    const generated = await generateDirectReply({
      task,
      paths,
      options,
      hooks,
      executionProfile,
      profileConfig,
      prompt: directUserPrompt(task),
      systemPrompt: directSystemPrompt(executionProfile),
      maxTokens: Number(options.fastAnswerMaxTokens ?? process.env.FEISHU_AGENT_FAST_ANSWER_MAX_TOKENS ?? 900),
      mockResponse: "这是 mock fast_answer 回复。",
    });
    if (generated.output) {
      writeJson(paths.agentOutputPath, generated.output);
      await hooks.onStep?.("task_execution_runner_completed", "blocked", { artifact: paths.agentOutputPath, executionProfile });
      return createPipelineRun(String(generated.status ?? "blocked"), generated.output);
    }
    const output = directOutput("completed", cleanGeneratedText(generated.content, "已生成回复。"), {
      provider: generated.candidate.provider,
      model: generated.candidate.model,
      usage: generated.generation.usage ?? null,
    }, [
      { kind: "model-route", name: "model-route.json", localPath: modelRoutePath(paths) },
    ], executionProfile);
    writeJson(paths.agentOutputPath, output);
    await hooks.onStep?.("fast_answer_generated", "completed", { artifact: paths.agentOutputPath });
    await hooks.onStep?.("task_execution_runner_completed", "completed", { artifact: paths.agentOutputPath, executionProfile });
    return createPipelineRun("completed", output);
  } catch (error) {
    const output = directOutput("failed", "任务处理失败，可重试。", {
      reason: "fast_answer_runner_failed",
      error: error instanceof Error ? error.message : String(error),
    }, [], executionProfile);
    writeJson(paths.agentOutputPath, output);
    await hooks.onStep?.("task_execution_runner_completed", "failed", { artifact: paths.agentOutputPath, reason: "fast_answer_runner_failed", executionProfile });
    return createPipelineRun("failed", output);
  }
}

/** @param {RunnerTask} task @param {RunnerPaths} paths @param {RunnerOptions} [options] @param {UnknownRecord} [profileConfig] @returns {Promise<PipelineRun>} */
async function runFileSummaryPipeline(task, paths, options = {}, profileConfig = {}) {
  const hooks = runnerHooks(options);
  const executionProfile = "file_summary";
  try {
    await hooks.onStep?.("task_execution_runner_started", "running", {
      taskType: task.taskIntent?.taskType,
      executionProfile,
      runnerRole: "profile_dispatch",
    });
    const fileContext = buildFileSummaryContext(task, paths, profileConfig);
    await hooks.onStep?.("file_summary_context_built", fileContext.sourceCount > 0 ? "completed" : "blocked", {
      artifact: fileSummaryContextPath(paths.artifactsDir),
      sourceCount: fileContext.sourceCount,
      rawMediaExternalUpload: false,
    });
    if (fileContext.sourceCount === 0) {
      const output = directOutput("blocked", "当前没有可读取的文件内容可总结。", {
        reason: "file_summary_context_missing",
      }, [
        { kind: "file-summary-context", name: "file-summary-context.json", localPath: fileSummaryContextPath(paths.artifactsDir) },
      ], executionProfile);
      writeJson(paths.agentOutputPath, output);
      await hooks.onStep?.("task_execution_runner_completed", "blocked", { artifact: paths.agentOutputPath, executionProfile });
      return createPipelineRun("blocked", output);
    }
    const generated = await generateDirectReply({
      task,
      paths,
      options,
      hooks,
      executionProfile,
      profileConfig,
      prompt: renderFileSummaryPrompt(task, fileContext),
      systemPrompt: directSystemPrompt(executionProfile),
      maxTokens: Number(options.fileSummaryMaxTokens ?? process.env.FEISHU_AGENT_FILE_SUMMARY_MAX_TOKENS ?? 1600),
      mockResponse: "这是 mock file_summary 总结。",
    });
    if (generated.output) {
      generated.output.artifacts = [
        { kind: "file-summary-context", name: "file-summary-context.json", localPath: fileSummaryContextPath(paths.artifactsDir) },
        ...(generated.output.artifacts ?? []),
      ];
      writeJson(paths.agentOutputPath, generated.output);
      await hooks.onStep?.("task_execution_runner_completed", "blocked", { artifact: paths.agentOutputPath, executionProfile });
      return createPipelineRun(String(generated.status ?? "blocked"), generated.output);
    }
    const output = directOutput("completed", cleanGeneratedText(generated.content, "已生成文件总结。"), {
      provider: generated.candidate.provider,
      model: generated.candidate.model,
      usage: generated.generation.usage ?? null,
      sourceCount: fileContext.sourceCount,
    }, [
      { kind: "file-summary-context", name: "file-summary-context.json", localPath: fileSummaryContextPath(paths.artifactsDir) },
      { kind: "model-route", name: "model-route.json", localPath: modelRoutePath(paths) },
    ], executionProfile);
    writeJson(paths.agentOutputPath, output);
    await hooks.onStep?.("file_summary_generated", "completed", { artifact: paths.agentOutputPath, sourceCount: fileContext.sourceCount });
    await hooks.onStep?.("task_execution_runner_completed", "completed", { artifact: paths.agentOutputPath, executionProfile });
    return createPipelineRun("completed", output);
  } catch (error) {
    const output = directOutput("failed", "任务处理失败，可重试。", {
      reason: "file_summary_runner_failed",
      error: error instanceof Error ? error.message : String(error),
    }, [], executionProfile);
    writeJson(paths.agentOutputPath, output);
    await hooks.onStep?.("task_execution_runner_completed", "failed", { artifact: paths.agentOutputPath, reason: "file_summary_runner_failed", executionProfile });
    return createPipelineRun("failed", output);
  }
}

/** @param {RunnerTask} task @param {RunnerPaths} paths @param {RunnerOptions} [options] @param {UnknownRecord} [profileConfig] @returns {Promise<PipelineRun>} */
async function runFullDocumentPipeline(task, paths, options = {}, profileConfig = {}) {
  const hooks = runnerHooks(options);
  const outputRoot = dirname(paths.runDir);
  const executionProfile = executionProfileForTask(task)?.id ?? null;
  try {
    await hooks.onStep?.("task_execution_runner_started", "running", { taskType: task.taskIntent?.taskType, executionProfile, runnerRole: "stage_execution_only" });
    const requestedDocuments = Array.isArray(task.taskIntent?.requestedDocuments) && task.taskIntent.requestedDocuments.length > 0
      ? task.taskIntent.requestedDocuments
      : ["meeting-minutes"];
    const requiresLocalAsr = task.taskIntent?.requiresAsr === true || task.taskIntent?.requiresLocalAsr === true;
    if (requiresLocalAsr) {
      const asr = await ensureAsrTranscription(task, paths, options, hooks);
      if (asr.status !== "completed") {
        const userMessage = "userMessage" in asr ? asr.userMessage : null;
        const output = blockedOutput(userMessage ?? userMessageForAsrFailure(asr), asr);
        writeJson(paths.agentOutputPath, output);
        return createPipelineRun("blocked", output);
      }
    }
    const meetingIntelligence = requestedDocuments.includes("meeting-minutes")
      ? await ensureMeetingIntelligence(task, paths, options, hooks)
      : { status: "skipped", reason: "meeting_minutes_not_requested", analysis: null };
    const meetingAnalysis = asRecord(meetingIntelligence.analysis);
    const revisionMode = isDocumentRevisionTask(task);
    const documentQualityMode = String(options.documentQualityMode ?? process.env.FEISHU_AGENT_DOCUMENT_QUALITY_MODE ?? "stable").toLowerCase();
    const workflowSectionsPerBatch = documentQualityMode === "stable" ? 2 : 3;
    const { evidenceSummary, titlePlan, reviewContext, sourceContext } = await buildEvidencePack(task, paths, {
      ...options,
      meetingAnalysis,
      sectionsPerUnit: workflowSectionsPerBatch,
    });
    const contextGate = asRecord(sourceContext.gate);
    await hooks.onStep?.("evidence_pack_built", "completed", {
      artifact: evidencePackPath(paths.artifactsDir),
      sourceCount: evidenceSummary.sourceCount,
      segmentCount: evidenceSummary.segmentCount ?? 0,
      contextManifest: sourceContext?.manifestPath ?? null,
      contextGateStatus: contextGate.status ?? null,
      requestedDocuments,
      operation: revisionMode ? "document_revision" : null,
    });
    if (sourceContext.status === "blocked" || contextGate.status === "blocked") {
      const output = blockedOutput("上下文准备未通过，暂时无法生成文档。", {
        reason: sourceContext.reason ?? contextGate.reason ?? "source_context_blocked",
        contextGate,
        contextManifest: sourceContext.manifestPath ?? null,
      });
      writeJson(paths.agentOutputPath, output);
      return createPipelineRun("blocked", output);
    }
    if (revisionMode) {
      await hooks.onStep?.("review_context_built", "completed", {
        artifact: reviewContextPath(paths.artifactsDir),
        status: reviewContext?.status ?? "missing",
        commentCount: reviewContext?.comments?.length ?? 0,
      });
    }

    const planner = await callRuntimeTool("planner_envelope_plan", {
      runId: task.runId,
      goal: revisionMode ? "基于飞书文档正文和批注/修改上下文修订既有办公文档并发布" : "基于飞书多源上下文生成用户请求的办公文档并发布",
      taskType: task.taskIntent?.taskType ?? "document_pipeline",
      taskDescription: cleanUserPrompt(task.sourceEvent?.message?.text ?? ""),
      requestedOutputs: requestedDocuments,
      availableArtifacts: [
        workspaceRelative(evidencePackPath(paths.artifactsDir)),
        Object.keys(meetingAnalysis).length > 0 ? workspaceRelative(meetingAnalysisPath(paths.artifactsDir)) : null,
        Object.keys(meetingAnalysis).length > 0 ? workspaceRelative(topicMapPath(paths.artifactsDir)) : null,
        Object.keys(meetingAnalysis).length > 0 ? workspaceRelative(internalEvidenceMapPath(paths.artifactsDir)) : null,
        Object.keys(meetingAnalysis).length > 0 ? workspaceRelative(agenticOrchestrationPath(paths.artifactsDir)) : null,
        Object.keys(meetingAnalysis).length > 0 ? workspaceRelative(agenticOrchestrationResultPath(paths.artifactsDir)) : null,
        revisionMode ? workspaceRelative(reviewContextPath(paths.artifactsDir)) : null,
        existsSync(transcriptPath(paths.artifactsDir)) ? workspaceRelative(transcriptPath(paths.artifactsDir)) : null,
        existsSync(evidenceIndexPath(paths.artifactsDir)) ? workspaceRelative(evidenceIndexPath(paths.artifactsDir)) : null,
      ].filter(Boolean),
      successCriteria: revisionMode
        ? ["批注/修改意图被覆盖", "修订后文档完整输出", "QA Gate 通过", "Policy Gate 通过", "最终发布/回复"]
        : ["请求文档生成", "QA Gate 通过", "Policy Gate 通过", "最终发布/回复"],
      constraints: ["凭证、Token、Cookie 和 Authorization 不得进入模型或日志", "模型选择必须走 Model Router", "会议结构由 Meeting Intelligence 与当前证据决定", "多源冲突按来源标注并列入待确认", "document_revision 只能作为 prompt overlay 和 review-context，不得新增第二编排层"],
      meetingAnalysis: Object.keys(meetingAnalysis).length > 0
        ? {
            meetingType: asRecord(meetingAnalysis.meetingProfile).meetingType ?? null,
            topicCount: asArray(meetingAnalysis.topicMap).length,
            participantCount: asRecord(meetingAnalysis.participantResolution).participantCount ?? 0,
            unresolvedParticipantCount: asRecord(meetingAnalysis.participantResolution).unresolvedCount ?? 0,
            complexity: asRecord(meetingAnalysis.agentPlan).meetingComplexity ?? null,
            narrativeMode: asRecord(meetingAnalysis.agentPlan).narrativeMode ?? null,
            reviewStrategy: asRecord(meetingAnalysis.agentPlan).reviewStrategy ?? null,
            orchestrationMode: asRecord(meetingAnalysis.agentPlan).orchestrationMode ?? null,
            specialistCount: asRecord(meetingAnalysis.agentPlan).specialistCount ?? 0,
            suggestedFollowUpDocuments: asArray(asRecord(meetingAnalysis.agentPlan).suggestedFollowUpDocuments),
            productDiscoverySummary: meetingAnalysis.productDiscovery ?? null,
          }
        : null,
    }, paths, options);
    await callRuntimeTool("planner_envelope_write", { runId: task.runId, envelope: planner, outputRoot }, paths, options);
    await hooks.onStep?.("planner_envelope_completed", planner.status === "blocked" ? "blocked" : "completed", { artifact: join(paths.runDir, "planner-envelope.json") });
    if (planner.status === "blocked") {
      const output = blockedOutput("任务计划未通过，暂未开始文档生成。", planner);
      writeJson(paths.agentOutputPath, output);
      return createPipelineRun("blocked", output);
    }
    const readyDocumentStepIds = requestedDocuments
      .map((docType) => `generate-${docType}`)
      .filter((stepId) => asArray(planner.steps).map(asRecord).some((step) => step.stepId === stepId && step.status === "ready"));
    const startedLedger = await callRuntimeTool("execution_ledger_reconcile", {
      runId: task.runId,
      outputRoot,
      expectedRevision: planner.revision,
      operationId: "document-generation-started",
      actor: "task-execution-runner",
      stepUpdates: readyDocumentStepIds.map((stepId) => ({ stepId, status: "in_progress" })),
    }, paths, options);
    if (startedLedger.status === "blocked") {
      const output = blockedOutput("任务账本无法进入文档生成步骤。", startedLedger);
      writeJson(paths.agentOutputPath, output);
      return createPipelineRun("blocked", output);
    }
    let activeLedger = startedLedger;

    const primaryDoc = requestedDocuments[0] ?? "document";
    const routeTaskType = primaryDoc === "meeting-minutes" && requestedDocuments.length === 1 ? "meeting_minutes" : "document_shard";
    const routePlan = await callRuntimeTool("model_route_plan", {
      taskType: routeTaskType,
      docType: primaryDoc,
      reasoningDepth: requestedDocuments.some((doc) => ["meeting-minutes", "prd", "tech-architecture", "ops-plan", "customer-requirement-checklist"].includes(doc)) ? "deep" : "fast",
    }, paths, options);
    await callRuntimeTool("model_route_record", { runId: task.runId, route: routePlan, outputRoot }, paths, options);
    const selectedRoute = asRecord(routePlan.selected);
    await hooks.onStep?.("model_route_planned", routePlan.status === "selected" ? "completed" : "blocked", {
      artifact: join(paths.runDir, "model-route.json"),
      selectedProvider: selectedRoute.provider ?? null,
      selectedModel: selectedRoute.model ?? null,
    });
    if (routePlan.status !== "selected") {
      const output = blockedOutput("上下文已准备完成，但当前没有可用模型生成文档。", routePlan);
      writeJson(paths.agentOutputPath, output);
      return createPipelineRun("blocked", output);
    }

    const workItemsResult = await callRuntimeTool("document_prompt_render_batch", {
      documents: requestedDocuments,
      routerConclusion: {
        selectedDocuments: requestedDocuments,
        operation: revisionMode ? "document_revision" : "create_document",
        reasoningDepth: requestedDocuments.some((doc) => ["meeting-minutes", "prd", "tech-architecture", "ops-plan", "customer-requirement-checklist"].includes(doc)) ? "deep" : "fast",
        modelRouteTaskType: routeTaskType,
        selectedModel: selectedRoute,
        reason: revisionMode ? "用户要求基于飞书文档和批注/修改内容修订既有文档；文档类型仍由 prompt registry 映射，revision overlay 只提供修订约束。" : "用户要求基于多源上下文生成指定办公文档；文档类型由 prompt registry 映射。",
      },
      evidenceSummary,
      contextEnvelopeRef: sourceContext.manifestPath,
      workUnits: asArray(sourceContext.workUnits),
      ...(revisionMode ? { operation: "document_revision", reviewContext: evidenceSummary.reviewContext } : {}),
    }, paths, options);
    if (!Array.isArray(workItemsResult.documentWorkItems) || workItemsResult.documentWorkItems.length === 0) {
      const output = blockedOutput("上下文已准备完成，但文档 work item 准备失败。", workItemsResult);
      writeJson(paths.agentOutputPath, output);
      return createPipelineRun("blocked", output);
    }
    await hooks.onStep?.("prompt_registry_rendered", "completed", {
      documents: requestedDocuments,
      promptRegistryPath: workspaceRelative(workItemsResult.promptRegistryPath),
    });

    const retryPolicy = {
      maxAttemptsPerUnit: Number(options.documentWorkerMaxAttemptsPerUnit ?? process.env.FEISHU_AGENT_DOCUMENT_WORKER_MAX_ATTEMPTS_PER_UNIT ?? 3),
      maxRetryUnits: Number(options.documentWorkerMaxRetryUnits ?? process.env.FEISHU_AGENT_DOCUMENT_WORKER_MAX_RETRY_UNITS ?? 12),
    };
    const workerPlan = await callRuntimeTool("document_workers_plan", {
      documentWorkItems: workItemsResult.documentWorkItems,
      maxWorkers: Math.min(3, Math.max(1, requestedDocuments.length)),
      sectionBatching: true,
      sectionsPerBatch: workflowSectionsPerBatch,
    }, paths, options);
    await hooks.onStep?.("document_workers_planned", workerPlan.status === "ready" ? "completed" : "blocked", { tasks: asArray(workerPlan.tasks).length });

    const configuredModelTimeoutMs = optionalPositiveNumber(options.modelTimeoutMs ?? process.env.FEISHU_AGENT_MODEL_TIMEOUT_MS);
    const workerDeadline = documentWorkerDeadlineParams(options);
    const workerToolTimeoutMs = workerDeadline.runtimeBudgetMs + DOCUMENT_WORKER_KILL_MARGIN_MS;
    const workerRun = await callRuntimeTool("document_workers_run", {
      runId: task.runId,
      documentWorkItems: workItemsResult.documentWorkItems,
      maxWorkers: Math.min(3, Math.max(1, requestedDocuments.length)),
      sectionBatching: true,
      sectionsPerBatch: workflowSectionsPerBatch,
      maxRepairAttempts: 1,
      reasoningDepth: requestedDocuments.some((doc) => ["meeting-minutes", "prd", "tech-architecture", "ops-plan", "customer-requirement-checklist"].includes(doc)) ? "deep" : "fast",
      outputRoot,
      mockProvider: options.pipelineMockModel === true || /^(1|true|yes|on)$/i.test(process.env.FEISHU_AGENT_PIPELINE_MOCK_MODEL ?? ""),
      maxTokens: Number(options.meetingMaxTokens ?? process.env.FEISHU_AGENT_MEETING_BATCH_MAX_TOKENS ?? 3500),
      ...(configuredModelTimeoutMs ? { modelTimeoutMs: configuredModelTimeoutMs } : {}),
      captureModelStream: options.captureModelStream !== false,
      qualityMode: documentQualityMode === "balanced" || documentQualityMode === "fast" ? documentQualityMode : "stable",
      workflowStrategy: "checkpointed",
      resumeFromCheckpoint: true,
      publishPartial: false,
      retryPolicy,
      ...workerDeadline,
    }, paths, options, "", { timeoutMs: workerToolTimeoutMs });
    const projectionEvents = asArray(workerRun.projectionEvents).map(asRecord);
    /** @type {UnknownRecord} */
    let projectionReconciliation = projectionEvents.length > 0
      ? { status: "pending", reason: "projection_write_failed", recovery: "从 Adaptive Execution Ledger 重建用户投影。" }
      : { status: "not_required", reason: null, recovery: null };
    if (projectionEvents.length > 0 && activeLedger?.schemaVersion === "adaptive-execution-ledger-v1") {
      const reconciled = await callRuntimeTool("execution_ledger_reconcile", {
        runId: task.runId,
        outputRoot,
        expectedRevision: activeLedger.revision,
        operationId: `document-projection-failure-${activeLedger.revision}`,
        actor: "task-execution-runner",
        eventAdditions: projectionEvents.map((event) => ({
          type: "projection_write_failed",
          actor: event.actor ?? "document-worker-runtime",
          reason: event.reason ?? "projection_write_failed",
          artifactRef: event.artifactRef ?? null,
          recovery: event.recovery ?? "从 Adaptive Execution Ledger 重建用户投影。",
        })),
      }, paths, options);
      if (reconciled?.schemaVersion === "adaptive-execution-ledger-v1") {
        activeLedger = reconciled;
        projectionReconciliation = { status: "recorded_in_ledger", reason: null, recovery: "从 Adaptive Execution Ledger 重建用户投影。" };
      } else {
        projectionReconciliation = {
          status: "needs_recovery",
          reason: String(reconciled.reason ?? "projection_failure_event_reconcile_failed"),
          recovery: "保留文档产物；修复 Ledger 写入后，从权威 Ledger 重建 task-state、Todo、飞书和 Workbench 投影。",
        };
      }
    }
    const results = asArray(workerRun.results).map(asRecord);
    const completedResults = results.filter((result) => typeof result.markdown === "string" && ["completed", "needs_fix"].includes(String(result.status)));
    const generatedStepName = requestedDocuments.length === 1 && requestedDocuments[0] === "meeting-minutes" ? "meeting_minutes_generated" : "documents_generated";
    await hooks.onStep?.(generatedStepName, workerRun.status === "completed" ? "completed" : String(workerRun.status ?? "blocked"), {
      artifact: completedResults.length > 0 ? "agent-output-pending" : null,
      modelRoutePath: workerRun.modelRoutePath ?? join(paths.runDir, "model-route.json"),
      documentCount: completedResults.length,
      sectionBatches: completedResults.reduce((sum, result) => sum + asArray(result.sectionBatches).length, 0),
      traceRoot: workerRun.traceRoot ?? join(paths.runDir, "artifacts", "model-streams", "document_workers_run"),
      attemptCount: workerRun.attemptCount ?? results.reduce((sum, result) => sum + asArray(result.sectionAttempts).map(asRecord).reduce((inner, attempt) => inner + asArray(attempt.attemptFailures).length, 0), 0),
      partialCount: workerRun.partialCount ?? results.filter((result) => result?.markdown && result?.status === "blocked").length,
      lastAttempt: workerRun.lastAttempt ?? null,
      timeoutBudgetMs: workerRun.timeoutBudgetMs ?? workerDeadline.runtimeBudgetMs,
      workflow: workerRun.workflow ?? null,
      finalFailureReport: workerRun.finalFailureReport ?? null,
      projection: workerRun.projection ?? projectionReconciliation,
      projectionReconciliation,
    });
    if (completedResults.length === 0) {
      const finalFailureReport = finalFailureReportFromWorkerRun(workerRun);
      const output = blockedOutput(finalFailureSummary(finalFailureReport), {
        ...workerRun,
        finalFailureReport,
      });
      writeJson(paths.agentOutputPath, output);
      return createPipelineRun("blocked", output);
    }
    if (workerRun.status !== "completed" || completedResults.length < workItemsResult.documentWorkItems.length || completedResults.some((result) => result.status !== "completed")) {
      const finalFailureReport = finalFailureReportFromWorkerRun(workerRun);
      const output = blockedOutput(finalFailureSummary(finalFailureReport), {
        ...workerRun,
        finalFailureReport,
        completedPrivateDraftCount: completedResults.length,
        publishPartial: false,
      });
      writeJson(paths.agentOutputPath, output);
      return createPipelineRun("blocked", output);
    }
    await hooks.progressReply?.("文档生成完成，正在检查并发布。", generatedStepName);

    const qaDocumentOutputs = completedResults.map((result, index) => {
      const docType = String(result.docType ?? requestedDocuments[index] ?? "document");
      const planned = titlePlanForDoc(titlePlan, docType);
      const generatedTitle = extractTitle(result.markdown);
      const qaInput = asRecord(result.qaInput);
      const outputContract = asRecord(sourceContext.outputContract);
      return {
        ...qaInput,
        docType,
        title: planned?.title ?? generatedTitle,
        markdownTitle: generatedTitle,
        targetTitle: planned?.title ?? null,
        titleBasis: planned?.titleBasis ?? null,
        documentIdentity: sourceContext.documentIdentity ?? null,
        outputContract: sourceContext.outputContract ?? null,
        sourceStructureSummary: sourceContext.sourceStructureSummary ?? null,
        sourceStructurePath: workspaceRelative(sourceContext.sourceStructurePath),
        contextManifest: workspaceRelative(sourceContext.manifestPath),
        contextPackIds: result.contextPackIds ?? qaInput.contextPackIds ?? [],
        sourceBlockIds: result.sourceBlockIds ?? qaInput.sourceBlockIds ?? [],
        tableBlockCount: Number(result.tableBlockCount ?? qaInput.tableBlockCount ?? 0),
        outputContractVersion: result.outputContractVersion ?? qaInput.outputContractVersion ?? outputContract.outputContractVersion ?? "document-output-contract-v1",
        markdown: result.markdown,
      };
    });

    const meetingQa = meetingIntelligence.analysis?.analysisMode === "model_reasoned_validated"
      ? buildMeetingQaFindings(meetingIntelligence.analysis, qaDocumentOutputs)
      : {
          omittedMacroTopics: [],
          uncertainEvidenceClaims: [],
          actionCoverageGaps: [],
          speakerAttributionViolations: [],
          unsupportedEntities: [],
          crossMeetingTerms: [],
          ambiguousTermExpansions: [],
        };

    const explicitPublishRequested = /发布|保存|放到|上传到|云端|飞书文档|创建文档|归档|publish|save|upload/i.test(
      cleanUserPrompt(task.sourceEvent?.message?.text ?? ""),
    );
    const qaGate = await callRuntimeTool("qa_gate_evaluate", {
      profile: revisionMode ? "document_revision" : requestedDocuments.includes("meeting-minutes") ? "meeting_minutes" : "office_document",
      publishIntent: explicitPublishRequested,
      checks: {
        security: { rawSecretsReturned: false, secretsLeaked: false },
        topicCoverage: { omittedMacroTopics: meetingQa.omittedMacroTopics, actionCoverageGaps: meetingQa.actionCoverageGaps },
        entitySafety: {
          unsupportedEntities: meetingQa.unsupportedEntities,
          crossMeetingTerms: meetingQa.crossMeetingTerms,
          ambiguousTermExpansions: meetingQa.ambiguousTermExpansions,
          speakerAttributionViolations: meetingQa.speakerAttributionViolations,
        },
        asrEvidence: { uncertainEvidenceClaims: meetingQa.uncertainEvidenceClaims },
        reviewContext: revisionMode
          ? {
              required: true,
              status: reviewContext?.status ?? "missing",
              artifact: workspaceRelative(reviewContextPath(paths.artifactsDir)),
              commentAccess: reviewContext?.commentAccess ?? null,
              matchSummary: reviewContext?.matchSummary ?? null,
              sourceDocuments: asArray(reviewContext?.sourceDocuments).map(asRecord).map((source) => ({
                sourceId: source.sourceId,
                commentAccess: source.commentAccess,
                commentCount: asArray(source.comments).length,
                comments: asArray(source.comments).map(asRecord).map((comment) => ({
                  sourceId: comment.sourceId,
                  commentId: comment.commentId,
                  matchStatus: comment.matchStatus,
                  matchReason: comment.matchReason,
                })),
              })),
              independentCommentThreadsRead: ["cli", "sdk"].includes(String(asRecord(reviewContext?.commentAccess).method ?? "")),
              unavailableMustBeDisclosed: !["cli", "sdk"].includes(String(asRecord(reviewContext?.commentAccess).method ?? "")),
            }
          : null,
        contextManifest: workspaceRelative(sourceContext.manifestPath),
        documentIdentity: sourceContext.documentIdentity ?? null,
        outputContract: sourceContext.outputContract ?? null,
        sourceStructureSummary: sourceContext.sourceStructureSummary ?? null,
        documentOutputs: qaDocumentOutputs,
      },
    }, paths, options);
    const qaGateWrite = await callRuntimeTool("qa_gate_write", { runId: task.runId, gate: qaGate, outputRoot }, paths, options);
    const qaGatePersisted = qaGateWrite?.ok === true;
    await hooks.onStep?.("qa_gate_completed", qaGate.status === "pass" && qaGatePersisted ? "completed" : qaGate.status === "pass" ? "blocked" : String(qaGate.status ?? "blocked"), {
      artifact: qaGatePersisted ? qaGateWrite.qaGatePath : null,
      status: qaGate.status,
      persistenceStatus: qaGatePersisted ? "persisted" : "blocked",
      reason: qaGatePersisted ? null : qaGateWrite?.reason ?? "qa_gate_write_failed",
    });

    const policyGate = await callRuntimeTool("policy_gate_check", {
      actionIntent: "publish_customer_visible",
      capabilityId: "feishu-agent-bridge",
      audience: "feishu_chat",
      payloadClass: requestedDocuments.includes("meeting-minutes") ? "meeting_minutes_document" : "office_document_outputs",
      riskLevel: "medium",
      artifacts: [
        workspaceRelative(evidencePackPath(paths.artifactsDir)),
        existsSync(transcriptPath(paths.artifactsDir)) ? workspaceRelative(transcriptPath(paths.artifactsDir)) : null,
        existsSync(evidenceIndexPath(paths.artifactsDir)) ? workspaceRelative(evidenceIndexPath(paths.artifactsDir)) : null,
      ].filter(Boolean),
      rawMediaExternalUpload: false,
      rawTranscriptIncluded: false,
      feishuInbound: true,
      explicitUserRequest: true,
      userRequestedAction: true,
      destructiveAction: false,
      targetSpecified: true,
    }, paths, options);
    await callRuntimeTool("policy_gate_write", { runId: task.runId, decision: policyGate, outputRoot }, paths, options);
    await hooks.onStep?.("policy_gate_completed", policyGate.status === "pass" ? "completed" : String(policyGate.status ?? "blocked"), { artifact: join(paths.runDir, "policy-gate.json"), status: policyGate.status });

    const publishable = qaGate.status === "pass" && qaGatePersisted && policyGate.status === "pass" && completedResults.every((result) => result.status === "completed");
    const documents = completedResults.map((result, index) => {
      const docType = String(result.docType ?? requestedDocuments[index] ?? "document");
      const planned = titlePlanForDoc(titlePlan, docType);
      const generatedTitle = extractTitle(result.markdown);
      const title = planned?.title ?? (isGenericTitle(generatedTitle, docType) ? documentTitleForFallback(docType) : generatedTitle);
      const fileName = safeFileName(title);
      const markdown = syncMarkdownTitle(result.markdown, String(title));
      const localDocPath = join(paths.artifactsDir, fileName);
      writeText(localDocPath, markdown);
      return { docType, title, fileName, markdown, titleBasis: planned?.titleBasis ?? null, localPath: localDocPath };
    });
    const remainingLedgerDocuments = [...documents];
    while (remainingLedgerDocuments.length > 0) {
      const ledgerSteps = asArray(activeLedger.steps).map(asRecord);
      const completedStepIds = new Set(ledgerSteps.filter((step) => step.status === "completed").map((step) => String(step.stepId ?? "")));
      const readyIndex = remainingLedgerDocuments.findIndex((document) => {
        const step = ledgerSteps.find((item) => item.stepId === `generate-${document.docType}`);
        return Boolean(step) && asArray(step?.dependsOn).every((dependency) => completedStepIds.has(String(dependency)));
      });
      if (readyIndex < 0) break;
      const [document] = remainingLedgerDocuments.splice(readyIndex, 1);
      if (!document) break;
      const completedLedger = await callRuntimeTool("execution_ledger_reconcile", {
        runId: task.runId,
        outputRoot,
        expectedRevision: activeLedger.revision,
        operationId: `document-generation-completed:${document.docType}`,
        actor: "task-execution-runner",
        stepUpdates: [{
          stepId: `generate-${document.docType}`,
          status: "completed",
          resultRefs: [workspaceRelative(document.localPath)],
          acceptancePassed: true,
        }],
      }, paths, options);
      if (completedLedger.status === "blocked") break;
      activeLedger = completedLedger;
    }
    /** @type {UnknownRecord | null} */
    let lifecycleResult = null;
    if (revisionMode) {
      lifecycleResult = await callRuntimeTool("document_lifecycle_write", {
        runId: task.runId,
        action: "revised",
        channel: "feishu",
        artifactPointer: workspaceRelative(documents[0]?.localPath),
        summaryPointer: workspaceRelative(reviewContextPath(paths.artifactsDir)),
        targetFileToken: task.attachments?.find((attachment) => attachment.fileToken)?.fileToken ?? undefined,
        sourceRunId: task.runId,
        outputRoot,
      }, paths, options);
      await hooks.onStep?.("document_lifecycle_recorded", lifecycleResult?.status === "blocked" ? "blocked" : "completed", {
        artifact: lifecycleResult?.documentLifecyclePath ?? join(paths.runDir, "document-lifecycle.json"),
        action: "revised",
      });
    }
    const meetingMemory = requestedDocuments.includes("meeting-minutes")
      ? asRecord(await runMeetingMemoryCurationSafely({
          task,
          paths,
          options,
          hooks,
          meetingAnalysis: meetingIntelligence.analysis,
          documents,
          qaGate,
        }))
      : null;
    const artifacts = [
      { kind: "evidence-pack", name: "evidence-pack.json", localPath: evidencePackPath(paths.artifactsDir) },
      meetingIntelligence.analysis ? { kind: "meeting-analysis", name: "meeting-analysis.json", localPath: meetingAnalysisPath(paths.artifactsDir) } : null,
      meetingIntelligence.analysis ? { kind: "participant-map", name: "participant-map.json", localPath: participantMapPath(paths.artifactsDir) } : null,
      meetingIntelligence.analysis ? { kind: "topic-map", name: "topic-map.json", localPath: topicMapPath(paths.artifactsDir) } : null,
      meetingIntelligence.analysis ? { kind: "evidence-map", name: "evidence-map.json", localPath: internalEvidenceMapPath(paths.artifactsDir) } : null,
      meetingIntelligence.analysis ? { kind: "agent-plan", name: "agent-plan.json", localPath: agentPlanPath(paths.artifactsDir) } : null,
      meetingIntelligence.analysis ? { kind: "product-discovery", name: "product-discovery.json", localPath: productDiscoveryPath(paths.artifactsDir) } : null,
      meetingIntelligence.analysis ? { kind: "next-step-options", name: "next-step-options.json", localPath: nextStepOptionsPath(paths.artifactsDir) } : null,
      meetingIntelligence.analysis ? { kind: "agentic-orchestration", name: "agentic-orchestration.json", localPath: agenticOrchestrationPath(paths.artifactsDir) } : null,
      meetingIntelligence.analysis ? { kind: "agentic-orchestration-result", name: "agentic-orchestration-result.json", localPath: agenticOrchestrationResultPath(paths.artifactsDir) } : null,
      meetingIntelligence.analysis && existsSync(agenticOrchestrationEventsPath(paths.artifactsDir))
        ? { kind: "agentic-orchestration-events", name: "agentic-orchestration-events.ndjson", localPath: agenticOrchestrationEventsPath(paths.artifactsDir) }
        : null,
      revisionMode ? { kind: "review-context", name: "review-context.json", localPath: reviewContextPath(paths.artifactsDir) } : null,
      { kind: "document-title-plan", name: "document-title-plan.json", localPath: titlePlanPath(paths.artifactsDir) },
      lifecycleResult?.documentLifecyclePath ? { kind: "document-lifecycle", name: "document-lifecycle.json", localPath: lifecycleResult.documentLifecyclePath } : null,
      existsSync(audioNormalizePath(paths.artifactsDir)) ? { kind: "audio-normalize", name: "audio-normalize.json", localPath: audioNormalizePath(paths.artifactsDir) } : null,
      existsSync(asrSummaryPath(paths.artifactsDir)) ? { kind: "asr-summary", name: "summary.json", localPath: asrSummaryPath(paths.artifactsDir) } : null,
      { kind: "model-route", name: "model-route.json", localPath: join(paths.runDir, "model-route.json") },
      { kind: "qa-gate", name: "qa-gate.json", localPath: join(paths.runDir, "qa-gate.json") },
      { kind: "policy-gate", name: "policy-gate.json", localPath: join(paths.runDir, "policy-gate.json") },
    ].filter(Boolean);
    if (publishable && asArray(activeLedger.steps).map(asRecord).some((step) => step.stepId === "verify-deliverables" && step.status === "ready")) {
      const verifiedLedger = await callRuntimeTool("execution_ledger_reconcile", {
        runId: task.runId,
        outputRoot,
        expectedRevision: activeLedger.revision,
        operationId: "deliverables-verified",
        actor: "task-execution-runner",
        stepUpdates: [{
          stepId: "verify-deliverables",
          status: "completed",
          resultRefs: [workspaceRelative(join(paths.runDir, "qa-gate.json")), workspaceRelative(join(paths.runDir, "policy-gate.json"))],
          acceptancePassed: true,
        }],
      }, paths, options);
      if (verifiedLedger.status !== "blocked") activeLedger = verifiedLedger;
    }
    const workerWorkflow = asRecord(workerRun.workflow);
    const meetingProfile = asRecord(meetingAnalysis.meetingProfile);
    const participantResolution = asRecord(meetingAnalysis.participantResolution);
    const meetingAgentPlan = asRecord(meetingAnalysis.agentPlan);
    const productDiscovery = asRecord(meetingAnalysis.productDiscovery);
    const suggestedFollowUpDocuments = uniqueStrings(meetingAgentPlan.suggestedFollowUpDocuments);
    const meetingMemoryPersistence = asRecord(meetingMemory?.persistence);
    const gateFailureReport = publishable ? null : {
      schemaVersion: "document-workflow-final-failure-v1",
      terminalReason: qaGate.status !== "pass" ? "qa_gate_not_publishable" : !qaGatePersisted ? "qa_gate_artifact_write_failed" : "policy_gate_not_publishable",
      status: "needs_fix",
      completedDocs: completedResults.map((result) => result.docType).filter(Boolean),
      pendingDocs: [],
      failedStage: qaGate.status !== "pass" || !qaGatePersisted ? "qa_gate" : "policy_gate",
      retryCount: Number(workerWorkflow.retryUnitsUsed ?? 0),
      retryExhausted: false,
      lastProviderAttempt: lastAttemptFromWorkerRun(workerRun),
      nextAction: qaGate.status !== "pass"
        ? "根据 QA issue 修订私有文档后再发布。"
        : !qaGatePersisted
          ? "修复 QA artifact 写入后重新评估，禁止依据未落盘结果发布。"
          : "确认发布边界或用户授权后再发布。",
      publishPartial: false,
      rawSecretsReturned: false,
    };
    const output = {
      status: publishable ? "completed" : "needs_fix",
      summary: publishable
        ? [
            `已基于 ${evidenceSummary.sourceCount} 个来源生成 ${documents.length} 份文档。`,
            typeof participantResolution.question === "string" ? participantResolution.question : "",
            suggestedFollowUpDocuments.length
              ? `Agent 建议后续可生成：${suggestedFollowUpDocuments.join("、")}。`
              : "",
          ].filter(Boolean).join(" ")
        : finalFailureSummary(gateFailureReport),
      documents: publishable ? documents : [],
      qaGate,
      policyGate,
      artifacts,
      details: publishable
        ? {
            meetingIntelligence: {
              meetingType: meetingProfile.meetingType ?? null,
              topicCount: asArray(meetingAnalysis.topicMap).length,
              participantCount: participantResolution.participantCount ?? 0,
              unresolvedParticipantCount: participantResolution.unresolvedCount ?? 0,
              narrativeMode: meetingAgentPlan.narrativeMode ?? null,
              orchestrationMode: meetingAgentPlan.orchestrationMode ?? null,
              specialistCount: meetingAgentPlan.specialistCount ?? 0,
              suggestedFollowUpDocuments,
              prdReadiness: productDiscovery.prdReadiness ?? null,
              nextStepOptions: asArray(productDiscovery.nextStepOptions),
              clarificationQuestionCount: asArray(productDiscovery.clarificationQuestions).length,
            },
            meetingMemory: meetingMemory
              ? {
                  status: meetingMemory.status,
                  reason: meetingMemory.reason ?? null,
                  persistedCount: meetingMemoryPersistence.persistedCount ?? 0,
                  conflictCount: meetingMemoryPersistence.conflictCount ?? 0,
                  artifact: workspaceRelative(meetingMemoryResultPath(paths.artifactsDir)),
                }
              : null,
            todo: activeLedger.userTodoProjection ?? planner.userTodoProjection ?? null,
            interactionItems: activeLedger.interactionItems ?? planner.interactionItems ?? [],
            projection: workerRun.projection ?? null,
            projectionReconciliation,
          }
        : { finalFailureReport: gateFailureReport },
      rawSecretsReturned: false,
      rawMediaExternalUpload: false,
    };
    writeJson(paths.agentOutputPath, output);
    await hooks.onStep?.("task_execution_runner_completed", output.status === "completed" ? "completed" : "needs_fix", { artifact: paths.agentOutputPath });
    return createPipelineRun(output.status === "completed" ? "completed" : "needs_fix", /** @type {PipelineOutput} */ (output));
  } catch (error) {
    const output = blockedOutput("任务处理失败，可重试。", { reason: "task_execution_runner_failed", error: error instanceof Error ? error.message : String(error) });
    writeJson(paths.agentOutputPath, output);
    await hooks.onStep?.("task_execution_runner_completed", "failed", { artifact: paths.agentOutputPath, reason: "task_execution_runner_failed" });
    return createPipelineRun("failed", output);
  }
}
