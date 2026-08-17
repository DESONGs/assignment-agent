import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildMeetingMemoryCuratorPlan,
  buildPiMeetingMemoryInvocation,
  extractMeetingMemoryPayload,
  meetingMemoryPayloadShapeValid,
  persistMeetingMemory,
  reconcileMeetingMemoryCandidates,
} from "../tools/meeting_memory_helpers.mjs";

const analysis = {
  evidenceMap: [
    { claimId: "claim-decision", claimType: "decision", text: "旅游 Agent 首版聚焦云南信息检索。", status: "supported", evidenceQuality: "ready", evidenceSegmentIds: ["audio-01:chunk-0001"] },
    { claimId: "claim-open", claimType: "open_question", text: "商业模式仍需后续确认。", status: "open", evidenceQuality: "ready", evidenceSegmentIds: ["audio-01:chunk-0002"] },
    { claimId: "claim-action", claimType: "action", text: "负责人明天交付。", status: "unresolved", evidenceQuality: "needs_review_only", evidenceSegmentIds: ["audio-01:chunk-0003"] },
  ],
  participantResolution: {
    participants: [
      { alias: "参会人 A", displayName: "张三", nameStatus: "user_confirmed" },
      { alias: "参会人 B", displayName: "参会人 B", nameStatus: "alias_only" },
    ],
  },
};

