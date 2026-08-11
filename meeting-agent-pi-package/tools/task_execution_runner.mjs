import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { AUDIO_NORMALIZE_VERSION, TARGET_AUDIO_SPEC, normalizeAudioBatch } from "./audio_normalize_helpers.mjs";
import { isCloudAsrMedia, mediaExtension } from "./asr_media_formats.mjs";
import { fetchFeishuDocumentReviewContext } from "./feishu_document_review_context_helpers.mjs";

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
const DEFAULT_CLOUD_ASR_FILE_MODEL = "paraformer-v2";
const DEFAULT_CLOUD_ASR_LANGUAGE_HINTS = ["yue", "zh", "en"];

const RUNNER_EXECUTION_PROFILES = new Set([
  "fast_answer",
  "file_summary",
  "audio_minutes",
  "document_generation",
  "document_revision",
  "multi_source_synthesis",
]);
const FULL_DOCUMENT_EXECUTION_PROFILES = new Set([
  "audio_minutes",
  "document_generation",
  "document_revision",
  "multi_source_synthesis",
]);
const DEFAULT_FILE_SUMMARY_CONTEXT_POLICY = {
  maxSources: 6,
  previewCharsPerSource: 4000,
  extractedSliceChars: 5000,
  maxExtractedSlicesPerSource: 2,
  maxPromptChars: 30000,
};
function nowIso() {
  return new Date().toISOString();
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sanitize(value), null, 2)}\n`, "utf8");
  return path;
}

function writeRawJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

function writeText(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
  return path;
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

let executionProfilesCache = null;

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
      publish_only: { runnerEligible: false, pipeline: "immediate" },
      unsupported: { runnerEligible: false, pipeline: "immediate" },
    },
  };
}

function loadExecutionProfiles() {
  if (executionProfilesCache) return executionProfilesCache;
  try {
    executionProfilesCache = loadJson(executionProfilesPath);
  } catch {
    executionProfilesCache = defaultExecutionProfiles();
  }
  return executionProfilesCache;
}

function normalizeExecutionProfile(value) {
  const profile = String(value ?? "").trim();
  return profile || null;
}

function executionProfileForTask(task) {
  const id = normalizeExecutionProfile(task?.taskIntent?.executionProfile);
  if (!id) return null;
  const config = loadExecutionProfiles().profiles?.[id] ?? {};
  return { id, config };
}

function safeSegment(value, fallback = "item") {
  const cleaned = String(value || fallback).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned;
}

function safeFileName(value, fallback = "meeting-minutes.md") {
  const name = String(value || fallback).replace(/[\/\\:*?"<>|]/g, "_").trim().slice(0, 120) || fallback;
  return name.endsWith(".md") ? name : `${name}.md`;
}

function titlePlanPath(artifactsDir) {
  return join(artifactsDir, "document-title-plan.json");
}

function redactString(value) {
  return String(value ?? "")
    .replace(/(app_secret|client_secret|refresh_token|access_token|authorization|cookie|session)\s*[:=]\s*["']?[^"',\s]+/gi, "[redacted]")
    .replace(/bearer\s+[A-Za-z0-9._-]+/gi, "[redacted]");
}

function sanitize(value) {
  if (typeof value === "string") return redactString(value).slice(0, 20000);
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, entryValue] of Object.entries(value)) {
      if (/secret|cookie|session|authorization/i.test(key) && key !== "rawSecretsReturned" && !/folderToken|fileToken|wikiToken/i.test(key)) {
        output[key] = "[redacted]";
      } else {
        output[key] = sanitize(entryValue);
      }
    }
    return output;
  }
  return value;
}

function hashText(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function workspaceRelative(path) {
  if (!path) return null;
  const resolved = resolve(path);
  return isInside(workspaceDir, resolved) ? relative(workspaceDir, resolved) : "[outside-workspace]";
}

function cleanUserPrompt(text) {
  return String(text ?? "")
    .replace(/@\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanPromptForTitle(text) {
  return cleanUserPrompt(text)
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\[[^\]]+\]\([^)]+\)/g, " ")
    .replace(/[\[\]【】（）()]/g, " ")
    .replace(/\b(file|doc|docx|sheet|wiki|token)[_-]?[A-Za-z0-9_-]{8,}\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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
      resolveCommand({ exitCode: error.code === "ENOENT" ? 127 : 1, stdout, stderr, timedOut, error: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolveCommand({ exitCode: code ?? (signal ? 128 : 1), stdout, stderr, timedOut });
    });
    child.stdin.end(options.stdin ?? "");
  });
}

function optionalPositiveNumber(raw) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function documentWorkerTimeoutMs(options = {}) {
  return optionalPositiveNumber(
    options.longDocumentJobTimeoutMs ??
    process.env.FEISHU_AGENT_LONG_DOCUMENT_JOB_TIMEOUT_MS ??
    options.documentWorkerTimeoutMs ??
    process.env.FEISHU_AGENT_DOCUMENT_WORKER_TIMEOUT_MS,
  ) ?? DEFAULT_LONG_DOCUMENT_JOB_TIMEOUT_MS ?? DEFAULT_DOCUMENT_WORKER_TIMEOUT_MS;
}

function documentWorkerDeadlineReserveMs(options = {}) {
  return optionalPositiveNumber(options.documentWorkerDeadlineReserveMs ?? process.env.FEISHU_AGENT_DOCUMENT_WORKER_DEADLINE_RESERVE_MS) ?? DEFAULT_DOCUMENT_WORKER_DEADLINE_RESERVE_MS;
}

function documentWorkerDeadlineParams(options = {}) {
  const runtimeBudgetMs = documentWorkerTimeoutMs(options);
  const deadlineReserveMs = documentWorkerDeadlineReserveMs(options);
  return {
    runtimeBudgetMs,
    deadlineReserveMs,
    deadlineAt: new Date(Date.now() + runtimeBudgetMs).toISOString(),
  };
}

function listFilesRecursive(root, predicate = () => true, limit = 200) {
  if (!existsSync(root) || limit <= 0) return [];
  const files = [];
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

function readNdjson(path, limit = 200) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { event: "parse_error", rawPreview: line.slice(0, 200) };
      }
    });
}

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

function lastAttemptFromWorkerRun(workerRun) {
  if (workerRun?.lastAttempt) return workerRun.lastAttempt;
  if (workerRun?.finalFailureReport?.lastProviderAttempt) return workerRun.finalFailureReport.lastProviderAttempt;
  const results = Array.isArray(workerRun?.results) ? workerRun.results : [];
  for (const result of [...results].reverse()) {
    const attempts = [
      ...(Array.isArray(result?.repairAttempts) ? result.repairAttempts : []),
      ...(Array.isArray(result?.sectionAttempts) ? result.sectionAttempts : []),
    ];
    for (const attempt of attempts.reverse()) {
      const failures = Array.isArray(attempt?.attemptFailures) ? attempt.attemptFailures : [];
      const last = failures.at(-1);
      if (last) {
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

function chineseFailureReason(reason, lastAttempt = null) {
  const finalReason = String(lastAttempt?.reason ?? reason ?? "document_workflow_not_completed");
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

function finalFailureReportFromWorkerRun(workerRun, fallbackReason = "document_workflow_not_completed") {
  const existing = workerRun?.finalFailureReport;
  if (existing && typeof existing === "object") return existing;
  const results = Array.isArray(workerRun?.results) ? workerRun.results : [];
  const lastAttempt = lastAttemptFromWorkerRun(workerRun);
  const pendingDocs = results
    .filter((result) => result?.status !== "completed")
    .map((result) => ({
      docType: result.docType,
      status: result.status,
      reason: result.reason ?? null,
      missingSections: result.missingSections ?? [],
    }));
  return {
    schemaVersion: "document-workflow-final-failure-v1",
    terminalReason: workerRun?.reason ?? fallbackReason,
    status: workerRun?.status ?? "blocked",
    completedDocs: results.filter((result) => result?.status === "completed").map((result) => result.docType).filter(Boolean),
    pendingDocs,
    failedStage: pendingDocs[0]?.missingSections?.length ? "review" : "section_draft",
    retryCount: Number(workerRun?.workflow?.retryUnitsUsed ?? 0),
    retryExhausted: Boolean(workerRun?.workflow?.retryExhausted),
    lastProviderAttempt: lastAttempt,
    nextAction: workerRun?.workflow?.checkpointPath ? "已保留本地 checkpoint，可修复阻塞原因后继续未完成章节。" : "修复阻塞原因后重新运行任务。",
    publishPartial: false,
    rawSecretsReturned: false,
  };
}

function finalFailureSummary(report) {
  const reasonText = chineseFailureReason(report?.terminalReason, report?.lastProviderAttempt);
  const pending = Array.isArray(report?.pendingDocs) && report.pendingDocs.length > 0
    ? report.pendingDocs.map((doc) => `${doc.docType}${doc.missingSections?.length ? ` 缺失 ${doc.missingSections.length} 个章节` : ""}`).slice(0, 3).join("；")
    : "无可发布文档";
  const retryText = Number(report?.retryCount ?? 0) > 0 ? `已按 checkpoint 重试 ${report.retryCount} 次。` : "已检查 checkpoint，暂无可发布结果。";
  return `文档生成未能最终交付：${reasonText}。${retryText}未发布阶段稿。未完成：${pending}。下一步：${report?.nextAction ?? "修复阻塞原因后继续运行。"}`;
}

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

export function shouldUseTaskExecutionRunner(task) {
  if (["unsupported", "needs_file", "ack_file_cached"].includes(task?.taskIntent?.responseMode)) return false;
  const profile = executionProfileForTask(task);
  if (!profile) return false;
  if (!RUNNER_EXECUTION_PROFILES.has(profile.id)) return false;
  return profile.config?.runnerEligible !== false;
}

async function callModelGenerateText(params, paths, options, profile = "") {
  return await callRuntimeTool("model_generate_text", params, paths, options, profile);
}

function normalizeAsrServiceUrl(value) {
  let url;
  try {
    url = new URL(value || process.env.LOCAL_ASR_SERVICE_URL || "http://127.0.0.1:8765");
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

function postJson(url, payload, timeoutMs, bearerToken) {
  return new Promise((resolveRequest) => {
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

function getJson(url, path, timeoutMs, bearerToken) {
  return new Promise((resolveRequest) => {
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

function tcpReachable(url, timeoutMs = 1000) {
  return new Promise((resolveReachable) => {
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

function localAsrServiceCommand(serviceUrl, options = {}) {
  const url = serviceUrl ? new URL(serviceUrl) : new URL("http://127.0.0.1:8765");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const modelDir = options.localAsrModelDir ?? process.env.LOCAL_ASR_MODEL_DIR ?? "models/Qwen3-ASR-1.7B-MLX-4bit";
  return `.venv-qwen3-asr/bin/python meeting-agent-pi-package/tools/local_asr_http_service.py --host ${url.hostname} --port ${port} --model-dir ${modelDir} --preload`;
}

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

async function preflightLocalAsrService(serviceUrl, options = {}) {
  const timeoutMs = Number(options.localAsrHealthTimeoutMs ?? process.env.FEISHU_AGENT_LOCAL_ASR_HEALTH_TIMEOUT_MS ?? 5000);
  const bearerToken = process.env.LOCAL_ASR_BEARER_TOKEN?.trim() || null;
  const health = await getJson(serviceUrl, "/health", timeoutMs, bearerToken);
  const timedOut = /timed out|timeout/i.test(String(health.error ?? ""));
  const tcpReachableAfterTimeout = !health.ok && timedOut
    ? await tcpReachable(serviceUrl, Math.min(timeoutMs, 1000))
    : false;
  return {
    ...health,
    timeoutMs,
    modelLoaded: Boolean(health.body?.modelLoaded),
    lastStatus: health.body?.lastStatus ?? null,
    serviceBusy: Boolean(health.body?.busy) || tcpReachableAfterTimeout,
    healthStatus: tcpReachableAfterTimeout ? "health_timeout_while_tcp_reachable" : health.body?.status ?? null,
    tcpReachable: tcpReachableAfterTimeout,
  };
}

function asrSummaryPath(outputDir) {
  return join(outputDir, "summary.json");
}

function transcriptPath(outputDir) {
  return join(outputDir, "transcripts", "transcript.full.json");
}

function evidenceIndexPath(outputDir) {
  return join(outputDir, "evidence", "evidence-index.json");
}

function audioNormalizePath(outputDir) {
  return join(outputDir, "audio-normalize.json");
}

function cloudAsrParamsPath(outputDir) {
  return join(outputDir, "asr", "cloud-asr-params.json");
}

function cloudAsrResultPath(outputDir) {
  return join(outputDir, "asr", "cloud-asr-result.json");
}

function cloudAsrRunPath(outputDir) {
  return join(outputDir, "asr", "cloud-asr-run.json");
}

function cloudAsrEventsPath(outputDir) {
  return join(outputDir, "asr", "cloud-asr-events.ndjson");
}

function evidencePackPath(outputDir) {
  return join(outputDir, "evidence-pack.json");
}

function fileSummaryContextPath(outputDir) {
  return join(outputDir, "file-summary-context.json");
}

function reviewContextPath(outputDir) {
  return join(outputDir, "review-context.json");
}

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

function copyAsrArtifacts(sourceDir, targetDir) {
  for (const name of ["transcripts", "evidence"]) {
    const from = join(sourceDir, name);
    if (existsSync(from)) cpSync(from, join(targetDir, name), { recursive: true, force: true });
  }
  if (existsSync(join(sourceDir, "summary.json"))) cpSync(join(sourceDir, "summary.json"), join(targetDir, "summary.json"), { force: true });
}

function asrCacheDir(paths, key) {
  return join(dirname(dirname(paths.runDir)), "asr-cache", safeSegment(key));
}

function sourceAudioPaths(task) {
  return (task.attachments ?? [])
    .map((attachment) => ({
      path: attachment.localPath ? resolve(attachment.localPath) : null,
      sha256: attachment.sha256 ?? null,
      name: attachment.name ?? null,
      sizeBytes: attachment.sizeBytes ?? null,
      resourceType: String(attachment.resourceType ?? "").toLowerCase(),
      ext: mediaExtension(attachment.name) || mediaExtension(attachment.localPath),
    }))
    .filter((item) => item.path && existsSync(item.path) && (isCloudAsrMedia(item.ext) || ["audio", "video"].includes(item.resourceType)));
}

function audioCacheKey(audios, providerConfig = {}) {
  return hashText(JSON.stringify({
    normalizerVersion: AUDIO_NORMALIZE_VERSION,
    targetSpec: TARGET_AUDIO_SPEC,
    asrProvider: providerConfig.provider ?? "local_qwen3",
    asrModel: providerConfig.model ?? null,
    asrFileModel: providerConfig.fileModel ?? null,
    asrInputMode: providerConfig.inputMode ?? null,
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

function writeAudioNormalizeArtifact(paths, artifact) {
  return writeJson(audioNormalizePath(paths.artifactsDir), artifact);
}

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

function parseLanguageHints(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value ?? process.env.ALIYUN_ASR_LANGUAGE_HINTS ?? DEFAULT_CLOUD_ASR_LANGUAGE_HINTS.join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveAsrProvider(options = {}) {
  const requested = normalizeAsrProvider(options.asrProvider ?? process.env.MEETING_ASR_PROVIDER ?? "auto");
  const provider = requested === "auto"
    ? cloudAsrApiKeyConfigured() ? "aliyun_dashscope_paraformer" : "local_qwen3"
    : requested;
  const fallback = normalizeAsrProvider(options.asrFallbackProvider ?? process.env.MEETING_ASR_FALLBACK_PROVIDER ?? "local_qwen3");
  const model = options.aliyunAsrModel ?? process.env.ALIYUN_ASR_MODEL ?? DEFAULT_CLOUD_ASR_MODEL;
  const fileModel = options.aliyunAsrFileModel ?? process.env.ALIYUN_ASR_FILE_MODEL ?? DEFAULT_CLOUD_ASR_FILE_MODEL;
  const languageHints = parseLanguageHints(options.aliyunAsrLanguageHints);
  const vocabularyId = options.aliyunAsrVocabularyId ?? process.env.ALIYUN_ASR_VOCABULARY_ID ?? "";
  return {
    requested,
    provider,
    fallbackProvider: fallback === "auto" ? "local_qwen3" : fallback,
    model,
    fileModel,
    inputMode: options.aliyunAsrInputMode ?? process.env.ALIYUN_ASR_INPUT_MODE ?? "auto",
    diarizationEnabled: options.aliyunAsrDiarizationEnabled ?? process.env.ALIYUN_ASR_DIARIZATION_ENABLED ?? "auto",
    speakerCount: options.aliyunAsrSpeakerCount ?? process.env.ALIYUN_ASR_SPEAKER_COUNT ?? "",
    timestampAlignmentEnabled: options.aliyunAsrTimestampAlignmentEnabled ?? process.env.ALIYUN_ASR_TIMESTAMP_ALIGNMENT_ENABLED ?? "true",
    languageHints,
    vocabularyId,
    endpoint: options.aliyunAsrEndpoint ?? process.env.ALIYUN_ASR_ENDPOINT ?? "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
    fileEndpoint: options.aliyunAsrFileEndpoint ?? process.env.ALIYUN_ASR_FILE_ENDPOINT ?? "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription",
    workspaceId: options.aliyunDashscopeWorkspaceId ?? process.env.ALIYUN_DASHSCOPE_WORKSPACE_ID ?? "",
  };
}

function userMessageForAsrFailure(asr) {
  const reason = asr?.reason ?? asr?.failureClass ?? "asr_all_providers_failed";
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
    local_asr_service_not_running: asr?.userMessage ?? "本机 ASR 服务未运行，暂时无法转写音频。",
    local_asr_service_unavailable: "本机 ASR 服务不可用，暂时无法转写音频。",
    local_asr_output_incomplete: "本机 ASR 输出不完整，暂时无法生成会议纪要。",
    asr_all_providers_failed: "本地和云端 ASR 均未完成转写，暂时无法生成会议纪要。",
  };
  return messages[reason] ?? `ASR 转写失败：${reason}`;
}

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
    const blocked = localAsrServiceNotRunning(null, {
      healthStatus: "invalid_service_url",
      error: error instanceof Error ? error.message : String(error),
    }, options);
    await hooks.onStep?.("local_asr_preflight", "blocked", {
      reason: blocked.reason,
      healthStatus: blocked.healthStatus,
      error: blocked.error,
      rawMediaExternalUpload: false,
    });
    return blocked;
  }
  const health = await preflightLocalAsrService(serviceUrl, options);
  if ((!health.ok || health.body?.status !== "ok") && !health.tcpReachable) {
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
    healthStatus: health.healthStatus ?? health.body?.status ?? null,
    serviceBusy: health.serviceBusy,
    healthError: health.error ?? null,
    tcpReachable: health.tcpReachable,
    lastStatus: health.lastStatus,
    rawMediaExternalUpload: false,
  });

  const normalized = await normalizeAudioBatch(audios, join(paths.artifactsDir, "audio-normalized"), {
    workspaceDir,
    timeoutMs: Number(options.audioNormalizeTimeoutMs ?? process.env.FEISHU_AGENT_AUDIO_NORMALIZE_TIMEOUT_MS ?? 1_200_000),
    transcoder: options.audioTranscoder ?? process.env.FEISHU_AGENT_AUDIO_TRANSCODER,
  });
  writeAudioNormalizeArtifact(paths, normalized);
  if (normalized.status !== "completed") {
    await hooks.progressReply?.(normalized.userMessage ?? "目前音频格式暂不支持自动转码。", "audio_normalized");
    await hooks.onStep?.("audio_normalized", "blocked", {
      artifact: audioNormalizePath(paths.artifactsDir),
      reason: normalized.reason ?? "audio_normalize_failed",
      rawMediaExternalUpload: false,
    });
    return { ...normalized, rawMediaExternalUpload: false };
  }
  const normalizedPaths = normalized.normalizedAudios.map((item) => item.normalizedPath);
  await hooks.onStep?.("audio_normalized", "completed", {
    artifact: audioNormalizePath(paths.artifactsDir),
    audioCount: normalizedPaths.length,
    targetSpec: TARGET_AUDIO_SPEC,
    transcoder: normalized.transcoder?.tool ?? null,
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

async function ensureCloudAsr(task, paths, options, hooks, audios, providerConfig) {
  const key = audioCacheKey(audios, {
    provider: providerConfig.provider,
    model: providerConfig.model,
    fileModel: providerConfig.fileModel,
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
    transcoder: options.audioTranscoder ?? process.env.FEISHU_AGENT_AUDIO_TRANSCODER,
  });
  writeAudioNormalizeArtifact(paths, {
    ...normalized,
    provider: providerConfig.provider,
    rawMediaExternalUpload: true,
    reason: normalized.status === "completed" ? "cloud_asr_format_retry_normalized" : normalized.reason,
  });
  if (normalized.status !== "completed") {
    await hooks.onStep?.("audio_normalized", "blocked", {
      artifact: audioNormalizePath(paths.artifactsDir),
      reason: normalized.reason ?? "audio_normalize_failed",
      rawMediaExternalUpload: true,
    });
    return { ...normalized, rawMediaExternalUpload: true };
  }
  const normalizedPaths = normalized.normalizedAudios.map((item) => item.normalizedPath);
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

  const fallbackAllowed = providerConfig.fallbackProvider === "local_qwen3" && !["cloud_asr_api_key_missing", "cloud_asr_auth_failed"].includes(cloud.reason);
  if (!fallbackAllowed) return cloud;

  await hooks.onStep?.("asr_provider_fallback_used", "running", {
    from: providerConfig.provider,
    to: "local_qwen3",
    primaryReason: cloud.reason,
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

function readTextIfAvailable(path, maxChars = 30000) {
  if (!path || !existsSync(path)) return "";
  return readFileSync(path, "utf8").slice(0, maxChars);
}

function readWorkspaceTextIfAvailable(path, maxChars = 30000) {
  if (!path) return "";
  const candidates = [
    path,
    isAbsolute(path) ? path : resolve(workspaceDir, path),
    isAbsolute(path) ? path : resolve(process.cwd(), path),
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

function documentTitleForFallback(docType) {
  const prefix = DOC_TITLE_PREFIX[docType] ?? cleanTitlePart(docType, "文档");
  const focus = DOC_TITLE_FOCUS[docType] ?? "文档输出";
  return docType === "meeting-minutes"
    ? `${prefix}｜待确认项目｜${focus}｜待确认`
    : `${prefix}｜待确认项目｜${focus}`;
}

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

function stripExtensionForTitle(fileName) {
  return cleanTitlePart(String(fileName ?? "").split(/[\\/]/).pop() ?? "", "");
}

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

function extractFirstMarkdownH1(text) {
  return String(text ?? "").match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() ?? "";
}

function projectTitleFromDocumentTitle(title) {
  const raw = String(title ?? "").trim();
  if (!raw || looksLikeGenericUploadName(raw)) return "";
  const parts = raw.split(/[｜|]/).map((part) => cleanTitlePart(part, "")).filter(Boolean);
  if (parts.length >= 2 && /^(PRD|技术架构|运营方案|客户需求确认表|会议纪要)$/i.test(parts[0])) {
    return looksLikeGenericUploadName(parts[1]) ? "" : parts[1];
  }
  const withoutDocType = raw
    .replace(/^(PRD|技术架构|运营方案|客户需求确认表|会议纪要)[：:\s｜|-]*/i, "")
    .replace(/[｜|]\s*(产品化方案|技术实现方案|运营落地方案|需求澄清|会议讨论|待确认)\s*$/i, "");
  const cleaned = cleanTitlePart(withoutDocType, "");
  return cleaned && !looksLikeGenericUploadName(cleaned) ? cleaned : "";
}

function inferProjectTitleFromSourceBody(source) {
  const text = readWorkspaceTextIfAvailable(source.extractedTextPath ?? source.sourcePath, 20000);
  const h1 = extractFirstMarkdownH1(text);
  return projectTitleFromDocumentTitle(h1);
}

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

function inferProjectTitleFromSources(sources) {
  for (const source of sources) {
    const candidate = inferProjectTitleFromSourceBody(source);
    if (candidate) return { title: candidate, source: "source_heading" };
  }
  for (const source of sources) {
    const candidate = stripExtensionForTitle(source.fileName ?? source.basename ?? source.source ?? source.type);
    if (candidate && !looksLikeGenericUploadName(candidate) && !/^(audio|file|source|text|markdown|pdf)$/i.test(candidate)) {
      return { title: candidate, source: "source_filename" };
    }
  }
  return { title: "", source: "" };
}

function buildDocumentTitlePlan(task, requestedDocuments, sources, documentIdentity = null) {
  const userPrompt = task.sourceEvent?.message?.text ?? "";
  const userPromptPreview = cleanPromptForTitle(userPrompt).slice(0, 160);
  if (documentIdentity?.titleByDocType && typeof documentIdentity.titleByDocType === "object") {
    const projectTitle = cleanTitlePart(documentIdentity.normalizedTitleBase ?? documentIdentity.projectName ?? documentIdentity.subject, "待确认项目");
    const documents = requestedDocuments.map((docType) => {
      const identityTitle = documentIdentity.titleByDocType?.[docType] ?? {};
      const prefix = DOC_TITLE_PREFIX[docType] ?? cleanTitlePart(docType, "文档");
      const focus = DOC_TITLE_FOCUS[docType] ?? "文档输出";
      const title = looksLikeGenericUploadName(identityTitle.title)
        ? (docType === "meeting-minutes" ? `${prefix}｜${projectTitle}｜${focus}｜待确认` : `${prefix}｜${projectTitle}｜${focus}`)
        : identityTitle.title;
      return {
        docType,
        title,
        feishuFileName: identityTitle.feishuFileName ?? safeFileName(title),
        titleBasis: {
          projectTitle,
          focus,
          source: "document_identity",
          identityBasis: identityTitle.identityBasis ?? documentIdentity.basis ?? [],
          identityConfidence: identityTitle.identityConfidence ?? documentIdentity.confidence ?? "low",
          sourceTitle: documentIdentity.sourceTitle ?? null,
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
      documentIdentity,
      documents,
      rawSecretsReturned: false,
    };
  }
  const promptProject = inferProjectTitleFromPrompt(userPrompt);
  const sourceProject = inferProjectTitleFromSources(sources);
  const projectTitle = cleanTitlePart(promptProject || sourceProject.title, "待确认项目");
  const documents = requestedDocuments.map((docType) => {
    const prefix = DOC_TITLE_PREFIX[docType] ?? cleanTitlePart(docType, "文档");
    const focus = DOC_TITLE_FOCUS[docType] ?? "文档输出";
    const title = docType === "meeting-minutes"
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

function isDocumentRevisionTask(task) {
  return task?.taskIntent?.executionProfile === "document_revision" ||
    task?.taskIntent?.operation === "document_revision" ||
    task?.taskIntent?.taskType === "document_revision" ||
    task?.taskIntent?.sourcePreparation?.operation === "document_revision";
}

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

function normalizeMatchText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。、“”‘’；：！？,.()[\]{}<>《》:;!?'"`~_-]+/g, "");
}

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

