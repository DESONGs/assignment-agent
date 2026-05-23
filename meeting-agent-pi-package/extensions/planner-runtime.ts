import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(extensionDir);
const workspaceDir = dirname(packageDir);

const TASK_TYPE = Type.Union([
  Type.Literal("meeting_minutes"),
  Type.Literal("doc_writer"),
  Type.Literal("feishu_bot"),
  Type.Literal("wechat_adapter"),
  Type.Literal("document_lifecycle"),
  Type.Literal("retrieval"),
  Type.Literal("memory"),
  Type.Literal("calendar"),
  Type.Literal("task_management"),
  Type.Literal("research"),
  Type.Literal("mixed"),
]);

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
]);

type TaskType =
  | "meeting_minutes"
  | "doc_writer"
  | "feishu_bot"
  | "wechat_adapter"
  | "document_lifecycle"
  | "retrieval"
  | "memory"
  | "calendar"
  | "task_management"
  | "research"
  | "mixed";
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
  | "persist_memory";

type CapabilityNeed = {
  capabilityId: string;
  reason: string;
  loadMode: "always_on" | "lazy";
  contextCost: "low" | "medium" | "high";
};

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
    throw new Error("planner_output_root_outside_workspace_blocked");
  }
  return root;
}

function runDir(runId: string, outputRoot?: string) {
  const root = runtimeRoot(outputRoot);
  const path = resolve(root, safeRunId(runId));
  if (!isInside(root, path)) {
    throw new Error("planner_run_dir_outside_root_blocked");
  }
  return path;
}

function plannerPath(runId: string, outputRoot?: string) {
  return join(runDir(runId, outputRoot), "planner-envelope.json");
}

function normalized(value: string) {
  return value.toLowerCase();
}

function hasAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(normalized(term)));
}

function addCapability(capabilities: CapabilityNeed[], capability: CapabilityNeed) {
  if (!capabilities.some((item) => item.capabilityId === capability.capabilityId)) {
    capabilities.push(capability);
  }
}

function addToolPlan(toolPlan: any[], toolIntent: ActionIntent, toolName: string, reason: string, policyCheckRequired?: boolean) {
  if (!toolPlan.some((item) => item.toolIntent === toolIntent && item.toolName === toolName)) {
    toolPlan.push({
      toolIntent,
      toolName,
      reason,
      policyCheckRequired:
        policyCheckRequired ??
        ["publish_customer_visible", "notify_people", "mutate_calendar", "assign_task", "external_web", "install_dependency", "persist_memory"].includes(
          toolIntent,
        ),
    });
  }
}

function inferTaskType(text: string, explicit?: TaskType): TaskType {
  if (explicit) return explicit;
  if (hasAny(text, ["wechat", "wechatcli", "微信", "微信群", "微信消息", "微信附件"])) return "wechat_adapter";
  if (hasAny(text, ["机器人不回复", "bot reply", "im.message.receive_v1", "feishu bot", "feishu inbound", "event consume", "feishu agent bridge", "飞书机器人", "飞书双向", "飞书附件", "飞书发布"])) return "feishu_bot";
  if (hasAny(text, ["overwrite", "rewrite section", "diff", "version", "source run", "覆盖修改", "改写章节", "变更摘要", "版本", "文档生命周期"])) return "document_lifecycle";
  if (hasAny(text, ["search previous", "retrieval", "find previous", "history", "上次", "之前", "历史", "检索", "找之前"])) return "retrieval";
  if (hasAny(text, ["memory", "preference", "profile", "偏好", "记忆", "档案", "常用模板"])) return "memory";
  if (hasAny(text, ["calendar", "schedule", "日历", "排期", "会议邀请"])) return "calendar";
  if (hasAny(text, ["assign", "todo", "task", "任务", "待办"])) return "task_management";
  if (hasAny(text, ["latest", "official docs", "sdk", "mcp", "api docs", "官方文档", "最新", "查阅文档"])) return "research";
  if (hasAny(text, ["meeting", "transcript", "asr", "audio", "video", "会议", "纪要", "录音", "转写"])) return "meeting_minutes";
  if (hasAny(text, ["doc", "document", "write", "draft", "prd", "wiki", "文档", "撰写"])) return "doc_writer";
  return "mixed";
}

