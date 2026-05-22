import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type SourceRecord = {
  sourceId: string;
  sourceType: string;
  title: string;
  artifactPath?: string | null;
  extractedTextPath?: string | null;
  status: string;
  extractionQuality: "ready" | "partial" | "low" | "missing";
  privacyClass: string;
  metadata: Record<string, unknown>;
};

type SourceSegment = {
  segmentId: string;
  sourceId: string;
  sourceType: string;
  title: string;
  text: string;
  segmentKind?: "text" | "table" | "mixed";
  charStart: number | null;
  charEnd: number | null;
  heading?: string | null;
  page?: number | null;
  sheet?: string | null;
  startSec?: number | null;
  endSec?: number | null;
  quality: string;
  metadata: Record<string, unknown>;
};

type DocumentIdentity = {
  projectName: string | null;
  subject: string | null;
  sourceTitle: string | null;
  normalizedTitleBase: string | null;
  confidence: "high" | "medium" | "low";
  basis: string[];
  warnings: string[];
  titleByDocType: Record<string, {
    title: string;
    feishuFileName: string;
    identityBasis: string[];
    identityConfidence: "high" | "medium" | "low";
  }>;
};

type SourceBlock = {
  blockId: string;
  segmentId: string | null;
  sourceId: string;
  blockType: "heading" | "paragraph" | "table" | "list" | "comment_anchor";
  sourceFormat?: "markdown_table" | "html_table" | "plain_text";
  headingPath?: string[];
  columns?: string[];
  rowCount?: number;
  markdownPreview?: string;
  quality: "ready" | "needs_fix" | "blocked";
  textPreview?: string;
  metadata?: Record<string, unknown>;
};

type SourceStructure = {
  schemaVersion: string;
  generatedAt: string;
  headings: SourceBlock[];
  tables: SourceBlock[];
  commentAnchors: SourceBlock[];
  blockCount: number;
  tableBlockCount: number;
  rawHtmlTableCount: number;
  markdownTableCount: number;
  rawSecretsReturned: false;
  rawMediaExternalUpload: false;
};

type OutputContract = {
  schemaVersion: "document-output-contract-v1";
  outputContractVersion: "document-output-contract-v1";
  titlePolicy: {
    forbidGenericUploadName: true;
    requireIdentityBasis: true;
  };
  markdownPolicy: {
    forbidHtmlTableTags: true;
    tablesMustBeMarkdownOrBullets: true;
  };
  publishBlockingRules: string[];
};

type WorkUnit = {
  workUnitId: string;
  docType: string;
  sections: string[];
  contextPackRef: string;
  contextPackId: string;
  contextPackHash: string;
  sourceSegmentIds: string[];
  sourceBlockIds: string[];
  tableBlockCount: number;
  promptBudgetChars: number;
  evidenceBudgetChars: number;
  retrievalReasons: string[];
  outputContractVersion: string;
  documentIdentityConfidence: "high" | "medium" | "low";
};

type PromptRecord = {
  docType: string;
  promptFile: string;
  aliases: string[];
  dependsOn?: string[];
  audience?: string;
  requiredSections: string[];
};

const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(extensionDir);
const workspaceDir = dirname(packageDir);
const promptRegistryPath = join(packageDir, "runtime", "document-prompt-registry.json");

const SOURCE_CONTEXT_VERSION = "source-context-v1";
const SEGMENT_TARGET_CHARS = 1200;
const SEGMENT_MAX_CHARS = 1500;
const SEGMENT_OVERLAP_CHARS = 120;
const DEFAULT_SECTION_PROMPT_HARD_CAP_CHARS = 24_000;
const DEFAULT_EVIDENCE_HARD_CAP_CHARS = 12_000;
const DEFAULT_CONTEXT_RULES_BUDGET_CHARS = 4_000;
const MAX_SEGMENTS_PER_PACK = 10;
const MAX_SOURCE_READ_CHARS = 240_000;

const DOC_TITLE_PREFIX: Record<string, string> = {
  "meeting-minutes": "会议纪要",
  prd: "PRD",
  "tech-architecture": "技术架构",
  "ops-plan": "运营方案",
  "customer-requirement-checklist": "客户需求确认表",
};

const DOC_TITLE_FOCUS: Record<string, string> = {
  "meeting-minutes": "会议讨论",
  prd: "产品化方案",
  "tech-architecture": "技术实现方案",
  "ops-plan": "运营落地方案",
  "customer-requirement-checklist": "需求澄清",
};

const SECRET_PATTERNS = [
  /(app_secret|client_secret|refresh_token|access_token|authorization|cookie|session)\s*[:=]\s*["']?[^"',\s]+/gi,
  /bearer\s+[A-Za-z0-9._-]+/gi,
  /\b(FEISHU_APP_SECRET|DEEPSEEK_API_KEY|XIAOMI_TOKEN_PLAN_SGP_API_KEY)\b/gi,
];

function nowIso() {
  return new Date().toISOString();
}

function isInside(parent: string, child: string) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeSegment(value: unknown, fallback = "item") {
  const cleaned = String(value || fallback).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned;
}

function safeFileName(value: unknown, fallback = "document.md") {
  const name = String(value || fallback).replace(/[\/\\:*?"<>|]/g, "_").trim().slice(0, 120) || fallback;
  return name.endsWith(".md") ? name : `${name}.md`;
}

function workspaceRelative(path?: string | null) {
  if (!path) return null;
  const resolved = resolve(path);
  return isInside(workspaceDir, resolved) ? relative(workspaceDir, resolved) : "[outside-workspace]";
}

function runtimeRoot(outputRoot?: string) {
  const root = resolve(outputRoot ?? join(workspaceDir, "runtime-runs"));
  if (!isInside(workspaceDir, root)) {
    throw new Error("source_context_output_root_outside_workspace_blocked");
  }
  return root;
}

function sourceContextDir(runId: string, outputRoot?: string) {
  const root = runtimeRoot(outputRoot);
  const dir = resolve(root, safeSegment(runId, "run"), "artifacts", "source-context");
  if (!isInside(root, dir)) {
    throw new Error("source_context_run_dir_outside_root_blocked");
  }
  return dir;
}

function safeWorkspacePath(path?: string | null) {
  if (!path) return null;
  const resolved = resolve(path);
  if (!isInside(workspaceDir, resolved)) {
    throw new Error("source_context_path_outside_workspace_blocked");
  }
  return resolved;
}

function readJson(path?: string | null) {
  const resolved = safeWorkspacePath(path);
  if (!resolved || !existsSync(resolved)) return null;
  return JSON.parse(readFileSync(resolved, "utf8"));
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

function writeJsonl(path: string, rows: unknown[]) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8");
  return path;
}

function sha256(value: unknown) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value ?? null)).digest("hex");
}

function redactString(value: unknown) {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[redacted]"), String(value ?? ""));
}

