import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const PUBLISH_TAXONOMY_FILE = "publish-taxonomy.json";
export const PROJECT_WIKI_ROOT_TITLE = "PI Agent 项目知识库";

/** @type {Readonly<Record<string, string>>} */
export const DOC_CATEGORY_LABELS = {
  "meeting-minutes": "会议纪要",
  prd: "PRD",
  "tech-architecture": "技术架构",
  "ops-plan": "运营方案",
  "customer-requirement-checklist": "客户需求确认",
  "todo-list": "To-do",
  checklist: "To-do",
};

/**
 * @typedef {Record<string, unknown>} UnknownRecord
 * @typedef {{ runId: string, sourceEvent: { message: Record<string, unknown> } }} PublishTask
 * @typedef {{ artifactsDir: string, runDir?: string }} ArtifactPaths
 * @typedef {{ normalizedTitleBase?: unknown, projectName?: unknown, subject?: unknown, sourceTitle?: unknown }} DocumentIdentity
 * @typedef {{ docType?: unknown, title?: unknown, fileName?: unknown, localPath?: unknown, documentIdentity?: DocumentIdentity, titleBasis?: { projectTitle?: unknown } }} PublishDocument
 * @typedef {{ title: string, basis: string, priority: number, accepted: boolean }} ProjectCandidate
 * @typedef {{ task: PublishTask, documents: PublishDocument[], titlePlan: { projectTitle?: unknown } | null, contextManifest: { documentIdentity?: DocumentIdentity } | null }} ProjectCandidateInput
 * @typedef {{ task: PublishTask, documents: unknown, paths: ArtifactPaths, options?: { projectWikiRootTitle?: string, folderToken?: string }, workspaceDir?: string, legacySessionKey?: string, writeFile?: boolean }} BuildPublishTaxonomyInput
 */

const UNKNOWN_PROJECT_TITLE = "待确认项目";
const BAD_PROJECT_TITLE_PATTERNS = [
  /^feishu[-_\s]*chat[-_\s]/i,
  /^feishu[-_\s]*file\b/i,
  /\bfeishu\s+file\b/i,
  /\bnormalized\b/i,
  /\bmono\b/i,
  /\bs16\b/i,
  /\b16k\b/i,
  /^record-\d{8,}/i,
  /^audio[-_\s]*input\b/i,
  /^run[-_\s]*id\b/i,
  /\b[A-Za-z0-9_-]{14,}\b/,
  /^文档生成$/,
  /^会议纪要$/,
  /^PRD$/i,
  /^技术架构$/,
  /^客户需求确认$/,
  /^参会方$/,
  /^总结$/,
  /^_?user_?\d+$/i,
  /这个文档/,
  /请根据.*(?:会议|录音|文件).*生成/,
  /根据.*(?:会议|录音|文件).*生成/,
  /生成会议纪要/,
  /这次会议/,
  /这段录音/,
  /会议录音文件/,
  /按.*会(?:议|记|记纪要).*方案.*撰写/,
];

function nowIso() {
  return new Date().toISOString();
}

