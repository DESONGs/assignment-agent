import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMeetingQaFindings,
  buildMeetingTimeline,
  buildParticipantMap,
  normalizeMeetingAnalysisResponse,
  normalizeMeetingSegments,
  participantAlias,
} from "../tools/meeting_intelligence_helpers.mjs";

const segments = normalizeMeetingSegments([
  { sourceIndex: 0, chunkIndex: 0, startSec: 0, endSec: 4, speakerId: 0, text: "我们先确定旅游 Agent 的最小范围。" },
  { sourceIndex: 0, chunkIndex: 1, startSec: 4, endSec: 8, speakerId: 1, text: "我建议先做云南地区的信息检索。" },
  { sourceIndex: 0, chunkIndex: 2, startSec: 8, endSec: 12, speakerId: 0, text: "这个方向可以，数据接口仍待确认。" },
  { sourceIndex: 0, chunkIndex: 3, startSec: 12, endSec: 16, speakerId: 2, text: "负责人明天提交接口清单。", singleMixEvidence: { status: "needs_review", reviewIds: ["review-1"] } },
]);

test("participant aliases are stable and explicit user mappings override aliases", () => {
  assert.equal(participantAlias(0), "参会人 A");
  assert.equal(participantAlias(26), "参会人 AA");
  const map = buildParticipantMap(segments, "参会人A=张三，参会人员：张三、李四、王五");
  assert.equal(map.participants[0].displayName, "张三");
  assert.equal(map.participants[0].nameStatus, "user_confirmed");
  assert.equal(map.participants[1].displayName, "参会人 B");
  assert.match(map.question, /参会人 B/);
  assert.equal(map.blocking, false);
});

test("meeting timeline keeps speaker aliases, evidence ids, and ASR review quality", () => {
  const map = buildParticipantMap(segments, "");
  const timeline = buildMeetingTimeline(segments, map);
  assert.match(timeline.text, /audio-01:chunk-0003/);
  assert.match(timeline.text, /参会人 C/);
  assert.match(timeline.text, /quality=needs_review/);
});

test("model meeting analysis is evidence-validated and unsafe owner attribution is removed", () => {
  const participantMap = buildParticipantMap(segments, "");
  const content = JSON.stringify({
    meetingType: "产品方向会议",
    allowedTopics: ["旅游 Agent MVP"],
    allowedTerms: ["旅游 Agent", "云南", "数据接口"],
    topics: [{
      title: "旅游 Agent MVP",
      timeRange: { startSec: 0, endSec: 16 },
      evidenceSegmentIds: segments.map((segment) => segment.segmentId),
      coreJudgment: "先聚焦单一区域的信息检索能力。",
      decisions: [{ text: "先做云南地区信息检索。", state: "agreed", evidenceSegmentIds: [segments[1].segmentId, segments[2].segmentId] }],
      actions: [{ text: "明天提交接口清单。", ownerSpeakerId: 2, dueDate: "明天", evidenceSegmentIds: [segments[3].segmentId] }],
      risks: [{ text: "数据接口待确认。", evidenceSegmentIds: [segments[2].segmentId] }],
      openQuestions: [{ text: "接口来源是什么？", evidenceSegmentIds: [segments[2].segmentId] }],
    }],
    agentPlan: {
      meetingComplexity: "simple",
      narrativeMode: "decision_driven",
      dynamicTopicHeadings: ["旅游 Agent MVP"],
      reviewStrategy: "independent_model",
      suggestedFollowUpDocuments: ["prd", "unknown"],
    },
  });
  const analysis = normalizeMeetingAnalysisResponse({ content, segments, participantMap, asrSummary: { speakerDiarization: { speakerLabelsAvailable: true } } });
  assert.equal(analysis.status, "complete");
  assert.equal(analysis.topicMap[0].actions[0].ownerSpeakerId, null);
  assert.equal(analysis.topicMap[0].actions[0].dueDate, null);
  assert.deepEqual(analysis.agentPlan.suggestedFollowUpDocuments, ["prd"]);
  const actionClaim = analysis.evidenceMap.find((claim) => claim.claimType === "action");
  assert.equal(actionClaim.evidenceQuality, "needs_review_only");
});

test("meeting QA derives real topic and uncertain-claim findings from analysis", () => {
  const participantMap = buildParticipantMap(segments, "");
  const analysis = normalizeMeetingAnalysisResponse({
    content: JSON.stringify({
      meetingType: "产品会议",
      topics: [{
        title: "旅游 Agent MVP",
        evidenceSegmentIds: segments.map((segment) => segment.segmentId),
        coreJudgment: "先聚焦云南信息检索。",
        decisions: [],
        actions: [{ text: "明天提交接口清单。", ownerSpeakerId: 2, dueDate: "明天", evidenceSegmentIds: [segments[3].segmentId] }],
        risks: [],
        openQuestions: [],
      }],
      agentPlan: {},
    }),
    segments,
    participantMap,
  });
  const findings = buildMeetingQaFindings(analysis, [{ markdown: "# 会议纪要\n\n## 行动项\n\n明天提交接口清单。" }]);
  assert.equal(findings.omittedMacroTopics.length, 1);
  assert.equal(findings.uncertainEvidenceClaims.length, 1);
});

test("meeting QA blocks cross-meeting ids introduced by delegated review", () => {
  const findings = buildMeetingQaFindings({
    topicMap: [],
    evidenceMap: [],
    participantResolution: { participants: [] },
    delegatedReview: {
      invalidSegmentIds: ["audio-99:chunk-9999"],
      missingEvidencePaths: ["$.result.actionFindings[0]"],
    },
  }, []);
  assert.equal(findings.crossMeetingTerms[0].segmentId, "audio-99:chunk-9999");
  assert.equal(findings.uncertainEvidenceClaims[0].claimType, "delegated_review");
});
