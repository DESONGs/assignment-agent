import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  CLOUD_ASR_MEDIA_EXTENSIONS,
  DASHSCOPE_FILE_EXTENSIONS,
  DASHSCOPE_REALTIME_FORMATS,
  cloudAsrMediaKind,
  planDashScopeInput,
  validateCloudAsrMediaHeader,
} from "../tools/asr_media_formats.mjs";
import {
  normalizeDiarizationPreference,
  normalizeSpeakerCount,
} from "../tools/asr_diarization_helpers.mjs";
import { transcribeDashScopeAsr } from "../tools/dashscope_asr_client.mjs";
import { buildSingleMixAnalysis, textSimilarity } from "../tools/single_mix_asr_helpers.mjs";
import { SUPPORTED_AUDIO_EXTENSIONS } from "../tools/audio_normalize_helpers.mjs";
import { attachmentKind } from "../tools/im_file_context_helpers.mjs";
import { classifyTaskIntent } from "../tools/task_router.mjs";

const EXPECTED_FILE_EXTENSIONS = [
  ".aac", ".amr", ".avi", ".flac", ".flv", ".m4a", ".mkv", ".mov", ".mp3",
  ".mp4", ".mpeg", ".ogg", ".opus", ".wav", ".webm", ".wma", ".wmv",
];

/** @param {unknown} value @returns {Record<string, unknown>} */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};
}

test("cloud file ASR accepts the complete documented recorded-file matrix", () => {
  assert.deepEqual([...DASHSCOPE_FILE_EXTENSIONS].sort(), EXPECTED_FILE_EXTENSIONS);
  assert.deepEqual([...DASHSCOPE_REALTIME_FORMATS].sort(), ["aac", "amr", "mp3", "opus", "pcm", "speex", "wav"]);
  assert.equal(CLOUD_ASR_MEDIA_EXTENSIONS.has(".m4a"), true);
  assert.equal(CLOUD_ASR_MEDIA_EXTENSIONS.has(".mp4"), true);
  assert.equal(CLOUD_ASR_MEDIA_EXTENSIONS.has(".wma"), true);
  assert.deepEqual([...SUPPORTED_AUDIO_EXTENSIONS].sort(), [...CLOUD_ASR_MEDIA_EXTENSIONS].sort());
});

test("auto mode keeps file and realtime endpoints separate", () => {
  assert.deepEqual(planDashScopeInput("meeting.m4a", { fileTransportConfigured: true }), {
    status: "ready", mode: "file", extension: ".m4a", format: "m4a",
  });
  assert.equal(planDashScopeInput("meeting.m4a", { fileTransportConfigured: false }).reason, "cloud_asr_file_transport_unavailable");
  assert.equal(planDashScopeInput("meeting.wav", { fileTransportConfigured: true }).mode, "file");
  assert.equal(planDashScopeInput("meeting.wav", { fileTransportConfigured: false }).mode, "realtime");
  assert.equal(planDashScopeInput("meeting.m4a", { inputMode: "realtime", fileTransportConfigured: true }).reason, "cloud_asr_realtime_format_not_supported");
  assert.equal(planDashScopeInput("capture.pcm", { inputMode: "file", fileTransportConfigured: true }).reason, "cloud_asr_file_format_not_supported");
});

test("audio and video containers are classified for transcription", () => {
  assert.equal(cloudAsrMediaKind("meeting.wma"), "audio");
  assert.equal(cloudAsrMediaKind("meeting.mp4"), "video");
  assert.equal(cloudAsrMediaKind("meeting.pdf"), null);
});

test("Feishu file attachments in the cloud matrix route to the ASR profile", () => {
  const audio = { resourceType: "file", name: "meeting.wma", localPath: "/tmp/meeting.wma" };
  const video = { resourceType: "file", name: "meeting.mp4", localPath: "/tmp/meeting.mp4" };
  assert.equal(attachmentKind(audio), "audio");
  assert.equal(attachmentKind(video), "video");
  const intent = classifyTaskIntent(
    { message: { text: "请把这个视频转写并形成会议纪要" } },
    [video],
    { contexts: [{ status: "ready", fileName: "meeting.mp4" }] },
  );
  assert.equal(intent.requiresAsr, true);
  assert.equal(intent.executionProfile, "audio_minutes");
  assert.equal(intent.responseMode, "document_pipeline");
});

