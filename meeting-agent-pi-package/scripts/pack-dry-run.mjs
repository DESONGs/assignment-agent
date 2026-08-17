import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const cacheDir = mkdtempSync(join(tmpdir(), "assignment-agent-pack-cache-"));
const npmCli = process.env.npm_execpath;
const command = npmCli ? process.execPath : "npm";
const args = npmCli ? [npmCli, "pack", "--dry-run", "--json"] : ["pack", "--dry-run", "--json"];
const result = spawnSync(command, args, {
  cwd: process.cwd(),
  stdio: "inherit",
  env: { ...process.env, npm_config_cache: cacheDir },
});

process.exitCode = result.status ?? 1;
