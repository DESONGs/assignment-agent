const MAX_SPECIALISTS = 6;

const SINGLE_REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    supportedClaims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          evidenceSegmentIds: { type: "array", items: { type: "string" } },
        },
        required: ["text", "evidenceSegmentIds"],
        additionalProperties: false,
      },
    },
    unresolved: { type: "array", items: { type: "string" } },
    participantAttributionIssues: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "supportedClaims", "unresolved", "participantAttributionIssues"],
  additionalProperties: false,
};

function list(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values, limit = 100) {
  return [...new Set(list(values).map((value) => String(value ?? "").trim()).filter(Boolean))].slice(0, limit);
}

function compactText(value, maxChars = 320) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function jsStringLiteral(value) {
  return JSON.stringify(String(value ?? ""))
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function claimCount(topics, field) {
  return topics.reduce((total, topic) => total + list(topic?.[field]).length, 0);
}

function meetingSignals(meetingAnalysis) {
  const topics = list(meetingAnalysis?.topicMap);
  const evidence = list(meetingAnalysis?.evidenceMap);
  const decisionCount = claimCount(topics, "decisions");
  const actionCount = claimCount(topics, "actions");
  const riskCount = claimCount(topics, "risks");
  const openQuestionCount = claimCount(topics, "openQuestions");
  const unresolvedClaimCount = evidence.filter((claim) => claim?.status === "unresolved" || claim?.evidenceQuality === "needs_review_only").length;
  const sustainedTopicCount = topics.filter((topic) => topic?.evidenceDensity?.sustained === true).length;
  let score = 0;
  if (topics.length >= 2) score += 2;
  if (topics.length >= 5) score += 1;
  if (sustainedTopicCount >= 3) score += 2;
  if (decisionCount > 0) score += 1;
  if (actionCount > 0) score += 1;
  if (riskCount + openQuestionCount > 2) score += 1;
  if (unresolvedClaimCount > 0) score += 2;
  if (meetingAnalysis?.status !== "complete" || meetingAnalysis?.analysisMode !== "model_reasoned_validated") score += 2;
  return {
    topicCount: topics.length,
    sustainedTopicCount,
    decisionCount,
    actionCount,
    riskCount,
    openQuestionCount,
    unresolvedClaimCount,
    participantCount: Number(meetingAnalysis?.participantResolution?.participantCount ?? 0),
    score,
  };
}

function evidenceInstruction(paths) {
  return [
    `会议分析：${paths.meetingAnalysisPath}`,
    `完整转录：${paths.transcriptPath}`,
    paths.participantMapPath ? `参会人映射：${paths.participantMapPath}` : null,
    "只读取以上明确文件。逐项引用真实 segment id。允许核验带依据的姓名候选，但未知声纹聚类不能凭空推出姓名，候选也不能用于确定 owner、权限或承诺。",
    "不要猜测 owner、日期、金额或承诺。",
    "quality=needs_review 的证据只能支持风险或待确认，不能单独升级为已达成决定。",
  ].filter(Boolean).join("\n");
}

function specialistTasks(meetingAnalysis, paths) {
  const topics = list(meetingAnalysis?.topicMap);
  const signals = meetingSignals(meetingAnalysis);
  const common = evidenceInstruction(paths);
  const tasks = [];
  if (topics.length >= 2) {
    const prioritized = [...topics]
      .sort((left, right) => Number(right?.evidenceDensity?.segmentCount ?? 0) - Number(left?.evidenceDensity?.segmentCount ?? 0))
      .slice(0, 3);
    for (const topic of prioritized) {
      tasks.push({
        id: `topic-${topic.topicId ?? tasks.length + 1}`,
        label: `议题核验：${compactText(topic.title, 60)}`,
        agentType: "meeting-evidence-analyst",
        prompt: [
          common,
          `重点议题：${compactText(topic.title, 120)}`,
          `当前判断：${compactText(topic.coreJudgment, 500) || "待确认"}`,
          `候选证据：${uniqueStrings(topic.evidenceSegmentIds, 80).join(", ")}`,
          "核验该议题是否完整、当前判断是否过度、是否遗漏关键分歧，并返回结构化发现。",
        ].join("\n"),
      });
    }
  }
  if (signals.decisionCount > 0) {
    tasks.push({
      id: "decision-state-review",
      label: "决策状态核验",
      agentType: "meeting-decision-reviewer",
      prompt: `${common}\n逐项核验 proposed/agreed/rejected/unresolved 状态，重点检查讨论意见是否被误写成共识。`,
    });
  }
  if (signals.actionCount > 0) {
    tasks.push({
      id: "action-commitment-review",
      label: "行动项承诺核验",
      agentType: "meeting-action-reviewer",
      prompt: `${common}\n逐项核验行动内容、owner 和 due date；只保留有明确语音证据的归属与期限。`,
    });
  }
  if (signals.unresolvedClaimCount > 0 || meetingAnalysis?.status !== "complete") {
    tasks.push({
      id: "uncertainty-review",
      label: "低置信与遗漏核验",
      agentType: "meeting-evidence-analyst",
      prompt: `${common}\n专门检查 needs_review、语义跳变、多人归属冲突和可能遗漏；不得修补听不清的原话。`,
    });
  }
  return tasks.slice(0, MAX_SPECIALISTS);
}

export function buildPiSubagentRequest(specialist, paths = {}) {
  const agent = specialist?.agentType ?? "meeting-evidence-analyst";
  const task = specialist?.prompt ?? evidenceInstruction(paths);
  const workflowScript = [
    `const review = await runs.run("meeting-review", { agent: ${jsStringLiteral(agent)}, task: ${jsStringLiteral(task)} });`,
    "return review;",
  ].join("\n");
  return {
    workflowScript,
    context: "fresh",
    async: false,
    mission: false,
    agentScope: "project",
    includeProgress: false,
    outputSchema: SINGLE_REVIEW_OUTPUT_SCHEMA,
  };
}

export function buildMeetingDynamicWorkflowScript() {
  return String.raw`export const meta = {
  name: "meeting-evidence-review",
  description: "Dynamically review meeting topics, decisions, actions and uncertain ASR evidence",
  phases: [{ title: "Specialists" }, { title: "Cross-check" }, { title: "Synthesis" }],
}

const specialistSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    supportedClaims: { type: "array", items: { type: "object", properties: { text: { type: "string" }, evidenceSegmentIds: { type: "array", items: { type: "string" } } }, required: ["text", "evidenceSegmentIds"], additionalProperties: false } },
    unresolved: { type: "array", items: { type: "object", properties: { text: { type: "string" }, evidenceSegmentIds: { type: "array", items: { type: "string" } } }, required: ["text", "evidenceSegmentIds"], additionalProperties: false } },
    omittedTopics: { type: "array", items: { type: "string" } },
    participantAttributionIssues: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "supportedClaims", "unresolved", "omittedTopics", "participantAttributionIssues"],
  additionalProperties: false,
}

phase("Specialists")
const specialistResults = await parallel(args.specialists.map((item) => () => agent(item.prompt, {
  label: item.label,
  agentType: item.agentType,
  schema: specialistSchema,
  retries: 1,
})))

phase("Cross-check")
const coverage = await completenessCheck(args.objective, {
  expectedSpecialists: args.specialists.map((item) => item.id),
  specialistResults,
})
const verification = await verify({ specialistResults, coverage }, {
  reviewers: 2,
  threshold: 0.5,
  lens: ["evidence traceability and ASR uncertainty", "decision state and participant attribution"],
})

phase("Synthesis")
const synthesisSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["supported", "needs_review"] },
    topicFindings: { type: "array", items: { type: "object", properties: { topic: { type: "string" }, finding: { type: "string" }, evidenceSegmentIds: { type: "array", items: { type: "string" } } }, required: ["topic", "finding", "evidenceSegmentIds"], additionalProperties: false } },
    decisionFindings: { type: "array", items: { type: "object", properties: { text: { type: "string" }, evidenceSegmentIds: { type: "array", items: { type: "string" } } }, required: ["text", "evidenceSegmentIds"], additionalProperties: false } },
    actionFindings: { type: "array", items: { type: "object", properties: { text: { type: "string" }, evidenceSegmentIds: { type: "array", items: { type: "string" } } }, required: ["text", "evidenceSegmentIds"], additionalProperties: false } },
    unresolved: { type: "array", items: { type: "object", properties: { text: { type: "string" }, evidenceSegmentIds: { type: "array", items: { type: "string" } } }, required: ["text", "evidenceSegmentIds"], additionalProperties: false } },
    qaPriorities: { type: "array", items: { type: "string" } },
  },
  required: ["status", "topicFindings", "decisionFindings", "actionFindings", "unresolved", "qaPriorities"],
  additionalProperties: false,
}
return await agent(
  "综合以下独立核验结果。保留分歧和缺失，不做多数投票式事实创造。输出可供父 Agent 修订 Meeting Intelligence 与 QA 的结构化结果。\n" +
  JSON.stringify({ specialistResults, coverage, verification }),
  { label: "会议证据综合", agentType: "meeting-evidence-synthesizer", schema: synthesisSchema, retries: 1 },
)`;
}

export function buildMeetingOrchestrationPlan(meetingAnalysis, paths = {}) {
  const signals = meetingSignals(meetingAnalysis);
  const specialists = specialistTasks(meetingAnalysis, paths);
  let mode = "direct";
  if (specialists.length === 1 || (specialists.length > 0 && signals.score <= 4)) mode = "single_subagent";
  if (specialists.length >= 2 && signals.score >= 5) mode = "dynamic_workflow";
  const reason = mode === "direct"
    ? "当前会议结构简单，主 Agent 直接完成可减少无收益委派。"
    : mode === "single_subagent"
      ? "存在一个主要核验轴，使用独立子 Agent 获得新鲜上下文即可。"
      : "存在多个可独立核验的议题/决策/行动轴，适合并行子 Agent 与交叉核验。";
  return {
    schemaVersion: "meeting-agentic-orchestration-v1",
    mode,
    reason,
    signals,
    objective: "核验当前会议的议题覆盖、决策状态、行动项归属和低置信 ASR 证据，并把可回溯发现交还父 Agent。",
    parentAuthority: "父 Agent 保留最终整合、证据验证、文档生成和发布边界责任。",
    specialists,
    executor: mode === "dynamic_workflow"
      ? {
          package: "@quintinshaw/pi-dynamic-workflows",
          tool: "workflow",
          version: "3.5.1",
          script: buildMeetingDynamicWorkflowScript(),
          args: {
            objective: "核验当前会议的议题覆盖、决策状态、行动项归属和低置信 ASR 证据。",
            specialists,
          },
          background: false,
          concurrency: Math.min(4, Math.max(2, specialists.length)),
          maxAgents: Math.min(12, specialists.length + 4),
          agentRetries: 1,
        }
      : mode === "single_subagent"
        ? {
            package: "pi-subagents",
            tool: "subagent",
            version: "0.46.0",
            request: buildPiSubagentRequest(specialists[0], paths),
          }
        : { package: "meeting-agent-pi-package", tool: "direct_parent_reasoning" },
    rawSecretsReturned: false,
  };
}