test("known headers are validated without pretending every codec has a magic header", () => {
  assert.equal(validateCloudAsrMediaHeader("meeting.m4a", Buffer.from("0000ftypM4A ")).ok, true);
  assert.deepEqual(validateCloudAsrMediaHeader("wechat.aac", Buffer.from("0000ftypM4A ")).detectedContainer, "m4a");
  assert.equal(validateCloudAsrMediaHeader("meeting.webm", Buffer.from([0x1A, 0x45, 0xDF, 0xA3])).ok, true);
  assert.equal(validateCloudAsrMediaHeader("meeting.m4a", Buffer.from("not-media")).ok, false);
  assert.deepEqual(validateCloudAsrMediaHeader("meeting.pcm", Buffer.from([0, 1])), {
    ok: true,
    checked: false,
    reason: null,
    extension: ".pcm",
  });
});

test("file diarization configuration is explicit and speaker count is bounded", () => {
  assert.equal(normalizeDiarizationPreference(undefined), "auto");
  assert.equal(normalizeDiarizationPreference(true), "enabled");
  assert.equal(normalizeDiarizationPreference("off"), "disabled");
  assert.equal(normalizeSpeakerCount("2"), 2);
  assert.equal(normalizeSpeakerCount(100), 100);
  assert.equal(Number.isNaN(normalizeSpeakerCount(1)), true);
  assert.equal(Number.isNaN(normalizeSpeakerCount(101)), true);
});

test("single mixed recording review exposes overlap and model conflicts without merging text", () => {
  assert.equal(textSimilarity("确认安排。", "确认安排"), 1);
  const primary = [
    { chunkIndex: 0, startSec: 0, endSec: 2, text: "先确认酒店。", speakerId: 0 },
    { chunkIndex: 1, startSec: 1.2, endSec: 2.5, text: "我不同意预算。", speakerId: 1 },
    { chunkIndex: 2, startSec: 3, endSec: 4, text: "明天回复。", speakerId: 0 },
  ];
  const review = [
    { chunkIndex: 0, startSec: 0, endSec: 2.5, text: "先确认机票，我不同意这个预算。", speakerId: 4 },
    { chunkIndex: 1, startSec: 3, endSec: 4, text: "后天回复。", speakerId: 4 },
    { chunkIndex: 2, startSec: 5, endSec: 6, text: "还有一个遗漏句子。", speakerId: 5 },
  ];
  const result = buildSingleMixAnalysis({
    primarySegments: primary,
    reviewSegments: review,
    primaryModel: "fun-asr",
    reviewModel: "paraformer-v2",
    sourceFile: "meeting.m4a",
  });
  assert.equal(result.inputTopology, "single_mixed_recording");
  assert.equal(result.sourceSeparationPerformed, false);
  assert.equal(result.simultaneousSpeechRecoveryGuaranteed, false);
  assert.ok(result.explicitOverlapCount >= 1);
  assert.ok(result.reviewItems.some((item) => item.reasons.includes("cross_model_text_conflict")));
  assert.ok(result.reviewItems.some((item) => item.reasons.includes("speech_missing_in_primary_model")));
  const firstTranscriptSegment = result.transcriptSegments.at(0);
  const firstPrimarySegment = primary.at(0);
  assert.ok(firstTranscriptSegment);
  assert.ok(firstPrimarySegment);
  assert.equal(firstTranscriptSegment.text, firstPrimarySegment.text);
  assert.equal(firstTranscriptSegment.singleMixEvidence.status, "needs_review");
});

