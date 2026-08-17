const DEFAULT_TEXT_CONFLICT_THRESHOLD = 0.42;
const DEFAULT_ALIGNMENT_TOLERANCE_SECONDS = 0.15;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function bigrams(value) {
  if (value.length < 2) return value ? [value] : [];
  const result = [];
  for (let index = 0; index < value.length - 1; index += 1) result.push(value.slice(index, index + 2));
  return result;
}

export function textSimilarity(left, right) {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) >= 2 && (a.includes(b) || b.includes(a))) return 0.8;
  if (a.length === 1 || b.length === 1) return a === b ? 1 : 0;
  const aPairs = bigrams(a);
  const bCounts = new Map();
  for (const pair of bigrams(b)) bCounts.set(pair, (bCounts.get(pair) ?? 0) + 1);
  let intersection = 0;
  for (const pair of aPairs) {
    const count = bCounts.get(pair) ?? 0;
    if (count <= 0) continue;
    intersection += 1;
    bCounts.set(pair, count - 1);
  }
  return (2 * intersection) / (aPairs.length + bigrams(b).length);
}

function interval(segment) {
  const startSec = finiteNumber(segment?.startSec);
  const endSec = Math.max(startSec, finiteNumber(segment?.endSec, startSec));
  return { startSec, endSec };
}

function overlapSeconds(left, right) {
  const a = interval(left);
  const b = interval(right);
  return Math.max(0, Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec));
}

function segmentDistance(left, right) {
  const a = interval(left);
  const b = interval(right);
  if (overlapSeconds(left, right) > 0) return 0;
  if (a.endSec <= b.startSec) return b.startSec - a.endSec;
  return a.startSec - b.endSec;
}

function speakerKey(value) {
  return value === null || value === undefined ? null : String(value);
}

function buildSpeakerMap(primarySegments, reviewSegments) {
  const weights = new Map();
  for (const review of reviewSegments) {
    const reviewSpeaker = speakerKey(review.speakerId);
    if (reviewSpeaker === null) continue;
    if (!weights.has(reviewSpeaker)) weights.set(reviewSpeaker, new Map());
    for (const primary of primarySegments) {
      const primarySpeaker = speakerKey(primary.speakerId);
      if (primarySpeaker === null) continue;
      const overlap = overlapSeconds(primary, review);
      if (overlap <= 0) continue;
      const row = weights.get(reviewSpeaker);
      row.set(primarySpeaker, (row.get(primarySpeaker) ?? 0) + overlap);
    }
  }
  const mapping = {};
  for (const [reviewSpeaker, candidates] of weights.entries()) {
    const sorted = [...candidates.entries()].sort((left, right) => right[1] - left[1]);
    if (sorted.length > 0) mapping[reviewSpeaker] = sorted[0][0];
  }
  return mapping;
}

function explicitOverlapItems(segments, model) {
  const items = [];
  const sorted = [...segments].sort((left, right) => finiteNumber(left.startSec) - finiteNumber(right.startSec));
  for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
    const left = sorted[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
      const right = sorted[rightIndex];
      if (finiteNumber(right.startSec) >= finiteNumber(left.endSec)) break;
      const overlap = overlapSeconds(left, right);
      if (overlap < 0.08 || speakerKey(left.speakerId) === speakerKey(right.speakerId)) continue;
      items.push({
        startSec: Math.max(finiteNumber(left.startSec), finiteNumber(right.startSec)),
        endSec: Math.min(finiteNumber(left.endSec), finiteNumber(right.endSec)),
        severity: "high",
        reasons: ["simultaneous_speech_timestamps"],
        model,
        primarySegmentIndexes: [left.chunkIndex, right.chunkIndex].filter(Number.isInteger),
        primary: [left, right].map((segment) => ({
          speakerId: segment.speakerId ?? null,
          text: String(segment.text ?? ""),
        })),
        review: [],
      });
    }
  }
  return items;
}

