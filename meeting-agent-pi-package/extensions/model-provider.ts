import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ProviderRecord = {
  provider: string;
  protocol: "openai-chat-completions" | "mock";
  apiKeyEnv: string | null;
  baseUrlEnv: string | null;
  defaultBaseUrl: string | null;
  chatCompletionsPath: string | null;
  requiredEnv: string[];
  allowedModels?: string[];
  supportsFileInput?: boolean;
  supportsTextFallback?: boolean;
};

type GenerateTextParams = {
  provider: string;
  model: string;
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  mockResponse?: string;
  stream?: boolean;
  streamTracePath?: string;
  streamTraceSummaryPath?: string;
  streamTraceMeta?: Record<string, unknown>;
};

const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(extensionDir);
const workspaceDir = dirname(packageDir);
const providersPath = join(packageDir, "runtime", "model-providers.json");

const SECRET_PATTERNS = [
  /(app_secret|client_secret|refresh_token|access_token|authorization|cookie|session)\s*[:=]\s*["']?[A-Za-z0-9._\-]{8,}/i,
  /bearer\s+[A-Za-z0-9._\-]{8,}/i,
];
const PROVIDER_ENV_NAMES = ["DEEPSEEK_API_KEY", "XIAOMI_TOKEN_PLAN_SGP_API_KEY", "XIAOMI_BASE_URL"];
const RAW_CONTENT_KEY_PATTERN =
  /rawTranscript|fullTranscript|transcriptSegments|rawMeetingContent|transcriptText|rawMedia|base64Audio/i;
const RAW_CONTENT_JSON_FIELD_PATTERN =
  /["'](?:rawTranscript|fullTranscript|transcriptSegments|rawMeetingContent|transcriptText|rawMedia|base64Audio)["']\s*:/i;
const MAX_PROMPT_CHARS = 180_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TIMEOUT_MS = 600_000;

function loadProviders() {
  return JSON.parse(readFileSync(providersPath, "utf8")) as { version: string; providers: ProviderRecord[] };
}

function providerRecord(provider: string) {
  return loadProviders().providers.find((item) => item.provider.toLowerCase() === provider.toLowerCase());
}

function containsSecretLikeValue(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

function containsRawContentKey(value: unknown, key = ""): boolean {
  if (RAW_CONTENT_KEY_PATTERN.test(key)) return true;
  if (typeof value === "string") return RAW_CONTENT_JSON_FIELD_PATTERN.test(value);
  if (Array.isArray(value)) return value.some((item, index) => containsRawContentKey(item, String(index)));
  if (value && typeof value === "object") {
    return Object.entries(value).some(([childKey, childValue]) => containsRawContentKey(childValue, childKey));
  }
  return false;
}

function routeMatchesProvider(route: any, provider: string, model: string) {
  if (!route || typeof route !== "object") return false;
  const selected = route.selected ?? route.modelRoute?.selected;
  return route.status === "selected" && selected?.provider === provider && selected?.model === model;
}

function redact(value: string) {
  let result = value;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED_SECRET_LIKE_VALUE]");
  }
  return result.slice(0, 600);
}

function redactDelta(value: string) {
  let result = value;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED_SECRET_LIKE_VALUE]");
  }
  return result;
}

function isInside(parent: string, child: string) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeWorkspacePath(path?: string) {
  if (!path) return null;
  const resolved = resolve(path);
  if (!isInside(workspaceDir, resolved)) {
    throw new Error("model_stream_trace_path_outside_workspace_blocked");
  }
  return resolved;
}

function appendTrace(path: string | null, event: Record<string, unknown>) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
}

function writeTraceSummary(path: string | null, tracePath: string | null, summary: Record<string, unknown>) {
  const target = path ?? (tracePath ? tracePath.replace(/\.ndjson$/i, ".summary.json") : null);
  if (!target) return;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

function effectiveTimeoutMs(value?: number) {
  const requested = Number(value ?? DEFAULT_TIMEOUT_MS);
  const max = Number(process.env.MODEL_PROVIDER_MAX_TIMEOUT_MS ?? DEFAULT_MAX_TIMEOUT_MS);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(max) || max <= 0) return requested;
  return Math.min(Math.max(1, Math.floor(requested)), Math.floor(max));
}

