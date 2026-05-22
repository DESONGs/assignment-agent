import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { extname, basename, resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

type LocalAsrServiceResult = {
  ok: boolean;
  statusCode: number;
  body: unknown;
  text: string;
  error?: string;
};

const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(extensionDir);
const workspaceDir = dirname(packageDir);

function sha256(path: string) {
  return new Promise<string>((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer) => {
      hash.update(chunk);
    });
    stream.on("error", rejectHash);
    stream.on("end", () => {
      resolveHash(hash.digest("hex"));
    });
  });
}

function mediaType(path: string) {
  const ext = extname(path).toLowerCase();
  if ([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"].includes(ext)) return "audio";
  if ([".mp4", ".mov", ".mkv", ".avi", ".webm"].includes(ext)) return "video";
  if ([".png", ".jpg", ".jpeg", ".webp", ".heic"].includes(ext)) return "image";
  if ([".txt", ".md", ".json", ".srt", ".vtt"].includes(ext)) return "text";
  return "unknown";
}

function localAsrBearerToken() {
  return process.env.LOCAL_ASR_BEARER_TOKEN?.trim() || null;
}

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (normalized === "localhost" || normalized === "::1") return true;

  const ipv4 = normalized.split(".");
  if (ipv4.length !== 4) return false;
  const octets = ipv4.map((part) => Number(part));
  return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && octets[0] === 127;
}

function normalizeLocalAsrServiceUrl(serviceUrl: string) {
  let url: URL;
  try {
    url = new URL(serviceUrl);
  } catch {
    throw new Error("LOCAL_ASR_SERVICE_URL must be a valid http(s) loopback URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("LOCAL_ASR_SERVICE_URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("LOCAL_ASR_SERVICE_URL must not include credentials.");
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error("LOCAL_ASR_SERVICE_URL must point to localhost, 127.0.0.0/8, or ::1.");
  }

  return url.origin;
}

function postJsonToAsrService(
  serviceUrl: string,
  payload: unknown,
  timeoutMs: number,
  bearerToken: string | null,
): Promise<LocalAsrServiceResult> {
  return new Promise((resolveRequest) => {
    const base = serviceUrl.endsWith("/") ? serviceUrl : `${serviceUrl}/`;
    const url = new URL("/v1/transcriptions", base);
    const body = JSON.stringify(payload);
    const requestImpl = url.protocol === "https:" ? httpsRequest : httpRequest;
    let responseText = "";
    const maxBytes = 20 * 1024 * 1024;

    const req = requestImpl(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(body, "utf8"),
          ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          responseText += chunk;
          if (Buffer.byteLength(responseText, "utf8") > maxBytes) {
            req.destroy(new Error("local ASR service response exceeded 20MB"));
          }
        });
        res.on("end", () => {
          let parsed: unknown = null;
          try {
            parsed = responseText ? JSON.parse(responseText) : null;
          } catch {
            parsed = null;
          }
          resolveRequest({
            ok: Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300),
            statusCode: res.statusCode ?? 0,
            body: parsed,
            text: responseText,
          });
        });
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error("local ASR service request timed out"));
    });
    req.on("error", (error: NodeJS.ErrnoException) => {
      resolveRequest({
        ok: false,
        statusCode: 0,
        body: null,
        text: responseText,
        error: error.message,
      });
    });
    req.write(body);
    req.end();
  });
}

function defaultModelDir() {
  return process.env.LOCAL_ASR_MODEL_DIR ?? join(workspaceDir, "models/Qwen3-ASR-1.7B-MLX-4bit");
}

