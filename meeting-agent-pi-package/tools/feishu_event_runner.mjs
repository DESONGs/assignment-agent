#!/usr/bin/env node

/**
 * Feishu event runner.
 *
 * CLI-first inbound path:
 *   lark-cli event consume <EventKey> --as bot
 *
 * The runner normalizes NDJSON events, records sanitized local evidence, and
 * forwards each event to the local Feishu Agent task handler. It does not call
 * PI directly and does not publish Feishu content.
 */

import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const toolDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(toolDir);
const workspaceDir = dirname(packageDir);
const DEFAULT_OUTPUT_ROOT = join(workspaceDir, "runtime-runs", "feishu-agent");
const DEFAULT_HANDLER_URL = "http://127.0.0.1:8788/feishu/events";
const REMOTE_HANDLER_ALLOW_ENV = "FEISHU_AGENT_ALLOW_REMOTE_HANDLER";
const SECRET_PATTERNS = [
  /(app_secret|client_secret|refresh_token|access_token|authorization|cookie|session)\s*[:=]\s*["']?[^"',\s]+/gi,
  /bearer\s+[A-Za-z0-9._-]+/gi,
  /\b(FEISHU_APP_SECRET|DEEPSEEK_API_KEY|XIAOMI_TOKEN_PLAN_SGP_API_KEY)\b/gi,
];

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(process.env[name]?.trim() ?? "");
}

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    if (["stdin", "dry-run", "quiet"].includes(key)) {
      args[key] = true;
      continue;
    }
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

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeOutputRoot(input) {
  const root = resolve(input ?? DEFAULT_OUTPUT_ROOT);
  if (!isInside(workspaceDir, root)) {
    throw new Error("feishu_event_runner_output_root_outside_workspace_blocked");
  }
  mkdirSync(root, { recursive: true });
  return root;
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".").map((part) => Number(part));
  return octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && octets[0] === 127;
}

function validateHandlerUrl(raw) {
  const url = new URL(raw || DEFAULT_HANDLER_URL);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("feishu_agent_handler_url_protocol_blocked");
  }
  if (url.username || url.password) {
    throw new Error("feishu_agent_handler_url_credentials_blocked");
  }
  if (!isLoopbackHostname(url.hostname) && !envFlag(REMOTE_HANDLER_ALLOW_ENV)) {
    throw new Error("feishu_agent_handler_remote_blocked");
  }
  return url.toString();
}

function redactString(value) {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[redacted]"), value);
}

