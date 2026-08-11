import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(extensionDir);
const workspaceDir = dirname(packageDir);

const SECRET_PATTERNS = [
  /(app_secret|client_secret|refresh_token|access_token|authorization|cookie|session)\s*[:=]\s*["']?[A-Za-z0-9._\-]{8,}/i,
  /bearer\s+[A-Za-z0-9._\-]{8,}/i,
  /\b(FEISHU_APP_SECRET|DEEPSEEK_API_KEY|XIAOMI_TOKEN_PLAN_SGP_API_KEY)\b/i,
];

const MAX_METRIC_TEXT_CHARS = 8000;

function defaultOutputRoot() {
  return join(workspaceDir, "runtime-runs");
}

function isInside(parent: string, child: string) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeRunId(input?: string) {
  const value = input?.trim() || `run_${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
  const cleaned = value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new Error("unsafe_runtime_segment_blocked");
  }
  return cleaned;
}

function runtimeRoot(outputRoot?: string) {
  const root = resolve(outputRoot ?? defaultOutputRoot());
  if (!isInside(workspaceDir, root)) {
    throw new Error("runtime_output_root_outside_workspace_blocked");
  }
  return root;
}

function runDir(runId: string, outputRoot?: string) {
  const root = runtimeRoot(outputRoot);
  const path = resolve(root, safeRunId(runId));
  if (!isInside(root, path)) {
    throw new Error("runtime_run_dir_outside_root_blocked");
  }
  return path;
}

function metricsPath(runId: string, outputRoot?: string) {
  return join(runDir(runId, outputRoot), "run.metrics.json");
}

function sanitize(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) return "[REDACTED_SECRET_LIKE_VALUE]";
    if (value.length > MAX_METRIC_TEXT_CHARS) return `${value.slice(0, MAX_METRIC_TEXT_CHARS)}...[TRUNCATED_FOR_METRICS_BUDGET]`;
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (/secret|token|cookie|session|authorization/i.test(key)) {
        result[key] = "[REDACTED_FIELD]";
      } else {
        result[key] = sanitize(item, key);
      }
    }
    return result;
  }
  return value;
}

function readMetrics(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeMetrics(path: string, metrics: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(sanitize(metrics), null, 2) + "\n", "utf8");
}

function baseMetrics(runId: string, taskType: string, summary?: string) {
  return {
    runId,
    taskType,
    summary: summary ?? "",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "running",
    enabledCapabilities: [],
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
    contentTruncationChars: MAX_METRIC_TEXT_CHARS,
  };
}

function appendByKind(metrics: Record<string, any>, kind: string, payload: unknown) {
  if (kind === "capability") {
    const id = typeof payload === "string" ? payload : (payload as any)?.capabilityId;
    if (id && !metrics.enabledCapabilities.includes(id)) metrics.enabledCapabilities.push(id);
    return;
  }
  if (kind === "model") {
    metrics.modelCalls.push(payload);
    const usage = (payload as any)?.usage;
    if (usage && typeof usage === "object") {
      metrics.tokenUsage.prompt += Number(usage.prompt ?? usage.prompt_tokens ?? 0);
      metrics.tokenUsage.completion += Number(usage.completion ?? usage.completion_tokens ?? 0);
      metrics.tokenUsage.cached += Number(usage.cached ?? usage.cached_tokens ?? 0);
      metrics.tokenUsage.total += Number(usage.total ?? usage.total_tokens ?? 0);
    }
    return;
  }
  if (kind === "tool") {
    metrics.toolCalls.push(payload);
    return;
  }
  if (kind === "external") {
    metrics.externalCalls.push(payload);
    return;
  }
  if (kind === "artifact") {
    metrics.generatedArtifacts.push(payload);
    return;
  }
  if (kind === "qaGate") {
    metrics.qaGate = payload;
    return;
  }
  if (kind === "contextBudget") {
    metrics.contextBudget = { ...metrics.contextBudget, ...(payload as object) };
    return;
  }
  if (kind === "planner") {
    metrics.plannerDecisions.push(payload);
    return;
  }
  if (kind === "policy") {
    metrics.policyDecisions.push(payload);
    return;
  }
  if (kind === "workerDecision") {
    metrics.workerDecisions.push(payload);
    return;
  }
  if (kind === "capabilitySelection") {
    metrics.capabilitySelections.push(payload);
    return;
  }
  if (kind === "packageAudit") {
    metrics.packageAudits.push(payload);
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "runtime_metrics_start",
    label: "Runtime Metrics Start",
    description: "Start a local runtime metrics artifact. Meeting content is allowed; credentials are always removed and oversized metric strings are truncated for operational budget.",
    parameters: Type.Object({
      taskType: Type.String({ description: "Task type, e.g. meeting_minutes, feishu_bot, prd, qa." }),
      summary: Type.Optional(Type.String({ description: "Short run summary." })),
      runId: Type.Optional(Type.String({ description: "Optional caller-provided run id." })),
      outputRoot: Type.Optional(Type.String({ description: "Optional runtime-runs output directory." })),
    }),
    async execute(_toolCallId, params): Promise<any> {
      try {
        const runId = safeRunId(params.runId);
        const path = metricsPath(runId, params.outputRoot);
        const metrics = baseMetrics(runId, params.taskType, params.summary);
        writeMetrics(path, metrics);
        const details = { runId, metricsPath: path, status: "running", rawSecretsReturned: false };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      } catch (error) {
        const blocked = { status: "blocked", reason: error instanceof Error ? error.message : String(error) };
        return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
      }
    },
  });

  pi.registerTool({
    name: "runtime_metrics_record",
    label: "Runtime Metrics Record",
    description: "Append a credential-safe runtime event to a metrics artifact.",
    parameters: Type.Object({
      runId: Type.String(),
      kind: Type.Union([
        Type.Literal("capability"),
        Type.Literal("model"),
        Type.Literal("tool"),
        Type.Literal("external"),
        Type.Literal("artifact"),
        Type.Literal("qaGate"),
        Type.Literal("contextBudget"),
        Type.Literal("planner"),
        Type.Literal("policy"),
        Type.Literal("workerDecision"),
        Type.Literal("capabilitySelection"),
        Type.Literal("packageAudit"),
      ]),
      payload: Type.Any(),
      outputRoot: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params): Promise<any> {
      try {
        const path = metricsPath(params.runId, params.outputRoot);
        if (!existsSync(path)) {
          const blocked = { status: "blocked", reason: "metrics_run_not_found", runId: params.runId, metricsPath: path };
          return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
        }
        const metrics = readMetrics(path);
        appendByKind(metrics, params.kind, params.payload);
        writeMetrics(path, metrics);
        const details = { ok: true, runId: params.runId, metricsPath: path, kind: params.kind };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      } catch (error) {
        const blocked = { status: "blocked", reason: error instanceof Error ? error.message : String(error), runId: params.runId };
        return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
      }
    },
  });

  pi.registerTool({
    name: "runtime_metrics_finish",
    label: "Runtime Metrics Finish",
    description: "Finish a runtime metrics artifact with final status and optional QA gate.",
    parameters: Type.Object({
      runId: Type.String(),
      status: Type.Union([
        Type.Literal("pass"),
        Type.Literal("needs_fix"),
        Type.Literal("blocked"),
        Type.Literal("failed"),
      ]),
      qaGate: Type.Optional(Type.Any()),
      outputRoot: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params): Promise<any> {
      try {
        const path = metricsPath(params.runId, params.outputRoot);
        if (!existsSync(path)) {
          const blocked = { status: "blocked", reason: "metrics_run_not_found", runId: params.runId, metricsPath: path };
          return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
        }
        const metrics = readMetrics(path);
        metrics.status = params.status;
        metrics.finishedAt = new Date().toISOString();
        if (params.qaGate) metrics.qaGate = params.qaGate;
        writeMetrics(path, metrics);
        const details = { ok: true, runId: params.runId, status: params.status, metricsPath: path };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      } catch (error) {
        const blocked = { status: "blocked", reason: error instanceof Error ? error.message : String(error), runId: params.runId };
        return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
      }
    },
  });
}
