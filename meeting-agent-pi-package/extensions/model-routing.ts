import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ModelCandidate = {
  provider: string;
  model: string;
  strength: string;
};

type Route = {
  taskType: string;
  primary: ModelCandidate;
  fallbacks: ModelCandidate[];
};

const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(extensionDir);
const workspaceDir = dirname(packageDir);
const routingPath = join(packageDir, "runtime", "model-routing.json");

function loadRouting() {
  return JSON.parse(readFileSync(routingPath, "utf8")) as {
    version: string;
    defaultPolicy: {
      automaticFallback: boolean;
      silentFallbackAllowed: boolean;
      recordArtifact: string;
      blockedWhen: string[];
    };
    routes: Route[];
  };
}

function safeRunId(input: string) {
  const cleaned = input.trim().replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new Error("unsafe_runtime_segment_blocked");
  }
  return cleaned;
}

function defaultOutputRoot() {
  return join(workspaceDir, "runtime-runs");
}

function isInside(parent: string, child: string) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function runtimeRoot(outputRoot?: string) {
  const root = resolve(outputRoot ?? defaultOutputRoot());
  if (!isInside(workspaceDir, root)) {
    throw new Error("runtime_output_root_outside_workspace_blocked");
  }
  return root;
}

function artifactPath(runId: string, outputRoot?: string) {
  const root = runtimeRoot(outputRoot);
  const dir = resolve(root, safeRunId(runId));
  if (!isInside(root, dir)) {
    throw new Error("runtime_run_dir_outside_root_blocked");
  }
  return join(dir, "model-route.json");
}

function isBlockedCandidate(candidate: ModelCandidate) {
  return candidate.provider.toLowerCase() === "manual" || candidate.strength.toLowerCase() === "blocked";
}

export function planRoute(params: {
  taskType: string;
  docType?: string | undefined;
  reasoningDepth?: "fast" | "deep" | undefined;
  userRequestedDeepThinking?: boolean | undefined;
  estimatedComplexity?: "low" | "medium" | "high" | undefined;
  unavailableProviders?: string[] | undefined;
  userRequiresExactModel?: boolean | undefined;
  /** Deprecated compatibility input. Meeting content no longer blocks model routing. */
}) {
  const routing = loadRouting();
  const resolvedTaskType = resolveRouteTaskType(params);
  const route = routing.routes.find((item) => item.taskType === resolvedTaskType);
  const unavailable = new Set((params.unavailableProviders ?? []).map((provider) => provider.toLowerCase()));

  if (!route) {
    return {
      status: "blocked",
      reason: "route_not_found",
      taskType: params.taskType,
      resolvedTaskType,
      availableTaskTypes: routing.routes.map((item) => item.taskType),
      policy: routing.defaultPolicy,
    };
  }

  const primaryUnavailable = unavailable.has(route.primary.provider.toLowerCase());
  if (params.userRequiresExactModel === true && primaryUnavailable) {
    return {
      status: "blocked",
      reason: "user_requires_exact_model",
      taskType: params.taskType,
      resolvedTaskType,
      primary: route.primary,
      policy: routing.defaultPolicy,
    };
  }

  const candidates = [route.primary, ...route.fallbacks];
  const selectedIndex = candidates.findIndex((candidate) => !unavailable.has(candidate.provider.toLowerCase()));
  if (selectedIndex < 0) {
    return {
      status: "blocked",
      reason: "no_candidate_model_available",
      taskType: params.taskType,
      resolvedTaskType,
      candidates,
      unavailableProviders: [...unavailable],
      policy: routing.defaultPolicy,
    };
  }

  const selected = candidates[selectedIndex];
  if (!selected) {
    return {
      status: "blocked",
      reason: "selected_model_candidate_missing",
      taskType: params.taskType,
      resolvedTaskType,
      candidates,
      policy: routing.defaultPolicy,
    };
  }
  const fallbackOccurred = selectedIndex > 0;
  const fallbackReason = fallbackOccurred ? "primary_or_prior_candidate_unavailable" : null;
  if (isBlockedCandidate(selected)) {
    return {
      status: "blocked",
      reason: "manual_or_blocked_candidate_selected",
      taskType: params.taskType,
      resolvedTaskType,
      selected,
      selectedIndex,
      primary: route.primary,
      fallbackOccurred,
      fallbackReason,
      executionAllowed: false,
      automaticFallbackAllowed: routing.defaultPolicy.automaticFallback,
      silentFallbackAllowed: routing.defaultPolicy.silentFallbackAllowed,
      recordRequired: true,
      recordArtifact: routing.defaultPolicy.recordArtifact,
      candidates,
      unavailableProviders: [...unavailable],
      policy: routing.defaultPolicy,
    };
  }

  return {
    status: "selected",
    reason: null,
    taskType: params.taskType,
    resolvedTaskType,
    selected,
    primary: route.primary,
    fallbackOccurred,
    fallbackReason,
    automaticFallbackAllowed: routing.defaultPolicy.automaticFallback,
    silentFallbackAllowed: routing.defaultPolicy.silentFallbackAllowed,
    recordRequired: true,
    recordArtifact: routing.defaultPolicy.recordArtifact,
    candidates,
    unavailableProviders: [...unavailable],
  };
}

