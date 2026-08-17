#!/usr/bin/env node

/**
 * Feishu bot event gateway for message receive events.
 *
 * This process is intentionally separate from feishu_cli. The official lark-cli
 * is still used for active Feishu operations from PI; this gateway only keeps a
 * Feishu SDK long connection open so bot messages can trigger replies.
 */

import { assertFeishuEvent } from "../dist/index.js";

const REQUIRED_ENV = ["FEISHU_APP_ID", "FEISHU_APP_SECRET"];
const DIAGNOSTIC_REPLY = "已收到消息。";
const HANDLER_EMPTY_REPLY =
  "已收到消息，正在处理。";
const REMOTE_HANDLER_ALLOW_ENV = "FEISHU_BOT_ALLOW_REMOTE_HANDLER";
const SECRET_PATTERNS = [
  /(app_secret|client_secret|refresh_token|access_token|authorization|cookie|session)\s*[:=]\s*["']?[^"',\s]+/gi,
  /bearer\s+[A-Za-z0-9._-]+/gi,
  /https?:\/\/[^\s"')]+/gi,
];

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(process.env[name]?.trim() ?? "");
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (normalized === "localhost" || normalized === "::1") return true;

  const ipv4 = normalized.split(".");
  if (ipv4.length !== 4) return false;
  const octets = ipv4.map((part) => Number(part));
  return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && octets[0] === 127;
}

function redactString(value) {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[redacted]"), value);
}

function redactLogValue(value) {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactLogValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactLogValue(entry)]));
  }
  return value;
}

function logJson(data, level = "log") {
  console[level](JSON.stringify(redactLogValue(data), null, 2));
}

function errorMessage(error) {
  return redactString(error instanceof Error ? error.message : String(error));
}

function handlerConfig() {
  const raw = process.env.FEISHU_BOT_HANDLER_URL?.trim();
  const remoteAllowed = envFlag(REMOTE_HANDLER_ALLOW_ENV);
  if (!raw) {
    return {
      configured: false,
      allowed: false,
      remoteAllowed,
      reason: "not_configured",
      summary: {
        configured: false,
        localhostOnlyByDefault: true,
        remoteAllowed,
        rawHandlerUrlReturned: false,
      },
    };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return {
      configured: true,
      allowed: false,
      remoteAllowed,
      reason: "invalid_url",
      summary: {
        configured: true,
        allowed: false,
        reason: "invalid_url",
        localhostOnlyByDefault: true,
        remoteAllowed,
        rawHandlerUrlReturned: false,
      },
    };
  }

  const protocolAllowed = url.protocol === "http:" || url.protocol === "https:";
  const hasCredentials = Boolean(url.username || url.password);
  const local = isLoopbackHostname(url.hostname);
  const allowed = protocolAllowed && !hasCredentials && (local || remoteAllowed);
  const reason = allowed
    ? "allowed"
    : hasCredentials
      ? "url_credentials_not_allowed"
      : protocolAllowed
        ? "remote_handler_blocked"
        : "unsupported_protocol";
  return {
    configured: true,
    allowed,
    url: allowed ? url.toString() : null,
    local,
    remoteAllowed,
    reason,
    summary: {
      configured: true,
      allowed,
      localhost: local,
      localhostOnlyByDefault: true,
      remoteAllowed,
      reason,
      rawHandlerUrlReturned: false,
    },
  };
}

function requireEnv() {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    logJson(
      {
        status: "blocked",
        reason: "missing_required_env",
        missingEnv: missing,
        requiredEnv: REQUIRED_ENV,
        rawSecretsReturned: false,
      },
      "error",
    );
    process.exit(2);
  }
}

async function loadLarkSdk() {
  try {
    return await import("@larksuiteoapi/node-sdk");
  } catch (error) {
    logJson(
      {
        status: "blocked",
        reason: "missing_lark_node_sdk",
        install: "npm install @larksuiteoapi/node-sdk@^1.24.0",
        error: errorMessage(error),
      },
      "error",
    );
    process.exit(2);
  }
}

function parseText(content) {
  try {
    const parsed = JSON.parse(content || "{}");
    return typeof parsed.text === "string" ? parsed.text.trim() : "";
  } catch {
    return "";
  }
}

