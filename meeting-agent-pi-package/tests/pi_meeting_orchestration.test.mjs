import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPiMeetingOrchestrationInvocation,
  loadPiMeetingOrchestrationEnv,
  parsePiMeetingOrchestrationOutput,
  reconcilePiMeetingOrchestrationResult,
  shouldRunPiMeetingOrchestration,
} from "../tools/pi_meeting_orchestration_helpers.mjs";

test("meeting delegation tries review model before the distinct primary model", () => {
  const config = loadPiMeetingOrchestrationEnv("/path/that/does/not/exist", {
    PI_REVIEW_PROVIDER: "xiaomi-token-plan-sgp",
    PI_REVIEW_MODEL: "mimo-v2.5-pro",
    PI_PROVIDER: "deepseek",
    PI_MODEL: "deepseek-v4-pro",
  });
  assert.deepEqual(config.candidates.slice(0, 2), [
    { provider: "xiaomi-token-plan-sgp", model: "mimo-v2.5-pro", role: "review" },
    { provider: "deepseek", model: "deepseek-v4-pro", role: "primary" },
  ]);
});

test("meeting delegation runs only for selected subagent or workflow modes", () => {
  assert.deepEqual(shouldRunPiMeetingOrchestration({ mode: "direct" }), { run: false, reason: "parent_direct_mode" });
  assert.deepEqual(
    shouldRunPiMeetingOrchestration({ mode: "single_subagent", executor: { tool: "subagent" } }),
    { run: true, reason: "product_owner_enabled" },
  );
  assert.equal(shouldRunPiMeetingOrchestration({ mode: "dynamic_workflow", executor: { tool: "workflow" } }, { meetingAgenticDelegation: "off" }).run, false);
});

test("Pi invocation exposes only read and the two audited delegation tools", () => {
  const invocation = buildPiMeetingOrchestrationInvocation({
    workspaceDir: "/workspace",
    packageDir: "/workspace/package",
    planPath: "/workspace/run/plan.json",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    piCodingAgentDir: "/workspace/run/pi-home",
  });
  const toolsIndex = invocation.args.indexOf("--tools");
  assert.equal(invocation.args[toolsIndex + 1], "read,subagent,workflow");
  assert.equal(invocation.args.includes("--no-session"), true);
  assert.match(invocation.prompt, /产品所有者已明确启用/);
});

test("Pi JSON output parser requires the planned tool to have actually completed", () => {
  const completed = parsePiMeetingOrchestrationOutput([
    JSON.stringify({ type: "tool_execution_end", toolName: "subagent", result: { details: { status: "completed" } }, isError: false }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "已完成核验" }] } }),
  ].join("\n"), "subagent");
  assert.equal(completed.status, "completed");
  assert.equal(completed.assistantSummary, "已完成核验");

  const missing = parsePiMeetingOrchestrationOutput(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [] } }), "workflow");
  assert.equal(missing.status, "blocked");
  assert.equal(missing.reason, "delegation_tool_not_executed");
});

test("parent reconciliation quarantines cross-meeting segment ids", () => {
  const reconciled = reconcilePiMeetingOrchestrationResult({
    status: "completed",
    assistantSummary: "核验引用 audio-99:chunk-9999",
    result: {
      topicFindings: [{ finding: "当前结论", evidenceSegmentIds: ["audio-01:chunk-0001"] }],
    },
  }, ["audio-01:chunk-0001"]);
  assert.equal(reconciled.status, "needs_review");
  assert.deepEqual(reconciled.invalidSegmentIds, ["audio-99:chunk-9999"]);
  assert.equal(reconciled.result, null);
});

test("parent reconciliation accepts only evidence-scoped structured findings", () => {
  const result = { supportedClaims: [{ text: "有证据的判断", evidenceSegmentIds: ["audio-01:chunk-0001"] }] };
  const reconciled = reconcilePiMeetingOrchestrationResult({ status: "completed", assistantSummary: "", result }, ["audio-01:chunk-0001"]);
  assert.equal(reconciled.status, "accepted");
  assert.equal(reconciled.evidenceScopeSatisfied, true);
  assert.deepEqual(reconciled.result, result);
});
