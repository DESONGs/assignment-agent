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

/**
 * @typedef {{ startMs: number, endMs: number, text: string, speaker?: unknown }} TranscriptSegment
 * @typedef {{ title: string, startMs: number, origin: string }} TimestampedChapter
 * @typedef {import("node:dns").LookupAddress} LookupAddress
 * @typedef {{ exitCode: number, stdout: string, stderr: string, timedOut: boolean }} CommandResult
 * @typedef {{ runner?: ((bin: string, args: string[], options: CommandOptions) => Promise<CommandResult> | CommandResult) | undefined, cwd?: string | undefined, env?: NodeJS.ProcessEnv | undefined, timeoutMs?: number | undefined }} CommandOptions
 * @typedef {{ url: string, type?: unknown, language?: unknown, origin?: unknown, ext?: unknown, [key: string]: unknown }} TranscriptCandidate
 * @typedef {{
 *   originalUrl: string, finalSourceUrl: string, platform: string, title: unknown, author: unknown,
 *   program: unknown, publishedAt: unknown, durationSec: number | null, language: unknown,
 *   description: string, showNotes: string, acquisitionMethod: string, processedAt: string,
 *   publicAccess: boolean, chapters?: TimestampedChapter[], [key: string]: unknown
 * }} PublicSource
 * @typedef {{
 *   resolveOnly?: boolean, inputDir?: string | null, episodeUrl?: string,
 *   maxRedirects?: number, maxPageBytes?: number, maxTranscriptBytes?: number,
 *   maxMediaBytes?: number, maxDurationSec?: number, timeoutMs?: number, mediaTimeoutMs?: number,
 *   mediaType?: unknown, lookupFn?: ((hostname: string, options: { all: true, verbatim: true }) => Promise<LookupAddress[] | LookupAddress>) | undefined,
 *   fetchResource?: (url: string, options: Record<string, unknown>) => Promise<unknown>,
 *   probeResource?: (url: string, options: Record<string, unknown>) => Promise<unknown>,
 *   downloadResource?: (url: string, destination: string, options: Record<string, unknown>) => Promise<unknown>,
 *   probeMedia?: (path: string, options: ResolverOptions) => Promise<unknown>,
 *   youtubeDownload?: (url: string, source: PublicSource, options: ResolverOptions) => Promise<unknown>,
 *   youtubeMetadata?: unknown, ytDlpBin?: string, ytDlpTimeoutMs?: number, ytDlpDownloadTimeoutMs?: number,
 *   ytDlpRunner?: CommandOptions["runner"], allowYoutubeAutoCaptions?: boolean,
 *   ffprobeBin?: string, ffprobeTimeoutMs?: number, ffprobeRunner?: CommandOptions["runner"],
 *   [key: string]: unknown
 * }} ResolverOptions
 */

/** @param {unknown} value @returns {Record<string, unknown>} */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

function nowIso() {
  return new Date().toISOString();
}

/** @param {unknown} value @returns {unknown[]} */
function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** @param {unknown} values @param {number} [limit] @returns {string[]} */
function uniqueStrings(values, limit = 100) {
  const source = Array.isArray(values) ? values : [];
  return [...new Set(source.map((value) => String(value ?? "").trim()).filter(Boolean))].slice(0, limit);
}

/** @param {string} parent @param {string} child */
function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** @param {unknown} value */
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

/** @param {unknown} value */
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

/** @param {unknown} value @returns {TimestampedChapter[]} */
export function extractTimestampedChapters(value) {
  /** @type {TimestampedChapter[]} */
  const chapters = [];
  for (const rawLine of String(value ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s+(.{2,200})$/u);
    if (!match) continue;
    const startSec = Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    const title = match[4]?.trim();
    if (title) chapters.push({ title, startMs: startSec * 1000, origin: "official_show_notes" });
  }
  return chapters;
}

/** @param {unknown} value */
export function parseDurationSeconds(value) {
  if (Number.isFinite(Number(value))) return Math.max(0, Number(value));
  const text = String(value ?? "").trim();
  const iso = text.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (iso) return Number(iso[1] ?? 0) * 3600 + Number(iso[2] ?? 0) * 60 + Number(iso[3] ?? 0);
  const clock = text.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (clock) return Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  return null;
}

