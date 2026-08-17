import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  classifyPublicUrl,
  enforceContentLength,
  extractPublicUrls,
  isBlockedNetworkAddress,
  sanitizeUrlForArtifact,
  validatePublicRedirect,
  validatePublicUrl,
} from "../tools/public_url_security.mjs";
import {
  parseRssFeed,
  parseJsonTranscript,
  parseVttTranscript,
  parseXiaoyuzhouPage,
  resolvePublicMediaSource,
} from "../tools/public_url_source_helpers.mjs";
import {
  buildKnowledgeSourcePack,
  buildProvenanceIndex,
  normalizeSourceChapterAnalysis,
  normalizeSourceSegments,
  partitionSourceSegments,
} from "../tools/public_url_source_pack_helpers.mjs";
import { classifyTaskIntent } from "../tools/task_router.mjs";
import { runTaskExecutionPipeline, shouldUseTaskExecutionRunner } from "../tools/task_execution_runner.mjs";
import { handleEvent } from "../tools/feishu_agent_task_handler.mjs";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const episodeUrl = "https://pod.example/episodes/one";
const feedUrl = "https://pod.example/feed.xml";
const transcriptUrl = "https://cdn.example/one.vtt";
const mediaUrl = "https://cdn.example/one.mp3";
const vtt = `WEBVTT

00:00:00.000 --> 00:00:03.000
第一段官方文稿。

00:00:03.000 --> 00:00:06.000
第二段官方文稿。
`;

