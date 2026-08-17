import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(extensionDir);
const workspaceDir = dirname(packageDir);

const TASK_TYPE = Type.Union([
  Type.Literal("meeting_minutes"),
  Type.Literal("doc_writer"),
  Type.Literal("document_revision"),
  Type.Literal("feishu_bot"),
  Type.Literal("wechat_adapter"),
  Type.Literal("document_lifecycle"),
  Type.Literal("retrieval"),
  Type.Literal("calendar"),
  Type.Literal("task_management"),
  Type.Literal("research"),
  Type.Literal("knowledge_source"),
  Type.Literal("mixed"),
]);

const ACTION_INTENT = Type.Union([
  Type.Literal("read"),
  Type.Literal("draft"),
  Type.Literal("interact"),
  Type.Literal("review"),
  Type.Literal("write_private"),
  Type.Literal("publish_customer_visible"),
  Type.Literal("notify_people"),
  Type.Literal("mutate_calendar"),
  Type.Literal("assign_task"),
  Type.Literal("external_web"),
  Type.Literal("install_dependency"),
]);

const STEP_STATUS = Type.Union([
  Type.Literal("pending"),
  Type.Literal("ready"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
  Type.Literal("blocked"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("skipped"),
]);

const INTERACTION_KIND = Type.Union([
  Type.Literal("progress"),
  Type.Literal("decision"),
  Type.Literal("question"),
  Type.Literal("suggestion"),
]);

type TaskType =
  | "meeting_minutes"
  | "doc_writer"
  | "document_revision"
  | "feishu_bot"
  | "wechat_adapter"
  | "document_lifecycle"
  | "retrieval"
  | "calendar"
  | "task_management"
  | "research"
  | "knowledge_source"
  | "mixed";
type ActionIntent =
  | "read"
  | "draft"
  | "interact"
  | "review"
  | "write_private"
  | "publish_customer_visible"
  | "notify_people"
  | "mutate_calendar"
  | "assign_task"
  | "external_web"
  | "install_dependency";

type CapabilityNeed = {
  capabilityId: string;
  reason: string;
  loadMode: "always_on" | "lazy";
  contextCost: "low" | "medium" | "high";
};

type LedgerStep = {
  stepId: string;
  title: string;
  description: string;
  status: "pending" | "ready" | "in_progress" | "completed" | "blocked" | "failed" | "cancelled" | "skipped";
  dependsOn: string[];
  owner: string;
  capabilityId: string | null;
  acceptance: string[];
  inputRefs: string[];
  resultRefs: string[];
  attempts: number;
  blockedReason: string | null;
  completedAt?: string | null;
};

function nowIso() {
  return new Date().toISOString();
}

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
  if (!cleaned || cleaned === "." || cleaned === "..") throw new Error("unsafe_runtime_segment_blocked");
  return cleaned;
}

function runtimeRoot(outputRoot?: string) {
  const root = resolve(outputRoot ?? defaultOutputRoot());
  if (!isInside(workspaceDir, root)) throw new Error("planner_output_root_outside_workspace_blocked");
  return root;
}

function runDir(runId: string, outputRoot?: string) {
  const root = runtimeRoot(outputRoot);
  const path = resolve(root, safeRunId(runId));
  if (!isInside(root, path)) throw new Error("planner_run_dir_outside_root_blocked");
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

function uniqueStrings(values: unknown, limit = 200) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean))].slice(0, limit);
}