/** @param {unknown} value */
function hashText(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

/** @param {string} path @returns {UnknownRecord | null} */
function loadJsonIfExists(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** @param {string} path @param {unknown} value */
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

/** @param {ArtifactPaths} paths */
export function publishTaxonomyPath(paths) {
  return join(paths.artifactsDir, PUBLISH_TAXONOMY_FILE);
}

/** @param {unknown} value @param {string} [fallback] */
export function safePublishTitle(value, fallback = UNKNOWN_PROJECT_TITLE) {
  const cleaned = String(value ?? "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(?:file[_\s-]?token|obj[_\s-]?token|token)\s*[:=：]\s*[A-Za-z0-9_-]{8,}/gi, " ")
    .replace(/[\/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
  return cleaned || fallback;
}

/** @param {unknown} value */
function stripMarkdownSuffix(value) {
  return String(value ?? "").replace(/\.(md|markdown|docx?|pdf|wav|mp3|m4a|aac|flac|ogg)$/i, "").trim();
}

/** @param {unknown} title */
function projectTitleFromDocumentTitle(title) {
  const clean = safePublishTitle(stripMarkdownSuffix(title), "");
  const parts = clean.split("｜").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[1];
  return clean;
}

/** @param {unknown} value */
function isWeakProjectTitle(value) {
  const title = safePublishTitle(value, "");
  if (!title || title.length < 2) return true;
  if (title === UNKNOWN_PROJECT_TITLE || title === "待确认") return true;
  if (BAD_PROJECT_TITLE_PATTERNS.some((pattern) => pattern.test(title))) return true;
  const compact = title.replace(/[\s_-]/g, "");
  if (/^[A-Za-z0-9]{12,}$/.test(compact)) return true;
  return false;
}

/** @param {unknown} title @param {string} [legacySessionKey] */
function normalizeProjectKey(title, legacySessionKey = "") {
  const asciiSlug = String(title ?? "")
    .normalize("NFKD")
    .replace(/[^\w\s.-]/g, " ")
    .replace(/[_\s.]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 36);
  const seed = isWeakProjectTitle(title) ? `${title}:${legacySessionKey}` : title;
  return `project:${asciiSlug || "project"}-${hashText(seed).slice(0, 10)}`;
}

/** @param {unknown} docType */
export function docCategory(docType) {
  return DOC_CATEGORY_LABELS[String(docType ?? "")] ?? safePublishTitle(docType, "文档");
}

/** @param {PublishTask} task */
function dateFromTask(task) {
  const raw = Number(task.sourceEvent.message.createTime);
  const date = Number.isFinite(raw) && raw > 0
    ? new Date(raw > 10_000_000_000 ? raw : raw * 1000)
    : new Date();
  return date.toISOString().slice(0, 10);
}

/** @param {ArtifactPaths} paths */
function contextManifestPath(paths) {
  return join(paths.artifactsDir, "source-context", "context-manifest.json");
}

/** @param {ArtifactPaths} paths */
function documentTitlePlanPath(paths) {
  return join(paths.artifactsDir, "document-title-plan.json");
}

/** @param {ProjectCandidateInput} input @returns {ProjectCandidate[]} */
function collectProjectCandidates({ task, documents, titlePlan, contextManifest }) {
  /** @type {ProjectCandidate[]} */
  const candidates = [];
  /** @param {unknown} value @param {string} basis @param {number} priority */
  const push = (value, basis, priority) => {
    const title = safePublishTitle(stripMarkdownSuffix(value), "");
    if (!title) return;
    candidates.push({ title, basis, priority, accepted: !isWeakProjectTitle(title) });
  };

  push(titlePlan?.projectTitle, "document_title_plan.projectTitle", 100);
  push(contextManifest?.documentIdentity?.normalizedTitleBase, "context_manifest.documentIdentity.normalizedTitleBase", 95);
  push(contextManifest?.documentIdentity?.projectName, "context_manifest.documentIdentity.projectName", 90);
  push(contextManifest?.documentIdentity?.subject, "context_manifest.documentIdentity.subject", 85);
  push(contextManifest?.documentIdentity?.sourceTitle, "context_manifest.documentIdentity.sourceTitle", 70);

  for (const doc of documents) {
    push(doc?.documentIdentity?.normalizedTitleBase, "document.documentIdentity.normalizedTitleBase", 82);
    push(doc?.titleBasis?.projectTitle, "document.titleBasis.projectTitle", 80);
    push(projectTitleFromDocumentTitle(doc?.title), "document.title", 75);
    push(projectTitleFromDocumentTitle(doc?.fileName), "document.fileName", 40);
  }

  const prompt = String(task.sourceEvent.message.text ?? "").replace(/https?:\/\/\S+/g, " ");
  const promptMatch = prompt.match(/([\u4e00-\u9fa5A-Za-z0-9 _-]{2,40})(?:的)?(?:PRD|技术架构|Checklist|checklist|会议纪要|运营方案|to do|todo|待办)/i);
  if (promptMatch) push(promptMatch[1], "task_prompt_keyword", 55);

  return candidates.sort((left, right) => right.priority - left.priority);
}

/** @param {ProjectCandidateInput} params */
function chooseProjectIdentity(params) {
  const candidates = collectProjectCandidates(params);
  const accepted = candidates.find((candidate) => candidate.accepted);
  if (accepted) {
    return {
      projectTitle: safePublishTitle(accepted.title, UNKNOWN_PROJECT_TITLE),
      confidence: accepted.priority >= 85 ? "high" : "medium",
      basis: accepted.basis,
      rejectedCandidates: candidates.filter((candidate) => !candidate.accepted).slice(0, 8),
    };
  }
  return {
    projectTitle: UNKNOWN_PROJECT_TITLE,
    confidence: "low",
    basis: "fallback_unknown_project",
    rejectedCandidates: candidates.slice(0, 8),
  };
}

/** @param {PublishTask} task @param {string} legacySessionKey */
function sourceThreadKey(task, legacySessionKey) {
  const message = task.sourceEvent.message;
  const seed = [
    message.chatId || "unknown_chat",
    message.threadId || message.rootId || message.parentId || message.messageId || legacySessionKey || task.runId || "unknown_thread",
  ].join(":");
  return `source-thread:${hashText(seed).slice(0, 16)}`;
}

/** @param {BuildPublishTaxonomyInput} input */
export function buildPublishTaxonomy({
  task,
  documents,
  paths,
  options = {},
  workspaceDir,
  legacySessionKey = "",
  writeFile = true,
}) {
  const taxonomyOptions = options;
  const titlePlan = loadJsonIfExists(documentTitlePlanPath(paths));
  const contextManifest = loadJsonIfExists(contextManifestPath(paths));
  const docs = /** @type {PublishDocument[]} */ (Array.isArray(documents) ? documents : []);
  const identity = chooseProjectIdentity({
    task,
    documents: docs,
    titlePlan: /** @type {{ projectTitle?: unknown } | null} */ (titlePlan),
    contextManifest: /** @type {{ documentIdentity?: DocumentIdentity } | null} */ (contextManifest),
  });
  const projectTitle = identity.projectTitle;
  const projectKey = normalizeProjectKey(projectTitle, legacySessionKey || task.runId);
  const date = dateFromTask(task);
  const categories = new Map();
  const documentPlans = docs.map((doc, index) => {
    const docType = doc?.docType ?? "document";
    const categoryTitle = docCategory(docType);
    const categoryReuseKey = `category:${projectKey}:${hashText(docType).slice(0, 8)}`;
    categories.set(docType, { docType, title: categoryTitle, reuseKey: categoryReuseKey });
    return {
      index,
      docType,
      title: safePublishTitle(doc?.title ?? doc?.fileName ?? docType, "文档"),
      fileName: doc?.fileName ?? null,
      localPath: typeof doc.localPath === "string" && workspaceDir ? relative(workspaceDir, resolve(doc.localPath)) : null,
      categoryTitle,
      targetCategoryReuseKey: categoryReuseKey,
      documentReuseKey: `document:${projectKey}:${task.runId}:${String(docType)}:${index}`,
    };
  });
  const taxonomy = {
    schemaVersion: "feishu-publish-taxonomy-v1",
    generatedAt: nowIso(),
    source: "publish_taxonomy",
    projectTitle,
    projectKey,
    projectConfidence: identity.confidence,
    projectBasis: identity.basis,
    rejectedProjectCandidates: identity.rejectedCandidates,
    legacySessionKey: legacySessionKey || null,
    sourceThreadKey: sourceThreadKey(task, legacySessionKey),
    sourceLineage: {
      runId: task.runId,
      chatIdHash: task.sourceEvent.message.chatId ? hashText(task.sourceEvent.message.chatId).slice(0, 16) : null,
      threadIdPresent: Boolean(task.sourceEvent.message.threadId || task.sourceEvent.message.rootId || task.sourceEvent.message.parentId),
      messageIdHash: task.sourceEvent.message.messageId ? hashText(task.sourceEvent.message.messageId).slice(0, 16) : null,
      date,
    },
    wiki: {
      rootTitle: taxonomyOptions.projectWikiRootTitle ?? PROJECT_WIKI_ROOT_TITLE,
      rootReuseKey: "root:pi-agent-project-knowledge-base",
      projectTitle: `项目｜${projectTitle}`,
      projectReuseKey: projectKey,
      treePolicy: "project_workspace_canonical",
      categoryNodes: [...categories.values()],
    },
    drive: {
      folderName: `项目｜${projectTitle}`,
      projectReuseKey: projectKey,
      fallbackPolicy: "project_named_drive_folder",
      parentFolderConfigured: Boolean(taxonomyOptions.folderToken),
    },
    documents: documentPlans,
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  };

  if (writeFile && paths.artifactsDir) writeJson(publishTaxonomyPath(paths), taxonomy);
  return taxonomy;
}

/** @param {unknown} publishTargetValue */
export function extractLegacySessionKeyFromPublishTarget(publishTargetValue) {
  const publishTarget = publishTargetValue && typeof publishTargetValue === "object" && !Array.isArray(publishTargetValue)
    ? /** @type {UnknownRecord} */ (publishTargetValue)
    : null;
  if (publishTarget && typeof publishTarget === "object") {
    if (typeof publishTarget.sessionKey === "string" && publishTarget.sessionKey && publishTarget.sessionKey !== "[redacted]") {
      return publishTarget.sessionKey;
    }
    const folderName = String(publishTarget.folderName ?? "");
    const match = folderName.match(/feishu-chat-([A-Za-z0-9_-]{8,})/i);
    if (match) return match[1];
  }
  return "";
}
