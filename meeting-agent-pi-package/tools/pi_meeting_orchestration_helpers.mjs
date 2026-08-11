import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PI_ENV_ALLOWLIST = new Set([
  "DEEPSEEK_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REVIEW_PROVIDER",
  "PI_REVIEW_MODEL",
]);

function parseDotenv(text) {
  const values = {};
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || !PI_ENV_ALLOWLIST.has(match[1])) continue;
    let value = match[2] ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    if (value) values[match[1]] = value;
  }
  return values;
}

export function loadPiMeetingOrchestrationEnv(workspaceDir, baseEnv = process.env) {
  const envPath = join(workspaceDir, ".env.local");
  const local = existsSync(envPath) ? parseDotenv(readFileSync(envPath, "utf8")) : {};
  const env = { ...baseEnv };
  const loadedKeys = [];
  for (const [key, value] of Object.entries(local)) {
    if (env[key]) continue;
    env[key] = value;
    loadedKeys.push(key);
  }
  const candidates = [];
  const addCandidate = (providerValue, modelValue, role) => {
    const provider = String(providerValue ?? "").trim();
    const model = String(modelValue ?? "").trim();
    if (!provider || !model || candidates.some((candidate) => candidate.provider === provider && candidate.model === model)) return;
    candidates.push({ provider, model, role });
  };
  addCandidate(env.PI_REVIEW_PROVIDER, env.PI_REVIEW_MODEL, "review");
  addCandidate(env.PI_PROVIDER, env.PI_MODEL, "primary");
  addCandidate("deepseek", "deepseek-v4-pro", "default");
  return { env, provider: candidates[0].provider, model: candidates[0].model, candidates, loadedKeys };
}

