#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

const DEFAULT_ENDPOINT = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
const DEFAULT_MODEL = "paraformer-realtime-v2";
const DEFAULT_LANGUAGE_HINTS = ["yue", "zh", "en"];
const SUPPORTED_FORMATS = new Set(["pcm", "wav", "mp3", "opus", "speex", "aac", "amr"]);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
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

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

function appendNdjson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "a" });
}

function redact(value) {
  return String(value ?? "")
    .replace(/bearer\s+[A-Za-z0-9._-]+/gi, "bearer [redacted]")
    .replace(/sk-[A-Za-z0-9._-]+/gi, "sk-[redacted]")
    .slice(0, 4000);
}

function sha256(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function asArray(value, fallback = []) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return fallback;
}

function audioFormat(path, explicitFormat) {
  if (explicitFormat) return String(explicitFormat).toLowerCase().replace(/^\./, "");
  const ext = extname(path).toLowerCase().replace(/^\./, "");
  return ext === "m4a" ? "aac" : ext;
}

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

function buildRunTask({ taskId, model, format, sampleRate, languageHints, vocabularyId }) {
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

function classifyCloudError(errorCode, message = "") {
  const text = `${errorCode ?? ""} ${message}`.toLowerCase();
  if (/auth|forbidden|permission|unauthorized|api.key|apikey|invalid.*key/.test(text)) return "cloud_asr_auth_failed";
  if (/model|not.*available|not.*found/.test(text)) return "cloud_asr_model_unavailable";
  if (/format|sample|audio/.test(text)) return "cloud_asr_audio_format_rejected";
  if (/timeout|timed out/.test(text)) return "cloud_asr_provider_timeout";
  return "cloud_asr_provider_error";
}

async function sendAudioFile(ws, path, frameBytes, frameDelayMs) {
  const handle = createReadStream(path, { highWaterMark: frameBytes });
  for await (const chunk of handle) {
    if (ws.readyState !== WebSocket.OPEN) throw new Error("cloud_asr_websocket_closed");
    ws.send(chunk, { binary: true });
    if (frameDelayMs > 0) await sleep(frameDelayMs);
  }
}

function parseJsonMessage(data) {
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  return JSON.parse(text);
}

async function transcribeOneFile(params, source, eventPath) {
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
    const segments = [];
    for (const eventMessage of events) {
      appendNdjson(eventPath, { ts: new Date().toISOString(), event: eventMessage?.header?.event ?? "mock-event", taskId: "mock-cloud-asr" });
      const sentence = eventMessage?.payload?.output?.sentence;
      if (eventMessage?.header?.event === "task-failed") {
        const reason = classifyCloudError(eventMessage?.header?.error_code, eventMessage?.header?.error_message);
        return blocked(reason, {
          taskId: "mock-cloud-asr",
          errorCode: eventMessage?.header?.error_code ?? null,
          errorMessage: redact(eventMessage?.header?.error_message ?? ""),
        });
      }
      if (!sentence || sentence.heartbeat === true || sentence.end_time === null || !String(sentence.text ?? "").trim()) continue;
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
      format: audioFormat(source.path, params.format),
      sampleRate: Number(params.sampleRate ?? 16000),
      languageHints: asArray(params.languageHints, DEFAULT_LANGUAGE_HINTS),
      vocabularyIdConfigured: false,
      workspaceIdConfigured: false,
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
  if (!SUPPORTED_FORMATS.has(format)) {
    return blocked("cloud_asr_audio_format_rejected", {
      format,
      supportedFormats: [...SUPPORTED_FORMATS],
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
  const segments = [];
  let taskStarted = false;
  let taskFinished = false;
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

  const headers = {
    Authorization: `bearer ${apiKey}`,
    "user-agent": "meeting-agent-pi-runtime",
    "X-DashScope-DataInspection": "enable",
  };
  if (workspaceId) headers["X-DashScope-WorkSpace"] = workspaceId;

  const ws = new WebSocket(endpoint, { headers });

  const result = await new Promise((resolveRun) => {
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

    const finish = (value) => {
      clearTimeout(timer);
      resolveRun(value);
    };

    ws.on("open", () => {
      appendNdjson(eventPath, { ts: new Date().toISOString(), event: "websocket_open", taskId });
      ws.send(JSON.stringify(buildRunTask({ taskId, model, format, sampleRate, languageHints, vocabularyId })));
    });

    ws.on("message", async (data) => {
      let message;
      try {
        message = parseJsonMessage(data);
      } catch (error) {
        appendNdjson(eventPath, { ts: new Date().toISOString(), event: "cloud_asr_unparsed_message", taskId, error: redact(error.message) });
        return;
      }
      const event = message?.header?.event ?? "unknown";
      appendNdjson(eventPath, {
        ts: new Date().toISOString(),
        event,
        taskId,
        errorCode: message?.header?.error_code ?? null,
        errorMessage: message?.header?.error_message ? redact(message.header.error_message) : null,
        sentence: message?.payload?.output?.sentence
          ? {
              begin_time: message.payload.output.sentence.begin_time ?? null,
              end_time: message.payload.output.sentence.end_time ?? null,
              textPreview: String(message.payload.output.sentence.text ?? "").slice(0, 120),
              heartbeat: message.payload.output.sentence.heartbeat ?? null,
            }
          : null,
      });

      if (event === "task-started") {
        taskStarted = true;
        try {
          await sendAudioFile(ws, source.path, frameBytes, frameDelayMs);
          ws.send(JSON.stringify(buildFinishTask(taskId)));
        } catch (error) {
          failure = blocked("cloud_asr_network_unreachable", { taskId, error: redact(error.message) });
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
        const sentence = message?.payload?.output?.sentence;
        if (!sentence || sentence.heartbeat === true || sentence.end_time === null || !String(sentence.text ?? "").trim()) return;
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
          format,
          sampleRate,
          languageHints,
          vocabularyIdConfigured: Boolean(vocabularyId),
          workspaceIdConfigured: Boolean(workspaceId),
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
        const reason = classifyCloudError(message?.header?.error_code, message?.header?.error_message);
        failure = blocked(reason, {
          taskId,
          errorCode: message?.header?.error_code ?? null,
          errorMessage: redact(message?.header?.error_message ?? ""),
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

async function buildSources(paths) {
  const sources = [];
  for (let index = 0; index < paths.length; index += 1) {
    const path = resolve(paths[index]);
    const stat = statSync(path);
    sources.push({
      sourceIndex: index,
      path,
      basename: basename(path),
      sizeBytes: stat.size,
      hashSha256: await sha256(path),
      format: audioFormat(path),
      privacy: "internal",
    });
  }
  return sources;
}

function buildOutputs(params, outputDir, sources, fileRuns) {
  const model = params.model ?? process.env.ALIYUN_ASR_MODEL ?? DEFAULT_MODEL;
  const endpoint = params.endpoint ?? process.env.ALIYUN_ASR_ENDPOINT ?? DEFAULT_ENDPOINT;
  const meetingId = params.meetingId ?? `cloud-asr-${new Date().toISOString()}`;
  const meetingTitle = params.meetingTitle ?? meetingId;
  const transcriptSegments = [];
  const failedChunks = [];
  for (const run of fileRuns) {
    transcriptSegments.push(...(run.transcriptSegments ?? []));
    if (run.status !== "completed") {
      failedChunks.push({
        sourceFile: sources[run.sourceIndex]?.basename ?? null,
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
    externalAudioUpload: rawMediaExternalUpload,
  }));
  const partial = fileRuns.some((run) => run.status !== "completed");
  const transcript = {
    meetingId,
    chunkSeconds: null,
    transcription: {
      provider: "aliyun_dashscope_paraformer",
      model,
      endpoint: "dashscope-websocket",
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
      evidenceIndex: join(outputDir, "evidence", "evidence-index.json"),
      summary: join(outputDir, "summary.json"),
    },
  };
  writeJson(join(outputDir, "transcripts", "transcript.full.json"), transcript);
  writeJson(join(outputDir, "evidence", "sources.json"), { assets: sourceRows });
  writeJson(join(outputDir, "evidence", "evidence-index.json"), evidence);
  writeJson(join(outputDir, "summary.json"), summary);
  return summary;
}

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
        sources: sources.map(({ path, basename: name, sizeBytes, hashSha256, format }) => ({ path, basename: name, sizeBytes, hashSha256, format })),
        fileRuns,
        failureClass: run.failureClass ?? run.reason,
        rawSecretsReturned: false,
        rawMediaExternalUpload: true,
      };
      writeJson(runPath, runRecord);
      return { ...run, runPath, eventsPath: eventPath };
    }
  }
  const summary = buildOutputs(params, outputDir, sources, fileRuns);
  const runRecord = {
    schemaVersion: "cloud-asr-run-v1",
    status: "completed",
    provider: "aliyun_dashscope_paraformer",
    model: summary.model,
    sources: sources.map(({ path, basename: name, sizeBytes, hashSha256, format }) => ({ path, basename: name, sizeBytes, hashSha256, format })),
    fileRuns,
    outputs: summary.outputs,
    rawSecretsReturned: false,
    rawMediaExternalUpload: true,
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