test("file-mode client emits the standard artifact contract without using the realtime endpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "assignment-cloud-file-asr-"));
  try {
    const source = join(dir, "meeting.m4a");
    writeFileSync(source, Buffer.from("0000ftypM4A mock"));
    const result = await transcribeDashScopeAsr({
      paths: [source],
      outputDir: join(dir, "artifacts"),
      meetingId: "mock-file-mode",
      mockFileProvider: true,
      inputMode: "auto",
      diarizationEnabled: true,
      speakerCount: 2,
      mockFileSentences: [
        { begin_time: 0, end_time: 900, text: "第一位发言。", speaker_id: 0 },
        { begin_time: 1000, end_time: 1900, text: "第二位回应。", speaker_id: 1 },
      ],
    });
    assert.equal(result.status, "completed");
    const summary = asRecord(result.summary);
    const speakerDiarization = asRecord(summary.speakerDiarization);
    const singleMixSummary = asRecord(summary.singleMix);
    const singleMixSource = asRecord(Array.isArray(singleMixSummary.bySource) ? singleMixSummary.bySource[0] : null);
    assert.equal(summary.model, "fun-asr");
    assert.deepEqual(summary.inputModes, ["file"]);
    assert.equal(summary.transcriptSegments, 2);
    assert.equal(speakerDiarization.enabled, true);
    assert.equal(speakerDiarization.speakerLabelsAvailable, true);
    assert.equal(singleMixSummary.enabled, true);
    assert.equal(singleMixSummary.reviewItemCount, 0);
    assert.equal(singleMixSource.reviewItems, undefined);
    const transcript = JSON.parse(readFileSync(join(dir, "artifacts", "transcripts", "transcript.full.json"), "utf8"));
    assert.equal(transcript.transcription.endpoint, "dashscope-file-transcription-mock");
    assert.deepEqual(transcript.transcription.inputModes, ["file"]);
    assert.equal(transcript.sources[0].format, "m4a");
    assert.deepEqual(transcript.transcriptSegments.map((/** @type {{ speakerLabel?: unknown }} */ segment) => segment.speakerLabel), ["speaker_0", "speaker_1"]);
    const evidence = JSON.parse(readFileSync(join(dir, "artifacts", "evidence", "evidence-index.json"), "utf8"));
    assert.equal(evidence.speakerDiarization.speakerLabelsAvailable, true);
    const run = JSON.parse(readFileSync(join(dir, "artifacts", "asr", "cloud-asr-run.json"), "utf8"));
    assert.equal(run.rawMediaExternalUpload, false);
    const singleMix = JSON.parse(readFileSync(join(dir, "artifacts", "asr", "single-mix-analysis.json"), "utf8"));
    assert.equal(singleMix.inputTopology, "single_mixed_recording");
    assert.equal(singleMix.rules.reviewTextIsNeverSilentlyMerged, true);
    assert.match(readFileSync(join(dir, "artifacts", "transcripts", "transcript.readable.md"), "utf8"), /说话人 2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("realtime-mode client remains a distinct WebSocket path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "assignment-cloud-realtime-asr-"));
  try {
    const source = join(dir, "meeting.wav");
    writeFileSync(source, Buffer.from("RIFF0000WAVEmock"));
    const result = await transcribeDashScopeAsr({
      paths: [source],
      outputDir: join(dir, "artifacts"),
      meetingId: "mock-realtime-mode",
      mockProvider: true,
      inputMode: "realtime",
    });
    assert.equal(result.status, "completed");
    const summary = asRecord(result.summary);
    const speakerDiarization = asRecord(summary.speakerDiarization);
    assert.equal(summary.model, "paraformer-realtime-v2");
    assert.deepEqual(summary.inputModes, ["realtime"]);
    assert.equal(speakerDiarization.enabled, false);
    assert.deepEqual(speakerDiarization.statuses, ["unsupported_realtime_endpoint"]);
    const transcript = JSON.parse(readFileSync(join(dir, "artifacts", "transcripts", "transcript.full.json"), "utf8"));
    assert.equal(transcript.transcription.endpoint, "dashscope-websocket-mock");
    assert.equal(transcript.transcription.speakerDiarization.speakerLabelsAvailable, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
