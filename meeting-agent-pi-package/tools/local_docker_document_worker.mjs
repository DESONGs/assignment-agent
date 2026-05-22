#!/usr/bin/env node

/**
 * Local Docker document worker.
 *
 * Consumes bounded document-generation jobs from the local runtime queue and
 * runs the existing profile runner inside the constrained Docker execution
 * plane. The host handler remains the only entry/exit point for channel
 * downloads, replies, and publishing.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runTaskExecutionPipeline } from "./task_execution_runner.mjs";
import {
  LOCAL_DOCKER_JOB_SCHEMA_VERSION,
  LOCAL_DOCKER_RESULT_SCHEMA_VERSION,
  isLocalDockerDocumentWorkerEligible,
  localDockerQueueConfig,
  pathsForRunDir,
  redisCommand,
  sanitizeForDocker,
} from "./local_docker_runtime_queue.mjs";

const DEFAULT_WORKSPACE_ROOT = process.env.LOCAL_DOCKER_WORKSPACE_ROOT || process.cwd();

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    if (["once", "quiet"].includes(key)) {
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

function workspacePath(relativePath, workspaceRoot = DEFAULT_WORKSPACE_ROOT) {
  const resolvedRoot = resolve(workspaceRoot);
  const resolved = resolve(resolvedRoot, String(relativePath ?? ""));
  if (!isInside(resolvedRoot, resolved)) {
    throw new Error("local_docker_worker_path_outside_workspace");
  }
  return resolved;
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sanitizeForDocker(value), null, 2)}\n`, "utf8");
}

function appendWorkerStep(paths, name, status, details = {}) {
  const state = existsSync(paths.statePath)
    ? loadJson(paths.statePath)
    : {
        schemaVersion: "feishu-run-state-v1",
        runId: null,
        status: "running",
        updatedAt: nowIso(),
        steps: [],
        rawSecretsReturned: false,
        rawMediaExternalUpload: false,
      };
  state.steps = Array.isArray(state.steps) ? state.steps : [];
  state.steps.push({ name, status, at: nowIso(), ...sanitizeForDocker(details) });
  state.status = status === "failed" ? "failed" : status === "blocked" ? "blocked" : state.status || "running";
  state.updatedAt = nowIso();
  state.rawSecretsReturned = false;
  state.rawMediaExternalUpload = false;
  writeJson(paths.statePath, state);
}

async function publishWorkerResult(config, job, result) {
  await redisCommand(config, ["RPUSH", job.resultKey, JSON.stringify({
    schemaVersion: LOCAL_DOCKER_RESULT_SCHEMA_VERSION,
    ...sanitizeForDocker(result),
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  })], 10000);
  await redisCommand(config, ["EXPIRE", job.resultKey, String(Number(process.env.FEISHU_AGENT_DOCKER_RESULT_TTL_SECONDS ?? 3600))], 10000);
}

function validateJob(job) {
  if (!job || typeof job !== "object") throw new Error("local_docker_worker_job_invalid");
  if (job.schemaVersion !== LOCAL_DOCKER_JOB_SCHEMA_VERSION) throw new Error("local_docker_worker_job_schema_invalid");
  if (!job.jobId || !job.runDirRelative || !job.taskPathRelative || !job.resultKey) {
    throw new Error("local_docker_worker_job_missing_required_fields");
  }
}

async function processJob(job, options = {}) {
  validateJob(job);
  const config = localDockerQueueConfig({ documentWorkerMode: "docker", ...options });
  const workspaceRoot = resolve(options.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT);
  const runDir = workspacePath(job.runDirRelative, workspaceRoot);
  const taskPath = workspacePath(job.taskPathRelative, workspaceRoot);
  const paths = pathsForRunDir(runDir);
  const workerId = options.workerId ?? `${process.pid}`;

  try {
    const task = loadJson(taskPath);
    if (!isLocalDockerDocumentWorkerEligible(task)) {
      throw new Error("local_docker_worker_task_not_eligible");
    }
    appendWorkerStep(paths, "local_docker_worker_started", "running", {
      jobId: job.jobId,
      workerId,
      executionProfile: task.taskIntent?.executionProfile ?? job.executionProfile ?? null,
      boundedArtifactsOnly: true,
    });
    const result = await runTaskExecutionPipeline(task, paths, {
      ...options,
      documentWorkerMode: "host",
      progressReply: async () => ({ status: "skipped", reason: "worker_has_no_channel_reply", rawSecretsReturned: false }),
      onStep: async (name, status, details = {}) => {
        appendWorkerStep(paths, name, status, {
          ...details,
          dockerWorker: true,
          jobId: job.jobId,
          workerId,
        });
      },
    });
    appendWorkerStep(paths, "local_docker_worker_completed", result.status === "completed" ? "completed" : result.status ?? "blocked", {
      jobId: job.jobId,
      workerId,
      artifact: paths.agentOutputPath,
    });
    await publishWorkerResult(config, job, {
      status: result.status,
      reason: result.output?.details?.reason ?? null,
      workerId,
      agentOutputPath: relative(workspaceRoot, paths.agentOutputPath),
      completedAt: nowIso(),
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendWorkerStep(paths, "local_docker_worker_completed", "failed", {
      jobId: job.jobId,
      workerId,
      reason: message,
    });
    const output = {
      status: "blocked",
      summary: "本地 Docker 文档 worker 执行失败，可稍后重试。",
      documents: [],
      qaGate: { status: "blocked", publishAllowed: false, issues: ["local_docker_worker_failed"] },
      policyGate: { status: "pass", actionIntent: "draft", reasons: ["worker_failed_before_publish"] },
      artifacts: [],
      retryLater: true,
      details: {
        reason: "local_docker_worker_failed",
        error: message,
        finalFailureReport: {
          schemaVersion: "document-workflow-final-failure-v1",
          terminalReason: "local_docker_worker_failed",
          status: "blocked",
          completedDocs: [],
          pendingDocs: [],
          failedStage: "local_docker_worker",
          retryCount: 0,
          retryExhausted: false,
          lastProviderAttempt: null,
          nextAction: "本地 checkpoint 已保留；修复 Docker worker 错误后重新运行会从最近检查点继续。",
          publishPartial: false,
          rawSecretsReturned: false,
        },
      },
      rawSecretsReturned: false,
      rawMediaExternalUpload: false,
    };
    writeJson(paths.agentOutputPath, output);
    await publishWorkerResult(config, job, {
      status: "failed",
      reason: message,
      workerId,
      agentOutputPath: relative(workspaceRoot, paths.agentOutputPath),
      completedAt: nowIso(),
    });
    return { status: "failed", output, mode: "local-docker-document-worker", rawSecretsReturned: false };
  }
}

async function pollWorkerLoop(slot, args) {
  const config = localDockerQueueConfig({
    documentWorkerMode: "docker",
    dockerQueueHost: process.env.FEISHU_AGENT_DOCKER_QUEUE_HOST ?? "runtime-queue",
    dockerQueuePort: process.env.FEISHU_AGENT_DOCKER_QUEUE_PORT ?? 6379,
    dockerQueueName: process.env.FEISHU_AGENT_DOCKER_QUEUE_NAME,
  });
  const workerId = `${process.pid}-${slot}`;
  let handled = 0;
  while (true) {
    const response = await redisCommand(config, ["BLPOP", config.queueName, "30"], 35000);
    if (!Array.isArray(response) || response.length < 2) {
      if (args.once) return handled;
      continue;
    }
    const job = JSON.parse(response[1]);
    await processJob(job, {
      workspaceRoot: DEFAULT_WORKSPACE_ROOT,
      workerId,
      pipelineMockModel: /^(1|true|yes|on)$/i.test(process.env.FEISHU_AGENT_PIPELINE_MOCK_MODEL ?? ""),
      runtimeToolTimeoutMs: Number(process.env.FEISHU_AGENT_RUNTIME_TOOL_TIMEOUT_MS ?? 600000),
      modelTimeoutMs: Number(process.env.FEISHU_AGENT_MODEL_TIMEOUT_MS ?? 600000),
      documentWorkerTimeoutMs: Number(process.env.FEISHU_AGENT_DOCUMENT_WORKER_TIMEOUT_MS ?? 1_800_000),
      longDocumentJobTimeoutMs: Number(process.env.FEISHU_AGENT_LONG_DOCUMENT_JOB_TIMEOUT_MS ?? 7_200_000),
      documentWorkerDeadlineReserveMs: Number(process.env.FEISHU_AGENT_DOCUMENT_WORKER_DEADLINE_RESERVE_MS ?? 30_000),
      documentQualityMode: process.env.FEISHU_AGENT_DOCUMENT_QUALITY_MODE ?? "stable",
      documentWorkerMaxAttemptsPerUnit: Number(process.env.FEISHU_AGENT_DOCUMENT_WORKER_MAX_ATTEMPTS_PER_UNIT ?? 3),
      documentWorkerMaxRetryUnits: Number(process.env.FEISHU_AGENT_DOCUMENT_WORKER_MAX_RETRY_UNITS ?? 12),
    });
    handled += 1;
    if (args.once) return handled;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args["job-file"]) {
    const job = loadJson(resolve(String(args["job-file"])));
    await processJob(job, { workspaceRoot: DEFAULT_WORKSPACE_ROOT, workerId: `${process.pid}-file` });
    return;
  }
  const concurrency = Math.max(1, Number(args.concurrency ?? process.env.FEISHU_AGENT_DOCUMENT_WORKER_CONCURRENCY ?? 2));
  const loops = Array.from({ length: concurrency }, (_item, index) => pollWorkerLoop(index + 1, args));
  await Promise.all(loops);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