function rssFixture({ transcript = true } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>测试节目</title><language>zh-CN</language>
    <item>
      <title>第一期</title><link>${episodeUrl}</link><pubDate>Mon, 17 Aug 2026 00:00:00 GMT</pubDate>
      <itunes:duration>60</itunes:duration>
      ${transcript ? `<podcast:transcript url="${transcriptUrl}" type="text/vtt" language="zh-CN" />` : ""}
      <enclosure url="${mediaUrl}" type="audio/mpeg" length="12345" />
    </item>
  </channel>
</rss>`;
}

test("public URL classification covers YouTube, RSS, Xiaoyuzhou and direct media", () => {
  assert.deepEqual(classifyPublicUrl("https://youtu.be/abc123"), { platform: "youtube", kind: "video_page" });
  assert.deepEqual(classifyPublicUrl("https://example.com/feed.xml"), { platform: "rss", kind: "podcast_feed" });
  assert.deepEqual(classifyPublicUrl("https://www.xiaoyuzhoufm.com/episode/abc"), { platform: "xiaoyuzhou", kind: "podcast_episode" });
  assert.deepEqual(classifyPublicUrl("https://cdn.example.com/audio.mp3"), { platform: "direct", kind: "direct_media" });
  assert.deepEqual(extractPublicUrls("请处理 https://example.com/a.mp3。"), ["https://example.com/a.mp3"]);
});

test("URL artifacts redact signed credentials but keep ordinary public query parameters", () => {
  assert.match(sanitizeUrlForArtifact("https://cdn.example/a.mp3?X-Amz-Signature=secret&lang=zh"), /X-Amz-Signature=%5Bredacted%5D/);
  assert.match(sanitizeUrlForArtifact("https://example.com/episode?s=share-value"), /s=share-value/);
});

test("SSRF, dangerous redirects and oversized responses are blocked", async () => {
  assert.equal(isBlockedNetworkAddress("127.0.0.1"), true);
  assert.equal(isBlockedNetworkAddress("169.254.169.254"), true);
  assert.equal(isBlockedNetworkAddress("10.1.2.3"), true);
  assert.equal(isBlockedNetworkAddress("fec0::1"), true);
  assert.equal(isBlockedNetworkAddress("93.184.216.34"), false);
  assert.equal((await validatePublicUrl("http://127.0.0.1/admin")).reason, "public_url_private_address_blocked");
  assert.match((await validatePublicRedirect("https://example.com", "http://169.254.169.254/latest")).reason, /redirect_public_url_private_address_blocked/);
  assert.equal((await validatePublicUrl("https://example.com", { lookupFn: publicLookup })).status, "ready");
  assert.equal(enforceContentLength({ "content-length": "5001" }, 5000).reason, "public_url_size_limit_exceeded");
});

test("YouTube json3 captions preserve millisecond timestamps and segmented text", () => {
  const segments = parseJsonTranscript({ events: [
    { tStartMs: 3200, dDurationMs: 1800, segs: [{ utf8: "第一句" }, { utf8: "字幕" }] },
    { tStartMs: 5000, dDurationMs: 1000, segs: [{ utf8: "第二句" }] },
  ] });
  assert.deepEqual(segments, [
    { startMs: 3200, endMs: 5000, text: "第一句字幕", speaker: null },
    { startMs: 5000, endMs: 6000, text: "第二句", speaker: null },
  ]);
});

test("RSS parser preserves podcast transcript and enclosure metadata", () => {
  const parsed = parseRssFeed(rssFixture(), feedUrl);
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.source.title, "第一期");
  assert.equal(parsed.source.program, "测试节目");
  assert.equal(parsed.source.durationSec, 60);
  assert.equal(parsed.transcriptCandidates[0].url, transcriptUrl);
  assert.equal(parsed.mediaUrl, mediaUrl);
});

test("RSS episode lookup never falls back to the latest item when the requested episode is absent", () => {
  const parsed = parseRssFeed(rssFixture(), feedUrl, { episodeUrl: "https://pod.example/episodes/missing" });
  assert.equal(parsed.status, "blocked");
  assert.equal(parsed.reason, "podcast_rss_episode_url_not_found");
});

test("official timestamped podcast transcript is preferred over cloud ASR fallback", async () => {
  const fetched = async (url) => {
    if (url === feedUrl) return { status: "completed", finalUrl: feedUrl, contentType: "application/rss+xml", body: Buffer.from(rssFixture()) };
    if (url === transcriptUrl) return { status: "completed", finalUrl: transcriptUrl, contentType: "text/vtt", body: Buffer.from(vtt) };
    throw new Error(`unexpected fetch ${url}`);
  };
  const resolved = await resolvePublicMediaSource(feedUrl, { resolveOnly: true, lookupFn: publicLookup, fetchResource: fetched });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.source.acquisitionMethod, "official_podcast_transcript");
  assert.equal(resolved.transcript.origin, "official_podcast_transcript");
  assert.equal(resolved.transcript.segments.length, 2);
  assert.equal(resolved.media.status, "not_required");
});

test("podcast without reliable transcript plans cloud ASR and does not claim completion", async () => {
  const fetched = async () => ({ status: "completed", finalUrl: feedUrl, contentType: "application/rss+xml", body: Buffer.from(rssFixture({ transcript: false })) });
  const resolved = await resolvePublicMediaSource(feedUrl, {
    resolveOnly: true,
    lookupFn: publicLookup,
    fetchResource: fetched,
    probeResource: async () => ({ status: "ready", finalUrl: mediaUrl, contentType: "audio/mpeg", contentLength: 12345 }),
  });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.transcript, null);
  assert.deepEqual(resolved.fallback, { required: true, method: "cloud_asr" });
  assert.equal(resolved.media.status, "available_not_downloaded");
});

test("extensionless public media URL is detected from content type before HTML parsing", async () => {
  const url = "https://cdn.example/public-media?id=episode-1";
  const resolved = await resolvePublicMediaSource(url, {
    resolveOnly: true,
    lookupFn: publicLookup,
    probeResource: async () => ({ status: "ready", finalUrl: url, contentType: "audio/mpeg", contentLength: 4567 }),
    fetchResource: async () => { throw new Error("media URL must not be fetched as HTML"); },
  });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.source.platform, "direct");
  assert.equal(resolved.media.contentType, "audio/mpeg");
  assert.deepEqual(resolved.fallback, { required: true, method: "cloud_asr" });
});

test("YouTube adapter uses official subtitles before media download", async () => {
  const youtubeUrl = "https://www.youtube.com/watch?v=fixture";
  const metadata = {
    title: "Stable short fixture",
    uploader: "Fixture channel",
    webpage_url: youtubeUrl,
    duration: 30,
    availability: "public",
    subtitles: { en: [{ ext: "vtt", url: "https://www.youtube.com/api/timedtext?v=fixture" }] },
  };
  const resolved = await resolvePublicMediaSource(youtubeUrl, {
    resolveOnly: true,
    lookupFn: publicLookup,
    youtubeMetadata: metadata,
    fetchResource: async () => ({ status: "completed", contentType: "text/vtt", body: Buffer.from(vtt) }),
  });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.source.acquisitionMethod, "official_subtitle");
  assert.equal(resolved.transcript.segments.length, 2);
  assert.equal(resolved.media.status, "not_required");
});

test("YouTube adapter falls back to cloud ASR when official subtitles are absent", async () => {
  const youtubeUrl = "https://youtu.be/fixture";
  const resolved = await resolvePublicMediaSource(youtubeUrl, {
    resolveOnly: true,
    lookupFn: publicLookup,
    youtubeMetadata: { title: "No subtitle", webpage_url: youtubeUrl, duration: 20, availability: "public", subtitles: {} },
  });
  assert.equal(resolved.status, "resolved");
  assert.deepEqual(resolved.fallback, { required: true, method: "cloud_asr" });
  assert.equal(resolved.media.status, "available_not_downloaded");
});

test("Xiaoyuzhou page parser reads public episode metadata without treating show notes as transcript", () => {
  const data = {
    props: { pageProps: { episode: {
      title: "公开单集", description: "节目介绍", shownotes: "<p>00:10 第一章</p><p>01:00 第二章</p>", duration: 90, pubDate: "2026-08-11T00:00:00Z",
      enclosure: { url: mediaUrl }, transcript: { mediaId: "only-a-pointer" },
      podcast: { title: "节目", author: "作者", payType: "FREE", permissions: [{ name: "AI_SUMMARIZE_EPISODE", status: "DENIED" }] },
    } } },
  };
  const html = `<meta property="og:title" content="fallback"><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
  const parsed = parseXiaoyuzhouPage(html, "https://www.xiaoyuzhoufm.com/episode/fixture");
  assert.equal(parsed.source.title, "公开单集");
  assert.equal(parsed.source.author, "作者");
  assert.equal(parsed.mediaUrl, mediaUrl);
  assert.equal(parsed.embeddedTranscript, null);
  assert.deepEqual(parsed.source.chapters, [
    { startMs: 10_000, title: "第一章", origin: "official_show_notes" },
    { startMs: 60_000, title: "第二章", origin: "official_show_notes" },
  ]);
  assert.ok(parsed.diagnostics.includes("xiaoyuzhou_transcript_pointer_without_public_text"));
  assert.ok(parsed.diagnostics.includes("xiaoyuzhou_platform_ai_summary_permission_denied_metadata_present"));
});

