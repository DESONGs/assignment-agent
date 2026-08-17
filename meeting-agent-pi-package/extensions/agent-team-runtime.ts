import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Worker } from "node:worker_threads";

type AgentTeamTask = {
  taskId?: string;
  componentId: string;
  input?: unknown;
};

type IndexedAgentTeamTask = AgentTeamTask & {
  taskIndex: number;
};

type AgentTeamRunDetails =
  | {
      status: string;
      reason: string;
      limits: typeof AGENT_TEAM_LIMITS;
    }
  | {
      status: string;
      reason: null;
      implementation: string;
      trueParallelWorkers: boolean;
      startedAt: string;
      finishedAt: string;
      taskCount: number;
      payloadBytes: number;
      requestedMaxWorkers: number;
      maxWorkers: number;
      requestedTimeoutMs: number;
      timeoutMs: number;
      capped: { maxWorkers: boolean; timeoutMs: boolean };
      limits: typeof AGENT_TEAM_LIMITS;
      results: unknown[];
    };

const DEFAULT_MAX_WORKERS = 3;
const MAX_TASKS = 24;
const MAX_WORKERS = 6;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 100;
const MAX_PAYLOAD_BYTES = 1_000_000;

const AGENT_TEAM_LIMITS = {
  maxTasks: MAX_TASKS,
  maxWorkers: MAX_WORKERS,
  minTimeoutMs: MIN_TIMEOUT_MS,
  maxTimeoutMs: MAX_TIMEOUT_MS,
  maxPayloadBytes: MAX_PAYLOAD_BYTES,
};

const COMPONENTS = [
  {
    componentId: "topic_map_extractor",
    purpose: "Extract candidate macro topics from transcript segments before drafting.",
    triggers: ["long meeting", "multi-topic meeting", "topicMap", "过度压缩", "长会议", "多议题"],
    writesFiles: false,
  },
  {
    componentId: "evidence_coverage_checker",
    purpose: "Check whether claims have supporting evidence pointers.",
    triggers: ["qa", "publish", "evidence coverage", "发布", "证据"],
    writesFiles: false,
  },
  {
    componentId: "entity_gate_checker",
    purpose: "Find unsupported, cross-meeting, or forbidden entities in draft text.",
    triggers: ["entity safety", "crossMeetingTerms", "unsupportedEntities", "实体", "跨会议"],
    writesFiles: false,
  },
  {
    componentId: "feishu_readiness_checker",
    purpose: "Check Feishu CLI/bot gateway readiness signals without returning secrets.",
    triggers: ["feishu", "bot reply", "publish readiness", "飞书", "机器人"],
    writesFiles: false,
  },
  {
    componentId: "document_shard_writer",
    purpose: "Validate a context-plane document work item before document worker execution. Document structure lives in prompts/*.md and evidence comes from context packs.",
    triggers: ["multi document", "document prompt", "documentWorkItem", "contextPackRef", "prd", "architecture", "ops", "checklist", "多文档", "PRD", "架构", "运营"],
    writesFiles: false,
  },
  {
    componentId: "risk_open_question_extractor",
    purpose: "Extract risk and open-question lines from source text.",
    triggers: ["risk", "open questions", "待确认", "风险", "开放问题"],
    writesFiles: false,
  },
];

