import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(toolDir);
const workspaceDir = dirname(packageDir);
const FILE_CONTEXT_SCHEMA_VERSION = "file-context-v1";
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"]);
const AUDIO_MIN_READY_BYTES = 4096;
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".heic"]);
const SUPPORTED_TEXT_FILE_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".csv",
  ".tsv",
  ".txt",
  ".md",
  ".markdown",
  ".json",
]);
const SPREADSHEET_EXTENSIONS = new Set([".xls", ".xlsx", ".csv", ".tsv"]);
const WORD_EXTENSIONS = new Set([".doc", ".docx"]);
const ONE_SENTENCE_PATTERN = /一句话|一段话|简短|简要|快速|summary|summarize|总结|摘要|概括/i;
const MAX_CONTEXT_PREVIEW_CHARS = Number(process.env.FEISHU_AGENT_FILE_CONTEXT_PREVIEW_CHARS ?? 60000);
const MAX_EXTRACTED_TEXT_CHARS = Number(process.env.FEISHU_AGENT_FILE_CONTEXT_MAX_CHARS ?? 240000);
const SECRET_PATTERNS = [
  /(app_secret|client_secret|refresh_token|access_token|authorization|cookie|session)\s*[:=]\s*["']?[^"',\s]+/gi,
  /bearer\s+[A-Za-z0-9._-]+/gi,
  /\b(FEISHU_APP_SECRET|DEEPSEEK_API_KEY|XIAOMI_TOKEN_PLAN_SGP_API_KEY)\b/gi,
];

function nowIso() {
  return new Date().toISOString();
}

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(process.env[name]?.trim() ?? "");
}

function existingNonEmptyFile(path) {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0 ? stat : null;
  } catch {
    return null;
  }
}

function audioSignatureStatus(path) {
  const stat = existingNonEmptyFile(path);
  if (!stat) return { ok: false, reason: "audio_file_missing" };
  const ext = extname(String(path ?? "")).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(ext)) return { ok: true, reason: "non_audio_extension", sizeBytes: stat.size, extension: ext };
  if (stat.size < AUDIO_MIN_READY_BYTES) {
    return { ok: false, reason: "audio_file_too_small", sizeBytes: stat.size, minBytes: AUDIO_MIN_READY_BYTES, extension: ext };
  }
  let head = Buffer.alloc(0);
  try {
    head = readFileSync(path).subarray(0, 64);
  } catch (error) {
    return { ok: false, reason: "audio_header_read_failed", error: redactString(error instanceof Error ? error.message : String(error)), extension: ext };
  }
  let ok = false;
  if (ext === ".wav") ok = head.length >= 12 && head.subarray(0, 4).equals(Buffer.from("RIFF")) && head.subarray(8, 12).equals(Buffer.from("WAVE"));
  else if (ext === ".mp3") ok = head.subarray(0, 3).equals(Buffer.from("ID3")) || (head.length >= 2 && head[0] === 0xFF && (head[1] & 0xE0) === 0xE0);
  else if (ext === ".m4a") ok = head.subarray(0, 16).includes(Buffer.from("ftyp"));
  else if (ext === ".flac") ok = head.subarray(0, 4).equals(Buffer.from("fLaC"));
  else if (ext === ".ogg") ok = head.subarray(0, 4).equals(Buffer.from("OggS"));
  else if (ext === ".aac") ok = head.length >= 2 && head[0] === 0xFF && (head[1] & 0xF0) === 0xF0;
  return { ok, reason: ok ? null : "invalid_audio_header", sizeBytes: stat.size, extension: ext };
}

function redactString(value) {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[redacted]"), String(value ?? ""));
}

export function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function safeSegment(value, fallback = "item") {
  const cleaned = String(value || fallback).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned;
}

export function workspaceRelative(path) {
  if (!path) return null;
  const resolved = resolve(path);
  return isInside(workspaceDir, resolved) ? relative(workspaceDir, resolved) : "[outside-workspace]";
}

export function attachmentKind(attachment) {
  const resourceType = String(attachment.resourceType ?? attachment.type ?? "").toLowerCase();
  const name = String(attachment.name ?? attachment.fileName ?? attachment.localPath ?? attachment.sourcePath ?? attachment.fileKey ?? "").toLowerCase();
  const mimeType = String(attachment.mimeType ?? attachment.mime_type ?? "").toLowerCase();
  const ext = extname(name);
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("image/")) return "image";
  if (["audio", "video", "image", "file"].includes(resourceType)) return resourceType;
  return "file";
}

