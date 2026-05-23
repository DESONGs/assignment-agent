#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  PROJECT_WIKI_ROOT_TITLE,
  buildPublishTaxonomy,
  docCategory,
  extractLegacySessionKeyFromPublishTarget,
} from "./feishu_publish_taxonomy.mjs";

const toolDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(toolDir);
const workspaceDir = dirname(packageDir);
const DEFAULT_ROOT = join(workspaceDir, "runtime-runs", "feishu-agent");
const INVENTORY_FILE = "publish-organization-inventory.json";
const PLAN_FILE = "publish-organization-plan.json";
const REPORT_FILE = "publish-organization-report.json";
const LEDGER_FILE = "publish-organization-ledger.jsonl";
const PROJECT_OVERRIDES_FILE = "publish-project-overrides.json";
const WIKI_REGISTRY_FILE = "feishu-wiki-target-registry.json";
const DRIVE_REGISTRY_FILE = "feishu-publish-targets.json";

function nowIso() {
  return new Date().toISOString();
}

function hashText(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    if (["live", "no-delete", "dry-run"].includes(key)) {
      args[key] = true;
      continue;
    }
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

function loadJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

function appendLedger(root, entry) {
  appendFileSync(join(root, LEDGER_FILE), `${JSON.stringify({ at: nowIso(), ...entry, rawSecretsReturned: false })}\n`, "utf8");
}

function publicTokenState(value) {
  return value ? { present: true, hash: hashText(value).slice(0, 12) } : { present: false, hash: null };
}

function findPublishJsonFiles(dir, output = []) {
  if (!existsSync(dir)) return output;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      findPublishJsonFiles(path, output);
    } else if (entry.isFile() && entry.name === "publish.json") {
      output.push(path);
    }
  }
  return output;
}

function normalizeRoot(input) {
  const root = resolve(input ?? DEFAULT_ROOT);
  mkdirSync(root, { recursive: true });
  return root;
}

function loadDriveRegistry(root) {
  const registry = loadJsonIfExists(join(root, DRIVE_REGISTRY_FILE)) ?? {};
  return {
    entries: registry.entries ?? {},
    projectEntries: registry.projectEntries ?? {},
    legacySessionMappings: registry.legacySessionMappings ?? {},
  };
}

function loadWikiRegistry(root) {
  const registry = loadJsonIfExists(join(root, WIKI_REGISTRY_FILE)) ?? {};
  return {
    schemaVersion: "feishu-wiki-target-registry-v1",
    updatedAt: registry.updatedAt ?? null,
    spaces: registry.spaces ?? {},
    rootNodes: registry.rootNodes ?? {},
    projectNodes: registry.projectNodes ?? {},
    runNodes: registry.runNodes ?? {},
    categoryNodes: registry.categoryNodes ?? {},
    documentNodes: registry.documentNodes ?? {},
    rawSecretsReturned: false,
  };
}

function loadProjectOverrides(root) {
  const parsed = loadJsonIfExists(join(root, PROJECT_OVERRIDES_FILE)) ?? {};
  return {
    schemaVersion: "feishu-publish-project-overrides-v1",
    runIds: parsed.runIds ?? {},
    legacySessionKeys: parsed.legacySessionKeys ?? {},
    rawSecretsReturned: false,
  };
}

function overrideForRun(run, overrides) {
  const runOverride = overrides.runIds?.[run.runId] ?? null;
  if (runOverride) return { ...runOverride, overrideType: "run_id" };
  const sessionOverride = run.legacySessionKey ? overrides.legacySessionKeys?.[run.legacySessionKey] ?? null : null;
  if (sessionOverride) return { ...sessionOverride, overrideType: "legacy_session_key" };
  return null;
}

function saveWikiRegistry(root, registry) {
  writeJson(join(root, WIKI_REGISTRY_FILE), {
    ...registry,
    updatedAt: nowIso(),
    rawSecretsReturned: false,
  });
}

function saveDriveRegistry(root, registry) {
  writeJson(join(root, DRIVE_REGISTRY_FILE), {
    schemaVersion: "feishu-publish-target-registry-v2",
    updatedAt: nowIso(),
    entries: registry.entries ?? {},
    projectEntries: registry.projectEntries ?? {},
    legacySessionMappings: registry.legacySessionMappings ?? {},
    rawSecretsReturned: false,
  });
}

function existingDocumentNode(registry, { runId, docType, spaceId }) {
  return Object.values(registry.documentNodes ?? {}).find((entry) =>
    entry?.sourceRun === runId
    && entry?.docType === docType
    && (!spaceId || entry?.spaceId === spaceId)
    && (entry?.nodeToken || entry?.fileToken)
  ) ?? null;
}

