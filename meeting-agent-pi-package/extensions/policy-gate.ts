import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(extensionDir);
const workspaceDir = dirname(packageDir);

const ACTION_INTENT = Type.Union([
  Type.Literal("read"),
  Type.Literal("draft"),
  Type.Literal("write_private"),
  Type.Literal("publish_customer_visible"),
  Type.Literal("notify_people"),
  Type.Literal("mutate_calendar"),
  Type.Literal("assign_task"),
  Type.Literal("external_web"),
  Type.Literal("install_dependency"),
  Type.Literal("persist_memory"),
  Type.Literal("delete"),
]);

type ActionIntent =
  | "read"
  | "draft"
  | "write_private"
  | "publish_customer_visible"
  | "notify_people"
  | "mutate_calendar"
  | "assign_task"
  | "external_web"
  | "install_dependency"
  | "persist_memory"
  | "delete";

const CONFIRMATION_REQUIRED = new Set<ActionIntent>([
  "publish_customer_visible",
  "notify_people",
  "mutate_calendar",
  "assign_task",
  "install_dependency",
  "persist_memory",
]);

const DOCS_RESEARCH_CLASSES = new Set(["docs_or_sdk_research", "sdk_docs", "official_docs", "api_docs"]);
const FEISHU_WRITE_INTENTS = new Set<ActionIntent>(["write_private", "publish_customer_visible"]);

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
    throw new Error("policy_output_root_outside_workspace_blocked");
  }
  return root;
}

function runDir(runId: string, outputRoot?: string) {
  const root = runtimeRoot(outputRoot);
  const path = resolve(root, safeRunId(runId));
  if (!isInside(root, path)) {
    throw new Error("policy_run_dir_outside_root_blocked");
  }
  return path;
}

function policyPath(runId: string, outputRoot?: string) {
  return join(runDir(runId, outputRoot), "policy-gate.json");
}

function isDocsResearch(payloadClass?: string) {
  return Boolean(payloadClass && DOCS_RESEARCH_CLASSES.has(payloadClass));
}

function isFeishuExplicitWriteAllowed(params: any, actionIntent: ActionIntent) {
  if (!FEISHU_WRITE_INTENTS.has(actionIntent)) return false;
  if (params.feishuInbound !== true && params.channel !== "feishu") return false;
  if (params.explicitUserRequest !== true && params.userRequestedAction !== true) return false;
  if (params.destructiveAction === true) return false;
  if (params.modifyExistingDocument === true && params.targetSpecified !== true) return false;
  return true;
}

