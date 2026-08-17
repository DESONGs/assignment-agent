const DEFAULT_TIMELINE_MAX_CHARS = 140_000;
const DEFAULT_TOPIC_WINDOW_SECONDS = 12 * 60;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function uniqueStrings(values, limit = 200) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean))].slice(0, limit);
}

function normalizeSpeakerId(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : String(value).trim();
}

function speakerSort(left, right) {
  const a = Number(left);
  const b = Number(right);
  if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
  return String(left).localeCompare(String(right));
}

export function participantAlias(index) {
  let value = Math.max(0, Number(index) || 0);
  let letters = "";
  do {
    letters = String.fromCharCode(65 + (value % 26)) + letters;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return `参会人 ${letters}`;
}

function aliasCode(alias) {
  return String(alias ?? "").replace(/^参会人\s*/u, "").trim().toUpperCase();
}

function safeDisplayName(value) {
  return String(value ?? "")
    .replace(/[，,；;。\n].*$/u, "")
    .replace(/^(?:姓名|名字)\s*[：:=]?\s*/u, "")
    .trim()
    .slice(0, 40);
}

function normalizeCandidateConfidence(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["high", "medium", "low"].includes(normalized)) return normalized;
  return "low";
}

function normalizeCandidateName(value, alias, confirmedName = "") {
  const name = safeDisplayName(value);
  if (!name || name === alias || name === confirmedName || /^(待确认|未知|不清楚)$/u.test(name)) return null;
  return name;
}

function enrolledVoiceprintMatches(voiceprintMatches, speakerId, candidateName) {
  return (Array.isArray(voiceprintMatches) ? voiceprintMatches : []).some((match) =>
    String(normalizeSpeakerId(match?.speakerId)) === String(speakerId)
      && safeDisplayName(match?.displayName ?? match?.name) === candidateName
      && ["confirmed", "matched"].includes(String(match?.status ?? "").toLowerCase()),
  );
}

function identityCandidateForSpeaker(parsedCandidates, speakerId, alias, confirmedName = "", validIds = new Set(), voiceprintMatches = []) {
  const candidates = Array.isArray(parsedCandidates) ? parsedCandidates : [];
  const matched = candidates.find((candidate) => {
    const candidateSpeakerId = normalizeSpeakerId(candidate?.speakerId);
    const candidateAlias = String(candidate?.alias ?? "").trim();
    return (candidateSpeakerId !== null && String(candidateSpeakerId) === String(speakerId)) || candidateAlias === alias;
  });
  const candidateName = normalizeCandidateName(matched?.candidateName ?? matched?.name, alias, confirmedName);
  if (!candidateName) return null;
  const candidateEvidenceSegmentIds = uniqueStrings(matched?.evidenceSegmentIds, 12).filter((segmentId) => validIds.has(segmentId));
  let candidateBasis = uniqueStrings([matched?.basis].flat().filter((basis) => [
    "self_introduction",
    "addressed_by_name",
    "context_relation",
    "enrolled_voiceprint",
  ].includes(String(basis))), 8);
  const voiceprintConfirmed = candidateBasis.includes("enrolled_voiceprint")
    && enrolledVoiceprintMatches(voiceprintMatches, speakerId, candidateName);
  candidateBasis = candidateBasis.filter((basis) => basis !== "enrolled_voiceprint" || voiceprintConfirmed);
  if (candidateBasis.length === 0) return null;
  if (!voiceprintConfirmed && candidateEvidenceSegmentIds.length === 0) return null;
  return {
    candidateName,
    candidateConfidence: normalizeCandidateConfidence(matched?.confidence),
    candidateBasis,
    candidateEvidenceSegmentIds,
  };
}

export function parseParticipantInput(text, speakerIds = []) {
  const prompt = String(text ?? "");
  const sortedSpeakerIds = [...speakerIds].sort(speakerSort);
  const directMappings = new Map();
  const pattern = /(?:参会人|说话人|speaker)\s*([A-Za-z]+|_?\d+)\s*(?:是|=|：|:)\s*([^，,；;。\n]{1,40})/giu;
  for (const match of prompt.matchAll(pattern)) {
    const reference = String(match[1] ?? "").trim();
    const displayName = safeDisplayName(match[2]);
    if (!displayName || /^(待确认|未知|不清楚)$/u.test(displayName)) continue;
    if (/^[A-Za-z]+$/u.test(reference)) {
      directMappings.set(reference.toUpperCase(), displayName);
      continue;
    }
    const numeric = Number(reference.replace(/^_/, ""));
    const index = reference.startsWith("_") || numeric === 0 ? numeric : numeric - 1;
    if (sortedSpeakerIds[index] !== undefined) directMappings.set(String(sortedSpeakerIds[index]), displayName);
  }

  const rosterMatch = prompt.match(/(?:参会人(?:员)?|参与人(?:员)?|与会人(?:员)?)\s*[：:]\s*([^。\n]{1,160})/u);
  const declaredRoster = rosterMatch
    ? uniqueStrings(rosterMatch[1].split(/[、，,；;]/u).map(safeDisplayName).filter(Boolean), 30)
    : [];
  return { directMappings, declaredRoster };
}

