import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DOC_CATEGORY_LABELS, PROJECT_WIKI_ROOT_TITLE, buildPublishTaxonomy, docCategory as taxonomyDocCategory } from "./feishu_publish_taxonomy.mjs";

export const WIKI_PUBLISH_PLAN_FILE = "wiki-publish-plan.json";
export const WIKI_PUBLISH_RESULT_FILE = "wiki-publish.json";
export const WIKI_TARGET_REGISTRY_FILE = "feishu-wiki-target-registry.json";
const TAXONOMY_TREE_POLICY_MARKER = "project_workspace_canonical";

function nowIso() {
  return new Date().toISOString();
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

function loadJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function hashLike(value) {
  let hash = 0;
  const text = String(value ?? "");
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36).slice(0, 8).padStart(4, "0");
}

function normalizeKey(value, fallback = "item") {
  const ascii = String(value ?? "")
    .normalize("NFKD")
    .replace(/[^\w\s.-]/g, " ")
    .replace(/[_\s.]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 36);
  return `${ascii || fallback}-${hashLike(value)}`;
}

function dateFromTask(task) {
  const raw = Number(task?.sourceEvent?.message?.createTime);
  const date = Number.isFinite(raw) && raw > 0
    ? new Date(raw > 10_000_000_000 ? raw : raw * 1000)
    : new Date();
  return date.toISOString().slice(0, 10);
}

function safeTitle(value, fallback = "待确认") {
  return String(value ?? fallback).replace(/[\/\\:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 90) || fallback;
}

function docCategory(docType) {
  return DOC_CATEGORY_LABELS[docType] ?? taxonomyDocCategory(docType);
}

function inferProjectTitle(task, documents, titlePlan) {
  if (titlePlan?.projectTitle) return safeTitle(titlePlan.projectTitle, "待确认项目");
  const title = documents.find((doc) => doc.title)?.title ?? "";
  const parts = String(title).split("｜").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) return safeTitle(parts[1], "待确认项目");
  const prompt = String(task?.sourceEvent?.message?.text ?? "").replace(/https?:\/\/\S+/g, " ");
  const match = prompt.match(/([\u4e00-\u9fa5A-Za-z0-9]{2,40})(?:的)?(?:PRD|技术架构|Checklist|会议纪要|运营方案)/i);
  return safeTitle(match?.[1] ?? "待确认项目", "待确认项目");
}

function inferRunTopic(documents) {
  const types = [...new Set(documents.map((doc) => doc.docType).filter(Boolean))];
  if (types.length === 1 && types[0] === "meeting-minutes") return "会议纪要";
  if (types.length === 1) return docCategory(types[0]);
  return "文档生成";
}

export function wikiPlanPath(paths) {
  return join(paths.artifactsDir, WIKI_PUBLISH_PLAN_FILE);
}

export function wikiPublishPath(paths) {
  return join(paths.runDir, WIKI_PUBLISH_RESULT_FILE);
}

export function wikiTargetRegistryPath(paths) {
  return join(dirname(dirname(paths.runDir)), WIKI_TARGET_REGISTRY_FILE);
}

export function loadWikiTargetRegistry(paths) {
  const registry = loadJsonIfExists(wikiTargetRegistryPath(paths));
  if (registry?.schemaVersion === "feishu-wiki-target-registry-v1") {
    return {
      schemaVersion: "feishu-wiki-target-registry-v1",
      updatedAt: registry.updatedAt ?? null,
      spaces: registry.spaces ?? {},
      projectNodes: registry.projectNodes ?? {},
      rootNodes: registry.rootNodes ?? {},
      runNodes: registry.runNodes ?? {},
      categoryNodes: registry.categoryNodes ?? {},
      documentNodes: registry.documentNodes ?? {},
      rawSecretsReturned: false,
    };
  }
  return {
    schemaVersion: "feishu-wiki-target-registry-v1",
    updatedAt: null,
    spaces: {},
    rootNodes: {},
    projectNodes: {},
    runNodes: {},
    categoryNodes: {},
    documentNodes: {},
    rawSecretsReturned: false,
  };
}