function buildDecision(params: any) {
  const actionIntent = params.actionIntent as ActionIntent;
  const reasons: string[] = [];
  let status: "pass" | "needs_confirmation" | "blocked" = "pass";
  let requiredUserConfirmation = false;
  let safeAlternative: string | null = null;
  let sourceRecordRequired = Boolean(params.sourceRecordRequired);

  if (actionIntent === "delete" || params.destructiveAction === true) {
    status = "blocked";
    reasons.push("destructive_action_blocked");
    safeAlternative = "Create, publish, or overwrite an explicitly targeted document instead; deletion is not supported.";
  }

  if (status !== "blocked" && params.modifyExistingDocument === true && params.targetSpecified !== true) {
    status = "needs_confirmation";
    requiredUserConfirmation = true;
    reasons.push("document_modify_target_required");
    safeAlternative = "Ask the user for an explicit file token/link, or modify a document generated in the current conversation.";
  }

  if (params.containsSecrets) {
    status = "blocked";
    reasons.push("secret_leak_blocked");
    safeAlternative = "Redact secrets/tokens/cookies/App Secret first, then retry with references only.";
  }

  if (params.rawMediaExternalUpload || params.rawTranscriptIncluded) {
    status = "blocked";
    reasons.push(params.rawMediaExternalUpload ? "raw_media_external_upload_blocked" : "raw_transcript_external_or_metrics_payload_blocked");
    safeAlternative = "Use local ASR/context-offload and pass only bounded evidence pointers to later steps.";
  }

  if (actionIntent === "external_web") {
    sourceRecordRequired = true;
    if (params.meetingFactsContext && params.externalWebAllowed !== true) {
      status = "blocked";
      reasons.push("external_web_blocked_for_meeting_fact_generation");
      safeAlternative = "Use transcript/evidence artifacts for meeting facts; web access may only verify generic docs with source records.";
    } else if (isDocsResearch(params.payloadClass) || params.externalWebAllowed === true) {
      reasons.push("external_web_allowed_with_source_record");
    } else if (status !== "blocked") {
      status = "needs_confirmation";
      requiredUserConfirmation = true;
      reasons.push("external_web_requires_confirmation_or_docs_payload_class");
      safeAlternative = "Continue with local artifacts only, or rerun as docs_or_sdk_research with source records.";
    }
  }

  if (status !== "blocked" && CONFIRMATION_REQUIRED.has(actionIntent)) {
    if (isFeishuExplicitWriteAllowed(params, actionIntent)) {
      reasons.push(`${actionIntent}_allowed_by_explicit_feishu_user_request`);
    } else if (params.channel === "wechat" && FEISHU_WRITE_INTENTS.has(actionIntent) && params.userConfirmed !== true) {
      status = "needs_confirmation";
      requiredUserConfirmation = true;
      reasons.push(`${actionIntent}_requires_confirmation_for_wechat_channel`);
    } else if (params.userConfirmed === true) {
      reasons.push("user_confirmation_recorded");
    } else {
      status = "needs_confirmation";
      requiredUserConfirmation = true;
      reasons.push(`${actionIntent}_requires_user_confirmation`);
    }
  }

  if (reasons.length === 0) {
    reasons.push(`${actionIntent}_within_default_boundary`);
  }

  return {
    schemaVersion: "policy-gate-v1",
    status,
    actionIntent,
    reasons,
    requiredUserConfirmation,
    safeAlternative,
    capabilityId: params.capabilityId ?? "",
    audience: params.audience ?? "private",
    payloadClass: params.payloadClass ?? "unspecified",
    riskLevel: params.riskLevel ?? (status === "blocked" ? "high" : requiredUserConfirmation ? "medium" : "low"),
    sourceRecordRequired,
    channel: params.channel ?? (params.feishuInbound === true ? "feishu" : "local"),
    targetSpecified: params.targetSpecified === true,
    evaluatedAt: new Date().toISOString(),
    rawSecretsReturned: false,
    rawTranscriptIncluded: false,
  };
}

function writePolicyDecision(runId: string, decision: unknown, outputRoot?: string) {
  const path = policyPath(runId, outputRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
  return path;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "policy_gate_check",
    label: "Policy Gate Check",
    description: "Check whether an action intent can proceed, needs confirmation, or is blocked.",
    parameters: Type.Object({
      actionIntent: ACTION_INTENT,
      capabilityId: Type.Optional(Type.String()),
      audience: Type.Optional(Type.String()),
      payloadClass: Type.Optional(Type.String()),
      riskLevel: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
      artifacts: Type.Optional(Type.Array(Type.String())),
      userConfirmed: Type.Optional(Type.Boolean()),
      externalWebAllowed: Type.Optional(Type.Boolean()),
      sourceRecordRequired: Type.Optional(Type.Boolean()),
      containsSecrets: Type.Optional(Type.Boolean()),
      rawMediaExternalUpload: Type.Optional(Type.Boolean()),
      rawTranscriptIncluded: Type.Optional(Type.Boolean()),
      meetingFactsContext: Type.Optional(Type.Boolean()),
      feishuInbound: Type.Optional(Type.Boolean()),
      channel: Type.Optional(Type.Union([Type.Literal("feishu"), Type.Literal("wechat"), Type.Literal("local")])),
      explicitUserRequest: Type.Optional(Type.Boolean()),
      userRequestedAction: Type.Optional(Type.Boolean()),
      destructiveAction: Type.Optional(Type.Boolean()),
      modifyExistingDocument: Type.Optional(Type.Boolean()),
      targetSpecified: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params) {
      try {
        const details = buildDecision(params);
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      } catch (error) {
        const blocked = { status: "blocked", reason: error instanceof Error ? error.message : String(error), rawSecretsReturned: false };
        return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
      }
    },
  });

  pi.registerTool({
    name: "policy_gate_write",
    label: "Policy Gate Write",
    description: "Write a policy-gate.json artifact inside the workspace runtime-runs directory.",
    parameters: Type.Object({
      runId: Type.String(),
      decision: Type.Any(),
      outputRoot: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      try {
        const path = writePolicyDecision(params.runId, params.decision, params.outputRoot);
        const details = { ok: true, runId: safeRunId(params.runId), policyGatePath: path, rawSecretsReturned: false };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      } catch (error) {
        const blocked = { status: "blocked", reason: error instanceof Error ? error.message : String(error), runId: params.runId };
        return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
      }
    },
  });
}
