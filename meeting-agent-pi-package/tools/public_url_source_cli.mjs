#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runTaskExecutionPipeline } from "./task_execution_runner.mjs";
import { sanitizeUrlForArtifact } from "./public_url_security.mjs";

const toolDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(toolDir);
const workspaceDir = dirname(packageDir);
const RUNTIME_ROOT = join(workspaceDir, "runtime-runs");
const DEFAULT_OUTPUT_ROOT = join(RUNTIME_ROOT, "public-url");
const ENV_ALLOWLIST = new Set([
  "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "XIAOMI_TOKEN_PLAN_SGP_API_KEY", "XIAOMI_BASE_URL", "PI_PROVIDER", "PI_MODEL", "PI_REVIEW_PROVIDER", "PI_REVIEW_MODEL",
  "MEETING_ASR_PROVIDER", "ALIYUN_DASHSCOPE_API_KEY", "DASHSCOPE_API_KEY", "ALIYUN_DASHSCOPE_WORKSPACE_ID", "ALIYUN_ASR_MODEL", "ALIYUN_ASR_FILE_MODEL", "ALIYUN_ASR_ENDPOINT", "ALIYUN_ASR_FILE_ENDPOINT", "ALIYUN_ASR_LANGUAGE_HINTS", "ALIYUN_ASR_TIMEOUT_MS",
  "ALIYUN_OSS_BUCKET", "ALIYUN_OSS_REGION", "ALIYUN_OSS_ENDPOINT", "ALIYUN_OSS_BUCKET_ENDPOINT", "ALIYUN_OSS_ASR_PREFIX", "ALIYUN_OSS_ACCESS_KEY_ID", "ALIYUN_OSS_ACCESS_KEY_SECRET", "ALIYUN_OSS_SECURITY_TOKEN", "ALIBABA_CLOUD_ACCESS_KEY_ID", "ALIBABA_CLOUD_ACCESS_KEY_SECRET", "ALIBABA_CLOUD_SECURITY_TOKEN",
  "YT_DLP_BIN", "FFPROBE_BIN",
]);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else { args[key] = next; index += 1; }
  }
  return args;
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function parseDotenv(text) {
  const values = {};
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2] ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "").trim();
    values[match[1]] = value;
  }
  return values;
}

function loadLocalEnv(path = join(workspaceDir, ".env.local")) {
  if (!existsSync(path)) return { status: "missing", loadedKeys: [] };
  const values = parseDotenv(readFileSync(path, "utf8"));
  const loadedKeys = [];
  for (const [key, value] of Object.entries(values)) {
    if (!ENV_ALLOWLIST.has(key) || process.env[key] !== undefined) continue;
    process.env[key] = value;
    loadedKeys.push(key);
  }
  return { status: "loaded", loadedKeys };
}

function safeSegment(value, fallback = "run") {
  const clean = String(value ?? fallback).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  return clean && clean !== "." && clean !== ".." ? clean : fallback;
}

