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

/** @template T @param {T | null | undefined} value @returns {T} */
function required(value) {
  assert.ok(value);
  return value;
}

/** @param {number} index */
function segmentId(index) {
  return required(segments.at(index)).segmentId;
}

test("participant aliases are stable and explicit user mappings override aliases", () => {
  assert.equal(participantAlias(0), "参会人 A");
  assert.equal(participantAlias(26), "参会人 AA");
  const map = buildParticipantMap(segments, "参会人A=张三，参会人员：张三、李四、王五");
  assert.equal(required(map.participants.at(0)).displayName, "张三");
  assert.equal(required(map.participants.at(0)).nameStatus, "user_confirmed");
  assert.equal(required(map.participants.at(1)).displayName, "参会人 B");
  assert.match(String(map.question), /参会人 B/);
  assert.equal(map.blocking, false);
});

test("evidence-backed identity guesses remain candidates and never replace stable aliases", () => {
  const participantMap = buildParticipantMap(segments, "");
  const analysis = required(normalizeMeetingAnalysisResponse({
    content: JSON.stringify({
      meetingType: "产品会议",
      participantIdentityCandidates: [{
        speakerId: 1,
        alias: "参会人 B",
        candidateName: "李四",
        confidence: "medium",
        basis: "addressed_by_name",
        evidenceSegmentIds: [segmentId(1)],
      }],
      topics: [{
        title: "旅游 Agent MVP",
        evidenceSegmentIds: segments.slice(0, 3).map((segment) => segment.segmentId),
        coreJudgment: "先聚焦云南信息检索。",
        decisions: [], actions: [], risks: [], openQuestions: [],
      }],
      agentPlan: {},
    }),
    segments,
    participantMap,
  }));
  const candidate = required(analysis.participantResolution.participants.at(1));
  assert.equal(candidate.alias, "参会人 B");
  assert.equal(candidate.displayName, "参会人 B");
  assert.equal(candidate.nameStatus, "alias");
  assert.equal(candidate.candidateName, "李四");
  assert.equal(candidate.candidateConfidence, "medium");
  assert.deepEqual(candidate.candidateBasis, ["addressed_by_name"]);
  assert.deepEqual(candidate.candidateEvidenceSegmentIds, [segmentId(1)]);
  assert.equal(analysis.participantResolution.candidateCount, 1);
});

test("identity candidates with cross-meeting evidence are discarded", () => {
  const participantMap = buildParticipantMap(segments, "");
  const analysis = required(normalizeMeetingAnalysisResponse({
    content: JSON.stringify({
      meetingType: "产品会议",
      participantIdentityCandidates: [{
        speakerId: 1,
        alias: "参会人 B",
        candidateName: "李四",
        confidence: "high",
        basis: "addressed_by_name",
        evidenceSegmentIds: ["audio-99:chunk-9999"],
      }],
      topics: [{
        title: "旅游 Agent MVP",
        evidenceSegmentIds: segments.slice(0, 3).map((segment) => segment.segmentId),
        coreJudgment: "先聚焦云南信息检索。",
        decisions: [], actions: [], risks: [], openQuestions: [],
      }],
      agentPlan: {},
    }),
    segments,
    participantMap,
  }));
  assert.equal(required(analysis.participantResolution.participants.at(1)).candidateName, undefined);
  assert.equal(analysis.participantResolution.candidateCount, 0);
});