function segmentIdFor(segment, index) {
  if (segment.segmentId) return String(segment.segmentId);
  const sourceIndex = Number.isInteger(segment.sourceIndex) ? segment.sourceIndex : 0;
  const chunkIndex = Number.isInteger(segment.chunkIndex) ? segment.chunkIndex : index;
  return `audio-${String(sourceIndex + 1).padStart(2, "0")}:chunk-${String(chunkIndex).padStart(4, "0")}`;
}

export function normalizeMeetingSegments(segments = []) {
  return (Array.isArray(segments) ? segments : [])
    .map((segment, index) => ({
      segmentId: segmentIdFor(segment, index),
      sourceIndex: Number.isInteger(segment.sourceIndex) ? segment.sourceIndex : 0,
      chunkIndex: Number.isInteger(segment.chunkIndex) ? segment.chunkIndex : index,
      startSec: finiteNumber(segment.startSec),
      endSec: Math.max(finiteNumber(segment.startSec), finiteNumber(segment.endSec, finiteNumber(segment.startSec))),
      speakerId: normalizeSpeakerId(segment.speakerId ?? segment.speaker_id),
      text: String(segment.text ?? "").trim(),
      language: String(segment.language ?? "").trim(),
      quality: segment.singleMixEvidence?.status === "needs_review" ? "needs_review" : String(segment.quality ?? "ready"),
      reviewIds: uniqueStrings(segment.singleMixEvidence?.reviewIds ?? [], 30),
    }))
    .filter((segment) => segment.text)
    .sort((left, right) => left.startSec - right.startSec || left.chunkIndex - right.chunkIndex);
}