function defaultRunId(url) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const hash = createHash("sha256").update(String(url)).digest("hex").slice(0, 10);
  return `public_url_${timestamp}_${hash}`;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function runPublicUrlCliTask(params) {
  loadLocalEnv(params.envFile ? resolve(params.envFile) : undefined);
  const url = String(params.url ?? "").trim();
  if (!url) throw new Error("public_url_source_cli_url_required");
  const outputRoot = resolve(params.outputRoot ?? DEFAULT_OUTPUT_ROOT);
  if (!isInside(RUNTIME_ROOT, outputRoot)) throw new Error("public_url_output_root_outside_ignored_runtime_blocked");
  const runId = safeSegment(params.runId ?? defaultRunId(url));
  const runDir = resolve(outputRoot, "runs", runId);
  if (!isInside(outputRoot, runDir)) throw new Error("public_url_run_dir_outside_output_root_blocked");
  const paths = {
    runDir,
    inputsDir: join(runDir, "inputs"),
    artifactsDir: join(runDir, "artifacts"),
    agentOutputPath: join(runDir, "agent-output.json"),
  };
  mkdirSync(paths.inputsDir, { recursive: true });
  mkdirSync(paths.artifactsDir, { recursive: true });
  writeJson(join(runDir, "request.json"), {
    schemaVersion: "public-url-source-request-v1",
    runId,
    url: sanitizeUrlForArtifact(url),
    resolveOnly: params.resolveOnly === true,
    requestedAt: new Date().toISOString(),
    rawSecretsReturned: false,
  });
  const state = { schemaVersion: "public-url-run-state-v1", runId, status: "running", updatedAt: new Date().toISOString(), steps: [], rawSecretsReturned: false };
  const recordStep = async (name, status, details = {}) => {
    state.steps.push({ name, status, at: new Date().toISOString(), ...details });
    state.status = status === "blocked" || status === "failed" ? status : state.status;
    state.updatedAt = new Date().toISOString();
    writeJson(join(runDir, "state.json"), state);
  };
  const task = {
    schemaVersion: "public-url-task-v1",
    runId,
    sourceEvent: { eventType: "local.public_url", message: { text: url, attachments: [] } },
    attachments: [],
    fileContexts: { contexts: [] },
    taskIntent: {
      schemaVersion: "task-intent-v1",
      taskType: "knowledge_source",
      responseMode: "source_pack",
      executionProfile: "url_source_pack",
      reasoningDepth: "deep",
      requestedDocuments: [],
      requiresAsr: false,
      requiresLocalAsr: false,
      sourcePreparation: { sourceSetMode: "explicit_public_url", inputModalities: ["public_url"], publicUrls: [url], requestedDocuments: [] },
    },
  };
  const result = await runTaskExecutionPipeline(task, paths, {
    onStep: recordStep,
    progressReply: async (text, stage) => recordStep(stage, "running", { message: text }),
    publicUrlResolveOnly: params.resolveOnly === true,
    pipelineMockModel: params.mockModel === true,
    ytDlpBin: params.ytDlpBin,
    publicUrlMaxMediaBytes: params.maxMediaBytes ? Number(params.maxMediaBytes) : undefined,
    publicUrlMaxDurationSec: params.maxDurationSec ? Number(params.maxDurationSec) : undefined,
    publicUrlTimeoutMs: params.timeoutMs ? Number(params.timeoutMs) : undefined,
  });
  state.status = result.status;
  state.updatedAt = new Date().toISOString();
  writeJson(join(runDir, "state.json"), state);
  const payload = {
    status: result.status,
    runId,
    runDir,
    sourcePackPath: result.output?.details?.sourcePackPath ? resolve(workspaceDir, result.output.details.sourcePackPath) : null,
    readableSourcePackPath: result.output?.details?.readableSourcePackPath ? resolve(workspaceDir, result.output.details.readableSourcePackPath) : null,
    provenancePath: result.output?.details?.provenancePath ? resolve(workspaceDir, result.output.details.provenancePath) : null,
    sourceResolutionPath: join(paths.artifactsDir, "public-source", "source-resolution.json"),
    summary: result.output?.summary ?? null,
    todo: result.output?.details?.todo ?? null,
    rawSecretsReturned: false,
    knowledgeBaseWritePerformed: false,
  };
  writeJson(join(runDir, "result.json"), payload);
  return payload;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runPublicUrlCliTask({
    url: args.url,
    runId: args["run-id"],
    outputRoot: args["output-root"],
    envFile: args["env-file"],
    resolveOnly: args["resolve-only"] === true,
    mockModel: args["mock-model"] === true,
    ytDlpBin: args["yt-dlp-bin"],
    maxMediaBytes: args["max-media-bytes"],
    maxDurationSec: args["max-duration-sec"],
    timeoutMs: args["timeout-ms"],
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "failed", reason: error instanceof Error ? error.message : String(error), rawSecretsReturned: false })}\n`);
    process.exit(2);
  });
}
