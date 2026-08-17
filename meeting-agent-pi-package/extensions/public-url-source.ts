import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(extensionDir);
const cli = join(packageDir, "tools", "public_url_source_cli.mjs");

function redactDiagnostic(value: string): string {
  let text = String(value ?? "");
  for (const [key, secret] of Object.entries(process.env)) {
    if (secret && /(?:key|token|secret|password|cookie|authorization|session)/i.test(key)) text = text.replaceAll(secret, "[redacted]");
  }
  return text.replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
    try {
      const url = new URL(raw);
      url.username = "";
      url.password = "";
      for (const key of [...url.searchParams.keys()]) {
        if (/(?:access.?key|api.?key|auth|credential|expires?|policy|signature|sig|security.?token|session|token|x-amz-|x-oss-)/i.test(key)) url.searchParams.set(key, "[redacted]");
      }
      return url.toString();
    } catch {
      return "[redacted-url]";
    }
  }).slice(-1600);
}

function runCli(args: string[], timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: dirname(packageDir), stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-2_000_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveRun({ exitCode: 127, stdout, stderr: error.message, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ exitCode: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

export default function publicUrlSource(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "public_url_source_ingest",
    label: "Public URL Source Ingest",
    description: "Resolve a user-provided public YouTube, podcast/RSS, Xiaoyuzhou, or direct media URL and return a local knowledge source-pack path. Never uses cookies or writes an external knowledge base.",
    parameters: Type.Object({
      url: Type.String(),
      runId: Type.Optional(Type.String()),
      resolveOnly: Type.Optional(Type.Boolean()),
      maxMediaBytes: Type.Optional(Type.Number()),
      maxDurationSec: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params): Promise<any> {
      const args = ["--url", params.url];
      if (params.runId) args.push("--run-id", params.runId);
      if (params.resolveOnly) args.push("--resolve-only");
      if (params.maxMediaBytes) args.push("--max-media-bytes", String(params.maxMediaBytes));
      if (params.maxDurationSec) args.push("--max-duration-sec", String(params.maxDurationSec));
      const run = await runCli(args, params.resolveOnly ? 180_000 : 7_200_000);
      let details: any;
      try { details = JSON.parse(run.stdout); } catch {
        details = { status: "blocked", reason: run.timedOut ? "public_url_source_timeout" : "public_url_source_cli_failed", exitCode: run.exitCode, stderrTail: redactDiagnostic(run.stderr), rawSecretsReturned: false };
      }
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });
}