function bodyAnchorPreview(text, quote) {
  const source = String(text ?? "");
  const query = String(quote ?? "");
  const index = query ? source.indexOf(query) : -1;
  if (index < 0) return query.slice(0, 300);
  const start = Math.max(0, index - 120);
  const end = Math.min(source.length, index + query.length + 120);
  return source.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 360);
}

function matchApiCommentToBody(comment, bodyText) {
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

function exportedSignalToComment(signal, source) {
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

function summarizeMatchedComments(comments, sourceDocuments = []) {
  const totalComments = comments.length;
  const matchedExact = comments.filter((comment) => comment.matchStatus === "exact_unique").length;
  const weakMatched = comments.filter((comment) => ["exact_multiple", "fuzzy"].includes(comment.matchStatus)).length;
  const unmatched = comments.filter((comment) => comment.matchStatus === "unmatched").length;
  const exportedBodyDetected = comments.filter((comment) => comment.matchStatus === "exported_body_detected").length;
  const sourcesWithUnavailableComments = sourceDocuments
    .filter((source) => !["cli", "sdk"].includes(String(source.commentAccess?.method ?? "")))
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

async function buildReviewContext(task, paths, sources, contexts, options = {}) {
  const userInstruction = cleanUserPrompt(task.sourceEvent?.message?.text ?? "");
  const apiContext = await fetchFeishuDocumentReviewContext({
    task,
    contexts,
    runCommand,
    options: {
      dryRun: options.dryRun === true,
      timeoutMs: options.cliTimeoutMs,
    },
  });
  const apiSourceResults = new Map((apiContext.sourceResults ?? []).map((item) => [item.sourceId, item]));
  const sourceDocuments = contexts.map((context, index) => {
    const sourceId = `file-${String(index + 1).padStart(2, "0")}`;
    const attachment = task.attachments?.[index] ?? {};
    const text = readTextIfAvailable(context.extractedTextPath, 30000) || String(context.contextPreview ?? "").slice(0, 30000);
    const apiSource = apiSourceResults.get(sourceId) ?? {};
    const detectedReviewSignals = extractReviewSignals(text);
    const apiComments = Array.isArray(apiSource.comments) ? apiSource.comments : [];
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
      replyCount: apiSource.replyCount ?? comments.reduce((sum, comment) => sum + (comment.replyCount ?? 0), 0),
      unresolvedCount: apiSource.unresolvedCount ?? comments.filter((comment) => comment.isSolved === false || comment.isSolved == null).length,
      plannedCommands: apiSource.plannedCommands ?? [],
      errors: apiSource.errors ?? [],
      exportedBodyDetectedCount: comments.filter((comment) => comment.matchStatus === "exported_body_detected").length,
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

function titlePlanForDoc(titlePlan, docType) {
  return titlePlan?.documents?.find((item) => item.docType === docType) ?? null;
}

function extractMarkdownH1(markdown) {
  return markdown.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() ?? "";
}

function isGenericTitle(title, docType) {
  const text = String(title ?? "").trim();
  if (!text) return true;
  if (/Mock\s+/i.test(text)) return true;
  if (looksLikeGenericUploadName(text)) return true;
  if (/产品\/项目名称或待确认|系统\/项目名称或待确认|客户\/项目名称或待确认/.test(text)) return true;
  if (docType === "meeting-minutes" && /^会议纪要｜参会方｜会议讨论｜待确认$/.test(text)) return true;
  return false;
}

function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function cleanHtmlTableCell(value) {
  return decodeHtmlEntities(value)
    .replace(/<br\s*\/?>/gi, "； ")
    .replace(/<\/?(b|strong|em|i|p|span|div)[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlTableToMarkdown(tableHtml) {
  const rows = [...String(tableHtml ?? "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((rowMatch) => [...rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((cellMatch) => cleanHtmlTableCell(cellMatch[1])))
    .filter((cells) => cells.length > 0);
  if (rows.length === 0) return tableHtml;
  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) => Array.from({ length: columnCount }, (_, index) => row[index] ?? ""));
  const header = normalizedRows[0];
  const separator = Array.from({ length: columnCount }, () => "---");
  const body = normalizedRows.slice(1);
  return [header, separator, ...body].map((row) => `| ${row.join(" | ")} |`).join("\n");
}

function normalizeMarkdownTables(markdown) {
  return String(markdown ?? "").replace(/<table\b[\s\S]*?<\/table>/gi, (tableHtml) => htmlTableToMarkdown(tableHtml));
}

function syncMarkdownTitle(markdown, title) {
  const body = normalizeMarkdownTables(markdown).trim();
  if (!body) return `# ${title}\n`;
  if (/^#\s+.+?\s*$/m.test(body)) {
    return body.replace(/^#\s+.+?\s*$/m, `# ${title}`);
  }
  return `# ${title}\n\n${body}`;
}

async function buildEvidencePack(task, paths, options = {}) {
  const sourcePreparation = task.taskIntent?.sourcePreparation ?? {};
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
    const sourceSummary = (evidence?.sources ?? []).map((source, index) => ({
      sourceId: `audio-${String(index + 1).padStart(2, "0")}`,
      type: source.type ?? "audio_transcript",
      fileName: source.basename ?? null,
      durationSec: source.durationSec,
      chunkCount: source.chunkCount,
      privacy: source.privacy,
    }));
    sources.push(...sourceSummary);
  }

  const reviewContext = isDocumentRevisionTask(task) ? await buildReviewContext(task, paths, sources, contexts, options) : null;
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
    operation: isDocumentRevisionTask(task) ? "document_revision" : requestedDocuments.includes("meeting-minutes") ? "meeting_minutes" : "create_document",
    sectionsPerUnit: options.sectionsPerUnit ?? options.sectionsPerBatch ?? 2,
  }, paths, options, executionProfileForTask(task)?.id ?? "");
  const titlePlan = buildDocumentTitlePlan(task, requestedDocuments, sources, sourceContext.documentIdentity);
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
    sourceCount: sourceContext.evidenceSummary?.sourceCount ?? sources.length,
    segmentCount: sourceContext.evidenceSummary?.segmentCount ?? 0,
    audioSegmentCount: sourceContext.evidenceSummary?.audioSegmentCount ?? 0,
    sources: sourceContext.evidenceSummary?.sourceSummary ?? sources,
    contextPlane: {
      schemaVersion: sourceContext.schemaVersion ?? "source-context-v1",
      manifestPath: workspaceRelative(sourceContext.manifestPath),
      sourceRecordsPath: workspaceRelative(sourceContext.sourceRecordsPath),
      sourceSegmentsPath: workspaceRelative(sourceContext.sourceSegmentsPath),
      sourceStructurePath: workspaceRelative(sourceContext.sourceStructurePath),
      retrievalPlanPath: workspaceRelative(sourceContext.retrievalPlanPath),
      gatePath: workspaceRelative(sourceContext.gatePath),
      workUnitCount: sourceContext.workUnits?.length ?? 0,
      contextGate: sourceContext.gate ?? null,
      documentIdentity: sourceContext.documentIdentity ?? null,
      sourceStructureSummary: sourceContext.sourceStructureSummary ?? null,
      outputContract: sourceContext.outputContract ?? null,
      fullRawContentIncluded: false,
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
    sourceMediaExternalUpload: false,
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
    fullRawContentIncluded: false,
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
      fullRawContentIncluded: false,
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
    },
    titlePlan,
    reviewContext,
    sourceContext,
  };
}

function extractTitle(markdown) {
  return extractMarkdownH1(markdown);
}

function modelRoutePath(paths) {
  return join(paths.runDir, "model-route.json");
}

function pipelineMockModelEnabled(options) {
  return options.pipelineMockModel === true || /^(1|true|yes|on)$/i.test(process.env.FEISHU_AGENT_PIPELINE_MOCK_MODEL ?? "");
}

function directOutput(status, summary, details = {}, artifacts = [], executionProfile = null) {
  const output = {
    status,
    summary: redactString(summary).slice(0, 3500),
    documents: [],
    artifacts,
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  };
  if (executionProfile) output.executionProfile = executionProfile;
  if (Object.keys(details).length > 0) output.details = sanitize(details);
  return output;
}

function cleanGeneratedText(text, fallback) {
  const cleaned = redactString(String(text ?? "").trim()).replace(/\n{3,}/g, "\n\n").trim();
  return (cleaned || fallback).slice(0, 3500).trim();
}

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

function fileSummaryPolicy(profileConfig = {}) {
  return {
    ...DEFAULT_FILE_SUMMARY_CONTEXT_POLICY,
    ...(profileConfig.contextPolicy ?? {}),
  };
}

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

function appendWithinBudget(parts, text, budget) {
  const value = String(text ?? "");
  if (!value) return budget;
  const clipped = value.slice(0, Math.max(0, budget));
  if (clipped) parts.push(clipped);
  return Math.max(0, budget - clipped.length);
}

function buildFileSummaryContext(task, paths, profileConfig = {}) {
  const policy = fileSummaryPolicy(profileConfig);
  const contexts = (Array.isArray(task.fileContexts?.contexts) ? task.fileContexts.contexts : [])
    .filter((context) => context?.status === "ready")
    .slice(0, policy.maxSources);
  const sources = contexts.map((context, index) => {
    const externalLlmAllowed = context.externalLlmAllowed !== false;
    const preview = externalLlmAllowed
      ? redactString(String(context.contextPreview ?? "").slice(0, policy.previewCharsPerSource))
      : "";
    const extractedText = externalLlmAllowed ? readTextIfAvailable(context.extractedTextPath, policy.extractedSliceChars * Math.max(1, policy.maxExtractedSlicesPerSource) * 4) : "";
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
    fullRawContentIncluded: false,
  };
  writeJson(fileSummaryContextPath(paths.artifactsDir), fileContext);
  return fileContext;
}

function renderFileSummaryPrompt(task, fileContext) {
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
  let budget = Number(fileContext.contextPolicy?.maxPromptChars ?? DEFAULT_FILE_SUMMARY_CONTEXT_POLICY.maxPromptChars);
  for (const source of fileContext.sources ?? []) {
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
    if (!source.externalLlmAllowed) {
      sourceParts.push("Text evidence omitted because this source is not allowed for external LLM use.", "");
    } else {
      if (source.preview) sourceParts.push("#### Preview", "", source.preview, "");
      for (const slice of source.extractedSlices ?? []) {
        sourceParts.push(`#### Extracted Slice: ${slice.label}`, "", slice.text, "");
      }
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
  return parts.join("\n").slice(0, Number(fileContext.contextPolicy?.maxPromptChars ?? DEFAULT_FILE_SUMMARY_CONTEXT_POLICY.maxPromptChars) + 2000);
}

function generationCandidate(routePlan, executionProfile, options) {
  if (pipelineMockModelEnabled(options)) {
    return { provider: "mock", model: `mock-${safeSegment(executionProfile, "fast-answer")}`, strength: "test" };
  }
  return routePlan?.selected ?? null;
}

async function planFastDraftRoute(task, paths, options, hooks, executionProfile, profileConfig = {}) {
  const routePlan = await callRuntimeTool("model_route_plan", {
    taskType: profileConfig.routeTaskType ?? "fast_draft",
    reasoningDepth: profileConfig.reasoningDepth ?? "fast",
    privacyBoundarySatisfied: true,
  }, paths, options);
  const candidate = generationCandidate(routePlan, executionProfile, options);
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
    selectedProvider: candidate?.provider ?? routePlan.selected?.provider ?? null,
    selectedModel: candidate?.model ?? routePlan.selected?.model ?? null,
    executionProfile,
  });
  return { routePlan, candidate };
}

async function generateDirectReply({ task, paths, options, hooks, executionProfile, profileConfig, prompt, systemPrompt, maxTokens, mockResponse }) {
  const { routePlan, candidate } = await planFastDraftRoute(task, paths, options, hooks, executionProfile, profileConfig);
  if (routePlan.status !== "selected" || !candidate) {
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
    modelRoute: candidate.provider === "mock" ? undefined : routePlan,
  }, paths, options, executionProfile);
  await hooks.onStep?.("model_text_generated", generation.status === "completed" ? "completed" : generation.status ?? "blocked", {
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
    details: sanitize(details),
  };
}

export async function runTaskExecutionPipeline(task, paths, options = {}) {
  const profile = executionProfileForTask(task);
  const executionProfile = profile?.id ?? "unknown";
  if (executionProfile === "fast_answer") return runFastAnswerPipeline(task, paths, options, profile.config);
  if (executionProfile === "file_summary") return runFileSummaryPipeline(task, paths, options, profile.config);
  if (FULL_DOCUMENT_EXECUTION_PROFILES.has(executionProfile)) return runFullDocumentPipeline(task, paths, options, profile.config);

  const output = directOutput("blocked", "当前执行 profile 不支持任务执行 Runner。", {
    reason: "execution_profile_not_runner_eligible",
    executionProfile,
  }, [], executionProfile);
  writeJson(paths.agentOutputPath, output);
  return { status: "blocked", output, mode: "task-execution-runner", rawSecretsReturned: false };
}

async function runFastAnswerPipeline(task, paths, options = {}, profileConfig = {}) {
  const hooks = {
    onStep: options.onStep,
    onMetric: options.onMetric,
    progressReply: options.progressReply,
  };
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
      return generated;
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
    return { status: "completed", output, mode: "task-execution-runner", rawSecretsReturned: false };
  } catch (error) {
    const output = directOutput("failed", "任务处理失败，可重试。", {
      reason: "fast_answer_runner_failed",
      error: error instanceof Error ? error.message : String(error),
    }, [], executionProfile);
    writeJson(paths.agentOutputPath, output);
    await hooks.onStep?.("task_execution_runner_completed", "failed", { artifact: paths.agentOutputPath, reason: "fast_answer_runner_failed", executionProfile });
    return { status: "failed", output, mode: "task-execution-runner", rawSecretsReturned: false };
  }
}

async function runFileSummaryPipeline(task, paths, options = {}, profileConfig = {}) {
  const hooks = {
    onStep: options.onStep,
    onMetric: options.onMetric,
    progressReply: options.progressReply,
  };
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
      return { status: "blocked", output, mode: "task-execution-runner", rawSecretsReturned: false };
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
      return generated;
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
    return { status: "completed", output, mode: "task-execution-runner", rawSecretsReturned: false };
  } catch (error) {
    const output = directOutput("failed", "任务处理失败，可重试。", {
      reason: "file_summary_runner_failed",
      error: error instanceof Error ? error.message : String(error),
    }, [], executionProfile);
    writeJson(paths.agentOutputPath, output);
    await hooks.onStep?.("task_execution_runner_completed", "failed", { artifact: paths.agentOutputPath, reason: "file_summary_runner_failed", executionProfile });
    return { status: "failed", output, mode: "task-execution-runner", rawSecretsReturned: false };
  }
}

async function runFullDocumentPipeline(task, paths, options = {}, profileConfig = {}) {
  const hooks = {
    onStep: options.onStep,
    onMetric: options.onMetric,
    progressReply: options.progressReply,
  };
  const outputRoot = dirname(paths.runDir);
  const executionProfile = executionProfileForTask(task)?.id ?? null;
  try {
    await hooks.onStep?.("task_execution_runner_started", "running", { taskType: task.taskIntent?.taskType, executionProfile, runnerRole: "stage_execution_only" });
    const requestedDocuments = Array.isArray(task.taskIntent?.requestedDocuments) && task.taskIntent.requestedDocuments.length > 0
      ? task.taskIntent.requestedDocuments
      : ["meeting-minutes"];
    const requiresLocalAsr = task.taskIntent?.requiresAsr === true || task.taskIntent?.requiresLocalAsr === true;
    let asr = { status: "skipped", reason: "no_audio_sources" };
    if (requiresLocalAsr) {
      asr = await ensureAsrTranscription(task, paths, options, hooks);
      if (asr.status !== "completed") {
        const output = blockedOutput(asr.userMessage ?? userMessageForAsrFailure(asr), asr);
        writeJson(paths.agentOutputPath, output);
        return { status: "blocked", output, mode: "task-execution-runner", rawSecretsReturned: false };
      }
    }
    const revisionMode = isDocumentRevisionTask(task);
    const documentQualityMode = String(options.documentQualityMode ?? process.env.FEISHU_AGENT_DOCUMENT_QUALITY_MODE ?? "stable").toLowerCase();
    const workflowSectionsPerBatch = documentQualityMode === "stable" ? 2 : 3;
    const { evidenceSummary, titlePlan, reviewContext, sourceContext } = await buildEvidencePack(task, paths, {
      ...options,
      sectionsPerUnit: workflowSectionsPerBatch,
    });
    await hooks.onStep?.("evidence_pack_built", "completed", {
      artifact: evidencePackPath(paths.artifactsDir),
      sourceCount: evidenceSummary.sourceCount,
      segmentCount: evidenceSummary.segmentCount ?? 0,
      contextManifest: sourceContext?.manifestPath ?? null,
      contextGateStatus: sourceContext?.gate?.status ?? null,
      requestedDocuments,
      operation: revisionMode ? "document_revision" : null,
    });
    if (sourceContext?.status === "blocked" || sourceContext?.gate?.status === "blocked") {
      const output = blockedOutput("上下文准备未通过，暂时无法生成文档。", {
        reason: sourceContext.reason ?? sourceContext.gate?.reason ?? "source_context_blocked",
        contextGate: sourceContext.gate ?? null,
        contextManifest: sourceContext.manifestPath ?? null,
      });
      writeJson(paths.agentOutputPath, output);
      return { status: "blocked", output, mode: "task-execution-runner", rawSecretsReturned: false };
    }
    if (revisionMode) {
      await hooks.onStep?.("review_context_built", "completed", {
        artifact: reviewContextPath(paths.artifactsDir),
        status: reviewContext?.status ?? "missing",
        commentCount: reviewContext?.comments?.length ?? 0,
      });
    }

    const planner = await callRuntimeTool("planner_envelope_plan", {
      goal: revisionMode ? "基于飞书文档正文和批注/修改上下文修订既有办公文档并发布" : "基于飞书多源上下文生成用户请求的办公文档并发布",
      taskType: task.taskIntent?.taskType ?? "document_pipeline",
      taskDescription: cleanUserPrompt(task.sourceEvent?.message?.text ?? ""),
      requestedOutputs: requestedDocuments,
      availableArtifacts: [
        workspaceRelative(evidencePackPath(paths.artifactsDir)),
        revisionMode ? workspaceRelative(reviewContextPath(paths.artifactsDir)) : null,
        existsSync(transcriptPath(paths.artifactsDir)) ? workspaceRelative(transcriptPath(paths.artifactsDir)) : null,
        existsSync(evidenceIndexPath(paths.artifactsDir)) ? workspaceRelative(evidenceIndexPath(paths.artifactsDir)) : null,
      ].filter(Boolean),
      successCriteria: revisionMode
        ? ["批注/修改意图被覆盖", "修订后文档完整输出", "QA Gate 通过", "Policy Gate 通过", "最终发布/回复"]
        : ["请求文档生成", "QA Gate 通过", "Policy Gate 通过", "最终发布/回复"],
      constraints: ["原始音频不得外发", "模型选择必须走 Model Router", "文档结构必须来自 Prompt Registry 和 Document Worker", "多源冲突按来源标注并列入待确认", "document_revision 只能作为 prompt overlay 和 review-context，不得新增第二编排层"],
    }, paths, options);
    await callRuntimeTool("planner_envelope_write", { runId: task.runId, envelope: planner, outputRoot }, paths, options);
    await hooks.onStep?.("planner_envelope_completed", planner.status === "blocked" ? "blocked" : "completed", { artifact: join(paths.runDir, "planner-envelope.json") });

    const primaryDoc = requestedDocuments[0] ?? "document";
    const routeTaskType = primaryDoc === "meeting-minutes" && requestedDocuments.length === 1 ? "meeting_minutes" : "document_shard";
    const routePlan = await callRuntimeTool("model_route_plan", {
      taskType: routeTaskType,
      docType: primaryDoc,
      reasoningDepth: requestedDocuments.some((doc) => ["meeting-minutes", "prd", "tech-architecture", "ops-plan", "customer-requirement-checklist"].includes(doc)) ? "deep" : "fast",
      privacyBoundarySatisfied: true,
    }, paths, options);
    await callRuntimeTool("model_route_record", { runId: task.runId, route: routePlan, outputRoot }, paths, options);
    await hooks.onStep?.("model_route_planned", routePlan.status === "selected" ? "completed" : "blocked", {
      artifact: join(paths.runDir, "model-route.json"),
      selectedProvider: routePlan.selected?.provider ?? null,
      selectedModel: routePlan.selected?.model ?? null,
    });
    if (routePlan.status !== "selected") {
      const output = blockedOutput("上下文已准备完成，但当前没有可用模型生成文档。", routePlan);
      writeJson(paths.agentOutputPath, output);
      return { status: "blocked", output, mode: "task-execution-runner", rawSecretsReturned: false };
    }

    const workItemsResult = await callRuntimeTool("document_prompt_render_batch", {
      documents: requestedDocuments,
      routerConclusion: {
        selectedDocuments: requestedDocuments,
        operation: revisionMode ? "document_revision" : "create_document",
        reasoningDepth: requestedDocuments.some((doc) => ["meeting-minutes", "prd", "tech-architecture", "ops-plan", "customer-requirement-checklist"].includes(doc)) ? "deep" : "fast",
        modelRouteTaskType: routeTaskType,
        selectedModel: routePlan.selected,
        reason: revisionMode ? "用户要求基于飞书文档和批注/修改内容修订既有文档；文档类型仍由 prompt registry 映射，revision overlay 只提供修订约束。" : "用户要求基于多源上下文生成指定办公文档；文档类型由 prompt registry 映射。",
      },
      evidenceSummary,
      contextEnvelopeRef: sourceContext?.manifestPath,
      workUnits: sourceContext?.workUnits ?? [],
      operation: revisionMode ? "document_revision" : undefined,
      reviewContext: revisionMode ? evidenceSummary.reviewContext : undefined,
    }, paths, options);
    if (!Array.isArray(workItemsResult.documentWorkItems) || workItemsResult.documentWorkItems.length === 0) {
      const output = blockedOutput("上下文已准备完成，但文档 work item 准备失败。", workItemsResult);
      writeJson(paths.agentOutputPath, output);
      return { status: "blocked", output, mode: "task-execution-runner", rawSecretsReturned: false };
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
    await hooks.onStep?.("document_workers_planned", workerPlan.status === "ready" ? "completed" : "blocked", { tasks: workerPlan.tasks?.length ?? 0 });

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
    const results = Array.isArray(workerRun.results) ? workerRun.results : [];
    const completedResults = results.filter((result) => result?.markdown && ["completed", "needs_fix"].includes(String(result.status)));
    const generatedStepName = requestedDocuments.length === 1 && requestedDocuments[0] === "meeting-minutes" ? "meeting_minutes_generated" : "documents_generated";
    await hooks.onStep?.(generatedStepName, workerRun.status === "completed" ? "completed" : workerRun.status ?? "blocked", {
      artifact: completedResults.length > 0 ? "agent-output-pending" : null,
      modelRoutePath: workerRun.modelRoutePath ?? join(paths.runDir, "model-route.json"),
      documentCount: completedResults.length,
      sectionBatches: completedResults.reduce((sum, result) => sum + (result?.sectionBatches?.length ?? 0), 0),
      traceRoot: workerRun.traceRoot ?? join(paths.runDir, "artifacts", "model-streams", "document_workers_run"),
      attemptCount: workerRun.attemptCount ?? results.reduce((sum, result) => sum + (result?.sectionAttempts ?? []).reduce((inner, attempt) => inner + (attempt?.attemptFailures?.length ?? 0), 0), 0),
      partialCount: workerRun.partialCount ?? results.filter((result) => result?.markdown && result?.status === "blocked").length,
      lastAttempt: workerRun.lastAttempt ?? null,
      timeoutBudgetMs: workerRun.timeoutBudgetMs ?? workerDeadline.runtimeBudgetMs,
      workflow: workerRun.workflow ?? null,
      finalFailureReport: workerRun.finalFailureReport ?? null,
    });
    if (completedResults.length === 0) {
      const finalFailureReport = finalFailureReportFromWorkerRun(workerRun);
      const output = blockedOutput(finalFailureSummary(finalFailureReport), {
        ...workerRun,
        finalFailureReport,
      });
      writeJson(paths.agentOutputPath, output);
      return { status: "blocked", output, mode: "task-execution-runner", rawSecretsReturned: false };
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
      return { status: "blocked", output, mode: "task-execution-runner", rawSecretsReturned: false };
    }
    await hooks.progressReply?.("文档生成完成，正在检查并发布。", generatedStepName);

    const qaDocumentOutputs = completedResults.map((result, index) => {
      const docType = result.docType ?? requestedDocuments[index] ?? "document";
      const planned = titlePlanForDoc(titlePlan, docType);
      const generatedTitle = extractTitle(result.markdown);
      return {
        ...result.qaInput,
        docType,
        title: planned?.title ?? generatedTitle,
        markdownTitle: generatedTitle,
        targetTitle: planned?.title ?? null,
        titleBasis: planned?.titleBasis ?? null,
        documentIdentity: sourceContext?.documentIdentity ?? null,
        outputContract: sourceContext?.outputContract ?? null,
        sourceStructureSummary: sourceContext?.sourceStructureSummary ?? null,
        sourceStructurePath: workspaceRelative(sourceContext?.sourceStructurePath),
        contextManifest: workspaceRelative(sourceContext?.manifestPath),
        contextPackIds: result.contextPackIds ?? result.qaInput?.contextPackIds ?? [],
        sourceBlockIds: result.sourceBlockIds ?? result.qaInput?.sourceBlockIds ?? [],
        tableBlockCount: Number(result.tableBlockCount ?? result.qaInput?.tableBlockCount ?? 0),
        outputContractVersion: result.outputContractVersion ?? result.qaInput?.outputContractVersion ?? sourceContext?.outputContract?.outputContractVersion ?? "document-output-contract-v1",
        markdown: result.markdown,
      };
    });

    const qaGate = await callRuntimeTool("qa_gate_evaluate", {
      publishIntent: true,
      checks: {
        privacy: { rawMediaExternalUpload: false, rawSecretsReturned: false, rawTranscriptInLongTermMemory: false },
        contextBudget: { rawTranscriptInMainContext: false },
        topicCoverage: { omittedMacroTopics: [] },
        entitySafety: { unsupportedEntities: [], crossMeetingTerms: [], ambiguousTermExpansions: [] },
        reviewContext: revisionMode
          ? {
              required: true,
              status: reviewContext?.status ?? "missing",
              artifact: workspaceRelative(reviewContextPath(paths.artifactsDir)),
              commentAccess: reviewContext?.commentAccess ?? null,
              matchSummary: reviewContext?.matchSummary ?? null,
              sourceDocuments: reviewContext?.sourceDocuments?.map((source) => ({
                sourceId: source.sourceId,
                commentAccess: source.commentAccess,
                commentCount: source.comments?.length ?? 0,
                comments: (source.comments ?? []).map((comment) => ({
                  sourceId: comment.sourceId,
                  commentId: comment.commentId,
                  matchStatus: comment.matchStatus,
                  matchReason: comment.matchReason,
                })),
              })) ?? [],
              independentCommentThreadsRead: reviewContext?.commentAccess?.method === "cli" || reviewContext?.commentAccess?.method === "sdk",
              unavailableMustBeDisclosed: reviewContext?.commentAccess?.method !== "cli" && reviewContext?.commentAccess?.method !== "sdk",
            }
          : null,
        contextManifest: workspaceRelative(sourceContext?.manifestPath),
        documentIdentity: sourceContext?.documentIdentity ?? null,
        outputContract: sourceContext?.outputContract ?? null,
        sourceStructureSummary: sourceContext?.sourceStructureSummary ?? null,
        documentOutputs: qaDocumentOutputs,
      },
    }, paths, options);
    await callRuntimeTool("qa_gate_write", { runId: task.runId, gate: qaGate, outputRoot }, paths, options);
    await hooks.onStep?.("qa_gate_completed", qaGate.status === "pass" ? "completed" : qaGate.status ?? "blocked", { artifact: join(paths.runDir, "qa-gate.json"), status: qaGate.status });

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
    }, paths, options);
    await callRuntimeTool("policy_gate_write", { runId: task.runId, decision: policyGate, outputRoot }, paths, options);
    await hooks.onStep?.("policy_gate_completed", policyGate.status === "pass" ? "completed" : policyGate.status ?? "blocked", { artifact: join(paths.runDir, "policy-gate.json"), status: policyGate.status });

    const publishable = qaGate.status === "pass" && policyGate.status === "pass" && completedResults.every((result) => result.status === "completed");
    const documents = completedResults.map((result, index) => {
      const docType = result.docType ?? requestedDocuments[index] ?? "document";
      const planned = titlePlanForDoc(titlePlan, docType);
      const generatedTitle = extractTitle(result.markdown);
      const title = planned?.title ?? (isGenericTitle(generatedTitle, docType) ? documentTitleForFallback(docType) : generatedTitle);
      const fileName = safeFileName(title);
      const markdown = syncMarkdownTitle(result.markdown, title);
      const localDocPath = join(paths.artifactsDir, fileName);
      writeText(localDocPath, markdown);
      return { docType, title, fileName, markdown, titleBasis: planned?.titleBasis ?? null, localPath: localDocPath };
    });
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
    const artifacts = [
      { kind: "evidence-pack", name: "evidence-pack.json", localPath: evidencePackPath(paths.artifactsDir) },
      revisionMode ? { kind: "review-context", name: "review-context.json", localPath: reviewContextPath(paths.artifactsDir) } : null,
      { kind: "document-title-plan", name: "document-title-plan.json", localPath: titlePlanPath(paths.artifactsDir) },
      lifecycleResult?.documentLifecyclePath ? { kind: "document-lifecycle", name: "document-lifecycle.json", localPath: lifecycleResult.documentLifecyclePath } : null,
      existsSync(audioNormalizePath(paths.artifactsDir)) ? { kind: "audio-normalize", name: "audio-normalize.json", localPath: audioNormalizePath(paths.artifactsDir) } : null,
      existsSync(asrSummaryPath(paths.artifactsDir)) ? { kind: "asr-summary", name: "summary.json", localPath: asrSummaryPath(paths.artifactsDir) } : null,
      { kind: "model-route", name: "model-route.json", localPath: join(paths.runDir, "model-route.json") },
      { kind: "qa-gate", name: "qa-gate.json", localPath: join(paths.runDir, "qa-gate.json") },
      { kind: "policy-gate", name: "policy-gate.json", localPath: join(paths.runDir, "policy-gate.json") },
    ].filter(Boolean);
    const gateFailureReport = publishable ? null : {
      schemaVersion: "document-workflow-final-failure-v1",
      terminalReason: qaGate.status !== "pass" ? "qa_gate_not_publishable" : "policy_gate_not_publishable",
      status: "needs_fix",
      completedDocs: completedResults.map((result) => result.docType).filter(Boolean),
      pendingDocs: [],
      failedStage: qaGate.status !== "pass" ? "qa_gate" : "policy_gate",
      retryCount: Number(workerRun?.workflow?.retryUnitsUsed ?? 0),
      retryExhausted: false,
      lastProviderAttempt: lastAttemptFromWorkerRun(workerRun),
      nextAction: qaGate.status !== "pass" ? "根据 QA issue 修订私有文档后再发布。" : "确认发布边界或用户授权后再发布。",
      publishPartial: false,
      rawSecretsReturned: false,
    };
    const output = {
      status: publishable ? "completed" : "needs_fix",
      summary: publishable ? `已基于 ${evidenceSummary.sourceCount} 个来源生成 ${documents.length} 份文档。` : finalFailureSummary(gateFailureReport),
      documents: publishable ? documents : [],
      qaGate,
      policyGate,
      artifacts,
      details: publishable ? undefined : { finalFailureReport: gateFailureReport },
      rawSecretsReturned: false,
      rawMediaExternalUpload: false,
    };
    writeJson(paths.agentOutputPath, output);
    await hooks.onStep?.("task_execution_runner_completed", output.status === "completed" ? "completed" : "needs_fix", { artifact: paths.agentOutputPath });
    return { status: output.status === "completed" ? "completed" : "needs_fix", output, mode: "task-execution-runner", rawSecretsReturned: false };
  } catch (error) {
    const output = blockedOutput("任务处理失败，可重试。", { reason: "task_execution_runner_failed", error: error instanceof Error ? error.message : String(error) });
    writeJson(paths.agentOutputPath, output);
    await hooks.onStep?.("task_execution_runner_completed", "failed", { artifact: paths.agentOutputPath, reason: "task_execution_runner_failed" });
    return { status: "failed", output, mode: "task-execution-runner", rawSecretsReturned: false };
  }
}
