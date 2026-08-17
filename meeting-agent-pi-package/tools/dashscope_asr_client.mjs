#!/usr/bin/env node

import { createHash, createHmac, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import { assertCloudAsrSummary } from "../dist/index.js";
import {
  DASHSCOPE_FILE_EXTENSIONS,
  DASHSCOPE_REALTIME_FORMATS,
  cloudAsrMediaKind,
  mediaExtension,
  planDashScopeInput,
  realtimeFormatForPath,
} from "./asr_media_formats.mjs";
import { normalizeDiarizationPreference, normalizeSpeakerCount, prepareFileDiarization } from "./asr_diarization_helpers.mjs";
import { buildSingleMixAnalysis, normalizeSingleMixMode } from "./single_mix_asr_helpers.mjs";

const DEFAULT_ENDPOINT = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
const DEFAULT_MODEL = "paraformer-realtime-v2";
const DEFAULT_FILE_MODEL = "fun-asr";
const DEFAULT_SINGLE_MIX_REVIEW_MODEL = "paraformer-v2";
const DEFAULT_LANGUAGE_HINTS = ["yue", "zh", "en"];
const DEFAULT_FILE_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription";
const DEFAULT_OSS_SIGNED_URL_TTL_SECONDS = 24 * 60 * 60;
const MAX_FILE_TRANSCRIPTION_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * @typedef {Record<string, unknown>} UnknownRecord
 * @typedef {{ [key: string]: string | boolean | undefined }} CliArgs
 * @typedef {{ sourceIndex: number, path: string, basename: string, sizeBytes: number, hashSha256: string, format: string, extension: string, mediaType: string, privacy: string }} AsrSource
 * @typedef {UnknownRecord & { sourceFile: string, sourceIndex: number, chunkIndex: number, startSec: number, endSec: number, text: string, speakerId?: unknown, channelId?: unknown, singleMixEvidence?: UnknownRecord }} TranscriptSegment
 * @typedef {{ bucket: string, region: string, endpoint: string, bucketEndpoint: string, accessKeyId: string, accessKeySecret: string, securityToken: string, prefix: string, configured: boolean }} OssConfig
 * @typedef {UnknownRecord & { status: "blocked", reason: string, failureClass: string, rawMediaExternalUpload: true }} BlockedResult
 * @typedef {UnknownRecord & { status: string, sourceIndex?: number, taskId?: string, reason?: string, failureClass?: string, model?: string, endpoint?: string, inputMode?: string, speakerDiarization?: UnknownRecord, transcriptSegments?: TranscriptSegment[], failedChunks?: unknown[], rawMediaExternalUpload?: boolean, singleMixAnalysis?: UnknownRecord & { transcriptSegments?: TranscriptSegment[] } }} FileRunResult
 * @typedef {{ outputDir: string, paths?: string[], model?: string, fileModel?: string, singleMixReviewModel?: string, endpoint?: string, fileEndpoint?: string, format?: string, inputMode?: string, sampleRate?: string | number, languageHints?: string | string[], vocabularyId?: string, workspaceId?: string, timeoutMs?: string | number, frameBytes?: string | number, frameDelayMs?: string | number, pollIntervalMs?: string | number, ossSignedUrlTtlSeconds?: string | number, ossBucket?: string, ossRegion?: string, ossEndpoint?: string, ossBucketEndpoint?: string, ossPrefix?: string, diarizationEnabled?: unknown, speakerCount?: unknown, timestampAlignmentEnabled?: unknown, singleMixMode?: unknown, audioTranscoder?: unknown, audioNormalizeTimeoutMs?: unknown, meetingId?: string, meetingTitle?: string, source?: string, privacy?: string, mockProvider?: boolean, mockEvents?: UnknownRecord[], mockFileProvider?: boolean, mockFileSentences?: UnknownRecord[], mockReviewFileSentences?: UnknownRecord[], _preparedDiarization?: Awaited<ReturnType<typeof prepareFileDiarization>>, [key: string]: unknown }} AsrParams
 * @typedef {{ ok: boolean, status: number, body: UnknownRecord | null, text: string, error?: string }} FetchJsonResult
 */

/** @param {unknown} value @returns {UnknownRecord} */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {UnknownRecord} */ (value)
    : {};
}

/** @param {unknown} value @param {TranscriptSegment[]} fallback @returns {TranscriptSegment[]} */
function normalizeTranscriptSegments(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  return value.flatMap((itemValue, index) => {
    const item = asRecord(itemValue);
    const backup = fallback[index];
    const sourceFile = typeof item.sourceFile === "string" ? item.sourceFile : backup?.sourceFile;
    const sourceIndex = Number.isInteger(item.sourceIndex) ? Number(item.sourceIndex) : backup?.sourceIndex;
    const text = String(item.text ?? backup?.text ?? "").trim();
    if (!sourceFile || sourceIndex === undefined || !text) return [];
    return [{
      ...item,
      sourceFile,
      sourceIndex,
      chunkIndex: Number.isInteger(item.chunkIndex) ? Number(item.chunkIndex) : backup?.chunkIndex ?? index,
      startSec: Number(item.startSec ?? backup?.startSec ?? 0),
      endSec: Number(item.endSec ?? backup?.endSec ?? item.startSec ?? 0),
      text,
    }];
  });
}

/** @param {string[]} argv @returns {CliArgs} */
function parseArgs(argv) {
  /** @type {CliArgs} */
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === undefined) continue;
    if (!item.startsWith("--")) continue;
    const equals = item.indexOf("=");
    if (equals > 2) {
      args[item.slice(2, equals)] = item.slice(equals + 1);
      continue;
    }
    const key = item.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

/** @param {string} path @param {unknown} value */
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

/** @param {string} path @param {unknown} value */
function appendNdjson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "a" });
}

/** @param {unknown} seconds */
function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds ?? 0)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

/** @param {string} meetingTitle @param {TranscriptSegment[]} segments */
function readableTranscript(meetingTitle, segments) {
  const lines = [`# ${meetingTitle}`, ""];
  for (const segment of segments) {
    const time = `${formatTimestamp(segment.startSec)}–${formatTimestamp(segment.endSec)}`;
    const speaker = segment.speakerId === null || segment.speakerId === undefined
      ? "说话人待确认"
      : `说话人 ${Number.isFinite(Number(segment.speakerId)) ? Number(segment.speakerId) + 1 : segment.speakerId}`;
    const channel = segment.channelId === null || segment.channelId === undefined ? "" : ` · 声道 ${segment.channelId}`;
    const review = segment.singleMixEvidence?.status === "needs_review" ? " · 单录混音复核待确认" : "";
    lines.push(`- **${time} · ${speaker}${channel}${review}** ${segment.text}`);
  }
  return `${lines.join("\n")}\n`;
}

