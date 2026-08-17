import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));

assert.equal(manifest.type, "module", "package must remain ESM");
assert.notEqual(manifest.private, true, "private=true blocks npm publication");
assert.equal(manifest.main, "./dist/index.js");
assert.equal(manifest.types, "./dist/index.d.ts");
assert.equal(manifest.exports?.["."]?.import, manifest.main);
assert.equal(manifest.exports?.["."]?.types, manifest.types);
assert(Array.isArray(manifest.files) && manifest.files.includes("dist/"), "files must include dist/");
assert(!manifest.files.includes("tests/"), "tests must not be published");

for (const relativePath of [
  "dist/index.js",
  "dist/index.js.map",
  "dist/index.d.ts",
  "dist/index.d.ts.map",
  "dist/contracts/task-contracts.js",
  "dist/contracts/task-contracts.js.map",
  "dist/contracts/task-contracts.d.ts",
  "dist/contracts/task-contracts.d.ts.map",
  "dist/contracts/runtime-boundary-contracts.js",
  "dist/contracts/runtime-boundary-contracts.js.map",
  "dist/contracts/runtime-boundary-contracts.d.ts",
  "dist/contracts/runtime-boundary-contracts.d.ts.map",
  "runtime/contract-manifest.json",
]) {
  assert(existsSync(join(packageDir, relativePath)), `missing build artifact: ${relativePath}`);
}

for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
  assert(!String(range).includes("*"), `peer dependency ${name} must use a controlled range`);
}

for (const requiredPeer of [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "@quintinshaw/pi-dynamic-workflows",
  "pi-subagents",
  "typebox",
]) {
  assert(manifest.peerDependencies?.[requiredPeer], `missing Pi runtime peer: ${requiredPeer}`);
}

for (const dependency of manifest.bundledDependencies ?? []) {
  assert(manifest.dependencies?.[dependency], `bundled dependency ${dependency} must be a production dependency`);
  assert(!manifest.peerDependencies?.[dependency], `peer dependency ${dependency} must not be bundled`);
}

for (const script of ["build", "typecheck", "test", "publint", "pack:dry-run", "pack:smoke", "prepack", "release:local"]) {
  assert(manifest.scripts?.[script], `missing release script: ${script}`);
}

const declaration = readFileSync(join(packageDir, "dist", "contracts", "task-contracts.d.ts"), "utf8");
assert.match(declaration, /TaskExecutionProfile/);
assert.match(declaration, /AdaptiveExecutionLedger/);
const boundaryDeclaration = readFileSync(join(packageDir, "dist", "contracts", "runtime-boundary-contracts.d.ts"), "utf8");
assert.match(boundaryDeclaration, /ModelGenerationResult/);
assert.match(boundaryDeclaration, /CloudAsrSummary/);
assert.match(boundaryDeclaration, /FeishuRunState/);

console.log(JSON.stringify({
  status: "passed",
  package: `${manifest.name}@${manifest.version}`,
  peerDependencyCount: Object.keys(manifest.peerDependencies ?? {}).length,
  bundledDependencyCount: (manifest.bundledDependencies ?? []).length,
}));
