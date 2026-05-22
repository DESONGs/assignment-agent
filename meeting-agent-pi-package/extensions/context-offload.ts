import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(extensionDir);
const workspaceDir = dirname(packageDir);

const SECRET_PATTERNS = [
  /(app_secret|client_secret|refresh_token|access_token|authorization|cookie|session)\s*[:=]\s*["']?[A-Za-z0-9._\-]{8,}/i,
  /bearer\s+[A-Za-z0-9._\-]{8,}/i,
  /\b(FEISHU_APP_SECRET|DEEPSEEK_API_KEY|XIAOMI_TOKEN_PLAN_SGP_API_KEY)\b/i,
];

const MAX_PREVIEW_CHARS = 1200;
const MAX_READ_CHARS = 8000;

function defaultOutputRoot() {
  return join(workspaceDir, "runtime-runs");
}

function isInside(parent: string, child: string) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeSegment(input: string, fallback: string) {
  const value = input.trim() || fallback;
  const cleaned = value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 140);
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new Error("unsafe_runtime_segment_blocked");
  }
  return cleaned;
}

function safeArtifactName(input: string) {
  const value = input.trim();
  if (!value || value !== basename(value) || value === "." || value === "..") {
    throw new Error("unsafe_artifact_name_blocked");
  }
  const cleaned = value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 140);
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new Error("unsafe_artifact_name_blocked");
  }
  return cleaned;
}

function runtimeRoot(outputRoot?: string) {
  const root = resolve(outputRoot ?? defaultOutputRoot());
  if (!isInside(workspaceDir, root)) {
    throw new Error("runtime_output_root_outside_workspace_blocked");
  }
  return root;
}

function runDir(runId: string, outputRoot?: string) {
  const root = runtimeRoot(outputRoot);
  const path = resolve(root, safeSegment(runId, "run"));
  if (!isInside(root, path)) {
    throw new Error("runtime_run_dir_outside_root_blocked");
  }
  return path;
}

function offloadDir(runId: string, outputRoot?: string) {
  return join(runDir(runId, outputRoot), "offload");
}

function artifactIndexPath(runId: string, outputRoot?: string) {
  return join(runDir(runId, outputRoot), "artifacts.json");
}

function sanitizeText(text: string) {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    return text.replace(/([A-Z0-9_]*(?:SECRET|TOKEN|COOKIE|SESSION|AUTHORIZATION)[A-Z0-9_]*\s*[:=]\s*)["']?[^"'\s]+/gi, "$1[REDACTED]");
  }
  return text;
}

function payloadToText(payload: unknown, payloadType: string) {
  if (payloadType === "text") return sanitizeText(String(payload ?? ""));
  return sanitizeText(JSON.stringify(payload ?? null, null, 2));
}

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function readIndex(path: string) {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8"));
}

function appendIndex(path: string, pointer: unknown) {
  const existing = readIndex(path);
  existing.push(pointer);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(existing, null, 2) + "\n", "utf8");
}

function assertInsideRuntime(path: string, outputRoot?: string) {
  const root = runtimeRoot(outputRoot);
  const resolved = resolve(path);
  if (!isInside(root, resolved)) {
    throw new Error("offload_read_outside_runtime_runs_blocked");
  }
  return resolved;
}

function boundedCount(value: unknown, fallback: number, max: number) {
  const numberValue = Number(value ?? fallback);
  if (!Number.isFinite(numberValue) || numberValue < 0) return fallback;
  return Math.min(Math.floor(numberValue), max);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "context_offload_plan",
    label: "Context Offload Plan",
    description: "Decide whether raw transcript/evidence should be offloaded from main context into local artifacts.",
    parameters: Type.Object({
      inputSummary: Type.String(),
      estimatedInputTokens: Type.Optional(Type.Number()),
      segmentCount: Type.Optional(Type.Number()),
      rawTranscriptBytes: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params) {
      const shouldOffload =
        (params.estimatedInputTokens ?? 0) > 12_000 ||
        (params.segmentCount ?? 0) > 80 ||
        (params.rawTranscriptBytes ?? 0) > 120_000;
      const details = {
        shouldOffload,
        inputSummary: params.inputSummary,
        thresholds: {
          estimatedInputTokens: 12_000,
          segmentCount: 80,
          rawTranscriptBytes: 120_000,
        },
        retainInMainContext: ["topicMap", "internalEvidenceMap", "qaGate", "openQuestions", "artifactPointers"],
        offloadTargets: ["raw transcript", "full evidence index", "large draft variants"],
      };
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });

  pi.registerTool({
    name: "context_offload_write",
    label: "Context Offload Write",
    description: "Write transcript/evidence/draft payloads to a local artifact and return a small pointer for main context.",
    parameters: Type.Object({
      runId: Type.String(),
      artifactName: Type.String(),
      payload: Type.Any(),
      payloadType: Type.Optional(Type.Union([Type.Literal("json"), Type.Literal("text")])),
      outputRoot: Type.Optional(Type.String()),
      maxPreviewChars: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params) {
      try {
        const payloadType = params.payloadType ?? "json";
        const ext = payloadType === "text" ? ".txt" : ".json";
        const artifactName = safeArtifactName(params.artifactName);
        const dir = offloadDir(params.runId, params.outputRoot);
        const path = resolve(dir, extname(artifactName) ? artifactName : `${artifactName}${ext}`);
        if (!isInside(dir, path)) {
          throw new Error("offload_write_outside_run_blocked");
        }
        const text = payloadToText(params.payload, payloadType);
        const previewChars = boundedCount(params.maxPreviewChars, 800, MAX_PREVIEW_CHARS);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text + (text.endsWith("\n") ? "" : "\n"), "utf8");
        const pointer = {
          artifactName: basename(path),
          artifactPath: path,
          payloadType,
          sha256: sha256(text),
          sizeBytes: Buffer.byteLength(text, "utf8"),
          preview: text.slice(0, previewChars),
          previewChars,
          createdAt: new Date().toISOString(),
          rawSecretsReturned: false,
        };
        appendIndex(artifactIndexPath(params.runId, params.outputRoot), pointer);
        return { content: [{ type: "text", text: JSON.stringify(pointer, null, 2) }], details: pointer };
      } catch (error) {
        const blocked = {
          status: "blocked",
          reason: error instanceof Error ? error.message : String(error),
          artifactName: params.artifactName,
          rawSecretsReturned: false,
        };
        return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
      }
    },
  });

  pi.registerTool({
    name: "context_offload_read",
    label: "Context Offload Read",
    description: "Read a bounded slice from a local offloaded artifact. This is for evidence lookup, not long-term memory.",
    parameters: Type.Object({
      artifactPath: Type.String(),
      outputRoot: Type.Optional(Type.String()),
      maxChars: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params) {
      try {
        const path = assertInsideRuntime(params.artifactPath, params.outputRoot);
        const text = readFileSync(path, "utf8");
        const maxChars = boundedCount(params.maxChars, 4000, MAX_READ_CHARS);
        const details = {
          artifactPath: path,
          sizeBytes: Buffer.byteLength(text, "utf8"),
          returnedChars: Math.min(text.length, maxChars),
          truncated: text.length > maxChars,
          content: text.slice(0, maxChars),
        };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      } catch (error) {
        const blocked = {
          status: "blocked",
          reason: error instanceof Error ? error.message : String(error),
          artifactPath: params.artifactPath,
        };
        return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
      }
    },
  });
}
