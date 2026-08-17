import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { spawn } from "node:child_process";

import { selectAudioTranscoder } from "./audio_normalize_helpers.mjs";

export const DIARIZATION_RECOMMENDED_MAX_DURATION_SECONDS = 2 * 60 * 60;

function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function runCommand(command, args, timeoutMs = 20 * 60 * 1000) {
  return new Promise((resolveCommand) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 2_000_000) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 2_000_000) child.kill("SIGTERM");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      const errorCode = typeof error === "object" && error !== null && "code" in error ? error.code : null;
      resolveCommand({ exitCode: errorCode === "ENOENT" ? 127 : 1, stdout, stderr, timedOut, error: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveCommand({ exitCode: code ?? (signal ? 128 : 1), stdout, stderr, timedOut });
    });
  });
}

export function normalizeDiarizationPreference(value) {
  if (value === true || /^(1|true|yes|on|enabled)$/i.test(String(value ?? "").trim())) return "enabled";
  if (value === false || /^(0|false|no|off|disabled)$/i.test(String(value ?? "").trim())) return "disabled";
  return "auto";
}

export function normalizeSpeakerCount(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const count = Number(value);
  return Number.isInteger(count) && count >= 2 && count <= 100 ? count : Number.NaN;
}

export async function probeMediaAudio(path, options = {}) {
  const command = options.ffprobePath ?? "ffprobe";
  const result = await runCommand(command, [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=channels,sample_rate:format=duration",
    "-of", "json",
    path,
  ], Number(options.timeoutMs ?? 60_000));
  if (result.exitCode !== 0) {
    return { status: "unavailable", reason: result.exitCode === 127 ? "ffprobe_unavailable" : "media_probe_failed", exitCode: result.exitCode };
  }
  try {
    const payload = JSON.parse(result.stdout || "{}");
    const stream = Array.isArray(payload.streams) ? payload.streams[0] : null;
    if (!stream) return { status: "blocked", reason: "audio_stream_missing" };
    return {
      status: "completed",
      channels: Number(stream.channels ?? 0) || null,
      sampleRate: Number(stream.sample_rate ?? 0) || null,
      durationSeconds: Number(payload.format?.duration ?? 0) || null,
    };
  } catch {
    return { status: "unavailable", reason: "media_probe_output_invalid" };
  }
}

function safeStem(value) {
  const extension = extname(String(value ?? ""));
  return basename(String(value ?? "media"), extension).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 100) || "media";
}

async function prepareMonoSource(source, outputDir, options = {}) {
  const transcoder = selectAudioTranscoder({ transcoder: options.transcoder });
  if (!transcoder) return { status: "blocked", reason: "diarization_transcoder_unavailable" };
  mkdirSync(outputDir, { recursive: true });
  const stem = safeStem(source.basename);
  const outputPath = transcoder.tool === "ffmpeg"
    ? join(outputDir, `${stem}-diarization-16k-mono.m4a`)
    : join(outputDir, `${stem}-diarization-16k-mono.wav`);
  const args = transcoder.tool === "ffmpeg"
    ? ["-hide_banner", "-nostdin", "-y", "-i", source.path, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "64k", outputPath]
    : ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", source.path, outputPath];
  const result = await runCommand(transcoder.path, args, Number(options.timeoutMs ?? 20 * 60 * 1000));
  if (result.exitCode !== 0 || !existsSync(outputPath)) {
    return {
      status: "blocked",
      reason: "diarization_mono_prepare_failed",
      transcoder: transcoder.tool,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    };
  }
  const stat = statSync(outputPath);
  return {
    status: "completed",
    source: {
      ...source,
      path: outputPath,
      basename: basename(outputPath),
      sizeBytes: stat.size,
      hashSha256: await sha256File(outputPath),
      format: extname(outputPath).slice(1),
      extension: extname(outputPath),
      mediaType: "audio",
    },
    transcoder: transcoder.tool,
  };
}

export async function prepareFileDiarization(source, outputDir, options = {}) {
  const preference = normalizeDiarizationPreference(options.enabled);
  const speakerCount = normalizeSpeakerCount(options.speakerCount);
  if (Number.isNaN(speakerCount)) {
    return { status: "blocked", reason: "cloud_asr_speaker_count_invalid", speakerCount: options.speakerCount };
  }
  const probe = await probeMediaAudio(source.path, options);
  if (probe.status === "blocked") return { status: "blocked", reason: "cloud_asr_audio_stream_missing" };

  const durationOverRecommendation = Number(probe.durationSeconds ?? 0) > DIARIZATION_RECOMMENDED_MAX_DURATION_SECONDS;
  const explicitlyEnabled = preference === "enabled";
  const enabled = preference !== "disabled" && (!durationOverRecommendation || explicitlyEnabled);
  const baseMetadata = {
    requested: preference,
    enabled,
    status: enabled ? "preparing" : preference === "disabled" ? "disabled_by_config" : "disabled_duration_over_recommendation",
    speakerCountHint: speakerCount,
    sourceChannels: probe.channels ?? null,
    sourceSampleRate: probe.sampleRate ?? null,
    sourceDurationSeconds: probe.durationSeconds ?? null,
    recommendedMaxDurationSeconds: DIARIZATION_RECOMMENDED_MAX_DURATION_SECONDS,
    inputPrepared: false,
    preparedChannels: probe.channels ?? null,
    overlapSpeechSeparationSupported: false,
    overlapSpeechHandling: "best_effort_diarization_not_source_separation",
  };
  if (!enabled) return { status: "completed", source, metadata: baseMetadata };
  if (probe.status === "completed" && probe.channels === 1) {
    return { status: "completed", source, metadata: { ...baseMetadata, status: "enabled_native_mono", preparedChannels: 1 } };
  }

  const prepared = await prepareMonoSource(source, outputDir, options);
  if (prepared.status !== "completed") {
    if (explicitlyEnabled) return { ...prepared, reason: "cloud_asr_diarization_preparation_failed", metadata: baseMetadata };
    return {
      status: "completed",
      source,
      metadata: {
        ...baseMetadata,
        enabled: false,
        status: "disabled_preparation_unavailable",
        preparationFailure: prepared.reason,
      },
    };
  }
  return {
    status: "completed",
    source: prepared.source,
    metadata: {
      ...baseMetadata,
      enabled: true,
      status: probe.status === "completed" ? "enabled_mono_prepared" : "enabled_mono_prepared_without_probe",
      inputPrepared: true,
      preparedChannels: 1,
      preparedFormat: prepared.source.format,
      transcoder: prepared.transcoder,
    },
  };
}