function alignSegments(primarySegments, reviewSegments, toleranceSeconds) {
  const alignments = [];
  const matchedReview = new Set();
  for (const primary of primarySegments) {
    const candidates = reviewSegments
      .map((review, index) => ({ review, index, overlap: overlapSeconds(primary, review), distance: segmentDistance(primary, review) }))
      .filter((item) => item.overlap >= 0.08 || item.distance <= toleranceSeconds)
      .sort((left, right) => right.overlap - left.overlap || left.distance - right.distance);
    const selected = candidates.filter((item) => item.overlap >= 0.08);
    if (selected.length === 0 && candidates[0]) selected.push(candidates[0]);
    for (const item of selected) matchedReview.add(item.index);
    alignments.push({ primary, review: selected.map((item) => item.review) });
  }
  return {
    alignments,
    unmatchedReview: reviewSegments.filter((_segment, index) => !matchedReview.has(index)),
  };
}

function compactSegment(segment) {
  return {
    chunkIndex: Number.isInteger(segment?.chunkIndex) ? segment.chunkIndex : null,
    startSec: finiteNumber(segment?.startSec),
    endSec: finiteNumber(segment?.endSec),
    speakerId: segment?.speakerId ?? null,
    text: String(segment?.text ?? ""),
  };
}

function reviewItemForAlignment(alignment, speakerMap, threshold) {
  const primary = alignment.primary;
  const review = alignment.review;
  if (review.length === 0) return null;
  const reviewText = review.map((segment) => String(segment.text ?? "").trim()).filter(Boolean).join(" ");
  const similarity = textSimilarity(primary.text, reviewText);
  const mappedSpeakers = [...new Set(review
    .map((segment) => speakerKey(segment.speakerId))
    .filter((value) => value !== null)
    .map((value) => speakerMap[value] ?? null)
    .filter((value) => value !== null))];
  const primarySpeaker = speakerKey(primary.speakerId);
  const reasons = [];
  if (similarity < threshold) reasons.push("cross_model_text_conflict");
  if (primarySpeaker !== null && mappedSpeakers.length > 0 && mappedSpeakers.some((speaker) => speaker !== primarySpeaker)) {
    reasons.push("speaker_attribution_conflict");
  }
  if (reasons.length === 0) return null;
  const starts = [primary, ...review].map((segment) => finiteNumber(segment.startSec));
  const ends = [primary, ...review].map((segment) => finiteNumber(segment.endSec));
  return {
    startSec: Math.min(...starts),
    endSec: Math.max(...ends),
    severity: similarity < 0.2 || reasons.includes("speaker_attribution_conflict") ? "high" : "medium",
    reasons,
    textSimilarity: Number(similarity.toFixed(3)),
    primarySegmentIndexes: Number.isInteger(primary.chunkIndex) ? [primary.chunkIndex] : [],
    primary: [compactSegment(primary)],
    review: review.map(compactSegment),
  };
}

function unmatchedReviewItem(segment) {
  return {
    startSec: finiteNumber(segment.startSec),
    endSec: finiteNumber(segment.endSec),
    severity: "high",
    reasons: ["speech_missing_in_primary_model"],
    textSimilarity: null,
    primarySegmentIndexes: [],
    primary: [],
    review: [compactSegment(segment)],
  };
}