function defaultAsrServiceUrl() {
  return process.env.LOCAL_ASR_SERVICE_URL ?? "http://127.0.0.1:8765";
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "meeting_index_local_media",
    label: "Index Local Meeting Media",
    description:
      "Create evidence metadata for local meeting media without uploading it.",
    parameters: Type.Object({
      paths: Type.Array(Type.String({ description: "Local file paths to index." })),
      source: Type.Optional(Type.String({ description: "Source label, e.g. rokid-export or local-upload." })),
      privacy: Type.Optional(
        Type.Union([
          Type.Literal("private"),
          Type.Literal("internal"),
          Type.Literal("customer-confidential"),
        ]),
      ),
    }),
    async execute(_toolCallId, params) {
      const assets = await Promise.all(params.paths.map(async (path) => {
        const abs = resolve(path);
        const stat = statSync(abs);
        return {
          path: abs,
          basename: basename(abs),
          type: mediaType(abs),
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          hashSha256: await sha256(abs),
          source: params.source ?? "local",
          privacy: params.privacy ?? "private",
        };
      }));

      return {
        content: [{ type: "text", text: JSON.stringify({ assets }, null, 2) }],
        details: { assets },
      };
    },
  });

  pi.registerTool({
    name: "meeting_transcribe_local_asr",
    label: "Transcribe Meeting With Local ASR",
    description:
      "Transcribe locally normalized 16-bit PCM WAV meeting audio with local Qwen3-ASR MLX 4-bit. Product audio inputs are normalized by the local runtime before this tool; raw audio is not uploaded.",
    parameters: Type.Object({
      paths: Type.Array(Type.String({ description: "Local normalized 16k mono 16-bit PCM WAV paths to transcribe." })),
      meetingId: Type.String({ description: "Meeting id used in output metadata." }),
      outputDir: Type.String({ description: "Artifact output directory." }),
      meetingTitle: Type.Optional(Type.String({ description: "Meeting title for evidence-index.json." })),
      chunkSeconds: Type.Optional(Type.Number({ description: "Fixed chunk seconds. Defaults to 30." })),
      language: Type.Optional(Type.String({ description: "ASR language. Defaults to Chinese." })),
      context: Type.Optional(Type.String({ description: "Domain context for ASR vocabulary bias." })),
      serviceUrl: Type.Optional(Type.String({ description: "Local ASR HTTP service URL. Must be localhost/loopback. Defaults to LOCAL_ASR_SERVICE_URL or http://127.0.0.1:8765." })),
      modelDir: Type.Optional(Type.String({ description: "Local MLX ASR model directory. Defaults to models/Qwen3-ASR-1.7B-MLX-4bit." })),
      maxNewTokens: Type.Optional(Type.Number({ description: "ASR max_new_tokens. Defaults to 512." })),
      source: Type.Optional(Type.String({ description: "Source label written into metadata. Defaults to local." })),
      privacy: Type.Optional(Type.String({ description: "Privacy label written into metadata. Defaults to private." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Execution timeout in milliseconds. Defaults to 7200000." })),
      limitChunks: Type.Optional(Type.Number({ description: "Optional debug limit per file." })),
    }),
    async execute(_toolCallId, params) {
      const resolvedPaths = params.paths.map((path) => resolve(path));
      const outputDir = resolve(params.outputDir);
      const modelDir = resolve(params.modelDir ?? defaultModelDir());
      const timeoutMs = params.timeoutMs ?? 7_200_000;
      const chunkSeconds = params.chunkSeconds ?? 30;
      const language = params.language ?? "Chinese";
      const context = params.context ?? "会议录音，中文为主，可能夹杂英文术语、人名、产品名。";
      const requestedServiceUrl = params.serviceUrl ?? defaultAsrServiceUrl();
      let serviceUrl: string;
      try {
        serviceUrl = normalizeLocalAsrServiceUrl(requestedServiceUrl);
      } catch (error) {
        const blocked = {
          status: "blocked",
          reason: "local_asr_service_url_not_allowed",
          provider: "local-qwen3-asr",
          mode: "local-http-api",
          error: error instanceof Error ? error.message : String(error),
          rawAudioUploaded: false,
          externalAudioUpload: false,
        };
        return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
      }
      const payload = {
        paths: resolvedPaths,
        meetingId: params.meetingId,
        meetingTitle: params.meetingTitle ?? params.meetingId,
        outputDir,
        modelDir,
        chunkSeconds,
        language,
        context,
        maxNewTokens: params.maxNewTokens ?? 512,
        source: params.source ?? "local",
        privacy: params.privacy ?? "private",
        limitChunks: params.limitChunks,
      };
      const bearerToken = localAsrBearerToken();
      const serviceResult = await postJsonToAsrService(serviceUrl, payload, timeoutMs, bearerToken);
      if (!serviceResult.ok) {
        const blocked = {
          status: "blocked",
          reason: "local_asr_service_unavailable",
          provider: "local-qwen3-asr",
          mode: "local-http-api",
          serviceUrl,
          authHeaderSent: Boolean(bearerToken),
          httpStatus: serviceResult.statusCode,
          error: serviceResult.error ?? null,
          response: serviceResult.body,
          responseTail: serviceResult.text.slice(-4000),
          rawAudioUploaded: false,
          externalAudioUpload: false,
          nextStep:
            "Start the local ASR HTTP service, then rerun meeting_transcribe_local_asr. This tool has no script fallback by design.",
        };
        return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
      }

      const details = {
        provider: "local-qwen3-asr",
        mode: "local-http-api",
        serviceUrl,
        authHeaderSent: Boolean(bearerToken),
        rawAudioUploaded: false,
        externalAudioUpload: false,
        response: serviceResult.body,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });

  pi.registerTool({
    name: "meeting_build_evidence_index",
    label: "Build Meeting Evidence Index",
    description:
      "Normalize transcript segments, file metadata, and context references into an evidence index.",
    parameters: Type.Object({
      meetingTitle: Type.String(),
      sources: Type.Array(Type.Any()),
      transcriptSegments: Type.Optional(Type.Array(Type.Any())),
    }),
    async execute(_toolCallId, params) {
      const transcriptSegments = params.transcriptSegments ?? [];
      const segmentRefs = transcriptSegments.slice(0, 200).map((segment, index) => ({
        id: segment?.id ?? segment?.segmentId ?? segment?.evidenceId ?? `segment_${index}`,
        startSec: segment?.startSec ?? null,
        endSec: segment?.endSec ?? null,
        source: segment?.source ?? segment?.sourceFile ?? segment?.basename ?? null,
      }));
      const evidence = {
        meetingTitle: params.meetingTitle,
        builtAt: new Date().toISOString(),
        sources: params.sources,
        transcriptSegmentCount: transcriptSegments.length,
        transcriptSegmentsRetainedInToolOutput: false,
        transcriptSegmentRefs: segmentRefs,
        transcriptSegmentRefsTruncated: transcriptSegments.length > segmentRefs.length,
        rawTranscriptPointerRequired: transcriptSegments.length > 0,
        rules: {
          keyClaimsRequireSource: true,
          rawTranscriptLongTermMemory: false,
          externalAudioUpload: false,
          textEvidenceExternalLlmDefault: "allow",
          rawMediaExternalUploadDefault: "deny",
          publishConfirmationOptional: true,
        },
      };

      return {
        content: [{ type: "text", text: JSON.stringify(evidence, null, 2) }],
        details: evidence,
      };
    },
  });
}