function parseContent(content) {
  try {
    return JSON.parse(content || "{}");
  } catch {
    return {};
  }
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

function normalizeResourceType(value, fallback = "file") {
  const normalized = String(value ?? fallback).toLowerCase();
  return ["file", "image", "audio", "video"].includes(normalized) ? normalized : "unknown";
}

function collectAttachments(message) {
  const parsed = parseContent(message.content);
  const attachments = [];
  if (Array.isArray(message.attachments)) {
    for (const [index, item] of message.attachments.entries()) {
      const fileKey = item.file_key ?? item.fileKey ?? item.key ?? item.image_key ?? item.imageKey;
      if (!fileKey) continue;
      attachments.push({
        resourceType: normalizeResourceType(item.resource_type ?? item.resourceType ?? item.type),
        fileKey: String(fileKey),
        name: String(item.file_name ?? item.name ?? fileKey ?? `attachment_${index}`),
        mimeType: item.mime_type ?? item.mimeType,
      });
    }
  }
  for (const [index, attrs] of xmlTagAttributes(message.content, "file").entries()) {
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
  for (const [index, attrs] of xmlTagAttributes(message.content, "img").entries()) {
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
  const fileKey = parsed.file_key ?? parsed.fileKey ?? parsed.key;
  const imageKey = parsed.image_key ?? parsed.imageKey;
  if (fileKey) {
    attachments.push({
      resourceType: "file",
      fileKey: String(fileKey),
      name: String(parsed.file_name ?? parsed.name ?? fileKey),
      mimeType: parsed.mime_type ?? parsed.mimeType,
    });
  }
  if (imageKey) {
    attachments.push({
      resourceType: "image",
      fileKey: String(imageKey),
      name: String(parsed.file_name ?? parsed.name ?? imageKey),
      mimeType: parsed.mime_type ?? parsed.mimeType,
    });
  }
  return attachments;
}

function normalizeEvent(data) {
  const message = data?.message ?? {};
  const sender = data?.sender ?? {};
  const messageId = message.message_id;
  const chatId = message.chat_id;
  const text = parseText(message.content);
  return assertFeishuEvent({
    schemaVersion: "feishu-event-v1",
    eventId: messageId,
    eventType: "im.message.receive_v1",
    source: "sdk-long-connection",
    receivedAt: new Date().toISOString(),
    message: {
      messageId,
      chatId,
      chatType: message.chat_type,
      msgType: message.message_type,
      rootId: message.root_id ?? message.rootId ?? null,
      parentId: message.parent_id ?? message.parentId ?? null,
      threadId: message.thread_id ?? message.threadId ?? null,
      createTime: message.create_time ?? message.createTime ?? null,
      text,
      contentPreview: typeof message.content === "string" ? redactString(message.content).slice(0, 500) : "",
      attachments: collectAttachments(message),
    },
    sender: {
      senderType: sender.sender_type,
      senderId: sender.sender_id,
    },
    rawSecretsReturned: false,

    // Compatibility fields used by this gateway for immediate SDK replies.
    messageId,
    chatId,
    chatType: message.chat_type,
    msgType: message.message_type,
    text,
    createTime: message.create_time,
    rootId: message.root_id ?? message.rootId ?? null,
    parentId: message.parent_id ?? message.parentId ?? null,
    threadId: message.thread_id ?? message.threadId ?? null,
    senderType: sender.sender_type,
    senderId: sender.sender_id,
  });
}

function summarizeHandlerBody(body) {
  if (typeof body?.text === "string" && body.text.trim()) return body.text.trim();
  if (typeof body?.reply === "string" && body.reply.trim()) return body.reply.trim();

  const status = body?.status;
  if (!status) return "";

  const lines = [];
  if (status === "accepted") {
    lines.push("已接受任务，正在处理。");
  } else if (status === "completed") {
    lines.push("已完成处理。");
  } else if (status === "blocked") {
    lines.push("目前暂不支持该功能");
  } else if (status === "needs_fix") {
    lines.push("已处理完成，但结果需要进一步确认。");
  } else if (status === "failed") {
    lines.push("任务执行失败，请稍后重试。");
  } else {
    lines.push(`任务状态：${status}`);
  }
  if (status === "completed" && body?.summary) lines.push(String(body.summary));
  if (Array.isArray(body?.documents) && body.documents.length > 0) {
    lines.push("");
    lines.push("文档：");
    for (const doc of body.documents.slice(0, 6)) {
      const title = doc.title || doc.fileName || doc.docType || "document";
      lines.push(`- ${title}: ${doc.status || "ready"}${doc.url ? ` ${doc.url}` : ""}`);
    }
  }
  return lines.join("\n").slice(0, 3500);
}

async function fetchHandlerResult(event) {
  const handler = handlerConfig();
  if (!handler.configured) {
    return { shouldReply: true, text: "", handlerConfigured: false };
  }
  if (!handler.allowed || !handler.url) {
    return {
      shouldReply: true,
      text: `处理服务配置被拒绝：FEISHU_BOT_HANDLER_URL 默认仅允许本机地址；如确需远程处理器，请设置 ${REMOTE_HANDLER_ALLOW_ENV}=1。`,
      handlerConfigured: true,
    };
  }

  const controller = new AbortController();
  const timeoutMs = Number(process.env.FEISHU_BOT_HANDLER_TIMEOUT_MS ?? 20_000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(handler.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    if (!response.ok) {
      return {
        shouldReply: true,
        text: `处理服务返回 ${response.status}，请检查 FEISHU_BOT_HANDLER_URL。`,
        handlerConfigured: true,
        handlerStatus: response.status,
      };
    }
    return {
      shouldReply: body?.suppressGatewayReply !== true,
      text: summarizeHandlerBody(body),
      handlerConfigured: true,
      handlerStatus: response.status,
    };
  } catch (error) {
    return {
      shouldReply: true,
      text: `处理服务暂不可用：${errorMessage(error)}`,
      handlerConfigured: true,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function buildReply(event) {
  const handler = handlerConfig();
  const mode = effectiveReplyMode(handler);
  if (mode === "silent") return "";
  if (mode === "echo") return event.text ? `收到：${event.text}` : "收到一条非文本消息。";
  if (mode === "http") {
    const handlerResult = await fetchHandlerResult(event);
    if (!handlerResult.shouldReply) return "";
    return handlerResult.text || HANDLER_EMPTY_REPLY;
  }
  return DIAGNOSTIC_REPLY;
}

function effectiveReplyMode(handler = handlerConfig()) {
  return process.env.FEISHU_BOT_REPLY_MODE?.trim() || (handler.configured && handler.allowed ? "http" : "diagnostic");
}

async function sendTextMessage(client, chatId, text) {
  if (!text) return;
  await client.im.v1.message.create({
    params: {
      receive_id_type: "chat_id",
    },
    data: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    },
  });
}

async function main() {
  requireEnv();
  const Lark = await loadLarkSdk();
  const baseConfig = {
    appId: process.env.FEISHU_APP_ID,
    appSecret: process.env.FEISHU_APP_SECRET,
    domain: Lark.Domain?.Feishu,
    appType: Lark.AppType?.SelfBuild,
  };
  const client = new Lark.Client(baseConfig);
  const wsClient = new Lark.WSClient({
    ...baseConfig,
    loggerLevel: Lark.LoggerLevel?.warn ?? Lark.LoggerLevel?.info,
  });
  const seen = new Set();

  wsClient.start({
    eventDispatcher: new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        const event = normalizeEvent(data);
        if (!event.messageId || !event.chatId) return;
        if (seen.has(event.messageId)) return;
        seen.add(event.messageId);
        if (seen.size > 1000) seen.clear();

        logJson(
          {
            status: "event_received",
            eventType: event.eventType,
            messageIdPresent: Boolean(event.messageId),
            chatType: event.chatType,
            msgType: event.msgType,
            hasText: Boolean(event.text),
            attachmentCount: event.message?.attachments?.length ?? 0,
            hasRootId: Boolean(event.rootId),
            hasParentId: Boolean(event.parentId),
            contentKeys: Object.keys(parseContent(data?.message?.content)).slice(0, 20),
            receivedAt: new Date().toISOString(),
          },
        );

        try {
          const reply = await buildReply(event);
          await sendTextMessage(client, event.chatId, reply);
        } catch (error) {
          logJson(
            {
              status: "event_reply_failed",
              eventType: event.eventType,
              messageIdPresent: Boolean(event.messageId),
              chatType: event.chatType,
              error: errorMessage(error),
            },
            "error",
          );
        }
      },
    }),
  });

  logJson(
    {
      status: "started",
      component: "feishu-bot-event-gateway",
      subscriptionMode: "long_connection",
      eventTypes: ["im.message.receive_v1"],
      replyMode: effectiveReplyMode(),
      handler: handlerConfig().summary,
      rawSecretsReturned: false,
    },
  );
}

main().catch((error) => {
  logJson(
    {
      status: "fatal",
      error: errorMessage(error),
    },
    "error",
  );
  process.exit(1);
});