export function fileExtension(attachment) {
  return extname(String(attachment.name ?? attachment.fileName ?? attachment.localPath ?? attachment.sourcePath ?? "")).toLowerCase();
}

export function isSupportedTextFile(attachment) {
  return attachmentKind(attachment) === "file" && SUPPORTED_TEXT_FILE_EXTENSIONS.has(fileExtension(attachment));
}

export function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function writeText(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
  return path;
}

function cleanUserPrompt(text) {
  return String(text ?? "")
    .replace(/@\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(command, args, {
      cwd: options.cwd ?? workspaceDir,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs ?? 120000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 5_000_000) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 5_000_000) child.kill("SIGTERM");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolveCommand({ exitCode: error.code === "ENOENT" ? 127 : 1, signal: null, stdout, stderr, error: error.message, timedOut });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolveCommand({ exitCode: code ?? (signal ? 128 : 1), signal, stdout, stderr, timedOut });
    });
    child.stdin.end(options.stdin ?? "");
  });
}

function xmlDecode(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function stripXmlToText(xml) {
  return xmlDecode(String(xml ?? "")
    .replace(/<w:p[^>]*>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<row[^>]*>/g, "\n")
    .replace(/<\/row>/g, "\n")
    .replace(/<c[^>]*>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n"))
    .trim();
}

function normalizeExtractedText(text) {
  return String(text ?? "")
    .replace(/\u0000/g, "")
    .replace(/[^\S\r\n]{2,}/g, " ")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, MAX_EXTRACTED_TEXT_CHARS);
}

function readTextPreview(path) {
  return normalizeExtractedText(readFileSync(path, "utf8"));
}

async function extractDocxText(path) {
  const xml = await runCommand("unzip", ["-p", path, "word/document.xml"], { timeoutMs: 60000 });
  if (xml.exitCode !== 0 || !xml.stdout.trim()) {
    return { status: "failed", method: "docx-unzip", reason: "word_document_xml_missing", stderrTail: redactString(xml.stderr).slice(-800), text: "" };
  }
  return { status: "completed", method: "docx-unzip", text: normalizeExtractedText(stripXmlToText(xml.stdout)) };
}

async function extractLegacyWordText(path) {
  const converted = await runCommand("textutil", ["-convert", "txt", "-stdout", path], { timeoutMs: 60000 });
  if (converted.exitCode !== 0 || !converted.stdout.trim()) {
    return { status: "failed", method: "textutil", reason: "textutil_convert_failed", stderrTail: redactString(converted.stderr).slice(-800), text: "" };
  }
  return { status: "completed", method: "textutil", text: normalizeExtractedText(converted.stdout) };
}

async function extractXlsxText(path) {
  const sharedStrings = await runCommand("unzip", ["-p", path, "xl/sharedStrings.xml"], { timeoutMs: 60000 });
  const strings = [...String(sharedStrings.stdout ?? "").matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((match) => xmlDecode(match[1]));
  const workbook = await runCommand("unzip", ["-p", path, "xl/workbook.xml"], { timeoutMs: 60000 });
  const sheetNames = [...String(workbook.stdout ?? "").matchAll(/<sheet[^>]*name="([^"]+)"/g)].map((match) => xmlDecode(match[1]));
  const sections = [];
  if (sheetNames.length > 0) sections.push(`Sheets: ${sheetNames.join(", ")}`);
  if (strings.length > 0) sections.push(`Shared strings preview:\n${strings.slice(0, 400).join("\n")}`);
  for (let index = 1; index <= 3; index += 1) {
    const sheet = await runCommand("unzip", ["-p", path, `xl/worksheets/sheet${index}.xml`], { timeoutMs: 60000 });
    if (sheet.exitCode === 0 && sheet.stdout.trim()) {
      const values = [...sheet.stdout.matchAll(/<c[^>]*?(?:r="([^"]+)")?[^>]*?(?:t="([^"]+)")?[^>]*>[\s\S]*?<v>([\s\S]*?)<\/v>[\s\S]*?<\/c>/g)]
        .slice(0, 240)
        .map((match) => {
          const cell = match[1] ?? "";
          const type = match[2] ?? "";
          const raw = xmlDecode(match[3]);
          const value = type === "s" ? strings[Number(raw)] ?? raw : raw;
          return cell ? `${cell}: ${value}` : value;
        });
      if (values.length > 0) sections.push(`Sheet ${index} preview:\n${values.join("\n")}`);
    }
  }
  const text = normalizeExtractedText(sections.join("\n\n"));
  if (!text) return { status: "failed", method: "xlsx-unzip", reason: "xlsx_text_empty", text: "" };
  return { status: "completed", method: "xlsx-unzip", text };
}

async function extractPdfText(path) {
  const output = await runCommand("strings", ["-n", "4", path], { timeoutMs: 60000 });
  const text = normalizeExtractedText(String(output.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 2 && !/^\/?[A-Z][A-Za-z]{0,6}\b/.test(line))
    .join("\n"));
  if (output.exitCode !== 0 || !text) {
    return { status: "failed", method: "pdf-strings", reason: "pdf_text_extract_empty", stderrTail: redactString(output.stderr).slice(-800), text: "" };
  }
  return { status: "completed", method: "pdf-strings", text };
}

export async function extractAttachmentText(attachment) {
  const sourcePath = attachment.localPath ?? attachment.sourcePath ?? "";
  const localPath = sourcePath ? resolve(sourcePath) : "";
  if (!localPath || !existsSync(localPath)) {
    return { status: "failed", method: "none", reason: "local_file_missing", text: "" };
  }
  const ext = fileExtension(attachment);
  try {
    if ([".txt", ".md", ".markdown", ".json", ".csv", ".tsv"].includes(ext)) {
      return { status: "completed", method: "utf8-read", text: readTextPreview(localPath) };
    }
    if (ext === ".docx") return await extractDocxText(localPath);
    if (ext === ".doc") return await extractLegacyWordText(localPath);
    if (ext === ".xlsx") return await extractXlsxText(localPath);
    if (ext === ".xls") return await extractLegacyWordText(localPath);
    if (ext === ".pdf") return await extractPdfText(localPath);
  } catch (error) {
    return { status: "failed", method: "extractor-exception", reason: redactString(error instanceof Error ? error.message : String(error)), text: "" };
  }
  return { status: "failed", method: "none", reason: "unsupported_text_file_extension", text: "" };
}

function disclosurePlanFor(attachment, taskPrompt) {
  const ext = fileExtension(attachment);
  const shortTask = ONE_SENTENCE_PATTERN.test(taskPrompt);
  if (SPREADSHEET_EXTENSIONS.has(ext)) {
    return {
      strategy: shortTask ? "sheet_summary_first" : "sheet_headers_then_relevant_ranges",
      firstPass: ["sheet names", "headers", "bounded value preview"],
      followUp: ["only task-relevant sheets/ranges"],
    };
  }
  if (WORD_EXTENSIONS.has(ext) || ext === ".pdf") {
    return {
      strategy: shortTask ? "document_summary_first" : "outline_then_relevant_sections",
      firstPass: ["title/outline if extractable", "bounded text preview", "task-relevant paragraphs"],
      followUp: ["only router-selected evidence slices"],
    };
  }
  return {
    strategy: shortTask ? "bounded_text_summary" : "bounded_text_then_evidence_slices",
    firstPass: ["bounded text preview"],
    followUp: ["only task-relevant chunks"],
  };
}

export async function buildFileContexts(event, attachments, paths, options = {}) {
  mkdirSync(paths.fileContextsDir, { recursive: true });
  const taskPrompt = cleanUserPrompt(event.message?.text ?? event.messageText ?? "");
  const nativeFileInputSupported = options.nativeFileInputSupported ?? envFlag(options.providerFileInputEnv ?? "FEISHU_AGENT_PROVIDER_FILE_INPUT");
  const contexts = [];
  for (const [index, attachment] of attachments.entries()) {
    const kind = attachmentKind(attachment);
    const ext = fileExtension(attachment);
    const supportedText = isSupportedTextFile(attachment);
    const baseName = safeSegment(`${index}-${basename(attachment.name ?? attachment.fileName ?? attachment.localPath ?? attachment.sourcePath ?? attachment.fileKey ?? attachment.attachmentId ?? "file")}`);
    const context = {
      schemaVersion: FILE_CONTEXT_SCHEMA_VERSION,
      fileId: attachment.sha256 ?? attachment.fileKey ?? attachment.attachmentId ?? baseName,
      fileName: attachment.name ?? attachment.fileName ?? baseName,
      mimeType: attachment.mimeType ?? null,
      fileType: kind,
      extension: ext,
      sourcePath: attachment.localPath ?? attachment.sourcePath ?? null,
      sourceMessageId: attachment.messageId ?? attachment.sourceMessageId ?? attachment.cacheSourceMessageId ?? event.message?.messageId ?? null,
      taskPrompt,
      externalLlmAllowed: true,
      nativeFileInputSupported,
      contextMode: nativeFileInputSupported ? "native_file_or_text_fallback" : "text_fallback",
      disclosurePlan: disclosurePlanFor(attachment, taskPrompt),
      progressiveDisclosureStatus: "requires_source_context_runtime",
      extraction: null,
      extractedTextPath: null,
      contextPreview: "",
      status: "ready",
      unsupportedReason: null,
      rawSecretsReturned: false,
    };

    if (kind === "image") {
      context.status = "unsupported";
      context.unsupportedReason = "image_understanding_not_supported";
      contexts.push(context);
      continue;
    }
    if (kind === "video") {
      context.status = "unsupported";
      context.unsupportedReason = "video_understanding_not_supported";
      context.externalLlmAllowed = false;
      contexts.push(context);
      continue;
    }
    if (kind === "audio") {
      context.contextMode = "local_asr_only";
      context.externalLlmAllowed = false;
    }
    if (attachment.downloadStatus === "skipped") {
      context.status = "pending";
      context.unsupportedReason = "dry_run_download_not_executed";
      contexts.push(context);
      continue;
    }
    if (!context.sourcePath || !existingNonEmptyFile(context.sourcePath)) {
      context.status = "blocked";
      context.unsupportedReason = ["failed", "blocked"].includes(attachment.downloadStatus)
        ? "attachment_download_failed"
        : "local_source_file_missing";
      context.localSourceReady = false;
      contexts.push(context);
      continue;
    }
    context.localSourceReady = true;
    if (kind === "audio") {
      const audioValidation = audioSignatureStatus(context.sourcePath);
      context.audioValidation = audioValidation;
      if (!audioValidation.ok) {
        context.status = "blocked";
        context.unsupportedReason = audioValidation.reason ?? "invalid_audio_source";
        context.localSourceReady = false;
      }
      contexts.push(context);
      continue;
    }
    if (!supportedText) {
      context.status = "unsupported";
      context.unsupportedReason = "unsupported_file_type";
      contexts.push(context);
      continue;
    }
    const extraction = await extractAttachmentText(attachment);
    context.extraction = {
      status: extraction.status,
      method: extraction.method,
      reason: extraction.reason ?? null,
      chars: extraction.text?.length ?? 0,
      previewChars: Math.min(extraction.text?.length ?? 0, MAX_CONTEXT_PREVIEW_CHARS),
    };
    if (extraction.status === "completed" && extraction.text) {
      const extractedPath = join(paths.fileContextsDir, `${baseName}.txt`);
      writeText(extractedPath, extraction.text);
      context.extractedTextPath = extractedPath;
      context.contextPreview = extraction.text.slice(0, MAX_CONTEXT_PREVIEW_CHARS);
      context.contextMode = nativeFileInputSupported ? "native_file_plus_text_preview" : "text_fallback";
    } else if (!nativeFileInputSupported) {
      context.status = "unsupported";
      context.unsupportedReason = "text_fallback_extract_failed";
    }
    contexts.push(context);
  }
  return {
    schemaVersion: "file-context-batch-v1",
    generatedAt: nowIso(),
    contextPolicy: {
      userUploadedTextFilesMayBeSentToLlm: true,
      rawAudioVideoExternalUploadAllowed: false,
      progressiveDisclosureRequired: true,
      progressiveDisclosureOwner: "source-context-runtime",
      progressiveDisclosureStatus: "requires_source_context_runtime",
      fullLargeFileInlineInMetricsOrLogs: false,
    },
    contexts,
    rawSecretsReturned: false,
  };
}