function stableId(prefix: string, value: string) {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 10)}`;
}

function addCapability(capabilities: CapabilityNeed[], capability: CapabilityNeed) {
  if (!capabilities.some((item) => item.capabilityId === capability.capabilityId)) capabilities.push(capability);
}

function addToolPlan(toolPlan: any[], toolIntent: ActionIntent, toolName: string, reason: string, policyCheckRequired?: boolean) {
  if (toolPlan.some((item) => item.toolIntent === toolIntent && item.toolName === toolName)) return;
  toolPlan.push({
    toolIntent,
    toolName,
    reason,
    policyCheckRequired: policyCheckRequired ?? [
      "publish_customer_visible",
      "notify_people",
      "mutate_calendar",
      "assign_task",
      "external_web",
      "install_dependency",
    ].includes(toolIntent),
  });
}

function inferTaskType(text: string, explicit?: TaskType): TaskType {
  if (explicit) return explicit;
  if (hasAny(text, ["wechat", "wechatcli", "微信", "微信群", "微信消息", "微信附件"])) return "wechat_adapter";
  if (hasAny(text, ["机器人不回复", "bot reply", "im.message.receive_v1", "feishu bot", "feishu inbound", "飞书机器人", "飞书双向", "飞书附件", "飞书发布"])) return "feishu_bot";
  if (hasAny(text, ["document_revision", "revision", "rewrite section", "批注", "修订"])) return "document_revision";
  if (hasAny(text, ["overwrite", "diff", "version", "source run", "覆盖修改", "变更摘要", "版本", "文档生命周期"])) return "document_lifecycle";
  if (hasAny(text, ["search previous", "retrieval", "find previous", "history", "上次", "之前", "历史", "检索", "找之前"])) return "retrieval";
  if (hasAny(text, ["calendar", "schedule", "日历", "排期", "会议邀请"])) return "calendar";
  if (hasAny(text, ["assign", "todo", "task", "任务", "待办"])) return "task_management";
  if (hasAny(text, ["latest", "official docs", "sdk", "mcp", "api docs", "官方文档", "最新", "查阅文档"])) return "research";
  if (hasAny(text, ["source pack", "source-pack", "youtube", "podcast", "rss", "小宇宙", "公开音频", "公开视频", "知识来源包"])) return "knowledge_source";
  if (hasAny(text, ["meeting", "transcript", "asr", "audio", "video", "会议", "纪要", "录音", "转写"])) return "meeting_minutes";
  if (hasAny(text, ["doc", "document", "write", "draft", "prd", "wiki", "文档", "撰写"])) return "doc_writer";
  return "mixed";
}

function documentCapability(docType: string) {
  if (docType === "meeting-minutes") return "meeting-minutes";
  if (docType === "prd" || docType === "customer-requirement-checklist") return "document-generation";
  if (docType === "tech-architecture") return "document-generation";
  if (docType === "ops-plan") return "document-generation";
  return "doc-writer";
}

function documentDependencies(docType: string, requested: Set<string>) {
  if (docType === "tech-architecture" && requested.has("prd")) return ["generate-prd"];
  if (docType === "customer-requirement-checklist") {
    return [requested.has("prd") ? "generate-prd" : null, requested.has("tech-architecture") ? "generate-tech-architecture" : null].filter(Boolean) as string[];
  }
  return [];
}

function buildSteps(params: any, taskType: TaskType, availableArtifacts: string[]): LedgerStep[] {
  const requestedOutputs = uniqueStrings(params.requestedOutputs, 20);
  const requested = new Set(requestedOutputs);
  const steps: LedgerStep[] = [];
  const add = (step: Omit<LedgerStep, "attempts" | "blockedReason" | "resultRefs"> & { resultRefs?: string[] }) => {
    if (!steps.some((item) => item.stepId === step.stepId)) {
      steps.push({ ...step, resultRefs: step.resultRefs ?? [], attempts: 0, blockedReason: null });
    }
  };

  if (taskType === "meeting_minutes" || requested.has("meeting-minutes")) {
    add({
      stepId: "understand-meeting",
      title: "完成会议理解与证据映射",
      description: "读取转录、参会人、议题、决定、行动、风险和产品发现信号。",
      status: availableArtifacts.some((item) => item.includes("meeting-analysis.json")) ? "completed" : "ready",
      dependsOn: [], owner: "parent", capabilityId: "meeting-intelligence",
      acceptance: ["会议结构和重要判断可以回溯到当前转录", "产品需求、假设和待确认问题被结构化"],
      inputRefs: availableArtifacts.filter((item) => /transcript|evidence/i.test(item)),
      resultRefs: availableArtifacts.filter((item) => item.includes("meeting-analysis.json")),
    });
  }

  if (taskType === "knowledge_source") {
    add({
      stepId: "resolve-public-url",
      title: "安全解析公开 URL",
      description: "识别平台、验证公网地址与重定向，并取得来源元数据。",
      status: "ready", dependsOn: [], owner: "parent", capabilityId: "public-url-source",
      acceptance: ["来源是用户明确提供的公开 URL", "SSRF、访问控制与大小边界检查通过"], inputRefs: [],
    });
    add({
      stepId: "acquire-source-content",
      title: "取得官方文稿或公开媒体",
      description: "优先官方带时间戳文稿；没有可靠文稿时才取得音频。",
      status: "pending", dependsOn: ["resolve-public-url"], owner: "parent", capabilityId: "public-url-source",
      acceptance: ["获取方式和来源元数据已记录", "未使用 Cookie 或绕过访问控制"], inputRefs: [],
    });
    add({
      stepId: "transcribe-source-media",
      title: "取得完整时间戳转写",
      description: "官方时间戳文稿可跳过；否则使用云端文件 ASR，partial 不得继续。",
      status: "pending", dependsOn: ["acquire-source-content"], owner: "parent", capabilityId: "cloud-asr",
      acceptance: ["完整转写状态为 complete", "片段包含可追踪时间戳与来源类型"], inputRefs: [],
    });
    add({
      stepId: "analyze-source-content",
      title: "分章生成知识 source pack",
      description: "按有界章节分析结构化转写，区分事实、作者观点、Agent 推断与开放问题。",
      status: "pending", dependsOn: ["transcribe-source-media"], owner: "parent", capabilityId: "public-url-source",
      acceptance: ["每个判断引用当前来源 segment id", "长转写未被整体反复注入模型"], inputRefs: [],
    });
    add({
      stepId: "verify-source-pack",
      title: "验收 source pack 与 provenance",
      description: "确认章节完整、所有 claim 可回溯，且没有把部分结果标成完整知识。",
      status: "pending", dependsOn: ["analyze-source-content"], owner: "parent", capabilityId: "qa-safety-review",
      acceptance: ["provenance 完整", "failed chapter 为零", "不写入外部知识库"], inputRefs: [],
    });
  }

  for (const docType of requestedOutputs) {
    const stepId = `generate-${docType}`;
    add({
      stepId,
      title: `生成 ${docType}`,
      description: `根据当前证据和文档契约生成 ${docType}，证据不足处保留待确认。`,
      status: "pending",
      dependsOn: [
        ...(docType === "meeting-minutes" && steps.some((item) => item.stepId === "understand-meeting") ? ["understand-meeting"] : []),
        ...documentDependencies(docType, requested),
      ],
      owner: "document-worker",
      capabilityId: documentCapability(docType),
      acceptance: [`${docType} 必需章节完整`, "关键结论有来源或明确标为待确认", "文档 QA 通过"],
      inputRefs: availableArtifacts,
    });
  }

  if (requestedOutputs.length === 0 && taskType !== "knowledge_source") {
    add({
      stepId: "complete-office-task",
      title: "完成当前办公任务",
      description: "基于用户目标选择最小能力集合并交付可验收结果。",
      status: "ready", dependsOn: [], owner: "parent", capabilityId: null,
      acceptance: uniqueStrings(params.successCriteria, 20), inputRefs: availableArtifacts,
    });
  }

  if (requestedOutputs.length > 0) {
    add({
      stepId: "verify-deliverables",
      title: "验收文档与证据覆盖",
      description: "将成功标准、QA、证据覆盖和依赖完成状态一并验收。",
      status: "pending",
      dependsOn: requestedOutputs.map((docType) => `generate-${docType}`),
      owner: "parent", capabilityId: "qa-safety-review",
      acceptance: uniqueStrings(params.successCriteria, 20), inputRefs: [],
    });
  }

  const stepIds = new Set(steps.map((step) => step.stepId));
  for (const step of steps) step.dependsOn = step.dependsOn.filter((dependency) => stepIds.has(dependency));
  const completed = new Set(steps.filter((step) => ["completed", "skipped"].includes(step.status)).map((step) => step.stepId));
  for (const step of steps) {
    if (step.status === "pending" && step.dependsOn.every((dependency) => completed.has(dependency))) step.status = "ready";
  }
  return steps;
}

function normalizeInteractionItems(values: unknown, validEvidence = new Set<string>()) {
  return (Array.isArray(values) ? values : []).map((value: any, index) => {
    const label = String(value?.label ?? value?.title ?? value?.question ?? value?.text ?? "").trim().slice(0, 240);
    if (!label) return null;
    const kind = ["progress", "decision", "question", "suggestion"].includes(String(value?.kind)) ? String(value.kind) : "question";
    const evidenceSegmentIds = uniqueStrings(value?.evidenceSegmentIds, 30).filter((id) => validEvidence.size === 0 || validEvidence.has(id));
    return {
      itemId: String(value?.itemId ?? stableId("interaction", `${index}:${label}`)),
      kind,
      label,
      description: String(value?.description ?? value?.why ?? "").trim().slice(0, 500),
      status: ["pending", "answered", "dismissed"].includes(String(value?.status)) ? String(value.status) : "pending",
      priority: ["high", "medium", "low"].includes(String(value?.priority)) ? String(value.priority) : "medium",
      order: Number.isInteger(value?.order) ? Number(value.order) : index,
      options: uniqueStrings(value?.options, 8),
      blocks: uniqueStrings(value?.blocks, 12),
      evidenceSegmentIds,
      suggestedDocuments: uniqueStrings(value?.suggestedDocuments, 8),
    };
  }).filter(Boolean).slice(0, 30);
}

function canonicalNextStepOptions(values: unknown) {
  const aliases = new Map([
    ["generate-prd", "prd"],
    ["draft-prd-with-open-questions", "prd"],
    ["generate-customer-requirement-checklist", "customer-requirement-checklist"],
    ["generate-tech-architecture", "tech-architecture"],
    ["generate-ops-plan", "ops-plan"],
  ]);
  return uniqueStrings(values, 12).map((value) => aliases.get(value) ?? value);
}

function deriveInteractionItems(params: any) {
  const explicit = normalizeInteractionItems(params.interactionItems);
  if (explicit.length > 0) return explicit;
  const discovery = params.meetingAnalysis?.productDiscovery ?? params.meetingAnalysis?.productDiscoverySummary;
  const values: any[] = [];
  for (const question of discovery?.clarificationQuestions ?? []) {
    values.push({
      kind: "question",
      label: question.question ?? question.text,
      description: question.why ?? question.reason,
      priority: question.priority,
      blocks: question.blocks,
      evidenceSegmentIds: question.evidenceSegmentIds,
    });
  }
  const docs = canonicalNextStepOptions(params.meetingAnalysis?.suggestedFollowUpDocuments);
  const discoveryOptions = canonicalNextStepOptions([
    ...(discovery?.nextStepOptions ?? []),
    ...(params.meetingAnalysis?.nextStepOptions ?? []),
  ]);
  const nextStepOptions = uniqueStrings([
    ...(values.some((item) => item.kind === "question") ? ["review-customer-questions"] : []),
    ...discoveryOptions,
    ...docs,
    ...(params.meetingAnalysis ? ["keep-meeting-minutes-only"] : []),
  ], 12);
  if (nextStepOptions.length > 0) {
    values.push({
      kind: "decision",
      label: "选择下一轮交付物",
      description: "会议理解已经完成，请选择继续生成的产品/交付文档；也可以补充自己的下一步。",
      priority: "high",
      options: nextStepOptions,
      suggestedDocuments: docs,
    });
  }
  return normalizeInteractionItems(values);
}

function buildEnvelope(params: any) {
  const availableArtifacts = uniqueStrings(params.availableArtifacts, 200);
  const text = normalized([
    params.goal ?? "",
    params.taskDescription ?? "",
    ...(params.requestedOutputs ?? []),
    ...availableArtifacts,
    params.meetingAnalysis ? JSON.stringify(params.meetingAnalysis) : "",
  ].join(" "));
  const taskType = inferTaskType(text, params.taskType);
  const capabilities: CapabilityNeed[] = [
    { capabilityId: "planner-runtime", reason: "Own the adaptive execution ledger and user-facing projections.", loadMode: "always_on", contextCost: "low" },
    { capabilityId: "policy-gate", reason: "Evaluate external action boundaries.", loadMode: "always_on", contextCost: "low" },
    { capabilityId: "runtime-observability", reason: "Record task transitions, artifacts and recovery evidence.", loadMode: "always_on", contextCost: "low" },
    { capabilityId: "capability-registry", reason: "Resolve capabilities lazily from ledger steps.", loadMode: "always_on", contextCost: "low" },
    { capabilityId: "qa-safety-review", reason: "Verify acceptance before completion.", loadMode: "always_on", contextCost: "low" },
  ];
  const toolPlan: any[] = [];
  const policyRisks: any[] = [];
  const requiredArtifacts = ["planner-envelope.json"];
  const constraints = [
    "The execution ledger is the only task-control source of truth; channel state, checkpoints and todos are projections.",
    "A step cannot start before its dependencies are completed.",
    "A step cannot be completed without acceptance evidence or result references.",
    "Child agents return result envelopes; only the parent reconciles global task state.",
    "Do not include secrets, tokens, cookies, CLI sessions, or App Secret values in planner artifacts.",
  ];
  const stopConditions = [
    "policy_gate_check returns blocked",
    "required input artifact is missing",
    "dependency cycle detected",
    "acceptance evidence is missing for a claimed completion",
  ];

  addToolPlan(toolPlan, "read", "capability_registry_plan", "Resolve capability readiness for ready ledger steps.", false);
  addToolPlan(toolPlan, "draft", "local_model", "Create private working results before external actions.", false);
  addToolPlan(toolPlan, "interact", "execution_ledger_todo", "Show progress, unresolved questions and next-step choices to the user.", false);

  const meetingOrchestrationMode = String(params.meetingAnalysis?.orchestrationMode ?? "direct");
  if (taskType === "meeting_minutes") {
    addCapability(capabilities, { capabilityId: "meeting-intelligence", reason: "Build meeting and product-discovery semantic state.", loadMode: "lazy", contextCost: "medium" });
    addCapability(capabilities, { capabilityId: "meeting-minutes", reason: "Generate evidence-grounded meeting minutes.", loadMode: "lazy", contextCost: "medium" });
    requiredArtifacts.push(
      "meeting-intelligence/meeting-analysis.json",
      "meeting-intelligence/product-discovery.json",
      "meeting-intelligence/next-step-options.json",
      "meeting-minutes.md",
    );
    constraints.push("Meeting facts and product discovery claims must reference current transcript evidence or remain assumptions/questions.");
  }
  if (hasAny(text, ["audio", "video", "asr", "录音", "转写", "音频", "视频"])) {
    addCapability(capabilities, { capabilityId: "cloud-asr", reason: "Transcribe supported meeting media through the configured file/stream endpoint.", loadMode: "lazy", contextCost: "medium" });
  }
  if (hasAny(text, ["prd", "tech-architecture", "customer-requirement-checklist", "需求", "产品", "架构", "checklist"])) {
    addCapability(capabilities, { capabilityId: "document-generation", reason: "Generate PRD, architecture and customer clarification deliverables from discovery state.", loadMode: "lazy", contextCost: "medium" });
  }
  if (taskType === "feishu_bot") {
    addCapability(capabilities, { capabilityId: "feishu-agent-bridge", reason: "Handle Feishu input and result delivery.", loadMode: "lazy", contextCost: "medium" });
    addToolPlan(toolPlan, "publish_customer_visible", "lark-cli", "Publish approved documents and reply to Feishu.", true);
    policyRisks.push({ actionIntent: "publish_customer_visible", reason: "Output is visible to Feishu users." });
  }
  if (taskType === "calendar" || taskType === "task_management") {
    const intent = taskType === "calendar" ? "mutate_calendar" : "assign_task";
    addToolPlan(toolPlan, intent, "calendar_task", "Create the requested office mutation after target resolution.", true);
    policyRisks.push({ actionIntent: intent, reason: "Office state mutation has external effects." });
  }
  if (taskType === "research") {
    addCapability(capabilities, { capabilityId: "web-access", reason: "Read current primary sources.", loadMode: "lazy", contextCost: "high" });
    addToolPlan(toolPlan, "external_web", "web_access", "Research current official sources.", true);
  }
  if (taskType === "knowledge_source") {
    addCapability(capabilities, { capabilityId: "public-url-source", reason: "Resolve user-provided public media URLs with bounded network access and provenance.", loadMode: "lazy", contextCost: "medium" });
    addCapability(capabilities, { capabilityId: "cloud-asr", reason: "Transcribe public media only when a reliable official timestamped transcript is unavailable.", loadMode: "lazy", contextCost: "medium" });
    addToolPlan(toolPlan, "external_web", "public_url_source_ingest", "Resolve the explicit public URL without credentials or access-control bypass.", true);
    requiredArtifacts.push("public-source/source-metadata.json", "public-source/source-pack/source-pack.json", "public-source/provenance/evidence-index.json");
    constraints.push("Do not route podcast or video sources into meeting-minutes semantics unless the user explicitly requests meeting treatment.");
  }
  if (hasAny(text, ["install", "package", "npm", "pip", "第三方包", "安装"])) {
    addToolPlan(toolPlan, "install_dependency", "package_audit", "Audit before dependency installation.", true);
    policyRisks.push({ actionIntent: "install_dependency", reason: "Third-party code changes runtime behavior." });
  }

  const steps = buildSteps(params, taskType, availableArtifacts);
  const interactionItems = deriveInteractionItems(params);
  const createdAt = nowIso();
  const planId = String(params.planId ?? stableId("plan", `${params.runId ?? "adhoc"}:${params.goal}`));
  const parallelizableWorkers = steps.filter((step) => step.status === "ready" && step.owner !== "parent").map((step) => ({
    component: step.owner,
    reason: `Ledger step ${step.stepId} is ready and dependency-safe.`,
    writeScope: step.resultRefs.length > 0 ? step.resultRefs.join(", ") : `result envelope for ${step.stepId}`,
  }));

  const envelope: any = {
    schemaVersion: "adaptive-execution-ledger-v1",
    planId,
    runId: params.runId ? safeRunId(params.runId) : null,
    revision: 1,
    status: steps.every((step) => ["completed", "skipped", "cancelled"].includes(step.status)) ? "completed" : "active",
    goal: params.goal,
    taskType,
    successCriteria: uniqueStrings(params.successCriteria?.length ? params.successCriteria : ["Complete the requested task with acceptance evidence."], 40),
    constraints: uniqueStrings([...(params.constraints ?? []), ...constraints], 80),
    capabilitiesNeeded: capabilities,
    toolPlan,
    steps,
    currentStepIds: steps.filter((step) => step.status === "in_progress").map((step) => step.stepId),
    nextStepIds: steps.filter((step) => step.status === "ready").map((step) => step.stepId),
    interactionItems,
    userTodoProjection: null,
    parallelizableWorkers,
    policyRisks,
    requiredArtifacts: uniqueStrings(requiredArtifacts, 80),
    stopConditions: uniqueStrings(stopConditions, 40),
    artifactIndex: Object.fromEntries(availableArtifacts.map((path, index) => [`artifact-${index + 1}`, path])),
    checkpointRefs: [],
    openQuestions: interactionItems.filter((item: any) => item.kind === "question" && item.status === "pending").map((item: any) => item.itemId),
    events: [{ eventId: stableId("event", `${planId}:created`), type: "plan_created", at: createdAt, actor: "parent" }],
    fixedWorkflow: false,
    plannerMode: "adaptive_execution_ledger",
    createdAt,
    updatedAt: createdAt,
    rawSecretsReturned: false,
    meetingContentAccess: "allowed",
  };
  envelope.userTodoProjection = buildTodoProjection(envelope);
  return envelope;
}

function buildTodoProjection(ledger: any) {
  const steps = Array.isArray(ledger?.steps) ? ledger.steps : [];
  const interactions = Array.isArray(ledger?.interactionItems) ? ledger.interactionItems : [];
  const items = [
    ...steps.map((step: any) => ({
      itemId: step.stepId,
      kind: "progress",
      label: step.title,
      status: step.status,
      interactive: false,
      options: [],
      blocks: step.dependsOn ?? [],
    })),
    ...[...interactions].sort((left: any, right: any) => Number(left.order ?? 0) - Number(right.order ?? 0)).map((item: any) => ({
      itemId: item.itemId,
      kind: item.kind,
      label: item.label,
      description: item.description,
      status: item.status,
      priority: item.priority,
      interactive: item.status === "pending" && ["decision", "question", "suggestion"].includes(item.kind),
      options: item.options ?? [],
      blocks: item.blocks ?? [],
    })),
  ];
  return {
    schemaVersion: "execution-todo-projection-v1",
    planId: ledger?.planId ?? null,
    revision: Number(ledger?.revision ?? 1),
    completed: steps.filter((step: any) => ["completed", "skipped", "cancelled"].includes(step.status)).length,
    total: steps.length,
    awaitingUser: interactions.some((item: any) => item.status === "pending" && ["decision", "question"].includes(item.kind)),
    items,
  };
}

function assertNoDependencyCycle(steps: LedgerStep[]) {
  const byId = new Map(steps.map((step) => [step.stepId, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("execution_ledger_dependency_cycle_blocked");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dependency)) throw new Error(`execution_ledger_dependency_missing:${dependency}`);
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const step of steps) visit(step.stepId);
}

function reconcileLedger(current: any, params: any) {
  if (!current || current.schemaVersion !== "adaptive-execution-ledger-v1") throw new Error("execution_ledger_invalid");
  if (params.operationId && (current.events ?? []).some((event: any) => event.operationId === params.operationId)) {
    return { ...current, userTodoProjection: buildTodoProjection(current), noOp: true, idempotentReplay: true };
  }
  if (params.expectedRevision !== undefined && Number(params.expectedRevision) !== Number(current.revision)) {
    throw new Error(`execution_ledger_revision_conflict:expected_${params.expectedRevision}_actual_${current.revision}`);
  }
  const now = nowIso();
  let changed = false;
  const patches = Array.isArray(params.stepUpdates) ? params.stepUpdates : [];
  const steps: LedgerStep[] = current.steps.map((step: LedgerStep) => {
    const patch = patches.find((item: any) => String(item.stepId) === step.stepId);
    if (!patch) return step;
    const nextStatus = patch.status ?? step.status;
    const completedDependencies = new Set(current.steps.filter((item: LedgerStep) => ["completed", "skipped"].includes(item.status)).map((item: LedgerStep) => item.stepId));
    const alreadyInProgress = step.status === "in_progress";
    if (nextStatus === "in_progress" && !step.dependsOn.every((dependency) => completedDependencies.has(dependency))) {
      throw new Error(`execution_ledger_dependency_not_ready:${step.stepId}`);
    }
    if (nextStatus === "completed" && !alreadyInProgress && !step.dependsOn.every((dependency) => completedDependencies.has(dependency))) {
      throw new Error(`execution_ledger_dependency_not_ready:${step.stepId}`);
    }
    const resultRefs = uniqueStrings([...(step.resultRefs ?? []), ...(patch.resultRefs ?? [])], 100);
    if (nextStatus === "completed" && resultRefs.length === 0 && step.acceptance.length > 0 && patch.acceptancePassed !== true) {
      throw new Error(`execution_ledger_completion_evidence_missing:${step.stepId}`);
    }
    changed = true;
    return {
      ...step,
      status: nextStatus,
      resultRefs,
      attempts: step.attempts + (nextStatus === "in_progress" && step.status !== "in_progress" ? 1 : 0),
      blockedReason: nextStatus === "blocked" ? String(patch.blockedReason ?? "blocked_without_reason") : null,
      completedAt: nextStatus === "completed" ? now : null,
    };
  });
  assertNoDependencyCycle(steps);
  const completed = new Set(steps.filter((step) => ["completed", "skipped"].includes(step.status)).map((step) => step.stepId));
  for (const step of steps) {
    if (step.status === "pending" && step.dependsOn.every((dependency) => completed.has(dependency))) {
      step.status = "ready";
      changed = true;
    }
  }
  const interactionUpdates = Array.isArray(params.interactionUpdates) ? params.interactionUpdates : [];
  let interactionItems = (current.interactionItems ?? []).map((item: any) => {
    const patch = interactionUpdates.find((value: any) => String(value.itemId) === item.itemId);
    if (!patch) return item;
    changed = true;
    return {
      ...item,
      status: patch.status ?? item.status,
      answer: patch.answer ?? item.answer ?? null,
      priority: patch.priority ?? item.priority,
      order: Number.isInteger(patch.order) ? Number(patch.order) : item.order,
    };
  });
  const additions = normalizeInteractionItems(params.interactionAdditions);
  for (const addition of additions) {
    if (interactionItems.some((item: any) => item.itemId === addition.itemId)) continue;
    interactionItems.push(addition);
    changed = true;
  }
  interactionItems = interactionItems.sort((left: any, right: any) => Number(left.order ?? 0) - Number(right.order ?? 0));
  if (!changed) return { ...current, userTodoProjection: buildTodoProjection(current), noOp: true };
  const revision = Number(current.revision ?? 1) + 1;
  const next = {
    ...current,
    revision,
    steps,
    interactionItems,
    currentStepIds: steps.filter((step) => step.status === "in_progress").map((step) => step.stepId),
    nextStepIds: steps.filter((step) => step.status === "ready").map((step) => step.stepId),
    openQuestions: interactionItems.filter((item: any) => item.kind === "question" && item.status === "pending").map((item: any) => item.itemId),
    status: steps.some((step) => ["blocked", "failed"].includes(step.status))
      ? "blocked"
      : steps.every((step) => ["completed", "skipped", "cancelled"].includes(step.status))
        ? "completed"
        : interactionItems.some((item: any) => item.status === "pending" && ["decision", "question"].includes(item.kind))
          ? "awaiting_user"
          : "active",
    updatedAt: now,
    events: [
      ...(current.events ?? []),
      { eventId: stableId("event", `${current.planId}:${revision}:${params.operationId ?? now}`), type: "ledger_reconciled", at: now, actor: params.actor ?? "parent", operationId: params.operationId ?? null },
    ].slice(-500),
  };
  next.userTodoProjection = buildTodoProjection(next);
  return next;
}

function writePlannerEnvelope(runId: string, envelope: unknown, outputRoot?: string) {
  const path = plannerPath(runId, outputRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  return path;
}

function readPlannerEnvelope(runId: string, outputRoot?: string) {
  const path = plannerPath(runId, outputRoot);
  if (!existsSync(path)) throw new Error("execution_ledger_not_found");
  return { path, ledger: JSON.parse(readFileSync(path, "utf8")) };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "planner_envelope_plan",
    label: "Adaptive Execution Ledger Plan",
    description: "Create the authoritative execution ledger and its user-facing todo projection before execution.",
    parameters: Type.Object({
      runId: Type.Optional(Type.String()),
      planId: Type.Optional(Type.String()),
      goal: Type.String(),
      taskType: Type.Optional(TASK_TYPE),
      taskDescription: Type.Optional(Type.String()),
      successCriteria: Type.Optional(Type.Array(Type.String())),
      constraints: Type.Optional(Type.Array(Type.String())),
      requestedOutputs: Type.Optional(Type.Array(Type.String())),
      availableArtifacts: Type.Optional(Type.Array(Type.String())),
      meetingAnalysis: Type.Optional(Type.Any()),
      interactionItems: Type.Optional(Type.Array(Type.Any())),
    }),
    async execute(_toolCallId, params): Promise<any> {
      try {
        const details = buildEnvelope(params);
        assertNoDependencyCycle(details.steps);
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      } catch (error) {
        const blocked = { status: "blocked", reason: error instanceof Error ? error.message : String(error), rawSecretsReturned: false };
        return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
      }
    },
  });

  pi.registerTool({
    name: "planner_envelope_write",
    label: "Adaptive Execution Ledger Write",
    description: "Persist the authoritative execution ledger inside the workspace run directory.",
    parameters: Type.Object({ runId: Type.String(), envelope: Type.Any(), outputRoot: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params): Promise<any> {
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

  pi.registerTool({
    name: "execution_ledger_reconcile",
    label: "Execution Ledger Reconcile",
    description: "Apply revision-checked task and user-interaction transitions to the authoritative ledger.",
    parameters: Type.Object({
      runId: Type.String(),
      outputRoot: Type.Optional(Type.String()),
      expectedRevision: Type.Optional(Type.Number()),
      operationId: Type.Optional(Type.String()),
      actor: Type.Optional(Type.String()),
      stepUpdates: Type.Optional(Type.Array(Type.Object({
        stepId: Type.String(),
        status: Type.Optional(STEP_STATUS),
        resultRefs: Type.Optional(Type.Array(Type.String())),
        acceptancePassed: Type.Optional(Type.Boolean()),
        blockedReason: Type.Optional(Type.String()),
      }))),
      interactionUpdates: Type.Optional(Type.Array(Type.Object({
        itemId: Type.String(),
        status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("answered"), Type.Literal("dismissed")])),
        answer: Type.Optional(Type.String()),
        priority: Type.Optional(Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")])),
        order: Type.Optional(Type.Number()),
      }))),
      interactionAdditions: Type.Optional(Type.Array(Type.Any())),
    }),
    async execute(_toolCallId, params): Promise<any> {
      try {
        const { path, ledger } = readPlannerEnvelope(params.runId, params.outputRoot);
        const details = reconcileLedger(ledger, params);
        writeFileSync(path, `${JSON.stringify(details, null, 2)}\n`, "utf8");
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      } catch (error) {
        const blocked = { status: "blocked", reason: error instanceof Error ? error.message : String(error), rawSecretsReturned: false };
        return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
      }
    },
  });

  pi.registerTool({
    name: "execution_ledger_todo",
    label: "Execution Todo Projection",
    description: "Read the user-facing progress, clarification and next-step projection from the execution ledger.",
    parameters: Type.Object({ runId: Type.String(), outputRoot: Type.Optional(Type.String()), kind: Type.Optional(INTERACTION_KIND) }),
    async execute(_toolCallId, params): Promise<any> {
      try {
        const { ledger } = readPlannerEnvelope(params.runId, params.outputRoot);
        const projection = buildTodoProjection(ledger);
        const items = params.kind ? projection.items.filter((item: any) => item.kind === params.kind) : projection.items;
        const details = { ...projection, items, rawSecretsReturned: false };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      } catch (error) {
        const blocked = { status: "blocked", reason: error instanceof Error ? error.message : String(error), rawSecretsReturned: false };
        return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
      }
    },
  });
}