test("memory curator is one fresh persistent-role subagent, not a workflow", () => {
  const plan = buildMeetingMemoryCuratorPlan({
    runId: "run-1",
    meetingAnalysisPath: "run/meeting-analysis.json",
    meetingMinutesPath: "run/minutes.md",
    qaGatePath: "run/qa-gate.json",
    transcriptPath: "run/transcript.json",
    participantMapPath: "run/participant-map.json",
  });
  assert.equal(plan.mode, "single_subagent");
  assert.equal(plan.executor.tool, "subagent");
  assert.equal(plan.executor.request.context, "fresh");
  assert.equal(plan.executor.request.mission, false);
  assert.match(plan.executor.request.workflowScript, /meeting-memory-curator/);
  assert.match(plan.executor.request.workflowScript, /acceptance: \{ level: "none"/);
  assert.doesNotMatch(plan.executor.request.workflowScript, /workflow\s*\(/);
  assert.equal("outputSchema" in plan.executor.request, false);
  assert.equal(plan.executor.structuredOutputMode, "parent_validated_json");
  assert.equal(plan.executor.outputContract.required.includes("candidates"), true);

  const invocation = buildPiMeetingMemoryInvocation({ workspaceDir: "/workspace", packageDir: "/workspace/package", planPath: "/workspace/run/plan.json", provider: "deepseek", model: "deepseek-v4-pro", piCodingAgentDir: "/workspace/pi-home" });
  const toolsIndex = invocation.args.indexOf("--tools");
  assert.equal(invocation.args[toolsIndex + 1], "read,subagent");
});

test("extractor finds the structured child result inside Pi tool details", () => {
  const payload = { schemaVersion: "meeting-memory-candidates-v1", summary: "ok", candidates: [], excluded: [] };
  assert.deepEqual(extractMeetingMemoryPayload({ details: { results: [{ structuredOutput: payload }] } }), payload);
  assert.deepEqual(extractMeetingMemoryPayload({ details: { results: [{ finalOutput: `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`` }] } }), payload);
  assert.equal(meetingMemoryPayloadShapeValid({ ...payload, unexpected: true }), false);
  assert.equal(extractMeetingMemoryPayload({ finalOutput: JSON.stringify({ ...payload, candidates: [{ type: "decision" }] }) }), null);
});

test("parent accepts supported memories and rejects low confidence or cross-meeting evidence", () => {
  const reconciled = reconcileMeetingMemoryCandidates({
    schemaVersion: "meeting-memory-candidates-v1",
    summary: "提炼完成",
    candidates: [
      { type: "decision", memoryKey: "decision:travel-agent-scope", content: "旅游 Agent 首版聚焦云南信息检索。", rationale: "已明确同意", confidence: "high", sourceClaimIds: ["claim-decision"], evidenceSegmentIds: ["audio-01:chunk-0001"] },
      { type: "participant_identity", memoryKey: "participant:a", content: "参会人 A = 张三", rationale: "用户显式提供", confidence: "high", sourceClaimIds: [], evidenceSegmentIds: [] },
      { type: "project_fact", memoryKey: "fact:unsafe", content: "跨会议事实", rationale: "无", confidence: "high", sourceClaimIds: ["claim-decision"], evidenceSegmentIds: ["audio-99:chunk-9999"] },
      { type: "project_fact", memoryKey: "fact:uncertain", content: "负责人明天交付", rationale: "低置信", confidence: "medium", sourceClaimIds: ["claim-action"], evidenceSegmentIds: ["audio-01:chunk-0003"] },
      { type: "open_question", memoryKey: "question:business-model", content: "商业模式仍需后续确认。", rationale: "会议未解决", confidence: "high", sourceClaimIds: ["claim-open"], evidenceSegmentIds: ["audio-01:chunk-0002"] },
      { type: "decision", memoryKey: "decision:wrong-claim", content: "错误归属", rationale: "claim 不拥有证据", confidence: "high", sourceClaimIds: ["claim-decision"], evidenceSegmentIds: ["audio-01:chunk-0002"] },
      { type: "decision", memoryKey: "decision:hallucinated", content: "首版将自动购买国际机票。", rationale: "无事实支持", confidence: "high", sourceClaimIds: ["claim-decision"], evidenceSegmentIds: ["audio-01:chunk-0001"] },
    ],
    excluded: [],
  }, { meetingAnalysis: analysis, knownSegmentIds: ["audio-01:chunk-0001", "audio-01:chunk-0002", "audio-01:chunk-0003"], runId: "run-1" });
  assert.equal(reconciled.accepted.length, 3);
  assert.equal(reconciled.rejected.length, 4);
  assert.ok(reconciled.rejected.some((item) => Array.isArray(item.reasons) && item.reasons.includes("segment_outside_current_meeting")));
  assert.ok(reconciled.rejected.some((item) => Array.isArray(item.reasons) && item.reasons.includes("memory_confidence_not_high")));
  assert.ok(reconciled.rejected.some((item) => Array.isArray(item.reasons) && item.reasons.includes("evidence_not_owned_by_source_claim")));
  assert.ok(reconciled.rejected.some((item) => Array.isArray(item.reasons) && item.reasons.includes("memory_content_not_grounded_in_source_claim")));
});

test("parent store deduplicates exact memories and blocks conflicting keys", () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "meeting-memory-"));
  const base = {
    accepted: [{
      type: "decision",
      memoryKey: "decision:travel-agent-scope",
      content: "旅游 Agent 首版聚焦云南信息检索。",
      rationale: "已明确同意",
      confidence: "high",
      sourceClaimIds: ["claim-decision"],
      evidenceSegmentIds: ["audio-01:chunk-0001"],
      sourceRunId: "run-1",
      fingerprint: "fingerprint-1",
    }],
  };
  const first = persistMeetingMemory(base, { workspaceDir, now: "2026-08-12T00:00:00.000Z" });
  assert.equal(first.persisted.length, 1);
  assert.match(readFileSync(first.memoryPath, "utf8"), /旅游 Agent 首版聚焦云南信息检索/);

  const duplicate = persistMeetingMemory(base, { workspaceDir, now: "2026-08-12T01:00:00.000Z" });
  assert.equal(duplicate.duplicates.length, 1);
  const conflict = persistMeetingMemory({ accepted: [{ ...base.accepted[0], content: "旅游 Agent 首版改做全国。", fingerprint: "fingerprint-2", sourceRunId: "run-2" }] }, { workspaceDir });
  assert.equal(conflict.status, "needs_review");
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(existsSync(conflict.conflictLedgerPath), true);
  assert.equal(existsSync(join(workspaceDir, ".pi/agent-memory/meeting-memory/.write.lock")), false);
  assert.match(readFileSync(conflict.conflictLedgerPath, "utf8"), /memory_key_conflict_requires_review/);
  assert.doesNotMatch(readFileSync(first.memoryPath, "utf8"), /改做全国/);
});
