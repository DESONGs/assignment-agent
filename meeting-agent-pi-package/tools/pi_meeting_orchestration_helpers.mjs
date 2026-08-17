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

/**
 * @typedef {{ provider: string, model: string, role: string }} ProviderCandidate
 * @typedef {{ workspaceDir: string, packageDir: string, planPath: string, provider: string, model: string, piCodingAgentDir: string }} PiInvocationInput
 * @typedef {{ role?: unknown, content?: Array<{ type?: unknown, text?: unknown }>, errorMessage?: unknown }} PiMessage
 * @typedef {{ status?: unknown, reason?: unknown, result?: unknown, assistantSummary?: unknown }} DelegationResult
 * @typedef {{ mode?: unknown, executor?: { tool?: unknown } }} OrchestrationPlan
 */

/** @param {unknown} value @returns {Record<string, unknown>} */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @param {unknown} text @returns {Record<string, string>} */
function parseDotenv(text) {
  /** @type {Record<string, string>} */
  const values = {};
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    const key = match?.[1];
    if (!key || !PI_ENV_ALLOWLIST.has(key)) continue;
    let value = match[2] ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    if (value) values[key] = value;
  }
  return values;
}

/** @param {string} workspaceDir @param {NodeJS.ProcessEnv} [baseEnv] */
export function loadPiMeetingOrchestrationEnv(workspaceDir, baseEnv = process.env) {
  const envPath = join(workspaceDir, ".env.local");
  const local = existsSync(envPath) ? parseDotenv(readFileSync(envPath, "utf8")) : {};
  const env = { ...baseEnv };
  /** @type {string[]} */
  const loadedKeys = [];
  for (const [key, value] of Object.entries(local)) {
    if (env[key]) continue;
    env[key] = value;
    loadedKeys.push(key);
  }
  /** @type {ProviderCandidate[]} */
  const candidates = [];
  /** @param {unknown} providerValue @param {unknown} modelValue @param {string} role */
  const addCandidate = (providerValue, modelValue, role) => {
    const provider = String(providerValue ?? "").trim();
    const model = String(modelValue ?? "").trim();
    if (!provider || !model || candidates.some((candidate) => candidate.provider === provider && candidate.model === model)) return;
    candidates.push({ provider, model, role });
  };
  addCandidate(env.PI_REVIEW_PROVIDER, env.PI_REVIEW_MODEL, "review");
  addCandidate(env.PI_PROVIDER, env.PI_MODEL, "primary");
  addCandidate("deepseek", "deepseek-v4-pro", "default");
  const selected = candidates[0];
  if (!selected) throw new Error("pi_meeting_provider_candidate_missing");
  return { env, provider: selected.provider, model: selected.model, candidates, loadedKeys };
}

/** @param {PiInvocationInput} input */
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