const WORKER_CODE = `
const { parentPort, workerData } = require("node:worker_threads");

function now() {
  return new Date().toISOString();
}

function textFromInput(input) {
  if (!input) return "";
  if (typeof input === "string") return input;
  if (Array.isArray(input)) return input.map(textFromInput).join("\\n");
  if (Array.isArray(input.transcriptSegments)) {
    return input.transcriptSegments.map((segment) => segment.text || segment.content || "").join("\\n");
  }
  return [input.text, input.markdown, input.sourceSummary].filter(Boolean).join("\\n");
}

function segmentsFromInput(input) {
  if (Array.isArray(input?.transcriptSegments)) return input.transcriptSegments;
  const text = textFromInput(input);
  return text.split(/\\n+/).filter(Boolean).map((line, index) => ({ id: "line_" + index, text: line, chunkIndex: index }));
}

function topicMapExtractor(input) {
  const intelligenceTopics = input?.meetingAnalysis?.topicMap || input?.meetingIntelligence?.topicMap;
  if (Array.isArray(intelligenceTopics) && intelligenceTopics.length > 0) {
    const topics = intelligenceTopics.slice(0, 24).map((topic, index) => ({
      topicId: topic.topicId || "topic_" + index,
      label: topic.title || topic.macroTopic || "议题 " + (index + 1),
      segmentCount: Array.isArray(topic.evidenceSegmentIds) ? topic.evidenceSegmentIds.length : 0,
      segmentRefs: (topic.evidenceSegmentIds || []).slice(0, 20),
      sample: [topic.coreJudgment].filter(Boolean).map((value) => String(value).slice(0, 240)),
      shouldExpand: topic.evidenceDensity?.sustained === true || (topic.evidenceSegmentIds || []).length >= 3
    }));
    return {
      componentId: "topic_map_extractor",
      source: "meeting_intelligence",
      topics,
      omittedMacroTopicRisk: topics.filter((topic) => topic.shouldExpand).map((topic) => topic.topicId),
      segmentCount: topics.reduce((total, topic) => total + topic.segmentCount, 0)
    };
  }
  const segments = segmentsFromInput(input);
  const stop = new Set(["这个", "那个", "然后", "就是", "我们", "你们", "他们", "一个", "可以", "还是", "不是", "没有", "什么", "怎么", "已经", "比较", "可能"]);
  const groupSize = Math.max(8, Math.ceil(segments.length / 8));
  const topics = [];
  for (let start = 0; start < segments.length; start += groupSize) {
    const matched = segments.slice(start, start + groupSize);
    const counts = new Map();
    const terms = matched.map((segment) => String(segment.text || "")).join(" ").match(/[A-Za-z][A-Za-z0-9_.-]{2,}|[一-龥]{2,6}/g) || [];
    for (const term of terms) {
      if (stop.has(term)) continue;
      counts.set(term, (counts.get(term) || 0) + 1);
    }
    const labels = [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 3).map(([term]) => term);
    const index = topics.length;
    topics.push({
      topicId: "timeline_topic_" + (index + 1),
      label: labels.length ? labels.join(" / ") : "时间段议题 " + (index + 1),
      segmentCount: matched.length,
      segmentRefs: matched.slice(0, 20).map((segment, offset) => segment.id || segment.segmentId || segment.chunkIndex || start + offset),
      sample: matched.slice(0, 3).map((segment) => String(segment.text || "").slice(0, 160)),
      shouldExpand: matched.length >= 3
    });
  }
  return {
    componentId: "topic_map_extractor",
    source: "generic_timeline_fallback",
    topics,
    omittedMacroTopicRisk: topics.filter((topic) => topic.shouldExpand).map((topic) => topic.topicId),
    segmentCount: segments.length
  };
}

function evidenceCoverageChecker(input) {
  const claims = Array.isArray(input?.claims) ? input.claims : [];
  const evidence = Array.isArray(input?.evidence) ? input.evidence : [];
  const evidenceText = evidence.map((item) => String(item.text || item.content || item.summary || item)).join("\\n").toLowerCase();
  const results = claims.map((claim, index) => {
    const text = String(claim.text || claim.claim || claim);
    const keywords = text.toLowerCase().split(/[\\s,，。；;：:、]+/).filter((word) => word.length >= 2).slice(0, 8);
    const matchedKeywords = keywords.filter((word) => evidenceText.includes(word));
    return {
      claimId: claim.id || claim.claimId || "claim_" + index,
      text: text.slice(0, 240),
      covered: matchedKeywords.length >= Math.min(2, keywords.length || 1),
      matchedKeywords,
      evidenceRefs: evidence
        .filter((item) => matchedKeywords.some((word) => String(item.text || item.content || item.summary || item).toLowerCase().includes(word)))
        .slice(0, 5)
        .map((item, evidenceIndex) => item.evidence_id || item.evidenceId || item.id || "evidence_" + evidenceIndex)
    };
  });
  return {
    componentId: "evidence_coverage_checker",
    results,
    missingEvidenceClaims: results.filter((item) => !item.covered)
  };
}

function entityGateChecker(input) {
  const text = textFromInput(input);
  const groups = [
    ["unsupportedEntities", input?.unsupportedEntities || []],
    ["crossMeetingTerms", input?.crossMeetingTerms || []],
    ["forbiddenTerms", input?.forbiddenTerms || []],
    ["siblingForbiddenTerms", input?.siblingForbiddenTerms || []]
  ];
  const hits = {};
  for (const [name, terms] of groups) {
    hits[name] = (Array.isArray(terms) ? terms : []).filter((term) => term && text.includes(String(term)));
  }
  return {
    componentId: "entity_gate_checker",
    hits,
    pass: Object.values(hits).every((items) => items.length === 0)
  };
}

function feishuReadinessChecker(input) {
  const requiredEnv = input?.requiredEnv || ["FEISHU_APP_ID", "FEISHU_APP_SECRET"];
  const env = requiredEnv.map((name) => ({ name, present: Boolean(process.env[name] && String(process.env[name]).trim()) }));
  return {
    componentId: "feishu_readiness_checker",
    env,
    missingEnv: env.filter((item) => !item.present).map((item) => item.name),
    cliReady: input?.cliReady === true,
    botGatewayReady: input?.botGatewayReady === true,
    requiredEvents: ["im.message.receive_v1"],
    rawSecretsReturned: false
  };
}

function documentShardWriter(input) {
  const workItem = input?.documentWorkItem || input || {};
  const docType = workItem?.docType || "document";
  const promptFile = workItem?.promptFile || null;
  const promptPath = workItem?.promptPath || null;
  const workUnits = Array.isArray(workItem?.workUnits) ? workItem.workUnits : [];
  const contextPackRefs = workUnits.map((unit) => unit?.contextPackRef).filter(Boolean);
  const promptInstructions = workItem?.promptInstructions || null;
  if (contextPackRefs.length === 0) {
    return {
      componentId: "document_shard_writer",
      status: "blocked",
      reason: "context_plane_required",
      docType,
      expectedInput: "Provide documentWorkItem.workUnits[].contextPackRef from document_prompt_render_batch.",
      hardcodedDocumentScaffoldUsed: false
    };
  }
  return {
    componentId: "document_shard_writer",
    status: "ready_for_model_generation",
    docType,
    promptFile,
    promptPath,
    contextPackRefs,
    workUnitCount: workUnits.length,
    promptInstructionChars: String(promptInstructions || "").length,
    modelInputMode: "contextPackWorkUnit",
    nextStep: "model_generate_document_then_qa_gate",
    evidenceRequired: true,
    hardcodedDocumentScaffoldUsed: false
  };
}

function riskOpenQuestionExtractor(input) {
  const lines = textFromInput(input).split(/\\n+/).map((line) => line.trim()).filter(Boolean);
  const patterns = ["风险", "待确认", "问题", "不确定", "依赖", "blocked", "blocker", "缺少", "争议"];
  const matches = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => includesAny(line, patterns))
    .slice(0, 80);
  return {
    componentId: "risk_open_question_extractor",
    items: matches.map(({ line, index }) => ({ lineRef: "line_" + index, text: line.slice(0, 300) }))
  };
}

const handlers = {
  topic_map_extractor: topicMapExtractor,
  evidence_coverage_checker: evidenceCoverageChecker,
  entity_gate_checker: entityGateChecker,
  feishu_readiness_checker: feishuReadinessChecker,
  document_shard_writer: documentShardWriter,
  risk_open_question_extractor: riskOpenQuestionExtractor
};

try {
  const startedAt = now();
  const handler = handlers[workerData.componentId];
  if (!handler) {
    throw new Error("unknown_component:" + workerData.componentId);
  }
  const output = handler(workerData.input || {});
  parentPort.postMessage({
    taskId: workerData.taskId,
    taskIndex: workerData.taskIndex,
    componentId: workerData.componentId,
    status: "completed",
    startedAt,
    finishedAt: now(),
    output
  });
} catch (error) {
  parentPort.postMessage({
    taskId: workerData.taskId,
    taskIndex: workerData.taskIndex,
    componentId: workerData.componentId,
    status: "failed",
    error: error && error.message ? error.message : String(error),
    finishedAt: now()
  });
}
`;