export function buildPiMeetingOrchestrationInvocation({
  workspaceDir,
  packageDir,
  planPath,
  provider,
  model,
  piCodingAgentDir,
}) {
  const prompt = [
    "产品所有者已明确启用 Pi Sub-agent 与 Pi Dynamic Workflows，用于当前会议的证据核验。",
    `读取项目生成的可信编排计划：${planPath}`,
    "如果 mode=single_subagent，必须调用 subagent，参数严格采用 executor.request。",
    "如果 mode=dynamic_workflow，必须调用 workflow，严格采用 executor.script、executor.args、background、concurrency、maxAgents 和 agentRetries。",
    "不要改写计划，不要调用 bash/edit/write，不要发布或通知任何人。子 Agent 只读取计划内明确列出的会议证据文件。",
    "工具完成后，简要返回其真实状态、结构化发现与未解决项；不得声称未执行的委派已经完成。",
  ].join("\n");
  return {
    command: process.execPath,
    args: [
      join(packageDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
      "--mode", "json",
      "--print",
      "--no-session",
      "--approve",
      "--provider", provider,
      "--model", model,
      "--thinking", "medium",
      "--tools", "read,subagent,workflow",
      prompt,
    ],
    cwd: workspaceDir,
    env: {
      PI_CODING_AGENT_DIR: piCodingAgentDir,
    },
    prompt,
  };
}

function messageText(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

export function parsePiMeetingOrchestrationOutput(stdout, expectedTool) {
  const events = [];
  const parseErrors = [];
  for (const [index, rawLine] of String(stdout ?? "").split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      parseErrors.push({ line: index + 1, preview: line.slice(0, 160) });
    }
  }
  const toolEvents = events.filter((event) => event?.type === "tool_execution_end");
  const requested = toolEvents.filter((event) => event.toolName === expectedTool);
  const toolEvent = requested.at(-1) ?? null;
  const assistantMessages = events
    .filter((event) => event?.type === "message_end")
    .map((event) => messageText(event.message))
    .filter(Boolean);
  const errorMessages = [...new Set(events
    .filter((event) => event?.type === "message_end" && event?.message?.role === "assistant" && event.message.errorMessage)
    .map((event) => String(event.message.errorMessage).slice(0, 1000)))];
  if (!toolEvent) {
    return {
      status: "blocked",
      reason: "delegation_tool_not_executed",
      expectedTool,
      observedTools: [...new Set(toolEvents.map((event) => event.toolName).filter(Boolean))],
      assistantSummary: assistantMessages.at(-1) ?? "",
      errorMessages,
      eventCount: events.length,
      parseErrors,
    };
  }
  return {
    status: toolEvent.isError ? "blocked" : "completed",
    reason: toolEvent.isError ? "delegation_tool_failed" : null,
    expectedTool,
    observedTools: [...new Set(toolEvents.map((event) => event.toolName).filter(Boolean))],
    assistantSummary: assistantMessages.at(-1) ?? "",
    errorMessages,
    result: toolEvent.result ?? null,
    eventCount: events.length,
    parseErrors,
  };
}

const CLAIM_COLLECTION_KEYS = new Set([
  "supportedClaims",
  "topicFindings",
  "decisionFindings",
  "actionFindings",
  "unresolved",
]);

export function reconcilePiMeetingOrchestrationResult(delegation, knownSegmentIds = []) {
  const known = new Set((Array.isArray(knownSegmentIds) ? knownSegmentIds : []).map((value) => String(value)));
  if (delegation?.status !== "completed") {
    return {
      status: delegation?.status ?? "blocked",
      toolRunStatus: delegation?.status ?? "blocked",
      evidenceScopeSatisfied: false,
      referencedSegmentIds: [],
      invalidSegmentIds: [],
      missingEvidencePaths: [],
      qaPriorities: [delegation?.reason ?? "delegated_review_unavailable"],
      result: null,
    };
  }
  const referenced = new Set();
  const missingEvidencePaths = [];
  const segmentPattern = /\b[A-Za-z][A-Za-z0-9_.-]*:(?:chunk|segment)-[A-Za-z0-9_.-]+\b/g;
  const walk = (value, path = "$", parentKey = "") => {
    if (typeof value === "string") {
      for (const match of value.matchAll(segmentPattern)) referenced.add(match[0]);
      return;
    }
    if (Array.isArray(value)) {
      if (CLAIM_COLLECTION_KEYS.has(parentKey)) {
        value.forEach((item, index) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return;
          const evidenceIds = Array.isArray(item.evidenceSegmentIds) ? item.evidenceSegmentIds.filter(Boolean) : [];
          if (evidenceIds.length === 0) missingEvidencePaths.push(`${path}[${index}]`);
        });
      }
      value.forEach((item, index) => walk(item, `${path}[${index}]`, parentKey));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`, key);
    }
  };
  walk({ result: delegation.result, assistantSummary: delegation.assistantSummary });
  const referencedSegmentIds = [...referenced];
  const invalidSegmentIds = referencedSegmentIds.filter((segmentId) => !known.has(segmentId));
  const evidenceScopeSatisfied = invalidSegmentIds.length === 0 && missingEvidencePaths.length === 0;
  return {
    status: evidenceScopeSatisfied ? "accepted" : "needs_review",
    toolRunStatus: delegation.status,
    evidenceScopeSatisfied,
    referencedSegmentIds,
    invalidSegmentIds,
    missingEvidencePaths,
    qaPriorities: [
      ...(invalidSegmentIds.length > 0 ? [`委派结果引用了 ${invalidSegmentIds.length} 个不属于当前 transcript 的 segment id。`] : []),
      ...(missingEvidencePaths.length > 0 ? [`委派结果有 ${missingEvidencePaths.length} 个事实性发现缺少 evidenceSegmentIds。`] : []),
    ],
    result: evidenceScopeSatisfied ? delegation.result : null,
  };
}

export function shouldRunPiMeetingOrchestration(plan, options = {}, env = process.env) {
  const setting = String(options.meetingAgenticDelegation ?? env.MEETING_AGENTIC_DELEGATION ?? "auto").toLowerCase();
  if (["0", "false", "off", "disabled"].includes(setting)) return { run: false, reason: "meeting_agentic_delegation_disabled" };
  if (!plan || plan.mode === "direct") return { run: false, reason: "parent_direct_mode" };
  if (!["single_subagent", "dynamic_workflow"].includes(plan.mode)) return { run: false, reason: "unsupported_orchestration_mode" };
  if (!["subagent", "workflow"].includes(plan.executor?.tool)) return { run: false, reason: "unsupported_orchestration_tool" };
  return { run: true, reason: "product_owner_enabled" };
}