test("source pack partitions long evidence and traces every claim to transcript origin", () => {
  const segments = normalizeSourceSegments({ segments: [
    { segmentId: "s1", startMs: 0, endMs: 240000, text: "作者提出第一条观点。" },
    { segmentId: "s2", startMs: 240000, endMs: 520000, text: "作者说明第二条事实。" },
  ] }, { originType: "official_podcast_transcript", sourceUrl: episodeUrl });
  const chapters = partitionSourceSegments(segments, { maxChapterDurationMs: 300000, maxChapterChars: 1000 });
  assert.equal(chapters.length, 2);
  const analyses = chapters.map((chapter, index) => normalizeSourceChapterAnalysis({
    chapterTitle: `章节 ${index + 1}`,
    summary: "摘要",
    claims: [{ claimType: index === 0 ? "author_view" : "explicit_fact", text: chapter.segments[0].text, evidenceSegmentIds: [chapter.segmentIds[0]], confidence: "high" }],
    suggestedRelatedTopics: ["Agent 产品"],
  }, chapter));
  const provenance = buildProvenanceIndex({ originalUrl: episodeUrl, finalSourceUrl: episodeUrl, platform: "rss", title: "第一期" }, segments, "official_podcast_transcript");
  const pack = buildKnowledgeSourcePack({
    source: { originalUrl: episodeUrl, finalSourceUrl: episodeUrl, platform: "rss", title: "第一期", author: "作者", program: "节目", publishedAt: null, durationSec: 520, language: "zh-CN", acquisitionMethod: "official_podcast_transcript", processedAt: new Date().toISOString() },
    transcript: { status: "complete", quality: "official_timestamped" },
    segments,
    chapterAnalyses: analyses,
    transcriptMethod: "official_podcast_transcript",
    provenancePath: "artifacts/public-source/provenance/evidence-index.json",
  });
  assert.equal(pack.status, "complete");
  assert.equal(pack.chapters.length, 2);
  assert.equal(pack.provenance.allClaimsHaveEvidence, true);
  assert.equal(provenance.segments[0].originType, "official_podcast_transcript");
});

