import { createHash } from "node:crypto";

const REQUIRED_COMMENT_SCOPES = [
  "docs:document.comment:read",
  "drive:drive:readonly",
  "docs:doc:readonly",
];

const COMMENT_TEXT_MAX_CHARS = 1200;
const REPLY_TEXT_MAX_CHARS = 800;
const REVIEW_CONTEXT_GUARDRAIL = "bounded comment anchors only";
const REVIEW_CONTEXT_METHODS = ["cli", "sdk", "export_body_detected", "unavailable"];
const COMMENT_MATCH_STATUSES = ["exact_unique", "exact_multiple", "fuzzy", "unmatched", "exported_body_detected"];

function nowIso() {
  return new Date().toISOString();
}

function envFlag(name, fallback = false) {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function redactString(value) {
  return String(value ?? "")
    .replace(/(file_token|fileToken|comment_id|commentId)\s*[:=]\s*["']?[^"',\s}]+/gi, "$1:[redacted]")
    .replace(/(app_secret|client_secret|refresh_token|access_token|authorization|cookie|session)\s*[:=]\s*["']?[^"',\s]+/gi, "[redacted]")
    .replace(/bearer\s+[A-Za-z0-9._-]+/gi, "[redacted]");
}

function hashText(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function hashId(value) {
  const text = String(value ?? "");
  return text ? hashText(text).slice(0, 16) : null;
}

function parseJsonOutput(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}$/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function extractItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.data?.comments)) return payload.data.comments;
  if (Array.isArray(payload?.comments)) return payload.comments;
  return [];
}

function extractPageToken(payload) {
  return payload?.page_token ?? payload?.data?.page_token ?? null;
}

function extractHasMore(payload) {
  return payload?.has_more === true || payload?.data?.has_more === true;
}

function richTextToText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(richTextToText).filter(Boolean).join("");
  if (typeof value === "object") {
    const direct = [
      value.text,
      value.content,
      value.plain_text,
      value.plainText,
      value.name,
    ].filter((item) => typeof item === "string" && item.trim());
    if (direct.length > 0) return direct.join("");
    if (Array.isArray(value.elements)) return richTextToText(value.elements);
    if (Array.isArray(value.children)) return richTextToText(value.children);
    return Object.entries(value)
      .filter(([key]) => !/id|token|url|time|user|image|reaction/i.test(key))
      .map(([, entry]) => richTextToText(entry))
      .filter(Boolean)
      .join("");
  }
  return "";
}

function boundedText(value, maxChars) {
  return redactString(richTextToText(value)).replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function fileTypeFromAttachment(attachment) {
  const type = String(attachment?.explicitFileUrlType ?? attachment?.fileType ?? "").toLowerCase();
  if (type === "doc") return "doc";
  if (type === "docx" || type === "wiki") return "docx";
  if (type === "sheet" || type === "sheets") return "sheet";
  if (type === "slides") return "slides";
  if (type === "file") return "file";
  if (type === "base" || type === "bitable") return "bitable";
  return null;
}

function redactCommand(command) {
  return command.map((part) => {
    const text = String(part ?? "");
    if (!text.trim().startsWith("{")) return redactString(text);
    const payload = parseJsonOutput(text);
    if (!payload || typeof payload !== "object") return redactString(text);
    const redacted = { ...payload };
    if (redacted.file_token) redacted.file_token = "[redacted]";
    if (redacted.comment_id) redacted.comment_id = "[redacted]";
    if (Array.isArray(redacted.comment_ids)) redacted.comment_ids = redacted.comment_ids.map(() => "[redacted]");
    return JSON.stringify(redacted);
  });
}

function sanitizeSource(source) {
  return {
    sourceId: source.sourceId,
    fileName: source.fileName,
    fileType: source.fileType,
    fileTokenPresent: Boolean(source.fileToken),
    fileTokenHash: source.fileToken ? hashId(source.fileToken) : null,
    explicitFileReference: source.explicitFileReference,
    downloadMethod: source.downloadMethod,
    apiEligible: source.apiEligible,
  };
}

function createSourceResult(source) {
  return {
    ...sanitizeSource(source),
    status: "body_ready_comments_not_available",
    method: "unavailable",
    apiStatus: source.apiEligible ? "not_attempted" : "not_eligible",
    identityTried: [],
    requiredScopes: REQUIRED_COMMENT_SCOPES,
    commentThreadCount: 0,
    replyCount: 0,
    unresolvedCount: 0,
    comments: [],
    plannedCommands: [],
    errors: [],
    reason: source.apiEligible
      ? "feishu_comment_api_not_attempted"
      : "no_feishu_file_token_or_supported_file_type_for_comment_api",
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  };
}

function summarizeComments(comments) {
  const replyCount = comments.reduce((sum, comment) => sum + (comment.replyCount ?? 0), 0);
  const unresolvedCount = comments.filter((comment) => comment.isSolved === false || comment.isSolved == null).length;
  return {
    commentThreadCount: comments.length,
    replyCount,
    unresolvedCount,
  };
}

function identitySequence() {
  const configured = String(process.env.FEISHU_REVIEW_CONTEXT_AS ?? "auto").trim().toLowerCase();
  if (configured === "user") return ["user"];
  if (configured === "bot") return ["bot"];
  return ["user", "bot"];
}

function classifyCommentFailure(result) {
  const text = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  if (/1069303|forbidden|permission|scope|docs:document\.comment:read|drive:drive:readonly|HTTP 403|status.?403/i.test(text)) {
    return {
      status: "comment_api_permission_blocked",
      reason: "feishu_comment_scope_or_document_permission_missing",
      requiredScopes: REQUIRED_COMMENT_SCOPES,
    };
  }
  if (/unknown command|Unknown resource|Unknown method|not found/i.test(text)) {
    return {
      status: "body_ready_comments_not_available",
      reason: "lark_cli_comment_command_unavailable",
      requiredScopes: REQUIRED_COMMENT_SCOPES,
    };
  }
  return {
    status: "body_ready_comments_not_available",
    reason: "feishu_comment_api_unavailable",
    requiredScopes: REQUIRED_COMMENT_SCOPES,
  };
}

function sanitizeReply(reply) {
  const contentText = boundedText(reply?.content ?? reply?.text ?? "", REPLY_TEXT_MAX_CHARS);
  return {
    replyId: reply?.reply_id ?? reply?.id ?? null,
    text: contentText,
    textHash: contentText ? hashText(contentText) : null,
    authorIdHash: hashId(reply?.user_id ?? reply?.userId ?? reply?.open_id),
    createdAt: reply?.create_time ?? null,
    updatedAt: reply?.update_time ?? null,
    rawSecretsReturned: false,
  };
}

function repliesFromComment(comment) {
  const replies = comment?.reply_list?.replies ?? comment?.replies ?? [];
  return Array.isArray(replies) ? replies.map(sanitizeReply) : [];
}

function sanitizeComment(comment, source) {
  const text = boundedText(comment?.content ?? comment?.text ?? comment?.comment ?? "", COMMENT_TEXT_MAX_CHARS);
  const quote = boundedText(comment?.quote ?? comment?.anchor ?? "", 500);
  const replies = repliesFromComment(comment);
  return {
    commentId: comment?.comment_id ?? comment?.id ?? null,
    sourceId: source.sourceId,
    fileName: source.fileName,
    fileType: source.fileType,
    quote,
    commentText: text,
    commentTextHash: text ? hashText(text) : null,
    isSolved: comment?.is_solved ?? null,
    isWhole: comment?.is_whole ?? null,
    authorIdHash: hashId(comment?.user_id ?? comment?.userId ?? comment?.open_id),
    createdAt: comment?.create_time ?? null,
    updatedAt: comment?.update_time ?? null,
    replies,
    replyCount: replies.length,
    rawSecretsReturned: false,
  };
}

async function runCli(runCommand, args, options) {
  if (options?.dryRun) {
    return { exitCode: 0, stdout: JSON.stringify({ data: { items: [] } }), stderr: "", dryRun: true };
  }
  return await runCommand("lark-cli", args, { timeoutMs: options?.timeoutMs ?? 120000 });
}

async function listCommentsWithCli(source, identity, runCommand, options) {
  const params = {
    file_token: source.fileToken,
    file_type: source.fileType,
    is_solved: false,
    page_size: 100,
    user_id_type: "open_id",
  };
  const args = [
    "drive",
    "file.comments",
    "list",
    "--as",
    identity,
    "--params",
    JSON.stringify(params),
    "--page-all",
    "--format",
    "json",
  ];
  const cli = await runCli(runCommand, args, options);
  if (cli.exitCode !== 0) return { ok: false, cli, command: redactCommand(["lark-cli", ...args]) };
  const payload = parseJsonOutput(cli.stdout);
  return {
    ok: true,
    payload,
    items: extractItems(payload),
    hasMore: extractHasMore(payload),
    pageToken: extractPageToken(payload),
    command: redactCommand(["lark-cli", ...args]),
    cli,
  };
}

async function listRepliesWithCli(source, comment, identity, runCommand, options) {
  const commentId = comment?.comment_id ?? comment?.id;
  if (!commentId) return [];
  const params = {
    file_token: source.fileToken,
    file_type: source.fileType,
    comment_id: commentId,
    page_size: 100,
    need_reaction: false,
    user_id_type: "open_id",
  };
  const args = [
    "drive",
    "file.comment.replys",
    "list",
    "--as",
    identity,
    "--params",
    JSON.stringify(params),
    "--page-all",
    "--format",
    "json",
  ];
  const cli = await runCli(runCommand, args, options);
  if (cli.exitCode !== 0) return [];
  return extractItems(parseJsonOutput(cli.stdout));
}

async function batchQueryCommentsWithCli(source, comments, identity, runCommand, options) {
  const ids = comments.map((comment) => comment?.comment_id ?? comment?.id).filter(Boolean).slice(0, 100);
  if (ids.length === 0 || !envFlag("FEISHU_REVIEW_CONTEXT_BATCH_QUERY")) return null;
  const params = {
    file_token: source.fileToken,
    file_type: source.fileType,
    user_id_type: "open_id",
  };
  const data = {
    comment_ids: ids,
    need_reaction: false,
  };
  const args = [
    "drive",
    "file.comments",
    "batch_query",
    "--as",
    identity,
    "--params",
    JSON.stringify(params),
    "--data",
    JSON.stringify(data),
    "--format",
    "json",
  ];
  const cli = await runCli(runCommand, args, options);
  if (cli.exitCode !== 0) return null;
  return extractItems(parseJsonOutput(cli.stdout));
}

async function listCommentsWithSdk(source) {
  if (!envFlag("FEISHU_REVIEW_CONTEXT_SDK_FALLBACK", true)) {
    return { ok: false, reason: "sdk_fallback_disabled" };
  }
  if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) {
    return { ok: false, reason: "sdk_missing_app_credentials" };
  }
  try {
    const lark = await import("@larksuiteoapi/node-sdk");
    const client = new lark.Client({
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      appType: lark.AppType?.SelfBuild,
      domain: lark.Domain?.Feishu,
    });
    const response = await client.request({
      method: "GET",
      url: `/open-apis/drive/v1/files/${source.fileToken}/comments`,
      params: {
        file_type: source.fileType,
        is_solved: false,
        page_size: 100,
        user_id_type: "open_id",
      },
    });
    return { ok: true, payload: response, items: extractItems(response), identity: "bot", method: "sdk" };
  } catch (error) {
    return { ok: false, reason: "sdk_comment_api_failed", error: redactString(error instanceof Error ? error.message : String(error)).slice(0, 1000) };
  }
}

export function buildReviewSources(task, contexts) {
  return contexts.map((context, index) => {
    const attachment = task.attachments?.[index] ?? {};
    const fileType = fileTypeFromAttachment(attachment);
    return {
      sourceId: `file-${String(index + 1).padStart(2, "0")}`,
      fileName: context.fileName,
      fileToken: attachment.fileToken ?? null,
      fileType,
      explicitFileReference: Boolean(attachment.explicitFileReference),
      downloadMethod: attachment.downloadMethod ?? null,
      apiEligible: Boolean(attachment.fileToken && fileType),
    };
  });
}

export async function fetchFeishuDocumentReviewContext({ task, contexts, runCommand, options = {} }) {
  const sources = buildReviewSources(task, contexts);
  const eligibleSources = sources.filter((source) => source.apiEligible);
  const sourceResults = new Map(sources.map((source) => [source.sourceId, createSourceResult(source)]));
  const plannedCommands = [];
  const identityTried = [];
  const errors = [];
  const comments = [];
  let method = "unavailable";
  let apiStatus = "not_attempted";

  if (eligibleSources.length === 0) {
    return {
      status: "body_ready_comments_not_available",
      method,
      apiStatus,
      identityTried,
      requiredScopes: REQUIRED_COMMENT_SCOPES,
      commentThreadCount: 0,
      replyCount: 0,
      unresolvedCount: 0,
      comments,
      sources: sources.map(sanitizeSource),
      sourceResults: [...sourceResults.values()],
      plannedCommands,
      errors,
      reason: "no_feishu_file_token_or_supported_file_type_for_comment_api",
      generatedAt: nowIso(),
      rawSecretsReturned: false,
      rawMediaExternalUpload: false,
    };
  }

  let permissionBlocked = false;
  for (const source of eligibleSources) {
    let sourceHandled = false;
    const sourceResult = sourceResults.get(source.sourceId);
    for (const identity of identitySequence()) {
      identityTried.push(identity);
      sourceResult.identityTried.push(identity);
      const listed = await listCommentsWithCli(source, identity, runCommand, {
        dryRun: options.dryRun,
        timeoutMs: options.timeoutMs,
      });
      plannedCommands.push(listed.command);
      sourceResult.plannedCommands.push(listed.command);
      if (!listed.ok) {
        const failure = classifyCommentFailure(listed.cli);
        const errorRecord = {
          sourceId: source.sourceId,
          identity,
          method: "cli",
          status: failure.status,
          reason: failure.reason,
          requiredScopes: failure.requiredScopes,
          stderrTail: redactString(listed.cli?.stderr ?? "").slice(-1000),
        };
        errors.push(errorRecord);
        sourceResult.errors.push(errorRecord);
        permissionBlocked = permissionBlocked || failure.status === "comment_api_permission_blocked";
        if (failure.reason === "lark_cli_comment_command_unavailable") {
          const sdk = await listCommentsWithSdk(source);
          if (sdk.ok) {
            method = "sdk";
            apiStatus = "success";
            const sourceComments = (sdk.items ?? []).map((item) => sanitizeComment(item, source));
            comments.push(...sourceComments);
            sourceResult.comments.push(...sourceComments);
            Object.assign(sourceResult, {
              status: "ready",
              method: "sdk",
              apiStatus: "success",
              reason: null,
              ...summarizeComments(sourceComments),
              identityTried: [...new Set(sourceResult.identityTried)],
            });
            sourceHandled = true;
            break;
          }
          const sdkError = { sourceId: source.sourceId, identity: "bot", method: "sdk", status: "failed", reason: sdk.reason, error: sdk.error ?? null };
          errors.push(sdkError);
          sourceResult.errors.push(sdkError);
        }
        continue;
      }

      method = "cli";
      apiStatus = "success";
      const batchItems = await batchQueryCommentsWithCli(source, listed.items, identity, runCommand, {
        dryRun: options.dryRun,
        timeoutMs: options.timeoutMs,
      });
      const items = batchItems?.length ? batchItems : listed.items;
      const sourceComments = [];
      for (const item of items) {
        const needsReplyFetch = item?.has_more === true || item?.reply_list?.has_more === true;
        const extraReplies = needsReplyFetch ? await listRepliesWithCli(source, item, identity, runCommand, {
          dryRun: options.dryRun,
          timeoutMs: options.timeoutMs,
        }) : [];
        if (extraReplies.length > 0) {
          item.reply_list = {
            ...(item.reply_list ?? {}),
            replies: [...(item.reply_list?.replies ?? []), ...extraReplies],
          };
        }
        sourceComments.push(sanitizeComment(item, source));
      }
      comments.push(...sourceComments);
      sourceResult.comments.push(...sourceComments);
      Object.assign(sourceResult, {
        status: "ready",
        method: "cli",
        apiStatus: "success",
        reason: null,
        ...summarizeComments(sourceComments),
        identityTried: [...new Set(sourceResult.identityTried)],
      });
      sourceHandled = true;
      break;
    }
    if (!sourceHandled) {
      const sourcePermissionBlocked = sourceResult.errors.some((error) => error.status === "comment_api_permission_blocked");
      Object.assign(sourceResult, {
        status: sourcePermissionBlocked ? "comment_api_permission_blocked" : "body_ready_comments_not_available",
        method: "unavailable",
        apiStatus: sourcePermissionBlocked ? "permission_blocked" : "failed",
        reason: sourcePermissionBlocked ? "feishu_comment_scope_or_document_permission_missing" : "feishu_comment_api_unavailable",
        identityTried: [...new Set(sourceResult.identityTried)],
      });
    }
  }

  const { replyCount, unresolvedCount } = summarizeComments(comments);
  const uniqueIdentityTried = [...new Set(identityTried)];
  const results = [...sourceResults.values()];
  const readyCount = results.filter((result) => result.status === "ready").length;
  const unavailableCount = results.filter((result) => result.status !== "ready").length;
  const hasPermissionBlocked = results.some((result) => result.status === "comment_api_permission_blocked");
  if (readyCount > 0 && unavailableCount > 0) apiStatus = "partial_success";
  if (readyCount === 0 && hasPermissionBlocked) apiStatus = "permission_blocked";
  if (readyCount === 0 && !hasPermissionBlocked) apiStatus = apiStatus === "success" ? "success" : "failed";
  const status = readyCount > 0 && unavailableCount > 0
    ? "partial_ready"
    : readyCount > 0
    ? "ready"
    : hasPermissionBlocked || permissionBlocked
      ? "comment_api_permission_blocked"
      : "body_ready_comments_not_available";
  return {
    status,
    method: readyCount > 0 ? method : "unavailable",
    apiStatus,
    identityTried: uniqueIdentityTried,
    requiredScopes: REQUIRED_COMMENT_SCOPES,
    commentThreadCount: comments.length,
    replyCount,
    unresolvedCount,
    comments,
    sources: sources.map(sanitizeSource),
    sourceResults: results,
    plannedCommands,
    errors,
    reason: status === "ready" || status === "partial_ready"
      ? null
      : hasPermissionBlocked || permissionBlocked
        ? "feishu_comment_scope_or_document_permission_missing"
        : "feishu_comment_api_unavailable",
    generatedAt: nowIso(),
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  };
}