function uniqueSegments(segments) {
  const seen = new Set();
  return segments.filter((segment) => {
    const key = [segment.chunkIndex, segment.startSec, segment.endSec, segment.speakerId, segment.text].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeReviewItems(items) {
  const merged = [];
  for (const item of [...items].sort((left, right) => left.startSec - right.startSec || left.endSec - right.endSec)) {
    const previous = merged.at(-1);
    if (!previous || item.startSec > previous.endSec + 0.05) {
      merged.push({ ...item });
      continue;
    }
    previous.endSec = Math.max(previous.endSec, item.endSec);
    previous.severity = previous.severity === "high" || item.severity === "high" ? "high" : "medium";
    previous.reasons = [...new Set([...(previous.reasons ?? []), ...(item.reasons ?? [])])];
    previous.primarySegmentIndexes = [...new Set([...(previous.primarySegmentIndexes ?? []), ...(item.primarySegmentIndexes ?? [])])];
    previous.primary = uniqueSegments([...(previous.primary ?? []), ...(item.primary ?? [])]);
    previous.review = uniqueSegments([...(previous.review ?? []), ...(item.review ?? [])]);
    const similarities = [previous.textSimilarity, item.textSimilarity].filter((value) => Number.isFinite(value));
    previous.textSimilarity = similarities.length > 0 ? Math.min(...similarities) : null;
  }
  return merged;
}

export function normalizeSingleMixMode(value) {
  if (value === false || /^(0|false|no|off|disabled)$/i.test(String(value ?? "").trim())) return "disabled";
  return "robust";
}

/**
 * @param {{
 *   primarySegments?: any[],
 *   reviewSegments?: any[],
 *   primaryModel?: string,
 *   reviewModel?: string,
 *   reviewStatus?: string,
 *   sourceFile?: string | null,
 *   textConflictThreshold?: number,
 *   alignmentToleranceSeconds?: number,
 * }} [options]
 */
export function buildSingleMixAnalysis({
  primarySegments = [],
  reviewSegments = [],
  primaryModel,
  reviewModel,
  reviewStatus = "completed",
  sourceFile = null,
  textConflictThreshold = DEFAULT_TEXT_CONFLICT_THRESHOLD,
  alignmentToleranceSeconds = DEFAULT_ALIGNMENT_TOLERANCE_SECONDS,
} = {}) {
  const speakerMap = buildSpeakerMap(primarySegments, reviewSegments);
  const explicitItems = [
    ...explicitOverlapItems(primarySegments, primaryModel),
    ...explicitOverlapItems(reviewSegments, reviewModel),
  ];
  const { alignments, unmatchedReview } = alignSegments(primarySegments, reviewSegments, alignmentToleranceSeconds);
  const conflictItems = reviewStatus === "completed"
    ? alignments.map((alignment) => reviewItemForAlignment(alignment, speakerMap, textConflictThreshold)).filter(Boolean)
    : [];
  const missingItems = reviewStatus === "completed" ? unmatchedReview.map(unmatchedReviewItem) : [];
  const reviewItems = mergeReviewItems([...explicitItems, ...conflictItems, ...missingItems])
    .map((item, index) => ({
      reviewId: `single-mix-review-${String(index + 1).padStart(4, "0")}`,
      resolution: "unresolved",
      classification: item.reasons.includes("simultaneous_speech_timestamps")
        ? "confirmed_timestamp_overlap"
        : "possible_overlap_or_asr_instability",
      ...item,
    }));
  const reviewByPrimaryIndex = new Map();
  for (const item of reviewItems) {
    for (const index of item.primarySegmentIndexes ?? []) {
      if (!reviewByPrimaryIndex.has(index)) reviewByPrimaryIndex.set(index, []);
      reviewByPrimaryIndex.get(index).push(item.reviewId);
    }
  }
  const transcriptSegments = primarySegments.map((segment, index) => {
    const chunkIndex = Number.isInteger(segment.chunkIndex) ? segment.chunkIndex : index;
    const reviewIds = reviewByPrimaryIndex.get(chunkIndex) ?? [];
    return {
      ...segment,
      singleMixEvidence: {
        status: reviewIds.length > 0 ? "needs_review" : reviewStatus === "completed" ? "corroborated_or_no_conflict" : "primary_only",
        reviewIds,
      },
    };
  });
  const primarySpeakerIds = [...new Set(primarySegments.map((segment) => speakerKey(segment.speakerId)).filter((value) => value !== null))];
  const explicitOverlapCount = reviewItems.filter((item) => item.classification === "confirmed_timestamp_overlap").length;
  return {
    schemaVersion: "single-mix-analysis-v1",
    inputTopology: "single_mixed_recording",
    sourceFile,
    status: reviewStatus !== "completed"
      ? "review_model_unavailable"
      : reviewItems.length > 0 ? "completed_with_review_items" : "completed_no_conflicts_detected",
    primaryModel,
    reviewModel,
    reviewStatus,
    strategy: "dual_model_diarization_consistency_review",
    speakerCountDetected: primarySpeakerIds.length,
    speakerIdsAnonymous: true,
    sourceSeparationPerformed: false,
    simultaneousSpeechRecoveryGuaranteed: false,
    reviewItemCount: reviewItems.length,
    explicitOverlapCount,
    highSeverityCount: reviewItems.filter((item) => item.severity === "high").length,
    speakerMapReviewToPrimary: speakerMap,
    reviewItems,
    transcriptSegments,
    rules: {
      primaryTranscriptRemainsAuthoritative: true,
      reviewTextIsNeverSilentlyMerged: true,
      unresolvedItemsMustNotBecomeCertainMeetingClaims: true,
      transcriptOnlyInputCannotRecoverMissingAcousticSources: true,
    },
  };
}