function buildEnvelope(params: any) {
  const text = normalized(
    [
      params.goal ?? "",
      params.taskDescription ?? "",
      ...(params.requestedOutputs ?? []),
      ...(params.availableArtifacts ?? []),
    ].join(" "),
  );
  const taskType = inferTaskType(text, params.taskType);
  const capabilities: CapabilityNeed[] = [
    {
      capabilityId: "planner-runtime",
      reason: "Create auditable planner envelope before selecting optional capabilities.",
      loadMode: "always_on",
      contextCost: "low",
    },
    {
      capabilityId: "policy-gate",
      reason: "Evaluate action boundaries before writes, notifications, installs, or external access.",
      loadMode: "always_on",
      contextCost: "low",
    },
    {
      capabilityId: "runtime-observability",
      reason: "Record planner, capability, policy, worker, model, tool, artifact, and package evidence.",
      loadMode: "always_on",
      contextCost: "low",
    },
    {
      capabilityId: "capability-registry",
      reason: "Select task capabilities lazily without loading optional integrations.",
      loadMode: "always_on",
      contextCost: "low",
    },
    {
      capabilityId: "qa-safety-review",
      reason: "Keep content QA available without forcing a meeting workflow.",
      loadMode: "always_on",
      contextCost: "low",
    },
  ];
  const toolPlan: any[] = [];
  const policyRisks: any[] = [];
  const requiredArtifacts = ["planner-envelope.json"];
  const constraints = [
    "Do not use a fixed meeting pipeline unless the task is a meeting/transcript scenario.",
    "Do not include secrets, tokens, cookies, CLI sessions, App Secret, or raw transcript bodies in planner/policy/metrics artifacts.",
    "Enable optional capabilities only when task evidence justifies them.",
  ];
  const stopConditions = [
    "policy_gate_check returns blocked",
    "required input artifact is missing",
    "requested action would leak secrets or raw media externally",
  ];

  addToolPlan(toolPlan, "read", "capability_registry_plan", "Inspect capability readiness without loading optional tools.", false);
  addToolPlan(toolPlan, "draft", "local_model", "Create private working draft before any external action.", false);

  const longOrMulti = hasAny(text, [
    "long meeting",
    "multi document",
    "raw transcript",
    "context prune",
    "evidence offload",
    "长会议",
    "多文档",
    "上下文",
    "完整迭代",
  ]);

  if (taskType === "meeting_minutes") {
    addCapability(capabilities, {
      capabilityId: "meeting-minutes",
      reason: "Task asks for meeting minutes or transcript-based summary.",
      loadMode: "lazy",
      contextCost: "medium",
    });
    requiredArtifacts.push("topicMap.json", "evidence-map.json", "meeting-minutes.md");
    constraints.push("Meeting facts must be sourced from transcript/evidence, not external web search.");
    stopConditions.push("topicMap omits a continuous macro topic");
  }

  if (taskType === "meeting_minutes" && (longOrMulti || hasAny(text, ["audio", "video", "asr", "录音", "转写", "音频", "视频"]))) {
    addCapability(capabilities, {
      capabilityId: "local-asr",
      reason: "Meeting media or long-session ingestion may require local transcription; raw media must remain local.",
      loadMode: "lazy",
      contextCost: "medium",
    });
  }

  if (longOrMulti && taskType === "meeting_minutes") {
    addCapability(capabilities, {
      capabilityId: "context-offload",
      reason: "Long transcript or multi-document evidence should be offloaded into bounded local artifacts.",
      loadMode: "lazy",
      contextCost: "low",
    });
    addCapability(capabilities, {
      capabilityId: "agent-team-runtime",
      reason: "Independent topic, evidence, and QA work can run as task-shaped workers.",
      loadMode: "lazy",
      contextCost: "medium",
    });
    addCapability(capabilities, {
      capabilityId: "model-fallback",
      reason: "Long generation benefits from explicit model route/fallback records.",
      loadMode: "lazy",
      contextCost: "low",
    });
  }

  if (taskType === "doc_writer" || taskType === "mixed") {
    addCapability(capabilities, {
      capabilityId: "doc-writer",
      reason: "Private document drafting/editing requested; meeting and Feishu flows stay disabled unless separately matched.",
      loadMode: "lazy",
      contextCost: "low",
    });
    addToolPlan(toolPlan, "write_private", "doc_writer", "Write or update private workspace document artifact.", false);
    requiredArtifacts.push("draft-document.md");
  }

  if (taskType === "feishu_bot") {
    addCapability(capabilities, {
      capabilityId: "feishu-agent-bridge",
      reason: "Feishu inbound events, attachment resolution, PI task handling, and approved publish/reply need the local bridge runner and handler.",
      loadMode: "lazy",
      contextCost: "medium",
    });
    addCapability(capabilities, {
      capabilityId: "feishu-bot-gateway",
      reason: "Feishu bot event/reply behavior was requested; SDK long-connection gateway can forward to the same local handler when CLI event consume is not used.",
      loadMode: "lazy",
      contextCost: "low",
    });
    addCapability(capabilities, {
      capabilityId: "feishu-cli",
      reason: "The bridge uses official lark-cli for event consume, attachment download, Drive/Markdown publish, and message replies.",
      loadMode: "lazy",
      contextCost: "low",
    });
    addToolPlan(toolPlan, "read", "feishu_event_runner", "Consume and normalize Feishu events through lark-cli event consume.", false);
    addToolPlan(toolPlan, "read", "feishu_agent_task_handler", "Resolve inbound task artifacts and attachments locally before PI generation.", false);
    addToolPlan(toolPlan, "publish_customer_visible", "lark-cli markdown +create|+overwrite / drive +create-folder", "Feishu document publishing needs QA; explicit Feishu user write requests can pass Policy Gate, while destructive actions remain blocked.", true);
    addToolPlan(toolPlan, "notify_people", "lark-cli im +messages-reply", "Bot reply may send a message to people.", true);
    policyRisks.push({ actionIntent: "publish_customer_visible", reason: "Feishu Markdown/Drive output is visible outside the local runtime." });
    policyRisks.push({ actionIntent: "notify_people", reason: "Bot reply is visible to Feishu users." });
    requiredArtifacts.push("feishu-event.json", "feishu-task.json", "feishu-run-state.json", "qa-gate.json", "policy-gate.json", "publish.json", "reply.json");
  }

  if (taskType === "wechat_adapter") {
    addCapability(capabilities, {
      capabilityId: "wechat-adapter",
      reason: "WeChat is a channel adapter that maps local/fixture messages into unified IM events and reuses the same runner/runtime path.",
      loadMode: "lazy",
      contextCost: "low",
    });
    addCapability(capabilities, {
      capabilityId: "file-context-service",
      reason: "WeChat attachments must use the same text/audio/unsupported-media context rules as Feishu.",
      loadMode: "lazy",
      contextCost: "medium",
    });
    addToolPlan(toolPlan, "read", "wechat_event_adapter", "Map WeChat fixture/local input into im-event-v1 without duplicating Planner/Router/Worker logic.", false);
    requiredArtifacts.push("im-event.json", "office-task-state.json", "run-manifest.json");
    constraints.push("WeChat adapter skeleton must not assume Feishu cloud document capabilities or duplicate Feishu bridge flow.");
  }

  if (taskType === "document_lifecycle") {
    addCapability(capabilities, {
      capabilityId: "office-runtime",
      reason: "Document creation, overwrite, rewrite, diff, version, and source-run metadata need a shared office object lifecycle layer.",
      loadMode: "lazy",
      contextCost: "low",
    });
    addToolPlan(toolPlan, "write_private", "document_lifecycle_plan", "Plan create/overwrite/rewrite/diff metadata before writing or publishing a document.", true);
    requiredArtifacts.push("document-lifecycle.json", "publish-target.json");
    constraints.push("Existing document modification requires an explicit file token/link or a document generated in this conversation.");
    stopConditions.push("delete, clear, remove, destroy, or ambiguous document target requested");
  }

  if (taskType === "retrieval") {
    addCapability(capabilities, {
      capabilityId: "office-runtime",
      reason: "Historical run/document lookup should use a pointer-only retrieval index instead of broad context injection.",
      loadMode: "lazy",
      contextCost: "low",
    });
    addToolPlan(toolPlan, "read", "retrieval_index_search", "Search pointer-only run/document index and return bounded previews.", false);
    requiredArtifacts.push("retrieval-index.json");
    constraints.push("Retrieval must return references, hashes, and bounded previews, never full raw transcripts or full files.");
  }

  if (taskType === "memory") {
    addCapability(capabilities, {
      capabilityId: "office-runtime",
      reason: "User/org preference updates must be recorded as reviewable memory proposals instead of automatic prompt mutations.",
      loadMode: "lazy",
      contextCost: "low",
    });
    addToolPlan(toolPlan, "persist_memory", "memory_proposal_write", "Write a reviewable memory proposal; persistence requires Policy Gate.", true);
    policyRisks.push({ actionIntent: "persist_memory", reason: "Long-term memory can affect future tasks and must remain reviewable." });
    requiredArtifacts.push("memory-proposal.json", "policy-gate.json");
  }

  if (taskType === "calendar" || taskType === "task_management") {
    addCapability(capabilities, {
      capabilityId: "calendar-task",
      reason: "Calendar/task mutation requested through approved office connector path.",
      loadMode: "lazy",
      contextCost: "low",
    });
    const intent = taskType === "calendar" ? "mutate_calendar" : "assign_task";
    addToolPlan(toolPlan, intent, "calendar_task", "Calendar or task state changes require confirmation.", true);
    policyRisks.push({ actionIntent: intent, reason: "Office state mutation requires explicit confirmation." });
    requiredArtifacts.push("policy-gate.json", "office-action-draft.json");
  }

  if (taskType === "research") {
    addCapability(capabilities, {
      capabilityId: "web-access",
      reason: "Time-sensitive SDK/MCP/API documentation requires current official sources.",
      loadMode: "lazy",
      contextCost: "high",
    });
    addToolPlan(toolPlan, "external_web", "web_access", "Official/current docs lookup must record sources.", true);
    policyRisks.push({ actionIntent: "external_web", reason: "External web is allowed only with source records and not for meeting facts." });
    requiredArtifacts.push("source-records.json");
  }

  if (hasAny(text, ["install", "package", "npm", "pip", "第三方包", "安装"])) {
    addToolPlan(toolPlan, "install_dependency", "package_audit", "Dependency install requires package audit and confirmation.", true);
    policyRisks.push({ actionIntent: "install_dependency", reason: "Third-party package install requires safety audit before enablement." });
    requiredArtifacts.push("package-audit.json", "policy-gate.json");
  }

  if (hasAny(text, ["publish", "发布", "customer visible", "飞书发布"])) {
    addToolPlan(toolPlan, "publish_customer_visible", "publish_connector", "Customer-visible publish requires QA and action-boundary Policy Gate.", true);
    policyRisks.push({ actionIntent: "publish_customer_visible", reason: "Customer-visible output requires QA gate; Feishu explicit write requests may satisfy publish authorization." });
    requiredArtifacts.push("qa-gate.json", "policy-gate.json");
  }

  const parallelizableWorkers =
    longOrMulti && taskType === "meeting_minutes"
      ? [
          {
            component: "topic-map",
            reason: "Identify macro topics before final structure decisions.",
            writeScope: "topicMap/evidence pointers only",
          },
          {
            component: "evidence-coverage",
            reason: "Check that long continuous topics are not compressed into a single bullet.",
            writeScope: "coverage report only",
          },
          {
            component: "qa-risk",
            reason: "Pre-check omitted macro topics, cross-meeting terms, and action-item coverage.",
            writeScope: "qa findings only",
          },
        ]
      : [];

  return {
    schemaVersion: "planner-envelope-v1",
    goal: params.goal,
    taskType,
    successCriteria:
      params.successCriteria?.length > 0
        ? params.successCriteria
        : ["Complete the requested task with auditable capability and policy decisions."],
    constraints: Array.from(new Set([...(params.constraints ?? []), ...constraints])),
    capabilitiesNeeded: capabilities,
    toolPlan,
    parallelizableWorkers,
    policyRisks,
    requiredArtifacts: Array.from(new Set(requiredArtifacts)),
    stopConditions: Array.from(new Set(stopConditions)),
    fixedWorkflow: false,
    plannerMode: "scenario_playbook",
    rawSecretsReturned: false,
    rawTranscriptIncluded: false,
    createdAt: new Date().toISOString(),
  };
}