/** @param {unknown} value */
function timestampMs(value) {
  const text = String(value ?? "").trim().replace(",", ".");
  const match = text.match(/^(?:(\d+):)?(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;
  return (Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000 + Number(String(match[4] ?? "0").padEnd(3, "0"));
}

/** @param {unknown} value */
function cleanCueText(value) {
  return decodeEntities(String(value ?? "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** @param {unknown} value @returns {TranscriptSegment[]} */
export function parseVttTranscript(value) {
  const blocks = String(value ?? "").replace(/^\uFEFF/, "").split(/\r?\n\r?\n+/);
  /** @type {TranscriptSegment[]} */
  const segments = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0 || /^(WEBVTT|NOTE|STYLE|REGION)/i.test(lines[0] ?? "")) continue;
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [startRaw, endPart] = (lines[timingIndex] ?? "").split("-->").map((item) => item.trim());
    const endRaw = endPart?.split(/\s+/)[0];
    const startMs = timestampMs(startRaw);
    const endMs = timestampMs(endRaw);
    const text = cleanCueText(lines.slice(timingIndex + 1).join(" "));
    if (startMs === null || endMs === null || !text) continue;
    const previous = segments.at(-1);
    if (previous?.text === text && previous.endMs <= startMs + 1500) {
      previous.endMs = Math.max(previous.endMs, endMs);
      continue;
    }
    segments.push({ startMs, endMs, text });
  }
  return segments;
}

/** @param {unknown} value @returns {TranscriptSegment[]} */
export function parseSrtTranscript(value) {
  return String(value ?? "").replace(/^\uFEFF/, "").split(/\r?\n\r?\n+/).flatMap((block) => {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) return [];
    const [startRaw, endRaw] = (lines[timingIndex] ?? "").split("-->").map((item) => item.trim());
    const startMs = timestampMs(startRaw);
    const endMs = timestampMs(endRaw);
    const text = cleanCueText(lines.slice(timingIndex + 1).join(" "));
    return startMs === null || endMs === null || !text ? [] : [{ startMs, endMs, text }];
  });
}

/** @param {unknown} value @returns {unknown[]} */
function findJsonSegments(value) {
  const record = asRecord(value);
  const candidates = [record.segments, record.events, record.transcript, record.items, record.results, record.body];
  return candidates.find(Array.isArray) ?? (Array.isArray(value) ? value : []);
}

/** @param {unknown} item @param {string[]} keys */
function numericField(item, keys) {
  const record = asRecord(item);
  for (const key of keys) {
    const value = record[key];
    if (value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

/** @param {unknown} item @param {"start" | "end"} side */
function jsonItemTimeMs(item, side) {
  const record = asRecord(item);
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
    const parsed = timestampMs(record[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

/** @param {unknown} item */
function jsonItemText(item) {
  const record = asRecord(item);
  if (Array.isArray(record.segs)) return cleanCueText(record.segs.map((segment) => {
    const entry = asRecord(segment);
    return entry.utf8 ?? entry.text ?? "";
  }).join(""));
  return cleanCueText(record.text ?? record.body ?? record.content ?? record.value ?? "");
}

/** @param {unknown} value @returns {TranscriptSegment[]} */
export function parseJsonTranscript(value) {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return []; }
  }
  return findJsonSegments(parsed).flatMap((item) => {
    const record = asRecord(item);
    const startMs = jsonItemTimeMs(item, "start");
    let endMs = jsonItemTimeMs(item, "end");
    const durationMs = numericField(item, ["durationMs", "duration_ms", "dDurationMs"]);
    const durationSec = numericField(item, ["durationSec", "duration"]);
    if (endMs === null && startMs !== null && durationMs !== null) endMs = startMs + durationMs;
    if (endMs === null && startMs !== null && durationSec !== null) endMs = startMs + durationSec * 1000;
    const text = jsonItemText(item);
    return startMs === null || endMs === null || endMs < startMs || !text ? [] : [{ startMs, endMs, text, speaker: record.speaker ?? record.speakerName ?? null }];
  });
}

/** @param {unknown} body @param {string} [contentType] @param {string} [sourceUrl] */
export function parseTranscriptBody(body, contentType = "", sourceUrl = "") {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body ?? "");
  const type = String(contentType ?? "").toLowerCase();
  const extension = extname(new URL(sourceUrl || "https://example.invalid/transcript").pathname).toLowerCase();
  /** @type {TranscriptSegment[]} */
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

/** @param {unknown} tag @returns {Record<string, string>} */
function htmlAttributes(tag) {
  /** @type {Record<string, string>} */
  const attributes = {};
  for (const match of String(tag).matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const key = match[1]?.toLowerCase();
    if (key) attributes[key] = decodeEntities(match[2] ?? match[3] ?? "");
  }
  return attributes;
}

/** @param {unknown} html @param {string} key */
function htmlMeta(html, key) {
  for (const tag of String(html).match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = htmlAttributes(tag);
    if (String(attributes.property ?? attributes.name ?? "").toLowerCase() === key.toLowerCase()) return attributes.content ?? "";
  }
  return "";
}

/** @param {unknown} value @param {string} baseUrl */
function absoluteHttpUrl(value, baseUrl) {
  try {
    const url = new URL(String(value ?? ""), baseUrl);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

/** @param {unknown} html @param {string} baseUrl */
function alternateRssUrl(html, baseUrl) {
  for (const tag of String(html).match(/<link\b[^>]*>/gi) ?? []) {
    const attributes = htmlAttributes(tag);
    if (String(attributes.rel ?? "").toLowerCase().includes("alternate") && /(?:rss|atom|xml)/i.test(attributes.type ?? "")) {
      try { return new URL(attributes.href ?? "", baseUrl).toString(); } catch {}
    }
  }
  return null;
}

/** @param {unknown} html @returns {Array<Record<string, unknown>>} */
function jsonLdObjects(html) {
  /** @type {Array<Record<string, unknown>>} */
  const values = [];
  for (const match of String(html).matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(decodeEntities(match[1]));
      const record = asRecord(parsed);
      values.push(...asArray(record["@graph"] ?? parsed).map(asRecord));
    } catch {}
  }
  return values;
}

/** @param {unknown} html @param {string} pageUrl */
export function parseXiaoyuzhouPage(html, pageUrl) {
  const match = String(html).match(/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  /** @type {Record<string, unknown>} */
  let episode = {};
  try {
    const nextData = match?.[1] ? asRecord(JSON.parse(match[1])) : {};
    episode = asRecord(asRecord(asRecord(nextData.props).pageProps).episode);
  } catch {}
  const enclosureRecord = asRecord(episode.enclosure);
  const enclosure = absoluteHttpUrl(enclosureRecord.url ?? htmlMeta(html, "og:audio") ?? null, pageUrl);
  const podcast = asRecord(episode.podcast);
  const transcript = asRecord(episode.transcript);
  const hasTranscript = Object.keys(transcript).length > 0;
  const showNotes = stripHtml(episode.shownotes ?? episode.description ?? "");
  const aiSummaryPermission = asRecord(asArray(podcast.permissions).find((item) => asRecord(item).name === "AI_SUMMARIZE_EPISODE")).status ?? null;
  const transcriptUrl = transcript.url ? absoluteHttpUrl(transcript.url, pageUrl) : null;
  return {
    source: {
      originalUrl: sanitizeUrlForArtifact(pageUrl),
      finalSourceUrl: sanitizeUrlForArtifact(pageUrl),
      platform: "xiaoyuzhou",
      title: episode.title ?? htmlMeta(html, "og:title") ?? null,
      author: podcast.author ?? podcast.title ?? null,
      program: podcast.title ?? null,
      publishedAt: episode.pubDate ?? null,
      durationSec: parseDurationSeconds(episode.duration),
      language: episode.language ?? podcast.language ?? "zh-CN",
      description: stripHtml(episode.description ?? htmlMeta(html, "og:description") ?? ""),
      showNotes,
      chapters: extractTimestampedChapters(showNotes),
      acquisitionMethod: "xiaoyuzhou_public_page_metadata",
      processedAt: nowIso(),
      publicAccess: podcast.payType === "FREE" || podcast.payType === undefined,
      platformAiSummaryPermission: aiSummaryPermission,
    },
    mediaUrl: enclosure,
    embeddedTranscript: transcript.segments || transcript.text ? transcript : null,
    transcriptCandidate: transcriptUrl ? {
      url: transcriptUrl,
      type: transcript.type ?? transcript.contentType ?? null,
      language: transcript.language ?? episode.language ?? podcast.language ?? "zh-CN",
      origin: "xiaoyuzhou_official_transcript",
    } : null,
    diagnostics: [
      ...(hasTranscript && !transcript.segments && !transcript.text && !transcript.url ? ["xiaoyuzhou_transcript_pointer_without_public_text"] : []),
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
  isArray: (/** @type {string} */ _name, /** @type {unknown} */ path) => /(?:\.item|\.transcript|\.enclosure)$/.test(String(path)),
});

/** @param {unknown} value */
function textValue(value) {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  if (Object.keys(record).length > 0) return String(record["#text"] ?? record.text ?? "");
  return "";
}

/** @param {unknown} value @returns {Set<string>} */
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

/** @param {unknown} channel @param {string} feedUrl @param {unknown} episodeUrl */
function chooseRssItem(channel, feedUrl, episodeUrl) {
  const items = asArray(asRecord(channel).item).map(asRecord);
  if (!episodeUrl) return items[0] ?? null;
  const targets = comparableEpisodeUrls(episodeUrl);
  return items.find((item) => {
    const links = [textValue(item.link), textValue(item.guid)]
      .map((value) => absoluteHttpUrl(value, feedUrl))
      .filter(Boolean)
      .flatMap((value) => [...comparableEpisodeUrls(value)]);
    return links.some((link) => targets.has(link));
  }) ?? null;
}

/** @param {unknown} xml @param {string} feedUrl @param {{ episodeUrl?: string }} [options] */
export function parseRssFeed(xml, feedUrl, options = {}) {
  /** @type {Record<string, unknown>} */
  let parsed;
  try { parsed = rssParser.parse(String(xml ?? "")); } catch (error) {
    return { status: "blocked", reason: "podcast_rss_parse_failed", error: error instanceof Error ? error.message : String(error) };
  }
  const channel = asRecord(asRecord(parsed.rss).channel ?? parsed.channel);
  if (Object.keys(channel).length === 0) return { status: "blocked", reason: "podcast_rss_channel_missing" };
  const item = chooseRssItem(channel, feedUrl, options.episodeUrl);
  if (!item) return { status: "blocked", reason: options.episodeUrl ? "podcast_rss_episode_url_not_found" : "podcast_rss_episode_missing" };
  const enclosures = asArray(item.enclosure).map(asRecord);
  const enclosure = enclosures.find((entry) => /^audio\//i.test(String(entry["@_type"] ?? ""))) ?? enclosures[0] ?? null;
  const transcripts = asArray(item.transcript).map(asRecord).map((entry) => ({
    url: absoluteHttpUrl(entry["@_url"] ?? entry.url ?? null, feedUrl),
    type: entry["@_type"] ?? entry.type ?? null,
    language: entry["@_language"] ?? entry.language ?? textValue(channel.language) ?? null,
    rel: entry["@_rel"] ?? entry.rel ?? null,
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

/** @param {string} bin @param {string[]} args @param {CommandOptions} [options] @returns {Promise<CommandResult>} */
async function runCommand(bin, args, options = {}) {
  if (options.runner) return options.runner(bin, args, options);
  /** @type {Promise<CommandResult>} */
  const result = new Promise((resolveRun) => {
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
  return result;
}

/** @param {unknown} metadata @param {boolean} [includeAuto] @returns {TranscriptCandidate | null} */
function selectedSubtitle(metadata, includeAuto = false) {
  const normalized = asRecord(metadata);
  const collections = [
    { entries: asRecord(normalized.subtitles), origin: "official_subtitle" },
    ...(includeAuto ? [{ entries: asRecord(normalized.automatic_captions), origin: "platform_auto_caption" }] : []),
  ];
  for (const collection of collections) {
    const languages = [...YOUTUBE_LANG_ORDER.filter((language) => collection.entries[language]), ...Object.keys(collection.entries).filter((language) => !YOUTUBE_LANG_ORDER.includes(language))];
    for (const language of languages) {
      const entries = asArray(collection.entries[language]).map(asRecord);
      const entry = ["vtt", "srt", "json3"].map((format) => entries.find((item) => String(item.ext ?? "").toLowerCase() === format && item.url)).find((item) => item !== undefined);
      if (entry && typeof entry.url === "string") return { ...entry, url: entry.url, language, origin: collection.origin };
    }
  }
  return null;
}

/** @param {unknown} metadata @param {number} maxBytes @returns {Record<string, unknown> | null} */
function selectedYoutubeAudioFormat(metadata, maxBytes) {
  return asArray(asRecord(metadata).formats).map(asRecord)
    .filter((format) => format.format_id && format.acodec && format.acodec !== "none")
    .filter((format) => !format.vcodec || format.vcodec === "none")
    .map((format) => /** @type {Record<string, unknown> & { boundedSize: number }} */ ({ ...format, boundedSize: Number(format.filesize ?? format.filesize_approx) }))
    .filter((format) => Number.isFinite(format.boundedSize) && format.boundedSize > 0 && format.boundedSize <= maxBytes)
    .filter((format) => !/m3u8|dash/i.test(String(format["protocol"] ?? "")))
    .sort((left, right) => Number(right["abr"] ?? right["tbr"] ?? 0) - Number(left["abr"] ?? left["tbr"] ?? 0))[0] ?? null;
}

/** @param {unknown} metadata @param {string} url @returns {PublicSource} */
function youtubeMetadataView(metadata, url) {
  const record = asRecord(metadata);
  return {
    originalUrl: sanitizeUrlForArtifact(url),
    finalSourceUrl: sanitizeUrlForArtifact(record.webpage_url ?? record.original_url ?? url),
    platform: "youtube",
    title: record.title ?? null,
    author: record.uploader ?? record.channel ?? null,
    program: record.channel ?? null,
    publishedAt: record.timestamp ? new Date(Number(record.timestamp) * 1000).toISOString() : record.upload_date ?? null,
    durationSec: parseDurationSeconds(record.duration),
    language: record.language ?? null,
    description: String(record.description ?? "").slice(0, 20_000),
    showNotes: String(record.description ?? "").slice(0, 20_000),
    acquisitionMethod: "yt_dlp_public_metadata",
    processedAt: nowIso(),
    publicAccess: !["private", "premium_only", "subscriber_only", "needs_auth"].includes(String(record.availability ?? "")),
  };
}

/** @param {string} url @param {ResolverOptions} options */
async function loadYoutubeMetadata(url, options) {
  if (options.youtubeMetadata) return { status: "completed", metadata: asRecord(options.youtubeMetadata), tool: "fixture" };
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
  try { return { status: "completed", metadata: asRecord(JSON.parse(run.stdout)), tool: "yt-dlp" }; } catch {
    return { status: "blocked", reason: "youtube_metadata_invalid" };
  }
}

/** @param {string} url @param {unknown} [contentType] */
function sourceMediaExtension(url, contentType = "") {
  let extension = "";
  try { extension = extname(new URL(url).pathname).toLowerCase(); } catch {}
  if (MEDIA_EXTENSIONS.has(extension)) return extension;
  const type = String(contentType ?? "").toLowerCase();
  /** @type {Record<string, string>} */
  const byType = { "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/aac": ".aac", "audio/ogg": ".ogg", "audio/wav": ".wav", "video/mp4": ".mp4", "video/webm": ".webm" };
  return byType[type] ?? ".media";
}

/** @param {string} path @param {ResolverOptions} [options] */
async function probeDuration(path, options = {}) {
  if (options.probeMedia) return asRecord(await options.probeMedia(path, options));
  const run = await runCommand(options.ffprobeBin ?? process.env.FFPROBE_BIN ?? "ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path,
  ], { timeoutMs: options.ffprobeTimeoutMs ?? 60_000, runner: options.ffprobeRunner });
  if (run.exitCode !== 0) return { status: "blocked", reason: "public_media_probe_failed", stderrTail: String(run.stderr ?? "").slice(-800) };
  const durationSec = Number(String(run.stdout).trim());
  return Number.isFinite(durationSec) ? { status: "completed", durationSec } : { status: "blocked", reason: "public_media_duration_missing" };
}

/** @param {string} mediaUrl @param {PublicSource} source @param {ResolverOptions} [options] */
async function downloadAndValidateMedia(mediaUrl, source, options = {}) {
  if (!options.inputDir) return { status: "blocked", reason: "public_url_input_dir_required" };
  const inputDir = resolve(options.inputDir);
  const extension = sourceMediaExtension(mediaUrl, options.mediaType);
  const destination = join(inputDir, `source-media${extension}`);
  const downloader = options.downloadResource ?? downloadPublicResource;
  const downloaded = asRecord(await downloader(mediaUrl, destination, {
    maxBytes: options.maxMediaBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxMediaBytes,
    maxRedirects: options.maxRedirects,
    timeoutMs: options.mediaTimeoutMs ?? 120_000,
    lookupFn: options.lookupFn,
  }));
  if (downloaded.status !== "completed") return downloaded;
  if (typeof downloaded.path !== "string") return { status: "blocked", reason: "public_media_download_path_missing" };
  const probe = await probeDuration(downloaded.path, options);
  if (probe.status !== "completed") return probe;
  const maxDurationSec = Number(options.maxDurationSec ?? DEFAULT_PUBLIC_URL_LIMITS.maxDurationSec);
  const durationSec = Number(probe.durationSec);
  if (!Number.isFinite(durationSec)) return { status: "blocked", reason: "public_media_duration_missing" };
  if (durationSec > maxDurationSec) return { status: "blocked", reason: "public_media_duration_limit_exceeded", durationSec, maxDurationSec };
  return {
    status: "downloaded",
    localPath: downloaded.path,
    sizeBytes: downloaded.sizeBytes,
    sha256: downloaded.sha256,
    durationSec,
    contentType: downloaded.contentType ?? options.mediaType ?? null,
    sourceUrl: sanitizeUrlForArtifact(mediaUrl),
  };
}

/** @param {TranscriptCandidate | null | undefined} candidate @param {ResolverOptions} [options] */
async function resolveTranscriptCandidate(candidate, options = {}) {
  if (!candidate?.url) return null;
  const fetcher = options.fetchResource ?? fetchPublicResource;
  const fetched = asRecord(await fetcher(candidate.url, {
    maxBytes: options.maxTranscriptBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxTranscriptBytes,
    timeoutMs: options.timeoutMs,
    maxRedirects: options.maxRedirects,
    lookupFn: options.lookupFn,
  }));
  if (fetched.status !== "completed") return { status: "blocked", reason: fetched.reason, candidate: { type: candidate.type, language: candidate.language } };
  if (!Buffer.isBuffer(fetched.body)) return { status: "blocked", reason: "official_transcript_body_invalid", candidate: { type: candidate.type, language: candidate.language } };
  const parsed = parseTranscriptBody(fetched.body, String(candidate.type ?? fetched.contentType ?? ""), candidate.url);
  return {
    status: parsed.hasTimestamps ? "completed" : parsed.plainText ? "supplementary_only" : "blocked",
    origin: candidate.origin ?? "official_transcript",
    language: candidate.language ?? null,
    sourceUrl: sanitizeUrlForArtifact(candidate.url),
    contentType: candidate.type ?? fetched.contentType ?? null,
    ...parsed,
  };
}

/** @param {string} url @param {ResolverOptions} [options] */
async function resolveYoutube(url, options = {}) {
  const validated = await validatePublicUrl(url, { lookupFn: options.lookupFn });
  if (validated.status !== "ready") return validated;
  const loaded = await loadYoutubeMetadata(url, options);
  if (loaded.status !== "completed") return loaded;
  const metadata = asRecord(loaded.metadata);
  const source = youtubeMetadataView(metadata, url);
  const maxDurationSec = Number(options.maxDurationSec ?? DEFAULT_PUBLIC_URL_LIMITS.maxDurationSec);
  if (!source.publicAccess) return { status: "blocked", reason: "youtube_access_restricted", source };
  if (source.durationSec && source.durationSec > maxDurationSec) return { status: "blocked", reason: "public_media_duration_limit_exceeded", source, maxDurationSec };
  if (metadata.is_live) return { status: "blocked", reason: "youtube_live_stream_not_supported", source };
  const subtitle = selectedSubtitle(metadata, options.allowYoutubeAutoCaptions === true);
  if (subtitle) {
    const subtitleExtension = String(subtitle.ext ?? "vtt");
    const transcript = await resolveTranscriptCandidate({ ...subtitle, type: subtitleExtension === "json3" ? "application/json" : `text/${subtitleExtension}` }, options);
    if (transcript?.status === "completed") {
      return { status: "resolved", source: { ...source, acquisitionMethod: subtitle.origin }, transcript, media: { status: "not_required" }, diagnostics: [] };
    }
  }
  if (options.resolveOnly) {
    return { status: "resolved", source, transcript: null, media: { status: "available_not_downloaded" }, fallback: { required: true, method: "cloud_asr" }, diagnostics: ["youtube_official_subtitle_unavailable"] };
  }
  if (options.youtubeDownload) {
    const media = asRecord(await options.youtubeDownload(url, source, options));
    return media.status === "downloaded"
      ? { status: "resolved", source, transcript: null, media, fallback: { required: true, method: "cloud_asr" }, diagnostics: ["youtube_official_subtitle_unavailable"] }
      : { status: "blocked", reason: media.reason ?? "youtube_media_download_failed", source, media };
  }
  const bin = options.ytDlpBin ?? process.env.YT_DLP_BIN ?? "yt-dlp";
  if (!options.inputDir) return { status: "blocked", reason: "public_url_input_dir_required" };
  const inputDir = resolve(options.inputDir);
  const outputTemplate = join(inputDir, "source-media.%(ext)s");
  const maxMediaBytes = Number(options.maxMediaBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxMediaBytes);
  const selectedFormat = selectedYoutubeAudioFormat(metadata, maxMediaBytes);
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
    "--format", String(selectedFormat["format_id"]), "--max-filesize", String(maxMediaBytes),
    "--match-filter", `duration <= ${maxDurationSec}`, "--output", outputTemplate, "--print", "after_move:filepath", "--", url,
  ], { timeoutMs: options.ytDlpDownloadTimeoutMs ?? 1_800_000, runner: options.ytDlpRunner });
  if (run.exitCode !== 0) {
    return { status: "blocked", reason: run.exitCode === 127 ? "youtube_yt_dlp_unavailable" : run.timedOut ? "youtube_media_download_timeout" : "youtube_media_download_failed", source, recovery: "请安装/升级 yt-dlp，或提供直接公开音频 URL；不支持认证 Cookie。", stderrTail: String(run.stderr ?? "").slice(-1200) };
  }
  const printed = String(run.stdout ?? "").trim().split(/\r?\n/).filter(Boolean).at(-1);
  const candidates = [printed, ...readdirSync(inputDir).filter((name) => name.startsWith("source-media.")).map((name) => join(inputDir, name))].flatMap((candidate) => typeof candidate === "string" && candidate.length > 0 ? [candidate] : []);
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

/** @param {string} feedUrl @param {unknown} xml @param {ResolverOptions} [options] */
async function resolveRss(feedUrl, xml, options = {}) {
  const parsed = asRecord(parseRssFeed(xml, feedUrl, options.episodeUrl === undefined ? {} : { episodeUrl: options.episodeUrl }));
  if (parsed.status !== "completed") return parsed;
  const source = /** @type {PublicSource} */ (asRecord(parsed.source));
  const maxDurationSec = Number(options.maxDurationSec ?? DEFAULT_PUBLIC_URL_LIMITS.maxDurationSec);
  const maxMediaBytes = Number(options.maxMediaBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxMediaBytes);
  if (source.durationSec && source.durationSec > maxDurationSec) return { status: "blocked", reason: "public_media_duration_limit_exceeded", source, maxDurationSec };
  /** @type {Array<Record<string, unknown>>} */
  const transcriptResults = [];
  for (const value of asArray(parsed.transcriptCandidates)) {
    const candidate = asRecord(value);
    if (typeof candidate.url !== "string") continue;
    const transcript = await resolveTranscriptCandidate(/** @type {TranscriptCandidate} */ ({ ...candidate, url: candidate.url, origin: "official_podcast_transcript" }), options);
    if (transcript) transcriptResults.push(transcript);
    if (transcript?.status === "completed") {
      return { status: "resolved", source: { ...source, acquisitionMethod: "official_podcast_transcript" }, transcript, media: { status: "not_required" }, diagnostics: [] };
    }
  }
  const mediaUrl = typeof parsed.mediaUrl === "string" ? parsed.mediaUrl : null;
  const mediaLength = Number(parsed.mediaLength);
  if (!mediaUrl) return { status: "blocked", reason: "podcast_media_enclosure_missing", source, transcriptDiagnostics: transcriptResults };
  if (Number.isFinite(mediaLength) && mediaLength > maxMediaBytes) return { status: "blocked", reason: "public_url_size_limit_exceeded", source, contentLength: mediaLength, maxBytes: maxMediaBytes };
  if (options.resolveOnly) {
    const probe = asRecord(await (options.probeResource ?? probePublicResource)(mediaUrl, { maxBytes: options.maxMediaBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxMediaBytes, timeoutMs: options.timeoutMs, lookupFn: options.lookupFn }));
    if (probe.status !== "ready") return { status: "blocked", reason: probe.reason, source, media: probe };
    return { status: "resolved", source, transcript: null, supplementaryTranscript: transcriptResults.find((item) => item.status === "supplementary_only") ?? null, media: { status: "available_not_downloaded", sizeBytes: probe.contentLength, contentType: probe.contentType, sourceUrl: sanitizeUrlForArtifact(mediaUrl) }, fallback: { required: true, method: "cloud_asr" }, diagnostics: ["official_timestamped_transcript_unavailable"] };
  }
  const media = await downloadAndValidateMedia(mediaUrl, source, { ...options, mediaType: parsed.mediaType });
  return media.status === "downloaded"
    ? { status: "resolved", source, transcript: null, supplementaryTranscript: transcriptResults.find((item) => item.status === "supplementary_only") ?? null, media, fallback: { required: true, method: "cloud_asr" }, diagnostics: ["official_timestamped_transcript_unavailable"] }
    : { status: "blocked", reason: media.reason ?? "podcast_media_download_failed", source, media };
}

/** @param {string} url @param {ResolverOptions} [options] */
async function resolveXiaoyuzhou(url, options = {}) {
  const fetcher = options.fetchResource ?? fetchPublicResource;
  const fetched = asRecord(await fetcher(url, { maxBytes: options.maxPageBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxPageBytes, timeoutMs: options.timeoutMs, maxRedirects: options.maxRedirects, lookupFn: options.lookupFn, accept: "text/html,application/xhtml+xml" }));
  if (fetched.status !== "completed") return fetched;
  if (!Buffer.isBuffer(fetched.body)) return { status: "blocked", reason: "xiaoyuzhou_page_body_invalid" };
  const parsed = parseXiaoyuzhouPage(fetched.body.toString("utf8"), String(fetched.finalUrl ?? url));
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
  /** @type {Record<string, unknown> | null} */
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
    const probe = asRecord(await (options.probeResource ?? probePublicResource)(parsed.mediaUrl, { maxBytes: options.maxMediaBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxMediaBytes, timeoutMs: options.timeoutMs, lookupFn: options.lookupFn }));
    if (probe.status !== "ready") return { status: "blocked", reason: probe.reason, source: parsed.source, media: probe, diagnostics: parsed.diagnostics };
    return { status: "resolved", source: parsed.source, transcript: null, supplementaryTranscript, media: { status: "available_not_downloaded", sizeBytes: probe.contentLength, contentType: probe.contentType, sourceUrl: sanitizeUrlForArtifact(parsed.mediaUrl) }, fallback: { required: true, method: "cloud_asr" }, diagnostics: [...parsed.diagnostics, "official_timestamped_transcript_unavailable"] };
  }
  const media = await downloadAndValidateMedia(parsed.mediaUrl, parsed.source, options);
  return media.status === "downloaded"
    ? { status: "resolved", source: parsed.source, transcript: null, supplementaryTranscript, media, fallback: { required: true, method: "cloud_asr" }, diagnostics: [...parsed.diagnostics, "official_timestamped_transcript_unavailable"] }
    : { status: "blocked", reason: media.reason ?? "xiaoyuzhou_media_download_failed", source: parsed.source, media, diagnostics: parsed.diagnostics };
}

/** @param {unknown} html @param {string} pageUrl */
function parseGenericHtml(html, pageUrl) {
  const objects = jsonLdObjects(html);
  const audioObject = objects.find((item) => /AudioObject|PodcastEpisode|VideoObject/i.test(String(item?.["@type"] ?? ""))) ?? {};
  const associatedMedia = asRecord(audioObject.associatedMedia);
  const mediaUrl = absoluteHttpUrl(audioObject.contentUrl ?? associatedMedia.contentUrl ?? htmlMeta(html, "og:audio") ?? htmlMeta(html, "og:video") ?? null, pageUrl);
  /** @type {TranscriptCandidate[]} */
  const transcriptCandidates = (String(html).match(/<track\b[^>]*>/gi) ?? []).flatMap((tag) => {
    const attributes = htmlAttributes(tag);
    if (!/^(?:captions|subtitles)$/i.test(attributes.kind ?? "") || !attributes.src) return [];
    const transcriptUrl = absoluteHttpUrl(attributes.src, pageUrl);
    return transcriptUrl ? [{ url: transcriptUrl, type: attributes.type ?? null, language: attributes.srclang ?? null, origin: "official_web_transcript" }] : [];
  });
  const structuredTranscript = asRecord(audioObject.transcript ?? audioObject.caption);
  if (Object.keys(structuredTranscript).length > 0) {
    const transcriptUrl = absoluteHttpUrl(structuredTranscript.url ?? structuredTranscript.contentUrl, pageUrl);
    if (transcriptUrl) transcriptCandidates.push({ url: transcriptUrl, type: structuredTranscript.encodingFormat ?? null, language: structuredTranscript.inLanguage ?? null, origin: "official_web_transcript" });
  }
  return {
    source: {
      originalUrl: sanitizeUrlForArtifact(pageUrl), finalSourceUrl: sanitizeUrlForArtifact(pageUrl), platform: "web",
      title: audioObject.name ?? htmlMeta(html, "og:title") ?? null,
      author: asRecord(audioObject.author).name ?? asRecord(audioObject.creator).name ?? htmlMeta(html, "author") ?? null,
      program: asRecord(audioObject.partOfSeries).name ?? null,
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

/** @param {unknown} value */
function isMediaContentType(value) {
  return /^(?:audio|video)\//i.test(String(value ?? ""));
}

/** @param {string} url @param {string} [finalUrl] @returns {PublicSource} */
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

/** @param {string} url @param {ResolverOptions} [options] @param {Record<string, unknown> | null} [existingProbe] */
async function resolveDirectMedia(url, options = {}, existingProbe = null) {
  if (options.resolveOnly) {
    const probe = existingProbe ?? asRecord(await (options.probeResource ?? probePublicResource)(url, { maxBytes: options.maxMediaBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxMediaBytes, timeoutMs: options.timeoutMs, lookupFn: options.lookupFn }));
    if (probe.status !== "ready") return probe;
    const source = directSource(url, String(probe.finalUrl ?? url));
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

/** @param {string} url @param {ResolverOptions} [options] */
async function resolveDirectOrWeb(url, options = {}) {
  const classification = classifyPublicUrl(url);
  if (classification.kind === "direct_media") return resolveDirectMedia(url, options);
  if (classification.platform === "web") {
    const probe = asRecord(await (options.probeResource ?? probePublicResource)(url, { maxBytes: options.maxMediaBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxMediaBytes, timeoutMs: options.timeoutMs, lookupFn: options.lookupFn }));
    if (probe.status === "ready" && isMediaContentType(probe.contentType)) return resolveDirectMedia(url, options, probe);
    if (probe.reason === "public_url_size_limit_exceeded") return probe;
  }
  const fetcher = options.fetchResource ?? fetchPublicResource;
  const fetched = asRecord(await fetcher(url, { maxBytes: options.maxPageBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxPageBytes, timeoutMs: options.timeoutMs, maxRedirects: options.maxRedirects, lookupFn: options.lookupFn, accept: "text/html,application/rss+xml,application/xml,text/xml" }));
  if (fetched.status !== "completed") return fetched;
  if (!Buffer.isBuffer(fetched.body)) return { status: "blocked", reason: "public_web_body_invalid" };
  const text = fetched.body.toString("utf8");
  if (/rss|xml/.test(String(fetched.contentType ?? "")) || /^\s*<rss\b/i.test(text)) return resolveRss(String(fetched.finalUrl ?? url), text, options);
  const parsed = parseGenericHtml(text, String(fetched.finalUrl ?? url));
  parsed.source.originalUrl = sanitizeUrlForArtifact(url);
  if (parsed.rssUrl) {
    const rssFetched = asRecord(await fetcher(parsed.rssUrl, { maxBytes: options.maxPageBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxPageBytes, timeoutMs: options.timeoutMs, lookupFn: options.lookupFn }));
    if (rssFetched.status === "completed" && Buffer.isBuffer(rssFetched.body)) return resolveRss(String(rssFetched.finalUrl ?? parsed.rssUrl), rssFetched.body.toString("utf8"), { ...options, episodeUrl: String(fetched.finalUrl ?? url) });
  }
  /** @type {Array<Record<string, unknown>>} */
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
    const probe = asRecord(await (options.probeResource ?? probePublicResource)(parsed.mediaUrl, { maxBytes: options.maxMediaBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxMediaBytes, timeoutMs: options.timeoutMs, lookupFn: options.lookupFn }));
    if (probe.status !== "ready") return { status: "blocked", reason: probe.reason, source: parsed.source, media: probe };
    return { status: "resolved", source: parsed.source, transcript: null, supplementaryTranscript: transcriptResults.find((item) => item.status === "supplementary_only") ?? null, media: { status: "available_not_downloaded", sizeBytes: probe.contentLength, contentType: probe.contentType, sourceUrl: sanitizeUrlForArtifact(parsed.mediaUrl) }, fallback: { required: true, method: "cloud_asr" }, diagnostics: ["official_timestamped_transcript_unavailable"] };
  }
  const media = await downloadAndValidateMedia(parsed.mediaUrl, parsed.source, options);
  return media.status === "downloaded" ? { status: "resolved", source: parsed.source, transcript: null, supplementaryTranscript: transcriptResults.find((item) => item.status === "supplementary_only") ?? null, media, fallback: { required: true, method: "cloud_asr" }, diagnostics: ["official_timestamped_transcript_unavailable"] } : { status: "blocked", reason: media.reason, source: parsed.source, media };
}

/** @param {string} url @param {ResolverOptions} [options] */
export async function resolvePublicMediaSource(url, options = {}) {
  const classification = classifyPublicUrl(url);
  if (classification.kind === "invalid") return { status: "blocked", reason: "public_url_invalid" };
  const validated = await validatePublicUrl(url, options.lookupFn === undefined ? {} : { lookupFn: options.lookupFn });
  if (validated.status !== "ready") return validated;
  const merged = {
    ...DEFAULT_PUBLIC_URL_LIMITS,
    ...options,
    resolveOnly: options.resolveOnly === true,
    inputDir: options.inputDir ? resolve(options.inputDir) : null,
  };
  if (!merged.resolveOnly && !merged.inputDir) return { status: "blocked", reason: "public_url_input_dir_required" };
  if (classification.platform === "youtube") return resolveYoutube(url, merged);
  if (classification.platform === "xiaoyuzhou") return resolveXiaoyuzhou(url, merged);
  return resolveDirectOrWeb(url, merged);
}

/** @param {unknown} result */
export function resolutionArtifactView(result) {
  const resolved = asRecord(result);
  const transcript = asRecord(resolved.transcript);
  const supplementaryTranscript = asRecord(resolved.supplementaryTranscript);
  const media = asRecord(resolved.media);
  return {
    schemaVersion: "public-url-source-resolution-v1",
    status: resolved.status ?? "blocked",
    reason: resolved.reason ?? null,
    source: resolved.source ?? null,
    transcript: Object.keys(transcript).length > 0 ? {
      status: transcript.status,
      origin: transcript.origin,
      language: transcript.language,
      format: transcript.format,
      hasTimestamps: transcript.hasTimestamps,
      quality: transcript.quality,
      segmentCount: Array.isArray(transcript.segments) ? transcript.segments.length : 0,
      sourceUrl: transcript.sourceUrl ?? null,
    } : null,
    supplementaryTranscript: Object.keys(supplementaryTranscript).length > 0 ? {
      status: supplementaryTranscript.status,
      origin: supplementaryTranscript.origin,
      language: supplementaryTranscript.language,
      format: supplementaryTranscript.format,
      hasTimestamps: false,
      sourceUrl: supplementaryTranscript.sourceUrl ?? null,
    } : null,
    media: Object.keys(media).length > 0 ? {
      status: media.status,
      localPath: media.localPath ?? null,
      sizeBytes: media.sizeBytes ?? null,
      durationSec: media.durationSec ?? null,
      contentType: media.contentType ?? null,
      sourceUrl: media.sourceUrl ?? null,
      sha256: media.sha256 ?? null,
    } : null,
    fallback: resolved.fallback ?? null,
    diagnostics: uniqueStrings(resolved.diagnostics ?? [], 30),
    recovery: resolved.recovery ?? null,
    rawSecretsReturned: false,
    cookiesUsed: false,
    accessControlBypassed: false,
  };
}
