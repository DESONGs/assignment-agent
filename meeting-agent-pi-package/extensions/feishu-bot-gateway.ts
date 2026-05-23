import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type GatewayMode = "long_connection" | "http_callback" | "mcp_tools_only";

const REQUIRED_PERMISSIONS = [
  "im:message",
  "im:message:send_as_bot",
  "im:message.p2p_msg",
  "im:message.group_at_msg",
];

const REQUIRED_EVENTS = ["im.message.receive_v1"];

function boolFromEnv(name: string) {
  return Boolean(process.env[name]?.trim());
}

function flagFromEnv(name: string) {
  return /^(1|true|yes|on)$/i.test(process.env[name]?.trim() ?? "");
}

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (normalized === "localhost" || normalized === "::1") return true;

  const ipv4 = normalized.split(".");
  if (ipv4.length !== 4) return false;
  const octets = ipv4.map((part) => Number(part));
  return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && octets[0] === 127;
}

function handlerPolicy() {
  const raw = process.env.FEISHU_BOT_HANDLER_URL?.trim();
  const remoteAllowed = flagFromEnv("FEISHU_BOT_ALLOW_REMOTE_HANDLER");
  if (!raw) {
    return {
      configured: false,
      allowed: false,
      localhostOnlyByDefault: true,
      remoteHandlerAllowedByEnv: remoteAllowed,
      reason: "not_configured",
      rawHandlerUrlReturned: false,
    };
  }

  try {
    const url = new URL(raw);
    const protocolAllowed = url.protocol === "http:" || url.protocol === "https:";
    const hasCredentials = Boolean(url.username || url.password);
    const local = isLoopbackHostname(url.hostname);
    const allowed = protocolAllowed && !hasCredentials && (local || remoteAllowed);
    return {
      configured: true,
      allowed,
      localhost: local,
      localhostOnlyByDefault: true,
      remoteHandlerAllowedByEnv: remoteAllowed,
      reason: allowed
        ? "allowed"
        : hasCredentials
          ? "url_credentials_not_allowed"
          : protocolAllowed
            ? "remote_handler_blocked"
            : "unsupported_protocol",
      rawHandlerUrlReturned: false,
    };
  } catch {
    return {
      configured: true,
      allowed: false,
      localhostOnlyByDefault: true,
      remoteHandlerAllowedByEnv: remoteAllowed,
      reason: "invalid_url",
      rawHandlerUrlReturned: false,
    };
  }
}

function redactedEnvStatus() {
  const policy = handlerPolicy();
  const effectiveReplyMode = process.env.FEISHU_BOT_REPLY_MODE?.trim() || (policy.configured && policy.allowed ? "http" : "diagnostic");
  return {
    FEISHU_APP_ID: boolFromEnv("FEISHU_APP_ID"),
    FEISHU_APP_SECRET: boolFromEnv("FEISHU_APP_SECRET"),
    FEISHU_BOT_REPLY_MODE: effectiveReplyMode,
    FEISHU_BOT_HANDLER_URL: boolFromEnv("FEISHU_BOT_HANDLER_URL"),
    FEISHU_BOT_HANDLER_TIMEOUT_MS: process.env.FEISHU_BOT_HANDLER_TIMEOUT_MS?.trim() || "20000",
    FEISHU_BOT_ALLOW_REMOTE_HANDLER: flagFromEnv("FEISHU_BOT_ALLOW_REMOTE_HANDLER"),
  };
}

