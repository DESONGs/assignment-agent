import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { accessSync, constants, cpSync, existsSync, mkdirSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { CLOUD_ASR_MEDIA_EXTENSIONS } from "./asr_media_formats.mjs";

export const AUDIO_NORMALIZE_VERSION = "audio-normalize-v1";
export const TARGET_AUDIO_SPEC = {
  container: "wav",
  codec: "pcm_s16le",
  sampleRate: 16000,
  channels: 1,
  bitsPerSample: 16,
  fileName: "normalized-16k-mono-s16.wav",
};
export const SUPPORTED_AUDIO_EXTENSIONS = new Set(CLOUD_ASR_MEDIA_EXTENSIONS);
const TRANSCODER_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * @typedef {{ tool: "ffmpeg" | "afconvert", path: string }} AudioTranscoder
 * @typedef {{ path: string, name?: unknown, sha256?: string }} AudioInput
 * @typedef {{ transcoder?: string, workspaceDir?: string, timeoutMs?: number }} AudioNormalizeOptions
 * @typedef {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} CommandOptions
 * @typedef {{ exitCode: number, stdout: string, stderr: string, timedOut: boolean, error?: string }} CommandResult
 * @typedef {{ audioFormat: number, channels: number, sampleRate: number, bitsPerSample: number }} WavFormat
 * @typedef {WavFormat & { hasData: boolean }} WavHeader
 */

function nowIso() {
  return new Date().toISOString();
}

/** @param {string} parent @param {string} child */
function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** @param {unknown} value @param {string} [fallback] */
function safeSegment(value, fallback = "audio") {
  const cleaned = String(value || fallback).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned;
}

/** @param {unknown} value */
function redactString(value) {
  return String(value ?? "")
    .replace(/(app_secret|client_secret|refresh_token|access_token|authorization|cookie|session)\s*[:=]\s*["']?[^"',\s]+/gi, "[redacted]")
    .replace(/bearer\s+[A-Za-z0-9._-]+/gi, "[redacted]");
}

/** @param {string} path */
function sha256File(path) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** @param {string | null | undefined} command */
function executablePath(command) {
  if (!command) return null;
  if (command.includes("/")) {
    const resolved = resolve(command);
    try {
      accessSync(resolved, constants.X_OK);
      return resolved;
    } catch {
      return null;
    }
  }
  for (const dir of String(process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

/** @param {AudioNormalizeOptions} [options] @returns {AudioTranscoder | null} */
export function selectAudioTranscoder(options = {}) {
  const requested = options.transcoder ?? process.env.FEISHU_AGENT_AUDIO_TRANSCODER;
  const disabled = /^(1|true|yes|on)$/i.test(process.env.FEISHU_AGENT_AUDIO_NORMALIZE_DISABLE_TRANSCODER ?? "");
  if (disabled || requested === "none") return null;
  const candidates = requested
    ? [requested]
    : ["ffmpeg", "afconvert"];
  for (const candidate of candidates) {
    const path = executablePath(candidate);
    if (!path) continue;
    const tool = basename(path).toLowerCase().includes("ffmpeg") ? "ffmpeg" : "afconvert";
    return { tool, path };
  }
  return null;
}

/** @param {string} command @param {string[]} args @param {CommandOptions} [options] @returns {Promise<CommandResult>} */
function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs ?? TRANSCODER_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 2_000_000) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 2_000_000) child.kill("SIGTERM");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      const errorCode = typeof error === "object" && error !== null && "code" in error ? error.code : null;
      resolveCommand({ exitCode: errorCode === "ENOENT" ? 127 : 1, stdout, stderr, timedOut, error: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolveCommand({ exitCode: code ?? (signal ? 128 : 1), stdout, stderr, timedOut });
    });
    child.stdin.end();
  });
}

/** @param {string} path @returns {WavHeader} */
export function readWavHeader(path) {
  const fd = openSync(path, "r");
  const header = Buffer.alloc(128 * 1024);
  let bytesRead = 0;
  try {
    bytesRead = readSync(fd, header, 0, header.length, 0);
  } finally {
    closeSync(fd);
  }
  if (bytesRead < 44 || header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("wav_header_invalid");
  }
  let offset = 12;
  /** @type {WavFormat | null} */
  let fmt = null;
  let hasData = false;
  while (offset + 8 <= bytesRead) {
    const chunkId = header.toString("ascii", offset, offset + 4);
    const chunkSize = header.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (chunkId === "fmt " && dataOffset + Math.min(chunkSize, 16) <= bytesRead) {
      fmt = {
        audioFormat: header.readUInt16LE(dataOffset),
        channels: header.readUInt16LE(dataOffset + 2),
        sampleRate: header.readUInt32LE(dataOffset + 4),
        bitsPerSample: header.readUInt16LE(dataOffset + 14),
      };
    } else if (chunkId === "data") {
      hasData = true;
    }
    offset = dataOffset + chunkSize + (chunkSize % 2);
  }
  if (!fmt) throw new Error("wav_fmt_chunk_missing");
  return { ...fmt, hasData };
}

/** @param {WavHeader} header */
function targetSpecMatches(header) {
  return (
    header.audioFormat === 1 &&
    header.channels === TARGET_AUDIO_SPEC.channels &&
    header.sampleRate === TARGET_AUDIO_SPEC.sampleRate &&
    header.bitsPerSample === TARGET_AUDIO_SPEC.bitsPerSample &&
    header.hasData === true
  );
}

/** @param {string} path */
function validateNormalizedWav(path) {
  const header = readWavHeader(path);
  const valid = targetSpecMatches(header);
  return {
    valid,
    header,
    expected: TARGET_AUDIO_SPEC,
    reason: valid ? null : "audio_normalize_output_format_invalid",
  };
}

/** @param {AudioTranscoder} transcoder @param {string} inputPath @param {string} outputPath */
function transcodeArgs(transcoder, inputPath, outputPath) {
  if (transcoder.tool === "ffmpeg") {
    return ["-hide_banner", "-nostdin", "-y", "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le", outputPath];
  }
  return ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", inputPath, outputPath];
}

/** @param {string} reason @param {Record<string, unknown>} [details] */
function blockedArtifact(reason, details = {}) {
  return {
    schemaVersion: AUDIO_NORMALIZE_VERSION,
    version: AUDIO_NORMALIZE_VERSION,
    status: "blocked",
    reason,
    userMessage: "目前音频格式暂不支持自动转码。",
    targetSpec: TARGET_AUDIO_SPEC,
    generatedAt: nowIso(),
    normalizedAudios: [],
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
    ...details,
  };
}

/** @param {AudioInput[]} audios @param {string} outputDir @param {AudioNormalizeOptions} [options] */
export async function normalizeAudioBatch(audios, outputDir, options = {}) {
  const workspaceDir = options.workspaceDir ? resolve(options.workspaceDir) : null;
  const normalizedDir = resolve(outputDir);
  if (workspaceDir && !isInside(workspaceDir, normalizedDir)) {
    return blockedArtifact("audio_normalize_output_dir_outside_workspace_blocked");
  }
  mkdirSync(normalizedDir, { recursive: true });
  const startedAt = nowIso();
  /** @type {Array<Record<string, unknown>>} */
  const normalizedAudios = [];
  /** @type {AudioTranscoder | null} */
  let selectedTranscoder = null;

  for (const [index, audio] of audios.entries()) {
    const inputPath = resolve(audio.path);
    const sourceName = String(audio.name ?? basename(inputPath));
    const ext = extname(sourceName).toLowerCase() || extname(inputPath).toLowerCase();
    if (!existsSync(inputPath)) {
      return blockedArtifact("audio_source_missing", { failedInput: { index, extension: ext } });
    }
    if (!SUPPORTED_AUDIO_EXTENSIONS.has(ext)) {
      return blockedArtifact("audio_format_not_supported", {
        supportedExtensions: [...SUPPORTED_AUDIO_EXTENSIONS],
        failedInput: { index, extension: ext },
      });
    }
    const outputPath = join(normalizedDir, `${String(index).padStart(2, "0")}-${TARGET_AUDIO_SPEC.fileName}`);
    let action = "transcoded";
    /** @type {ReturnType<typeof validateNormalizedWav> | null} */
    let validationBefore = null;

    if (ext === ".wav") {
      try {
        validationBefore = validateNormalizedWav(inputPath);
        if (validationBefore.valid) {
          cpSync(inputPath, outputPath, { force: true });
          action = "copied_already_normalized_wav";
        }
      } catch {
        validationBefore = null;
      }
    }

    if (action === "transcoded") {
      selectedTranscoder ??= selectAudioTranscoder(options);
      if (!selectedTranscoder) {
        return blockedArtifact("audio_transcoder_unavailable", {
          supportedExtensions: [...SUPPORTED_AUDIO_EXTENSIONS],
          failedInput: { index, extension: ext },
        });
      }
      const result = await runCommand(selectedTranscoder.path, transcodeArgs(selectedTranscoder, inputPath, outputPath), {
        timeoutMs: options.timeoutMs ?? TRANSCODER_TIMEOUT_MS,
      });
      if (result.exitCode !== 0 || !existsSync(outputPath)) {
        return blockedArtifact("audio_normalize_failed", {
          transcoder: { tool: selectedTranscoder.tool, path: selectedTranscoder.path },
          failedInput: { index, extension: ext },
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          error: result.error ?? null,
          stderrTail: redactString(result.stderr).slice(-1200),
        });
      }
    }

    const validation = validateNormalizedWav(outputPath);
    if (!validation.valid) {
      return blockedArtifact("audio_normalize_failed", {
        failedInput: { index, extension: ext },
        validation,
      });
    }
    const stat = statSync(outputPath);
    normalizedAudios.push({
      index,
      action,
      sourceName,
      sourceExtension: ext,
      sourceHashSha256: audio.sha256 ?? sha256File(inputPath),
      sourceSizeBytes: statSync(inputPath).size,
      normalizedPath: outputPath,
      normalizedSizeBytes: stat.size,
      normalizedHashSha256: sha256File(outputPath),
      targetSpec: TARGET_AUDIO_SPEC,
      validation: {
        audioFormat: validation.header.audioFormat,
        channels: validation.header.channels,
        sampleRate: validation.header.sampleRate,
        bitsPerSample: validation.header.bitsPerSample,
      },
      rawMediaExternalUpload: false,
    });
  }

  return {
    schemaVersion: AUDIO_NORMALIZE_VERSION,
    version: AUDIO_NORMALIZE_VERSION,
    status: "completed",
    generatedAt: nowIso(),
    startedAt,
    targetSpec: TARGET_AUDIO_SPEC,
    transcoder: selectedTranscoder ? { tool: selectedTranscoder.tool, path: selectedTranscoder.path } : { tool: "copy", path: null },
    supportedExtensions: [...SUPPORTED_AUDIO_EXTENSIONS],
    normalizedAudios,
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  };
}