function resolveRouteTaskType(params: {
  taskType: string;
  docType?: string | undefined;
  reasoningDepth?: "fast" | "deep" | undefined;
  userRequestedDeepThinking?: boolean | undefined;
  estimatedComplexity?: "low" | "medium" | "high" | undefined;
}) {
  if (params.taskType === "document_shard") {
    if (params.docType === "meeting-minutes") return "meeting_minutes";
    const deepDocs = new Set(["prd", "tech-architecture", "ops-plan", "customer-requirement-checklist"]);
    if (
      params.reasoningDepth === "deep" ||
      params.userRequestedDeepThinking === true ||
      params.estimatedComplexity === "high" ||
      (params.docType ? deepDocs.has(params.docType) : false)
    ) {
      return "document_shard_deep";
    }
    return "document_shard_fast";
  }
  if (params.taskType === "main_draft") {
    if (
      params.reasoningDepth === "deep" ||
      params.userRequestedDeepThinking === true ||
      params.estimatedComplexity === "high"
    ) {
      return "deep_draft";
    }
    if (params.reasoningDepth === "fast") return "fast_draft";
  }
  return params.taskType;
}

export function recordRouteArtifact(runId: string, route: unknown, outputRoot?: string) {
  const path = artifactPath(runId, outputRoot);
  const routePayload =
    route && typeof route === "object" && !Array.isArray(route)
      ? route
      : { route };
  const payload = {
    ...routePayload,
    recordedAt: new Date().toISOString(),
    routeConfigPath: routingPath,
    silentFallbackAllowed: false,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return path;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "model_route_plan",
    label: "Model Route Plan",
    description:
      "Select the configured model route for a task. Automatic fallback is allowed, but the fallback must be explicit and recorded.",
    parameters: Type.Object({
      taskType: Type.String({ description: "Route id such as meeting_analysis, meeting_minutes, main_draft, fast_draft, qa_gate, feishu_readiness, or document_shard." }),
      docType: Type.Optional(Type.String({ description: "Document type used to choose fast/deep document shard routes." })),
      reasoningDepth: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("deep")])),
      userRequestedDeepThinking: Type.Optional(Type.Boolean()),
      estimatedComplexity: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
      unavailableProviders: Type.Optional(Type.Array(Type.String())),
      userRequiresExactModel: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params) {
      const details = planRoute(params);
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });

  pi.registerTool({
    name: "model_route_record",
    label: "Model Route Record",
    description: "Write the selected model route to runtime-runs/{runId}/model-route.json.",
    parameters: Type.Object({
      runId: Type.String(),
      route: Type.Unknown({ description: "Output from model_route_plan plus actual model call metadata if available." }),
      outputRoot: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
      try {
        const path = recordRouteArtifact(params.runId, params.route, params.outputRoot);
        const details = { ok: true, runId: params.runId, modelRoutePath: path };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      } catch (error) {
        const blocked = { status: "blocked", reason: error instanceof Error ? error.message : String(error), runId: params.runId };
        return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
      }
    },
  });
}