test("official chapter markers keep the prelude and remain bounded without losing transcript segments", () => {
  const segments = [
    { segmentId: "s1", startMs: 0, endMs: 9000, text: "开场内容" },
    { segmentId: "s2", startMs: 10_000, endMs: 20_000, text: "第一章内容一" },
    { segmentId: "s3", startMs: 20_000, endMs: 30_000, text: "第一章内容二" },
    { segmentId: "s4", startMs: 60_000, endMs: 70_000, text: "第二章内容" },
  ];
  const chapters = partitionSourceSegments(segments, {
    chapterMarkers: [{ startMs: 10_000, title: "第一章" }, { startMs: 60_000, title: "第二章" }],
    maxChapterChars: 7,
    maxChapterDurationMs: 60_000,
  });
  assert.equal(chapters[0].officialTitle, "开场");
  assert.deepEqual(chapters.flatMap((chapter) => chapter.segmentIds), ["s1", "s2", "s3", "s4"]);
  assert.ok(chapters.every((chapter) => chapter.charCount <= 7));
});

test("Feishu and local Agent router send explicit public URLs to the real source-pack profile", () => {
  const event = { message: { text: "请整理这个播客 https://pod.example/feed.xml" } };
  const intent = classifyTaskIntent(event, [], { contexts: [] }, {});
  assert.equal(intent.taskType, "knowledge_source");
  assert.equal(intent.executionProfile, "url_source_pack");
  assert.equal(intent.responseMode, "source_pack");
  assert.equal(intent.sourcePreparation.publicUrls[0], feedUrl);
  assert.equal(shouldUseTaskExecutionRunner({ taskIntent: intent }), true);
  const feishuDoc = classifyTaskIntent({ message: { text: "请看 https://example.larksuite.com/wiki/abc123" } }, [], { contexts: [] }, {});
  assert.notEqual(feishuDoc.executionProfile, "url_source_pack");
});

test("VTT parsing preserves timestamps for evidence indexing", () => {
  const segments = parseVttTranscript(vtt);
  assert.deepEqual(segments.map((item) => [item.startMs, item.endMs]), [[0, 3000], [3000, 6000]]);
});