function sanitize(value, key = "") {
  if (typeof value === "string") return redactString(value).slice(0, 12000);
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    const output = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (entryKey === "rawSecretsReturned" || entryKey === "rawMediaExternalUpload") {
        output[entryKey] = entryValue;
      } else if (/secret|token|cookie|session|authorization/i.test(entryKey) && entryKey !== "folderToken" && entryKey !== "fileToken") {
        output[entryKey] = "[redacted]";
      } else {
        output[entryKey] = sanitize(entryValue, entryKey);
      }
    }
    return output;
  }
  return value;
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseJsonMaybe(value) {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function parseText(content) {
  const parsed = parseJsonMaybe(content);
  if (typeof parsed?.text === "string") return parsed.text.trim();
  if (typeof content === "string") return content.trim();
  return "";
}

function xmlDecode(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function xmlTagAttributes(rawContent, tagName) {
  const content = typeof rawContent === "string" ? rawContent : "";
  return [...content.matchAll(new RegExp(`<${tagName}\\b([^>]*)\\/?>`, "gi"))].map((match) =>
    Object.fromEntries(
      [...String(match[1] ?? "").matchAll(/([A-Za-z_:.-]+)=["']([^"']*)["']/g)].map((attr) => [attr[1], xmlDecode(attr[2])]),
    ),
  );
}

function collectAttachments(message, content) {
  const parsed = parseJsonMaybe(content);
  const existing = Array.isArray(message?.attachments) ? message.attachments : [];
  const attachments = existing.map((item) => ({
    resourceType: item.resourceType ?? item.type ?? "unknown",
    fileKey: item.fileKey ?? item.file_key ?? item.image_key ?? item.key ?? "",
    name: item.name ?? item.file_name ?? item.filename ?? "",
    localPath: item.localPath ?? item.local_path,
    mimeType: item.mimeType ?? item.mime_type,
  }));

  for (const [index, attrs] of xmlTagAttributes(content, "file").entries()) {
    const fileKey = attrs.key ?? attrs.file_key ?? attrs.fileKey;
    if (!fileKey) continue;
    attachments.push({
      resourceType: "file",
      fileKey: String(fileKey),
      name: String(attrs.name ?? attrs.file_name ?? attrs.fileName ?? fileKey ?? `file_${index}`),
      mimeType: attrs.mime_type ?? attrs.mimeType,
      resolvedFromXmlFileTag: true,
    });
  }
  for (const [index, attrs] of xmlTagAttributes(content, "img").entries()) {
    const imageKey = attrs.key ?? attrs.image_key ?? attrs.imageKey;
    if (!imageKey) continue;
    attachments.push({
      resourceType: "image",
      fileKey: String(imageKey),
      name: String(attrs.name ?? attrs.file_name ?? attrs.fileName ?? imageKey ?? `image_${index}`),
      mimeType: attrs.mime_type ?? attrs.mimeType,
      resolvedFromXmlFileTag: true,
    });
  }

  const contentFileKey = parsed.file_key ?? parsed.fileKey ?? parsed.key;
  const contentImageKey = parsed.image_key ?? parsed.imageKey;
  if (contentFileKey) {
    attachments.push({
      resourceType: "file",
      fileKey: String(contentFileKey),
      name: String(parsed.file_name ?? parsed.name ?? contentFileKey),
      mimeType: parsed.mime_type ?? parsed.mimeType,
    });
  }
  if (contentImageKey) {
    attachments.push({
      resourceType: "image",
      fileKey: String(contentImageKey),
      name: String(parsed.file_name ?? parsed.name ?? contentImageKey),
      mimeType: parsed.mime_type ?? parsed.mimeType,
    });
  }
  return attachments.filter((item) => item.fileKey || item.localPath);
}

function normalizeEvent(rawInput, source) {
  const raw = sanitize(rawInput);
  const envelope = raw?.event ?? raw?.data?.event ?? raw?.data ?? raw;
  const message = envelope?.message ?? raw?.message ?? {};
  const sender = envelope?.sender ?? raw?.sender ?? {};
  const eventType = raw?.event_type ?? raw?.eventType ?? envelope?.event_type ?? "im.message.receive_v1";
  const content = message?.content ?? raw?.content ?? "";
  const text = raw?.text ?? message?.text ?? parseText(content);
  const eventId = String(raw?.event_id ?? raw?.eventId ?? envelope?.event_id ?? message?.message_id ?? hashJson(raw).slice(0, 24));
  const messageId = String(message?.message_id ?? message?.messageId ?? raw?.messageId ?? "");
  const chatId = String(message?.chat_id ?? message?.chatId ?? raw?.chatId ?? "");
  const msgType = String(message?.message_type ?? message?.msgType ?? raw?.msgType ?? "text");
  const attachments = collectAttachments(message, content);
  return {
    schemaVersion: "feishu-event-v1",
    eventId,
    eventType,
    source,
    receivedAt: nowIso(),
    message: {
      messageId,
      chatId,
      chatType: message?.chat_type ?? message?.chatType ?? raw?.chatType ?? null,
      msgType,
      rootId: message?.root_id ?? message?.rootId ?? raw?.rootId ?? null,
      parentId: message?.parent_id ?? message?.parentId ?? raw?.parentId ?? null,
      threadId: message?.thread_id ?? message?.threadId ?? raw?.threadId ?? null,
      createTime: message?.create_time ?? message?.createTime ?? raw?.createTime ?? null,
      text: String(text ?? "").slice(0, 12000),
      contentPreview: typeof content === "string" ? redactString(content).slice(0, 500) : "",
      attachments,
    },
    sender: {
      senderType: sender?.sender_type ?? sender?.senderType ?? raw?.senderType ?? null,
      senderId: sender?.sender_id ?? sender?.senderId ?? raw?.senderId ?? null,
    },
    rawEventStored: true,
    rawEventPath: null,
    rawSecretsReturned: false,
  };
}

function dedupePath(outputRoot) {
  return join(outputRoot, ".feishu-event-runner-dedupe.json");
}

function loadSeen(outputRoot) {
  const path = dedupePath(outputRoot);
  if (!existsSync(path)) return new Set();
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return new Set(Array.isArray(data.seenEventIds) ? data.seenEventIds.slice(-5000) : []);
  } catch {
    return new Set();
  }
}

function saveSeen(outputRoot, seen) {
  const values = [...seen].slice(-5000);
  writeFileSync(dedupePath(outputRoot), `${JSON.stringify({ seenEventIds: values, updatedAt: nowIso() }, null, 2)}\n`, "utf8");
}

async function appendEventLog(outputRoot, event, raw) {
  const date = new Date().toISOString().slice(0, 10);
  const dir = join(outputRoot, "events");
  mkdirSync(dir, { recursive: true });
  const rawPath = join(dir, `${date}-source-events.ndjson`);
  const normalizedPath = join(dir, `${date}-normalized-events.ndjson`);
  event.rawEventPath = relative(workspaceDir, rawPath);
  await appendFile(rawPath, `${JSON.stringify(sanitize(raw))}\n`, "utf8");
  await appendFile(normalizedPath, `${JSON.stringify(sanitize(event))}\n`, "utf8");
}

async function postToHandler(handlerUrl, event, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(handlerUrl, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(event),
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { text: redactString(text).slice(0, 2000) };
    }
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function processRawEvent(raw, options, seen) {
  const event = normalizeEvent(raw, options.source);
  await appendEventLog(options.outputRoot, event, raw);
  if (seen.has(event.eventId)) {
    return { status: "skipped", reason: "duplicate_event", eventId: event.eventId, rawSecretsReturned: false };
  }

  if (options.dryRun) {
    seen.add(event.eventId);
    saveSeen(options.outputRoot, seen);
    return { status: "dry_run", event, handlerForwarded: false, rawSecretsReturned: false };
  }

  const handler = await postToHandler(options.handlerUrl, event, options.handlerTimeoutMs);
  if (handler.ok) {
    seen.add(event.eventId);
    saveSeen(options.outputRoot, seen);
  }
  return {
    status: handler.ok ? "forwarded" : "handler_failed",
    eventId: event.eventId,
    handlerStatus: handler.status,
    handlerBody: sanitize(handler.body),
    rawSecretsReturned: false,
  };
}

function parseJsonEventsText(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // Fall through to NDJSON parsing. A normal NDJSON stream also starts
      // with "{", but contains one object per line rather than one JSON value.
    }
  }
  return trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function readJsonEventsFromFile(path) {
  return parseJsonEventsText(readFileSync(resolve(path), "utf8"));
}

async function readJsonEventsFromStdin() {
  const input = await new Promise((resolveInput) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolveInput(data));
  });
  return parseJsonEventsText(input);
}