export function saveWikiTargetRegistry(paths, registry) {
  return writeJson(wikiTargetRegistryPath(paths), {
    ...registry,
    updatedAt: nowIso(),
    rawSecretsReturned: false,
  });
}

export function buildWikiPublishPlan({ task, documents, paths, options, workspaceDir, taxonomyPlan = null }) {
  const titlePlan = loadJsonIfExists(join(paths.artifactsDir, "document-title-plan.json"));
  const taxonomy = taxonomyPlan ?? buildPublishTaxonomy({
    task,
    documents,
    paths,
    options,
    workspaceDir,
    legacySessionKey: null,
    writeFile: true,
  });
  const projectTitle = taxonomy?.projectTitle ? safeTitle(taxonomy.projectTitle, "待确认项目") : inferProjectTitle(task, documents, titlePlan);
  const date = dateFromTask(task);
  const topic = inferRunTopic(documents);
  const projectKeyPart = normalizeKey(projectTitle, "project");
  const topicKeyPart = normalizeKey(topic, "topic");
  const runTitle = `${date}｜${projectTitle}｜${topic}`;
  const spaceId = options.wikiSpaceId ?? null;
  const rootNodeToken = options.wikiRootNodeToken ?? null;
  const rootMode = spaceId ? (options.wikiSpaceResolved ? "project_wiki_space" : "configured_space") : rootNodeToken ? "configured_root_node" : "my_library";
  const rootReuseKey = taxonomy?.wiki?.rootReuseKey ?? "root:pi-agent-project-knowledge-base";
  const rootTitle = taxonomy?.wiki?.rootTitle ?? PROJECT_WIKI_ROOT_TITLE;
  const projectReuseKey = taxonomy?.wiki?.projectReuseKey ?? `project:${projectKeyPart}`;
  const runReuseKey = `run:${projectKeyPart}:${date}:${topicKeyPart}`;
  const categoryReuseKeys = new Map();

  const projectNodeTitle = taxonomy?.wiki?.projectTitle ?? projectTitle;
  const nodes = [];
  if (!rootNodeToken && !spaceId) {
    nodes.push({ level: "root", title: rootTitle, reuseKey: rootReuseKey, parentReuseKey: null });
  }
  nodes.push({ level: "project", title: projectNodeTitle, reuseKey: projectReuseKey, parentReuseKey: rootNodeToken ? "configured-root" : spaceId ? null : rootReuseKey });
  for (const doc of documents) {
    const categoryTitle = docCategory(doc.docType);
    const taxonomyDoc = taxonomy?.documents?.find((item) => item.docType === doc.docType);
    const key = taxonomyDoc?.targetCategoryReuseKey ?? `category:${projectKeyPart}:${normalizeKey(doc.docType ?? categoryTitle, "doc")}`;
    if (!categoryReuseKeys.has(doc.docType)) {
      categoryReuseKeys.set(doc.docType, key);
      nodes.push({ level: "category", title: categoryTitle, reuseKey: key, parentReuseKey: projectReuseKey, docType: doc.docType });
    }
  }

  return {
    schemaVersion: "wiki-publish-plan-v1",
    generatedAt: nowIso(),
    target: "user-deliverables",
    spaceId,
    rootNodeToken,
    rootMode,
    treePolicy: taxonomy?.wiki?.treePolicy ?? "dynamic_content_based",
    taxonomyRef: taxonomy ? "publish-taxonomy.json" : null,
    projectTitle,
    projectKey: taxonomy?.projectKey ?? projectReuseKey,
    rootTitle,
    runTitle,
    nodes,
    documents: documents.map((doc) => ({
      docType: doc.docType ?? "document",
      title: safeTitle(doc.title ?? doc.fileName ?? doc.docType, "文档"),
      fileName: doc.fileName ?? null,
      localPath: doc.localPath ? relative(workspaceDir, resolve(doc.localPath)) : null,
      targetParentReuseKey: categoryReuseKeys.get(doc.docType) ?? runReuseKey,
      documentReuseKey: taxonomy?.documents?.find((item) => item.docType === doc.docType)?.documentReuseKey ?? `document:${task.runId}:${doc.docType ?? "document"}`,
    })),
    sourceRun: task.runId,
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  };
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

function stderrTail(result) {
  return String(result?.stderr ?? "").slice(-2000);
}

function listedSpaces(value) {
  const data = value?.data ?? value;
  if (Array.isArray(data?.spaces)) return data.spaces;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(value?.spaces)) return value.spaces;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

async function ensureProjectWikiSpace({ options, publishAs, runCommand, timeoutMs }) {
  if (options.wikiSpaceId || options.wikiRootNodeToken) {
    return {
      status: "configured",
      spaceId: options.wikiSpaceId ?? null,
      rootNodeTokenPresent: Boolean(options.wikiRootNodeToken),
      spaceName: options.projectWikiSpaceName ?? PROJECT_WIKI_ROOT_TITLE,
    };
  }
  const spaceName = options.projectWikiSpaceName ?? PROJECT_WIKI_ROOT_TITLE;
  const listArgs = ["wiki", "+space-list", "--as", publishAs, "--format", "json"];
  const listed = await runCommand("lark-cli", listArgs, { timeoutMs });
  const listedJson = parseJsonOutput(listed.stdout);
  const existing = listed.exitCode === 0
    ? listedSpaces(listedJson).find((space) => String(space?.name ?? "") === spaceName)
    : null;
  if (existing?.space_id) {
    return {
      status: "reused",
      spaceId: existing.space_id,
      spaceName,
      listExitCode: listed.exitCode,
      stderrTail: stderrTail(listed),
    };
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
  const created = await runCommand("lark-cli", createArgs, { timeoutMs });
  const createdJson = parseJsonOutput(created.stdout);
  const spaceId = findToken(createdJson, ["space_id"]);
  return {
    status: created.exitCode === 0 && spaceId ? "created" : "failed",
    spaceId,
    spaceName,
    listExitCode: listed.exitCode,
    createExitCode: created.exitCode,
    stderrTail: stderrTail(created) || stderrTail(listed),
  };
}

function classifyWikiFailure(result) {
  const text = `${result?.stderr ?? ""}\n${result?.stdout ?? ""}`;
  if (/99991672|action_scope_required|wiki|permission|Access denied|forbidden|HTTP 403/i.test(text)) {
    return "wiki_permission_or_scope_missing";
  }
  if (result?.exitCode === 127) return "lark_cli_not_found";
  if (result?.timedOut) return "wiki_cli_timeout";
  return "wiki_cli_failed";
}

export async function publishDocumentsToWiki({ task, documents, paths, options, workspaceDir, runCommand, writeText, taxonomyPlan = null }) {
  const publishAs = options.publishAs ?? "user";
  const spaceEnsure = options.publishMode === "live"
    ? await ensureProjectWikiSpace({ options, publishAs, runCommand, timeoutMs: options.cliTimeoutMs })
    : null;
  const effectiveOptions = spaceEnsure?.spaceId && !options.wikiSpaceId && !options.wikiRootNodeToken
    ? { ...options, wikiSpaceId: spaceEnsure.spaceId, wikiSpaceResolved: true }
    : options;
  const plan = buildWikiPublishPlan({ task, documents, paths, options: effectiveOptions, workspaceDir, taxonomyPlan });
  writeJson(wikiPlanPath(paths), plan);
  const registry = loadWikiTargetRegistry(paths);
  const result = {
    schemaVersion: "feishu-wiki-publish-v1",
    runId: task.runId,
    status: "blocked",
    publishMode: options.publishMode,
    publishAs,
    publishTarget: options.publishTarget ?? "auto",
    target: "user-deliverables",
    planPath: plan ? WIKI_PUBLISH_PLAN_FILE : null,
    taxonomyPath: plan.taxonomyRef,
    registryPath: WIKI_TARGET_REGISTRY_FILE,
    rootMode: plan.rootMode,
    spaceId: plan.spaceId,
    projectWikiSpace: spaceEnsure,
    rootNodeTokenPresent: Boolean(plan.rootNodeToken),
    plannedCommands: [],
    nodes: [],
    documents: [],
    fallbackReason: null,
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  };

  const spaceListCommand = ["lark-cli", "wiki", "+space-list", "--as", publishAs, "--format", "json"];
  result.plannedCommands.push(spaceListCommand);
  if (options.publishMode === "live") {
    const spaceCheck = await runCommand("lark-cli", spaceListCommand.slice(1), { timeoutMs: options.cliTimeoutMs });
    result.spaceCheck = { exitCode: spaceCheck.exitCode, stderrTail: stderrTail(spaceCheck) };
    if (spaceCheck.exitCode !== 0 && plan.rootMode !== "my_library") {
      result.status = "blocked";
      result.reason = classifyWikiFailure(spaceCheck);
      result.fallbackReason = "wiki_publish_blocked_drive_fallback";
      writeJson(wikiPublishPath(paths), result);
      return result;
    }
  }

  if (options.publishMode !== "live") {
    for (const node of plan.nodes) {
      const command = ["lark-cli", "wiki", "+node-create", "--as", publishAs, "--title", node.title, "--obj-type", "docx"];
      if (!node.parentReuseKey) command.push("--space-id", plan.spaceId ?? "my_library");
      else if (plan.spaceId && node.level === "project" && !plan.rootNodeToken) command.push("--space-id", plan.spaceId);
      if (node.parentReuseKey) command.push("--parent-node-token", `<${node.parentReuseKey}>`);
      result.plannedCommands.push(command);
      result.nodes.push({ ...node, status: "planned" });
    }
    for (const doc of plan.documents) {
      const createCommand = ["lark-cli", "markdown", "+create", "--as", publishAs, "--file", doc.localPath, "--name", doc.fileName ?? `${doc.title}.md`];
      const moveCommand = ["lark-cli", "wiki", "+move", "--as", publishAs, "--obj-token", "<created-doc-token>", "--obj-type", "docx"];
      if (plan.spaceId) moveCommand.push("--target-space-id", plan.spaceId);
      moveCommand.push("--target-parent-token", `<${doc.targetParentReuseKey}>`);
      result.plannedCommands.push(createCommand, moveCommand);
      result.documents.push({ ...doc, status: "planned", action: "wiki_create_and_move" });
    }
    result.status = "dry_run";
    writeJson(wikiPublishPath(paths), result);
    return result;
  }

  const nodeTokens = new Map();
  if (plan.rootNodeToken) nodeTokens.set("configured-root", plan.rootNodeToken);
  for (const node of plan.nodes) {
    const cacheMap = node.level === "root" ? registry.rootNodes : node.level === "project" ? registry.projectNodes : node.level === "run" ? registry.runNodes : registry.categoryNodes;
    let nodeToken = cacheMap[node.reuseKey]?.nodeToken ?? null;
    if (!nodeToken) {
      const args = ["wiki", "+node-create", "--as", publishAs, "--title", node.title, "--obj-type", "docx"];
      const parentToken = node.parentReuseKey ? nodeTokens.get(node.parentReuseKey) : null;
      if (parentToken) args.push("--parent-node-token", parentToken);
      else if (plan.rootNodeToken && node.level === "project") args.push("--parent-node-token", plan.rootNodeToken);
      else args.push("--space-id", plan.spaceId ?? "my_library");
      result.plannedCommands.push(["lark-cli", ...args]);
      const created = await runCommand("lark-cli", args, { timeoutMs: options.cliTimeoutMs });
      const json = parseJsonOutput(created.stdout);
      nodeToken = findToken(json, ["node_token", "token", "wiki_token"]);
      result.nodes.push({ ...node, status: created.exitCode === 0 && nodeToken ? "created" : "failed", nodeTokenPresent: Boolean(nodeToken), exitCode: created.exitCode, stderrTail: stderrTail(created) });
      if (created.exitCode !== 0 || !nodeToken) {
        result.status = "blocked";
        result.reason = classifyWikiFailure(created);
        result.fallbackReason = "wiki_publish_blocked_drive_fallback";
        writeJson(wikiPublishPath(paths), result);
        return result;
      }
      cacheMap[node.reuseKey] = { nodeToken, title: node.title, createdAt: nowIso(), updatedAt: nowIso() };
      saveWikiTargetRegistry(paths, registry);
    } else {
      result.nodes.push({ ...node, status: "reused", nodeTokenPresent: true });
    }
    nodeTokens.set(node.reuseKey, nodeToken);
  }

  for (const [index, doc] of documents.entries()) {
    const planned = plan.documents[index];
    const fileName = planned.fileName ?? `${planned.title}.md`;
    const localPath = resolve(doc.localPath);
    writeText(localPath, String(doc.markdown ?? ""));
    const createArgs = ["markdown", "+create", "--as", publishAs, "--file", relative(workspaceDir, localPath), "--name", fileName, "--format", "json"];
    result.plannedCommands.push(["lark-cli", ...createArgs]);
    const created = await runCommand("lark-cli", createArgs, { timeoutMs: options.cliTimeoutMs });
    const createJson = parseJsonOutput(created.stdout);
    const objToken = findToken(createJson, ["file_token", "token", "obj_token"]);
    const docResult = {
      ...planned,
      status: created.exitCode === 0 && objToken ? "created" : "failed",
      action: "wiki_create_and_move",
      fileToken: objToken ?? null,
      url: findToken(createJson, ["url", "link"]) ?? null,
      exitCode: created.exitCode,
      stderrTail: stderrTail(created),
    };
    if (created.exitCode !== 0 || !objToken) {
      result.documents.push(docResult);
      result.status = "blocked";
      result.reason = "feishu_markdown_create_failed";
      result.fallbackReason = "wiki_publish_blocked_drive_fallback";
      writeJson(wikiPublishPath(paths), result);
      return result;
    }
    const targetParent = nodeTokens.get(planned.targetParentReuseKey);
    const moveArgs = ["wiki", "+move", "--as", publishAs, "--obj-token", objToken, "--obj-type", "docx"];
    moveArgs.push("--target-space-id", plan.spaceId ?? "my_library");
    if (targetParent) moveArgs.push("--target-parent-token", targetParent);
    result.plannedCommands.push(["lark-cli", ...moveArgs]);
    const moved = await runCommand("lark-cli", moveArgs, { timeoutMs: options.cliTimeoutMs });
    const moveJson = parseJsonOutput(moved.stdout);
    docResult.moveStatus = moved.exitCode === 0 ? "moved" : "failed";
    docResult.status = moved.exitCode === 0 ? "published" : "failed";
    docResult.nodeToken = findToken(moveJson, ["node_token", "token", "wiki_token"]) ?? null;
    docResult.moveExitCode = moved.exitCode;
    docResult.moveStderrTail = stderrTail(moved);
    result.documents.push(docResult);
    registry.documentNodes[planned.documentReuseKey] = {
      title: planned.title,
      docType: planned.docType,
      sourceRun: task.runId,
      fileToken: objToken,
      nodeToken: docResult.nodeToken,
      updatedAt: nowIso(),
    };
    saveWikiTargetRegistry(paths, registry);
    if (moved.exitCode !== 0) {
      result.status = "blocked";
      result.reason = classifyWikiFailure(moved);
      result.fallbackReason = "wiki_publish_blocked_drive_fallback";
      writeJson(wikiPublishPath(paths), result);
      return result;
    }
  }

  result.status = "published";
  writeJson(wikiPublishPath(paths), result);
  return result;
}
