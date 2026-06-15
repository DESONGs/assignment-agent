#!/usr/bin/env node

/**
 * Thin local runner for PI extension tools.
 *
 * This CLI lets non-PI bridge code invoke the existing Planner/Router/Prompt
 * Registry/Document Worker/QA/Policy tools without reimplementing their
 * decisions in the Feishu or future WeChat adapters.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const toolDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(toolDir);
const workspaceDir = dirname(packageDir);
const runtimeDir = join(packageDir, "runtime");
const extensionsDir = join(packageDir, "extensions");
const toolLoadManifestPath = join(runtimeDir, "tool-load-manifest.json");
const LOCAL_ENV_ALLOWLIST = new Set([
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "XIAOMI_BASE_URL",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REVIEW_PROVIDER",
  "PI_REVIEW_MODEL",
  "MODEL_PROVIDER_MAX_TIMEOUT_MS",
  "MEETING_ASR_PROVIDER",
  "MEETING_ASR_FALLBACK_PROVIDER",
  "ALIYUN_DASHSCOPE_API_KEY",
  "DASHSCOPE_API_KEY",
  "ALIYUN_DASHSCOPE_WORKSPACE_ID",
  "ALIYUN_ASR_MODEL",
  "ALIYUN_ASR_ENDPOINT",
  "ALIYUN_ASR_LANGUAGE_HINTS",
  "ALIYUN_ASR_VOCABULARY_ID",
  "ALIYUN_ASR_SAMPLE_RATE",
  "ALIYUN_ASR_TIMEOUT_MS",
  "ALIYUN_ASR_AUDIO_FRAME_BYTES",
  "ALIYUN_ASR_AUDIO_FRAME_DELAY_MS",
]);

function ensureTypeScriptImportSupport() {
  const hasStripTypes = process.execArgv.includes("--experimental-strip-types") ||
    String(process.env.NODE_OPTIONS ?? "").includes("--experimental-strip-types");
  if (hasStripTypes || process.env.FEISHU_AGENT_RUNTIME_TOOL_REEXEC_STRIP_TYPES === "1") return;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", ...process.argv.slice(1)], {
    cwd: process.cwd(),
    env: { ...process.env, FEISHU_AGENT_RUNTIME_TOOL_REEXEC_STRIP_TYPES: "1" },
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const equalsIndex = item.indexOf("=");
    if (equalsIndex > 2) {
      args[item.slice(2, equalsIndex)] = item.slice(equalsIndex + 1);
      continue;
    }
    const key = item.slice(2);
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

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeEnvFilePath(value) {
  const target = resolve(value || join(workspaceDir, ".env.local"));
  if (!isInside(workspaceDir, target)) {
    throw new Error("runtime_env_file_outside_workspace_blocked");
  }
  return target;
}

function parseDotenv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2] ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values[match[1]] = value;
  }
  return values;
}

function loadRuntimeEnv(args) {
  if (/^(0|false|no|off)$/i.test(String(process.env.FEISHU_AGENT_LOAD_LOCAL_ENV ?? "1"))) {
    return { status: "disabled", loadedKeys: [], skippedKeys: [] };
  }
  const envFile = safeEnvFilePath(args["env-file"] ?? process.env.FEISHU_AGENT_RUNTIME_ENV_FILE ?? join(workspaceDir, ".env.local"));
  if (!existsSync(envFile)) {
    return { status: "missing", loadedKeys: [], skippedKeys: [] };
  }
  const parsed = parseDotenv(readFileSync(envFile, "utf8"));
  const loadedKeys = [];
  const skippedKeys = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (!LOCAL_ENV_ALLOWLIST.has(key)) {
      skippedKeys.push(key);
      continue;
    }
    if (process.env[key] !== undefined) {
      skippedKeys.push(key);
      continue;
    }
    process.env[key] = value;
    loadedKeys.push(key);
  }
  process.env.FEISHU_AGENT_RUNTIME_ENV_LOADED_KEYS = loadedKeys.join(",");
  return { status: "loaded", loadedKeys, skippedKeys };
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new Error(`tool load manifest ${label} must be an array of extension file names`);
  }
  return value.map((item) => item.trim());
}

function readToolLoadManifest() {
  if (!existsSync(toolLoadManifestPath)) {
    throw new Error(`tool load manifest not found: ${toolLoadManifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(toolLoadManifestPath, "utf8"));
  if (!manifest || typeof manifest !== "object") {
    throw new Error("tool load manifest must be an object");
  }
  if (!Number.isInteger(manifest.version) || manifest.version < 1) {
    throw new Error("tool load manifest version must be a positive integer");
  }
  const profileTools = manifest.profileTools;
  if (!profileTools || typeof profileTools !== "object" || Array.isArray(profileTools)) {
    throw new Error("tool load manifest profileTools must be an object");
  }
  const normalizedProfileTools = Object.create(null);
  for (const [profile, files] of Object.entries(profileTools)) {
    normalizedProfileTools[profile] = assertStringArray(files, `profileTools.${profile}`);
  }
  return {
    version: manifest.version,
    defaultTools: assertStringArray(manifest.defaultTools, "defaultTools"),
    profileTools: normalizedProfileTools,
  };
}

function unique(values) {
  return [...new Set(values)];
}

function allManifestExtensionFiles(manifest) {
  return unique([
    ...manifest.defaultTools,
    ...Object.values(manifest.profileTools).flat(),
  ]);
}

function safeExtensionPath(file) {
  if (isAbsolute(file)) {
    throw new Error(`extension file must be relative to extensions dir: ${file}`);
  }
  if (![".js", ".mjs", ".ts"].includes(extname(file))) {
    throw new Error(`extension file has unsupported extension: ${file}`);
  }
  const abs = resolve(extensionsDir, file);
  const rel = relative(extensionsDir, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`extension file escapes extensions dir: ${file}`);
  }
  if (!existsSync(abs)) {
    throw new Error(`extension file not found: ${file}`);
  }
  const realExtensionsDir = realpathSync(extensionsDir);
  const realAbs = realpathSync(abs);
  const realRel = relative(realExtensionsDir, realAbs);
  if (realRel === "" || realRel.startsWith("..") || isAbsolute(realRel)) {
    throw new Error(`extension file resolves outside extensions dir: ${file}`);
  }
  return realAbs;
}

function extensionFilesForProfile(manifest, profile) {
  if (!profile) return manifest.defaultTools;
  const files = manifest.profileTools[profile];
  if (!files) {
    const available = Object.keys(manifest.profileTools).sort().join(", ");
    throw new Error(`unknown runtime tool profile: ${profile}; available profiles: ${available}`);
  }
  return files;
}

async function loadTools({ profile = "", requestedTool = "" } = {}) {
  const manifest = readToolLoadManifest();
  const tools = Object.create(null);
  const pi = {
    registerTool(definition) {
      tools[definition.name] = definition;
    },
  };

  const loaded = new Set();
  async function loadExtensionFile(file) {
    const abs = safeExtensionPath(file);
    if (loaded.has(abs)) return;
    const mod = await import(pathToFileURL(abs).href);
    if (typeof mod.default !== "function") {
      throw new Error(`extension file does not export a default registration function: ${file}`);
    }
    await mod.default(pi);
    loaded.add(abs);
  }

  for (const file of unique(extensionFilesForProfile(manifest, profile))) {
    await loadExtensionFile(file);
  }
  if (requestedTool && !tools[requestedTool]) {
    for (const file of allManifestExtensionFiles(manifest)) {
      await loadExtensionFile(file);
      if (tools[requestedTool]) break;
    }
  }

  return tools;
}

async function main() {
  ensureTypeScriptImportSupport();
  const args = parseArgs(process.argv.slice(2));
  loadRuntimeEnv(args);
  const tool = String(args.tool ?? "");
  const profile = args.profile === undefined ? "" : String(args.profile).trim();
  const paramsFile = args["params-file"] ? resolve(String(args["params-file"])) : "";
  const out = args.out ? resolve(String(args.out)) : "";
  if (!tool || !paramsFile || !existsSync(paramsFile)) {
    throw new Error("runtime_tool_cli requires --tool and --params-file");
  }
  if (profile === "true") {
    throw new Error("runtime_tool_cli --profile requires a profile name");
  }
  const params = JSON.parse(readFileSync(paramsFile, "utf8"));
  const tools = await loadTools({ profile, requestedTool: tool });
  if (!tools[tool]) {
    throw new Error(`runtime tool not found: ${tool}`);
  }
  const result = await tools[tool].execute("runtime-tool-cli", params);
  const payload = result?.details ?? result;
  if (out) writeJson(out, payload);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