test("voiceprint identity candidates require upstream enrolled-match metadata", () => {
  const participantMap = buildParticipantMap(segments, "");
  const response = {
    meetingType: "产品会议",
    participantIdentityCandidates: [{
      speakerId: 1,
      alias: "参会人 B",
      candidateName: "李四",
      confidence: "high",
      basis: "enrolled_voiceprint",
      evidenceSegmentIds: [],
    }],
    topics: [{
      title: "旅游 Agent MVP",
      evidenceSegmentIds: segments.slice(0, 3).map((segment) => segment.segmentId),
      coreJudgment: "先聚焦云南信息检索。",
      decisions: [], actions: [], risks: [], openQuestions: [],
    }],
    agentPlan: {},
  };
  const withoutRegistry = required(normalizeMeetingAnalysisResponse({ content: JSON.stringify(response), segments, participantMap }));
  assert.equal(withoutRegistry.participantResolution.candidateCount, 0);
  const withRegistry = required(normalizeMeetingAnalysisResponse({
    content: JSON.stringify(response),
    segments,
    participantMap,
    asrSummary: { speakerDiarization: { identityMatches: [{ speakerId: 1, displayName: "李四", status: "matched" }] } },
  }));
  assert.equal(required(withRegistry.participantResolution.participants.at(1)).candidateName, "李四");
  assert.deepEqual(required(withRegistry.participantResolution.participants.at(1)).candidateBasis, ["enrolled_voiceprint"]);
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
      decisions: [{ text: "先做云南地区信息检索。", state: "agreed", evidenceSegmentIds: [segmentId(1), segmentId(2)] }],
      actions: [{ text: "明天提交接口清单。", ownerSpeakerId: 2, dueDate: "明天", evidenceSegmentIds: [segmentId(3)] }],
      risks: [{ text: "数据接口待确认。", evidenceSegmentIds: [segmentId(2)] }],
      openQuestions: [{ text: "接口来源是什么？", evidenceSegmentIds: [segmentId(2)] }],
    }],
    productDiscovery: {
      userProblems: [{ text: "用户需要更快获得区域旅游信息。", state: "inferred", evidenceSegmentIds: [segmentId(0), segmentId(1)] }],
      targetUsers: [{ text: "旅游规划用户", state: "inferred", evidenceSegmentIds: [segmentId(0)] }],
      workflows: [{ text: "用户提出目的地后检索云南信息。", state: "inferred", evidenceSegmentIds: [segmentId(1)] }],
      desiredOutcomes: [{ text: "获得可用的目的地信息。", state: "inferred", evidenceSegmentIds: [segmentId(1)] }],
      constraints: [{ text: "数据接口尚未确定。", state: "confirmed", evidenceSegmentIds: [segmentId(2)] }],
      acceptanceSignals: [{ text: "云南地区信息可以稳定检索。", state: "inferred", evidenceSegmentIds: [segmentId(1)] }],
      assumptions: [{ text: "单一区域足以验证价值。", state: "inferred", evidenceSegmentIds: [segmentId(0)] }],
      clarificationQuestions: [{ question: "首期数据接口来自哪里？", why: "接口来源会影响架构和数据质量。", priority: "high", blocks: ["architecture", "implementation"], evidenceSegmentIds: [segmentId(2)] }],
    },
    agentPlan: {
      meetingComplexity: "simple",
      narrativeMode: "decision_driven",
      dynamicTopicHeadings: ["旅游 Agent MVP"],
      reviewStrategy: "independent_model",
      suggestedFollowUpDocuments: ["prd", "unknown"],
    },
  });
  const analysis = required(normalizeMeetingAnalysisResponse({ content, segments, participantMap, asrSummary: { speakerDiarization: { speakerLabelsAvailable: true } } }));
  assert.equal(analysis.status, "complete");
  const firstTopic = required(analysis.topicMap.at(0));
  const firstAction = required(firstTopic.actions.at(0));
  assert.equal(firstAction.ownerSpeakerId, null);
  assert.equal(firstAction.dueDate, null);
  assert.deepEqual(analysis.agentPlan.suggestedFollowUpDocuments, ["prd"]);
  assert.equal(required(analysis.productDiscovery.userProblems.at(0)).state, "inferred");
  assert.equal(required(analysis.productDiscovery.clarificationQuestions.at(0)).question, "首期数据接口来自哪里？");
  assert.equal(analysis.productDiscovery.prdReadiness.status, "needs_clarification");
  assert.equal(analysis.agentPlan.prdReadiness.status, "needs_clarification");
  const actionClaim = analysis.evidenceMap.find((claim) => claim.claimType === "action");
  assert.ok(actionClaim);
  assert.equal(actionClaim.evidenceQuality, "needs_review_only");
});

test("meeting QA derives real topic and uncertain-claim findings from analysis", () => {
  const participantMap = buildParticipantMap(segments, "");
  const analysis = required(normalizeMeetingAnalysisResponse({
    content: JSON.stringify({
      meetingType: "产品会议",
      topics: [{
        title: "旅游 Agent MVP",
        evidenceSegmentIds: segments.map((segment) => segment.segmentId),
        coreJudgment: "先聚焦云南信息检索。",
        decisions: [],
        actions: [{ text: "明天提交接口清单。", ownerSpeakerId: 2, dueDate: "明天", evidenceSegmentIds: [segmentId(3)] }],
        risks: [],
        openQuestions: [],
      }],
      agentPlan: {},
    }),
    segments,
    participantMap,
  }));
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
  assert.equal(required(findings.crossMeetingTerms.at(0)).segmentId, "audio-99:chunk-9999");
  assert.equal(required(findings.uncertainEvidenceClaims.at(0)).claimType, "delegated_review");
});