function planComponents(taskDescription: string, requestedOutputs: string[] = []) {
  const text = taskDescription.toLowerCase();
  const outputs = requestedOutputs.join(" ").toLowerCase();
  const recommended = COMPONENTS.filter((component) => {
    const triggerHit = component.triggers.some((trigger) => text.includes(trigger.toLowerCase()));
    const outputHit = requestedOutputs.length > 0 && component.triggers.some((trigger) => outputs.includes(trigger.toLowerCase()));
    return triggerHit || outputHit;
  });
  const fallback = recommended.length > 0 ? recommended : COMPONENTS.filter((component) =>
    ["topic_map_extractor", "evidence_coverage_checker", "risk_open_question_extractor"].includes(component.componentId),
  );
  return {
    mode: "dynamic_component_pool",
    permanentRolesPreloaded: false,
    recommendedComponents: fallback,
    serialGates: ["qa_gate_evaluate", "feishu publish after qa pass"],
    parallelSafety: "Components do not write files. The orchestrator owns integration and artifact writes.",
  };
}

function blocked(reason: string, details: Record<string, unknown> = {}) {
  return {
    status: "blocked",
    reason,
    limits: AGENT_TEAM_LIMITS,
    ...details,
  };
}

function payloadSize(value: unknown) {
  try {
    const json = JSON.stringify(value ?? null);
    return { ok: true, bytes: Buffer.byteLength(json ?? "null", "utf8") };
  } catch (error) {
    return {
      ok: false,
      bytes: 0,
      error: error && typeof error === "object" && "message" in error ? String(error.message) : String(error),
    };
  }
}

