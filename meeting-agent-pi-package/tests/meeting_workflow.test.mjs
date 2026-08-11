import assert from "node:assert/strict";
import test from "node:test";
import { buildMeetingDynamicWorkflowScript, buildMeetingOrchestrationPlan, buildPiSubagentRequest } from "../tools/meeting_workflow_helpers.mjs";

const paths = {
  meetingAnalysisPath: "runtime-runs/run/artifacts/meeting-intelligence/meeting-analysis.json",
  transcriptPath: "runtime-runs/run/artifacts/transcripts/transcript.full.json",
  participantMapPath: "runtime-runs/run/artifacts/meeting-intelligence/participant-map.json",
};

test("simple meeting stays with the parent agent", () => {
  const plan = buildMeetingOrchestrationPlan({
    status: "complete",
    analysisMode: "model_reasoned_validated",
    topicMap: [{ topicId: "topic-01", title: "例会同步", evidenceDensity: { sustained: false, segmentCount: 2 }, decisions: [], actions: [], risks: [], openQuestions: [] }],
    evidenceMap: [],
  }, paths);
  assert.equal(plan.mode, "direct");
  assert.equal(plan.executor.tool, "direct_parent_reasoning");
});

test("one independent review axis uses one fresh subagent", () => {
  const plan = buildMeetingOrchestrationPlan({
    status: "complete",
    analysisMode: "model_reasoned_validated",
    topicMap: [{ topicId: "topic-01", title: "行动安排", evidenceDensity: { sustained: true, segmentCount: 8 }, decisions: [], actions: [{ text: "跟进" }], risks: [], openQuestions: [] }],
    evidenceMap: [],
  }, paths);
  assert.equal(plan.mode, "single_subagent");
  assert.equal(plan.executor.package, "pi-subagents");
  assert.equal(plan.executor.request.context, "fresh");
  assert.equal(plan.executor.request.async, false);
  assert.equal(plan.executor.request.mission, false);
  assert.match(plan.executor.request.workflowScript, /runs\.run\("meeting-review"/);
  assert.equal("agent" in plan.executor.request, false);
  assert.equal(plan.executor.request.outputSchema.type, "object");
});

test("complex meeting produces bounded dynamic workflow specialists", () => {
  const topics = Array.from({ length: 4 }, (_, index) => ({
    topicId: `topic-0${index + 1}`,
    title: `议题 ${index + 1}`,
    coreJudgment: "存在讨论与待核验结论",
    evidenceSegmentIds: [`audio-01:chunk-000${index}`],
    evidenceDensity: { sustained: true, segmentCount: 12 - index },
    decisions: index === 0 ? [{ text: "候选决定" }] : [],
    actions: index === 1 ? [{ text: "候选行动" }] : [],
    risks: [],
    openQuestions: [],
  }));
  const plan = buildMeetingOrchestrationPlan({
    status: "complete",
    analysisMode: "model_reasoned_validated",
    topicMap: topics,
    evidenceMap: [{ status: "unresolved", evidenceQuality: "needs_review_only" }],
  }, paths);
  assert.equal(plan.mode, "dynamic_workflow");
  assert.equal(plan.executor.package, "@quintinshaw/pi-dynamic-workflows");
  assert.ok(plan.specialists.length >= 4);
  assert.ok(plan.specialists.length <= 6);
  assert.equal(plan.executor.concurrency <= 4, true);
  assert.match(plan.executor.script, /parallel\(/);
  assert.match(plan.executor.script, /completenessCheck\(/);
  assert.match(plan.executor.script, /verify\(/);
  assert.match(plan.executor.script, /schema:/);
});

test("workflow script references run artifacts instead of duplicating transcript payloads", () => {
  const script = buildMeetingDynamicWorkflowScript();
  assert.doesNotMatch(script, /audio-01:chunk/);
  assert.match(script, /args\.specialists/);
  assert.match(script, /meeting-evidence-synthesizer/);
});

test("pi-subagents 0.46 request uses workflowScript and safely encodes meeting text", () => {
  const request = buildPiSubagentRequest({
    agentType: "meeting-evidence-analyst",
    prompt: "核验引号 \"、反引号 `、换行\n和分隔符\u2028不会改变 workflowScript 结构。",
  });
  assert.equal(request.context, "fresh");
  assert.equal(request.async, false);
  assert.equal(request.mission, false);
  assert.equal("agent" in request, false);
  assert.doesNotThrow(() => new Function("runs", `return (async () => { ${request.workflowScript} })();`));
});