export function buildParticipantMap(segments, userPrompt = "") {
  const speakerIds = [...new Set(segments.map((segment) => segment.speakerId).filter((value) => value !== null))].sort(speakerSort);
  const input = parseParticipantInput(userPrompt, speakerIds);
  const participants = speakerIds.map((speakerId, index) => {
    const alias = participantAlias(index);
    const displayName = input.directMappings.get(String(speakerId)) ?? input.directMappings.get(aliasCode(alias)) ?? alias;
    return {
      speakerId,
      alias,
      displayName,
      nameStatus: displayName === alias ? "alias" : "user_confirmed",
      identityEvidence: displayName === alias ? [] : ["user_prompt_mapping"],
    };
  });
  if (participants.length === 0 && segments.length > 0) {
    participants.push({
      speakerId: null,
      alias: participantAlias(0),
      displayName: participantAlias(0),
      nameStatus: "alias_without_diarization",
      identityEvidence: [],
    });
  }
  const unresolved = participants.filter((participant) => participant.nameStatus.startsWith("alias"));
  const references = unresolved.map((participant) => participant.alias).join("、");
  return {
    schemaVersion: "meeting-participant-map-v1",
    participants,
    declaredRoster: input.declaredRoster,
    participantCount: participants.length,
    unresolvedCount: unresolved.length,
    question: unresolved.length > 0
      ? `当前先使用${references}作为稳定代号。如需实名，请回复映射，例如：${unresolved.slice(0, 3).map((participant, index) => `${participant.alias}=${input.declaredRoster[index] ?? "姓名"}`).join("，")}；也可以继续保留代号。`
      : null,
    blocking: false,
  };
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(finiteNumber(seconds)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

function participantForSpeaker(participantMap, speakerId) {
  return participantMap.participants.find((participant) => String(participant.speakerId) === String(speakerId))
    ?? participantMap.participants.find((participant) => participant.speakerId === null)
    ?? null;
}

export function buildMeetingTimeline(segments, participantMap, maxChars = DEFAULT_TIMELINE_MAX_CHARS) {
  const lines = segments.map((segment) => {
    const participant = participantForSpeaker(participantMap, segment.speakerId);
    return `[${segment.segmentId}] [${formatTime(segment.startSec)}-${formatTime(segment.endSec)}] [${participant?.alias ?? "参会人待确认"}] [quality=${segment.quality}] ${segment.text}`;
  });
  const totalChars = lines.reduce((total, line) => total + line.length + 1, 0);
  if (totalChars <= maxChars) return { text: lines.join("\n"), includedSegmentIds: segments.map((segment) => segment.segmentId), truncated: false };

  const mustInclude = new Set();
  for (const [index, segment] of segments.entries()) {
    if (segment.quality === "needs_review" || index === 0 || index === segments.length - 1) mustInclude.add(index);
    if (index > 0 && segment.speakerId !== segments[index - 1].speakerId) {
      mustInclude.add(index - 1);
      mustInclude.add(index);
    }
  }
  const stride = Math.max(2, Math.ceil(totalChars / maxChars));
  for (let index = 0; index < segments.length; index += stride) mustInclude.add(index);
  const selectedIndexes = [...mustInclude].sort((left, right) => left - right);
  const selectedLines = [];
  const includedSegmentIds = [];
  let used = 0;
  for (const index of selectedIndexes) {
    const line = lines[index];
    if (used + line.length + 1 > maxChars && selectedLines.length > 0) continue;
    selectedLines.push(line);
    includedSegmentIds.push(segments[index].segmentId);
    used += line.length + 1;
  }
  return { text: selectedLines.join("\n"), includedSegmentIds, truncated: true };
}

function frequentTerms(segments, limit = 24) {
  const stop = new Set(["这个", "那个", "然后", "就是", "我们", "你们", "他们", "一个", "可以", "还是", "不是", "没有", "什么", "怎么", "已经", "比较", "可能", "如果", "因为", "所以", "但是", "对的", "嗯嗯"]);
  const counts = new Map();
  const text = segments.map((segment) => segment.text).join(" ");
  const terms = text.match(/[A-Za-z][A-Za-z0-9_.-]{2,}|[\p{Script=Han}]{2,6}/gu) ?? [];
  for (const term of terms) {
    if (stop.has(term)) continue;
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || right[0].length - left[0].length).slice(0, limit).map(([term]) => term);
}

function fallbackTopics(segments, participantMap) {
  if (segments.length === 0) return [];
  const groups = [];
  let current = [];
  let windowStart = segments[0].startSec;
  for (const segment of segments) {
    if (current.length > 0 && segment.startSec - windowStart >= DEFAULT_TOPIC_WINDOW_SECONDS) {
      groups.push(current);
      current = [];
      windowStart = segment.startSec;
    }
    current.push(segment);
  }
  if (current.length > 0) groups.push(current);
  return groups.slice(0, 16).map((group, index) => {
    const terms = frequentTerms(group, 3);
    const speakerAliases = uniqueStrings(group.map((segment) => participantForSpeaker(participantMap, segment.speakerId)?.alias));
    return {
      topicId: `topic-${String(index + 1).padStart(2, "0")}`,
      title: terms.length > 0 ? terms.join(" / ") : `时间段议题 ${index + 1}`,
      timeRange: { startSec: group[0].startSec, endSec: group.at(-1).endSec },
      evidenceSegmentIds: group.map((segment) => segment.segmentId),
      evidenceDensity: { segmentCount: group.length, sustained: group.length >= 3 },
      speakerAliases,
      coreJudgment: "待模型或人工进一步归纳",
      decisions: [],
      actions: [],
      risks: [],
      openQuestions: ["该时间段的核心议题和结论待确认"],
    };
  });
}

export function buildFallbackMeetingAnalysis({ segments, participantMap, asrSummary = null, reason = "model_analysis_unavailable" }) {
  const topicMap = fallbackTopics(segments, participantMap);
  return {
    schemaVersion: "meeting-intelligence-v1",
    status: "needs_review",
    analysisMode: "deterministic_fallback",
    fallbackReason: reason,
    meetingProfile: {
      meetingType: "会议类型待确认",
      participantMap,
      allowedRoles: participantMap.participants.map((participant) => participant.displayName),
      allowedTopics: topicMap.map((topic) => topic.title),
      allowedTerms: frequentTerms(segments),
      ambiguousTerms: [],
      siblingForbiddenTerms: [],
      languages: uniqueStrings(segments.map((segment) => segment.language)),
      asrCapabilities: {
        speakerLabelsAvailable: Boolean(asrSummary?.speakerDiarization?.speakerLabelsAvailable),
        speakerCountDetected: participantMap.participantCount,
        singleMix: asrSummary?.singleMix ?? asrSummary?.speakerDiarization?.singleMix ?? null,
      },
    },
    topicMap,
    evidenceMap: [],
    productDiscovery: {
      schemaVersion: "meeting-product-discovery-v1",
      opportunitySignals: [],
      userProblems: [],
      targetUsers: [],
      workflows: [],
      desiredOutcomes: [],
      constraints: [],
      assumptions: [],
      acceptanceSignals: [],
      clarificationQuestions: topicMap.flatMap((topic) => topic.openQuestions.map((text) => ({
        text,
        question: text,
        state: "unresolved",
        priority: "medium",
        why: "确定性 fallback 无法可靠归纳产品发现，需要模型或用户复核。",
        blocks: ["prd"],
        evidenceSegmentIds: topic.evidenceSegmentIds.slice(0, 8),
      }))).slice(0, 12),
      prdReadiness: { status: "insufficient", score: 0, coveredDimensions: 0, totalDimensions: 6, highPriorityGapCount: 0, blockingQuestions: [] },
      nextStepOptions: ["review-customer-questions", "keep-meeting-minutes-only"],
    },
    agentPlan: {
      meetingComplexity: topicMap.length > 3 ? "complex" : "simple",
      narrativeMode: topicMap.length > 3 ? "topic_driven" : "decision_driven",
      dynamicTopicHeadings: topicMap.map((topic) => topic.title),
      reviewStrategy: "deterministic_and_human_review",
      suggestedFollowUpDocuments: [],
      focusAreas: ["确认核心议题", "确认决策与行动项"],
      prdReadiness: { status: "insufficient", score: 0 },
      nextStepOptions: ["review-customer-questions", "keep-meeting-minutes-only"],
    },
    participantResolution: participantMap,
  };
}

export function buildMeetingAnalysisPrompt({ segments, participantMap, asrSummary = null, userPrompt = "", maxChars = DEFAULT_TIMELINE_MAX_CHARS }) {
  const timeline = buildMeetingTimeline(segments, participantMap, maxChars);
  const contract = {
    meetingType: "string",
    languages: ["string"],
    allowedRoles: ["string"],
    allowedTopics: ["string"],
    allowedTerms: ["string"],
    ambiguousTerms: ["string"],
    participantIdentityCandidates: [{
      speakerId: 0,
      alias: "参会人 A",
      candidateName: "string",
      confidence: "high|medium|low",
      basis: "self_introduction|addressed_by_name|context_relation|enrolled_voiceprint",
      evidenceSegmentIds: ["audio-01:chunk-0000"],
    }],
    topics: [{
      title: "string",
      timeRange: { startSec: 0, endSec: 0 },
      evidenceSegmentIds: ["audio-01:chunk-0000"],
      coreJudgment: "string or 待确认",
      decisions: [{ text: "string", state: "proposed|agreed|rejected|unresolved", evidenceSegmentIds: [] }],
      actions: [{ text: "string", ownerSpeakerId: null, dueDate: null, evidenceSegmentIds: [] }],
      risks: [{ text: "string", evidenceSegmentIds: [] }],
      openQuestions: [{ text: "string", evidenceSegmentIds: [] }],
    }],
    productDiscovery: {
      opportunitySignals: [{ text: "潜在需求或价值机会", state: "confirmed|inferred|unresolved", evidenceSegmentIds: [] }],
      userProblems: [{ text: "用户问题/痛点", state: "confirmed|inferred|unresolved", evidenceSegmentIds: [] }],
      targetUsers: [{ text: "目标用户或角色", state: "confirmed|inferred|unresolved", evidenceSegmentIds: [] }],
      workflows: [{ text: "当前工作流、触发、输入与输出", state: "confirmed|inferred|unresolved", evidenceSegmentIds: [] }],
      desiredOutcomes: [{ text: "期望结果与价值时刻", state: "confirmed|inferred|unresolved", evidenceSegmentIds: [] }],
      constraints: [{ text: "范围、技术、数据、权限、预算或交付约束", state: "confirmed|inferred|unresolved", evidenceSegmentIds: [] }],
      assumptions: [{ text: "尚未验证的产品假设", state: "inferred|unresolved", evidenceSegmentIds: [] }],
      acceptanceSignals: [{ text: "可观察的成功/验收信号", state: "confirmed|inferred|unresolved", evidenceSegmentIds: [] }],
      clarificationQuestions: [{
        question: "下一次最值得向客户确认的问题",
        why: "为什么需要问",
        priority: "high|medium|low",
        blocks: ["prd|architecture|implementation|acceptance|delivery"],
        evidenceSegmentIds: [],
      }],
      nextStepOptions: ["review-customer-questions|generate-prd|draft-prd-with-open-questions|generate-customer-requirement-checklist|keep-meeting-minutes-only"],
    },
    agentPlan: {
      meetingComplexity: "simple|complex",
      narrativeMode: "decision_driven|topic_driven|chronological",
      dynamicTopicHeadings: ["string"],
      reviewStrategy: "deterministic|independent_model|human_confirmation",
      suggestedFollowUpDocuments: ["prd|tech-architecture|ops-plan|customer-requirement-checklist"],
      focusAreas: ["string"],
    },
  };
  return {
    timeline,
    prompt: [
      "# Meeting Intelligence Analysis",
      "",
      "你正在执行会议理解回合，而不是起草会议纪要。根据当前会议时间轴建立结构化事实图，输出且只输出一个 JSON 对象。",
      "参会人 alias 是稳定身份键。用户显式映射的姓名可直接使用；也允许根据自我介绍、他人称呼、上下文关系或已登记声纹匹配提出姓名候选，但必须写入 participantIdentityCandidates，包含依据、真实 segment id 与置信度。",
      "未知 speaker id/声纹聚类本身不能凭空推出姓名。未经确认的姓名候选不得成为 owner、承诺、权限或长期事实，且不能覆盖 participant map 的 displayName。",
      "必须区分提议、异议、讨论中判断、已达成共识、被否决方案和未决事项。",
      "如果会议涉及客户访谈、产品开发、AI 能力、现有流程、痛点、范围或验收，必须同时建立 productDiscovery。它不是自动写 PRD，而是区分已确认需求、合理推断、假设与客户待确认问题。",
      "clarificationQuestions 必须具体、可直接用于下一次客户沟通，并说明 why、priority、blocks 与证据。不要提已经由会议明确回答的问题。",
      "根据 productDiscovery 的完整度决定 suggestedFollowUpDocuments：需求仍模糊时优先 customer-requirement-checklist；用户问题、场景和验收已较清楚时可以建议 prd；不要机械建议所有文档。",
      "quality=needs_review 的片段可以形成风险或待确认问题，但不得单独形成 agreed decision、明确 owner、日期、金额或承诺。",
      "议题数量和结构由会议内容决定，不要套固定行业关键词。每个重要判断必须引用实际 segment id。",
      "若证据不足，字段使用待确认或 unresolved，不要补充外部事实。",
      "",
      "## User Request",
      userPrompt || "生成会议理解与会议纪要。",
      "",
      "## Participant Map",
      JSON.stringify(participantMap, null, 2),
      "",
      "## ASR Capability Summary",
      JSON.stringify({
        model: asrSummary?.model ?? null,
        speakerDiarization: asrSummary?.speakerDiarization ?? null,
        singleMix: asrSummary?.singleMix ?? null,
        failedChunks: asrSummary?.failedChunks ?? null,
      }, null, 2),
      "",
      "## Output JSON Contract",
      JSON.stringify(contract, null, 2),
      "",
      `## Transcript Timeline${timeline.truncated ? "（已做时间轴分层采样）" : ""}`,
      timeline.text,
    ].join("\n"),
  };
}

function extractJson(text) {
  const value = String(text ?? "").trim();
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced ?? value.slice(value.indexOf("{"), value.lastIndexOf("}") + 1);
  if (!candidate) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function normalizeEvidenceIds(values, validIds) {
  return uniqueStrings(values, 200).filter((value) => validIds.has(value));
}

function segmentsForRange(segments, range) {
  const startSec = finiteNumber(range?.startSec, Number.NaN);
  const endSec = finiteNumber(range?.endSec, Number.NaN);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return [];
  return segments.filter((segment) => segment.endSec >= startSec && segment.startSec <= endSec);
}

function normalizeClaimItems(values, validIds, segments, fallbackIds = []) {
  return (Array.isArray(values) ? values : [])
    .map((value) => typeof value === "string" ? { text: value } : value)
    .map((value) => ({
      text: String(value?.text ?? "").trim().slice(0, 600),
      state: value?.state ? String(value.state) : undefined,
      ownerSpeakerId: normalizeSpeakerId(value?.ownerSpeakerId),
      dueDate: value?.dueDate ? String(value.dueDate).slice(0, 80) : null,
      evidenceSegmentIds: normalizeEvidenceIds(value?.evidenceSegmentIds, validIds),
    }))
    .filter((value) => value.text)
    .map((value) => ({ ...value, evidenceSegmentIds: value.evidenceSegmentIds.length > 0 ? value.evidenceSegmentIds : fallbackIds.slice(0, 8) }));
}

function evidenceQuality(ids, byId) {
  const evidence = ids.map((id) => byId.get(id)).filter(Boolean);
  if (evidence.length === 0) return "missing";
  if (evidence.every((segment) => segment.quality === "needs_review")) return "needs_review_only";
  if (evidence.some((segment) => segment.quality === "needs_review")) return "mixed";
  return "ready";
}

function normalizeDiscoveryItems(values, validIds, options = {}) {
  const allowedStates = new Set(options.allowedStates ?? ["confirmed", "inferred", "unresolved"]);
  return (Array.isArray(values) ? values : [])
    .map((value) => typeof value === "string" ? { text: value } : value)
    .map((value) => {
      const text = String(value?.text ?? value?.title ?? value?.question ?? "").trim().slice(0, 800);
      if (!text) return null;
      const evidenceSegmentIds = normalizeEvidenceIds(value?.evidenceSegmentIds, validIds);
      let state = allowedStates.has(String(value?.state)) ? String(value.state) : evidenceSegmentIds.length > 0 ? "inferred" : "unresolved";
      if (state === "confirmed" && evidenceSegmentIds.length === 0) state = "unresolved";
      return {
        text,
        state,
        priority: ["high", "medium", "low"].includes(String(value?.priority)) ? String(value.priority) : "medium",
        why: String(value?.why ?? value?.reason ?? "").trim().slice(0, 500),
        blocks: uniqueStrings(value?.blocks, 12),
        evidenceSegmentIds,
      };
    })
    .filter(Boolean)
    .slice(0, options.limit ?? 30);
}

function normalizeProductDiscovery(parsed, validIds) {
  const source = parsed?.productDiscovery ?? {};
  const opportunitySignals = normalizeDiscoveryItems(source.opportunitySignals ?? source.potentialNeeds, validIds);
  const userProblems = normalizeDiscoveryItems(source.userProblems ?? source.painPoints, validIds);
  const targetUsers = normalizeDiscoveryItems(source.targetUsers, validIds);
  const workflows = normalizeDiscoveryItems(source.workflows ?? source.coreScenarios, validIds);
  const desiredOutcomes = normalizeDiscoveryItems(source.desiredOutcomes ?? source.successOutcomes, validIds);
  const constraints = normalizeDiscoveryItems(source.constraints, validIds);
  const assumptions = normalizeDiscoveryItems(source.assumptions, validIds, { allowedStates: ["inferred", "unresolved"] });
  const acceptanceSignals = normalizeDiscoveryItems(source.acceptanceSignals ?? source.acceptanceCriteria, validIds);
  const clarificationQuestions = normalizeDiscoveryItems(source.clarificationQuestions ?? source.questions, validIds).map((item) => ({
    ...item,
    question: item.text,
  }));
  const evidenceBackedSignals = [opportunitySignals, userProblems, targetUsers, workflows, desiredOutcomes, constraints, acceptanceSignals]
    .flat()
    .filter((item) => item.evidenceSegmentIds.length > 0).length;
  const highPriorityGaps = clarificationQuestions.filter((item) => item.priority === "high").length;
  const dimensions = [userProblems, targetUsers, workflows, desiredOutcomes, constraints, acceptanceSignals];
  const coveredDimensions = dimensions.filter((items) => items.some((item) => item.state === "confirmed" || item.evidenceSegmentIds.length > 0)).length;
  const readinessScore = Math.max(0, Math.min(100, Math.round((coveredDimensions / dimensions.length) * 85 - highPriorityGaps * 8 + Math.min(15, evidenceBackedSignals))));
  const prdReadiness = {
    status: readinessScore >= 75 && highPriorityGaps === 0 ? "ready" : readinessScore >= 45 ? "needs_clarification" : "insufficient",
    score: readinessScore,
    coveredDimensions,
    totalDimensions: dimensions.length,
    highPriorityGapCount: highPriorityGaps,
    blockingQuestions: clarificationQuestions.filter((item) => item.priority === "high").map((item) => item.question),
  };
  const explicitNextSteps = uniqueStrings(source.nextStepOptions, 8);
  const nextStepOptions = explicitNextSteps.length > 0
    ? explicitNextSteps
    : [
        clarificationQuestions.length > 0 ? "review-customer-questions" : null,
        prdReadiness.status === "ready" ? "generate-prd" : "draft-prd-with-open-questions",
        "generate-customer-requirement-checklist",
        "keep-meeting-minutes-only",
      ].filter(Boolean);
  return {
    schemaVersion: "meeting-product-discovery-v1",
    opportunitySignals,
    userProblems,
    targetUsers,
    workflows,
    desiredOutcomes,
    constraints,
    assumptions,
    acceptanceSignals,
    clarificationQuestions,
    prdReadiness,
    nextStepOptions,
  };
}

function buildEvidenceMap(topicMap, byId) {
  const claims = [];
  const append = (topic, claimType, text, ids, status = null) => {
    const evidenceIds = uniqueStrings(ids, 100);
    const quality = evidenceQuality(evidenceIds, byId);
    claims.push({
      claimId: `claim-${String(claims.length + 1).padStart(4, "0")}`,
      topicId: topic.topicId,
      claimType,
      text,
      status: status ?? (quality === "ready" || quality === "mixed" ? "supported" : "unresolved"),
      evidenceQuality: quality,
      evidenceSegmentIds: evidenceIds,
    });
  };
  for (const topic of topicMap) {
    if (topic.coreJudgment && topic.coreJudgment !== "待确认") append(topic, "core_judgment", topic.coreJudgment, topic.evidenceSegmentIds);
    for (const decision of topic.decisions) append(topic, "decision", decision.text, decision.evidenceSegmentIds, decision.state === "agreed" && evidenceQuality(decision.evidenceSegmentIds, byId) !== "needs_review_only" ? "supported" : "unresolved");
    for (const action of topic.actions) {
      const quality = evidenceQuality(action.evidenceSegmentIds, byId);
      append(topic, "action", action.text, action.evidenceSegmentIds, quality === "needs_review_only" ? "unresolved" : action.ownerSpeakerId === null && action.dueDate === null ? "open" : null);
    }
    for (const risk of topic.risks) append(topic, "risk", risk.text, risk.evidenceSegmentIds);
    for (const question of topic.openQuestions) append(topic, "open_question", question.text, question.evidenceSegmentIds, "open");
  }
  return claims;
}

export function normalizeMeetingAnalysisResponse({ content, segments, participantMap, asrSummary = null }) {
  const parsed = typeof content === "object" && content !== null ? content : extractJson(content);
  if (!parsed || typeof parsed !== "object") return null;
  const validIds = new Set(segments.map((segment) => segment.segmentId));
  const byId = new Map(segments.map((segment) => [segment.segmentId, segment]));
  const speakerAliases = new Map(participantMap.participants.map((participant) => [String(participant.speakerId), participant.alias]));
  const topicRows = Array.isArray(parsed.topics ?? parsed.topicMap) ? (parsed.topics ?? parsed.topicMap) : [];
  const topicMap = topicRows.map((topic, index) => {
    const ranged = segmentsForRange(segments, topic?.timeRange);
    const evidenceIds = normalizeEvidenceIds(topic?.evidenceSegmentIds, validIds);
    const resolvedIds = evidenceIds.length > 0 ? evidenceIds : ranged.map((segment) => segment.segmentId).slice(0, 120);
    if (resolvedIds.length === 0) return null;
    const evidenceSegments = resolvedIds.map((id) => byId.get(id)).filter(Boolean);
    const decisions = normalizeClaimItems(topic?.decisions, validIds, segments, resolvedIds);
    const actions = normalizeClaimItems(topic?.actions, validIds, segments, resolvedIds).map((action) => {
      const ownerAllowed = participantMap.participants.some((participant) => String(participant.speakerId) === String(action.ownerSpeakerId));
      const quality = evidenceQuality(action.evidenceSegmentIds, byId);
      return {
        ...action,
        ownerSpeakerId: ownerAllowed && quality !== "needs_review_only" ? action.ownerSpeakerId : null,
        ownerAlias: ownerAllowed && quality !== "needs_review_only" ? speakerAliases.get(String(action.ownerSpeakerId)) ?? null : null,
        dueDate: quality === "needs_review_only" ? null : action.dueDate,
      };
    });
    const risks = normalizeClaimItems(topic?.risks, validIds, segments, resolvedIds);
    const openQuestions = normalizeClaimItems(topic?.openQuestions, validIds, segments, resolvedIds);
    return {
      topicId: `topic-${String(index + 1).padStart(2, "0")}`,
      title: String(topic?.title ?? topic?.macroTopic ?? `议题 ${index + 1}`).trim().slice(0, 100),
      timeRange: {
        startSec: Math.min(...evidenceSegments.map((segment) => segment.startSec)),
        endSec: Math.max(...evidenceSegments.map((segment) => segment.endSec)),
      },
      evidenceSegmentIds: resolvedIds,
      evidenceDensity: { segmentCount: resolvedIds.length, sustained: resolvedIds.length >= 3 },
      speakerAliases: uniqueStrings(evidenceSegments.map((segment) => speakerAliases.get(String(segment.speakerId))).filter(Boolean)),
      coreJudgment: String(topic?.coreJudgment ?? "待确认").trim().slice(0, 800) || "待确认",
      decisions,
      actions,
      risks,
      openQuestions,
    };
  }).filter(Boolean).slice(0, 24);
  if (topicMap.length === 0) return null;
  const evidenceMap = buildEvidenceMap(topicMap, byId);
  const productDiscovery = normalizeProductDiscovery(parsed, validIds);
  const plan = parsed.agentPlan ?? {};
  const suggestedDocs = uniqueStrings(plan.suggestedFollowUpDocuments, 8).filter((doc) => ["prd", "tech-architecture", "ops-plan", "customer-requirement-checklist"].includes(doc));
  const allowedTopics = uniqueStrings(parsed.allowedTopics?.length ? parsed.allowedTopics : topicMap.map((topic) => topic.title), 80);
  const voiceprintMatches = asrSummary?.speakerDiarization?.identityMatches ?? asrSummary?.voiceprintIdentityMatches ?? [];
  const participants = participantMap.participants.map((participant) => {
    if (participant.nameStatus === "user_confirmed") return participant;
    const candidate = identityCandidateForSpeaker(
      parsed.participantIdentityCandidates,
      participant.speakerId,
      participant.alias,
      participant.displayName,
      validIds,
      voiceprintMatches,
    );
    return candidate ? { ...participant, ...candidate } : participant;
  });
  const participantResolution = {
    ...participantMap,
    participants,
    candidateCount: participants.filter((participant) => participant.candidateName).length,
  };
  return {
    schemaVersion: "meeting-intelligence-v1",
    status: "complete",
    analysisMode: "model_reasoned_validated",
    meetingProfile: {
      meetingType: String(parsed.meetingType ?? "会议类型待确认").trim().slice(0, 120),
      participantMap: participantResolution,
      allowedRoles: uniqueStrings([...(parsed.allowedRoles ?? []), ...participants.map((participant) => participant.displayName)], 80),
      allowedTopics,
      allowedTerms: uniqueStrings(parsed.allowedTerms, 160),
      ambiguousTerms: uniqueStrings(parsed.ambiguousTerms, 100),
      siblingForbiddenTerms: [],
      languages: uniqueStrings(parsed.languages, 30),
      asrCapabilities: {
        speakerLabelsAvailable: Boolean(asrSummary?.speakerDiarization?.speakerLabelsAvailable),
        speakerCountDetected: participantMap.participantCount,
        singleMix: asrSummary?.singleMix ?? asrSummary?.speakerDiarization?.singleMix ?? null,
      },
    },
    topicMap,
    evidenceMap,
    productDiscovery,
    agentPlan: {
      meetingComplexity: plan.meetingComplexity === "simple" ? "simple" : "complex",
      narrativeMode: ["decision_driven", "topic_driven", "chronological"].includes(plan.narrativeMode) ? plan.narrativeMode : "topic_driven",
      dynamicTopicHeadings: uniqueStrings(plan.dynamicTopicHeadings?.length ? plan.dynamicTopicHeadings : topicMap.map((topic) => topic.title), 30),
      reviewStrategy: ["deterministic", "independent_model", "human_confirmation"].includes(plan.reviewStrategy) ? plan.reviewStrategy : "independent_model",
      suggestedFollowUpDocuments: suggestedDocs,
      focusAreas: uniqueStrings(plan.focusAreas, 30),
      prdReadiness: productDiscovery.prdReadiness,
      nextStepOptions: productDiscovery.nextStepOptions,
    },
    participantResolution,
  };
}

function topicTextCovered(markdown, topic) {
  const text = String(markdown ?? "").toLowerCase();
  const terms = frequentTerms([{ text: `${topic.title} ${topic.coreJudgment}` }], 8).filter((term) => term.length >= 2);
  if (text.includes(String(topic.title).toLowerCase())) return true;
  if (terms.length === 0) return false;
  return terms.filter((term) => text.includes(term.toLowerCase())).length >= Math.min(2, terms.length);
}

function claimAppears(markdown, claim) {
  const text = String(markdown ?? "").toLowerCase();
  const terms = frequentTerms([{ text: claim.text }], 6).filter((term) => term.length >= 2);
  return terms.length > 0 && terms.filter((term) => text.includes(term.toLowerCase())).length >= Math.min(2, terms.length);
}

export function buildMeetingQaFindings(meetingAnalysis, documents = []) {
  const markdown = (Array.isArray(documents) ? documents : []).map((document) => String(document?.markdown ?? document?.content ?? "")).join("\n\n");
  const topics = meetingAnalysis?.topicMap ?? [];
  const claims = meetingAnalysis?.evidenceMap ?? [];
  const omittedMacroTopics = topics
    .filter((topic) => topic.evidenceDensity?.sustained === true && !topicTextCovered(markdown, topic))
    .map((topic) => ({ topicId: topic.topicId, title: topic.title, timeRange: topic.timeRange, evidenceSegmentIds: topic.evidenceSegmentIds.slice(0, 12) }));
  const uncertainEvidenceClaims = claims
    .filter((claim) => claim.status === "unresolved" && ["decision", "action", "core_judgment"].includes(claim.claimType) && claimAppears(markdown, claim))
    .map((claim) => ({ claimId: claim.claimId, claimType: claim.claimType, text: claim.text, evidenceQuality: claim.evidenceQuality, evidenceSegmentIds: claim.evidenceSegmentIds }));
  const actionCoverageGaps = topics
    .filter((topic) => topic.actions.length > 0 && !topic.actions.some((action) => claimAppears(markdown, action)))
    .map((topic) => ({ topicId: topic.topicId, title: topic.title, actionCount: topic.actions.length }));
  const participantAliases = new Set(meetingAnalysis?.participantResolution?.participants?.map((participant) => participant.alias) ?? []);
  const referencedAliases = [...markdown.matchAll(/参会人\s+[A-Z]+/gu)].map((match) => match[0]);
  const unsupportedParticipantAliases = uniqueStrings(referencedAliases.filter((alias) => !participantAliases.has(alias)), 30);
  const delegatedInvalidSegmentIds = uniqueStrings(meetingAnalysis?.delegatedReview?.invalidSegmentIds, 100);
  const delegatedMissingEvidencePaths = uniqueStrings(meetingAnalysis?.delegatedReview?.missingEvidencePaths, 100);
  return {
    omittedMacroTopics,
    uncertainEvidenceClaims: [
      ...uncertainEvidenceClaims,
      ...delegatedMissingEvidencePaths.map((path) => ({
        claimId: `delegated-review:${path}`,
        claimType: "delegated_review",
        text: "委派核验结果包含缺少 evidenceSegmentIds 的事实性发现。",
        evidenceQuality: "missing",
        evidenceSegmentIds: [],
      })),
    ],
    actionCoverageGaps,
    speakerAttributionViolations: unsupportedParticipantAliases.map((alias) => ({ alias, reason: "alias_not_in_participant_map" })),
    unsupportedEntities: unsupportedParticipantAliases,
    crossMeetingTerms: delegatedInvalidSegmentIds.map((segmentId) => ({ segmentId, reason: "delegated_segment_not_in_current_transcript" })),
    ambiguousTermExpansions: [],
  };
}