test("local source-pack profile produces complete handoff artifacts without meeting semantics", async () => {
  const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
  const temp = await mkdtemp(join(workspaceRoot, "runtime-runs", "public-url-integration-"));
  const runDir = join(temp, "runs", "fixture-run");
  const paths = {
    runDir,
    inputsDir: join(runDir, "inputs"),
    artifactsDir: join(runDir, "artifacts"),
    agentOutputPath: join(runDir, "agent-output.json"),
  };
  const task = {
    runId: "fixture-run",
    sourceEvent: { message: { text: episodeUrl } },
    attachments: [],
    taskIntent: {
      taskType: "knowledge_source",
      responseMode: "source_pack",
      executionProfile: "url_source_pack",
      requestedDocuments: [],
      sourcePreparation: { publicUrls: [episodeUrl] },
    },
  };
  try {
    const result = await runTaskExecutionPipeline(task, paths, {
      pipelineMockModel: true,
      publicUrlResolver: async () => ({
        status: "resolved",
        source: {
          originalUrl: episodeUrl,
          finalSourceUrl: episodeUrl,
          platform: "rss",
          title: "第一期",
          author: "作者",
          program: "测试节目",
          publishedAt: "2026-08-17T00:00:00Z",
          durationSec: 6,
          language: "zh-CN",
          description: "",
          showNotes: "",
          acquisitionMethod: "official_podcast_transcript",
          processedAt: new Date().toISOString(),
          publicAccess: true,
        },
        transcript: { status: "completed", origin: "official_podcast_transcript", language: "zh-CN", format: "vtt", hasTimestamps: true, quality: "official_timestamped", segments: parseVttTranscript(vtt), sourceUrl: transcriptUrl },
        media: { status: "not_required" },
        diagnostics: [],
      }),
    });
    assert.equal(result.status, "completed");
    assert.equal(result.output.details.transcriptMethod, "official_podcast_transcript");
    assert.equal(result.output.details.knowledgeBaseWritePerformed, false);
    const pack = JSON.parse(await readFile(join(paths.artifactsDir, "public-source", "source-pack", "source-pack.json"), "utf8"));
    const provenance = JSON.parse(await readFile(join(paths.artifactsDir, "public-source", "provenance", "evidence-index.json"), "utf8"));
    const ledger = JSON.parse(await readFile(join(runDir, "planner-envelope.json"), "utf8"));
    const qaGate = JSON.parse(await readFile(join(runDir, "qa-gate.json"), "utf8"));
    const policyGate = JSON.parse(await readFile(join(runDir, "policy-gate.json"), "utf8"));
    assert.equal(pack.status, "complete");
    assert.equal(pack.quality.partialResultsPublished, false);
    assert.equal(provenance.claims[0].transcriptOrigin, "official_podcast_transcript");
    assert.equal(ledger.steps.find((step) => step.stepId === "verify-source-pack").status, "completed");
    assert.equal(ledger.steps.some((step) => step.stepId === "generate-meeting-minutes"), false);
    assert.equal(qaGate.status, "pass");
    assert.equal(qaGate.checks.sourcePack.allClaimsHaveEvidence, true);
    assert.equal(policyGate.status, "pass");
    assert.equal(policyGate.actionIntent, "external_web");
    assert.equal(result.output.qaGate.evaluatedAt, qaGate.evaluatedAt);
    assert.equal(result.output.policyGate.evaluatedAt, policyGate.evaluatedAt);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("source-pack profile executes cloud ASR fallback when official transcript is unavailable", async () => {
  const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
  const temp = await mkdtemp(join(workspaceRoot, "runtime-runs", "public-url-asr-integration-"));
  const runDir = join(temp, "runs", "fixture-asr-run");
  const mediaPath = join(runDir, "inputs", "source-media.mp3");
  const paths = { runDir, inputsDir: join(runDir, "inputs"), artifactsDir: join(runDir, "artifacts"), agentOutputPath: join(runDir, "agent-output.json") };
  const task = {
    runId: "fixture-asr-run",
    sourceEvent: { message: { text: mediaUrl } },
    attachments: [],
    taskIntent: { taskType: "knowledge_source", responseMode: "source_pack", executionProfile: "url_source_pack", requestedDocuments: [], sourcePreparation: { publicUrls: [mediaUrl] } },
  };
  try {
    await mkdir(paths.inputsDir, { recursive: true });
    await writeFile(mediaPath, Buffer.from("ID3-public-url-mock-audio"));
    const result = await runTaskExecutionPipeline(task, paths, {
      pipelineMockModel: true,
      cloudAsrMockFileProvider: true,
      cloudAsrMockFileSentences: [
        { begin_time: 0, end_time: 2500, text: "公开播客第一段。", speaker_id: 0 },
        { begin_time: 2500, end_time: 5000, text: "公开播客第二段。", speaker_id: 0 },
      ],
      publicUrlResolver: async () => ({
        status: "resolved",
        source: { originalUrl: mediaUrl, finalSourceUrl: mediaUrl, platform: "direct", title: "公开音频", author: "作者", program: null, publishedAt: null, durationSec: 5, language: "zh-CN", description: "", showNotes: "", acquisitionMethod: "direct_public_media", processedAt: new Date().toISOString(), publicAccess: true },
        transcript: null,
        media: { status: "downloaded", localPath: mediaPath, sizeBytes: 24, sha256: "fixture", durationSec: 5, contentType: "audio/mpeg", sourceUrl: mediaUrl },
        fallback: { required: true, method: "cloud_asr" },
        diagnostics: [],
      }),
    });
    assert.equal(result.status, "completed");
    assert.equal(result.output.details.transcriptMethod, "aliyun_dashscope_paraformer");
    const summary = JSON.parse(await readFile(join(paths.artifactsDir, "summary.json"), "utf8"));
    const pack = JSON.parse(await readFile(join(paths.artifactsDir, "public-source", "source-pack", "source-pack.json"), "utf8"));
    const qaGate = JSON.parse(await readFile(join(runDir, "qa-gate.json"), "utf8"));
    assert.equal(summary.status, "complete");
    assert.equal(summary.provider, "aliyun_dashscope_paraformer");
    assert.equal(pack.transcript.method, "aliyun_dashscope_paraformer");
    assert.equal(pack.quality.partialResultsPublished, false);
    assert.equal(qaGate.status, "pass");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("blocked public-source run exposes the blocked step and recovery Todo", async () => {
  const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
  const temp = await mkdtemp(join(workspaceRoot, "runtime-runs", "public-url-blocked-"));
  const runDir = join(temp, "runs", "fixture-blocked-run");
  const paths = { runDir, inputsDir: join(runDir, "inputs"), artifactsDir: join(runDir, "artifacts"), agentOutputPath: join(runDir, "agent-output.json") };
  const task = {
    runId: "fixture-blocked-run",
    sourceEvent: { message: { text: "https://www.youtube.com/watch?v=fixture" } },
    attachments: [],
    taskIntent: { taskType: "knowledge_source", responseMode: "source_pack", executionProfile: "url_source_pack", requestedDocuments: [], sourcePreparation: { publicUrls: ["https://www.youtube.com/watch?v=fixture"] } },
  };
  try {
    const result = await runTaskExecutionPipeline(task, paths, {
      publicUrlResolver: async () => ({ status: "blocked", reason: "youtube_yt_dlp_unavailable", recovery: "Install yt-dlp and retry without cookies." }),
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.output.details.todo.awaitingUser, true);
    assert.equal(result.output.details.todo.items.find((item) => item.itemId === "resolve-public-url").status, "blocked");
    assert.ok(result.output.details.todo.items.some((item) => item.interactive === true));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Feishu source-pack entry returns a readable result and local handoff path", async () => {
  const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
  const outputRoot = await mkdtemp(join(workspaceRoot, "runtime-runs", "feishu-public-url-"));
  const runId = "feishu-public-url-fixture";
  try {
    const result = await handleEvent({
      schemaVersion: "im-event-v1",
      eventId: "evt-public-url-fixture",
      eventType: "im.message.receive_v1",
      occurredAt: new Date().toISOString(),
      message: {
        messageId: "om-public-url-fixture",
        chatId: "oc-public-url-fixture",
        msgType: "text",
        text: `请整理这个播客 ${episodeUrl}`,
        attachments: [],
      },
    }, {
      outputRoot,
      runId,
      executionMode: "execute",
      publishMode: "dry-run",
      replyMode: "dry-run",
      progressReplyMode: "off",
      runtimeStoreMode: "off",
      pipelineMockModel: true,
      publicUrlResolver: async () => ({
        status: "resolved",
        source: {
          originalUrl: episodeUrl,
          finalSourceUrl: episodeUrl,
          platform: "rss",
          title: "第一期",
          author: "作者",
          program: "测试节目",
          publishedAt: "2026-08-17T00:00:00Z",
          durationSec: 6,
          language: "zh-CN",
          description: "",
          showNotes: "",
          acquisitionMethod: "official_podcast_transcript",
          processedAt: new Date().toISOString(),
          publicAccess: true,
        },
        transcript: { status: "completed", origin: "official_podcast_transcript", language: "zh-CN", format: "vtt", hasTimestamps: true, quality: "official_timestamped", segments: parseVttTranscript(vtt), sourceUrl: transcriptUrl },
        media: { status: "not_required" },
        diagnostics: [],
      }),
    });
    assert.equal(result.status, "completed");
    assert.match(result.text, /关键观点预览/);
    assert.match(result.text, /本地交接包：runtime-runs\//);
    const reply = JSON.parse(await readFile(result.replyPath, "utf8"));
    assert.match(reply.markdown, /本地交接包：runtime-runs\//);
    assert.match(reply.markdown, /先审阅 source pack/);
    const followUp = await handleEvent({
      schemaVersion: "im-event-v1",
      eventId: "evt-public-url-follow-up",
      eventType: "im.message.receive_v1",
      occurredAt: new Date().toISOString(),
      message: {
        messageId: "om-public-url-follow-up",
        chatId: "oc-public-url-fixture",
        msgType: "text",
        text: "先审阅 source pack",
        attachments: [],
      },
    }, {
      outputRoot,
      runId: "feishu-public-url-follow-up",
      executionMode: "execute",
      publishMode: "dry-run",
      replyMode: "dry-run",
      progressReplyMode: "off",
      runtimeStoreMode: "off",
    });
    assert.equal(followUp.status, "completed");
    assert.match(followUp.text, /有界预览/);
    assert.match(followUp.text, /本地交接包：runtime-runs\//);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