function normalizeBaseUrl(record: ProviderRecord) {
  const raw = record.baseUrlEnv ? process.env[record.baseUrlEnv]?.trim() : "";
  const value = raw || record.defaultBaseUrl || "";
  if (!value) return null;
  return value.replace(/\/+$/, "");
}

function providerStatus(record: ProviderRecord) {
  const missingEnv = record.requiredEnv.filter((name) => !process.env[name]?.trim());
  const configuredEnv = record.requiredEnv.filter((name) => process.env[name]?.trim());
  const baseUrl = normalizeBaseUrl(record);
  const ready = record.protocol === "mock" || (missingEnv.length === 0 && Boolean(baseUrl));
  return {
    provider: record.provider,
    protocol: record.protocol,
    ready,
    missingEnv,
    configuredEnv,
    loadedProviderEnvNames: PROVIDER_ENV_NAMES.filter((name) => process.env[name]?.trim()),
    baseUrlConfigured: Boolean(baseUrl),
    apiKeyEnv: record.apiKeyEnv,
    baseUrlEnv: record.baseUrlEnv,
    defaultBaseUrlProvided: Boolean(record.defaultBaseUrl),
    allowedModels: record.allowedModels ?? [],
    supportsFileInput: record.supportsFileInput === true,
    supportsTextFallback: record.supportsTextFallback !== false,
    rawSecretsReturned: false,
    requestBodyReturned: false,
  };
}

function mockSections(prompt: string) {
  const marker = prompt.match(/## 目标章节[^\n]*\n\n([\s\S]*?)(?:\n\n## |$)/);
  if (!marker) return [];
  return marker[1]
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*[-*]\s+(.+?)\s*$/)?.[1])
    .filter(Boolean) as string[];
}