/** @param {unknown} message */
function messageText(message) {
  const normalized = /** @type {PiMessage} */ (asRecord(message));
  if (normalized.role !== "assistant" || !Array.isArray(normalized.content)) return "";
  return normalized.content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

/** @param {unknown} stdout @param {string} expectedTool */
export function parsePiMeetingOrchestrationOutput(stdout, expectedTool) {
  /** @type {Array<Record<string, unknown>>} */
  const events = [];
  /** @type {Array<{ line: number, preview: string }>} */
  const parseErrors = [];
  for (const [index, rawLine] of String(stdout ?? "").split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      events.push(asRecord(JSON.parse(line)));
    } catch {
      parseErrors.push({ line: index + 1, preview: line.slice(0, 160) });
    }
  }
  const toolEvents = events.filter((event) => event.type === "tool_execution_end");
  const requested = toolEvents.filter((event) => event.toolName === expectedTool);
  const toolEvent = requested.at(-1) ?? null;
  const assistantMessages = events
    .filter((event) => event.type === "message_end")
    .map((event) => messageText(event.message))
    .filter(Boolean);
  const errorMessages = [...new Set(events
    .filter((event) => event.type === "message_end" && asRecord(event.message).role === "assistant" && asRecord(event.message).errorMessage)
    .map((event) => String(asRecord(event.message).errorMessage).slice(0, 1000)))];
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

/** @param {unknown} delegation @param {unknown[]} [knownSegmentIds] */
export function reconcilePiMeetingOrchestrationResult(delegation, knownSegmentIds = []) {
  const normalizedDelegation = /** @type {DelegationResult} */ (asRecord(delegation));
  const known = new Set((Array.isArray(knownSegmentIds) ? knownSegmentIds : []).map((value) => String(value)));
  if (normalizedDelegation.status !== "completed") {
    return {
      status: normalizedDelegation.status ?? "blocked",
      toolRunStatus: normalizedDelegation.status ?? "blocked",
      evidenceScopeSatisfied: false,
      referencedSegmentIds: [],
      invalidSegmentIds: [],
      missingEvidencePaths: [],
      qaPriorities: [normalizedDelegation.reason ?? "delegated_review_unavailable"],
      result: null,
    };
  }
  /** @type {Set<string>} */
  const referenced = new Set();
  /** @type {string[]} */
  const missingEvidencePaths = [];
  const segmentPattern = /\b[A-Za-z][A-Za-z0-9_.-]*:(?:chunk|segment)-[A-Za-z0-9_.-]+\b/g;
  /** @param {unknown} value @param {string} [path] @param {string} [parentKey] */
  const walk = (value, path = "$", parentKey = "") => {
    if (typeof value === "string") {
      for (const match of value.matchAll(segmentPattern)) referenced.add(match[0]);
      return;
    }
    if (Array.isArray(value)) {
      if (CLAIM_COLLECTION_KEYS.has(parentKey)) {
        value.forEach((item, index) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return;
          const record = asRecord(item);
          const evidenceIds = Array.isArray(record.evidenceSegmentIds) ? record.evidenceSegmentIds.filter(Boolean) : [];
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
  walk({ result: normalizedDelegation.result, assistantSummary: normalizedDelegation.assistantSummary });
  const referencedSegmentIds = [...referenced];
  const invalidSegmentIds = referencedSegmentIds.filter((segmentId) => !known.has(segmentId));
  const evidenceScopeSatisfied = invalidSegmentIds.length === 0 && missingEvidencePaths.length === 0;
  return {
    status: evidenceScopeSatisfied ? "accepted" : "needs_review",
    toolRunStatus: normalizedDelegation.status,
    evidenceScopeSatisfied,
    referencedSegmentIds,
    invalidSegmentIds,
    missingEvidencePaths,
    qaPriorities: [
      ...(invalidSegmentIds.length > 0 ? [`委派结果引用了 ${invalidSegmentIds.length} 个不属于当前 transcript 的 segment id。`] : []),
      ...(missingEvidencePaths.length > 0 ? [`委派结果有 ${missingEvidencePaths.length} 个事实性发现缺少 evidenceSegmentIds。`] : []),
    ],
    result: evidenceScopeSatisfied ? normalizedDelegation.result : null,
  };
}

/** @param {unknown} plan @param {{ meetingAgenticDelegation?: unknown }} [options] @param {NodeJS.ProcessEnv} [env] */
export function shouldRunPiMeetingOrchestration(plan, options = {}, env = process.env) {
  const normalizedPlan = /** @type {OrchestrationPlan} */ (asRecord(plan));
  const setting = String(options.meetingAgenticDelegation ?? env.MEETING_AGENTIC_DELEGATION ?? "auto").toLowerCase();
  if (["0", "false", "off", "disabled"].includes(setting)) return { run: false, reason: "meeting_agentic_delegation_disabled" };
  if (!plan || normalizedPlan.mode === "direct") return { run: false, reason: "parent_direct_mode" };
  if (!["single_subagent", "dynamic_workflow"].includes(String(normalizedPlan.mode ?? ""))) return { run: false, reason: "unsupported_orchestration_mode" };
  if (!["subagent", "workflow"].includes(String(normalizedPlan.executor?.tool ?? ""))) return { run: false, reason: "unsupported_orchestration_tool" };
  return { run: true, reason: "product_owner_enabled" };
}
