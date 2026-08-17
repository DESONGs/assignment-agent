import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const producerLock = JSON.parse(readFileSync(join(packageDir, "package-lock.json"), "utf8"));
const smokeRoot = mkdtempSync(join(tmpdir(), "assignment-agent-package-smoke-"));
const consumerDir = join(smokeRoot, "consumer");
const packDir = join(smokeRoot, "pack");
const cacheDir = process.env.PACK_SMOKE_NPM_CACHE || join(smokeRoot, "npm-cache");
const offline = process.env.PACK_SMOKE_OFFLINE === "1";
mkdirSync(consumerDir, { recursive: true });
mkdirSync(packDir, { recursive: true });

/** @typedef {{ cwd?: string, env?: NodeJS.ProcessEnv }} RunOptions */

/** @param {string} command @param {string[]} args @param {RunOptions} [options] */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? packageDir,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: cacheDir, ...options.env },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result.stdout.trim();
}

/** @param {string} output */
function parsePackJson(output) {
  const start = output.indexOf("[");
  assert(start >= 0, `npm pack did not return JSON: ${output.slice(-500)}`);
  return JSON.parse(output.slice(start));
}

const dryRun = parsePackJson(run("npm", ["pack", "--dry-run", "--json", "--silent"]))[0];
const packed = parsePackJson(run("npm", ["pack", "--json", "--silent", "--pack-destination", packDir]))[0];
const tarballPath = join(packDir, packed.filename);

const directDependencies = new Set(Object.keys(manifest.dependencies ?? {}));
/** @type {Record<string, string>} */
const overrides = {};
for (const [path, record] of Object.entries(producerLock.packages ?? {})) {
  if (!record || typeof record !== "object") continue;
  const packageRecord = /** @type {{ dev?: boolean, version?: string }} */ (record);
  if (!path.startsWith("node_modules/") || packageRecord.dev === true || !packageRecord.version) continue;
  const packageName = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  if (!directDependencies.has(packageName)) overrides[packageName] = packageRecord.version;
}
writeFileSync(join(consumerDir, "package.json"), `${JSON.stringify({
  name: "assignment-agent-package-consumer",
  private: true,
  type: "module",
  overrides,
}, null, 2)}\n`);
run("npm", [
  "install",
  ...(offline ? ["--offline"] : []),
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--package-lock=false",
  "--legacy-peer-deps",
  "--omit=peer",
  tarballPath,
], { cwd: consumerDir });

writeFileSync(join(consumerDir, "consumer.mts"), [
  `import { isTaskExecutionProfile, TASK_EXECUTION_PROFILES, type TaskExecutionProfile } from "${manifest.name}";`,
  `import { parseQaGateResult, type QaGateResult } from "${manifest.name}/contracts/qa";`,
  `import { parseSourceContextManifest, type SourceContextManifest } from "${manifest.name}/contracts/source-context";`,
  `import { parseDocumentWorkflowCheckpoint, type DocumentWorkflowCheckpoint } from "${manifest.name}/contracts/document-runtime";`,
  `import { parseOfficeObject, type OfficeObject } from "${manifest.name}/contracts/office-artifacts";`,
  `const profile: TaskExecutionProfile = "url_source_pack";`,
  `if (!isTaskExecutionProfile(profile) || !TASK_EXECUTION_PROFILES.includes(profile)) throw new Error("typed_contract_consumer_failed");`,
  `const parsers: Array<(value: unknown) => QaGateResult | SourceContextManifest | DocumentWorkflowCheckpoint | OfficeObject> = [parseQaGateResult, parseSourceContextManifest, parseDocumentWorkflowCheckpoint, parseOfficeObject];`,
  `if (parsers.length !== 4) throw new Error("typed_subpath_contract_consumer_failed");`,
  `console.log(profile);`,
  "",
].join("\n"));
writeFileSync(join(consumerDir, "consumer.mjs"), [
  `import { isTaskExecutionProfile, TASK_EXECUTION_PROFILES } from "${manifest.name}";`,
  `import { QA_GATE_SCHEMA_VERSION } from "${manifest.name}/contracts/qa";`,
  `import { SOURCE_CONTEXT_SCHEMA_VERSION } from "${manifest.name}/contracts/source-context";`,
  `import { DOCUMENT_CHECKPOINT_SCHEMA_VERSION } from "${manifest.name}/contracts/document-runtime";`,
  `if (!isTaskExecutionProfile("url_source_pack") || isTaskExecutionProfile("direct_answer")) throw new Error("runtime_contract_consumer_failed");`,
  `console.log(JSON.stringify({ status: "passed", profileCount: TASK_EXECUTION_PROFILES.length, contracts: [QA_GATE_SCHEMA_VERSION, SOURCE_CONTEXT_SCHEMA_VERSION, DOCUMENT_CHECKPOINT_SCHEMA_VERSION] }));`,
  "",
].join("\n"));
writeFileSync(join(consumerDir, "tsconfig.json"), `${JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    noEmit: true,
  },
  files: ["consumer.mts"],
}, null, 2)}\n`);

run(process.execPath, [join(packageDir, "node_modules", "typescript", "bin", "tsc"), "-p", join(consumerDir, "tsconfig.json")]);
const runtimeSmoke = run(process.execPath, [join(consumerDir, "consumer.mjs")], { cwd: consumerDir });

const forbiddenEntries = packed.files
  .map((/** @type {{ path: string }} */ entry) => entry.path)
  .filter((/** @type {string} */ path) => /(^|\/)(tests?|__pycache__|runtime-runs)(\/|$)|\.pyc$|\.env(?:\.|$)/.test(path));
assert.deepEqual(forbiddenEntries, [], `tarball contains forbidden files: ${forbiddenEntries.join(", ")}`);

const packedPaths = new Set(packed.files.map((/** @type {{ path: string }} */ entry) => entry.path));
const requiredPiRuntimeEntries = [
  "dist/index.js",
  "dist/index.d.ts",
  "extensions/planner-runtime.ts",
  "extensions/document-worker-runtime.ts",
  "prompts/meeting-minutes.md",
  "runtime/capability-registry.json",
  "runtime/contract-manifest.json",
  "skills/public-url-source/SKILL.md",
  "tools/task_execution_runner.mjs",
];
for (const relativePath of requiredPiRuntimeEntries) {
  assert(packedPaths.has(relativePath), `tarball is missing Pi runtime entry: ${relativePath}`);
  assert(existsSync(join(consumerDir, "node_modules", manifest.name, relativePath)), `installed package is missing Pi runtime entry: ${relativePath}`);
}

console.log(JSON.stringify({
  status: "passed",
  smokeRoot,
  tarballPath,
  dryRun: { entryCount: dryRun.entryCount, size: dryRun.size, unpackedSize: dryRun.unpackedSize },
  packed: { entryCount: packed.entryCount, size: packed.size, unpackedSize: packed.unpackedSize },
  consumer: {
    install: offline ? "npm_tgz_offline" : "npm_tgz",
    typecheck: "NodeNext_strict",
    runtime: JSON.parse(runtimeSmoke),
    piRuntimeEntriesChecked: requiredPiRuntimeEntries.length,
  },
  node: process.version,
  pathEntriesObserved: (process.env.PATH ?? "").split(delimiter).length,
}, null, 2));
