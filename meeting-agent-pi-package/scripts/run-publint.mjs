import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const cacheDir = mkdtempSync(join(tmpdir(), "assignment-agent-publint-cache-"));
const cli = join(packageDir, "node_modules", "publint", "src", "cli.js");
const result = spawnSync(process.execPath, [cli], {
  cwd: packageDir,
  stdio: "inherit",
  env: { ...process.env, npm_config_cache: cacheDir },
});

process.exitCode = result.status ?? 1;