function mockMarkdown(params: GenerateTextParams) {
  const sections = mockSections(params.prompt);
  if (sections.length > 0) {
    return sections
      .map((section) => [
        `## ${section}`,
        "",
        "- 已确认事实：mock provider 已接收该目标章节的 bounded context pack 和 evidence 输入。",
        "- 推断：这是 section-batch smoke 输出，用于验证章节批次、合并、QA gate 和 model-route artifact。",
        "- 待确认：真实 provider 生成时仍需检查 evidence 覆盖、章节完整度和发布质量。",
      ].join("\n"))
      .join("\n\n");
  }
  const title = params.prompt.match(/生成\s*([^\n。]+)|#\s*([^\n]+)/)?.[1] ?? params.model;
  return `# Mock ${title}\n\n## 已确认事实\n\n- mock provider 已接收渲染后的正式 prompt 或 bounded context pack。\n\n## 推断\n\n- 这是并行 document worker 的 smoke 输出，不代表真实会议结论。\n\n## 待确认\n\n- 真实 provider 配置和 evidence 覆盖需要在生产运行时确认。\n`;
}

export async function generateText(params: GenerateTextParams) {
  const tracePath = safeWorkspacePath(params.streamTracePath);
  const traceSummaryPath = safeWorkspacePath(params.streamTraceSummaryPath);
  const traceMeta = params.streamTraceMeta ?? {};
  const traceStartedAt = new Date().toISOString();
  const traceStartedAtMs = Date.now();
  let timeoutMs = effectiveTimeoutMs(params.timeoutMs);
  let requestStartedAtMs = traceStartedAtMs;
  let firstByteAt: string | null = null;
  let streamChunkCount = 0;
  const blocked = (reason: string, extra: Record<string, unknown> = {}) => {
    const completedAt = new Date().toISOString();
    const result = {
      status: "blocked",
      reason,
      provider: params.provider,
      model: params.model,
      rawSecretsReturned: false,
      requestBodyReturned: false,
      ...extra,
    };
    const summary = {
      schemaVersion: "model-stream-trace-summary-v1",
      ...traceMeta,
      ...result,
      startedAt: traceStartedAt,
      completedAt,
      timeoutMs,
      durationMs: Date.now() - traceStartedAtMs,
      firstByteAt,
      chunkCount: streamChunkCount,
    };
    appendTrace(tracePath, {
      schemaVersion: "model-stream-delta-v1",
      event: "stream_blocked",
      ...summary,
      at: completedAt,
    });
    writeTraceSummary(traceSummaryPath, tracePath, summary);
    return result;
  };
  try {
    if (!params.prompt || typeof params.prompt !== "string") {
      return blocked("prompt_required");
    }
    if (params.prompt.length > MAX_PROMPT_CHARS) {
      return blocked("prompt_too_large", { maxPromptChars: MAX_PROMPT_CHARS });
    }
    if (containsSecretLikeValue(params.prompt) || containsSecretLikeValue(params.systemPrompt)) {
      return blocked("model_prompt_secret_like_input_blocked");
    }
    if (containsRawContentKey({ prompt: params.prompt, systemPrompt: params.systemPrompt })) {
      return blocked("model_prompt_raw_content_key_blocked");
    }

    const record = providerRecord(params.provider);
    if (!record) {
      return blocked("model_provider_not_found");
    }
    const status = providerStatus(record);
    if (record.protocol === "mock") {
      return {
        status: "completed",
        provider: record.provider,
        model: params.model,
        content: params.mockResponse ?? mockMarkdown(params),
        usage: { prompt: 0, completion: 0, total: 0 },
        rawSecretsReturned: false,
        requestBodyReturned: false,
        mockProvider: true,
      };
    }
    if (!status.ready) {
      return blocked("model_provider_unavailable", {
        provider: record.provider,
        missingEnv: status.missingEnv,
        baseUrlConfigured: status.baseUrlConfigured,
      });
    }
    if (record.allowedModels?.length && !record.allowedModels.includes(params.model)) {
      return blocked("model_not_allowed_for_provider", {
        provider: record.provider,
        allowedModels: record.allowedModels,
      });
    }

    const baseUrl = normalizeBaseUrl(record);
    const apiKey = record.apiKeyEnv ? process.env[record.apiKeyEnv]?.trim() : "";
    if (!baseUrl || !apiKey || !record.chatCompletionsPath) {
      return blocked("model_provider_unavailable", { provider: record.provider });
    }

    const controller = new AbortController();
    timeoutMs = effectiveTimeoutMs(params.timeoutMs);
    requestStartedAtMs = Date.now();
    appendTrace(tracePath, {
      schemaVersion: "model-stream-delta-v1",
      event: "request_started",
      ...traceMeta,
      provider: record.provider,
      model: params.model,
      at: new Date(requestStartedAtMs).toISOString(),
      timeoutMs,
      stream: params.stream === true,
      rawSecretsReturned: false,
      requestBodyReturned: false,
    });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`${baseUrl}${record.chatCompletionsPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: params.model,
        messages: [
          params.systemPrompt ? { role: "system", content: params.systemPrompt } : null,
          { role: "user", content: params.prompt },
        ].filter(Boolean),
        temperature: params.temperature ?? 0.2,
        max_tokens: params.maxTokens ?? 4000,
        ...(params.stream === true ? { stream: true } : {}),
      }),
      signal: controller.signal,
    });
    appendTrace(tracePath, {
      schemaVersion: "model-stream-delta-v1",
      event: "response_headers_received",
      ...traceMeta,
      provider: record.provider,
      model: params.model,
      at: new Date().toISOString(),
      httpStatus: response.status,
      ok: response.ok,
      durationMs: Date.now() - requestStartedAtMs,
      rawSecretsReturned: false,
      requestBodyReturned: false,
    });

    if (params.stream === true) {
      if (!response.ok) {
        clearTimeout(timeout);
        const responseText = await response.text();
        let parsed: any = null;
        try {
          parsed = responseText ? JSON.parse(responseText) : null;
        } catch {
          parsed = null;
        }
        const blocked = {
          status: "blocked",
          reason: "model_provider_http_error",
          provider: record.provider,
          model: params.model,
          httpStatus: response.status,
          error: redact(parsed?.error?.message ?? responseText),
          rawSecretsReturned: false,
          requestBodyReturned: false,
        };
        writeTraceSummary(traceSummaryPath, tracePath, {
          schemaVersion: "model-stream-trace-summary-v1",
          ...traceMeta,
          ...blocked,
          startedAt: traceStartedAt,
          completedAt: new Date().toISOString(),
          timeoutMs,
          durationMs: Date.now() - requestStartedAtMs,
          firstByteAt,
          chunkCount: streamChunkCount,
        });
        appendTrace(tracePath, {
          schemaVersion: "model-stream-delta-v1",
          event: "stream_blocked",
          ...traceMeta,
          ...blocked,
          at: new Date().toISOString(),
          timeoutMs,
          durationMs: Date.now() - requestStartedAtMs,
          firstByteAt,
          chunkCount: streamChunkCount,
        });
        return blocked;
      }
      if (!response.body) {
        clearTimeout(timeout);
        return blocked("model_provider_stream_body_missing", {
          provider: record.provider,
        });
      }

      appendTrace(tracePath, {
        schemaVersion: "model-stream-delta-v1",
        event: "stream_started",
        ...traceMeta,
        provider: record.provider,
        model: params.model,
        at: traceStartedAt,
        timeoutMs,
        rawSecretsReturned: false,
        requestBodyReturned: false,
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let seq = 0;
      let finishReason: string | null = null;
      let usage: any = null;
      let doneSeen = false;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!firstByteAt) firstByteAt = new Date().toISOString();
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data) continue;
            if (data === "[DONE]") {
              doneSeen = true;
              continue;
            }
            let parsed: any = null;
            try {
              parsed = JSON.parse(data);
            } catch {
              appendTrace(tracePath, {
                schemaVersion: "model-stream-delta-v1",
                event: "stream_parse_error",
                ...traceMeta,
                provider: record.provider,
                model: params.model,
                seq,
                at: new Date().toISOString(),
                rawPreview: redact(data).slice(0, 200),
                rawSecretsReturned: false,
                requestBodyReturned: false,
              });
              continue;
            }
            usage = parsed?.usage ?? usage;
            const choice = parsed?.choices?.[0] ?? {};
            finishReason = choice.finish_reason ?? finishReason;
            const delta = choice.delta?.content ?? choice.text ?? choice.message?.content ?? "";
            if (delta) {
              content += delta;
              appendTrace(tracePath, {
                schemaVersion: "model-stream-delta-v1",
                event: "delta",
                ...traceMeta,
                provider: record.provider,
                model: params.model,
                seq,
                at: new Date().toISOString(),
                delta: redactDelta(String(delta)),
                deltaChars: String(delta).length,
                contentChars: content.length,
                rawSecretsReturned: false,
                requestBodyReturned: false,
              });
              seq += 1;
              streamChunkCount = seq;
            }
          }
        }
      } finally {
        clearTimeout(timeout);
      }
      const completedAt = new Date().toISOString();
      const summary = {
        schemaVersion: "model-stream-trace-summary-v1",
        ...traceMeta,
        status: content ? "completed" : "blocked",
        reason: content ? null : "model_provider_empty_response",
        provider: record.provider,
        model: params.model,
        startedAt: traceStartedAt,
        firstByteAt,
        completedAt,
        timeoutMs,
        durationMs: Date.now() - requestStartedAtMs,
        chunkCount: seq,
        contentChars: content.length,
        finishReason,
        doneSeen,
        usage,
        rawSecretsReturned: false,
        requestBodyReturned: false,
      };
      writeTraceSummary(traceSummaryPath, tracePath, summary);
      appendTrace(tracePath, { event: "stream_completed", ...summary });
      if (!content) {
        return {
          status: "blocked",
          reason: "model_provider_empty_response",
          provider: record.provider,
          model: params.model,
          rawSecretsReturned: false,
          requestBodyReturned: false,
        };
      }
      return {
        status: "completed",
        provider: record.provider,
        model: params.model,
        content,
        usage,
        finishReason,
        rawSecretsReturned: false,
        requestBodyReturned: false,
        streamTracePath: tracePath,
        streamTraceSummaryPath: traceSummaryPath ?? tracePath?.replace(/\.ndjson$/i, ".summary.json") ?? null,
      };
    }

    const responseText = await response.text().finally(() => clearTimeout(timeout));
    let parsed: any = null;
    try {
      parsed = responseText ? JSON.parse(responseText) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      return blocked("model_provider_http_error", {
        provider: record.provider,
        httpStatus: response.status,
        error: redact(parsed?.error?.message ?? responseText),
      });
    }
    const content = parsed?.choices?.[0]?.message?.content ?? parsed?.choices?.[0]?.text ?? "";
    if (!content) {
      return blocked("model_provider_empty_response", {
        provider: record.provider,
      });
    }
    return {
      status: "completed",
      provider: record.provider,
      model: params.model,
      content,
      usage: parsed?.usage ?? null,
      finishReason: parsed?.choices?.[0]?.finish_reason ?? null,
      rawSecretsReturned: false,
      requestBodyReturned: false,
    };
  } catch (error) {
    const completedAt = new Date().toISOString();
    const reason = error instanceof Error && error.name === "AbortError" ? "model_provider_request_timeout" : "model_provider_request_failed";
    const summary = {
      schemaVersion: "model-stream-trace-summary-v1",
      ...traceMeta,
      status: "blocked",
      reason,
      provider: params.provider,
      model: params.model,
      error: redact(error instanceof Error ? error.message : String(error)),
      startedAt: traceStartedAt,
      completedAt,
      timeoutMs,
      durationMs: Date.now() - requestStartedAtMs,
      firstByteAt,
      chunkCount: streamChunkCount,
      rawSecretsReturned: false,
      requestBodyReturned: false,
    };
    appendTrace(tracePath, {
      schemaVersion: "model-stream-delta-v1",
      event: "stream_blocked",
      ...summary,
      at: completedAt,
    });
    writeTraceSummary(traceSummaryPath, tracePath, summary);
    return {
      status: "blocked",
      reason,
      provider: params.provider,
      model: params.model,
      error: redact(error instanceof Error ? error.message : String(error)),
      timeoutMs,
      durationMs: Date.now() - requestStartedAtMs,
      firstByteAt,
      chunkCount: streamChunkCount,
      rawSecretsReturned: false,
      requestBodyReturned: false,
    };
  }
}

export function checkProviders(provider?: string) {
  const registry = loadProviders();
  const records = provider ? registry.providers.filter((item) => item.provider.toLowerCase() === provider.toLowerCase()) : registry.providers;
  return {
    registryVersion: registry.version,
    providers: records.map(providerStatus),
    providersPath,
    rawSecretsReturned: false,
    requestBodyReturned: false,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "model_provider_check",
    label: "Model Provider Check",
    description: "Check configured model provider readiness without returning secrets or request bodies.",
    parameters: Type.Object({
      provider: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const details = checkProviders(params.provider);
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });

  pi.registerTool({
    name: "model_generate_text",
    label: "Model Generate Text",
    description: "Generate text via a configured provider. Caller must run model_route_plan/model_route_record around production calls.",
    parameters: Type.Object({
      provider: Type.String(),
      model: Type.String(),
      prompt: Type.String(),
      systemPrompt: Type.Optional(Type.String()),
      temperature: Type.Optional(Type.Number()),
      maxTokens: Type.Optional(Type.Number()),
      timeoutMs: Type.Optional(Type.Number()),
      mockResponse: Type.Optional(Type.String()),
      modelRoute: Type.Optional(Type.Any({ description: "Output from model_route_plan. Required for non-mock provider calls." })),
    }),
    async execute(_toolCallId, params) {
      if (params.provider !== "mock" && !routeMatchesProvider(params.modelRoute, params.provider, params.model)) {
        const blocked = {
          status: "blocked",
          reason: "model_route_plan_required",
          provider: params.provider,
          model: params.model,
          rawSecretsReturned: false,
          requestBodyReturned: false,
        };
        return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
      }
      const details = await generateText(params);
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });
}
