import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { XMLParser } from "fast-xml-parser";

import {
  DEFAULT_PUBLIC_URL_LIMITS,
  classifyPublicUrl,
  downloadPublicResource,
  fetchPublicResource,
  probePublicResource,
  sanitizeUrlForArtifact,
  validatePublicUrl,
} from "./public_url_security.mjs";

const MEDIA_EXTENSIONS = new Set([".aac", ".amr", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav", ".wma", ".avi", ".flv", ".mkv", ".mov", ".mp4", ".mpeg", ".webm", ".wmv"]);
const TRANSCRIPT_EXTENSIONS = new Set([".vtt", ".srt", ".txt", ".json", ".html", ".htm"]);
const YOUTUBE_LANG_ORDER = ["zh-Hans", "zh-CN", "zh-Hant", "zh-TW", "zh", "yue", "en"];

function nowIso() {
  return new Date().toISOString();
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function uniqueStrings(values, limit = 100) {
  return [...new Set((values ?? []).map((value) => String(value ?? "").trim()).filter(Boolean))].slice(0, limit);
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function decodeEntities(value) {
  return String(value ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)));
}

export function stripHtml(value) {
  return decodeEntities(String(value ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractTimestampedChapters(value) {
  const chapters = [];
  for (const rawLine of String(value ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s+(.{2,200})$/u);
    if (!match) continue;
    const startSec = Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    chapters.push({ title: match[4].trim(), startMs: startSec * 1000, origin: "official_show_notes" });
  }
  return chapters;
}

export function parseDurationSeconds(value) {
  if (Number.isFinite(Number(value))) return Math.max(0, Number(value));
  const text = String(value ?? "").trim();
  const iso = text.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (iso) return Number(iso[1] ?? 0) * 3600 + Number(iso[2] ?? 0) * 60 + Number(iso[3] ?? 0);
  const clock = text.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (clock) return Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  return null;
}

function timestampMs(value) {
  const text = String(value ?? "").trim().replace(",", ".");
  const match = text.match(/^(?:(\d+):)?(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;
  return (Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000 + Number(String(match[4] ?? "0").padEnd(3, "0"));
}

function cleanCueText(value) {
  return decodeEntities(String(value ?? "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function parseVttTranscript(value) {
  const blocks = String(value ?? "").replace(/^\uFEFF/, "").split(/\r?\n\r?\n+/);
  const segments = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0 || /^(WEBVTT|NOTE|STYLE|REGION)/i.test(lines[0])) continue;
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [startRaw, endPart] = lines[timingIndex].split("-->").map((item) => item.trim());
    const endRaw = endPart?.split(/\s+/)[0];
    const startMs = timestampMs(startRaw);
    const endMs = timestampMs(endRaw);
    const text = cleanCueText(lines.slice(timingIndex + 1).join(" "));
    if (startMs === null || endMs === null || !text) continue;
    if (segments.at(-1)?.text === text && segments.at(-1)?.endMs <= startMs + 1500) {
      segments.at(-1).endMs = Math.max(segments.at(-1).endMs, endMs);
      continue;
    }
    segments.push({ startMs, endMs, text });
  }
  return segments;
}

export function parseSrtTranscript(value) {
  return String(value ?? "").replace(/^\uFEFF/, "").split(/\r?\n\r?\n+/).flatMap((block) => {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) return [];
    const [startRaw, endRaw] = lines[timingIndex].split("-->").map((item) => item.trim());
    const startMs = timestampMs(startRaw);
    const endMs = timestampMs(endRaw);
    const text = cleanCueText(lines.slice(timingIndex + 1).join(" "));
    return startMs === null || endMs === null || !text ? [] : [{ startMs, endMs, text }];
  });
}

function findJsonSegments(value) {
  const candidates = [value?.segments, value?.events, value?.transcript, value?.items, value?.results, value?.body];
  return candidates.find(Array.isArray) ?? (Array.isArray(value) ? value : []);
}

function numericField(item, keys) {
  for (const key of keys) {
    const value = item?.[key];
    if (value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function jsonItemTimeMs(item, side) {
  const msKeys = side === "start"
    ? ["startMs", "startTimeMs", "start_time_ms", "tStartMs", "offsetMs", "offset_ms"]
    : ["endMs", "endTimeMs", "end_time_ms", "tEndMs"];
  const secondsKeys = side === "start"
    ? ["startSec", "start_time", "startTime", "start", "offset"]
    : ["endSec", "end_time", "endTime", "end"];
  const milliseconds = numericField(item, msKeys);
  if (milliseconds !== null) return milliseconds;
  const seconds = numericField(item, secondsKeys);
  if (seconds !== null) return seconds * 1000;
  for (const key of secondsKeys) {
    const parsed = timestampMs(item?.[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function jsonItemText(item) {
  if (Array.isArray(item?.segs)) return cleanCueText(item.segs.map((segment) => segment?.utf8 ?? segment?.text ?? "").join(""));
  return cleanCueText(item?.text ?? item?.body ?? item?.content ?? item?.value ?? "");
}

export function parseJsonTranscript(value) {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return []; }
  }
  return findJsonSegments(parsed).flatMap((item) => {
    const startMs = jsonItemTimeMs(item, "start");
    let endMs = jsonItemTimeMs(item, "end");
    const durationMs = numericField(item, ["durationMs", "duration_ms", "dDurationMs"]);
    const durationSec = numericField(item, ["durationSec", "duration"]);
    if (endMs === null && startMs !== null && durationMs !== null) endMs = startMs + durationMs;
    if (endMs === null && startMs !== null && durationSec !== null) endMs = startMs + durationSec * 1000;
    const text = jsonItemText(item);
    return startMs === null || endMs === null || endMs < startMs || !text ? [] : [{ startMs, endMs, text, speaker: item?.speaker ?? item?.speakerName ?? null }];
  });
}

export function parseTranscriptBody(body, contentType = "", sourceUrl = "") {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body ?? "");
  const type = String(contentType ?? "").toLowerCase();
  const extension = extname(new URL(sourceUrl || "https://example.invalid/transcript").pathname).toLowerCase();
  let segments = [];
  let format = "plain";
  if (type.includes("vtt") || extension === ".vtt" || /^WEBVTT/m.test(text)) {
    segments = parseVttTranscript(text);
    format = "vtt";
  } else if (type.includes("subrip") || extension === ".srt" || /\d\d:\d\d:\d\d[,.]\d+\s+-->/m.test(text)) {
    segments = parseSrtTranscript(text);
    format = "srt";
  } else if (type.includes("json") || extension === ".json") {
    segments = parseJsonTranscript(text);
    format = "json";
  }
  const plainText = format === "plain" ? (type.includes("html") || [".html", ".htm"].includes(extension) ? stripHtml(text) : text.trim()) : "";
  return {
    format,
    segments,
    plainText,
    hasTimestamps: segments.length > 0,
    quality: segments.length > 0 ? "official_timestamped" : plainText ? "official_without_timestamps" : "empty",
  };
}

function htmlAttributes(tag) {
  const attributes = {};
  for (const match of String(tag).matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attributes[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? "");
  return attributes;
}

function htmlMeta(html, key) {
  for (const tag of String(html).match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = htmlAttributes(tag);
    if (String(attributes.property ?? attributes.name ?? "").toLowerCase() === key.toLowerCase()) return attributes.content ?? "";
  }
  return "";
}

function absoluteHttpUrl(value, baseUrl) {
  try {
    const url = new URL(String(value ?? ""), baseUrl);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function alternateRssUrl(html, baseUrl) {
  for (const tag of String(html).match(/<link\b[^>]*>/gi) ?? []) {
    const attributes = htmlAttributes(tag);
    if (String(attributes.rel ?? "").toLowerCase().includes("alternate") && /(?:rss|atom|xml)/i.test(attributes.type ?? "")) {
      try { return new URL(attributes.href, baseUrl).toString(); } catch {}
    }
  }
  return null;
}

function jsonLdObjects(html) {
  const values = [];
  for (const match of String(html).matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(decodeEntities(match[1]));
      values.push(...asArray(parsed?.["@graph"] ?? parsed));
    } catch {}
  }
  return values;
}

export function parseXiaoyuzhouPage(html, pageUrl) {
  const match = String(html).match(/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  let episode = null;
  try { episode = match ? JSON.parse(match[1])?.props?.pageProps?.episode ?? null : null; } catch {}
  const enclosure = absoluteHttpUrl(episode?.enclosure?.url ?? htmlMeta(html, "og:audio") ?? null, pageUrl);
  const podcast = episode?.podcast ?? {};
  const transcript = episode?.transcript ?? null;
  const showNotes = stripHtml(episode?.shownotes ?? episode?.description ?? "");
  const aiSummaryPermission = asArray(podcast.permissions).find((item) => item?.name === "AI_SUMMARIZE_EPISODE")?.status ?? null;
  return {
    source: {
      originalUrl: sanitizeUrlForArtifact(pageUrl),
      finalSourceUrl: sanitizeUrlForArtifact(pageUrl),
      platform: "xiaoyuzhou",
      title: episode?.title ?? htmlMeta(html, "og:title") ?? null,
      author: podcast.author ?? podcast.title ?? null,
      program: podcast.title ?? null,
      publishedAt: episode?.pubDate ?? null,
      durationSec: parseDurationSeconds(episode?.duration),
      language: episode?.language ?? podcast.language ?? "zh-CN",
      description: stripHtml(episode?.description ?? htmlMeta(html, "og:description") ?? ""),
      showNotes,
      chapters: extractTimestampedChapters(showNotes),
      acquisitionMethod: "xiaoyuzhou_public_page_metadata",
      processedAt: nowIso(),
      publicAccess: podcast.payType === "FREE" || podcast.payType === undefined,
      platformAiSummaryPermission: aiSummaryPermission,
    },
    mediaUrl: enclosure,
    embeddedTranscript: transcript?.segments || transcript?.text ? transcript : null,
    transcriptCandidate: transcript?.url ? {
      url: absoluteHttpUrl(transcript.url, pageUrl),
      type: transcript.type ?? transcript.contentType ?? null,
      language: transcript.language ?? episode?.language ?? podcast.language ?? "zh-CN",
      origin: "xiaoyuzhou_official_transcript",
    } : null,
    diagnostics: [
      ...(transcript && !transcript?.segments && !transcript?.text && !transcript?.url ? ["xiaoyuzhou_transcript_pointer_without_public_text"] : []),
      ...(aiSummaryPermission === "DENIED" ? ["xiaoyuzhou_platform_ai_summary_permission_denied_metadata_present"] : []),
    ],
  };
}

const rssParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
  processEntities: false,
  isArray: (_name, path) => /(?:\.item|\.transcript|\.enclosure)$/.test(path),
});

function textValue(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return value["#text"] ?? value.text ?? "";
  return "";
}

function comparableEpisodeUrls(value) {
  try {
    const exact = new URL(String(value));
    exact.hash = "";
    const canonical = new URL(exact);
    for (const key of [...canonical.searchParams.keys()]) {
      if (/^utm_/i.test(key) || /^(?:s|share|source|from|ref)$/i.test(key)) canonical.searchParams.delete(key);
    }
    canonical.pathname = canonical.pathname.replace(/\/+$/, "") || "/";
    return new Set([exact.toString(), canonical.toString()]);
  } catch {
    return new Set();
  }
}

function chooseRssItem(channel, feedUrl, episodeUrl) {
  const items = asArray(channel?.item);
  if (!episodeUrl) return items[0] ?? null;
  const targets = comparableEpisodeUrls(episodeUrl);
  return items.find((item) => {
    const links = [textValue(item?.link), textValue(item?.guid)]
      .map((value) => absoluteHttpUrl(value, feedUrl))
      .filter(Boolean)
      .flatMap((value) => [...comparableEpisodeUrls(value)]);
    return links.some((link) => targets.has(link));
  }) ?? null;
}

export function parseRssFeed(xml, feedUrl, options = {}) {
  let parsed;
  try { parsed = rssParser.parse(String(xml ?? "")); } catch (error) {
    return { status: "blocked", reason: "podcast_rss_parse_failed", error: error instanceof Error ? error.message : String(error) };
  }
  const channel = parsed?.rss?.channel ?? parsed?.channel;
  if (!channel) return { status: "blocked", reason: "podcast_rss_channel_missing" };
  const item = chooseRssItem(channel, feedUrl, options.episodeUrl);
  if (!item) return { status: "blocked", reason: options.episodeUrl ? "podcast_rss_episode_url_not_found" : "podcast_rss_episode_missing" };
  const enclosures = asArray(item.enclosure);
  const enclosure = enclosures.find((entry) => /^audio\//i.test(entry?.["@_type"] ?? "")) ?? enclosures[0] ?? null;
  const transcripts = asArray(item.transcript).map((entry) => ({
    url: absoluteHttpUrl(entry?.["@_url"] ?? entry?.url ?? null, feedUrl),
    type: entry?.["@_type"] ?? entry?.type ?? null,
    language: entry?.["@_language"] ?? entry?.language ?? textValue(channel.language) ?? null,
    rel: entry?.["@_rel"] ?? entry?.rel ?? null,
  })).filter((entry) => entry.url);
  return {
    status: "completed",
    source: {
      originalUrl: sanitizeUrlForArtifact(options.episodeUrl ?? feedUrl),
      finalSourceUrl: sanitizeUrlForArtifact(absoluteHttpUrl(textValue(item.link), feedUrl) || feedUrl),
      platform: "rss",
      title: textValue(item.title) || null,
      author: textValue(item.author) || textValue(item.creator) || textValue(channel.author) || textValue(channel.title) || null,
      program: textValue(channel.title) || null,
      publishedAt: textValue(item.pubDate) || textValue(item.published) || null,
      durationSec: parseDurationSeconds(textValue(item.duration)),
      language: textValue(item.language) || textValue(channel.language) || null,
      description: stripHtml(textValue(item.description) || textValue(item.encoded)),
      showNotes: stripHtml(textValue(item.encoded) || textValue(item.description)),
      acquisitionMethod: "podcast_rss",
      processedAt: nowIso(),
      publicAccess: true,
      feedUrl: sanitizeUrlForArtifact(feedUrl),
      episodeSelection: options.episodeUrl ? "matched_episode" : "latest_episode",
    },
    mediaUrl: absoluteHttpUrl(enclosure?.["@_url"] ?? enclosure?.url ?? null, feedUrl),
    mediaType: enclosure?.["@_type"] ?? enclosure?.type ?? null,
    mediaLength: Number(enclosure?.["@_length"] ?? enclosure?.length) || null,
    transcriptCandidates: transcripts,
  };
}

async function runCommand(bin, args, options = {}) {
  if (options.runner) return options.runner(bin, args, options);
  return await new Promise((resolveRun) => {
    const child = spawn(bin, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, Number(options.timeoutMs ?? 120_000));
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-12_000_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-200_000); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveRun({ exitCode: 127, stdout, stderr: error.message, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ exitCode: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

function selectedSubtitle(metadata, includeAuto = false) {
  const collections = [
    { entries: metadata?.subtitles ?? {}, origin: "official_subtitle" },
    ...(includeAuto ? [{ entries: metadata?.automatic_captions ?? {}, origin: "platform_auto_caption" }] : []),
  ];
  for (const collection of collections) {
    const languages = [...YOUTUBE_LANG_ORDER.filter((language) => collection.entries[language]), ...Object.keys(collection.entries).filter((language) => !YOUTUBE_LANG_ORDER.includes(language))];
    for (const language of languages) {
      const entries = asArray(collection.entries[language]);
      const entry = ["vtt", "srt", "json3"].map((format) => entries.find((item) => String(item?.ext ?? "").toLowerCase() === format && item?.url)).find(Boolean);
      if (entry) return { ...entry, language, origin: collection.origin };
    }
  }
  return null;
}

function selectedYoutubeAudioFormat(metadata, maxBytes) {
  return asArray(metadata?.formats)
    .filter((format) => format?.format_id && format?.acodec && format.acodec !== "none")
    .filter((format) => !format?.vcodec || format.vcodec === "none")
    .map((format) => ({ ...format, boundedSize: Number(format.filesize ?? format.filesize_approx) }))
    .filter((format) => Number.isFinite(format.boundedSize) && format.boundedSize > 0 && format.boundedSize <= maxBytes)
    .filter((format) => !/m3u8|dash/i.test(String(format.protocol ?? "")))
    .sort((left, right) => Number(right.abr ?? right.tbr ?? 0) - Number(left.abr ?? left.tbr ?? 0))[0] ?? null;
}

function youtubeMetadataView(metadata, url) {
  return {
    originalUrl: sanitizeUrlForArtifact(url),
    finalSourceUrl: sanitizeUrlForArtifact(metadata?.webpage_url ?? metadata?.original_url ?? url),
    platform: "youtube",
    title: metadata?.title ?? null,
    author: metadata?.uploader ?? metadata?.channel ?? null,
    program: metadata?.channel ?? null,
    publishedAt: metadata?.timestamp ? new Date(Number(metadata.timestamp) * 1000).toISOString() : metadata?.upload_date ?? null,
    durationSec: parseDurationSeconds(metadata?.duration),
    language: metadata?.language ?? null,
    description: String(metadata?.description ?? "").slice(0, 20_000),
    showNotes: String(metadata?.description ?? "").slice(0, 20_000),
    acquisitionMethod: "yt_dlp_public_metadata",
    processedAt: nowIso(),
    publicAccess: !["private", "premium_only", "subscriber_only", "needs_auth"].includes(String(metadata?.availability ?? "")),
  };
}

async function loadYoutubeMetadata(url, options) {
  if (options.youtubeMetadata) return { status: "completed", metadata: options.youtubeMetadata, tool: "fixture" };
  const bin = options.ytDlpBin ?? process.env.YT_DLP_BIN ?? "yt-dlp";
  const run = await runCommand(bin, [
    "--no-config", "--no-playlist", "--no-cookies", "--no-cookies-from-browser", "--no-cache-dir",
    "--no-write-comments", "--no-warnings", "--dump-single-json", "--skip-download", "--", url,
  ], { timeoutMs: options.ytDlpTimeoutMs ?? 180_000, runner: options.ytDlpRunner });
  if (run.exitCode !== 0) {
    return {
      status: "blocked",
      reason: run.exitCode === 127 ? "youtube_yt_dlp_unavailable" : run.timedOut ? "youtube_metadata_timeout" : "youtube_metadata_failed",
      recovery: run.exitCode === 127 ? "请安装 yt-dlp 或设置 YT_DLP_BIN 后重试；本能力不接受 Cookie。" : "请重试该公开 URL，或改为提供直接媒体/RSS URL。",
      stderrTail: String(run.stderr ?? "").slice(-1200),
    };
  }
  try { return { status: "completed", metadata: JSON.parse(run.stdout), tool: "yt-dlp" }; } catch {
    return { status: "blocked", reason: "youtube_metadata_invalid" };
  }
}

function sourceMediaExtension(url, contentType = "") {
  let extension = "";
  try { extension = extname(new URL(url).pathname).toLowerCase(); } catch {}
  if (MEDIA_EXTENSIONS.has(extension)) return extension;
  const type = String(contentType ?? "").toLowerCase();
  const byType = { "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/aac": ".aac", "audio/ogg": ".ogg", "audio/wav": ".wav", "video/mp4": ".mp4", "video/webm": ".webm" };
  return byType[type] ?? ".media";
}

async function probeDuration(path, options = {}) {
  if (options.probeMedia) return options.probeMedia(path, options);
  const run = await runCommand(options.ffprobeBin ?? process.env.FFPROBE_BIN ?? "ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path,
  ], { timeoutMs: options.ffprobeTimeoutMs ?? 60_000, runner: options.ffprobeRunner });
  if (run.exitCode !== 0) return { status: "blocked", reason: "public_media_probe_failed", stderrTail: String(run.stderr ?? "").slice(-800) };
  const durationSec = Number(String(run.stdout).trim());
  return Number.isFinite(durationSec) ? { status: "completed", durationSec } : { status: "blocked", reason: "public_media_duration_missing" };
}

async function downloadAndValidateMedia(mediaUrl, source, options = {}) {
  const inputDir = resolve(options.inputDir);
  const extension = sourceMediaExtension(mediaUrl, options.mediaType);
  const destination = join(inputDir, `source-media${extension}`);
  const downloader = options.downloadResource ?? downloadPublicResource;
  const downloaded = await downloader(mediaUrl, destination, {
    maxBytes: options.maxMediaBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxMediaBytes,
    maxRedirects: options.maxRedirects,
    timeoutMs: options.mediaTimeoutMs ?? 120_000,
    lookupFn: options.lookupFn,
  });
  if (downloaded.status !== "completed") return downloaded;
  const probe = await probeDuration(downloaded.path, options);
  if (probe.status !== "completed") return probe;
  const maxDurationSec = Number(options.maxDurationSec ?? DEFAULT_PUBLIC_URL_LIMITS.maxDurationSec);
  if (probe.durationSec > maxDurationSec) return { status: "blocked", reason: "public_media_duration_limit_exceeded", durationSec: probe.durationSec, maxDurationSec };
  return {
    status: "downloaded",
    localPath: downloaded.path,
    sizeBytes: downloaded.sizeBytes,
    sha256: downloaded.sha256,
    durationSec: probe.durationSec,
    contentType: downloaded.contentType ?? options.mediaType ?? null,
    sourceUrl: sanitizeUrlForArtifact(mediaUrl),
  };
}

async function resolveTranscriptCandidate(candidate, options = {}) {
  if (!candidate?.url) return null;
  const fetcher = options.fetchResource ?? fetchPublicResource;
  const fetched = await fetcher(candidate.url, {
    maxBytes: options.maxTranscriptBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxTranscriptBytes,
    timeoutMs: options.timeoutMs,
    maxRedirects: options.maxRedirects,
    lookupFn: options.lookupFn,
  });
  if (fetched.status !== "completed") return { status: "blocked", reason: fetched.reason, candidate: { type: candidate.type, language: candidate.language } };
  const parsed = parseTranscriptBody(fetched.body, candidate.type ?? fetched.contentType, candidate.url);
  return {
    status: parsed.hasTimestamps ? "completed" : parsed.plainText ? "supplementary_only" : "blocked",
    origin: candidate.origin ?? "official_transcript",
    language: candidate.language ?? null,
    sourceUrl: sanitizeUrlForArtifact(candidate.url),
    contentType: candidate.type ?? fetched.contentType ?? null,
    ...parsed,
  };
}

async function resolveYoutube(url, options = {}) {
  const validated = await validatePublicUrl(url, { lookupFn: options.lookupFn });
  if (validated.status !== "ready") return validated;
  const loaded = await loadYoutubeMetadata(url, options);
  if (loaded.status !== "completed") return loaded;
  const source = youtubeMetadataView(loaded.metadata, url);
  const maxDurationSec = Number(options.maxDurationSec ?? DEFAULT_PUBLIC_URL_LIMITS.maxDurationSec);
  if (!source.publicAccess) return { status: "blocked", reason: "youtube_access_restricted", source };
  if (source.durationSec && source.durationSec > maxDurationSec) return { status: "blocked", reason: "public_media_duration_limit_exceeded", source, maxDurationSec };
  if (loaded.metadata?.is_live) return { status: "blocked", reason: "youtube_live_stream_not_supported", source };
  const subtitle = selectedSubtitle(loaded.metadata, options.allowYoutubeAutoCaptions === true);
  if (subtitle) {
    const transcript = await resolveTranscriptCandidate({ ...subtitle, type: subtitle.ext === "json3" ? "application/json" : `text/${subtitle.ext}` }, options);
    if (transcript?.status === "completed") {
      return { status: "resolved", source: { ...source, acquisitionMethod: subtitle.origin }, transcript, media: { status: "not_required" }, diagnostics: [] };
    }
  }
  if (options.resolveOnly) {
    return { status: "resolved", source, transcript: null, media: { status: "available_not_downloaded" }, fallback: { required: true, method: "cloud_asr" }, diagnostics: ["youtube_official_subtitle_unavailable"] };
  }
  if (options.youtubeDownload) {
    const media = await options.youtubeDownload(url, source, options);
    return media.status === "downloaded"
      ? { status: "resolved", source, transcript: null, media, fallback: { required: true, method: "cloud_asr" }, diagnostics: ["youtube_official_subtitle_unavailable"] }
      : { status: "blocked", reason: media.reason ?? "youtube_media_download_failed", source, media };
  }
  const bin = options.ytDlpBin ?? process.env.YT_DLP_BIN ?? "yt-dlp";
  const inputDir = resolve(options.inputDir);
  const outputTemplate = join(inputDir, "source-media.%(ext)s");
  const maxMediaBytes = Number(options.maxMediaBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxMediaBytes);
  const selectedFormat = selectedYoutubeAudioFormat(loaded.metadata, maxMediaBytes);
  if (!selectedFormat) {
    return {
      status: "blocked",
      reason: "youtube_media_size_unknown_or_exceeded",
      source,
      recovery: "请使用有官方字幕的内容、受限大小的直接公开音频 URL，或音频格式能够报告大小且未超过上限的 YouTube 内容。",
    };
  }
  const run = await runCommand(bin, [
    "--no-config", "--no-playlist", "--no-cookies", "--no-cookies-from-browser", "--no-cache-dir", "--no-write-comments", "--no-warnings",
    "--format", String(selectedFormat.format_id), "--max-filesize", String(maxMediaBytes),
    "--match-filter", `duration <= ${maxDurationSec}`, "--output", outputTemplate, "--print", "after_move:filepath", "--", url,
  ], { timeoutMs: options.ytDlpDownloadTimeoutMs ?? 1_800_000, runner: options.ytDlpRunner });
  if (run.exitCode !== 0) {
    return { status: "blocked", reason: run.exitCode === 127 ? "youtube_yt_dlp_unavailable" : run.timedOut ? "youtube_media_download_timeout" : "youtube_media_download_failed", source, recovery: "请安装/升级 yt-dlp，或提供直接公开音频 URL；不支持认证 Cookie。", stderrTail: String(run.stderr ?? "").slice(-1200) };
  }
  const printed = String(run.stdout ?? "").trim().split(/\r?\n/).filter(Boolean).at(-1);
  const candidates = [printed, ...readdirSync(inputDir).filter((name) => name.startsWith("source-media.")).map((name) => join(inputDir, name))].filter(Boolean);
  const path = candidates.map((candidate) => resolve(candidate)).find((candidate) => isInside(inputDir, candidate) && existsSync(candidate));
  if (!path) return { status: "blocked", reason: "youtube_media_output_missing", source };
  const sizeBytes = statSync(path).size;
  if (sizeBytes > Number(options.maxMediaBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxMediaBytes)) return { status: "blocked", reason: "public_url_size_limit_exceeded", source, sizeBytes };
  const probe = await probeDuration(path, options);
  if (probe.status !== "completed") return { status: "blocked", reason: probe.reason, source };
  return {
    status: "resolved",
    source,
    transcript: null,
    media: { status: "downloaded", localPath: path, sizeBytes, durationSec: probe.durationSec, sourceUrl: source.finalSourceUrl, contentType: null },
    fallback: { required: true, method: "cloud_asr" },
    diagnostics: ["youtube_official_subtitle_unavailable"],
  };
}

async function resolveRss(feedUrl, xml, options = {}) {
  const parsed = parseRssFeed(xml, feedUrl, { episodeUrl: options.episodeUrl });
  if (parsed.status !== "completed") return parsed;
  const maxDurationSec = Number(options.maxDurationSec ?? DEFAULT_PUBLIC_URL_LIMITS.maxDurationSec);
  const maxMediaBytes = Number(options.maxMediaBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxMediaBytes);
  if (parsed.source.durationSec && parsed.source.durationSec > maxDurationSec) return { status: "blocked", reason: "public_media_duration_limit_exceeded", source: parsed.source, maxDurationSec };
  const transcriptResults = [];
  for (const candidate of parsed.transcriptCandidates ?? []) {
    const transcript = await resolveTranscriptCandidate({ ...candidate, origin: "official_podcast_transcript" }, options);
    if (transcript) transcriptResults.push(transcript);
    if (transcript?.status === "completed") {
      return { status: "resolved", source: { ...parsed.source, acquisitionMethod: "official_podcast_transcript" }, transcript, media: { status: "not_required" }, diagnostics: [] };
    }
  }
  if (!parsed.mediaUrl) return { status: "blocked", reason: "podcast_media_enclosure_missing", source: parsed.source, transcriptDiagnostics: transcriptResults };
  if (parsed.mediaLength && parsed.mediaLength > maxMediaBytes) return { status: "blocked", reason: "public_url_size_limit_exceeded", source: parsed.source, contentLength: parsed.mediaLength, maxBytes: maxMediaBytes };
  if (options.resolveOnly) {
    const probe = await (options.probeResource ?? probePublicResource)(parsed.mediaUrl, { maxBytes: options.maxMediaBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxMediaBytes, timeoutMs: options.timeoutMs, lookupFn: options.lookupFn });
    if (probe.status !== "ready") return { status: "blocked", reason: probe.reason, source: parsed.source, media: probe };
    return { status: "resolved", source: parsed.source, transcript: null, supplementaryTranscript: transcriptResults.find((item) => item.status === "supplementary_only") ?? null, media: { status: "available_not_downloaded", sizeBytes: probe.contentLength, contentType: probe.contentType, sourceUrl: sanitizeUrlForArtifact(parsed.mediaUrl) }, fallback: { required: true, method: "cloud_asr" }, diagnostics: ["official_timestamped_transcript_unavailable"] };
  }
  const media = await downloadAndValidateMedia(parsed.mediaUrl, parsed.source, { ...options, mediaType: parsed.mediaType });
  return media.status === "downloaded"
    ? { status: "resolved", source: parsed.source, transcript: null, supplementaryTranscript: transcriptResults.find((item) => item.status === "supplementary_only") ?? null, media, fallback: { required: true, method: "cloud_asr" }, diagnostics: ["official_timestamped_transcript_unavailable"] }
    : { status: "blocked", reason: media.reason ?? "podcast_media_download_failed", source: parsed.source, media };
}

async function resolveXiaoyuzhou(url, options = {}) {
  const fetcher = options.fetchResource ?? fetchPublicResource;
  const fetched = await fetcher(url, { maxBytes: options.maxPageBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxPageBytes, timeoutMs: options.timeoutMs, maxRedirects: options.maxRedirects, lookupFn: options.lookupFn, accept: "text/html,application/xhtml+xml" });
  if (fetched.status !== "completed") return fetched;
  const parsed = parseXiaoyuzhouPage(fetched.body.toString("utf8"), fetched.finalUrl ?? url);
  parsed.source.originalUrl = sanitizeUrlForArtifact(url);
  if (!parsed.source.publicAccess) return { status: "blocked", reason: "xiaoyuzhou_paid_episode_blocked", source: parsed.source };
  const maxDurationSec = Number(options.maxDurationSec ?? DEFAULT_PUBLIC_URL_LIMITS.maxDurationSec);
  if (parsed.source.durationSec && parsed.source.durationSec > maxDurationSec) return { status: "blocked", reason: "public_media_duration_limit_exceeded", source: parsed.source, maxDurationSec };
  if (parsed.embeddedTranscript) {
    const transcriptParsed = parseJsonTranscript(parsed.embeddedTranscript);
    if (transcriptParsed.length > 0) {
      return { status: "resolved", source: { ...parsed.source, acquisitionMethod: "xiaoyuzhou_official_transcript" }, transcript: { status: "completed", origin: "xiaoyuzhou_official_transcript", language: parsed.source.language, format: "json", segments: transcriptParsed, hasTimestamps: true, quality: "official_timestamped" }, media: { status: "not_required" }, diagnostics: parsed.diagnostics };
    }
  }
  let supplementaryTranscript = null;
  if (parsed.transcriptCandidate?.url) {
    const transcript = await resolveTranscriptCandidate(parsed.transcriptCandidate, options);
    if (transcript?.status === "completed") {
      return { status: "resolved", source: { ...parsed.source, acquisitionMethod: "xiaoyuzhou_official_transcript" }, transcript, media: { status: "not_required" }, diagnostics: parsed.diagnostics };
    }
    if (transcript?.status === "supplementary_only") supplementaryTranscript = transcript;
    if (transcript?.status === "blocked") parsed.diagnostics.push(`xiaoyuzhou_transcript_fetch_${transcript.reason ?? "failed"}`);
  }
  if (!parsed.mediaUrl) return { status: "blocked", reason: "xiaoyuzhou_public_media_missing", source: parsed.source, diagnostics: parsed.diagnostics };
  if (options.resolveOnly) {
    const probe = await (options.probeResource ?? probePublicResource)(parsed.mediaUrl, { maxBytes: options.maxMediaBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxMediaBytes, timeoutMs: options.timeoutMs, lookupFn: options.lookupFn });
    if (probe.status !== "ready") return { status: "blocked", reason: probe.reason, source: parsed.source, media: probe, diagnostics: parsed.diagnostics };
    return { status: "resolved", source: parsed.source, transcript: null, supplementaryTranscript, media: { status: "available_not_downloaded", sizeBytes: probe.contentLength, contentType: probe.contentType, sourceUrl: sanitizeUrlForArtifact(parsed.mediaUrl) }, fallback: { required: true, method: "cloud_asr" }, diagnostics: [...parsed.diagnostics, "official_timestamped_transcript_unavailable"] };
  }
  const media = await downloadAndValidateMedia(parsed.mediaUrl, parsed.source, options);
  return media.status === "downloaded"
    ? { status: "resolved", source: parsed.source, transcript: null, supplementaryTranscript, media, fallback: { required: true, method: "cloud_asr" }, diagnostics: [...parsed.diagnostics, "official_timestamped_transcript_unavailable"] }
    : { status: "blocked", reason: media.reason ?? "xiaoyuzhou_media_download_failed", source: parsed.source, media, diagnostics: parsed.diagnostics };
}

function parseGenericHtml(html, pageUrl) {
  const objects = jsonLdObjects(html);
  const audioObject = objects.find((item) => /AudioObject|PodcastEpisode|VideoObject/i.test(String(item?.["@type"] ?? ""))) ?? {};
  const mediaUrl = absoluteHttpUrl(audioObject.contentUrl ?? audioObject.associatedMedia?.contentUrl ?? htmlMeta(html, "og:audio") ?? htmlMeta(html, "og:video") ?? null, pageUrl);
  const transcriptCandidates = (String(html).match(/<track\b[^>]*>/gi) ?? []).flatMap((tag) => {
    const attributes = htmlAttributes(tag);
    if (!/^(?:captions|subtitles)$/i.test(attributes.kind ?? "") || !attributes.src) return [];
    const transcriptUrl = absoluteHttpUrl(attributes.src, pageUrl);
    return transcriptUrl ? [{ url: transcriptUrl, type: attributes.type ?? null, language: attributes.srclang ?? null, origin: "official_web_transcript" }] : [];
  });
  const structuredTranscript = audioObject.transcript ?? audioObject.caption ?? null;
  if (structuredTranscript && typeof structuredTranscript === "object") {
    const transcriptUrl = absoluteHttpUrl(structuredTranscript.url ?? structuredTranscript.contentUrl, pageUrl);
    if (transcriptUrl) transcriptCandidates.push({ url: transcriptUrl, type: structuredTranscript.encodingFormat ?? null, language: structuredTranscript.inLanguage ?? null, origin: "official_web_transcript" });
  }
  return {
    source: {
      originalUrl: sanitizeUrlForArtifact(pageUrl), finalSourceUrl: sanitizeUrlForArtifact(pageUrl), platform: "web",
      title: audioObject.name ?? htmlMeta(html, "og:title") ?? null,
      author: audioObject.author?.name ?? audioObject.creator?.name ?? htmlMeta(html, "author") ?? null,
      program: audioObject.partOfSeries?.name ?? null,
      publishedAt: audioObject.datePublished ?? null,
      durationSec: parseDurationSeconds(audioObject.duration),
      language: audioObject.inLanguage ?? htmlMeta(html, "og:locale") ?? null,
      description: stripHtml(audioObject.description ?? htmlMeta(html, "og:description") ?? ""),
      showNotes: stripHtml(audioObject.description ?? htmlMeta(html, "og:description") ?? ""),
      acquisitionMethod: "public_web_metadata", processedAt: nowIso(), publicAccess: true,
    },
    mediaUrl,
    rssUrl: alternateRssUrl(html, pageUrl),
    transcriptCandidates,
  };
}

function isMediaContentType(value) {
  return /^(?:audio|video)\//i.test(String(value ?? ""));
}

function directSource(url, finalUrl = url) {
  return {
    originalUrl: sanitizeUrlForArtifact(url),
    finalSourceUrl: sanitizeUrlForArtifact(finalUrl),
    platform: "direct",
    title: basename(new URL(finalUrl).pathname) || "public-media",
    author: null,
    program: null,
    publishedAt: null,
    durationSec: null,
    language: null,
    description: "",
    showNotes: "",
    acquisitionMethod: "direct_public_media",
    processedAt: nowIso(),
    publicAccess: true,
  };
}

async function resolveDirectMedia(url, options = {}, existingProbe = null) {
  if (options.resolveOnly) {
    const probe = existingProbe ?? await (options.probeResource ?? probePublicResource)(url, { maxBytes: options.maxMediaBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxMediaBytes, timeoutMs: options.timeoutMs, lookupFn: options.lookupFn });
    if (probe.status !== "ready") return probe;
    const source = directSource(url, probe.finalUrl ?? url);
    return {
      status: "resolved",
      source,
      transcript: null,
      media: { status: "available_not_downloaded", sizeBytes: probe.contentLength, contentType: probe.contentType, sourceUrl: probe.finalUrl ?? source.finalSourceUrl },
      fallback: { required: true, method: "cloud_asr" },
      diagnostics: [],
    };
  }
  const source = directSource(url);
  const media = await downloadAndValidateMedia(url, source, options);
  return media.status === "downloaded"
    ? { status: "resolved", source: { ...source, finalSourceUrl: media.sourceUrl ?? source.finalSourceUrl, durationSec: media.durationSec }, transcript: null, media, fallback: { required: true, method: "cloud_asr" }, diagnostics: [] }
    : { status: "blocked", reason: media.reason, source, media };
}

async function resolveDirectOrWeb(url, options = {}) {
  const classification = classifyPublicUrl(url);
  if (classification.kind === "direct_media") return resolveDirectMedia(url, options);
  if (classification.platform === "web") {
    const probe = await (options.probeResource ?? probePublicResource)(url, { maxBytes: options.maxMediaBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxMediaBytes, timeoutMs: options.timeoutMs, lookupFn: options.lookupFn });
    if (probe.status === "ready" && isMediaContentType(probe.contentType)) return resolveDirectMedia(url, options, probe);
    if (probe.reason === "public_url_size_limit_exceeded") return probe;
  }
  const fetcher = options.fetchResource ?? fetchPublicResource;
  const fetched = await fetcher(url, { maxBytes: options.maxPageBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxPageBytes, timeoutMs: options.timeoutMs, maxRedirects: options.maxRedirects, lookupFn: options.lookupFn, accept: "text/html,application/rss+xml,application/xml,text/xml" });
  if (fetched.status !== "completed") return fetched;
  const text = fetched.body.toString("utf8");
  if (/rss|xml/.test(fetched.contentType) || /^\s*<rss\b/i.test(text)) return resolveRss(fetched.finalUrl ?? url, text, options);
  const parsed = parseGenericHtml(text, fetched.finalUrl ?? url);
  parsed.source.originalUrl = sanitizeUrlForArtifact(url);
  if (parsed.rssUrl) {
    const rssFetched = await fetcher(parsed.rssUrl, { maxBytes: options.maxPageBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxPageBytes, timeoutMs: options.timeoutMs, lookupFn: options.lookupFn });
    if (rssFetched.status === "completed") return resolveRss(rssFetched.finalUrl ?? parsed.rssUrl, rssFetched.body.toString("utf8"), { ...options, episodeUrl: fetched.finalUrl ?? url });
  }
  const transcriptResults = [];
  for (const candidate of parsed.transcriptCandidates ?? []) {
    const transcript = await resolveTranscriptCandidate(candidate, options);
    if (transcript) transcriptResults.push(transcript);
    if (transcript?.status === "completed") {
      return { status: "resolved", source: { ...parsed.source, acquisitionMethod: "official_web_transcript" }, transcript, media: { status: "not_required" }, diagnostics: [] };
    }
  }
  if (!parsed.mediaUrl) return { status: "blocked", reason: "public_url_supported_media_not_found", source: parsed.source, recovery: "请提供直接公开音视频 URL、播客 RSS、小宇宙单集或受支持的 YouTube URL。" };
  if (options.resolveOnly) {
    const probe = await (options.probeResource ?? probePublicResource)(parsed.mediaUrl, { maxBytes: options.maxMediaBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxMediaBytes, timeoutMs: options.timeoutMs, lookupFn: options.lookupFn });
    if (probe.status !== "ready") return { status: "blocked", reason: probe.reason, source: parsed.source, media: probe };
    return { status: "resolved", source: parsed.source, transcript: null, supplementaryTranscript: transcriptResults.find((item) => item.status === "supplementary_only") ?? null, media: { status: "available_not_downloaded", sizeBytes: probe.contentLength, contentType: probe.contentType, sourceUrl: sanitizeUrlForArtifact(parsed.mediaUrl) }, fallback: { required: true, method: "cloud_asr" }, diagnostics: ["official_timestamped_transcript_unavailable"] };
  }
  const media = await downloadAndValidateMedia(parsed.mediaUrl, parsed.source, options);
  return media.status === "downloaded" ? { status: "resolved", source: parsed.source, transcript: null, supplementaryTranscript: transcriptResults.find((item) => item.status === "supplementary_only") ?? null, media, fallback: { required: true, method: "cloud_asr" }, diagnostics: ["official_timestamped_transcript_unavailable"] } : { status: "blocked", reason: media.reason, source: parsed.source, media };
}

export async function resolvePublicMediaSource(url, options = {}) {
  const classification = classifyPublicUrl(url);
  if (classification.kind === "invalid") return { status: "blocked", reason: "public_url_invalid" };
  const validated = await validatePublicUrl(url, { lookupFn: options.lookupFn });
  if (validated.status !== "ready") return validated;
  const merged = {
    ...DEFAULT_PUBLIC_URL_LIMITS,
    ...options,
    inputDir: options.inputDir ? resolve(options.inputDir) : null,
  };
  if (!merged.resolveOnly && !merged.inputDir) return { status: "blocked", reason: "public_url_input_dir_required" };
  if (classification.platform === "youtube") return resolveYoutube(url, merged);
  if (classification.platform === "xiaoyuzhou") return resolveXiaoyuzhou(url, merged);
  return resolveDirectOrWeb(url, merged);
}

export function resolutionArtifactView(result) {
  return {
    schemaVersion: "public-url-source-resolution-v1",
    status: result?.status ?? "blocked",
    reason: result?.reason ?? null,
    source: result?.source ?? null,
    transcript: result?.transcript ? {
      status: result.transcript.status,
      origin: result.transcript.origin,
      language: result.transcript.language,
      format: result.transcript.format,
      hasTimestamps: result.transcript.hasTimestamps,
      quality: result.transcript.quality,
      segmentCount: result.transcript.segments?.length ?? 0,
      sourceUrl: result.transcript.sourceUrl ?? null,
    } : null,
    supplementaryTranscript: result?.supplementaryTranscript ? {
      status: result.supplementaryTranscript.status,
      origin: result.supplementaryTranscript.origin,
      language: result.supplementaryTranscript.language,
      format: result.supplementaryTranscript.format,
      hasTimestamps: false,
      sourceUrl: result.supplementaryTranscript.sourceUrl ?? null,
    } : null,
    media: result?.media ? {
      status: result.media.status,
      localPath: result.media.localPath ?? null,
      sizeBytes: result.media.sizeBytes ?? null,
      durationSec: result.media.durationSec ?? null,
      contentType: result.media.contentType ?? null,
      sourceUrl: result.media.sourceUrl ?? null,
      sha256: result.media.sha256 ?? null,
    } : null,
    fallback: result?.fallback ?? null,
    diagnostics: uniqueStrings(result?.diagnostics ?? [], 30),
    recovery: result?.recovery ?? null,
    rawSecretsReturned: false,
    cookiesUsed: false,
    accessControlBypassed: false,
  };
}
