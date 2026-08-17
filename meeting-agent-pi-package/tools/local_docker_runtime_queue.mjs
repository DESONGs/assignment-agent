import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(toolDir);
const workspaceDir = dirname(packageDir);

export const LOCAL_DOCKER_JOB_SCHEMA_VERSION = "local-docker-runtime-job-v1";
export const LOCAL_DOCKER_RESULT_SCHEMA_VERSION = "local-docker-runtime-result-v1";
export const LOCAL_DOCKER_WORKER_MODE_ENV = "FEISHU_AGENT_DOCUMENT_WORKER_MODE";
export const LOCAL_DOCKER_ELIGIBLE_PROFILES = new Set(["document_generation", "multi_source_synthesis"]);
const SECRET_KEY_PATTERN = /secret|cookie|session|authorization|(^|[_-])token($|[_-])|access_token|refresh_token|tenant_access_token|app_secret|client_secret|fileToken|file_token|fileKey|file_key|wikiToken|folderToken/i;
const SECRET_VALUE_PATTERN =
  /(app_secret|client_secret|refresh_token|access_token|authorization|cookie|session)\s*[:=]\s*["']?[^"',\s]+|bearer\s+[A-Za-z0-9._-]+/gi;

/**
 * @typedef {string | number | null | unknown[]} RedisValue
 * @typedef {{ value: RedisValue, offset: number }} RedisParseResult
 * @typedef {{
 *   documentWorkerMode?: unknown, dockerQueueHost?: unknown, dockerQueuePort?: unknown,
 *   dockerQueueName?: unknown, dockerResultKeyPrefix?: unknown,
 *   dockerWorkerWaitTimeoutMs?: unknown, dockerWorkerTimeoutMs?: unknown,
 *   dockerQueueMaxDepth?: unknown,
 *   onStep?: (name: string, status: string, details: Record<string, unknown>) => Promise<unknown> | unknown,
 *   [key: string]: unknown
 * }} DockerQueueOptions
 * @typedef {{ mode: string, host: string, port: number, queueName: string, resultKeyPrefix: string, waitTimeoutMs: number, queueMaxDepth: number }} DockerQueueConfig
 * @typedef {{ runDir: string, inputsDir: string, artifactsDir: string, statePath: string, agentOutputPath: string, [key: string]: string }} RuntimePaths
 */

/** @param {unknown} value @returns {Record<string, unknown>} */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

function nowIso() {
  return new Date().toISOString();
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

/** @param {string} path @param {unknown} value */
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sanitizeForDocker(value), null, 2)}\n`, "utf8");
  return path;
}

/** @param {string} path @returns {unknown} */
function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** @param {string | null | undefined} path */
function workspaceRelativePath(path) {
  if (!path) return null;
  const resolved = resolve(path);
  return isInside(workspaceDir, resolved) ? relative(workspaceDir, resolved) : null;
}

/** @param {unknown} value */
function redactString(value) {
  return String(value ?? "").replace(SECRET_VALUE_PATTERN, "[redacted]").slice(0, 20000);
}

/** @param {unknown} value @param {string} [key] @returns {unknown} */
export function sanitizeForDocker(value, key = "") {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeForDocker(item, key));
  if (value && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const output = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(entryKey)) {
        output[entryKey] = "[redacted]";
      } else {
        output[entryKey] = sanitizeForDocker(entryValue, entryKey);
      }
    }
    return output;
  }
  return value;
}

/** @param {unknown} event */
function boundedSourceEvent(event) {
  const sourceEvent = asRecord(event);
  const message = asRecord(sourceEvent.message);
  const sender = asRecord(sourceEvent.sender);
  return {
    schemaVersion: sourceEvent.schemaVersion ?? "feishu-event-v1",
    eventType: sourceEvent.eventType ?? null,
    source: sourceEvent.source ?? null,
    receivedAt: sourceEvent.receivedAt ?? null,
    message: {
      msgType: message.msgType ?? null,
      chatType: message.chatType ?? null,
      createTime: message.createTime ?? null,
      text: redactString(message.text ?? ""),
      attachments: [],
    },
    sender: {
      senderType: sender.senderType ?? null,
      senderIdHash: sender.senderId ? safeSegment(String(sender.senderId), "sender").slice(0, 16) : null,
    },
    rawSecretsReturned: false,
  };
}

/** @param {unknown} context */
function boundedFileContext(context) {
  const source = asRecord(context);
  const extractedPath = typeof source.extractedTextPath === "string" ? source.extractedTextPath : null;
  const extractedTextPath = workspaceRelativePath(extractedPath) ?? extractedPath;
  return {
    schemaVersion: source.schemaVersion ?? null,
    sourceId: source.sourceId ?? null,
    fileName: source.fileName ?? null,
    fileType: source.fileType ?? null,
    extension: source.extension ?? null,
    contextMode: source.contextMode ?? null,
    status: source.status ?? null,
    disclosurePlan: source.disclosurePlan ?? null,
    contextPreview: redactString(source.contextPreview ?? ""),
    extractedTextPath,
    extraction: source.extraction ?? null,
    externalLlmAllowed: source.externalLlmAllowed !== false,
    unsupportedReason: source.unsupportedReason ?? null,
    sourcePath: null,
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  };
}

/** @param {unknown} [sourcePreparation] */
function boundedSourcePreparation(sourcePreparation = {}) {
  const sourcePreparationRecord = asRecord(sourcePreparation);
  const sanitized = asRecord(sanitizeForDocker(sourcePreparationRecord));
  return {
    ...sanitized,
    sourceReferences: (Array.isArray(sourcePreparationRecord.sourceReferences) ? sourcePreparationRecord.sourceReferences : []).map((value, index) => {
      const source = asRecord(value);
      return ({
      sourceId: source.sourceId ?? `source-${String(index + 1).padStart(2, "0")}`,
      kind: source.kind ?? source.resourceType ?? null,
      fileName: source.fileName ?? source.name ?? null,
      sha256: source.sha256 ?? null,
      sourceKind: source.sourceKind ?? null,
      explicitFileReference: Boolean(source.explicitFileReference),
      resolvedFromCache: Boolean(source.resolvedFromCache),
      fileToken: "[redacted]",
      fileKey: "[redacted]",
      });
    }),
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  };
}

/** @param {unknown} task */
export function buildBoundedDockerTask(task) {
  const normalizedTask = asRecord(task);
  const taskIntentInput = asRecord(normalizedTask.taskIntent);
  const fileContextsInput = asRecord(normalizedTask.fileContexts);
  const taskIntent = {
    ...asRecord(sanitizeForDocker(taskIntentInput)),
    sourcePreparation: boundedSourcePreparation(taskIntentInput.sourcePreparation ?? {}),
  };
  const contexts = Array.isArray(fileContextsInput.contexts) ? fileContextsInput.contexts.map(boundedFileContext) : [];
  return {
    schemaVersion: "feishu-task-v1",
    dockerBoundedTaskSchemaVersion: "local-docker-bounded-task-v1",
    runId: normalizedTask.runId,
    status: "running",
    sourceEvent: boundedSourceEvent(normalizedTask.sourceEvent ?? {}),
    requestedAt: normalizedTask.requestedAt ?? nowIso(),
    executionMode: normalizedTask.executionMode,
    publishMode: "dry-run",
    replyMode: "silent",
    taskIntent,
    attachments: [],
    fileContexts: {
      schemaVersion: fileContextsInput.schemaVersion ?? "file-context-v1",
      generatedAt: fileContextsInput.generatedAt ?? null,
      contexts,
      rawSecretsReturned: false,
      rawMediaExternalUpload: false,
    },
    fileContextPath: null,
    agentTaskPath: workspaceRelativePath(typeof normalizedTask.agentTaskPath === "string" ? normalizedTask.agentTaskPath : null),
    agentOutputPath: workspaceRelativePath(typeof normalizedTask.agentOutputPath === "string" ? normalizedTask.agentOutputPath : null),
    qaGatePath: null,
    policyGatePath: null,
    publishPath: workspaceRelativePath(typeof normalizedTask.publishPath === "string" ? normalizedTask.publishPath : null),
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  };
}

/** @param {DockerQueueOptions} [options] */
function modeFromOptions(options = {}) {
  return String(options.documentWorkerMode ?? process.env[LOCAL_DOCKER_WORKER_MODE_ENV] ?? "host").trim().toLowerCase();
}

/** @param {DockerQueueOptions} [options] @returns {DockerQueueConfig} */
export function localDockerQueueConfig(options = {}) {
  return {
    mode: modeFromOptions(options),
    host: String(options.dockerQueueHost ?? process.env.FEISHU_AGENT_DOCKER_QUEUE_HOST ?? "127.0.0.1"),
    port: Number(options.dockerQueuePort ?? process.env.FEISHU_AGENT_DOCKER_QUEUE_PORT ?? 6379),
    queueName: String(options.dockerQueueName ?? process.env.FEISHU_AGENT_DOCKER_QUEUE_NAME ?? "pi:document-worker:jobs"),
    resultKeyPrefix: String(options.dockerResultKeyPrefix ?? process.env.FEISHU_AGENT_DOCKER_RESULT_KEY_PREFIX ?? "pi:document-worker:result"),
    waitTimeoutMs: Number(options.dockerWorkerWaitTimeoutMs ?? options.dockerWorkerTimeoutMs ?? process.env.FEISHU_AGENT_DOCKER_WORKER_WAIT_TIMEOUT_MS ?? process.env.FEISHU_AGENT_DOCKER_WORKER_TIMEOUT_MS ?? 1_200_000),
    queueMaxDepth: Number(options.dockerQueueMaxDepth ?? process.env.FEISHU_AGENT_DOCKER_QUEUE_MAX_DEPTH ?? 100),
  };
}

/** @param {DockerQueueOptions} [options] */
export function isLocalDockerDocumentWorkerEnabled(options = {}) {
  return ["docker", "local-docker", "queue"].includes(modeFromOptions(options));
}

/** @param {unknown} task */
export function isLocalDockerDocumentWorkerEligible(task) {
  const intent = asRecord(asRecord(task).taskIntent);
  const sourcePreparation = asRecord(intent.sourcePreparation);
  if (!LOCAL_DOCKER_ELIGIBLE_PROFILES.has(String(intent.executionProfile ?? ""))) return false;
  if (intent.requiresLocalAsr === true) return false;
  if (intent.operation === "document_revision" || sourcePreparation.operation === "document_revision" || sourcePreparation.reviewContextRequired === true) return false;
  return true;
}

/** @param {Array<string | number>} args */
function encodeRedisCommand(args) {
  return `*${args.length}\r\n${args.map((arg) => {
    const value = Buffer.from(String(arg));
    return `$${value.length}\r\n${value.toString()}\r\n`;
  }).join("")}`;
}

/** @param {Buffer} buffer @param {number} offset */
function findLineEnd(buffer, offset) {
  for (let index = offset; index + 1 < buffer.length; index += 1) {
    if (buffer[index] === 13 && buffer[index + 1] === 10) return index;
  }
  return -1;
}

/** @param {Buffer} buffer @param {number} [offset] @returns {RedisParseResult | null} */
function parseRedisValue(buffer, offset = 0) {
  if (offset >= buffer.length) return null;
  const type = String.fromCharCode(buffer.at(offset) ?? 0);
  const lineEnd = findLineEnd(buffer, offset);
  if (lineEnd < 0) return null;
  const line = buffer.toString("utf8", offset + 1, lineEnd);
  const next = lineEnd + 2;
  if (type === "+") return { value: line, offset: next };
  if (type === "-") throw new Error(`redis_error:${line}`);
  if (type === ":") return { value: Number(line), offset: next };
  if (type === "$") {
    const length = Number(line);
    if (length === -1) return { value: null, offset: next };
    const end = next + length;
    if (buffer.length < end + 2) return null;
    return { value: buffer.toString("utf8", next, end), offset: end + 2 };
  }
  if (type === "*") {
    const count = Number(line);
    if (count === -1) return { value: null, offset: next };
    /** @type {RedisValue[]} */
    const values = [];
    let itemOffset = next;
    for (let index = 0; index < count; index += 1) {
      const parsed = parseRedisValue(buffer, itemOffset);
      if (!parsed) return null;
      values.push(parsed.value);
      itemOffset = parsed.offset;
    }
    return { value: values, offset: itemOffset };
  }
  throw new Error(`redis_protocol_unknown_type:${type}`);
}

/** @param {DockerQueueConfig} config @param {Array<string | number>} args @param {number} [timeoutMs] @returns {Promise<RedisValue>} */
export function redisCommand(config, args, timeoutMs = 120000) {
  return new Promise((resolveCommand, rejectCommand) => {
    const socket = net.createConnection({ host: config.host, port: config.port });
    let buffer = Buffer.alloc(0);
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      rejectCommand(new Error("redis_command_timeout"));
    }, timeoutMs);
    /** @param {() => void} complete */
    function settle(complete) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.end();
      complete();
    }
    socket.on("connect", () => {
      socket.write(encodeRedisCommand(args));
    });
    socket.on("data", (chunk) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        const parsed = parseRedisValue(buffer);
        if (parsed) settle(() => resolveCommand(parsed.value));
      } catch (error) {
        settle(() => rejectCommand(error));
      }
    });
    socket.on("error", (error) => settle(() => rejectCommand(error)));
  });
}

/** @param {RuntimePaths} paths @param {string} summary @param {string} reason @param {Record<string, unknown>} [details] */
function blockedAgentOutput(paths, summary, reason, details = {}) {
  const finalFailureReport = {
    schemaVersion: "document-workflow-final-failure-v1",
    terminalReason: reason,
    status: "blocked",
    completedDocs: [],
    pendingDocs: [],
    failedStage: "local_docker_worker",
    retryCount: 0,
    retryExhausted: false,
    lastProviderAttempt: null,
    nextAction: reason === "local_docker_worker_timeout"
      ? "本地 checkpoint 已保留；等待 worker 完成或重新运行后会从最近检查点继续。"
      : "启动本地 Docker runtime queue/worker 后重新运行任务。",
    publishPartial: false,
    rawSecretsReturned: false,
  };
  const output = {
    status: "blocked",
    summary,
    documents: [],
    qaGate: { status: "blocked", publishAllowed: false, issues: [reason] },
    policyGate: { status: "pass", actionIntent: "draft", reasons: ["local_docker_worker_not_completed"] },
    artifacts: [],
    retryLater: true,
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
    details: sanitizeForDocker({ reason, ...details, finalFailureReport }),
  };
  writeJson(paths.agentOutputPath, output);
  return { status: "blocked", output, mode: "local-docker-document-worker", rawSecretsReturned: false };
}

/** @param {unknown} output */
function resultStatusFromOutput(output) {
  const status = asRecord(output).status;
  if (status === "completed") return "completed";
  if (status === "needs_fix") return "needs_fix";
  if (status === "failed") return "failed";
  return "blocked";
}

/** @param {unknown} task @param {RuntimePaths} paths @param {DockerQueueOptions} [options] */
export async function runViaLocalDockerDocumentWorker(task, paths, options = {}) {
  const normalizedTask = asRecord(task);
  const taskIntent = asRecord(normalizedTask.taskIntent);
  const config = localDockerQueueConfig(options);
  if (!isLocalDockerDocumentWorkerEnabled(options)) return null;
  if (!isLocalDockerDocumentWorkerEligible(task)) return null;

  const workerInputDir = join(paths.artifactsDir, "docker-worker");
  const boundedTaskPath = join(workerInputDir, "task.json");
  const jobPath = join(workerInputDir, "job.json");
  const runDirRelative = workspaceRelativePath(paths.runDir);
  const taskPathRelative = workspaceRelativePath(boundedTaskPath);
  if (!runDirRelative || !taskPathRelative) {
    return blockedAgentOutput(paths, "本地 Docker worker 输入路径不在 workspace 内。", "local_docker_worker_path_outside_workspace");
  }
  const boundedTask = buildBoundedDockerTask(task);
  writeJson(boundedTaskPath, boundedTask);
  const runId = String(normalizedTask.runId ?? "");
  if (!runId) return blockedAgentOutput(paths, "本地 Docker worker 缺少 runId。", "local_docker_worker_run_id_missing");
  const jobId = safeSegment(`${runId}-${randomUUID()}`);
  const resultKey = `${config.resultKeyPrefix}:${jobId}`;
  const job = {
    schemaVersion: LOCAL_DOCKER_JOB_SCHEMA_VERSION,
    jobId,
    runId,
    executionProfile: taskIntent.executionProfile,
    runDirRelative,
    taskPathRelative,
    resultKey,
    createdAt: nowIso(),
    safety: {
      boundedArtifactsOnly: true,
      rawAudioVideoIncluded: false,
      feishuCredentialsIncluded: false,
      larkCliAllowed: false,
      publishAllowedInWorker: false,
    },
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  };
  writeJson(jobPath, job);

  try {
    const depth = Number(await redisCommand(config, ["LLEN", config.queueName], 10000));
    if (Number.isFinite(depth) && depth >= config.queueMaxDepth) {
      return blockedAgentOutput(paths, "本地 Docker 文档 worker 队列已满，任务已暂停等待重试。", "local_docker_queue_overloaded", {
        queueName: config.queueName,
        queueDepth: depth,
        queueMaxDepth: config.queueMaxDepth,
      });
    }
    await options.onStep?.("local_docker_worker_enqueued", "running", {
      jobId,
      queueName: config.queueName,
      queueDepth: Number.isFinite(depth) ? depth : null,
      artifact: jobPath,
      executionProfile: taskIntent.executionProfile,
    });
    await redisCommand(config, ["RPUSH", config.queueName, JSON.stringify(job)], 10000);
    const timeoutSec = Math.max(1, Math.ceil(config.waitTimeoutMs / 1000));
    const response = await redisCommand(config, ["BLPOP", resultKey, String(timeoutSec)], config.waitTimeoutMs + 5000);
    if (!Array.isArray(response) || response.length < 2) {
      return blockedAgentOutput(paths, "本地 Docker 文档 worker 未在限定时间内完成，可稍后重试。", "local_docker_worker_timeout", {
        jobId,
        waitTimeoutMs: config.waitTimeoutMs,
      });
    }
    const serializedResult = response[1];
    if (typeof serializedResult !== "string") {
      return blockedAgentOutput(paths, "本地 Docker 文档 worker 返回了无效结果。", "local_docker_worker_result_invalid", { jobId });
    }
    const result = asRecord(JSON.parse(serializedResult));
    await options.onStep?.("local_docker_worker_completed", result.status === "completed" ? "completed" : String(result.status ?? "blocked"), {
      jobId,
      workerId: result.workerId ?? null,
      artifact: paths.agentOutputPath,
      reason: result.reason ?? null,
    });
    if (!existsSync(paths.agentOutputPath)) {
      return blockedAgentOutput(paths, "本地 Docker 文档 worker 未返回 agent-output。", "local_docker_worker_output_missing", { jobId, result });
    }
    const output = loadJson(paths.agentOutputPath);
    return {
      status: resultStatusFromOutput(output),
      output,
      mode: "local-docker-document-worker",
      workerResult: sanitizeForDocker(result),
      rawSecretsReturned: false,
    };
  } catch (error) {
    return blockedAgentOutput(paths, "本地 Docker 文档 worker 不可用，任务未回退到 Host 长链路。", "local_docker_worker_unavailable", {
      jobId,
      queueName: config.queueName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** @param {string} runDir @returns {RuntimePaths} */
export function pathsForRunDir(runDir) {
  const resolved = resolve(runDir);
  return {
    runDir: resolved,
    inputsDir: join(resolved, "inputs"),
    attachmentsDir: join(resolved, "inputs", "attachments"),
    fileContextsDir: join(resolved, "inputs", "file-context"),
    fileContextPath: join(resolved, "inputs", "file-context.json"),
    artifactsDir: join(resolved, "artifacts"),
    eventPath: join(resolved, "event.json"),
    sourceEventsPath: join(resolved, "source-events.ndjson"),
    taskPath: join(resolved, "task.json"),
    statePath: join(resolved, "state.json"),
    metricsPath: join(resolved, "run.metrics.json"),
    manifestPath: join(resolved, "run-manifest.json"),
    agentTaskPath: join(resolved, "agent-task.md"),
    agentOutputPath: join(resolved, "agent-output.json"),
    publishPath: join(resolved, "publish.json"),
    replyPath: join(resolved, "reply.json"),
    progressPath: join(resolved, "progress-replies.ndjson"),
    stdoutPath: join(resolved, "pi.stdout.txt"),
    stderrPath: join(resolved, "pi.stderr.txt"),
  };
}