function positiveInteger(value: unknown, fallback: number) {
  if (value === undefined || value === null) return { ok: true, value: fallback };
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    return { ok: false, value: fallback };
  }
  return { ok: true, value: Math.floor(numberValue) };
}

function taskIdFor(task: IndexedAgentTeamTask) {
  return task.taskId ?? `${task.componentId}_${task.taskIndex}`;
}

function normalizeWorkerResult(result: unknown, task: IndexedAgentTeamTask) {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return {
      ...result,
      taskId: (result as any).taskId ?? taskIdFor(task),
      taskIndex: task.taskIndex,
      componentId: (result as any).componentId ?? task.componentId,
    };
  }
  return {
    taskId: taskIdFor(task),
    taskIndex: task.taskIndex,
    componentId: task.componentId,
    status: "failed",
    error: "invalid_worker_result",
    output: result,
  };
}

function runWorker(task: IndexedAgentTeamTask, timeoutMs: number) {
  return new Promise((resolve) => {
    const taskId = taskIdFor(task);
    const worker = new Worker(WORKER_CODE, {
      eval: true,
      workerData: {
        taskId,
        taskIndex: task.taskIndex,
        componentId: task.componentId,
        input: task.input ?? {},
      },
    });
    const timer = setTimeout(() => {
      worker.terminate();
      resolve({
        taskId,
        taskIndex: task.taskIndex,
        componentId: task.componentId,
        status: "failed",
        error: "worker_timeout",
      });
    }, timeoutMs);
    worker.once("message", (message) => {
      clearTimeout(timer);
      resolve(normalizeWorkerResult(message, task));
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      resolve({
        taskId,
        taskIndex: task.taskIndex,
        componentId: task.componentId,
        status: "failed",
        error: error.message,
      });
    });
    worker.once("exit", (code) => {
      if (code !== 0) {
        clearTimeout(timer);
        resolve({
          taskId,
          taskIndex: task.taskIndex,
          componentId: task.componentId,
          status: "failed",
          error: `worker_exit_${code}`,
        });
      }
    });
  });
}