function decodeHtmlEntities(value: unknown) {
  return String(value ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function cleanHtmlTableCell(value: unknown) {
  return decodeHtmlEntities(value)
    .replace(/<br\s*\/?>/gi, "； ")
    .replace(/<\/?(b|strong|em|i|p|span|div)[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlTableToMarkdown(tableHtml: string) {
  const rows = [...String(tableHtml ?? "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((rowMatch) => [...rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((cellMatch) => cleanHtmlTableCell(cellMatch[1])))
    .filter((cells) => cells.length > 0);
  if (rows.length === 0) return tableHtml;
  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) => Array.from({ length: columnCount }, (_, index) => row[index] ?? ""));
  const header = normalizedRows[0];
  const separator = Array.from({ length: columnCount }, () => "---");
  const body = normalizedRows.slice(1);
  return [header, separator, ...body].map((row) => `| ${row.join(" | ")} |`).join("\n");
}

function normalizeHtmlTables(value: unknown) {
  return String(value ?? "").replace(/<table\b[\s\S]*?<\/table>/gi, (tableHtml) => htmlTableToMarkdown(tableHtml));
}

function normalizeText(value: unknown) {
  return redactString(normalizeHtmlTables(value))
    .replace(/\u0000/g, "")
    .replace(/[^\S\r\n]{2,}/g, " ")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function readTextBounded(path?: string | null, maxChars = MAX_SOURCE_READ_CHARS) {
  const resolved = safeWorkspacePath(path);
  if (!resolved || !existsSync(resolved)) return "";
  return normalizeText(readFileSync(resolved, "utf8")).slice(0, maxChars);
}

function readRawTextBounded(path?: string | null, maxChars = MAX_SOURCE_READ_CHARS) {
  const resolved = safeWorkspacePath(path);
  if (!resolved || !existsSync(resolved)) return "";
  return redactString(readFileSync(resolved, "utf8")).replace(/\u0000/g, "").slice(0, maxChars);
}

function looksLikeGenericUploadName(value: unknown) {
  const text = String(value ?? "").toLowerCase();
  const hasLongAlphaNumericToken = /[a-z0-9]{14,}/i.test(text) && /[a-z]/i.test(text) && /\d/.test(text);
  return !text ||
    /^record[-_\s]?\d/.test(text) ||
    /^audio[-_\s]?\d/.test(text) ||
    /^file[-_\s]?\d/.test(text) ||
    /^source[-_\s]?\d/.test(text) ||
    /feishu[-_\s]?file[-_\s]?\d/.test(text) ||
    (/^(file|doc|docx|markdown|md|feishu)[-_\s.]?/i.test(text) && hasLongAlphaNumericToken) ||
    hasLongAlphaNumericToken;
}

function cleanTitlePart(value: unknown, fallback = "待确认") {
  const cleaned = String(value ?? "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\.(md|markdown|txt|csv|pdf|docx?|xlsx?|xls|wav|mp3|m4a|aac|flac|ogg)$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/[\/\\:*?"<>|#`~]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^.*进行/, "")
    .replace(/^(进行|生成|撰写|输出|形成|整理|分析|总结|基于|结合|关于)/, "")
    .replace(/^(这个|该)?(文档|文件|材料|内容)(和|与)?(我)?(整理|梳理)?(的)?/, "")
    .replace(/(的)?(PRD|技术架构文档?|客户\s*Checklist|客户需求确认表|会议纪要|运营方案|文档撰写)$/i, "")
    .trim();
  if (!cleaned || cleaned.length < 2 || looksLikeGenericUploadName(cleaned)) return fallback;
  return cleaned.slice(0, 36);
}

function extractFirstMarkdownH1(text: string) {
  return String(text ?? "").match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() ?? "";
}

function projectTitleFromDocumentTitle(title: unknown) {
  const raw = String(title ?? "").trim();
  if (!raw || looksLikeGenericUploadName(raw)) return "";
  const parts = raw.split(/[｜|]/).map((part) => cleanTitlePart(part, "")).filter(Boolean);
  if (parts.length >= 2 && /^(PRD|技术架构|运营方案|客户需求确认表|会议纪要)$/i.test(parts[0])) {
    return looksLikeGenericUploadName(parts[1]) ? "" : parts[1];
  }
  const withoutDocType = raw
    .replace(/^(PRD|技术架构|运营方案|客户需求确认表|会议纪要)[：:\s｜|-]*/i, "")
    .replace(/[｜|]\s*(产品化方案|技术实现方案|运营落地方案|需求澄清|会议讨论|待确认)\s*$/i, "");
  const cleaned = cleanTitlePart(withoutDocType, "");
  return cleaned && !looksLikeGenericUploadName(cleaned) ? cleaned : "";
}

function inferProjectTitleFromPrompt(text: unknown) {
  const prompt = normalizeText(text);
  const candidates: string[] = [];
  const patterns = [
    /进行\s*([^，。；\n]{2,48}?)(?:的)?(?:PRD|技术架构文档?|客户\s*Checklist|客户需求确认表|会议纪要|运营方案|文档撰写)/gi,
    /(?:生成|撰写|输出|形成)\s*([^，。；\n]{2,48}?)(?:的)?(?:PRD|技术架构文档?|客户\s*Checklist|客户需求确认表|会议纪要|运营方案)/gi,
    /关于\s*([^，。；\n]{2,48}?)(?:的)?(?:PRD|技术架构文档?|客户\s*Checklist|客户需求确认表|会议纪要|运营方案)/gi,
    /([^，。；\n]{2,48}?)(?:的)?(?:PRD|技术架构文档?|客户\s*Checklist|客户需求确认表|会议纪要|运营方案)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of prompt.matchAll(pattern)) {
      const candidate = cleanTitlePart(match[1], "");
      if (candidate && !/^(这个文档|该文件|文件内容|文档内容|内容)$/.test(candidate)) candidates.push(candidate);
    }
  }
  return candidates
    .map((candidate, index) => ({
      candidate,
      score:
        (/(AI|Agent|智能|自动化|工作流|系统|平台|产品|项目|方案|流程)/i.test(candidate) ? 20 : 0) +
        Math.min(candidate.length, 24) -
        (/^(文档|文件|内容|材料)$/.test(candidate) ? 50 : 0) +
        index / 100,
    }))
    .sort((a, b) => b.score - a.score)[0]?.candidate ?? "";
}

function inferDominantSubjectFromSegments(sourceSegments: SourceSegment[]) {
  const transcriptText = normalizeText(sourceSegments
    .filter((segment) => segment.sourceType === "audio_transcript" && segment.text)
    .slice(0, 80)
    .map((segment) => segment.text)
    .join("\n"))
    .slice(0, 16_000);
  if (!transcriptText) return "";

  const has = (pattern: RegExp) => pattern.test(transcriptText);
  const candidates = [
    {
      title: "抖音私信 AI 客服方案",
      score:
        (has(/抖音/) ? 3 : 0) +
        (has(/私信/) ? 3 : 0) +
        (has(/AI|人工智能/i) ? 3 : 0) +
        (has(/客服/) ? 3 : 0) +
        (has(/小程序|选品|催单|核销/) ? 1 : 0),
    },
    {
      title: "抖音小程序客服方案",
      score:
        (has(/抖音/) ? 3 : 0) +
        (has(/小程序/) ? 3 : 0) +
        (has(/客服/) ? 3 : 0) +
        (has(/AI|私信|选品/) ? 1 : 0),
    },
    {
      title: "AI 客服选品与催单流程",
      score:
        (has(/AI|人工智能/i) ? 3 : 0) +
        (has(/客服/) ? 3 : 0) +
        (has(/选品/) ? 2 : 0) +
        (has(/催单/) ? 2 : 0) +
        (has(/核销/) ? 1 : 0),
    },
    {
      title: "客服选品与核销流程",
      score:
        (has(/客服/) ? 3 : 0) +
        (has(/选品/) ? 2 : 0) +
        (has(/核销/) ? 2 : 0) +
        (has(/催单|购物车|下单/) ? 1 : 0),
    },
    {
      title: "项目 Demo 交付与试用方案",
      score:
        (has(/Demo|demo/) ? 3 : 0) +
        (has(/定金|尾款|试用|交付/) ? 3 : 0) +
        (has(/迭代|反馈/) ? 1 : 0),
    },
  ];
  const best = candidates
    .filter((candidate) => candidate.score >= 7)
    .sort((a, b) => b.score - a.score)[0]?.title;
  if (best) return best;

  const fallbackTerms = [
    [/抖音/, "抖音"],
    [/AI|人工智能/i, "AI"],
    [/客服/, "客服"],
    [/小程序/, "小程序"],
    [/选品/, "选品"],
    [/催单/, "催单"],
    [/核销/, "核销"],
    [/Demo|demo/, "Demo"],
    [/补充协议|协议/, "协议"],
  ].filter(([pattern]) => (pattern as RegExp).test(transcriptText))
    .map(([, label]) => String(label));
  const uniqueTerms = [...new Set(fallbackTerms)].slice(0, 4);
  if (uniqueTerms.length >= 2) return cleanTitlePart(`${uniqueTerms.join(" ")}会议`, "");
  return "";
}

function stripExtensionForTitle(fileName: unknown) {
  return cleanTitlePart(String(fileName ?? "").split(/[\\/]/).pop() ?? "", "");
}

function documentTitleFor(docType: string, baseTitle: string) {
  const prefix = DOC_TITLE_PREFIX[docType] ?? cleanTitlePart(docType, "文档");
  const focus = DOC_TITLE_FOCUS[docType] ?? "文档输出";
  return docType === "meeting-minutes"
    ? `${prefix}｜${baseTitle}｜${focus}｜待确认`
    : `${prefix}｜${baseTitle}｜${focus}`;
}

function promptRegistry() {
  return JSON.parse(readFileSync(promptRegistryPath, "utf8")) as { documents: PromptRecord[] };
}

function promptRecordFor(docType: string) {
  const normalized = String(docType ?? "").trim().toLowerCase();
  return promptRegistry().documents.find((record) =>
    record.docType === normalized ||
    record.promptFile === normalized ||
    record.aliases?.some((alias) => alias.toLowerCase() === normalized),
  );
}

function tokenize(value: unknown) {
  const text = String(value ?? "").toLowerCase();
  const words = text.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  const chars = [...text.matchAll(/\p{Script=Han}/gu)].map((match) => match[0]);
  return new Set([...words, ...chars]);
}

function splitParagraphs(text: string) {
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function segmentText(record: SourceRecord, text: string) {
  const clean = normalizeText(text);
  if (!clean) return [] as SourceSegment[];
  const paragraphs = splitParagraphs(clean);
  const chunks: Array<{ text: string; heading: string | null; charStart: number; charEnd: number }> = [];
  let current = "";
  let heading: string | null = null;
  let charStart = 0;
  let cursor = 0;
  for (const paragraph of paragraphs.length ? paragraphs : [clean]) {
    const paragraphStart = clean.indexOf(paragraph, cursor);
    const start = paragraphStart >= 0 ? paragraphStart : cursor;
    const isHeading = /^(#{1,6}\s+|第[一二三四五六七八九十\d]+[章节部分]|[一二三四五六七八九十\d]+[.、]\s*)/.test(paragraph);
    if (isHeading) heading = paragraph.replace(/^#{1,6}\s+/, "").slice(0, 120);
    if (!current) charStart = start;
    if ((current + "\n\n" + paragraph).length > SEGMENT_TARGET_CHARS && current) {
      const segmentTextValue = current.slice(0, SEGMENT_MAX_CHARS);
      chunks.push({ text: segmentTextValue, heading, charStart, charEnd: charStart + segmentTextValue.length });
      const overlap = segmentTextValue.slice(-SEGMENT_OVERLAP_CHARS);
      current = overlap ? `${overlap}\n\n${paragraph}` : paragraph;
      charStart = Math.max(0, start - overlap.length);
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
    cursor = start + paragraph.length;
  }
  if (current) {
    const segmentTextValue = current.slice(0, SEGMENT_MAX_CHARS);
    chunks.push({ text: segmentTextValue, heading, charStart, charEnd: charStart + segmentTextValue.length });
  }
  return chunks.map((chunk, index) => ({
    segmentId: `${record.sourceId}:seg-${String(index + 1).padStart(4, "0")}`,
    sourceId: record.sourceId,
    sourceType: record.sourceType,
    title: record.title,
    text: chunk.text,
    segmentKind: /^\s*\|.+\|\s*\n\s*\|[\s:-]+\|/m.test(chunk.text) ? "table" : "text",
    charStart: chunk.charStart,
    charEnd: chunk.charEnd,
    heading: chunk.heading,
    page: null,
    sheet: null,
    startSec: null,
    endSec: null,
    quality: record.extractionQuality,
    metadata: {
      sourceStatus: record.status,
      segmentKind: /^\s*\|.+\|\s*\n\s*\|[\s:-]+\|/m.test(chunk.text) ? "table" : "text",
      artifactPath: workspaceRelative(record.artifactPath),
      extractedTextPath: workspaceRelative(record.extractedTextPath),
    },
  }));
}

function parseMarkdownTable(markdown: string) {
  const rows = String(markdown ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map((line) => line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
  const dataRows = rows.filter((row) => !row.every((cell) => /^:?-{3,}:?$/.test(cell)));
  const columns = dataRows[0] ?? [];
  return {
    columns: columns.slice(0, 12),
    rowCount: Math.max(0, dataRows.length - 1),
  };
}

function findSegmentForText(sourceId: string, segments: SourceSegment[], value: unknown) {
  const needle = normalizeText(value).slice(0, 160);
  const sourceSegments = segments.filter((segment) => segment.sourceId === sourceId);
  if (!needle) return sourceSegments[0]?.segmentId ?? null;
  return sourceSegments.find((segment) => segment.text.includes(needle))?.segmentId ?? sourceSegments[0]?.segmentId ?? null;
}

function extractHeadingBlocks(record: SourceRecord, text: string, segments: SourceSegment[], startIndex: number) {
  const blocks: SourceBlock[] = [];
  const headingPath: string[] = [];
  for (const match of normalizeText(text).matchAll(/^(#{1,6})\s+(.+?)\s*$/gm)) {
    const level = match[1].length;
    const heading = cleanTitlePart(match[2], "");
    if (!heading) continue;
    headingPath.splice(level - 1);
    headingPath[level - 1] = heading;
    blocks.push({
      blockId: `${record.sourceId}:block-${String(startIndex + blocks.length + 1).padStart(4, "0")}`,
      segmentId: findSegmentForText(record.sourceId, segments, match[0]),
      sourceId: record.sourceId,
      blockType: "heading",
      sourceFormat: "plain_text",
      headingPath: headingPath.filter(Boolean),
      quality: "ready",
      textPreview: heading,
      metadata: { level },
    });
  }
  return blocks;
}

function extractHtmlTableBlocks(record: SourceRecord, rawText: string, segments: SourceSegment[], startIndex: number) {
  const blocks: SourceBlock[] = [];
  for (const match of String(rawText ?? "").matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    const markdownPreview = htmlTableToMarkdown(match[0]);
    const parsed = parseMarkdownTable(markdownPreview);
    blocks.push({
      blockId: `${record.sourceId}:block-${String(startIndex + blocks.length + 1).padStart(4, "0")}`,
      segmentId: findSegmentForText(record.sourceId, segments, markdownPreview),
      sourceId: record.sourceId,
      blockType: "table",
      sourceFormat: "html_table",
      columns: parsed.columns,
      rowCount: parsed.rowCount,
      markdownPreview: markdownPreview.slice(0, 1200),
      quality: parsed.columns.length > 0 ? "ready" : "needs_fix",
      metadata: {
        rawHtmlTableDetected: true,
        rawHtmlSuppressed: true,
      },
    });
  }
  return blocks;
}

function extractMarkdownTableBlocks(record: SourceRecord, rawText: string, segments: SourceSegment[], startIndex: number) {
  const withoutHtmlTables = String(rawText ?? "").replace(/<table\b[\s\S]*?<\/table>/gi, "\n");
  const normalized = normalizeText(withoutHtmlTables);
  const blocks: SourceBlock[] = [];
  const tablePattern = /((?:^\s*\|.*\|\s*$\n?){2,})/gm;
  for (const match of normalized.matchAll(tablePattern)) {
    const markdown = match[1].trim();
    if (!/^\s*\|.+\|\s*\n\s*\|[\s:-]+\|/m.test(markdown)) continue;
    const parsed = parseMarkdownTable(markdown);
    blocks.push({
      blockId: `${record.sourceId}:block-${String(startIndex + blocks.length + 1).padStart(4, "0")}`,
      segmentId: findSegmentForText(record.sourceId, segments, markdown),
      sourceId: record.sourceId,
      blockType: "table",
      sourceFormat: "markdown_table",
      columns: parsed.columns,
      rowCount: parsed.rowCount,
      markdownPreview: markdown.slice(0, 1200),
      quality: parsed.columns.length > 0 ? "ready" : "needs_fix",
    });
  }
  return blocks;
}

function extractCommentAnchorBlocks(reviewContext: any, segments: SourceSegment[], startIndex: number) {
  const comments = Array.isArray(reviewContext?.comments) ? reviewContext.comments : [];
  return comments.slice(0, 200).map((comment: any, index: number): SourceBlock => {
    const preview = normalizeText(comment.bodyAnchorPreview ?? comment.anchorPreview ?? comment.quote ?? comment.commentText ?? "").slice(0, 360);
    return {
      blockId: `review-01:block-${String(startIndex + index + 1).padStart(4, "0")}`,
      segmentId: segments.find((segment) => segment.sourceId === "review-01" && segment.metadata?.commentId === comment.commentId)?.segmentId ?? null,
      sourceId: "review-01",
      blockType: "comment_anchor",
      sourceFormat: "plain_text",
      quality: String(comment.matchStatus ?? "").includes("unmatched") ? "needs_fix" : "ready",
      textPreview: preview,
      metadata: {
        commentId: comment.commentId ?? null,
        matchStatus: comment.matchStatus ?? null,
        matchReason: comment.matchReason ?? null,
      },
    };
  });
}

function buildSourceStructure(records: SourceRecord[], segments: SourceSegment[], rawTextBySourceId: Map<string, string>, reviewContext: any): SourceStructure {
  const headings: SourceBlock[] = [];
  const tables: SourceBlock[] = [];
  for (const record of records) {
    const rawText = rawTextBySourceId.get(record.sourceId) ?? "";
    if (!rawText) continue;
    const headingBlocks = extractHeadingBlocks(record, rawText, segments, headings.length + tables.length);
    headings.push(...headingBlocks);
    const htmlBlocks = extractHtmlTableBlocks(record, rawText, segments, headings.length + tables.length);
    tables.push(...htmlBlocks);
    const markdownBlocks = extractMarkdownTableBlocks(record, rawText, segments, headings.length + tables.length);
    tables.push(...markdownBlocks);
  }
  const commentAnchors = extractCommentAnchorBlocks(reviewContext, segments, headings.length + tables.length);
  return {
    schemaVersion: `${SOURCE_CONTEXT_VERSION}/source-structure`,
    generatedAt: nowIso(),
    headings,
    tables,
    commentAnchors,
    blockCount: headings.length + tables.length + commentAnchors.length,
    tableBlockCount: tables.length,
    rawHtmlTableCount: tables.filter((block) => block.sourceFormat === "html_table").length,
    markdownTableCount: tables.filter((block) => block.sourceFormat === "markdown_table").length,
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  };
}

function sourceBlocksForSegments(structure: SourceStructure, selected: SourceSegment[]) {
  const segmentIds = new Set(selected.map((segment) => segment.segmentId));
  return [...structure.headings, ...structure.tables, ...structure.commentAnchors]
    .filter((block) => block.segmentId && segmentIds.has(block.segmentId))
    .slice(0, 24);
}

function buildOutputContract(): OutputContract {
  return {
    schemaVersion: "document-output-contract-v1",
    outputContractVersion: "document-output-contract-v1",
    titlePolicy: {
      forbidGenericUploadName: true,
      requireIdentityBasis: true,
    },
    markdownPolicy: {
      forbidHtmlTableTags: true,
      tablesMustBeMarkdownOrBullets: true,
    },
    publishBlockingRules: [
      "bad_document_title",
      "document_identity_missing",
      "raw_html_table_in_markdown",
      "table_source_unreadable_in_output",
    ],
  };
}

function buildDocumentIdentity(params: {
  requestedDocuments: string[];
  taskPrompt: string;
  sourceRecords: SourceRecord[];
  sourceSegments: SourceSegment[];
  sourceStructure: SourceStructure;
  reviewContext: any;
}): DocumentIdentity {
  const warnings: string[] = [];
  const sourceHeading = params.sourceStructure.headings
    .map((block) => String(block.textPreview ?? ""))
    .find((heading) => heading && !looksLikeGenericUploadName(heading));
  const sourceTitle = sourceHeading ? String(sourceHeading) : null;
  const sourceProject = projectTitleFromDocumentTitle(sourceHeading);
  const reviewTitle = params.reviewContext?.sourceDocuments
    ?.map((source: any) => source.title ?? source.fileName)
    ?.map((title: unknown) => projectTitleFromDocumentTitle(title) || stripExtensionForTitle(title))
    ?.find((title: string) => title && !looksLikeGenericUploadName(title)) ?? "";
  const promptProject = inferProjectTitleFromPrompt(params.taskPrompt);
  const dominantHeading = params.sourceStructure.headings
    .map((block) => projectTitleFromDocumentTitle(block.textPreview) || cleanTitlePart(block.textPreview, ""))
    .find((title) => title && !looksLikeGenericUploadName(title)) ?? "";
  const dominantSubject = inferDominantSubjectFromSegments(params.sourceSegments);
  let baseTitle = sourceProject || reviewTitle || promptProject || dominantHeading || dominantSubject;
  const basis: string[] = [];
  if (sourceProject) basis.push("source_h1");
  else if (reviewTitle) basis.push("review_context");
  else if (promptProject) basis.push("user_request");
  else if (dominantHeading) basis.push("dominant_heading");
  else if (dominantSubject) basis.push("audio_transcript_dominant_terms");
  if (!baseTitle || looksLikeGenericUploadName(baseTitle)) {
    baseTitle = "待确认项目";
    basis.push("low_confidence_fallback");
    warnings.push("document_identity_low_confidence");
  }
  const confidence: DocumentIdentity["confidence"] = basis.includes("source_h1") || basis.includes("review_context")
    ? "high"
    : basis.includes("user_request") || basis.includes("dominant_heading") || basis.includes("audio_transcript_dominant_terms")
      ? "medium"
      : "low";
  const titleByDocType: DocumentIdentity["titleByDocType"] = {};
  for (const docType of params.requestedDocuments) {
    const title = documentTitleFor(docType, baseTitle);
    titleByDocType[docType] = {
      title,
      feishuFileName: safeFileName(title),
      identityBasis: basis,
      identityConfidence: confidence,
    };
  }
  return {
    projectName: baseTitle,
    subject: baseTitle,
    sourceTitle,
    normalizedTitleBase: baseTitle,
    confidence,
    basis,
    warnings,
    titleByDocType,
  };
}

function sourceRecordsFromFileContexts(fileContexts: any) {
  const contexts = Array.isArray(fileContexts?.contexts) ? fileContexts.contexts : [];
  return contexts.map((context: any, index: number): SourceRecord => {
    const sourceId = `file-${String(index + 1).padStart(2, "0")}`;
    const extractionStatus = String(context.extraction?.status ?? context.status ?? "unknown");
    const chars = Number(context.extraction?.chars ?? 0);
    return {
      sourceId,
      sourceType: String(context.fileType ?? "file"),
      title: String(context.fileName ?? context.sourcePath ?? sourceId),
      artifactPath: context.sourcePath ?? null,
      extractedTextPath: context.extractedTextPath ?? null,
      status: String(context.status ?? "ready"),
      extractionQuality: extractionStatus === "completed" && chars > 0 ? "ready" : chars > 0 ? "partial" : "missing",
      privacyClass: context.externalLlmAllowed === false ? "local_only" : "text_evidence_allowed",
      metadata: {
        extension: context.extension ?? null,
        contextMode: context.contextMode ?? null,
        sourcePath: workspaceRelative(context.sourcePath),
        extractedTextPath: workspaceRelative(context.extractedTextPath),
        extraction: context.extraction ?? null,
      },
    };
  });
}

function audioRecordsAndSegments(params: any) {
  const transcript = readJson(params.transcriptPath);
  const evidence = readJson(params.evidenceIndexPath);
  const summary = readJson(params.asrSummaryPath) ?? {};
  const sourceRows = Array.isArray(evidence?.sources) ? evidence.sources : [];
  const records: SourceRecord[] = sourceRows.map((source: any, index: number) => ({
    sourceId: `audio-${String(index + 1).padStart(2, "0")}`,
    sourceType: "audio_transcript",
    title: String(source.basename ?? source.fileName ?? `audio-${index + 1}`),
    artifactPath: params.transcriptPath ?? null,
    extractedTextPath: params.transcriptPath ?? null,
    status: "ready",
    extractionQuality: Number(summary.failedChunks ?? 0) > 0 ? "partial" : "ready",
    privacyClass: "transcript_text_allowed_raw_media_local_only",
    metadata: {
      durationSec: source.durationSec ?? null,
      chunkCount: source.chunkCount ?? null,
      privacy: source.privacy ?? null,
      transcriptPath: workspaceRelative(params.transcriptPath),
      evidenceIndexPath: workspaceRelative(params.evidenceIndexPath),
    },
  }));
  const transcriptSegments = (transcript?.transcriptSegments ?? evidence?.transcriptSegments ?? [])
    .filter((segment: any) => String(segment?.text ?? "").trim())
    .slice(0, 1200);
  const segments: SourceSegment[] = transcriptSegments.map((segment: any, index: number) => {
    const sourceIndex = Number.isInteger(segment.sourceIndex) ? segment.sourceIndex : 0;
    const sourceId = records[sourceIndex]?.sourceId ?? records[0]?.sourceId ?? "audio-01";
    const title = records.find((record) => record.sourceId === sourceId)?.title ?? sourceId;
    return {
      segmentId: `${sourceId}:chunk-${String(segment.chunkIndex ?? index).padStart(4, "0")}`,
      sourceId,
      sourceType: "audio_transcript",
      title,
      text: normalizeText(segment.text).slice(0, SEGMENT_MAX_CHARS),
      charStart: null,
      charEnd: null,
      heading: null,
      page: null,
      sheet: null,
      startSec: Number(segment.startSec ?? 0),
      endSec: Number(segment.endSec ?? 0),
      quality: "ready",
      metadata: {
        chunkIndex: segment.chunkIndex ?? index,
        sourceFile: segment.sourceFile ?? null,
        sourceHashSha256: segment.sourceHashSha256 ?? null,
        model: segment.model ?? null,
      },
    };
  });
  return { records, segments, audioSegmentCount: transcriptSegments.length };
}

function reviewRecordsAndSegments(reviewContext: any) {
  if (!reviewContext || typeof reviewContext !== "object") return { records: [] as SourceRecord[], segments: [] as SourceSegment[] };
  const comments = Array.isArray(reviewContext.comments) ? reviewContext.comments : [];
  const record: SourceRecord = {
    sourceId: "review-01",
    sourceType: "review_context",
    title: "Feishu review comments",
    artifactPath: null,
    extractedTextPath: null,
    status: String(reviewContext.status ?? "unknown"),
    extractionQuality: comments.length > 0 ? "ready" : "missing",
    privacyClass: "text_evidence_allowed",
    metadata: {
      operation: reviewContext.operation ?? null,
      commentAccess: reviewContext.commentAccess ?? null,
      matchSummary: reviewContext.matchSummary ?? null,
    },
  };
  const segments = comments.map((comment: any, index: number): SourceSegment => {
    const text = normalizeText([
      comment.commentText ?? comment.quote ?? comment.anchorPreview ?? "",
      Array.isArray(comment.replies) && comment.replies.length ? `Replies: ${comment.replies.map((reply: any) => reply.text ?? reply.content ?? "").join(" / ")}` : "",
    ].filter(Boolean).join("\n"));
    return {
      segmentId: `review-01:comment-${String(index + 1).padStart(4, "0")}`,
      sourceId: "review-01",
      sourceType: "review_context",
      title: `Comment ${comment.commentId ?? index + 1}`,
      text: text.slice(0, SEGMENT_MAX_CHARS),
      charStart: null,
      charEnd: null,
      heading: null,
      page: null,
      sheet: null,
      startSec: null,
      endSec: null,
      quality: comment.matchStatus ?? "comment",
      metadata: {
        commentId: comment.commentId ?? null,
        sourceId: comment.sourceId ?? null,
        matchStatus: comment.matchStatus ?? null,
        matchReason: comment.matchReason ?? null,
      },
    };
  }).filter((segment: SourceSegment) => segment.text);
  return { records: [record], segments };
}

function scoreSegment(segment: SourceSegment, terms: Set<string>, sectionText = "") {
  const haystack = tokenize(`${segment.title}\n${segment.heading ?? ""}\n${segment.text}`);
  let score = 0;
  for (const term of terms) {
    if (haystack.has(term)) score += term.length > 1 ? 3 : 1;
    else if (term.length > 2 && segment.text.toLowerCase().includes(term)) score += 1;
  }
  if (segment.sourceType === "review_context") score += 6;
  if (segment.segmentKind === "table") score += /范围|MVP|暂不做|功能需求|验收|需求确认|checklist|表格|清单/i.test(sectionText) ? 8 : 3;
  if (segment.heading) score += 1;
  return score;
}

function selectSegmentsForWorkUnit(segments: SourceSegment[], taskPrompt: string, docType: string, sections: string[], operation?: string) {
  const terms = tokenize([taskPrompt, docType, sections.join(" "), operation ?? ""].join("\n"));
  const sectionText = [docType, sections.join(" ")].join(" ");
  const ranked = segments.map((segment) => ({
    segment,
    score: scoreSegment(segment, terms, sectionText),
  })).sort((a, b) => b.score - a.score || a.segment.segmentId.localeCompare(b.segment.segmentId));
  const selected: SourceSegment[] = [];
  let evidenceChars = 0;
  for (const item of ranked) {
    if (selected.length >= MAX_SEGMENTS_PER_PACK) break;
    if (item.score <= 0 && selected.length >= Math.min(4, ranked.length)) continue;
    const nextChars = item.segment.text.length;
    if (evidenceChars + nextChars > DEFAULT_EVIDENCE_HARD_CAP_CHARS && selected.length > 0) continue;
    selected.push(item.segment);
    evidenceChars += nextChars;
  }
  if (selected.length === 0) {
    for (const item of ranked.slice(0, Math.min(4, ranked.length))) selected.push(item.segment);
  }
  return {
    selected,
    retrievalReasons: selected.map((segment) =>
      segment.sourceType === "review_context"
        ? `review_comment:${segment.segmentId}`
        : `deterministic_keyword_or_fallback:${segment.segmentId}`,
    ),
  };
}

function buildModelContext(params: {
  packId: string;
  workUnitId: string;
  docType: string;
  sections: string[];
  taskPrompt: string;
  selectedSegments: SourceSegment[];
  selectedSourceBlocks?: SourceBlock[];
  documentIdentity?: DocumentIdentity;
  outputContract?: OutputContract;
  retrievalReasons: string[];
  operation?: string;
}) {
  const evidenceBlocks: string[] = [];
  let budget = DEFAULT_EVIDENCE_HARD_CAP_CHARS;
  for (const segment of params.selectedSegments) {
    const header = [
      `### ${segment.segmentId}`,
      `source=${segment.sourceId}`,
      `type=${segment.sourceType}`,
      segment.segmentKind ? `kind=${segment.segmentKind}` : null,
      segment.heading ? `heading=${segment.heading}` : null,
      Number.isFinite(segment.startSec ?? NaN) ? `time=${segment.startSec}-${segment.endSec}` : null,
    ].filter(Boolean).join(" | ");
    const text = segment.text.slice(0, Math.max(0, budget - header.length - 8));
    if (!text) continue;
    evidenceBlocks.push(`${header}\n${text}`);
    budget -= header.length + text.length + 8;
    if (budget <= 0) break;
  }
  const sourceBlockSummary = (params.selectedSourceBlocks ?? []).map((block) => ({
    blockId: block.blockId,
    segmentId: block.segmentId,
    blockType: block.blockType,
    sourceFormat: block.sourceFormat,
    columns: block.columns ?? [],
    rowCount: block.rowCount ?? null,
    markdownPreview: block.markdownPreview ?? block.textPreview ?? "",
    quality: block.quality,
  }));
  return [
    "## Runtime Context Pack",
    "",
    `contextPackId: ${params.packId}`,
    `workUnitId: ${params.workUnitId}`,
    `operation: ${params.operation ?? "create_document"}`,
    `docType: ${params.docType}`,
    `targetSections: ${params.sections.join(" | ")}`,
    `promptBudgetChars: ${DEFAULT_SECTION_PROMPT_HARD_CAP_CHARS}`,
    `evidenceBudgetChars: ${DEFAULT_EVIDENCE_HARD_CAP_CHARS}`,
    `documentIdentityConfidence: ${params.documentIdentity?.confidence ?? "unknown"}`,
    `outputContractVersion: ${params.outputContract?.outputContractVersion ?? "document-output-contract-v1"}`,
    "",
    "## User Request",
    "",
    params.taskPrompt || "请根据上下文生成文档章节。",
    "",
    "## Selected Source Evidence",
    "",
    evidenceBlocks.join("\n\n") || "No selected evidence segment is available.",
    "",
    "## Selected Source Structure Blocks",
    "",
    sourceBlockSummary.length
      ? JSON.stringify(sourceBlockSummary, null, 2)
      : "No selected source structure block is available.",
    "",
    "## Document Identity And Output Contract",
    "",
    JSON.stringify({
      documentIdentity: params.documentIdentity
        ? {
            projectName: params.documentIdentity.projectName,
            subject: params.documentIdentity.subject,
            sourceTitle: params.documentIdentity.sourceTitle,
            normalizedTitleBase: params.documentIdentity.normalizedTitleBase,
            confidence: params.documentIdentity.confidence,
            basis: params.documentIdentity.basis,
            warnings: params.documentIdentity.warnings,
            title: params.documentIdentity.titleByDocType[params.docType]?.title ?? null,
          }
        : null,
      outputContract: params.outputContract ?? buildOutputContract(),
    }, null, 2),
    "",
    "## Retrieval Reasons",
    "",
    params.retrievalReasons.map((reason) => `- ${reason}`).join("\n") || "- fallback",
  ].join("\n");
}

function chunkSections(sections: string[], size: number) {
  const chunks: string[][] = [];
  for (let index = 0; index < sections.length; index += size) {
    chunks.push(sections.slice(index, index + size));
  }
  return chunks.length ? chunks : [[]];
}

function buildContextPlane(params: any) {
  const runId = String(params.runId ?? "run");
  const outputRoot = params.outputRoot ? String(params.outputRoot) : undefined;
  const dir = sourceContextDir(runId, outputRoot);
  const packsDir = join(dir, "context-packs");
  mkdirSync(packsDir, { recursive: true });

  const taskPrompt = normalizeText(params.taskPrompt ?? params.userPrompt ?? "");
  const requestedDocuments = Array.isArray(params.requestedDocuments) && params.requestedDocuments.length > 0
    ? params.requestedDocuments.map(String)
    : ["meeting-minutes"];
  const sourcePreparation = params.sourcePreparation ?? {};
  const operation = params.operation ?? (params.revisionMode ? "document_revision" : "create_document");
  const sectionsPerUnit = Math.max(1, Math.min(Number(params.sectionsPerUnit ?? params.sectionsPerBatch ?? 2) || 2, 6));

  const fileRecords = sourceRecordsFromFileContexts(params.fileContexts);
  const rawTextBySourceId = new Map<string, string>();
  const fileSegments = fileRecords.flatMap((record) => {
    const rawText = readRawTextBounded(record.extractedTextPath);
    rawTextBySourceId.set(record.sourceId, rawText);
    return segmentText(record, rawText);
  });
  const audio = audioRecordsAndSegments(params);
  const review = reviewRecordsAndSegments(params.reviewContext);
  const requestRecord: SourceRecord | null = taskPrompt
    ? {
        sourceId: "request-01",
        sourceType: "user_request",
        title: "User request",
        artifactPath: null,
        extractedTextPath: null,
        status: "ready",
        extractionQuality: "ready",
        privacyClass: "text_evidence_allowed",
        metadata: { source: "taskPrompt" },
      }
    : null;
  if (requestRecord) rawTextBySourceId.set(requestRecord.sourceId, taskPrompt);
  const requestSegments = requestRecord ? segmentText(requestRecord, taskPrompt) : [];
  const sourceRecords = [...(requestRecord ? [requestRecord] : []), ...fileRecords, ...audio.records, ...review.records];
  const sourceSegments = [...requestSegments, ...fileSegments, ...audio.segments, ...review.segments];
  const sourceStructure = buildSourceStructure(sourceRecords, sourceSegments, rawTextBySourceId, params.reviewContext);
  const documentIdentity = buildDocumentIdentity({
    requestedDocuments,
    taskPrompt,
    sourceRecords,
    sourceSegments,
    sourceStructure,
    reviewContext: params.reviewContext,
  });
  const outputContract = buildOutputContract();

  const sourceRecordsPath = join(dir, "source-records.json");
  const sourceSegmentsPath = join(dir, "source-segments.jsonl");
  const sourceStructurePath = join(dir, "source-structure.json");
  writeJson(sourceRecordsPath, {
    schemaVersion: `${SOURCE_CONTEXT_VERSION}/source-records`,
    generatedAt: nowIso(),
    sourceCount: sourceRecords.length,
    sources: sourceRecords.map((record) => ({
      ...record,
      artifactPath: workspaceRelative(record.artifactPath),
      extractedTextPath: workspaceRelative(record.extractedTextPath),
    })),
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  });
  writeJsonl(sourceSegmentsPath, sourceSegments.map((segment) => ({
    ...segment,
    textChars: segment.text.length,
    textPreview: segment.text.slice(0, 240),
    text: segment.text,
    rawSecretsReturned: false,
  })));
  writeJson(sourceStructurePath, sourceStructure);

  const workUnits: WorkUnit[] = [];
  const retrievalPlan: any[] = [];
  for (const docType of requestedDocuments) {
    const record = promptRecordFor(docType);
    const requiredSections = record?.requiredSections?.length ? record.requiredSections : ["正文"];
    for (const [unitIndex, sections] of chunkSections(requiredSections, sectionsPerUnit).entries()) {
      const workUnitId = safeSegment(`${docType}-unit-${String(unitIndex + 1).padStart(2, "0")}-${sha256(sections.join("|")).slice(0, 8)}`);
      const { selected, retrievalReasons } = selectSegmentsForWorkUnit(sourceSegments, taskPrompt, docType, sections, operation);
      const selectedSourceBlocks = sourceBlocksForSegments(sourceStructure, selected);
      const contextPackId = `${workUnitId}-${sha256(selected.map((segment) => segment.segmentId).join("|")).slice(0, 10)}`;
      const modelContext = buildModelContext({
        packId: contextPackId,
        workUnitId,
        docType,
        sections,
        taskPrompt,
        selectedSegments: selected,
        selectedSourceBlocks,
        documentIdentity,
        outputContract,
        retrievalReasons,
        operation,
      });
      const contextPack = {
        schemaVersion: "context-pack-v1",
        generatedAt: nowIso(),
        contextPackId,
        workUnitId,
        docType,
        sections,
        operation,
        promptBudgetChars: DEFAULT_SECTION_PROMPT_HARD_CAP_CHARS,
        evidenceBudgetChars: DEFAULT_EVIDENCE_HARD_CAP_CHARS,
        rulesBudgetChars: DEFAULT_CONTEXT_RULES_BUDGET_CHARS,
        sourceSegmentIds: selected.map((segment) => segment.segmentId),
        sourceBlockIds: selectedSourceBlocks.map((block) => block.blockId),
        tableBlockCount: selectedSourceBlocks.filter((block) => block.blockType === "table").length,
        retrievalReasons,
        documentIdentity: {
          projectName: documentIdentity.projectName,
          subject: documentIdentity.subject,
          sourceTitle: documentIdentity.sourceTitle,
          normalizedTitleBase: documentIdentity.normalizedTitleBase,
          confidence: documentIdentity.confidence,
          basis: documentIdentity.basis,
          warnings: documentIdentity.warnings,
          title: documentIdentity.titleByDocType[docType]?.title ?? null,
        },
        outputContract,
        selectedSegments: selected.map((segment) => ({
          segmentId: segment.segmentId,
          sourceId: segment.sourceId,
          sourceType: segment.sourceType,
          title: segment.title,
          segmentKind: segment.segmentKind ?? "text",
          heading: segment.heading ?? null,
          startSec: segment.startSec ?? null,
          endSec: segment.endSec ?? null,
          text: segment.text,
          textChars: segment.text.length,
          quality: segment.quality,
        })),
        selectedSourceBlocks: selectedSourceBlocks.map((block) => ({
          blockId: block.blockId,
          segmentId: block.segmentId,
          sourceId: block.sourceId,
          blockType: block.blockType,
          sourceFormat: block.sourceFormat,
          headingPath: block.headingPath ?? [],
          columns: block.columns ?? [],
          rowCount: block.rowCount ?? null,
          markdownPreview: block.markdownPreview ?? null,
          quality: block.quality,
        })),
        modelContext,
        rawSecretsReturned: false,
        rawMediaExternalUpload: false,
      };
      const contextPackRef = join(packsDir, `${workUnitId}.json`);
      writeJson(contextPackRef, contextPack);
      const contextPackHash = sha256(contextPack);
      workUnits.push({
        workUnitId,
        docType,
        sections,
        contextPackRef,
        contextPackId,
        contextPackHash,
        sourceSegmentIds: contextPack.sourceSegmentIds,
        sourceBlockIds: contextPack.sourceBlockIds,
        tableBlockCount: contextPack.tableBlockCount,
        promptBudgetChars: contextPack.promptBudgetChars,
        evidenceBudgetChars: contextPack.evidenceBudgetChars,
        retrievalReasons,
        outputContractVersion: outputContract.outputContractVersion,
        documentIdentityConfidence: documentIdentity.confidence,
      });
      retrievalPlan.push({
        workUnitId,
        docType,
        sections,
        contextPackRef: workspaceRelative(contextPackRef),
        contextPackId,
        sourceSegmentIds: contextPack.sourceSegmentIds,
        sourceBlockIds: contextPack.sourceBlockIds,
        tableBlockCount: contextPack.tableBlockCount,
        retrievalReasons,
      });
    }
  }

  const retrievalPlanPath = join(dir, "retrieval-plan.json");
  writeJson(retrievalPlanPath, {
    schemaVersion: `${SOURCE_CONTEXT_VERSION}/retrieval-plan`,
    generatedAt: nowIso(),
    strategy: "deterministic_section_retrieval",
    vectorStoreUsed: false,
    ftsUsed: false,
    requestedDocuments,
    workUnits: retrievalPlan,
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  });

  const gate = buildGate({
    sourceRecords,
    sourceSegments,
    workUnits,
    operation,
    reviewContext: params.reviewContext,
  });
  const gatePath = join(dir, "context-gate.json");
  writeJson(gatePath, gate);
  const manifestPath = join(dir, "context-manifest.json");
  const manifest = {
    schemaVersion: `${SOURCE_CONTEXT_VERSION}/context-manifest`,
    generatedAt: nowIso(),
    contextPlane: "runtime-context-plane-v1",
    runId,
    operation,
    requestedDocuments,
    sourceRecordsPath,
    sourceSegmentsPath,
    sourceStructurePath,
    retrievalPlanPath,
    gatePath,
    sourceCount: sourceRecords.length,
    segmentCount: sourceSegments.length,
    sourceStructureSummary: {
      blockCount: sourceStructure.blockCount,
      headingCount: sourceStructure.headings.length,
      tableBlockCount: sourceStructure.tableBlockCount,
      rawHtmlTableCount: sourceStructure.rawHtmlTableCount,
      markdownTableCount: sourceStructure.markdownTableCount,
      commentAnchorCount: sourceStructure.commentAnchors.length,
    },
    documentIdentity,
    outputContract,
    workUnitCount: workUnits.length,
    contextPackCount: workUnits.length,
    sourceSetMode: sourcePreparation.sourceSetMode ?? "consolidated",
    conflictPolicy: sourcePreparation.conflictPolicy ?? "source_attribution",
    budgetPolicy: {
      sectionPromptHardCapChars: DEFAULT_SECTION_PROMPT_HARD_CAP_CHARS,
      evidenceHardCapChars: DEFAULT_EVIDENCE_HARD_CAP_CHARS,
      segmentTargetChars: SEGMENT_TARGET_CHARS,
      segmentMaxChars: SEGMENT_MAX_CHARS,
      deterministicRetrieval: true,
      vectorStoreUsed: false,
    },
    workUnits,
    gate,
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
    fullRawContentIncluded: false,
  };
  writeJson(manifestPath, manifest);

  const contextBrief = [
    "## Runtime Context Plane",
    "",
    "Source content is segmented and selected through source-context-runtime. Do not request or recreate full raw source text.",
    "",
    `contextManifest: ${workspaceRelative(manifestPath)}`,
    `sourceRecords: ${workspaceRelative(sourceRecordsPath)}`,
    `sourceSegments: ${workspaceRelative(sourceSegmentsPath)}`,
    `sourceStructure: ${workspaceRelative(sourceStructurePath)}`,
    `retrievalPlan: ${workspaceRelative(retrievalPlanPath)}`,
    `sourceCount: ${sourceRecords.length}`,
    `segmentCount: ${sourceSegments.length}`,
    `workUnitCount: ${workUnits.length}`,
    `contextGateStatus: ${gate.status}`,
  ].join("\n");

  return {
    status: gate.status === "blocked" ? "blocked" : "completed",
    reason: gate.status === "blocked" ? gate.reason : "source_context_prepared",
    schemaVersion: SOURCE_CONTEXT_VERSION,
    manifestPath,
    sourceRecordsPath,
    sourceSegmentsPath,
    sourceStructurePath,
    retrievalPlanPath,
    gatePath,
    contextBrief,
    evidenceSummary: {
      schemaVersion: "office-evidence-summary-v2",
      sourceSetMode: manifest.sourceSetMode,
      conflictPolicy: manifest.conflictPolicy,
      sourceCount: sourceRecords.length,
      segmentCount: sourceSegments.length,
      audioSegmentCount: audio.audioSegmentCount,
      requestedDocuments,
      sourceSummary: sourceRecords.map((record) => ({
        sourceId: record.sourceId,
        type: record.sourceType,
        fileName: record.title,
        status: record.status,
        extractionQuality: record.extractionQuality,
        privacyClass: record.privacyClass,
      })),
      contextManifest: workspaceRelative(manifestPath),
      contextGate: gate,
      documentIdentity,
      sourceStructureSummary: manifest.sourceStructureSummary,
      outputContract,
      sourceMediaExternalUpload: false,
      textEvidenceExternalLlmDefault: "allow",
      fullRawContentIncluded: false,
    },
    workUnits,
    gate,
    documentIdentity,
    sourceStructureSummary: manifest.sourceStructureSummary,
    sourceStructurePath,
    outputContract,
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
    fullRawContentIncluded: false,
  };
}

function buildGate(params: {
  sourceRecords: SourceRecord[];
  sourceSegments: SourceSegment[];
  workUnits: WorkUnit[];
  operation?: string;
  reviewContext?: any;
}) {
  const warnings: string[] = [];
  const missingOrStaleInputs: string[] = [];
  if (params.sourceRecords.length === 0) {
    return {
      schemaVersion: "context-gate-result-v1",
      status: "blocked",
      reason: "source_context_no_sources",
      warnings,
      missingOrStaleInputs: ["source records"],
      rawSecretsReturned: false,
      rawMediaExternalUpload: false,
    };
  }
  if (params.sourceSegments.length === 0) {
    return {
      schemaVersion: "context-gate-result-v1",
      status: "blocked",
      reason: "source_context_no_segments",
      warnings,
      missingOrStaleInputs: ["source segments"],
      rawSecretsReturned: false,
      rawMediaExternalUpload: false,
    };
  }
  if (params.workUnits.length === 0) {
    return {
      schemaVersion: "context-gate-result-v1",
      status: "blocked",
      reason: "source_context_no_work_units",
      warnings,
      missingOrStaleInputs: ["work units"],
      rawSecretsReturned: false,
      rawMediaExternalUpload: false,
    };
  }
  for (const record of params.sourceRecords) {
    if (record.extractionQuality === "missing") warnings.push(`source_extraction_missing:${record.sourceId}`);
    if (record.privacyClass === "local_only") warnings.push(`source_local_only:${record.sourceId}`);
  }
  if (params.operation === "document_revision") {
    const comments = Array.isArray(params.reviewContext?.comments) ? params.reviewContext.comments : [];
    if (comments.length === 0) {
      return {
        schemaVersion: "context-gate-result-v1",
        status: "blocked",
        reason: "needs_review_context",
        warnings,
        missingOrStaleInputs: ["review comments"],
        rawSecretsReturned: false,
        rawMediaExternalUpload: false,
      };
    }
    const unmatched = comments.filter((comment: any) => String(comment.matchStatus ?? "").includes("unmatched")).length;
    if (unmatched >= comments.length) {
      return {
        schemaVersion: "context-gate-result-v1",
        status: "blocked",
        reason: "needs_review_context",
        warnings: [...warnings, `review_comment_unmapped:${unmatched}`],
        missingOrStaleInputs: ["mapped review comments"],
        rawSecretsReturned: false,
        rawMediaExternalUpload: false,
      };
    }
    if (unmatched > 0) warnings.push(`review_comment_unmapped:${unmatched}`);
  }
  return {
    schemaVersion: "context-gate-result-v1",
    status: missingOrStaleInputs.length > 0 ? "needs_fix" : "pass",
    reason: missingOrStaleInputs.length > 0 ? "source_context_has_missing_inputs" : "source_context_ready",
    warnings,
    missingOrStaleInputs,
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  };
}

function detailsFromError(error: unknown) {
  return {
    status: "blocked",
    reason: error instanceof Error ? error.message : String(error),
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "source_context_prepare",
    label: "Source Context Prepare",
    description: "Build runtime context-plane source records, segments, retrieval plan, context packs, work units, and pre-generation gate.",
    parameters: Type.Object({
      runId: Type.String(),
      outputRoot: Type.Optional(Type.String()),
      taskPrompt: Type.Optional(Type.String()),
      requestedDocuments: Type.Optional(Type.Array(Type.String())),
      sourcePreparation: Type.Optional(Type.Any()),
      fileContexts: Type.Optional(Type.Any()),
      transcriptPath: Type.Optional(Type.String()),
      evidenceIndexPath: Type.Optional(Type.String()),
      asrSummaryPath: Type.Optional(Type.String()),
      reviewContext: Type.Optional(Type.Any()),
      operation: Type.Optional(Type.String()),
      sectionsPerUnit: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params) {
      try {
        const details = buildContextPlane(params);
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      } catch (error) {
        const details = detailsFromError(error);
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      }
    },
  });

  pi.registerTool({
    name: "source_context_segment",
    label: "Source Context Segment",
    description: "Segment one source text with the same structure-aware source context contract used by source_context_prepare.",
    parameters: Type.Object({
      sourceId: Type.String(),
      sourceType: Type.String(),
      title: Type.String(),
      text: Type.String(),
    }),
    async execute(_toolCallId, params) {
      const record: SourceRecord = {
        sourceId: params.sourceId,
        sourceType: params.sourceType,
        title: params.title,
        status: "ready",
        extractionQuality: "ready",
        privacyClass: "text_evidence_allowed",
        metadata: {},
      };
      const details = {
        schemaVersion: `${SOURCE_CONTEXT_VERSION}/source-segments`,
        segments: segmentText(record, params.text),
        rawSecretsReturned: false,
        rawMediaExternalUpload: false,
      };
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });

  pi.registerTool({
    name: "source_context_plan_retrieval",
    label: "Source Context Retrieval Plan",
    description: "Plan deterministic section-scoped retrieval over source segments without a vector database.",
    parameters: Type.Object({
      taskPrompt: Type.Optional(Type.String()),
      docType: Type.String(),
      sections: Type.Array(Type.String()),
      segments: Type.Array(Type.Any()),
      operation: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const { selected, retrievalReasons } = selectSegmentsForWorkUnit(params.segments as SourceSegment[], params.taskPrompt ?? "", params.docType, params.sections, params.operation);
      const details = {
        schemaVersion: `${SOURCE_CONTEXT_VERSION}/retrieval-plan`,
        strategy: "deterministic_section_retrieval",
        vectorStoreUsed: false,
        selectedSegmentIds: selected.map((segment) => segment.segmentId),
        retrievalReasons,
        rawSecretsReturned: false,
        rawMediaExternalUpload: false,
      };
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });

  pi.registerTool({
    name: "source_context_build_pack",
    label: "Source Context Build Pack",
    description: "Build a bounded model context pack for one work unit from selected source segments.",
    parameters: Type.Object({
      taskPrompt: Type.Optional(Type.String()),
      docType: Type.String(),
      sections: Type.Array(Type.String()),
      selectedSegments: Type.Array(Type.Any()),
      operation: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const workUnitId = safeSegment(`${params.docType}-${sha256(params.sections.join("|")).slice(0, 8)}`);
      const contextPackId = `${workUnitId}-${sha256(params.selectedSegments).slice(0, 10)}`;
      const retrievalReasons = (params.selectedSegments as SourceSegment[]).map((segment) => `manual_selected:${segment.segmentId}`);
      const details = {
        schemaVersion: "context-pack-v1",
        contextPackId,
        workUnitId,
        docType: params.docType,
        sections: params.sections,
        operation: params.operation ?? "create_document",
        promptBudgetChars: DEFAULT_SECTION_PROMPT_HARD_CAP_CHARS,
        evidenceBudgetChars: DEFAULT_EVIDENCE_HARD_CAP_CHARS,
        sourceSegmentIds: (params.selectedSegments as SourceSegment[]).map((segment) => segment.segmentId),
        retrievalReasons,
        modelContext: buildModelContext({
          packId: contextPackId,
          workUnitId,
          docType: params.docType,
          sections: params.sections,
          taskPrompt: params.taskPrompt ?? "",
          selectedSegments: params.selectedSegments as SourceSegment[],
          retrievalReasons,
          operation: params.operation,
        }),
        rawSecretsReturned: false,
        rawMediaExternalUpload: false,
      };
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });

  pi.registerTool({
    name: "source_context_gate",
    label: "Source Context Gate",
    description: "Evaluate source/context coverage before document generation starts.",
    parameters: Type.Object({
      manifestPath: Type.Optional(Type.String()),
      manifest: Type.Optional(Type.Any()),
    }),
    async execute(_toolCallId, params) {
      try {
        const manifest = params.manifest ?? readJson(params.manifestPath);
        const gate = manifest?.gate ?? {
          schemaVersion: "context-gate-result-v1",
          status: "blocked",
          reason: "source_context_manifest_required",
          warnings: [],
          missingOrStaleInputs: ["context manifest"],
          rawSecretsReturned: false,
          rawMediaExternalUpload: false,
        };
        return { content: [{ type: "text", text: JSON.stringify(gate, null, 2) }], details: gate };
      } catch (error) {
        const details = detailsFromError(error);
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      }
    },
  });
}
