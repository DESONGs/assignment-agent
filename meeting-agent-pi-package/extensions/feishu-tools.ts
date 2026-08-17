import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";

type LarkCliResult = {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut?: boolean;
};

type RedactionPolicy = "none" | "auth-status-summary" | "secret-scan";

type FeishuCliDetails = {
  provider: string;
  mode: string;
  commandCategory?: string;
  command?: string[];
  blocked?: boolean;
  reason?: string;
  redactionPolicy?: string;
  cliAvailable?: boolean;
  authVerified?: boolean;
  loginState?: string;
  exitCode?: number;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
  error?: string | null;
  json?: unknown;
  jsonParseError?: string | null;
  checkedAt?: string;
  rawOutputReturned?: boolean;
  identityRedacted?: boolean;
  errorCategory?: string | null;
};

const SECRET_PATTERNS = [
  /(app_secret|client_secret|refresh_token|access_token|authorization|cookie|session)\s*[:=]\s*["']?[A-Za-z0-9._\-]{8,}/i,
  /bearer\s+[A-Za-z0-9._\-]{8,}/i,
  /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/,
  /\b(?:tenant|app|user|open)[_-]?id\s*[:=]\s*["']?[A-Za-z0-9._\-]{6,}/i,
];

function isAuthStatusCommand(args: string[]) {
  return args.length >= 2 && args[0] === "auth" && args[1] === "status";
}

function containsSecretLikeText(value: string) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

function authErrorCategory(result: LarkCliResult) {
  if (result.exitCode === 127) return "cli_not_found";
  if (result.timedOut === true) return "timeout";
  if (result.exitCode === 0) return null;

  const text = `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`.toLowerCase();
  if (
    text.includes("not login") ||
    text.includes("not logged") ||
    text.includes("login required") ||
    text.includes("unauthorized") ||
    text.includes("auth")
  ) {
    return "not_logged_in";
  }

  if (text.includes("verify") || text.includes("--verify")) {
    return "verify_failed";
  }

  return "unknown_error";
}

function summarizeAuthStatus(result: LarkCliResult) {
  const category = authErrorCategory(result);
  const cliAvailable = result.exitCode !== 127;
  const authVerified = result.exitCode === 0;
  const loginState = authVerified ? "logged_in" : category === "not_logged_in" ? "not_logged_in" : "unknown";

  return {
    provider: "feishu",
    mode: "official-lark-cli-passthrough",
    redactionPolicy: "auth-status-summary",
    commandCategory: "auth_status",
    cliAvailable,
    authVerified,
    loginState,
    exitCode: result.exitCode,
    checkedAt: new Date().toISOString(),
    rawOutputReturned: false,
    identityRedacted: true,
    errorCategory: category,
  };
}

function runLarkCli(args: string[], stdin: string | undefined, timeoutMs: number): Promise<LarkCliResult> {
  return new Promise((resolve) => {
    if (args.length === 0) {
      resolve({
        exitCode: 2,
        signal: null,
        stdout: "",
        stderr: "feishu_cli requires at least one lark-cli argument, for example [\"--help\"].",
      });
      return;
    }

    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    const maxBufferBytes = 10 * 1024 * 1024;

    const finish = (result: LarkCliResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = spawn("lark-cli", args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > maxBufferBytes) {
        stderr += "\nstdout exceeded 10MB output limit.";
        child.kill("SIGTERM");
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (Buffer.byteLength(stderr, "utf8") > maxBufferBytes) {
        stderr = stderr.slice(0, maxBufferBytes) + "\nstderr exceeded 10MB output limit.";
        child.kill("SIGTERM");
      }
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      const missingCli = error.code === "ENOENT";
      finish({
        exitCode: missingCli ? 127 : 1,
        signal: null,
        stdout,
        stderr: missingCli
          ? "lark-cli not found. Install the official larksuite/cli and authenticate it before using Feishu operations."
          : stderr,
        error: error.message,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      finish({
        exitCode: code ?? (signal ? 128 : 1),
        signal,
        stdout,
        stderr,
        timedOut,
      });
    });

    child.stdin.end(stdin ?? "");
  });
}

function parseJsonOutput(stdout: string) {
  if (!stdout.trim()) return null;
  return JSON.parse(stdout);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "feishu_cli",
    label: "Feishu Official CLI",
    description:
      "Run the official lark-cli directly. This tool does not reimplement Feishu commands, whitelist subcommands, add dry-run defaults, or maintain a custom approval store.",
    parameters: Type.Object({
      args: Type.Array(Type.String({ description: "One lark-cli argument." }), {
        description: "Arguments passed directly to lark-cli, for example [\"--help\"] or [\"docs\", \"--help\"].",
      }),
      stdin: Type.Optional(Type.String({ description: "Optional stdin passed to lark-cli." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Execution timeout in milliseconds. Defaults to 120000." })),
      parseJson: Type.Optional(Type.Boolean({ description: "Parse stdout as JSON and return it in details.json." })),
      redactionPolicy: Type.Optional(
        Type.Union([Type.Literal("none"), Type.Literal("auth-status-summary"), Type.Literal("secret-scan")], {
          description:
            "Output redaction policy. Defaults to secret-scan. auth status commands require auth-status-summary so raw account metadata is never returned to the model.",
        }),
      ),
    }),
    async execute(_toolCallId, params): Promise<AgentToolResult<FeishuCliDetails>> {
      const timeoutMs = params.timeoutMs ?? 120_000;
      const redactionPolicy = (params.redactionPolicy ?? "secret-scan") as RedactionPolicy;

      if (isAuthStatusCommand(params.args) && redactionPolicy !== "auth-status-summary") {
        const blocked = {
          provider: "feishu",
          mode: "official-lark-cli-passthrough",
          commandCategory: "auth_status",
          blocked: true,
          reason:
            "Raw lark-cli auth status output may contain account metadata. Re-run with redactionPolicy=\"auth-status-summary\".",
          rawOutputReturned: false,
          identityRedacted: true,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }],
          details: blocked,
        };
      }

      const result = await runLarkCli(params.args, params.stdin, timeoutMs);

      if (isAuthStatusCommand(params.args)) {
        const summary = summarizeAuthStatus(result);
        return {
          content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
          details: summary,
        };
      }

      if (redactionPolicy === "secret-scan" && containsSecretLikeText(`${result.stdout}\n${result.stderr}`)) {
        const blocked = {
          provider: "feishu",
          mode: "official-lark-cli-passthrough",
          command: ["lark-cli", ...params.args],
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut === true,
          blocked: true,
          reason: "secret-like output detected; raw stdout/stderr withheld",
          rawOutputReturned: false,
          identityRedacted: true,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }],
          details: blocked,
        };
      }

      let json: unknown = null;
      let jsonParseError: string | null = null;

      if (params.parseJson === true && result.stdout.trim()) {
        try {
          json = parseJsonOutput(result.stdout);
        } catch (error) {
          jsonParseError = error instanceof Error ? error.message : String(error);
        }
      }

      const details = {
        provider: "feishu",
        mode: "official-lark-cli-passthrough",
        command: ["lark-cli", ...params.args],
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut === true,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error ?? null,
        json,
        jsonParseError,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
}