async function processStaticEvents(events, options) {
  const seen = loadSeen(options.outputRoot);
  const results = [];
  for (const raw of events) {
    results.push(await processRawEvent(raw, options, seen));
  }
  return results;
}

async function consumeLarkCli(options) {
  if (!options.eventKey) {
    throw new Error("FEISHU_EVENT_KEY or --event-key is required for lark-cli event consume");
  }
  const args = ["event", "consume", options.eventKey, "--as", options.asIdentity, "--quiet"];
  if (options.maxEvents) args.push("--max-events", String(options.maxEvents));
  if (options.timeout) args.push("--timeout", String(options.timeout));
  const child = spawn("lark-cli", args, { cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"], shell: false });
  const seen = loadSeen(options.outputRoot);
  const rl = createInterface({ input: child.stdout });
  const results = [];
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    try {
      const raw = JSON.parse(line);
      const result = await processRawEvent(raw, { ...options, source: "lark-cli-event-consume" }, seen);
      results.push(result);
      if (!options.quiet) console.log(JSON.stringify(result));
    } catch (error) {
      console.error(JSON.stringify({ status: "event_parse_failed", error: redactString(error.message), rawSecretsReturned: false }));
    }
  });
  child.stderr.on("data", (chunk) => {
    if (!options.quiet) process.stderr.write(redactString(chunk.toString("utf8")));
  });
  return await new Promise((resolveRunner) => {
    child.on("error", (error) => {
      resolveRunner({ status: "blocked", reason: error.code === "ENOENT" ? "lark_cli_not_found" : redactString(error.message), results });
    });
    child.on("close", (code, signal) => {
      resolveRunner({ status: code === 0 ? "completed" : "failed", exitCode: code, signal, results, rawSecretsReturned: false });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputRoot = safeOutputRoot(args["output-root"] ?? process.env.FEISHU_EVENT_RUNNER_OUTPUT_ROOT);
  const handlerUrl = validateHandlerUrl(args["handler-url"] ?? process.env.FEISHU_AGENT_HANDLER_URL ?? DEFAULT_HANDLER_URL);
  const options = {
    outputRoot,
    handlerUrl,
    handlerTimeoutMs: Number(args["handler-timeout-ms"] ?? process.env.FEISHU_AGENT_HANDLER_TIMEOUT_MS ?? 120000),
    dryRun: args["dry-run"] === true,
    source: args.fixture ? "fixture" : args.stdin ? "stdin" : "lark-cli-event-consume",
    eventKey: args["event-key"] ?? process.env.FEISHU_EVENT_KEY,
    asIdentity: args.as ?? process.env.FEISHU_EVENT_AS ?? "bot",
    maxEvents: args["max-events"],
    timeout: args.timeout,
    quiet: args.quiet === true,
  };

  if (args.fixture) {
    const events = await readJsonEventsFromFile(args.fixture);
    console.log(JSON.stringify({ status: "completed", results: await processStaticEvents(events, options), rawSecretsReturned: false }, null, 2));
    return;
  }
  if (args.stdin) {
    const events = await readJsonEventsFromStdin();
    console.log(JSON.stringify({ status: "completed", results: await processStaticEvents(events, options), rawSecretsReturned: false }, null, 2));
    return;
  }
  console.log(JSON.stringify(await consumeLarkCli(options), null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "blocked", reason: redactString(error.message), rawSecretsReturned: false }, null, 2));
  process.exit(2);
});