async function runPool(tasks: IndexedAgentTeamTask[], maxWorkers: number, timeoutMs: number) {
  const queue = [...tasks];
  const results: unknown[] = new Array(tasks.length);
  const workerCount = Math.max(1, Math.min(maxWorkers, tasks.length || 1));
  async function consume() {
    while (queue.length > 0) {
      const task = queue.shift();
      if (task) results[task.taskIndex] = await runWorker(task, timeoutMs);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => consume()));
  return results;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "agent_team_components",
    label: "Agent Team Components",
    description: "List dynamic agent-team runtime components. These are task-shaped workers, not permanent role prompts.",
    parameters: Type.Object({}),
    async execute() {
      const details = {
        mode: "dynamic_component_pool",
        implementation: "node_worker_threads",
        components: COMPONENTS,
      };
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });

  pi.registerTool({
    name: "agent_team_plan",
    label: "Agent Team Plan",
    description: "Recommend dynamic worker components for the current task.",
    parameters: Type.Object({
      taskDescription: Type.String(),
      requestedOutputs: Type.Optional(Type.Array(Type.String())),
      artifacts: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId, params) {
      const details = {
        ...planComponents(params.taskDescription, params.requestedOutputs ?? []),
        taskDescription: params.taskDescription,
        artifacts: params.artifacts ?? [],
      };
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });

  pi.registerTool({
    name: "agent_team_run",
    label: "Agent Team Run",
    description: "Run selected agent-team components concurrently with Node worker_threads. Components do not write files.",
    parameters: Type.Object({
      tasks: Type.Array(Type.Object({
        taskId: Type.Optional(Type.String()),
        componentId: Type.String(),
        input: Type.Optional(Type.Unknown()),
      })),
      maxWorkers: Type.Optional(Type.Number({ description: "Maximum concurrent workers. Defaults to 3." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Per-worker timeout. Defaults to 30000." })),
    }),
    async execute(_toolCallId, params): Promise<AgentToolResult<AgentTeamRunDetails>> {
      const known = new Set(COMPONENTS.map((component) => component.componentId));
      const rawTasks = Array.isArray(params.tasks) ? params.tasks : [];
      if (!Array.isArray(params.tasks)) {
        const blockedDetails = blocked("invalid_tasks", { message: "tasks must be an array." });
        return { content: [{ type: "text", text: JSON.stringify(blockedDetails, null, 2) }], details: blockedDetails };
      }
      if (rawTasks.length === 0) {
        const blockedDetails = blocked("no_tasks", { taskCount: 0 });
        return { content: [{ type: "text", text: JSON.stringify(blockedDetails, null, 2) }], details: blockedDetails };
      }
      if (rawTasks.length > MAX_TASKS) {
        const blockedDetails = blocked("too_many_tasks", { taskCount: rawTasks.length, maxTasks: MAX_TASKS });
        return { content: [{ type: "text", text: JSON.stringify(blockedDetails, null, 2) }], details: blockedDetails };
      }

      const measured = payloadSize(rawTasks);
      if (!measured.ok) {
        const blockedDetails = blocked("payload_not_serializable", { error: measured.error });
        return { content: [{ type: "text", text: JSON.stringify(blockedDetails, null, 2) }], details: blockedDetails };
      }
      if (measured.bytes > MAX_PAYLOAD_BYTES) {
        const blockedDetails = blocked("payload_too_large", {
          payloadBytes: measured.bytes,
          maxPayloadBytes: MAX_PAYLOAD_BYTES,
        });
        return { content: [{ type: "text", text: JSON.stringify(blockedDetails, null, 2) }], details: blockedDetails };
      }

      const requestedMaxWorkers = positiveInteger(params.maxWorkers, DEFAULT_MAX_WORKERS);
      if (!requestedMaxWorkers.ok) {
        const blockedDetails = blocked("invalid_max_workers", {
          requestedMaxWorkers: params.maxWorkers,
          defaultMaxWorkers: DEFAULT_MAX_WORKERS,
        });
        return { content: [{ type: "text", text: JSON.stringify(blockedDetails, null, 2) }], details: blockedDetails };
      }
      const requestedTimeoutMs = positiveInteger(params.timeoutMs, DEFAULT_TIMEOUT_MS);
      if (!requestedTimeoutMs.ok) {
        const blockedDetails = blocked("invalid_timeout_ms", {
          requestedTimeoutMs: params.timeoutMs,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        });
        return { content: [{ type: "text", text: JSON.stringify(blockedDetails, null, 2) }], details: blockedDetails };
      }

      const effectiveMaxWorkers = Math.min(requestedMaxWorkers.value, MAX_WORKERS, rawTasks.length);
      const effectiveTimeoutMs = Math.min(Math.max(requestedTimeoutMs.value, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
      const invalidShape = rawTasks
        .map((task, taskIndex) => ({ task, taskIndex }))
        .filter(({ task }) => !task || typeof task !== "object" || Array.isArray(task) ||
          typeof (task as any).componentId !== "string" || !(task as any).componentId.trim())
        .map(({ task, taskIndex }) => ({
          taskIndex,
          componentId: task && typeof task === "object" && !Array.isArray(task) ? ((task as any).componentId ?? null) : null,
          reason: "invalid_task",
        }));
      if (invalidShape.length > 0) {
        const blockedDetails = blocked("invalid_tasks", { invalidTasks: invalidShape });
        return { content: [{ type: "text", text: JSON.stringify(blockedDetails, null, 2) }], details: blockedDetails };
      }

      const indexedTasks: IndexedAgentTeamTask[] = (rawTasks as AgentTeamTask[]).map((task, taskIndex) => ({
        ...task,
        componentId: task.componentId.trim(),
        taskIndex,
      }));
      const invalid = indexedTasks
        .filter((task) => !known.has(task.componentId))
        .map((task) => ({ taskIndex: task.taskIndex, componentId: task.componentId }));
      if (invalid.length > 0) {
        const blockedDetails = blocked("unknown_component", {
          invalidComponents: invalid,
          availableComponents: [...known],
        });
        return { content: [{ type: "text", text: JSON.stringify(blockedDetails, null, 2) }], details: blockedDetails };
      }
      const startedAt = new Date().toISOString();
      const results = await runPool(indexedTasks, effectiveMaxWorkers, effectiveTimeoutMs);
      const details = {
        status: results.some((result: any) => result.status === "failed") ? "needs_review" : "completed",
        reason: null,
        implementation: "node_worker_threads",
        trueParallelWorkers: true,
        startedAt,
        finishedAt: new Date().toISOString(),
        taskCount: indexedTasks.length,
        payloadBytes: measured.bytes,
        requestedMaxWorkers: requestedMaxWorkers.value,
        maxWorkers: effectiveMaxWorkers,
        requestedTimeoutMs: requestedTimeoutMs.value,
        timeoutMs: effectiveTimeoutMs,
        capped: {
          maxWorkers: requestedMaxWorkers.value !== effectiveMaxWorkers,
          timeoutMs: requestedTimeoutMs.value !== effectiveTimeoutMs,
        },
        limits: AGENT_TEAM_LIMITS,
        results,
      };
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });
}
