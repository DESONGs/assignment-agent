import { extname } from "node:path";
import { closeSync, openSync, readSync } from "node:fs";

// Alibaba Cloud Model Studio speech-to-text audio specifications.
// Keep product intake aligned with the provider instead of local model limits.
export const DASHSCOPE_REALTIME_FORMATS = new Set([
  "pcm",
  "wav",
  "mp3",
  "opus",
  "speex",
  "aac",
  "amr",
]);

export const DASHSCOPE_FILE_AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".amr",
  ".flac",
  ".m4a",
  ".mp3",
  ".ogg",
  ".opus",
  ".wav",
  ".wma",
]);

export const DASHSCOPE_FILE_VIDEO_EXTENSIONS = new Set([
  ".avi",
  ".flv",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".webm",
  ".wmv",
]);

export const DASHSCOPE_FILE_EXTENSIONS = new Set([
  ...DASHSCOPE_FILE_AUDIO_EXTENSIONS,
  ...DASHSCOPE_FILE_VIDEO_EXTENSIONS,
]);

export const DASHSCOPE_REALTIME_EXTENSIONS = new Set(
  [...DASHSCOPE_REALTIME_FORMATS].map((format) => `.${format}`),
);

export const CLOUD_ASR_MEDIA_EXTENSIONS = new Set([
  ...DASHSCOPE_FILE_EXTENSIONS,
  ...DASHSCOPE_REALTIME_EXTENSIONS,
]);

export function mediaExtension(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return "";
  if (text.startsWith(".") && !text.includes("/") && !text.includes("\\")) return text;
  return extname(text).toLowerCase();
}

export function cloudAsrMediaKind(value) {
  const extension = mediaExtension(value);
  if (DASHSCOPE_FILE_VIDEO_EXTENSIONS.has(extension)) return "video";
  if (CLOUD_ASR_MEDIA_EXTENSIONS.has(extension)) return "audio";
  return null;
}

export function isCloudAsrMedia(value) {
  return CLOUD_ASR_MEDIA_EXTENSIONS.has(mediaExtension(value));
}

export function realtimeFormatForPath(value, explicitFormat) {
  const format = explicitFormat
    ? String(explicitFormat).trim().toLowerCase().replace(/^\./, "")
    : mediaExtension(value).replace(/^\./, "");
  return DASHSCOPE_REALTIME_FORMATS.has(format) ? format : null;
}

export function planDashScopeInput(value, options = {}) {
  const extension = mediaExtension(value);
  const requestedMode = String(options.inputMode ?? "auto").trim().toLowerCase();
  const fileSupported = DASHSCOPE_FILE_EXTENSIONS.has(extension);
  const realtimeFormat = realtimeFormatForPath(value, options.explicitFormat);
  const fileTransportConfigured = options.fileTransportConfigured === true;

  if (!CLOUD_ASR_MEDIA_EXTENSIONS.has(extension) && !realtimeFormat) {
    return { status: "blocked", reason: "cloud_asr_media_format_not_supported", extension };
  }
  if (requestedMode === "file") {
    if (!fileSupported) return { status: "blocked", reason: "cloud_asr_file_format_not_supported", extension };
    if (!fileTransportConfigured) return { status: "blocked", reason: "cloud_asr_file_transport_unavailable", extension };
    return { status: "ready", mode: "file", extension, format: extension.slice(1) };
  }
  if (requestedMode === "realtime") {
    if (!realtimeFormat) return { status: "blocked", reason: "cloud_asr_realtime_format_not_supported", extension };
    return { status: "ready", mode: "realtime", extension, format: realtimeFormat };
  }
  if (requestedMode !== "auto") {
    return { status: "blocked", reason: "cloud_asr_input_mode_invalid", extension, requestedMode };
  }
  if (fileSupported && fileTransportConfigured) {
    return { status: "ready", mode: "file", extension, format: extension.slice(1) };
  }
  if (realtimeFormat) {
    return { status: "ready", mode: "realtime", extension, format: realtimeFormat };
  }
  return { status: "blocked", reason: "cloud_asr_file_transport_unavailable", extension };
}

export function validateCloudAsrMediaHeader(value, head) {
  const extension = mediaExtension(value);
  const bytes = Buffer.isBuffer(head) ? head : Buffer.from(head ?? []);
  let checked = true;
  let ok = false;
  let detectedContainer = null;

  if (extension === ".wav") ok = bytes.length >= 12 && bytes.subarray(0, 4).equals(Buffer.from("RIFF")) && bytes.subarray(8, 12).equals(Buffer.from("WAVE"));
  else if (extension === ".mp3") ok = bytes.subarray(0, 3).equals(Buffer.from("ID3")) || (bytes.length >= 2 && bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0);
  else if ([".m4a", ".mov", ".mp4"].includes(extension)) ok = bytes.subarray(0, 32).includes(Buffer.from("ftyp"));
  else if (extension === ".flac") ok = bytes.subarray(0, 4).equals(Buffer.from("fLaC"));
  else if ([".ogg", ".opus"].includes(extension)) ok = bytes.subarray(0, 4).equals(Buffer.from("OggS")) || bytes.subarray(0, 16).includes(Buffer.from("OpusHead"));
  else if (extension === ".aac") {
    const adts = bytes.length >= 2 && bytes[0] === 0xFF && (bytes[1] & 0xF0) === 0xF0;
    const isoMedia = bytes.subarray(0, 32).includes(Buffer.from("ftyp"));
    ok = adts || isoMedia;
    detectedContainer = isoMedia ? "m4a" : adts ? "aac-adts" : null;
  }
  else if (extension === ".amr") ok = bytes.subarray(0, 5).equals(Buffer.from("#!AMR"));
  else if ([".wma", ".wmv"].includes(extension)) ok = bytes.subarray(0, 8).equals(Buffer.from([0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11]));
  else if (extension === ".avi") ok = bytes.length >= 12 && bytes.subarray(0, 4).equals(Buffer.from("RIFF")) && bytes.subarray(8, 12).equals(Buffer.from("AVI "));
  else if (extension === ".flv") ok = bytes.subarray(0, 3).equals(Buffer.from("FLV"));
  else if ([".mkv", ".webm"].includes(extension)) ok = bytes.subarray(0, 4).equals(Buffer.from([0x1A, 0x45, 0xDF, 0xA3]));
  else {
    checked = false;
    ok = CLOUD_ASR_MEDIA_EXTENSIONS.has(extension);
  }

  return {
    ok,
    checked,
    reason: ok ? null : "invalid_asr_media_header",
    extension,
    ...(detectedContainer ? { detectedContainer } : {}),
  };
}

export function readCloudAsrMediaHeader(path, maxBytes = 64) {
  const size = Math.max(16, Math.min(4096, Number(maxBytes) || 64));
  const buffer = Buffer.alloc(size);
  const fd = openSync(path, "r");
  try {
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}