/** @param {unknown} value */
function redact(value) {
  return String(value ?? "")
    .replace(/bearer\s+[A-Za-z0-9._-]+/gi, "bearer [redacted]")
    .replace(/sk-[A-Za-z0-9._-]+/gi, "sk-[redacted]")
    .replace(/https:\/\/[^\s"'<>]+(?:OSSAccessKeyId|Signature=)[^\s"'<>]*/gi, "[redacted-signed-url]")
    .slice(0, 4000);
}

/** @param {string} path @returns {Promise<string>} */
function sha256(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** @param {unknown} value @param {string[]} [fallback] @returns {string[]} */
function asArray(value, fallback = []) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return fallback;
}

/** @param {string} path @param {unknown} [explicitFormat] */
function audioFormat(path, explicitFormat) {
  return realtimeFormatForPath(path, explicitFormat) ?? mediaExtension(path).replace(/^\./, "");
}

function realtimeSpeakerDiarizationMetadata() {
  return {
    requested: "unsupported",
    enabled: false,
    status: "unsupported_realtime_endpoint",
    speakerCountHint: null,
    speakerCountDetected: 0,
    overlapSpeechSeparationSupported: false,
    overlapSpeechHandling: "not_available_on_paraformer_realtime",
  };
}

/** @param {...string} names */
function envValue(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return "";
}

/** @param {unknown} value @param {string} [fallback] */
function normalizeHttpsUrl(value, fallback = "") {
  const url = new URL(String(value || fallback));
  if (url.protocol !== "https:") throw new Error("cloud_asr_https_endpoint_required");
  if (url.username || url.password) throw new Error("cloud_asr_endpoint_credentials_not_allowed");
  return url;
}

/** @param {AsrParams} params @returns {OssConfig} */
function ossConfig(params) {
  const bucket = String(params.ossBucket ?? envValue("ALIYUN_OSS_BUCKET")).trim();
  const region = String(params.ossRegion ?? envValue("ALIYUN_OSS_REGION")).trim();
  const endpointValue = String(params.ossEndpoint ?? envValue("ALIYUN_OSS_ENDPOINT") ?? "").trim();
  const bucketEndpointValue = String(params.ossBucketEndpoint ?? envValue("ALIYUN_OSS_BUCKET_ENDPOINT") ?? "").trim();
  const accessKeyId = envValue("ALIBABA_CLOUD_ACCESS_KEY_ID", "ALIYUN_OSS_ACCESS_KEY_ID");
  const accessKeySecret = envValue("ALIBABA_CLOUD_ACCESS_KEY_SECRET", "ALIYUN_OSS_ACCESS_KEY_SECRET");
  const securityToken = envValue("ALIBABA_CLOUD_SECURITY_TOKEN", "ALIYUN_OSS_SECURITY_TOKEN");
  const prefix = String(params.ossPrefix ?? envValue("ALIYUN_OSS_ASR_PREFIX") ?? "agent-asr").replace(/^\/+|\/+$/g, "");
  let endpoint = endpointValue;
  if (!endpoint && region) endpoint = `https://${region}.aliyuncs.com`;
  let bucketEndpoint = bucketEndpointValue;
  if (!bucketEndpoint && bucket && endpoint) {
    const parsed = normalizeHttpsUrl(endpoint);
    bucketEndpoint = `${parsed.protocol}//${bucket}.${parsed.host}`;
  }
  return {
    bucket,
    region,
    endpoint,
    bucketEndpoint,
    accessKeyId,
    accessKeySecret,
    securityToken,
    prefix,
    configured: Boolean(bucket && bucketEndpoint && accessKeyId && accessKeySecret),
  };
}

/** @param {unknown} value */
function safeObjectName(value) {
  const extension = mediaExtension(value);
  const stem = basename(String(value ?? "media"), extension).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 100) || "media";
  return `${stem}${extension}`;
}

/** @param {string} objectKey */
function encodeObjectKey(objectKey) {
  return String(objectKey).split("/").map((part) => encodeURIComponent(part)).join("/");
}

/** @param {string} extension */
function objectContentType(extension) {
  /** @type {Record<string, string>} */
  const types = {
    ".aac": "audio/aac",
    ".amr": "audio/amr",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".wav": "audio/wav",
    ".wma": "audio/x-ms-wma",
    ".avi": "video/x-msvideo",
    ".flv": "video/x-flv",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".mp4": "video/mp4",
    ".mpeg": "video/mpeg",
    ".webm": "video/webm",
    ".wmv": "video/x-ms-wmv",
  };
  return types[extension] ?? "application/octet-stream";
}

/** @param {string} secret @param {string} value */
function hmacSha1Base64(secret, value) {
  return createHmac("sha1", secret).update(value, "utf8").digest("base64");
}

/** @param {OssConfig} config */
function ossCanonicalHeaders(config) {
  return config.securityToken ? `x-oss-security-token:${config.securityToken}\n` : "";
}

/** @param {AsrSource} source @param {OssConfig} config @param {string} eventPath */
async function uploadSourceToOss(source, config, eventPath) {
  const extension = mediaExtension(source.path);
  const objectKey = [config.prefix, source.hashSha256.slice(0, 16), safeObjectName(source.basename)].filter(Boolean).join("/");
  const canonicalResource = `/${config.bucket}/${objectKey}`;
  const date = new Date().toUTCString();
  const contentType = objectContentType(extension);
  const stringToSign = `PUT\n\n${contentType}\n${date}\n${ossCanonicalHeaders(config)}${canonicalResource}`;
  const signature = hmacSha1Base64(config.accessKeySecret, stringToSign);
  const objectUrl = new URL(`${config.bucketEndpoint.replace(/\/$/, "")}/${encodeObjectKey(objectKey)}`);
  /** @type {Record<string, string>} */
  const headers = {
    Authorization: `OSS ${config.accessKeyId}:${signature}`,
    Date: date,
    "Content-Type": contentType,
    "Content-Length": String(source.sizeBytes),
  };
  if (config.securityToken) headers["x-oss-security-token"] = config.securityToken;
  appendNdjson(eventPath, {
    ts: new Date().toISOString(),
    event: "cloud_asr_oss_upload_started",
    sourceFile: source.basename,
    objectUri: `oss://${config.bucket}/${objectKey}`,
    sizeBytes: source.sizeBytes,
  });
  let response;
  try {
    const uploadRequest = {
      method: "PUT",
      headers,
      body: /** @type {BodyInit} */ (/** @type {unknown} */ (createReadStream(source.path))),
      duplex: "half",
    };
    response = await fetch(objectUrl, /** @type {RequestInit} */ (/** @type {unknown} */ (uploadRequest)));
  } catch (error) {
    return blocked("cloud_asr_file_upload_failed", { error: redact(error instanceof Error ? error.message : String(error)) });
  }
  if (!response.ok) {
    return blocked("cloud_asr_file_upload_failed", { httpStatus: response.status, responseText: redact(await response.text()) });
  }
  appendNdjson(eventPath, {
    ts: new Date().toISOString(),
    event: "cloud_asr_oss_upload_completed",
    sourceFile: source.basename,
    objectUri: `oss://${config.bucket}/${objectKey}`,
    httpStatus: response.status,
  });
  return { status: "completed", objectKey, objectUri: `oss://${config.bucket}/${objectKey}` };
}

/** @param {OssConfig} config @param {string} objectKey @param {unknown} ttlSeconds */
function signedOssGetUrl(config, objectKey, ttlSeconds) {
  const expires = Math.floor(Date.now() / 1000) + Math.max(300, Number(ttlSeconds) || DEFAULT_OSS_SIGNED_URL_TTL_SECONDS);
  const tokenQuery = config.securityToken ? `?security-token=${config.securityToken}` : "";
  const canonicalResource = `/${config.bucket}/${objectKey}${tokenQuery}`;
  const signature = hmacSha1Base64(config.accessKeySecret, `GET\n\n\n${expires}\n${canonicalResource}`);
  const url = new URL(`${config.bucketEndpoint.replace(/\/$/, "")}/${encodeObjectKey(objectKey)}`);
  url.searchParams.set("OSSAccessKeyId", config.accessKeyId);
  url.searchParams.set("Expires", String(expires));
  url.searchParams.set("Signature", signature);
  if (config.securityToken) url.searchParams.set("security-token", config.securityToken);
  return url.toString();
}

/** @param {string} reason @param {UnknownRecord} [details] @returns {BlockedResult} */
function blocked(reason, details = {}) {
  return {
    status: "blocked",
    provider: "aliyun_dashscope_paraformer",
    reason,
    failureClass: reason,
    externalAudioUpload: true,
    rawMediaExternalUpload: true,
    rawSecretsReturned: false,
    ...details,
  };
}

/** @param {{taskId: string, model: string, format: string, sampleRate: number, languageHints: string[], vocabularyId: string}} input */
function buildRunTask({ taskId, model, format, sampleRate, languageHints, vocabularyId }) {
  /** @type {UnknownRecord} */
  const parameters = {
    format,
    sample_rate: sampleRate,
    disfluency_removal_enabled: false,
    punctuation_prediction_enabled: true,
    inverse_text_normalization_enabled: true,
    semantic_punctuation_enabled: true,
    language_hints: languageHints,
  };
  if (vocabularyId) parameters.vocabulary_id = vocabularyId;
  return {
    header: {
      action: "run-task",
      task_id: taskId,
      streaming: "duplex",
    },
    payload: {
      task_group: "audio",
      task: "asr",
      function: "recognition",
      model,
      parameters,
      input: {},
    },
  };
}

/** @param {string} taskId */
function buildFinishTask(taskId) {
  return {
    header: {
      action: "finish-task",
      task_id: taskId,
      streaming: "duplex",
    },
    payload: {
      input: {},
    },
  };
}

/** @param {unknown} errorCode @param {unknown} [message] */
function classifyCloudError(errorCode, message = "") {
  const text = `${errorCode ?? ""} ${message}`.toLowerCase();
  if (/auth|forbidden|permission|unauthorized|api.key|apikey|invalid.*key/.test(text)) return "cloud_asr_auth_failed";
  if (/model|not.*available|not.*found/.test(text)) return "cloud_asr_model_unavailable";
  if (/format|sample|audio/.test(text)) return "cloud_asr_audio_format_rejected";
  if (/timeout|timed out/.test(text)) return "cloud_asr_provider_timeout";
  return "cloud_asr_provider_error";
}

/** @param {WebSocket} ws @param {string} path @param {number} frameBytes @param {number} frameDelayMs */
async function sendAudioFile(ws, path, frameBytes, frameDelayMs) {
  const handle = createReadStream(path, { highWaterMark: frameBytes });
  for await (const chunk of handle) {
    if (ws.readyState !== WebSocket.OPEN) throw new Error("cloud_asr_websocket_closed");
    ws.send(chunk, { binary: true });
    if (frameDelayMs > 0) await sleep(frameDelayMs);
  }
}

/** @param {import("ws").RawData} data @returns {UnknownRecord} */
function parseJsonMessage(data) {
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  return asRecord(JSON.parse(text));
}

/** @param {AsrParams} params @param {AsrSource} source @param {string} eventPath @returns {Promise<FileRunResult>} */
async function transcribeRealtimeFile(params, source, eventPath) {
  if (params.mockProvider === true || Array.isArray(params.mockEvents)) {
    const events = Array.isArray(params.mockEvents) && params.mockEvents.length > 0
      ? params.mockEvents
      : [
          {
            header: { event: "result-generated" },
            payload: { output: { sentence: { begin_time: 0, end_time: 1000, text: "mock cloud asr transcript" } } },
          },
          { header: { event: "task-finished" }, payload: {} },
        ];
    /** @type {TranscriptSegment[]} */
    const segments = [];
    for (const eventMessageValue of events) {
      const eventMessage = asRecord(eventMessageValue);
      const header = asRecord(eventMessage.header);
      const sentence = asRecord(asRecord(asRecord(eventMessage.payload).output).sentence);
      appendNdjson(eventPath, { ts: new Date().toISOString(), event: header.event ?? "mock-event", taskId: "mock-cloud-asr" });
      if (header.event === "task-failed") {
        const reason = classifyCloudError(header.error_code, header.error_message);
        return blocked(reason, {
          taskId: "mock-cloud-asr",
          errorCode: header.error_code ?? null,
          errorMessage: redact(header.error_message ?? ""),
        });
      }
      if (sentence.heartbeat === true || sentence.end_time === null || !String(sentence.text ?? "").trim()) continue;
      segments.push({
        status: "success",
        sourceFile: source.basename,
        sourceIndex: source.sourceIndex,
        sourceHashSha256: source.hashSha256,
        chunkIndex: segments.length,
        startSec: Number(sentence.begin_time ?? 0) / 1000,
        endSec: Number(sentence.end_time ?? sentence.begin_time ?? 0) / 1000,
        text: String(sentence.text ?? "").trim(),
        language: "mock",
        model: params.model ?? DEFAULT_MODEL,
        endpoint: "dashscope-websocket-mock",
        finishReason: "sentence_final",
        truncated: false,
        words: Array.isArray(sentence.words) ? sentence.words.slice(0, 200) : [],
      });
    }
    return {
      status: "completed",
      taskId: "mock-cloud-asr",
      model: params.model ?? DEFAULT_MODEL,
      endpoint: "dashscope-websocket-mock",
      inputMode: "realtime",
      format: audioFormat(source.path, params.format),
      sampleRate: Number(params.sampleRate ?? 16000),
      languageHints: asArray(params.languageHints, DEFAULT_LANGUAGE_HINTS),
      vocabularyIdConfigured: false,
      workspaceIdConfigured: false,
      speakerDiarization: realtimeSpeakerDiarizationMetadata(),
      taskStarted: true,
      taskFinished: true,
      transcriptSegments: segments,
      failedChunks: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      externalAudioUpload: false,
      rawMediaExternalUpload: false,
      rawSecretsReturned: false,
      mockProvider: true,
    };
  }

  const apiKey = process.env.ALIYUN_DASHSCOPE_API_KEY?.trim() || process.env.DASHSCOPE_API_KEY?.trim();
  if (!apiKey) return blocked("cloud_asr_api_key_missing");

  const format = audioFormat(source.path, params.format);
  if (!DASHSCOPE_REALTIME_FORMATS.has(format)) {
    return blocked("cloud_asr_audio_format_rejected", {
      format,
      supportedFormats: [...DASHSCOPE_REALTIME_FORMATS],
    });
  }

  const taskId = randomUUID();
  const endpoint = params.endpoint ?? process.env.ALIYUN_ASR_ENDPOINT ?? DEFAULT_ENDPOINT;
  const model = params.model ?? process.env.ALIYUN_ASR_MODEL ?? DEFAULT_MODEL;
  const sampleRate = Number(params.sampleRate ?? process.env.ALIYUN_ASR_SAMPLE_RATE ?? 16000);
  const languageHints = asArray(params.languageHints ?? process.env.ALIYUN_ASR_LANGUAGE_HINTS, DEFAULT_LANGUAGE_HINTS);
  const vocabularyId = params.vocabularyId ?? process.env.ALIYUN_ASR_VOCABULARY_ID ?? "";
  const workspaceId = params.workspaceId ?? process.env.ALIYUN_DASHSCOPE_WORKSPACE_ID ?? "";
  const timeoutMs = Number(params.timeoutMs ?? process.env.ALIYUN_ASR_TIMEOUT_MS ?? 1_800_000);
  const frameBytes = Number(params.frameBytes ?? process.env.ALIYUN_ASR_AUDIO_FRAME_BYTES ?? 32_000);
  const frameDelayMs = Number(params.frameDelayMs ?? process.env.ALIYUN_ASR_AUDIO_FRAME_DELAY_MS ?? 20);
  const startedAt = new Date().toISOString();
  /** @type {TranscriptSegment[]} */
  const segments = [];
  let taskStarted = false;
  let taskFinished = false;
  /** @type {BlockedResult | null} */
  let failure = null;

  appendNdjson(eventPath, {
    ts: startedAt,
    event: "cloud_asr_request_started",
    taskId,
    endpoint,
    model,
    format,
    sampleRate,
    languageHints,
    vocabularyIdConfigured: Boolean(vocabularyId),
    workspaceIdConfigured: Boolean(workspaceId),
    sourceFile: source.basename,
    rawSecretsReturned: false,
  });

  /** @type {Record<string, string>} */
  const headers = {
    Authorization: `bearer ${apiKey}`,
    "user-agent": "meeting-agent-pi-runtime",
    "X-DashScope-DataInspection": "enable",
  };
  if (workspaceId) headers["X-DashScope-WorkSpace"] = workspaceId;

  const ws = new WebSocket(endpoint, { headers });

  const result = await new Promise((/** @type {(value: FileRunResult) => void} */ resolveRun) => {
    const timer = setTimeout(() => {
      failure = blocked("cloud_asr_provider_timeout", { taskId, timeoutMs });
      appendNdjson(eventPath, { ts: new Date().toISOString(), event: "cloud_asr_timeout", taskId, timeoutMs });
      try {
        ws.terminate();
      } catch {
        // ignore termination errors
      }
      resolveRun(failure);
    }, timeoutMs);

    /** @param {FileRunResult} value */
    const finish = (value) => {
      clearTimeout(timer);
      resolveRun(value);
    };

    ws.on("open", () => {
      appendNdjson(eventPath, { ts: new Date().toISOString(), event: "websocket_open", taskId });
      ws.send(JSON.stringify(buildRunTask({ taskId, model, format, sampleRate, languageHints, vocabularyId })));
    });

    ws.on("message", async (data) => {
      /** @type {UnknownRecord} */
      let message;
      try {
        message = parseJsonMessage(data);
      } catch (error) {
        appendNdjson(eventPath, { ts: new Date().toISOString(), event: "cloud_asr_unparsed_message", taskId, error: redact(error instanceof Error ? error.message : error) });
        return;
      }
      const header = asRecord(message.header);
      const sentence = asRecord(asRecord(asRecord(message.payload).output).sentence);
      const event = header.event ?? "unknown";
      appendNdjson(eventPath, {
        ts: new Date().toISOString(),
        event,
        taskId,
        errorCode: header.error_code ?? null,
        errorMessage: header.error_message ? redact(header.error_message) : null,
        sentence: Object.keys(sentence).length > 0
          ? {
              begin_time: sentence.begin_time ?? null,
              end_time: sentence.end_time ?? null,
              textPreview: String(sentence.text ?? "").slice(0, 120),
              heartbeat: sentence.heartbeat ?? null,
            }
          : null,
      });

      if (event === "task-started") {
        taskStarted = true;
        try {
          await sendAudioFile(ws, source.path, frameBytes, frameDelayMs);
          ws.send(JSON.stringify(buildFinishTask(taskId)));
        } catch (error) {
          failure = blocked("cloud_asr_network_unreachable", { taskId, error: redact(error instanceof Error ? error.message : error) });
          try {
            ws.terminate();
          } catch {
            // ignore termination errors
          }
          finish(failure);
        }
        return;
      }

      if (event === "result-generated") {
        if (sentence.heartbeat === true || sentence.end_time === null || !String(sentence.text ?? "").trim()) return;
        segments.push({
          status: "success",
          sourceFile: source.basename,
          sourceIndex: source.sourceIndex,
          sourceHashSha256: source.hashSha256,
          chunkIndex: segments.length,
          startSec: Number(sentence.begin_time ?? 0) / 1000,
          endSec: Number(sentence.end_time ?? sentence.begin_time ?? 0) / 1000,
          text: String(sentence.text ?? "").trim(),
          language: languageHints.join(","),
          model,
          endpoint: "dashscope-websocket",
          finishReason: "sentence_final",
          truncated: false,
          words: Array.isArray(sentence.words) ? sentence.words.slice(0, 200) : [],
        });
        return;
      }

      if (event === "task-finished") {
        taskFinished = true;
        try {
          ws.close(1000, "done");
        } catch {
          // ignore close errors
        }
        finish({
          status: "completed",
          taskId,
          model,
          endpoint,
          inputMode: "realtime",
          format,
          sampleRate,
          languageHints,
          vocabularyIdConfigured: Boolean(vocabularyId),
          workspaceIdConfigured: Boolean(workspaceId),
          speakerDiarization: realtimeSpeakerDiarizationMetadata(),
          taskStarted,
          taskFinished,
          transcriptSegments: segments,
          failedChunks: [],
          startedAt,
          completedAt: new Date().toISOString(),
          externalAudioUpload: true,
          rawMediaExternalUpload: true,
          rawSecretsReturned: false,
        });
        return;
      }

      if (event === "task-failed") {
        const reason = classifyCloudError(header.error_code, header.error_message);
        failure = blocked(reason, {
          taskId,
          errorCode: header.error_code ?? null,
          errorMessage: redact(header.error_message ?? ""),
        });
        try {
          ws.close(1011, "task failed");
        } catch {
          // ignore close errors
        }
        finish(failure);
      }
    });

    ws.on("error", (error) => {
      const reason = /401|403|unauthorized|forbidden|auth/i.test(error.message) ? "cloud_asr_auth_failed" : "cloud_asr_network_unreachable";
      finish(blocked(reason, { taskId, error: redact(error.message) }));
    });

    ws.on("close", (code, reason) => {
      if (taskFinished || failure) return;
      finish(blocked(taskStarted ? "cloud_asr_partial_result" : "cloud_asr_network_unreachable", {
        taskId,
        closeCode: code,
        closeReason: redact(reason?.toString?.() ?? ""),
        partialSegmentCount: segments.length,
      }));
    });
  });

  return result;
}

/** @param {string | URL} url @param {RequestInit} [init] @param {number} [timeoutMs] @returns {Promise<FetchJsonResult>} */
async function fetchJson(url, init = {}, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    /** @type {UnknownRecord | null} */
    let body = null;
    try {
      body = text ? asRecord(JSON.parse(text)) : null;
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body, text };
  } catch (error) {
    return { ok: false, status: 0, body: null, text: "", error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** @param {string} apiKey @param {string} workspaceId @param {boolean} [asyncRequest] */
function dashscopeHeaders(apiKey, workspaceId, asyncRequest = false) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    ...(asyncRequest ? { "X-DashScope-Async": "enable" } : {}),
    ...(workspaceId ? { "X-DashScope-WorkSpace": workspaceId } : {}),
  };
}

/** @param {unknown} payloadValue @param {AsrSource} source @param {string} model @returns {TranscriptSegment[]} */
function fileTranscriptSegments(payloadValue, source, model) {
  const payload = asRecord(payloadValue);
  const transcripts = payload.transcripts ?? asRecord(payload.output).transcripts ?? asRecord(payload.result).transcripts ?? [];
  /** @type {TranscriptSegment[]} */
  const segments = [];
  for (const transcriptValue of Array.isArray(transcripts) ? transcripts : []) {
    const transcript = asRecord(transcriptValue);
    const sentences = transcript.sentences ?? transcript.sentence_list ?? [];
    if (Array.isArray(sentences) && sentences.length > 0) {
      for (const sentenceValue of sentences) {
        const sentence = asRecord(sentenceValue);
        const text = String(sentence.text ?? "").trim();
        if (!text) continue;
        const speakerId = sentence.speaker_id ?? sentence.speaker ?? null;
        const channelId = sentence.channel_id ?? transcript.channel_id ?? null;
        segments.push({
          status: "success",
          sourceFile: source.basename,
          sourceIndex: source.sourceIndex,
          sourceHashSha256: source.hashSha256,
          chunkIndex: segments.length,
          startSec: Number(sentence.begin_time ?? sentence.start_time ?? 0) / 1000,
          endSec: Number(sentence.end_time ?? sentence.begin_time ?? sentence.start_time ?? 0) / 1000,
          text,
          language: sentence.language ?? "",
          model,
          endpoint: "dashscope-file-transcription",
          finishReason: "sentence_final",
          truncated: false,
          speakerId,
          speakerLabel: speakerId === null ? null : `speaker_${speakerId}`,
          channelId,
          words: Array.isArray(sentence.words) ? sentence.words.slice(0, 200) : [],
        });
      }
      continue;
    }
    const text = String(transcript?.text ?? "").trim();
    if (!text) continue;
    const durationMs = Number(
      transcript.content_duration_in_milliseconds
      ?? asRecord(payload.properties).original_duration_in_milliseconds
      ?? 0,
    );
    segments.push({
      status: "success",
      sourceFile: source.basename,
      sourceIndex: source.sourceIndex,
      sourceHashSha256: source.hashSha256,
      chunkIndex: segments.length,
      startSec: 0,
      endSec: durationMs / 1000,
      text,
      language: "",
      model,
      endpoint: "dashscope-file-transcription",
      finishReason: "transcript_final",
      truncated: false,
      speakerId: null,
      speakerLabel: null,
      channelId: transcript.channel_id ?? null,
      words: [],
    });
  }
  return segments.sort((left, right) => left.startSec - right.startSec).map((segment, index) => ({ ...segment, chunkIndex: index }));
}

/** @param {AsrParams} params @param {AsrSource} source @param {string} eventPath @returns {FileRunResult} */
function mockFileRun(params, source, eventPath) {
  const model = params.fileModel ?? DEFAULT_FILE_MODEL;
  const sentences = Array.isArray(params.mockFileSentences) && params.mockFileSentences.length > 0
    ? params.mockFileSentences
    : [{ begin_time: 0, end_time: 1000, text: "mock cloud file asr transcript", speaker_id: 0 }];
  const preference = normalizeDiarizationPreference(params.diarizationEnabled ?? "auto");
  const speakerCountHint = normalizeSpeakerCount(params.speakerCount);
  const detectedSpeakers = [...new Set(sentences.map((sentence) => asRecord(sentence).speaker_id).filter((value) => value !== null && value !== undefined))];
  const primarySegments = fileTranscriptSegments({ transcripts: [{ sentences }] }, source, model);
  const singleMixMode = normalizeSingleMixMode(params.singleMixMode);
  const reviewModel = params.singleMixReviewModel ?? DEFAULT_SINGLE_MIX_REVIEW_MODEL;
  const reviewSentences = Array.isArray(params.mockReviewFileSentences) ? params.mockReviewFileSentences : sentences;
  const reviewSegments = singleMixMode === "robust"
    ? fileTranscriptSegments({ transcripts: [{ sentences: reviewSentences }] }, source, reviewModel)
    : [];
  const singleMixAnalysis = singleMixMode === "robust"
    ? buildSingleMixAnalysis({
        primarySegments,
        reviewSegments,
        primaryModel: model,
        reviewModel,
        sourceFile: source.basename,
      })
    : null;
  const reviewedSegments = normalizeTranscriptSegments(singleMixAnalysis?.transcriptSegments, primarySegments);
  const singleMixRecord = singleMixAnalysis ? { ...singleMixAnalysis, transcriptSegments: reviewedSegments } : null;
  appendNdjson(eventPath, { ts: new Date().toISOString(), event: "cloud_asr_file_task_finished", taskId: "mock-cloud-file-asr", sourceFile: source.basename });
  return {
    status: "completed",
    taskId: "mock-cloud-file-asr",
    model,
    endpoint: "dashscope-file-transcription-mock",
    inputMode: "file",
    format: mediaExtension(source.path).slice(1),
    languageHints: asArray(params.languageHints, DEFAULT_LANGUAGE_HINTS),
    speakerDiarization: {
      requested: preference,
      enabled: preference !== "disabled",
      status: preference === "disabled" ? "disabled_by_config" : "enabled_mock",
      speakerCountHint: Number.isNaN(speakerCountHint) ? null : speakerCountHint,
      speakerCountDetected: detectedSpeakers.length,
      sourceChannels: 1,
      preparedChannels: 1,
      inputPrepared: false,
      overlapSpeechSeparationSupported: false,
      overlapSpeechHandling: singleMixMode === "robust" ? "dual_model_review_with_unresolved_overlap_gating" : "best_effort_diarization_not_source_separation",
      singleMix: singleMixAnalysis ? {
        status: singleMixAnalysis.status,
        strategy: singleMixAnalysis.strategy,
        reviewItemCount: singleMixAnalysis.reviewItemCount,
        explicitOverlapCount: singleMixAnalysis.explicitOverlapCount,
        sourceSeparationPerformed: false,
        simultaneousSpeechRecoveryGuaranteed: false,
      } : null,
    },
    transcriptSegments: reviewedSegments,
    ...(singleMixRecord ? { singleMixAnalysis: singleMixRecord } : {}),
    failedChunks: [],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    externalAudioUpload: false,
    rawMediaExternalUpload: false,
    rawSecretsReturned: false,
    mockProvider: true,
  };
}

/** @param {AsrParams} params @param {AsrSource} source @param {string} eventPath @param {OssConfig} config @param {string} [providedFileUrl] @returns {Promise<FileRunResult>} */
async function transcribeFileRecording(params, source, eventPath, config, providedFileUrl = "") {
  if (params.mockFileProvider === true) return mockFileRun(params, source, eventPath);
  const apiKey = process.env.ALIYUN_DASHSCOPE_API_KEY?.trim() || process.env.DASHSCOPE_API_KEY?.trim();
  if (!apiKey) return blocked("cloud_asr_api_key_missing");
  if (source.sizeBytes > MAX_FILE_TRANSCRIPTION_BYTES) {
    return blocked("cloud_asr_file_size_exceeded", { sizeBytes: source.sizeBytes, maxBytes: MAX_FILE_TRANSCRIPTION_BYTES });
  }
  const transcoder = params.audioTranscoder ?? process.env.FEISHU_AGENT_AUDIO_TRANSCODER;
  const normalizeTimeout = Number(params.audioNormalizeTimeoutMs ?? process.env.FEISHU_AGENT_AUDIO_NORMALIZE_TIMEOUT_MS);
  const diarization = params._preparedDiarization ?? await prepareFileDiarization(
    source,
    join(resolve(params.outputDir), "asr", "diarization-input"),
    {
      enabled: params.diarizationEnabled ?? process.env.ALIYUN_ASR_DIARIZATION_ENABLED ?? "auto",
      speakerCount: params.speakerCount ?? process.env.ALIYUN_ASR_SPEAKER_COUNT,
      ...(typeof transcoder === "string" && transcoder ? { transcoder } : {}),
      ...(Number.isFinite(normalizeTimeout) && normalizeTimeout > 0 ? { timeoutMs: normalizeTimeout } : {}),
    },
  );
  if (diarization.status !== "completed") {
    return blocked(diarization.reason ?? "cloud_asr_diarization_preparation_failed", {
      speakerDiarization: diarization.metadata ?? null,
      speakerCount: diarization.speakerCount ?? null,
      transcoder: asRecord(diarization).transcoder ?? null,
      exitCode: asRecord(diarization).exitCode ?? null,
    });
  }
  const preparedSource = asRecord(diarization.source);
  const uploadSource = {
    ...source,
    ...preparedSource,
    path: typeof preparedSource.path === "string" ? preparedSource.path : source.path,
    basename: typeof preparedSource.basename === "string" ? preparedSource.basename : source.basename,
    sizeBytes: Number(preparedSource.sizeBytes ?? source.sizeBytes),
    hashSha256: typeof preparedSource.hashSha256 === "string" ? preparedSource.hashSha256 : source.hashSha256,
    format: typeof preparedSource.format === "string" ? preparedSource.format : source.format,
    extension: typeof preparedSource.extension === "string" ? preparedSource.extension : source.extension,
    mediaType: typeof preparedSource.mediaType === "string" ? preparedSource.mediaType : source.mediaType,
  };
  const diarizationMetadata = asRecord(diarization.metadata);

  let fileUrl = String(providedFileUrl ?? "").trim();
  let objectUri = null;
  if (!fileUrl) {
    if (!config.configured) return blocked("cloud_asr_file_transport_unavailable");
    const upload = await uploadSourceToOss(uploadSource, config, eventPath);
    if (upload.status !== "completed" || !("objectUri" in upload) || !("objectKey" in upload)) return upload;
    objectUri = upload.objectUri;
    fileUrl = signedOssGetUrl(
      config,
      upload.objectKey,
      params.ossSignedUrlTtlSeconds ?? process.env.ALIYUN_OSS_SIGNED_URL_TTL_SECONDS ?? DEFAULT_OSS_SIGNED_URL_TTL_SECONDS,
    );
  }
  let parsedFileUrl;
  try {
    parsedFileUrl = normalizeHttpsUrl(fileUrl);
  } catch {
    return blocked("cloud_asr_file_transport_unavailable", { detail: "file URL must use HTTPS" });
  }

  const model = params.fileModel ?? process.env.ALIYUN_ASR_FILE_MODEL ?? DEFAULT_FILE_MODEL;
  const fileEndpoint = normalizeHttpsUrl(params.fileEndpoint ?? process.env.ALIYUN_ASR_FILE_ENDPOINT, DEFAULT_FILE_ENDPOINT);
  const workspaceId = params.workspaceId ?? process.env.ALIYUN_DASHSCOPE_WORKSPACE_ID ?? "";
  const languageHints = asArray(params.languageHints ?? process.env.ALIYUN_ASR_LANGUAGE_HINTS, DEFAULT_LANGUAGE_HINTS);
  const vocabularyId = params.vocabularyId ?? process.env.ALIYUN_ASR_VOCABULARY_ID ?? "";
  const timestampAlignmentEnabled = !/^(0|false|no|off|disabled)$/i.test(String(
    params.timestampAlignmentEnabled ?? process.env.ALIYUN_ASR_TIMESTAMP_ALIGNMENT_ENABLED ?? "true",
  ));
  const timeoutMs = Number(params.timeoutMs ?? process.env.ALIYUN_ASR_TIMEOUT_MS ?? 1_800_000);
  const pollIntervalMs = Math.max(1000, Number(params.pollIntervalMs ?? process.env.ALIYUN_ASR_FILE_POLL_INTERVAL_MS ?? 3000));
  const startedAt = new Date().toISOString();
  /** @type {UnknownRecord} */
  const parameters = {
    language_hints: languageHints,
    diarization_enabled: diarizationMetadata.enabled === true,
    timestamp_alignment_enabled: timestampAlignmentEnabled,
  };
  if (vocabularyId) parameters.vocabulary_id = vocabularyId;
  if (diarizationMetadata.enabled === true && diarizationMetadata.speakerCountHint) {
    parameters.speaker_count = diarizationMetadata.speakerCountHint;
  }
  const submit = await fetchJson(fileEndpoint, {
    method: "POST",
    headers: dashscopeHeaders(apiKey, workspaceId, true),
    body: JSON.stringify({ model, input: { file_urls: [parsedFileUrl.toString()] }, parameters }),
  }, Math.min(timeoutMs, 60_000));
  if (!submit.ok) {
    const reason = classifyCloudError(submit.body?.code, submit.body?.message ?? submit.text ?? submit.error);
    return blocked(reason, { httpStatus: submit.status, errorCode: submit.body?.code ?? null, errorMessage: redact(submit.body?.message ?? submit.error ?? "") });
  }
  const taskIdValue = asRecord(submit.body?.output).task_id ?? submit.body?.task_id;
  if (!taskIdValue) return blocked("cloud_asr_file_task_failed", { detail: "task id missing" });
  const taskId = String(taskIdValue);
  appendNdjson(eventPath, {
    ts: startedAt,
    event: "cloud_asr_file_task_submitted",
    taskId,
    model,
    sourceFile: source.basename,
    uploadedSourceFile: uploadSource.basename,
    objectUri,
    format: mediaExtension(uploadSource.path).slice(1),
    speakerDiarization: diarizationMetadata,
  });

  const taskEndpoint = new URL(`/api/v1/tasks/${encodeURIComponent(taskId)}`, fileEndpoint.origin);
  const deadline = Date.now() + timeoutMs;
  /** @type {UnknownRecord | null} */
  let taskOutput = null;
  while (Date.now() < deadline) {
    const query = await fetchJson(taskEndpoint, { headers: dashscopeHeaders(apiKey, workspaceId, false) }, Math.min(60_000, Math.max(1000, deadline - Date.now())));
    if (!query.ok) {
      const reason = classifyCloudError(query.body?.code, query.body?.message ?? query.text ?? query.error);
      if (query.status >= 500 || query.status === 429 || query.status === 0) {
        await sleep(pollIntervalMs);
        continue;
      }
      return blocked(reason, { taskId, httpStatus: query.status, errorCode: query.body?.code ?? null, errorMessage: redact(query.body?.message ?? query.error ?? "") });
    }
    taskOutput = asRecord(query.body?.output ?? query.body);
    const taskStatus = String(taskOutput.task_status ?? taskOutput.status ?? "").toUpperCase();
    appendNdjson(eventPath, { ts: new Date().toISOString(), event: "cloud_asr_file_task_polled", taskId, taskStatus });
    if (taskStatus === "SUCCEEDED") break;
    if (taskStatus === "FAILED" || taskStatus === "CANCELED" || taskStatus === "CANCELLED") {
      const reason = classifyCloudError(taskOutput?.code, taskOutput?.message);
      return blocked(reason === "cloud_asr_provider_error" ? "cloud_asr_file_task_failed" : reason, {
        taskId,
        errorCode: taskOutput?.code ?? null,
        errorMessage: redact(taskOutput?.message ?? ""),
      });
    }
    await sleep(pollIntervalMs);
  }
  const finalStatus = String(taskOutput?.task_status ?? taskOutput?.status ?? "").toUpperCase();
  if (finalStatus !== "SUCCEEDED") return blocked("cloud_asr_provider_timeout", { taskId, timeoutMs });

  const resultRows = taskOutput?.results ?? asRecord(taskOutput?.result).results ?? [];
  const resultRow = asRecord(Array.isArray(resultRows) ? resultRows[0] : null);
  if (resultRow.subtask_status && String(resultRow.subtask_status).toUpperCase() !== "SUCCEEDED") {
    const reason = classifyCloudError(resultRow.code, resultRow.message);
    return blocked(reason === "cloud_asr_provider_error" ? "cloud_asr_file_task_failed" : reason, {
      taskId,
      subtaskStatus: resultRow.subtask_status,
      errorCode: resultRow.code ?? null,
      errorMessage: redact(resultRow.message ?? ""),
    });
  }
  const transcriptionUrl = resultRow.transcription_url ?? taskOutput?.transcription_url ?? asRecord(taskOutput?.result).transcription_url;
  if (!transcriptionUrl) return blocked("cloud_asr_file_task_failed", { taskId, detail: "transcription URL missing" });
  let parsedTranscriptionUrl;
  try {
    parsedTranscriptionUrl = normalizeHttpsUrl(transcriptionUrl);
  } catch {
    return blocked("cloud_asr_file_task_failed", { taskId, detail: "invalid transcription URL" });
  }
  const transcription = await fetchJson(parsedTranscriptionUrl, {}, Math.min(timeoutMs, 120_000));
  if (!transcription.ok || !transcription.body) {
    return blocked("cloud_asr_file_task_failed", { taskId, httpStatus: transcription.status, detail: "transcription result download failed" });
  }
  const transcriptSegments = fileTranscriptSegments(transcription.body, source, model);
  const detectedSpeakerIds = [...new Set(transcriptSegments.map((segment) => segment.speakerId).filter((value) => value !== null && value !== undefined))];
  /** @type {UnknownRecord} */
  let speakerDiarization = {
    ...diarizationMetadata,
    speakerCountDetected: detectedSpeakerIds.length,
    speakerIds: detectedSpeakerIds,
  };
  appendNdjson(eventPath, {
    ts: new Date().toISOString(),
    event: "cloud_asr_file_task_finished",
    taskId,
    sourceFile: source.basename,
    transcriptSegmentCount: transcriptSegments.length,
    speakerCountDetected: detectedSpeakerIds.length,
  });
  const result = {
    status: "completed",
    taskId,
    model,
    endpoint: "dashscope-file-transcription",
    inputMode: "file",
    format: mediaExtension(uploadSource.path).slice(1),
    sourceFormat: mediaExtension(source.path).slice(1),
    languageHints,
    vocabularyIdConfigured: Boolean(vocabularyId),
    workspaceIdConfigured: Boolean(workspaceId),
    timestampAlignmentEnabled,
    speakerDiarization,
    transcriptSegments,
    failedChunks: [],
    startedAt,
    completedAt: new Date().toISOString(),
    externalAudioUpload: true,
    rawMediaExternalUpload: true,
    rawSecretsReturned: false,
    objectUri,
  };
  const singleMixMode = normalizeSingleMixMode(params.singleMixMode ?? process.env.ALIYUN_ASR_SINGLE_MIX_MODE ?? "robust");
  if (singleMixMode !== "robust") return result;

  const configuredReviewModel = params.singleMixReviewModel
    ?? process.env.ALIYUN_ASR_SINGLE_MIX_REVIEW_MODEL
    ?? DEFAULT_SINGLE_MIX_REVIEW_MODEL;
  const reviewModel = configuredReviewModel === model
    ? (model === "fun-asr" ? "paraformer-v2" : "fun-asr")
    : configuredReviewModel;
  appendNdjson(eventPath, {
    ts: new Date().toISOString(),
    event: "cloud_asr_single_mix_review_started",
    sourceFile: source.basename,
    primaryModel: model,
    reviewModel,
  });
  const reviewRun = await transcribeFileRecording({
    ...params,
    fileModel: reviewModel,
    singleMixMode: "disabled",
    _preparedDiarization: diarization,
  }, source, eventPath, config, parsedFileUrl.toString());
  const reviewStatus = reviewRun.status === "completed" ? "completed" : reviewRun.reason ?? "review_model_failed";
  const singleMixAnalysis = buildSingleMixAnalysis({
    primarySegments: transcriptSegments,
    reviewSegments: reviewRun.status === "completed" ? reviewRun.transcriptSegments ?? [] : [],
    primaryModel: model,
    reviewModel,
    reviewStatus,
    sourceFile: source.basename,
  });
  speakerDiarization = {
    ...speakerDiarization,
    overlapSpeechHandling: "dual_model_review_with_unresolved_overlap_gating",
    singleMix: {
      status: singleMixAnalysis.status,
      strategy: singleMixAnalysis.strategy,
      reviewModel,
      reviewItemCount: singleMixAnalysis.reviewItemCount,
      explicitOverlapCount: singleMixAnalysis.explicitOverlapCount,
      highSeverityCount: singleMixAnalysis.highSeverityCount,
      sourceSeparationPerformed: false,
      simultaneousSpeechRecoveryGuaranteed: false,
    },
  };
  appendNdjson(eventPath, {
    ts: new Date().toISOString(),
    event: "cloud_asr_single_mix_review_finished",
    sourceFile: source.basename,
    primaryModel: model,
    reviewModel,
    reviewStatus,
    reviewItemCount: singleMixAnalysis.reviewItemCount,
    explicitOverlapCount: singleMixAnalysis.explicitOverlapCount,
  });
  const reviewedTranscriptSegments = normalizeTranscriptSegments(singleMixAnalysis.transcriptSegments, transcriptSegments);
  const singleMixRecord = { ...singleMixAnalysis, transcriptSegments: reviewedTranscriptSegments };
  return {
    ...result,
    speakerDiarization,
    transcriptSegments: reviewedTranscriptSegments,
    singleMixAnalysis: singleMixRecord,
    reviewTaskId: reviewRun.taskId ?? null,
    reviewModel,
    reviewStatus,
  };
}

/** @param {AsrParams} params @param {AsrSource} source @param {string} eventPath @returns {Promise<FileRunResult>} */
async function transcribeOneFile(params, source, eventPath) {
  const config = ossConfig(params);
  const providedFileUrl = "";
  const inputPlan = planDashScopeInput(source.path, {
    inputMode: params.inputMode ?? process.env.ALIYUN_ASR_INPUT_MODE ?? "auto",
    explicitFormat: params.format,
    fileTransportConfigured: Boolean(providedFileUrl || config.configured || params.mockFileProvider === true),
  });
  appendNdjson(eventPath, {
    ts: new Date().toISOString(),
    event: "cloud_asr_input_planned",
    sourceFile: source.basename,
    extension: mediaExtension(source.path),
    inputMode: inputPlan.mode ?? null,
    status: inputPlan.status,
    reason: inputPlan.reason ?? null,
    fileTransportConfigured: Boolean(providedFileUrl || config.configured),
  });
  if (inputPlan.status !== "ready") {
    return blocked(inputPlan.reason ?? "cloud_asr_input_plan_blocked", {
      extension: inputPlan.extension,
      supportedFileExtensions: [...DASHSCOPE_FILE_EXTENSIONS],
      supportedRealtimeFormats: [...DASHSCOPE_REALTIME_FORMATS],
    });
  }
  if (inputPlan.mode === "file") return transcribeFileRecording(params, source, eventPath, config, providedFileUrl);
  return transcribeRealtimeFile({
    ...params,
    ...(typeof inputPlan.format === "string" ? { format: inputPlan.format } : {}),
  }, source, eventPath);
}

/** @param {string[]} paths @returns {Promise<AsrSource[]>} */
async function buildSources(paths) {
  /** @type {AsrSource[]} */
  const sources = [];
  for (let index = 0; index < paths.length; index += 1) {
    const inputPath = paths[index];
    if (!inputPath) throw new Error("cloud_asr_source_path_missing");
    const path = resolve(inputPath);
    const stat = statSync(path);
    sources.push({
      sourceIndex: index,
      path,
      basename: basename(path),
      sizeBytes: stat.size,
      hashSha256: await sha256(path),
      format: audioFormat(path),
      extension: mediaExtension(path),
      mediaType: cloudAsrMediaKind(path) ?? "unknown",
      privacy: "internal",
    });
  }
  return sources;
}

/** @param {AsrParams} params @param {string} outputDir @param {AsrSource[]} sources @param {FileRunResult[]} fileRuns */
function buildOutputs(params, outputDir, sources, fileRuns) {
  const models = [...new Set(fileRuns.map((run) => run.model).filter((value) => typeof value === "string"))];
  const endpoints = [...new Set(fileRuns.map((run) => run.endpoint).filter((value) => typeof value === "string"))];
  const inputModes = [...new Set(fileRuns.map((run) => run.inputMode ?? (String(run.endpoint ?? "").includes("file-transcription") ? "file" : "realtime")))];
  /** @type {Array<UnknownRecord & {sourceIndex: number, sourceFile: string | null}>} */
  const diarizationBySource = fileRuns.map((run, index) => ({
    sourceIndex: index,
    sourceFile: sources[index]?.basename ?? null,
    ...(run.speakerDiarization ?? realtimeSpeakerDiarizationMetadata()),
  }));
  /** @type {Array<UnknownRecord & {sourceIndex: number, sourceFile: string | null}>} */
  const singleMixBySource = fileRuns
    .map((run, index) => {
      if (!run.singleMixAnalysis) return null;
      const { transcriptSegments: _transcriptSegments, ...analysis } = run.singleMixAnalysis;
      return {
        sourceIndex: index,
        sourceFile: sources[index]?.basename ?? null,
        ...analysis,
      };
    })
    .filter((item) => item !== null);
  const singleMix = {
    enabled: singleMixBySource.length > 0,
    inputTopology: singleMixBySource.length > 0 ? "single_mixed_recording" : null,
    statuses: [...new Set(singleMixBySource.map((item) => item.status))],
    reviewItemCount: singleMixBySource.reduce((total, item) => total + Number(item.reviewItemCount ?? 0), 0),
    explicitOverlapCount: singleMixBySource.reduce((total, item) => total + Number(item.explicitOverlapCount ?? 0), 0),
    highSeverityCount: singleMixBySource.reduce((total, item) => total + Number(item.highSeverityCount ?? 0), 0),
    sourceSeparationPerformed: false,
    simultaneousSpeechRecoveryGuaranteed: false,
    artifact: singleMixBySource.length > 0 ? join(outputDir, "asr", "single-mix-analysis.json") : null,
    bySource: singleMixBySource.map((item) => ({
      sourceIndex: item.sourceIndex,
      sourceFile: item.sourceFile,
      status: item.status,
      primaryModel: item.primaryModel,
      reviewModel: item.reviewModel,
      reviewStatus: item.reviewStatus,
      speakerCountDetected: item.speakerCountDetected,
      reviewItemCount: item.reviewItemCount,
      explicitOverlapCount: item.explicitOverlapCount,
      highSeverityCount: item.highSeverityCount,
    })),
  };
  const speakerDiarization = {
    enabled: diarizationBySource.some((item) => item.enabled === true),
    speakerLabelsAvailable: fileRuns.some((run) => (run.transcriptSegments ?? []).some((segment) => segment.speakerId !== null && segment.speakerId !== undefined)),
    statuses: [...new Set(diarizationBySource.map((item) => item.status).filter(Boolean))],
    overlapSpeechSeparationSupported: false,
    singleMix,
    bySource: diarizationBySource,
  };
  const model = models.length === 1 ? models[0] : models.length > 1 ? "mixed" : params.model ?? process.env.ALIYUN_ASR_MODEL ?? DEFAULT_MODEL;
  const endpoint = endpoints.length === 1 ? endpoints[0] : endpoints.length > 1 ? "mixed" : DEFAULT_ENDPOINT;
  const meetingId = params.meetingId ?? `cloud-asr-${new Date().toISOString()}`;
  const meetingTitle = params.meetingTitle ?? meetingId;
  /** @type {TranscriptSegment[]} */
  const transcriptSegments = [];
  /** @type {UnknownRecord[]} */
  const failedChunks = [];
  for (const run of fileRuns) {
    transcriptSegments.push(...(run.transcriptSegments ?? []));
    if (run.status !== "completed") {
      failedChunks.push({
        sourceFile: typeof run.sourceIndex === "number" ? sources[run.sourceIndex]?.basename ?? null : null,
        chunkIndex: 0,
        status: "failed",
        error: run.reason ?? run.failureClass ?? "cloud_asr_failed",
      });
    }
  }
  const rawMediaExternalUpload = fileRuns.some((run) => run.rawMediaExternalUpload === true);
  const sourceRows = sources.map((source, index) => ({
    basename: source.basename,
    path: source.path,
    sizeBytes: source.sizeBytes,
    hashSha256: source.hashSha256,
    sourceIndex: index,
    source: params.source ?? "feishu",
    privacy: params.privacy ?? "internal",
    provider: "aliyun_dashscope_paraformer",
    format: source.format,
    extension: source.extension,
    mediaType: source.mediaType,
    inputMode: fileRuns[index]?.inputMode ?? (String(fileRuns[index]?.endpoint ?? "").includes("file-transcription") ? "file" : "realtime"),
    speakerDiarization: diarizationBySource[index],
    externalAudioUpload: rawMediaExternalUpload,
  }));
  const partial = fileRuns.some((run) => run.status !== "completed");
  const transcript = {
    meetingId,
    chunkSeconds: null,
    transcription: {
      provider: "aliyun_dashscope_paraformer",
      model,
      endpoint,
      inputModes,
      speakerDiarization,
      singleMix,
      externalAudioUpload: rawMediaExternalUpload,
      rawMediaExternalUpload,
    },
    sources: sourceRows,
    transcriptSegments,
    failedChunks,
  };
  const evidence = {
    meetingTitle,
    meetingId,
    builtAt: new Date().toISOString(),
    sources: sourceRows,
    speakerDiarization,
    singleMix,
    transcriptSegments,
    rules: {
      keyClaimsRequireSource: true,
      rawTranscriptLongTermMemory: false,
      externalAudioUpload: rawMediaExternalUpload,
      textEvidenceExternalLlmDefault: "allow",
      rawMediaExternalUploadDefault: rawMediaExternalUpload ? "allow_for_cloud_asr" : "mock_no_upload",
    },
  };
  const summary = {
    status: failedChunks.length > 0 || transcriptSegments.length === 0 ? "needs_review" : "complete",
    meetingId,
    provider: "aliyun_dashscope_paraformer",
    model,
    inputModes,
    speakerDiarization,
    singleMix,
    sourceCount: sourceRows.length,
    transcriptSegments: transcriptSegments.length,
    failedChunks: failedChunks.length,
    partial,
    externalAudioUpload: rawMediaExternalUpload,
    rawMediaExternalUpload,
    textEvidenceExternalLlmDefault: "allow",
    rawMediaExternalUploadDefault: rawMediaExternalUpload ? "allow_for_cloud_asr" : "mock_no_upload",
    outputs: {
      sources: join(outputDir, "evidence", "sources.json"),
      transcript: join(outputDir, "transcripts", "transcript.full.json"),
      readableTranscript: join(outputDir, "transcripts", "transcript.readable.md"),
      evidenceIndex: join(outputDir, "evidence", "evidence-index.json"),
      singleMixAnalysis: singleMix.artifact,
      summary: join(outputDir, "summary.json"),
    },
  };
  writeJson(join(outputDir, "transcripts", "transcript.full.json"), transcript);
  mkdirSync(join(outputDir, "transcripts"), { recursive: true });
  writeFileSync(join(outputDir, "transcripts", "transcript.readable.md"), readableTranscript(meetingTitle, transcriptSegments), "utf8");
  writeJson(join(outputDir, "evidence", "sources.json"), { assets: sourceRows });
  writeJson(join(outputDir, "evidence", "evidence-index.json"), evidence);
  if (singleMix.enabled) {
    writeJson(join(outputDir, "asr", "single-mix-analysis.json"), {
      schemaVersion: "single-mix-analysis-v1",
      builtAt: new Date().toISOString(),
      inputTopology: "single_mixed_recording",
      bySource: singleMixBySource,
      rules: {
        sourceSeparationPerformed: false,
        simultaneousSpeechRecoveryGuaranteed: false,
        reviewTextIsNeverSilentlyMerged: true,
        unresolvedItemsMustNotBecomeCertainMeetingClaims: true,
      },
    });
  }
  const validatedSummary = assertCloudAsrSummary(summary);
  writeJson(join(outputDir, "summary.json"), validatedSummary);
  return validatedSummary;
}

/** @param {AsrParams} params */
export async function transcribeDashScopeAsr(params) {
  const outputDir = resolve(params.outputDir);
  mkdirSync(join(outputDir, "asr"), { recursive: true });
  const runPath = join(outputDir, "asr", "cloud-asr-run.json");
  const eventPath = join(outputDir, "asr", "cloud-asr-events.ndjson");
  const inputPaths = (params.paths ?? []).map((path) => resolve(path));
  if (inputPaths.length === 0) return blocked("cloud_asr_audio_format_rejected", { detail: "no audio paths provided" });
  for (const path of inputPaths) {
    if (!existsSync(path) || statSync(path).size <= 0) {
      return blocked("cloud_asr_audio_format_rejected", { path, detail: "audio path missing or empty" });
    }
  }

  const sources = await buildSources(inputPaths);
  /** @type {FileRunResult[]} */
  const fileRuns = [];
  for (const source of sources) {
    const run = await transcribeOneFile(params, source, eventPath);
    fileRuns.push({ ...run, sourceIndex: source.sourceIndex });
    if (run.status !== "completed") {
      const runRecord = {
        schemaVersion: "cloud-asr-run-v1",
        status: "blocked",
        provider: "aliyun_dashscope_paraformer",
        model: params.model ?? process.env.ALIYUN_ASR_MODEL ?? DEFAULT_MODEL,
        sources: sources.map(({ path, basename: name, sizeBytes, hashSha256, format, extension, mediaType }) => ({ path, basename: name, sizeBytes, hashSha256, format, extension, mediaType })),
        fileRuns,
        failureClass: run.failureClass ?? run.reason,
        rawSecretsReturned: false,
        rawMediaExternalUpload: run.rawMediaExternalUpload === true,
      };
      writeJson(runPath, runRecord);
      return { ...run, runPath, eventsPath: eventPath };
    }
  }
  const summary = buildOutputs(params, outputDir, sources, fileRuns);
  const artifactFileRuns = fileRuns.map((run) => {
    if (!run.singleMixAnalysis) return run;
    const { transcriptSegments: _transcriptSegments, ...singleMixAnalysis } = run.singleMixAnalysis;
    return { ...run, singleMixAnalysis };
  });
  const runRecord = {
    schemaVersion: "cloud-asr-run-v1",
    status: "completed",
    provider: "aliyun_dashscope_paraformer",
    model: summary.model,
    sources: sources.map(({ path, basename: name, sizeBytes, hashSha256, format, extension, mediaType }) => ({ path, basename: name, sizeBytes, hashSha256, format, extension, mediaType })),
    fileRuns: artifactFileRuns,
    outputs: summary.outputs,
    rawSecretsReturned: false,
    rawMediaExternalUpload: summary.rawMediaExternalUpload === true,
  };
  writeJson(runPath, runRecord);
  return {
    status: "completed",
    provider: "aliyun_dashscope_paraformer",
    summary,
    runPath,
    eventsPath: eventPath,
    rawSecretsReturned: false,
    rawMediaExternalUpload: summary.rawMediaExternalUpload === true,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paramsFile = args["params-file"] ? resolve(String(args["params-file"])) : "";
  if (!paramsFile || !existsSync(paramsFile)) throw new Error("dashscope_asr_client requires --params-file");
  const params = JSON.parse(readFileSync(paramsFile, "utf8"));
  const result = await transcribeDashScopeAsr(params);
  if (args.out) writeJson(resolve(String(args.out)), result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const result = blocked("cloud_asr_client_failed", { error: redact(error instanceof Error ? error.stack || error.message : String(error)) });
    process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(1);
  });
}