function localPath(root, path) {
  return path ? relative(workspaceDir, resolve(path)) : null;
}

function documentsForRun(publish, agentOutput) {
  const docs = Array.isArray(publish?.documents) && publish.documents.length > 0
    ? publish.documents
    : Array.isArray(agentOutput?.documents) ? agentOutput.documents : [];
  return docs.map((doc) => ({
    docType: doc.docType ?? "document",
    title: doc.title ?? doc.fileName ?? doc.docType ?? "document",
    fileName: doc.fileName ?? null,
    localPath: doc.localPath ?? null,
    fileToken: doc.fileToken ?? doc.objToken ?? null,
    url: doc.url ?? null,
    status: doc.status ?? null,
  }));
}

function projectDisplayTitle(project) {
  return String(project?.projectTitle ?? "待确认项目").replace(/^项目｜/, "").trim() || "待确认项目";
}

function runDisplayStamp(run) {
  const fromRunId = String(run?.runId ?? "").match(/feishu_(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (fromRunId) return `${fromRunId[1]} ${fromRunId[2]}${fromRunId[3]}${fromRunId[4]}`;
  const date = run?.taxonomy?.sourceLineage?.date ?? null;
  return date || hashText(run?.runId ?? nowIso()).slice(0, 8);
}

function docDisplayKind(docType) {
  if (docType === "prd") return "PRD";
  if (docType === "tech-architecture") return "技术架构";
  if (docType === "customer-requirement-checklist") return "客户需求确认表";
  if (docType === "todo-list") return "To-do";
  if (docType === "meeting-minutes") return "会议纪要";
  return docCategory(docType);
}

function docDisplayPurpose(docType) {
  if (docType === "prd") return "产品化方案";
  if (docType === "tech-architecture") return "技术实现方案";
  if (docType === "customer-requirement-checklist") return "需求澄清";
  if (docType === "todo-list") return "行动项";
  if (docType === "meeting-minutes") return "会议讨论";
  return "文档";
}

function wikiDocumentDisplayTitle(project, run, doc) {
  const base = [
    docDisplayKind(doc.docType),
    projectDisplayTitle(project),
    docDisplayPurpose(doc.docType),
    runDisplayStamp(run),
  ].filter(Boolean).join("｜");
  return base.endsWith(".md") ? base : `${base}.md`;
}

function folderKeyFromPublish(publish) {
  const fromTarget = extractLegacySessionKeyFromPublishTarget(publish?.publishTarget);
  if (fromTarget) return fromTarget;
  const folderName = String(publish?.publishTarget?.folderName ?? "");
  const match = folderName.match(/feishu-chat-([A-Za-z0-9_-]{8,})/i);
  return match?.[1] ?? "";
}

function collectInventory(root) {
  const driveRegistry = loadDriveRegistry(root);
  const publishFiles = findPublishJsonFiles(join(root, "runs")).sort();
  const runs = [];
  for (const publishPath of publishFiles) {
    const runDir = dirname(publishPath);
    const artifactsDir = join(runDir, "artifacts");
    const publish = loadJsonIfExists(publishPath) ?? {};
    const task = loadJsonIfExists(join(runDir, "task.json")) ?? { runId: publish.runId ?? runDir.split("/").pop(), sourceEvent: { message: {} } };
    const agentOutput = loadJsonIfExists(join(runDir, "agent-output.json")) ?? {};
    const documents = documentsForRun(publish, agentOutput);
    if (documents.length === 0) continue;
    const legacySessionKey = folderKeyFromPublish(publish);
    const taxonomy = buildPublishTaxonomy({
      task,
      documents,
      paths: { runDir, artifactsDir },
      options: {},
      workspaceDir,
      legacySessionKey,
      writeFile: false,
    });
    const legacyTarget = legacySessionKey ? driveRegistry.entries?.[legacySessionKey] ?? null : null;
    runs.push({
      runId: task.runId ?? publish.runId ?? runDir.split("/").pop(),
      runDir,
      publishPath,
      status: publish.status ?? null,
      reason: publish.reason ?? null,
      legacySessionKey,
      legacyFolderName: legacyTarget?.folderName ?? publish?.publishTarget?.folderName ?? null,
      legacyFolderToken: legacyTarget?.folderToken ?? null,
      taxonomy,
      documents,
      publishTarget: publish.publishTarget ?? null,
    });
  }
  return { root, generatedAt: nowIso(), runs };
}

function publicInventory(inventory) {
  return {
    schemaVersion: "feishu-publish-organization-inventory-v1",
    generatedAt: inventory.generatedAt,
    root: localPath(inventory.root, inventory.root),
    runCount: inventory.runs.length,
    runs: inventory.runs.map((run) => ({
      runId: run.runId,
      runDir: localPath(inventory.root, run.runDir),
      status: run.status,
      reason: run.reason,
      projectTitle: run.taxonomy.projectTitle,
      projectKey: run.taxonomy.projectKey,
      projectConfidence: run.taxonomy.projectConfidence,
      projectBasis: run.taxonomy.projectBasis,
      legacyFolderName: run.legacyFolderName,
      legacyFolderToken: publicTokenState(run.legacyFolderToken),
      documents: run.documents.map((doc) => ({
        docType: doc.docType,
        title: doc.title,
        fileName: doc.fileName,
        status: doc.status,
        urlPresent: Boolean(doc.url),
        fileToken: publicTokenState(doc.fileToken),
      })),
    })),
    rawSecretsReturned: false,
  };
}

function buildOrganizationPlan(inventory, overrides = loadProjectOverrides(inventory.root)) {
  const projects = new Map();
  const manualReviewRuns = [];
  const overridesApplied = [];
  for (const run of inventory.runs) {
    const override = overrideForRun(run, overrides);
    const hasCloudArtifact = Boolean(run.legacyFolderToken) || run.documents.some((doc) => doc.fileToken || doc.url);
    if (!hasCloudArtifact) {
      manualReviewRuns.push({
        runId: run.runId,
        reason: "no_published_cloud_artifact",
        legacyFolderName: run.legacyFolderName,
        documentCount: run.documents.length,
        rejectedProjectCandidates: run.taxonomy.rejectedProjectCandidates ?? [],
      });
      continue;
    }
    if (!override && (run.taxonomy.projectConfidence === "low" || run.taxonomy.projectTitle === "待确认项目")) {
      manualReviewRuns.push({
        runId: run.runId,
        reason: "project_identity_low_confidence",
        legacyFolderName: run.legacyFolderName,
        documentCount: run.documents.length,
        rejectedProjectCandidates: run.taxonomy.rejectedProjectCandidates ?? [],
      });
      continue;
    }
    const key = override?.projectKey ?? run.taxonomy.projectKey;
    const projectTitle = override?.projectTitle ?? run.taxonomy.projectTitle;
    const projectConfidence = override ? "override" : run.taxonomy.projectConfidence;
    if (override) {
      overridesApplied.push({
        runId: run.runId,
        legacySessionKey: run.legacySessionKey || null,
        projectKey: key,
        projectTitle,
        overrideType: override.overrideType,
        reason: override.reason ?? "manual_project_assignment",
      });
    }
    if (!projects.has(key)) {
      projects.set(key, {
        projectKey: key,
        projectTitle,
        projectConfidence,
        wikiRootTitle: PROJECT_WIKI_ROOT_TITLE,
        driveFolderName: `项目｜${projectTitle}`,
        categoryTitles: new Map(),
        runs: [],
      });
    }
    const project = projects.get(key);
    for (const doc of run.documents) project.categoryTitles.set(doc.docType, docCategory(doc.docType));
    project.runs.push(run);
  }
  return {
    schemaVersion: "feishu-publish-organization-plan-v1",
    generatedAt: nowIso(),
    root: localPath(inventory.root, inventory.root),
    migrationPolicy: "no_delete_move_or_index_only",
    projectCount: projects.size,
    runCount: inventory.runs.length,
    overridesApplied,
    manualReviewRunCount: manualReviewRuns.length,
    manualReviewRuns,
    projects: [...projects.values()].map((project) => ({
      projectKey: project.projectKey,
      projectTitle: project.projectTitle,
      projectConfidence: project.projectConfidence,
      wikiPath: [PROJECT_WIKI_ROOT_TITLE, `项目｜${project.projectTitle}`],
      driveFolderName: project.driveFolderName,
      categories: [...project.categoryTitles.entries()].map(([docType, title]) => ({ docType, title })),
      legacyFolderCount: project.runs.filter((run) => run.legacyFolderToken).length,
      documentCount: project.runs.reduce((sum, run) => sum + run.documents.length, 0),
      runs: project.runs.map((run) => ({
        runId: run.runId,
        legacyFolderName: run.legacyFolderName,
        legacyFolderToken: publicTokenState(run.legacyFolderToken),
        documents: run.documents.map((doc) => ({
          docType: doc.docType,
          title: doc.title,
          wikiTitle: wikiDocumentDisplayTitle(project, run, doc),
          fileToken: publicTokenState(doc.fileToken),
          urlPresent: Boolean(doc.url),
        })),
      })),
    })),
    plannedOperations: {
      wiki: ["ensure_root_node", "ensure_project_node", "ensure_category_nodes", "move_existing_docs_to_wiki_when_file_token_present"],
      drive: ["ensure_project_folder", "move_legacy_feishu_chat_folders_under_project_folder", "rename_legacy_folder_to_date_topic_short_key"],
      deletion: "disabled",
    },
    rawSecretsReturned: false,
  };
}

function runCommand(bin, args, timeoutMs = 120000) {
  return new Promise((resolveResult) => {
    const child = spawn(bin, args, { cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolveResult({ exitCode, stdout, stderr });
    });
  });
}

function stderrTail(result) {
  return String(result?.stderr ?? "").slice(-1600);
}

function publicCommand(args, secretValues = []) {
  const secrets = new Set(secretValues.filter(Boolean));
  return args.map((arg) => (secrets.has(arg) ? "<token>" : arg));
}

function parseJsonOutput(text) {
  try {
    return text?.trim() ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function findToken(value, keys) {
  if (!value || typeof value !== "object") return null;
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findToken(item, keys);
        if (found) return found;
      }
    } else if (child && typeof child === "object") {
      const found = findToken(child, keys);
      if (found) return found;
    }
  }
  return null;
}

async function ensureWikiNode({ root, registry, level, reuseKey, title, parentToken, live, publishAs, spaceId, timeoutMs, report }) {
  const cacheMap = level === "root" ? registry.rootNodes : level === "project" ? registry.projectNodes : registry.categoryNodes;
  const existingEntry = cacheMap[reuseKey] ?? null;
  const existing = existingEntry?.nodeToken && (!spaceId || existingEntry.spaceId === spaceId) ? existingEntry.nodeToken : null;
  if (existing) return existing;
  const args = ["wiki", "+node-create", "--as", publishAs, "--title", title, "--obj-type", "docx"];
  if (parentToken) args.push("--parent-node-token", parentToken);
  else args.push("--space-id", spaceId ?? "my_library");
  report.plannedCommands.push(["lark-cli", ...publicCommand(args, [parentToken])]);
  if (!live) return `<${reuseKey}>`;
  const result = await runCommand("lark-cli", args, timeoutMs);
  const nodeToken = findToken(parseJsonOutput(result.stdout), ["node_token", "token", "wiki_token"]);
  const status = result.exitCode === 0 && nodeToken ? "created" : "failed";
  report.operations.push({ kind: "wiki_node_create", level, title, status, exitCode: result.exitCode, stderrTail: stderrTail(result), token: publicTokenState(nodeToken) });
  appendLedger(root, { kind: "wiki_node_create", level, title, status, exitCode: result.exitCode, stderrTail: stderrTail(result), token: publicTokenState(nodeToken) });
  if (status !== "created") return null;
  cacheMap[reuseKey] = { title, nodeToken, spaceId: spaceId ?? null, createdAt: nowIso(), updatedAt: nowIso() };
  saveWikiRegistry(root, registry);
  return nodeToken;
}

function listedSpaces(value) {
  const data = value?.data ?? value;
  if (Array.isArray(data?.spaces)) return data.spaces;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(value?.spaces)) return value.spaces;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

async function ensureKnowledgeBaseSpace({ root, registry, live, publishAs, timeoutMs, report, spaceName = PROJECT_WIKI_ROOT_TITLE }) {
  const cached = registry.spaces?.[spaceName]?.spaceId ?? null;
  if (cached) {
    return cached;
  }
  const listArgs = ["wiki", "+space-list", "--as", publishAs, "--format", "json"];
  report.plannedCommands.push(["lark-cli", ...listArgs]);
  if (live) {
    const listed = await runCommand("lark-cli", listArgs, timeoutMs);
    const found = listed.exitCode === 0
      ? listedSpaces(parseJsonOutput(listed.stdout)).find((space) => String(space?.name ?? "") === spaceName)
      : null;
    if (found?.space_id) {
      registry.spaces ??= {};
      registry.spaces[spaceName] = { name: spaceName, spaceId: found.space_id, status: "reused", updatedAt: nowIso() };
      saveWikiRegistry(root, registry);
      report.operations.push({ kind: "wiki_space_resolve", title: spaceName, status: "reused", exitCode: listed.exitCode, token: publicTokenState(found.space_id) });
      appendLedger(root, { kind: "wiki_space_resolve", title: spaceName, status: "reused", exitCode: listed.exitCode, token: publicTokenState(found.space_id) });
      return found.space_id;
    }
    const createArgs = [
      "wiki",
      "spaces",
      "create",
      "--as",
      publishAs,
      "--data",
      JSON.stringify({
        name: spaceName,
        description: "PI Agent 自动整理的项目会议纪要、PRD、架构和行动项知识库。",
        open_sharing: "closed",
      }),
      "--yes",
      "--format",
      "json",
    ];
    report.plannedCommands.push(["lark-cli", ...createArgs]);
    const created = await runCommand("lark-cli", createArgs, timeoutMs);
    const spaceId = findToken(parseJsonOutput(created.stdout), ["space_id"]);
    const status = created.exitCode === 0 && spaceId ? "created" : "failed";
    report.operations.push({ kind: "wiki_space_create", title: spaceName, status, exitCode: created.exitCode, stderrTail: stderrTail(created), token: publicTokenState(spaceId) });
    appendLedger(root, { kind: "wiki_space_create", title: spaceName, status, exitCode: created.exitCode, stderrTail: stderrTail(created), token: publicTokenState(spaceId) });
    if (status !== "created") return null;
    registry.spaces ??= {};
    registry.spaces[spaceName] = { name: spaceName, spaceId, status: "created", createdAt: nowIso(), updatedAt: nowIso() };
    saveWikiRegistry(root, registry);
    return spaceId;
  }
  report.plannedCommands.push([
    "lark-cli",
    "wiki",
    "spaces",
    "create",
    "--as",
    publishAs,
    "--data",
    JSON.stringify({ name: spaceName, description: "PI Agent 自动整理的项目会议纪要、PRD、架构和行动项知识库。", open_sharing: "closed" }),
    "--yes",
    "--format",
    "json",
  ]);
  return `<space:${spaceName}>`;
}

async function ensureDriveProjectFolder({ root, registry, project, live, publishAs, timeoutMs, report }) {
  const existing = registry.projectEntries?.[project.projectKey]?.folderToken ?? null;
  if (existing) return existing;
  const args = ["drive", "+create-folder", "--as", publishAs, "--name", project.driveFolderName];
  report.plannedCommands.push(["lark-cli", ...args]);
  if (!live) return `<drive:${project.projectKey}>`;
  const result = await runCommand("lark-cli", args, timeoutMs);
  const folderToken = findToken(parseJsonOutput(result.stdout), ["folder_token", "token", "file_token"]);
  const status = result.exitCode === 0 && folderToken ? "created" : "failed";
  report.operations.push({ kind: "drive_project_folder_create", projectTitle: project.projectTitle, status, exitCode: result.exitCode, stderrTail: stderrTail(result), token: publicTokenState(folderToken) });
  appendLedger(root, { kind: "drive_project_folder_create", projectTitle: project.projectTitle, status, exitCode: result.exitCode, stderrTail: stderrTail(result), token: publicTokenState(folderToken) });
  if (status !== "created") return null;
  registry.projectEntries ??= {};
  registry.projectEntries[project.projectKey] = {
    folderToken,
    folderName: project.driveFolderName,
    projectTitle: project.projectTitle,
    projectKey: project.projectKey,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  saveDriveRegistry(root, registry);
  return folderToken;
}

async function applyOrganization({ root, inventory, plan, live, noDelete, publishAs, spaceId, timeoutMs }) {
  if (!noDelete) throw new Error("publish_organize_apply_requires_no_delete");
  const wikiRegistry = loadWikiRegistry(root);
  const driveRegistry = loadDriveRegistry(root);
  const runsById = new Map(inventory.runs.map((run) => [run.runId, run]));
  const report = {
    schemaVersion: "feishu-publish-organization-report-v1",
    generatedAt: nowIso(),
    mode: live ? "live" : "dry_run",
    noDelete,
    projectCount: plan.projects.length,
    plannedCommands: [],
    operations: [],
    summary: {
      wikiNodesCreatedOrReused: 0,
      documentsMovedToWiki: 0,
      documentsRecreatedInWiki: 0,
      driveFoldersMoved: 0,
      driveFoldersRenamed: 0,
      legacyUrlsPreserved: 0,
      failures: 0,
    },
    rawSecretsReturned: false,
  };

  const wikiSpaceId = await ensureKnowledgeBaseSpace({
    root,
    registry: wikiRegistry,
    live,
    publishAs,
    timeoutMs,
    report,
  });
  report.wikiSpace = {
    title: PROJECT_WIKI_ROOT_TITLE,
    status: wikiSpaceId ? "ready" : "failed",
    token: publicTokenState(wikiSpaceId && !String(wikiSpaceId).startsWith("<space:") ? wikiSpaceId : null),
  };
  if (!wikiSpaceId) {
    report.summary.failures += 1;
    writeJson(join(root, REPORT_FILE), report);
    return report;
  }

  for (const project of plan.projects) {
    const projectToken = await ensureWikiNode({
      root,
      registry: wikiRegistry,
      level: "project",
      reuseKey: project.projectKey,
      title: `项目｜${project.projectTitle}`,
      parentToken: null,
      live,
      publishAs,
      spaceId: wikiSpaceId,
      timeoutMs,
      report,
    });
    if (projectToken) report.summary.wikiNodesCreatedOrReused += 1;

    const categoryTokens = new Map();
    for (const category of project.categories) {
      const reuseKey = `category:${project.projectKey}:${hashText(category.docType).slice(0, 8)}`;
      const token = await ensureWikiNode({
        root,
        registry: wikiRegistry,
        level: "category",
        reuseKey,
        title: category.title,
        parentToken: projectToken,
        live,
        publishAs,
        spaceId: wikiSpaceId,
        timeoutMs,
        report,
      });
      categoryTokens.set(category.docType, token);
    }

    const driveProjectFolderToken = await ensureDriveProjectFolder({ root, registry: driveRegistry, project, live, publishAs, timeoutMs, report });
    for (const plannedRun of project.runs) {
      const run = runsById.get(plannedRun.runId);
      if (!run) continue;
      if (live && driveProjectFolderToken && run.legacySessionKey) {
        driveRegistry.projectEntries ??= {};
        driveRegistry.legacySessionMappings ??= {};
        const existingProjectEntry = driveRegistry.projectEntries[project.projectKey] ?? {};
        driveRegistry.projectEntries[project.projectKey] = {
          ...existingProjectEntry,
          folderToken: driveProjectFolderToken,
          folderName: project.driveFolderName,
          projectTitle: project.projectTitle,
          projectKey: project.projectKey,
          legacySessionKeys: Array.from(new Set([...(existingProjectEntry.legacySessionKeys ?? []), run.legacySessionKey])),
          updatedAt: nowIso(),
        };
        driveRegistry.legacySessionMappings[run.legacySessionKey] = {
          projectKey: project.projectKey,
          folderName: project.driveFolderName,
          mappedAt: nowIso(),
        };
        saveDriveRegistry(root, driveRegistry);
      }
      if (driveProjectFolderToken && run.legacyFolderToken) {
        const moveArgs = ["drive", "+move", "--as", publishAs, "--file-token", run.legacyFolderToken, "--type", "folder", "--folder-token", driveProjectFolderToken];
        report.plannedCommands.push(["lark-cli", ...moveArgs.map((arg) => (arg === run.legacyFolderToken || arg === driveProjectFolderToken ? "<token>" : arg))]);
        if (live) {
          const moved = await runCommand("lark-cli", moveArgs, timeoutMs);
          const status = moved.exitCode === 0 ? "moved" : "failed";
          if (status === "moved") report.summary.driveFoldersMoved += 1;
          else report.summary.failures += 1;
          appendLedger(root, { kind: "drive_folder_move", runId: run.runId, projectTitle: project.projectTitle, status, exitCode: moved.exitCode, stderrTail: stderrTail(moved), token: publicTokenState(run.legacyFolderToken) });
          report.operations.push({ kind: "drive_folder_move", runId: run.runId, status, exitCode: moved.exitCode, stderrTail: stderrTail(moved), token: publicTokenState(run.legacyFolderToken) });
          const newTitle = `${run.taxonomy.sourceLineage.date}｜${run.taxonomy.documents?.[0]?.categoryTitle ?? "文档"}｜${run.legacySessionKey.slice(0, 6)}`;
          const patchArgs = ["drive", "files", "patch", "--as", publishAs, "--params", JSON.stringify({ file_token: run.legacyFolderToken, type: "folder" }), "--data", JSON.stringify({ new_title: newTitle })];
          const patched = await runCommand("lark-cli", patchArgs, timeoutMs);
          if (patched.exitCode === 0) report.summary.driveFoldersRenamed += 1;
          appendLedger(root, { kind: "drive_folder_rename", runId: run.runId, title: newTitle, status: patched.exitCode === 0 ? "renamed" : "failed", exitCode: patched.exitCode, stderrTail: stderrTail(patched), token: publicTokenState(run.legacyFolderToken) });
        }
      }
      for (const doc of run.documents) {
        const wikiTitle = wikiDocumentDisplayTitle(project, run, doc);
        const targetParent = categoryTokens.get(doc.docType);
        if (!targetParent) {
          if (doc.url) report.summary.legacyUrlsPreserved += 1;
          continue;
        }
        const existingDoc = existingDocumentNode(wikiRegistry, { runId: run.runId, docType: doc.docType, spaceId: wikiSpaceId });
        if (existingDoc) {
          report.operations.push({
            kind: "wiki_document_skip_existing",
            runId: run.runId,
            docType: doc.docType,
            title: existingDoc.title ?? wikiTitle,
            status: "skipped_existing",
            token: publicTokenState(existingDoc.nodeToken ?? existingDoc.fileToken),
          });
          continue;
        }
        if (live && doc.localPath) {
          const resolvedLocalPath = resolve(doc.localPath);
          if (existsSync(resolvedLocalPath)) {
            const createArgs = ["markdown", "+create", "--as", publishAs, "--file", relative(workspaceDir, resolvedLocalPath), "--name", wikiTitle, "--format", "json"];
            const created = await runCommand("lark-cli", createArgs, timeoutMs);
            const newObjToken = findToken(parseJsonOutput(created.stdout), ["file_token", "token", "obj_token"]);
            const recreateMoveArgs = ["wiki", "+move", "--as", publishAs, "--obj-token", newObjToken ?? "", "--obj-type", "file", "--target-space-id", wikiSpaceId, "--target-parent-token", targetParent];
            const recreatedMove = newObjToken ? await runCommand("lark-cli", recreateMoveArgs, timeoutMs) : { exitCode: 1, stdout: "", stderr: "markdown_create_missing_token" };
            const status = recreatedMove.exitCode === 0 ? "recreated_in_wiki" : "failed";
            if (status === "recreated_in_wiki") {
              report.summary.documentsRecreatedInWiki += 1;
              if (doc.url) report.summary.legacyUrlsPreserved += 1;
            } else {
              report.summary.failures += 1;
            }
            const fallback = {
              attempted: "prefer_recreate_from_local_markdown",
              createExitCode: created.exitCode,
              createStderrTail: stderrTail(created),
              moveExitCode: recreatedMove.exitCode,
              moveStderrTail: stderrTail(recreatedMove),
              newToken: publicTokenState(newObjToken),
            };
            appendLedger(root, { kind: "wiki_document_recreate", runId: run.runId, docType: doc.docType, title: wikiTitle, originalTitle: doc.title, status, exitCode: recreatedMove.exitCode, stderrTail: stderrTail(recreatedMove), fallback, token: publicTokenState(newObjToken) });
            report.operations.push({ kind: "wiki_document_recreate", runId: run.runId, docType: doc.docType, title: wikiTitle, originalTitle: doc.title, status, exitCode: recreatedMove.exitCode, stderrTail: stderrTail(recreatedMove), fallback, token: publicTokenState(newObjToken) });
            if (status === "recreated_in_wiki") {
              const documentReuseKey = `document:${project.projectKey}:${run.runId}:${doc.docType}:${hashText(doc.title).slice(0, 8)}`;
              wikiRegistry.documentNodes[documentReuseKey] = {
                title: wikiTitle,
                originalTitle: doc.title,
                docType: doc.docType,
                sourceRun: run.runId,
                fileToken: newObjToken,
                nodeToken: findToken(parseJsonOutput(recreatedMove.stdout), ["node_token", "wiki_token", "token"]),
                originalFileToken: doc.fileToken,
                spaceId: wikiSpaceId,
                updatedAt: nowIso(),
              };
              saveWikiRegistry(root, wikiRegistry);
            }
            continue;
          }
        }
        if (!doc.fileToken) {
          if (doc.url) report.summary.legacyUrlsPreserved += 1;
          continue;
        }
        const moveArgs = ["wiki", "+move", "--as", publishAs, "--obj-token", doc.fileToken, "--obj-type", "docx", "--target-space-id", wikiSpaceId, "--target-parent-token", targetParent];
        report.plannedCommands.push(["lark-cli", ...publicCommand(moveArgs, [doc.fileToken, targetParent])]);
        if (!live) continue;
        const moved = await runCommand("lark-cli", moveArgs, timeoutMs);
        let status = moved.exitCode === 0 ? "moved" : "failed";
        let finalResult = moved;
        let fallback = null;
        if (status !== "moved") {
          const fileMoveArgs = ["wiki", "+move", "--as", publishAs, "--obj-token", doc.fileToken, "--obj-type", "file", "--target-space-id", wikiSpaceId, "--target-parent-token", targetParent];
          finalResult = await runCommand("lark-cli", fileMoveArgs, timeoutMs);
          status = finalResult.exitCode === 0 ? "moved_as_file" : "failed";
          fallback = { attempted: "obj_type_file", exitCode: finalResult.exitCode, stderrTail: stderrTail(finalResult) };
        }
        if (!["moved", "moved_as_file"].includes(status) && doc.localPath) {
          const resolvedLocalPath = resolve(doc.localPath);
          if (existsSync(resolvedLocalPath)) {
            const createArgs = ["markdown", "+create", "--as", publishAs, "--file", relative(workspaceDir, resolvedLocalPath), "--name", wikiTitle, "--format", "json"];
            const created = await runCommand("lark-cli", createArgs, timeoutMs);
            const newObjToken = findToken(parseJsonOutput(created.stdout), ["file_token", "token", "obj_token"]);
            const recreateMoveArgs = ["wiki", "+move", "--as", publishAs, "--obj-token", newObjToken ?? "", "--obj-type", "docx", "--target-space-id", wikiSpaceId, "--target-parent-token", targetParent];
            const recreatedMove = newObjToken ? await runCommand("lark-cli", recreateMoveArgs, timeoutMs) : { exitCode: 1, stdout: "", stderr: "markdown_create_missing_token" };
            status = recreatedMove.exitCode === 0 ? "recreated_in_wiki" : "failed";
            finalResult = recreatedMove;
            fallback = {
              attempted: "recreate_from_local_markdown",
              createExitCode: created.exitCode,
              createStderrTail: stderrTail(created),
              moveExitCode: recreatedMove.exitCode,
              moveStderrTail: stderrTail(recreatedMove),
              newToken: publicTokenState(newObjToken),
            };
          }
        }
        if (["moved", "moved_as_file"].includes(status)) report.summary.documentsMovedToWiki += 1;
        else if (status === "recreated_in_wiki") {
          report.summary.documentsRecreatedInWiki += 1;
          report.summary.legacyUrlsPreserved += doc.url ? 1 : 0;
        } else {
          report.summary.failures += 1;
            if (doc.url) report.summary.legacyUrlsPreserved += 1;
        }
        appendLedger(root, { kind: "wiki_document_move", runId: run.runId, docType: doc.docType, title: wikiTitle, originalTitle: doc.title, status, exitCode: finalResult.exitCode, stderrTail: stderrTail(finalResult), fallback, token: publicTokenState(doc.fileToken) });
        report.operations.push({ kind: "wiki_document_move", runId: run.runId, docType: doc.docType, title: wikiTitle, originalTitle: doc.title, status, exitCode: finalResult.exitCode, stderrTail: stderrTail(finalResult), fallback, token: publicTokenState(doc.fileToken) });
        if (live && ["moved", "moved_as_file", "recreated_in_wiki"].includes(status)) {
          const documentReuseKey = `document:${project.projectKey}:${run.runId}:${doc.docType}:${hashText(doc.title).slice(0, 8)}`;
          wikiRegistry.documentNodes[documentReuseKey] = {
            title: wikiTitle,
            originalTitle: doc.title,
            docType: doc.docType,
            sourceRun: run.runId,
            fileToken: doc.fileToken,
            updatedAt: nowIso(),
          };
          saveWikiRegistry(root, wikiRegistry);
        }
      }
    }
  }
  writeJson(join(root, REPORT_FILE), report);
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? "plan";
  const root = normalizeRoot(args["output-root"] ?? args.root);
  const inventory = collectInventory(root);
  if (command === "inventory") {
    const output = publicInventory(inventory);
    writeJson(join(root, INVENTORY_FILE), output);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }
  const plan = buildOrganizationPlan(inventory);
  if (command === "plan") {
    writeJson(join(root, INVENTORY_FILE), publicInventory(inventory));
    writeJson(join(root, PLAN_FILE), plan);
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  if (command === "apply") {
    writeJson(join(root, INVENTORY_FILE), publicInventory(inventory));
    writeJson(join(root, PLAN_FILE), plan);
    const report = await applyOrganization({
      root,
      inventory,
      plan,
      live: Boolean(args.live),
      noDelete: Boolean(args["no-delete"]),
      publishAs: args.as ?? "user",
      spaceId: args["wiki-space-id"] ?? process.env.FEISHU_WIKI_SPACE_ID ?? null,
      timeoutMs: Number(args["cli-timeout-ms"] ?? 120000),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  throw new Error(`unknown_command:${command}`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