function baseChecklist(mode: GatewayMode) {
  const consoleSteps =
    mode === "http_callback"
      ? [
          "Enable bot capability in Feishu Open Platform.",
          "Configure Events & Callbacks with a public HTTPS request URL.",
          "Subscribe to im.message.receive_v1.",
          "Apply for and publish required message permissions/events.",
          "Ensure the bot is available to target users and added to target groups.",
        ]
      : mode === "long_connection"
        ? [
            "Enable bot capability in Feishu Open Platform.",
            "Configure Events & Callbacks to use long connection.",
            "Subscribe to im.message.receive_v1.",
            "Apply for and publish required message permissions/events.",
            "Run the local gateway process so the app establishes an active WebSocket connection.",
            "Ensure the bot is available to target users and added to target groups.",
          ]
        : [
            "Use MCP only for AI tool calls into Feishu APIs.",
            "Do not expect MCP by itself to receive Feishu bot messages.",
            "Add long connection or HTTP callback if the bot must reply inside Feishu chats.",
          ];

  return {
    mode,
    requiredPermissions: REQUIRED_PERMISSIONS,
    requiredEvents: REQUIRED_EVENTS,
    consoleSteps,
    runtime:
      mode === "long_connection"
        ? {
            command: "node meeting-agent-pi-package/tools/feishu_bot_event_gateway.mjs",
            requiredPackage: "@larksuiteoapi/node-sdk >= 1.24.0",
            env: ["FEISHU_APP_ID", "FEISHU_APP_SECRET"],
            optionalEnv: ["FEISHU_BOT_REPLY_MODE", "FEISHU_BOT_HANDLER_URL", "FEISHU_BOT_HANDLER_TIMEOUT_MS", "FEISHU_BOT_ALLOW_REMOTE_HANDLER", "FEISHU_AGENT_ASYNC"],
            handlerPolicy:
              "FEISHU_BOT_HANDLER_URL is loopback-only by default and switches the gateway to HTTP handler mode when allowed. Set FEISHU_BOT_ALLOW_REMOTE_HANDLER=1 only for an approved remote handler.",
          }
        : mode === "http_callback"
          ? {
              requirement: "Public HTTPS callback service that verifies Feishu event requests and replies through OpenAPI.",
            }
          : {
              requirement: "MCP server can be added separately for tool access, but it is not the chat event receiver.",
            },
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "feishu_bot_gateway_plan",
    label: "Feishu Bot Gateway Plan",
    description:
      "Explain and plan Feishu bot message receiving. This does not read app secrets and does not replace feishu_cli for active Feishu operations.",
    parameters: Type.Object({
      mode: Type.Optional(
        Type.Union([
          Type.Literal("long_connection"),
          Type.Literal("http_callback"),
          Type.Literal("mcp_tools_only"),
        ]),
      ),
      purpose: Type.Optional(Type.String({ description: "Why the bot needs to receive/reply to messages." })),
    }),
    async execute(_toolCallId, params) {
      const mode = (params.mode ?? "long_connection") as GatewayMode;
      const plan = {
        provider: "feishu",
        component: "bot-event-gateway",
        purpose: params.purpose ?? "Receive im.message.receive_v1 events and reply from the meeting agent.",
        mcpRequiredForChatReply: false,
        larkCliRole: "Active OpenAPI/Docs/Drive/IM operations only; not a message event listener.",
        gateway: baseChecklist(mode),
        credentialPolicy: {
          readFromEnvOnly: true,
          neverReturnSecrets: true,
          doNotCommitAppSecret: true,
          handlerUrlRedacted: true,
          handlerLocalhostOnlyByDefault: true,
        },
      };

      return {
        content: [{ type: "text", text: JSON.stringify(plan, null, 2) }],
        details: plan,
      };
    },
  });

  pi.registerTool({
    name: "feishu_bot_gateway_check",
    label: "Feishu Bot Gateway Check",
    description:
      "Return a redacted local readiness check for the Feishu bot event gateway. Secret values are never returned.",
    parameters: Type.Object({}),
    async execute() {
      const env = redactedEnvStatus();
      const missingEnv = Object.entries(env)
        .filter(([key, value]) => (key === "FEISHU_APP_ID" || key === "FEISHU_APP_SECRET" ? value !== true : false))
        .map(([key]) => key);
      const result = {
        provider: "feishu",
        component: "bot-event-gateway",
        env,
        missingEnv,
        readyToStartLocalGateway: missingEnv.length === 0,
        requiredPermissions: REQUIRED_PERMISSIONS,
        requiredEvents: REQUIRED_EVENTS,
        recommendedMode: "long_connection",
        serviceCommand: "node meeting-agent-pi-package/tools/feishu_bot_event_gateway.mjs",
        handlerPolicy: handlerPolicy(),
        rawSecretsReturned: false,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