function writePlannerEnvelope(runId: string, envelope: unknown, outputRoot?: string) {
  const path = plannerPath(runId, outputRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  return path;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "planner_envelope_plan",
    label: "Planner Envelope Plan",
    description: "Create an auditable scenario planner envelope before selecting lazy office capabilities.",
    parameters: Type.Object({
      goal: Type.String({ description: "Concrete user goal." }),
      taskType: Type.Optional(TASK_TYPE),
      taskDescription: Type.Optional(Type.String({ description: "Additional task context." })),
      successCriteria: Type.Optional(Type.Array(Type.String())),
      constraints: Type.Optional(Type.Array(Type.String())),
      requestedOutputs: Type.Optional(Type.Array(Type.String())),
      availableArtifacts: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId, params) {
      try {
        const details = buildEnvelope(params);
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      } catch (error) {
        const blocked = { status: "blocked", reason: error instanceof Error ? error.message : String(error), rawSecretsReturned: false };
        return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
      }
    },
  });

  pi.registerTool({
    name: "planner_envelope_write",
    label: "Planner Envelope Write",
    description: "Write a planner-envelope.json artifact inside the workspace runtime-runs directory.",
    parameters: Type.Object({
      runId: Type.String(),
      envelope: Type.Any(),
      outputRoot: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      try {
        const path = writePlannerEnvelope(params.runId, params.envelope, params.outputRoot);
        const details = { ok: true, runId: safeRunId(params.runId), plannerEnvelopePath: path, rawSecretsReturned: false };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      } catch (error) {
        const blocked = { status: "blocked", reason: error instanceof Error ? error.message : String(error), runId: params.runId };
        return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
      }
    },
  });
}
