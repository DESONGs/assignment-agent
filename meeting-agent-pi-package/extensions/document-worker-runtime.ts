import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateText } from "./model-provider.ts";
import { planRoute, recordRouteArtifact } from "./model-routing.ts";

type DocumentWorkItem = {
  docType: string;
  promptFile?: string;
  promptPath?: string;
  promptInstructions?: string;
  promptInstructionChars?: number;
  contextPlane?: {
    enabled?: boolean;
    contextEnvelopeRef?: string;
    workUnitCount?: number;
    promptMode?: string;
    fullContentAvailableByArtifact?: boolean;
  } | null;
  workUnits?: Array<{
    workUnitId: string;
    docType: string;
    sections: string[];
    contextPackRef: string;
    contextPackId?: string;
    contextPackHash?: string;
    sourceSegmentIds?: string[];
    sourceBlockIds?: string[];
    tableBlockCount?: number;
    promptBudgetChars?: number;
    evidenceBudgetChars?: number;
    retrievalReasons?: string[];
    outputContractVersion?: string;
    documentIdentityConfidence?: "high" | "medium" | "low";
  }>;
  upstreamDependencyContext?: unknown;
  requiredSections?: string[];
  dependsOn?: string[];
  audience?: string | null;
  upstreamDocumentsUsed?: string[];
  missingUpstreamDocuments?: string[];
  absentUpstreamDocuments?: string[];
};

type SectionBatch = {
  batchIndex: number;
  sections: string[];
};

const DEFAULT_MAX_WORKERS = 6;
const MAX_WORKERS = 6;
const MAX_DOCUMENT_WORK_ITEMS = 24;
const DEFAULT_SECTIONS_PER_BATCH = 3;
const MAX_SECTIONS_PER_BATCH = 6;
const DEFAULT_REPAIR_ATTEMPTS = 1;
const MAX_REPAIR_ATTEMPTS = 2;
const DEFAULT_MODEL_ATTEMPT_TIMEOUT_MS = 120_000;
const DEFAULT_DEADLINE_RESERVE_MS = 30_000;
const MIN_MODEL_ATTEMPT_TIMEOUT_MS = 1_000;
const DEFAULT_RETRY_ATTEMPTS_PER_UNIT = 3;
const DEFAULT_MAX_RETRY_UNITS = 12;
const MAX_RETRY_ATTEMPTS_PER_UNIT = 5;
const MAX_RETRY_UNITS = 36;
const OPEN_QUESTION_PATTERN = /待确认|确认|问题|阻塞|缺口|未定|未明确/;
const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(extensionDir);
const workspaceDir = dirname(packageDir);
const SYSTEM_PROMPT =
  "你是一个证据约束的中文办公文档写作 worker。你只根据当前 work unit 的 bounded context pack 和目标章节写作，不调用飞书，不修改日历/任务，不编造 owner/deadline/budget/外部事实。输出 Markdown。";
const MEETING_SYSTEM_PROMPT = [
  "你是会议理解与执行提炼 Agent，不是普通文档续写器。",
  "你必须使用 Meeting Intelligence、当前 work unit 的证据和 participant map，自主判断当前章节应突出哪些议题、分歧、共识、行动和开放问题。",
  "证据优先级为：用户明确事实；多模型一致且质量稳定的 ASR；主模型单独支持的 ASR；quality=needs_review 的冲突片段。",
  "冲突片段不得单独支持已决定事项、姓名、owner、日期、金额或承诺。speaker id 只是匿名聚类；未确认姓名一律使用参会人代号。",
  "严格区分提议、异议、讨论中判断、已达成共识、被否决方案和未决事项。会议没有形成共识时，不得替会议生成最终结论。",
  "输出中文 Markdown，只写当前目标章节。",
].join("");

function systemPromptForDocType(docType: string) {
  return docType === "meeting-minutes" ? MEETING_SYSTEM_PROMPT : SYSTEM_PROMPT;
}

function positiveInteger(value: unknown, fallback: number) {
  if (value === undefined || value === null) return fallback;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) return fallback;
  return Math.floor(numberValue);
}

function effectiveMaxWorkers(value: unknown) {
  return Math.min(Math.max(positiveInteger(value, DEFAULT_MAX_WORKERS), 1), MAX_WORKERS);
}

function effectiveSectionsPerBatch(value: unknown) {
  return Math.min(Math.max(positiveInteger(value, DEFAULT_SECTIONS_PER_BATCH), 1), MAX_SECTIONS_PER_BATCH);
}

function effectiveRepairAttempts(value: unknown) {
  return Math.min(Math.max(positiveInteger(value, DEFAULT_REPAIR_ATTEMPTS), 0), MAX_REPAIR_ATTEMPTS);
}

function optionalPositiveInteger(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) return undefined;
  return Math.floor(numberValue);
}

function boundedPositiveInteger(value: unknown, fallback: number, max: number) {
  return Math.min(positiveInteger(value, fallback), max);
}

function nowIso() {
  return new Date().toISOString();
}

type DeadlineContext = {
  startedAtMs: number;
  deadlineAtMs: number | null;
  deadlineAt: string | null;
  runtimeBudgetMs: number | null;
  deadlineReserveMs: number;
};

type RetryPolicy = {
  maxAttemptsPerUnit: number;
  maxRetryUnits: number;
};

type WorkflowContext = {
  runId?: string;
  root: string | null;
  checkpointPath: string | null;
  retryLedgerPath: string | null;
  qualityMode: "stable" | "balanced" | "fast";
  workflowStrategy: "checkpointed" | "single_pass";
  resumeFromCheckpoint: boolean;
  publishPartial: boolean;
  retryPolicy: RetryPolicy;
  checkpoint: any;
};

function deadlineContext(params: { deadlineAt?: unknown; runtimeBudgetMs?: unknown; deadlineReserveMs?: unknown }): DeadlineContext {
  const startedAtMs = Date.now();
  const runtimeBudgetMs = optionalPositiveInteger(params.runtimeBudgetMs) ?? null;
  const explicitDeadlineMs = typeof params.deadlineAt === "string" || typeof params.deadlineAt === "number"
    ? Date.parse(String(params.deadlineAt))
    : NaN;
  const deadlineAtMs = Number.isFinite(explicitDeadlineMs)
    ? explicitDeadlineMs
    : runtimeBudgetMs
      ? startedAtMs + runtimeBudgetMs
      : null;
  return {
    startedAtMs,
    deadlineAtMs,
    deadlineAt: deadlineAtMs ? new Date(deadlineAtMs).toISOString() : null,
    runtimeBudgetMs,
    deadlineReserveMs: optionalPositiveInteger(params.deadlineReserveMs) ?? DEFAULT_DEADLINE_RESERVE_MS,
  };
}

function deadlineSnapshot(deadline?: DeadlineContext | null) {
  if (!deadline?.deadlineAtMs) {
    return {
      deadlineAt: null,
      remainingMs: null,
      usableMs: null,
      deadlineReserveMs: deadline?.deadlineReserveMs ?? DEFAULT_DEADLINE_RESERVE_MS,
      exhausted: false,
    };
  }
  const remainingMs = deadline.deadlineAtMs - Date.now();
  const usableMs = remainingMs - deadline.deadlineReserveMs;
  return {
    deadlineAt: deadline.deadlineAt,
    remainingMs,
    usableMs,
    deadlineReserveMs: deadline.deadlineReserveMs,
    exhausted: usableMs <= 0,
  };
}

function modelAttemptTimeoutMs(configuredTimeoutMs: number | undefined, deadline?: DeadlineContext | null) {
  const baseTimeoutMs = optionalPositiveInteger(configuredTimeoutMs) ?? DEFAULT_MODEL_ATTEMPT_TIMEOUT_MS;
  const snapshot = deadlineSnapshot(deadline);
  if (snapshot.usableMs === null) return baseTimeoutMs;
  if (snapshot.usableMs < MIN_MODEL_ATTEMPT_TIMEOUT_MS) return null;
  return Math.max(MIN_MODEL_ATTEMPT_TIMEOUT_MS, Math.min(baseTimeoutMs, Math.floor(snapshot.usableMs)));
}

function attemptsPathFor(traceRoot?: string | null) {
  return traceRoot ? join(traceRoot, "attempts.ndjson") : null;
}

function deadlineBlockedResult(params: {
  item: DocumentWorkItem;
  taskIndex: number;
  requiredSections: string[];
  completedSections: string[];
  sectionAttempts: any[];
  repairAttempts: any[];
  markdownParts: string[];
  traceRoot: string | null;
  deadline?: DeadlineContext | null;
  stage: string;
}) {
  const markdown = mergeMarkdown(params.markdownParts);
  const missing = uniqueStrings(params.requiredSections).filter((section) => !params.completedSections.includes(section));
  return {
    taskIndex: params.taskIndex,
    docType: params.item.docType,
    promptFile: params.item.promptFile ?? null,
    promptPath: params.item.promptPath ?? null,
    status: "blocked",
    reason: "document_worker_deadline_exhausted",
    deadlineStage: params.stage,
    dependsOn: params.item.dependsOn ?? [],
    audience: params.item.audience ?? null,
    upstreamDocumentsUsed: params.item.upstreamDocumentsUsed ?? [],
    missingUpstreamDocuments: params.item.missingUpstreamDocuments ?? [],
    absentUpstreamDocuments: params.item.absentUpstreamDocuments ?? [],
    completedSections: params.completedSections,
    missingSections: missing,
    sectionAttempts: params.sectionAttempts,
    repairAttempts: params.repairAttempts,
    traceRoot: params.traceRoot,
    attemptsPath: attemptsPathFor(params.traceRoot),
    deadline: deadlineSnapshot(params.deadline),
    markdown,
    rawSecretsReturned: false,
  };
}

function normalizeDocumentWorkItems(value: unknown): DocumentWorkItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((item: any) => ({
    docType: String(item?.docType ?? "document"),
    promptFile: item?.promptFile,
    promptPath: item?.promptPath,
    promptInstructions: item?.promptInstructions ? String(item.promptInstructions) : undefined,
    promptInstructionChars: Number(item?.promptInstructionChars ?? 0) || undefined,
    contextPlane: item?.contextPlane ?? null,
    workUnits: Array.isArray(item?.workUnits) ? item.workUnits.map((unit: any) => ({
      workUnitId: String(unit?.workUnitId ?? ""),
      docType: String(unit?.docType ?? item?.docType ?? "document"),
      sections: Array.isArray(unit?.sections) ? unit.sections.map(String).filter(Boolean) : [],
      contextPackRef: String(unit?.contextPackRef ?? ""),
      contextPackId: unit?.contextPackId ? String(unit.contextPackId) : undefined,
      contextPackHash: unit?.contextPackHash ? String(unit.contextPackHash) : undefined,
      sourceSegmentIds: Array.isArray(unit?.sourceSegmentIds) ? unit.sourceSegmentIds.map(String).filter(Boolean) : [],
      promptBudgetChars: Number(unit?.promptBudgetChars ?? 0) || undefined,
      evidenceBudgetChars: Number(unit?.evidenceBudgetChars ?? 0) || undefined,
      retrievalReasons: Array.isArray(unit?.retrievalReasons) ? unit.retrievalReasons.map(String).filter(Boolean) : [],
    })).filter((unit: any) => unit.workUnitId && unit.contextPackRef) : [],
    upstreamDependencyContext: item?.upstreamDependencyContext ?? null,
    requiredSections: Array.isArray(item?.requiredSections) ? item.requiredSections.map(String).filter(Boolean) : [],
    dependsOn: Array.isArray(item?.dependsOn) ? item.dependsOn.map(String).filter(Boolean) : [],
    audience: item?.audience === undefined || item?.audience === null ? null : String(item.audience),
    upstreamDocumentsUsed: Array.isArray(item?.upstreamDocumentsUsed) ? item.upstreamDocumentsUsed.map(String).filter(Boolean) : [],
    missingUpstreamDocuments: Array.isArray(item?.missingUpstreamDocuments) ? item.missingUpstreamDocuments.map(String).filter(Boolean) : [],
    absentUpstreamDocuments: Array.isArray(item?.absentUpstreamDocuments) ? item.absentUpstreamDocuments.map(String).filter(Boolean) : [],
  }));
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function chunkSections(sections: string[], sectionsPerBatch: number): SectionBatch[] {
  const cleanSections = uniqueStrings(sections);
  const batches: SectionBatch[] = [];
  for (let index = 0; index < cleanSections.length; index += sectionsPerBatch) {
    batches.push({
      batchIndex: batches.length,
      sections: cleanSections.slice(index, index + sectionsPerBatch),
    });
  }
  return batches;
}

function missingSections(markdown: string, requiredSections: string[]) {
  return uniqueStrings(requiredSections).filter((section) => !markdown.includes(section));
}

function extractOpenQuestions(markdown: string) {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && OPEN_QUESTION_PATTERN.test(line))
    .slice(0, 24);
}

function trimMarkdown(markdown: string) {
  return markdown.trim().replace(/\n{3,}/g, "\n\n");
}

function safeSegment(value: unknown, fallback = "item") {
  const cleaned = String(value ?? fallback).replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 100);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : fallback;
}

function isInside(parent: string, child: string) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeWorkspacePath(path: string) {
  const resolved = resolve(path);
  if (!isInside(workspaceDir, resolved)) {
    throw new Error("document_worker_artifact_path_outside_workspace_blocked");
  }
  return resolved;
}

function runDirFor(runId?: string, outputRoot?: string) {
  if (!runId || !outputRoot) return null;
  const root = safeWorkspacePath(outputRoot);
  const dir = resolve(root, safeSegment(runId, "run"));
  if (!isInside(root, dir)) {
    throw new Error("document_worker_run_dir_outside_output_root_blocked");
  }
  return dir;
}

function traceRootFor(runId?: string, outputRoot?: string) {
  const runDir = runDirFor(runId, outputRoot);
  if (!runDir) return null;
  return join(runDir, "artifacts", "model-streams", "document_workers_run");
}

function workflowRootFor(runId?: string, outputRoot?: string) {
  const runDir = runDirFor(runId, outputRoot);
  if (!runDir) return null;
  return join(runDir, "artifacts", "document-workflow");
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readText(path: string) {
  return readFileSync(path, "utf8");
}

function appendNdjson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function writeText(path: string, value: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
}

function relativeWorkflowPath(workflow: WorkflowContext | null | undefined, path: string | null | undefined) {
  if (!workflow?.root || !path) return null;
  const resolvedRoot = resolve(workflow.root);
  const resolvedPath = resolve(path);
  return isInside(resolvedRoot, resolvedPath) ? relative(resolvedRoot, resolvedPath) : null;
}

function attemptBaseName(meta: {
  taskIndex: number;
  docType: string;
  batchIndex: number | string;
  provider: string;
  model: string;
  attemptKind?: string;
}) {
  return [
    `task-${meta.taskIndex}`,
    safeSegment(meta.docType, "document"),
    `batch-${safeSegment(meta.batchIndex, "full")}`,
    safeSegment(meta.provider, "provider"),
    safeSegment(meta.model, "model"),
    meta.attemptKind ? safeSegment(meta.attemptKind, "attempt") : null,
  ].filter(Boolean).join("-");
}

function mergeMarkdown(parts: string[]) {
  return trimMarkdown(parts.map(trimMarkdown).filter(Boolean).join("\n\n"));
}

function normalizeQualityMode(value: unknown): WorkflowContext["qualityMode"] {
  const mode = String(value ?? "stable").trim().toLowerCase();
  if (mode === "balanced" || mode === "fast") return mode;
  return "stable";
}

function normalizeWorkflowStrategy(value: unknown): WorkflowContext["workflowStrategy"] {
  return String(value ?? "checkpointed").trim().toLowerCase() === "single_pass" ? "single_pass" : "checkpointed";
}

function normalizeRetryPolicy(value: any): RetryPolicy {
  return {
    maxAttemptsPerUnit: boundedPositiveInteger(value?.maxAttemptsPerUnit, DEFAULT_RETRY_ATTEMPTS_PER_UNIT, MAX_RETRY_ATTEMPTS_PER_UNIT),
    maxRetryUnits: boundedPositiveInteger(value?.maxRetryUnits, DEFAULT_MAX_RETRY_UNITS, MAX_RETRY_UNITS),
  };
}

function workflowContext(params: {
  runId?: string;
  outputRoot?: string;
  qualityMode?: unknown;
  workflowStrategy?: unknown;
  resumeFromCheckpoint?: unknown;
  publishPartial?: unknown;
  retryPolicy?: unknown;
}): WorkflowContext {
  const root = workflowRootFor(params.runId, params.outputRoot);
  const checkpointPath = root ? join(root, "checkpoint.json") : null;
  const retryLedgerPath = root ? join(root, "retry-ledger.ndjson") : null;
  const workflowStrategy = normalizeWorkflowStrategy(params.workflowStrategy);
  const checkpoint = checkpointPath && params.resumeFromCheckpoint !== false && existsSync(checkpointPath)
    ? readJson(checkpointPath)
    : {
        schemaVersion: "document-workflow-checkpoint-v1",
        runId: params.runId ?? null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        workflowStrategy,
        qualityMode: normalizeQualityMode(params.qualityMode),
        publishPartial: params.publishPartial === true,
        retry: { unitsUsed: 0 },
        docs: {},
        rawSecretsReturned: false,
      };
  checkpoint.schemaVersion = "document-workflow-checkpoint-v1";
  checkpoint.runId = params.runId ?? checkpoint.runId ?? null;
  checkpoint.workflowStrategy = workflowStrategy;
  checkpoint.qualityMode = normalizeQualityMode(params.qualityMode);
  checkpoint.publishPartial = params.publishPartial === true;
  checkpoint.updatedAt = nowIso();
  checkpoint.retry = checkpoint.retry && typeof checkpoint.retry === "object" ? checkpoint.retry : { unitsUsed: 0 };
  checkpoint.docs = checkpoint.docs && typeof checkpoint.docs === "object" ? checkpoint.docs : {};
  return {
    runId: params.runId,
    root,
    checkpointPath,
    retryLedgerPath,
    qualityMode: normalizeQualityMode(params.qualityMode),
    workflowStrategy,
    resumeFromCheckpoint: params.resumeFromCheckpoint !== false,
    publishPartial: params.publishPartial === true,
    retryPolicy: normalizeRetryPolicy(params.retryPolicy),
    checkpoint,
  };
}

function writeCheckpoint(workflow?: WorkflowContext | null) {
  if (!workflow?.checkpointPath) return;
  workflow.checkpoint.updatedAt = nowIso();
  workflow.checkpoint.retryPolicy = workflow.retryPolicy;
  workflow.checkpoint.publishPartial = workflow.publishPartial;
  writeJson(workflow.checkpointPath, workflow.checkpoint);
}

function appendRetryLedger(workflow: WorkflowContext | null | undefined, value: Record<string, unknown>) {
  if (!workflow?.retryLedgerPath) return;
  appendNdjson(workflow.retryLedgerPath, {
    schemaVersion: "document-workflow-retry-ledger-v1",
    at: nowIso(),
    ...value,
    rawSecretsReturned: false,
  });
}

function docCheckpoint(workflow: WorkflowContext | null | undefined, item: DocumentWorkItem, taskIndex: number) {
  if (!workflow) return null;
  const key = `task-${taskIndex}-${safeSegment(item.docType, "document")}`;
  const existing = workflow.checkpoint.docs[key] && typeof workflow.checkpoint.docs[key] === "object"
    ? workflow.checkpoint.docs[key]
    : {};
  const doc = {
    taskIndex,
    docType: item.docType,
    promptFile: item.promptFile ?? null,
    dependsOn: item.dependsOn ?? [],
    status: existing.status ?? "running",
    createdAt: existing.createdAt ?? nowIso(),
    updatedAt: nowIso(),
    blueprint: existing.blueprint ?? null,
    sections: existing.sections && typeof existing.sections === "object" ? existing.sections : {},
    repairs: existing.repairs && typeof existing.repairs === "object" ? existing.repairs : {},
    assembly: existing.assembly ?? null,
    review: existing.review ?? null,
    completedSections: Array.isArray(existing.completedSections) ? existing.completedSections : [],
    missingSections: Array.isArray(existing.missingSections) ? existing.missingSections : [],
  };
  workflow.checkpoint.docs[key] = doc;
  return { key, doc };
}

function workflowArtifactPath(workflow: WorkflowContext | null | undefined, kind: string, name: string) {
  if (!workflow?.root) return null;
  return join(workflow.root, kind, name);
}

function sectionUnitKey(taskIndex: number, docType: string, batchIndex: number | string, contextPackHash?: string | null) {
  const contextSuffix = contextPackHash ? `-${safeSegment(String(contextPackHash).slice(0, 12), "ctx")}` : "";
  return `task-${taskIndex}-${safeSegment(docType, "document")}-batch-${safeSegment(batchIndex, "full")}${contextSuffix}`;
}

function repairUnitKey(taskIndex: number, docType: string, repairIndex: number) {
  return `task-${taskIndex}-${safeSegment(docType, "document")}-repair-${repairIndex}`;
}

function canRetryGeneration(generation: any) {
  const reason = String(generation?.reason ?? "");
  const attempts = Array.isArray(generation?.attemptFailures) ? generation.attemptFailures : [];
  const hasRetryableProviderFailure = attempts.some((attempt: any) =>
    ["model_provider_request_timeout", "model_provider_empty_response"].includes(String(attempt?.reason ?? "")),
  );
  if (reason === "no_candidate_model_available" && hasRetryableProviderFailure) return true;
  if (attempts.some((attempt: any) => Array.isArray(attempt?.missingEnv) && attempt.missingEnv.length > 0)) return false;
  if (reason === "model_provider_request_timeout") return true;
  if (reason === "model_provider_empty_response") return true;
  if (reason === "document_worker_deadline_exhausted") return true;
  if (reason === "model_provider_http_error") {
    const status = Number(generation?.httpStatus ?? attempts.find((attempt: any) => attempt?.httpStatus)?.httpStatus ?? 0);
    return status >= 500 && status < 600;
  }
  if (reason === "no_candidate_model_available") return hasRetryableProviderFailure;
  return false;
}

function lastAttemptFailure(generation: any) {
  const attempts = Array.isArray(generation?.attemptFailures) ? generation.attemptFailures : [];
  const last = attempts.at(-1) ?? null;
  if (!last) return null;
  return {
    provider: last.provider ?? null,
    model: last.model ?? null,
    status: last.status ?? null,
    reason: last.reason ?? null,
    httpStatus: last.httpStatus ?? null,
    timeoutMs: last.timeoutMs ?? null,
  };
}

async function generateWithRetry(params: {
  unitId: string;
  stage: string;
  docType: string;
  sections?: string[];
  workflow?: WorkflowContext | null;
  prompt: string;
  initialRoute: any;
  candidates: any[];
  mockResponse?: string;
  temperature?: number;
  maxTokens?: number;
  modelTimeoutMs?: number;
  captureModelStream?: boolean;
  traceRoot?: string | null;
  traceMeta?: Record<string, unknown>;
  deadline?: DeadlineContext | null;
}) {
  const workflow = params.workflow;
  const maxAttempts = workflow?.workflowStrategy === "checkpointed" ? workflow.retryPolicy.maxAttemptsPerUnit : 1;
  let lastGeneration: any = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (deadlineSnapshot(params.deadline).exhausted) {
      const blocked = {
        status: "blocked",
        reason: "document_worker_deadline_exhausted",
        deadline: deadlineSnapshot(params.deadline),
        attemptFailures: lastGeneration?.attemptFailures ?? [],
      };
      appendRetryLedger(workflow, {
        event: "unit_deadline_exhausted",
        unitId: params.unitId,
        stage: params.stage,
        docType: params.docType,
        sections: params.sections ?? [],
        attempt,
        reason: blocked.reason,
      });
      return blocked;
    }
    const generation = await generateWithCandidates({
      prompt: params.prompt,
      systemPrompt: systemPromptForDocType(params.docType),
      initialRoute: params.initialRoute,
      candidates: params.candidates,
      mockResponse: params.mockResponse,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      modelTimeoutMs: params.modelTimeoutMs,
      captureModelStream: params.captureModelStream,
      traceRoot: params.traceRoot,
      deadline: params.deadline,
      traceMeta: {
        ...(params.traceMeta ?? {}),
        retryAttempt: attempt,
      },
    });
    lastGeneration = generation;
    if (generation.status === "completed") {
      appendRetryLedger(workflow, {
        event: attempt === 1 ? "unit_completed" : "unit_retry_completed",
        unitId: params.unitId,
        stage: params.stage,
        docType: params.docType,
        sections: params.sections ?? [],
        attempt,
        retryCount: attempt - 1,
      });
      return {
        ...generation,
        workflowRetry: {
          unitId: params.unitId,
          stage: params.stage,
          attempts: attempt,
          retryCount: attempt - 1,
          retryExhausted: false,
        },
      };
    }
    const retryable = canRetryGeneration(generation);
    const snapshot = deadlineSnapshot(params.deadline);
    const retryBudgetUsed = Number(workflow?.checkpoint?.retry?.unitsUsed ?? 0);
    const retryBudgetAvailable = Boolean(workflow && retryBudgetUsed < workflow.retryPolicy.maxRetryUnits);
    const canTryAgain = attempt < maxAttempts && retryable && retryBudgetAvailable && !snapshot.exhausted;
    appendRetryLedger(workflow, {
      event: canTryAgain ? "unit_retry_scheduled" : "unit_failed",
      unitId: params.unitId,
      stage: params.stage,
      docType: params.docType,
      sections: params.sections ?? [],
      attempt,
      retryable,
      retryBudgetUsed,
      reason: generation.reason ?? "generation_failed",
      lastProviderAttempt: lastAttemptFailure(generation),
    });
    if (!canTryAgain) {
      return {
        ...generation,
        workflowRetry: {
          unitId: params.unitId,
          stage: params.stage,
          attempts: attempt,
          retryCount: attempt - 1,
          retryExhausted: retryable && attempt >= maxAttempts,
          retryBudgetExhausted: retryable && !retryBudgetAvailable,
        },
      };
    }
    workflow.checkpoint.retry.unitsUsed = retryBudgetUsed + 1;
    writeCheckpoint(workflow);
  }
  return lastGeneration ?? { status: "blocked", reason: "no_generation_attempts" };
}

function markdownExcerpt(markdown: string, maxChars = 12000) {
  const clean = trimMarkdown(markdown);
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars)}\n\n[上游文档已截断；如需细节请回看对应文档 artifact。]`;
}

function dependencyWaves(items: DocumentWorkItem[]) {
  const presentDocTypes = new Set(items.map((item) => item.docType));
  const unresolved = new Set(items.map((_, index) => index));
  const waves: Array<{ waveIndex: number; taskIndexes: number[] }> = [];
  const resolvedDocTypes = new Set<string>();
  let dependencyCycleDetected = false;

  while (unresolved.size > 0) {
    const ready: number[] = [];
    for (const index of unresolved) {
      const item = items[index];
      const requiredPresentDeps = uniqueStrings(item.dependsOn ?? []).filter((dep) => presentDocTypes.has(dep));
      if (requiredPresentDeps.every((dep) => resolvedDocTypes.has(dep))) {
        ready.push(index);
      }
    }

    if (ready.length === 0) {
      dependencyCycleDetected = true;
      ready.push(...Array.from(unresolved).sort((a, b) => a - b));
    }

    waves.push({ waveIndex: waves.length, taskIndexes: ready.sort((a, b) => a - b) });
    for (const index of ready) {
      unresolved.delete(index);
      resolvedDocTypes.add(items[index].docType);
    }
  }

  return { waves, dependencyCycleDetected, presentDocTypes };
}

function injectUpstreamDocuments(
  item: DocumentWorkItem,
  completedByDocType: Map<string, any>,
  presentDocTypes: Set<string>,
) {
  const dependsOn = uniqueStrings(item.dependsOn ?? []);
  if (dependsOn.length === 0) return item;

  const upstreamDocs: Array<{ docType: string; title?: string | null; promptFile?: string | null; markdown: string }> = [];
  const missingUpstreamDocuments: string[] = [];
  const absentUpstreamDocuments: string[] = [];

  for (const dep of dependsOn) {
    const upstream = completedByDocType.get(dep);
    if (upstream?.markdown) {
      upstreamDocs.push({
        docType: dep,
        title: upstream.title ?? null,
        promptFile: upstream.promptFile ?? null,
        markdown: String(upstream.markdown),
      });
    } else if (presentDocTypes.has(dep)) {
      missingUpstreamDocuments.push(dep);
    } else {
      absentUpstreamDocuments.push(dep);
    }
  }

  const upstreamDependencyContext = {
    schemaVersion: "upstream-dependency-context-v1",
    mode: "bounded_summary_not_full_document",
    dependsOn,
    upstreamDocumentsUsed: upstreamDocs.map((doc) => doc.docType),
    missingUpstreamDocuments,
    absentUpstreamDocuments,
    summaries: upstreamDocs.map((doc) => ({
      docType: doc.docType,
      title: doc.title ?? null,
      promptFile: doc.promptFile ?? null,
      excerpt: markdownExcerpt(doc.markdown, 1800),
      fullDocumentInjected: false,
    })),
    rawSecretsReturned: false,
  };

  return {
    ...item,
    upstreamDocumentsUsed: upstreamDocs.map((doc) => doc.docType),
    missingUpstreamDocuments,
    absentUpstreamDocuments,
    upstreamDependencyContext,
  };
}

function sectionList(sections: string[]) {
  return sections.map((section) => `- ${section}`).join("\n");
}

function workUnitMatchesSections(unit: NonNullable<DocumentWorkItem["workUnits"]>[number], sections: string[]) {
  const unitSections = new Set((unit.sections ?? []).map((section) => section.trim()));
  return sections.length > 0 && sections.every((section) => unitSections.has(section.trim()));
}

function safeContextPackPath(path?: string) {
  if (!path) return null;
  const resolved = resolve(path);
  if (!isInside(workspaceDir, resolved)) return null;
  return resolved;
}

function readContextPack(path?: string) {
  const resolved = safeContextPackPath(path);
  if (!resolved || !existsSync(resolved)) return null;
  try {
    return JSON.parse(readFileSync(resolved, "utf8"));
  } catch {
    return null;
  }
}

function contextWorkUnitForSections(item: DocumentWorkItem, sections: string[]) {
  const units = Array.isArray(item.workUnits) ? item.workUnits : [];
  return units.find((unit) => workUnitMatchesSections(unit, sections))
    ?? units.find((unit) => sections.some((section) => unit.sections?.includes(section)))
    ?? units[0]
    ?? null;
}

function contextMetadataForSections(item: DocumentWorkItem, sections: string[]) {
  const unit = contextWorkUnitForSections(item, sections);
  const pack = readContextPack(unit?.contextPackRef);
  const selectedSourceBlocks = Array.isArray(pack?.selectedSourceBlocks) ? pack.selectedSourceBlocks : [];
  const sourceBlockIds = unit?.sourceBlockIds ?? pack?.sourceBlockIds ?? selectedSourceBlocks.map((block: any) => block.blockId).filter(Boolean);
  const tableBlockCount = Number(unit?.tableBlockCount ?? pack?.tableBlockCount ?? selectedSourceBlocks.filter((block: any) => block.blockType === "table").length);
  return {
    workUnitId: unit?.workUnitId ?? pack?.workUnitId ?? null,
    contextPackId: unit?.contextPackId ?? pack?.contextPackId ?? null,
    contextPackHash: unit?.contextPackHash ?? null,
    contextPackRef: unit?.contextPackRef ?? null,
    sourceSegmentIds: unit?.sourceSegmentIds ?? pack?.sourceSegmentIds ?? [],
    sourceBlockIds,
    tableBlockCount,
    promptBudgetChars: unit?.promptBudgetChars ?? pack?.promptBudgetChars ?? null,
    evidenceBudgetChars: unit?.evidenceBudgetChars ?? pack?.evidenceBudgetChars ?? null,
    retrievalReasons: unit?.retrievalReasons ?? pack?.retrievalReasons ?? [],
    selectedSourceBlocks,
    documentIdentity: pack?.documentIdentity ?? null,
    outputContract: pack?.outputContract ?? null,
    outputContractVersion: unit?.outputContractVersion ?? pack?.outputContract?.outputContractVersion ?? "document-output-contract-v1",
    documentIdentityConfidence: unit?.documentIdentityConfidence ?? pack?.documentIdentity?.confidence ?? null,
    modelContext: pack?.modelContext ?? null,
    contextPackFound: Boolean(pack),
  };
}

function boundedPromptInstructions(item: DocumentWorkItem, maxChars = 9000) {
  const text = String(item.promptInstructions ?? "").trim();
  if (!text) return "No prompt registry instructions were provided.";
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n\n[prompt registry instructions truncated; source evidence must come from the context pack above.]`
    : text;
}

function contextPlaneIssue(item: DocumentWorkItem) {
  const units = Array.isArray(item.workUnits) ? item.workUnits : [];
  if (units.length === 0) return "context_work_units_required";
  const missingPack = units.find((unit) => !readContextPack(unit.contextPackRef));
  if (missingPack) return "context_pack_missing";
  return null;
}

function buildSectionPrompt(params: {
  item: DocumentWorkItem;
  sections: string[];
  completedSections: string[];
  repair: boolean;
  missingSections?: string[];
}) {
  const contextMeta = contextMetadataForSections(params.item, params.sections);
  const targetSections = sectionList(params.sections);
  const completedSections = params.completedSections.length > 0 ? sectionList(params.completedSections) : "- 无";
  const missingSections = params.missingSections?.length ? sectionList(params.missingSections) : "- 无";
  const mode = params.repair ? "缺失章节修复批次" : "章节批次生成";
  return [
    `# Document Worker ${mode}`,
    "",
    `docType: ${params.item.docType}`,
    `promptFile: ${params.item.promptFile ?? "unknown"}`,
    "",
    "## 目标章节（必须逐字作为 Markdown 二级标题输出）",
    "",
    targetSections,
    "",
    "## 已完成章节（不要重复生成）",
    "",
    completedSections,
    "",
    "## 缺失章节（修复批次参考）",
    "",
    missingSections,
    "",
    "## 输出要求",
    "",
    "1. 只输出目标章节，不输出非目标章节。",
    "2. 每个目标章节都必须出现，章节标题必须使用 `## {目标章节}`，目标章节文本必须逐字匹配。",
    "3. 根据 Runtime Context Pack 中的 selected evidence、写作规则和目标章节写作。",
    "4. 所有事实、推断、待确认要分清楚；证据不足必须写“待确认”，不得编造 owner、deadline、budget、外部事实。",
    "5. 不要输出 raw evidence id、API key、Authorization、raw request body、raw media 或源音频文件名。",
    "6. 表格必须输出为 Markdown pipe table 或分组 bullet；不要输出 HTML table/tbody/tr/th/td 标签。",
    "",
    "## Runtime Context Pack Metadata",
    "",
    JSON.stringify({
      workUnitId: contextMeta.workUnitId,
      contextPackId: contextMeta.contextPackId,
      contextPackHash: contextMeta.contextPackHash,
      sourceSegmentIds: contextMeta.sourceSegmentIds,
      sourceBlockIds: contextMeta.sourceBlockIds,
      tableBlockCount: contextMeta.tableBlockCount,
      promptBudgetChars: contextMeta.promptBudgetChars,
      evidenceBudgetChars: contextMeta.evidenceBudgetChars,
      retrievalReasons: contextMeta.retrievalReasons,
      contextPackFound: contextMeta.contextPackFound,
      documentIdentityConfidence: contextMeta.documentIdentityConfidence,
      outputContractVersion: contextMeta.outputContractVersion,
    }, null, 2),
    "",
    "## Document Output Contract",
    "",
    JSON.stringify({
      documentIdentity: contextMeta.documentIdentity,
      outputContract: contextMeta.outputContract,
      selectedSourceBlocks: contextMeta.selectedSourceBlocks?.map((block: any) => ({
        blockId: block.blockId,
        blockType: block.blockType,
        sourceFormat: block.sourceFormat,
        columns: block.columns ?? [],
        rowCount: block.rowCount ?? null,
        markdownPreview: block.markdownPreview ?? null,
        quality: block.quality,
      })) ?? [],
    }, null, 2),
    "",
    "## Selected Bounded Evidence",
    "",
    contextMeta.modelContext ?? "No context pack was found; use only compact prompt instructions and mark evidence gaps as 待确认.",
    "",
    "## Prompt Registry Instructions",
    "",
    boundedPromptInstructions(params.item),
    ...(params.item.upstreamDependencyContext ? ["", "## Upstream Dependency Summary", "", JSON.stringify(params.item.upstreamDependencyContext, null, 2)] : []),
  ].join("\n");
}

function buildFullDocumentPrompt(item: DocumentWorkItem) {
  const contextMeta = contextMetadataForSections(item, item.requiredSections ?? []);
  return [
    "# Document Worker Full Document Generation",
    "",
    `docType: ${item.docType}`,
    `promptFile: ${item.promptFile ?? "unknown"}`,
    "",
    "## 输出要求",
    "",
    "1. 输出完整文档。",
    "2. 如果有 requiredSections，必须逐字使用这些章节名作为 Markdown 二级标题。",
    "3. 只根据 Runtime Context Pack 和 prompt registry instructions 写作，不编造 owner、deadline、budget 或外部事实。",
    "4. 表格必须输出为 Markdown pipe table 或分组 bullet；不要输出 HTML table/tbody/tr/th/td 标签。",
    "",
    "## requiredSections",
    "",
    sectionList(item.requiredSections ?? []),
    "",
    "## Runtime Context Pack",
    "",
    contextMeta.modelContext ?? "No context pack was found.",
    "",
    "## Prompt Registry Instructions",
    "",
    boundedPromptInstructions(item),
  ].join("\n");
}

function isBlockedCandidate(candidate: any) {
  return candidate?.provider?.toLowerCase?.() === "manual" || candidate?.strength?.toLowerCase?.() === "blocked";
}

function routeCandidates(route: any, mockProvider: boolean, unavailableProviders: string[]) {
  if (mockProvider) {
    return [{ provider: "mock", model: "mock-document-worker", strength: "test" }];
  }
  const unavailable = new Set(unavailableProviders.map((provider) => provider.toLowerCase()));
  return (route?.candidates ?? [route?.selected].filter(Boolean)).filter((candidate: any) =>
    candidate && !isBlockedCandidate(candidate) && !unavailable.has(String(candidate.provider).toLowerCase()),
  );
}

function selectedIndexFor(initialRoute: any, candidates: any[], candidate: any) {
  return (initialRoute.candidates ?? candidates).findIndex((routeCandidate: any) =>
    routeCandidate?.provider === candidate.provider && routeCandidate?.model === candidate.model,
  );
}

function isFallbackEligible(generation: any) {
  if (generation?.reason === "model_provider_unavailable") return true;
  if (generation?.reason === "model_provider_empty_response") return true;
  if (generation?.reason === "model_provider_http_error") {
    const status = Number(generation?.httpStatus ?? 0);
    return status >= 500 && status < 600;
  }
  return false;
}

async function generateWithCandidates(params: {
  prompt: string;
  systemPrompt?: string;
  initialRoute: any;
  candidates: any[];
  mockResponse?: string;
  temperature?: number;
  maxTokens?: number;
  modelTimeoutMs?: number;
  captureModelStream?: boolean;
  traceRoot?: string | null;
  traceMeta?: Record<string, unknown>;
  deadline?: DeadlineContext | null;
}) {
  const attempts: any[] = [];
  for (const [candidateIndex, candidate] of params.candidates.entries()) {
    const startedAt = new Date().toISOString();
    const timeoutMs = modelAttemptTimeoutMs(params.modelTimeoutMs, params.deadline);
    const traceMeta = {
      ...(params.traceMeta ?? {}),
      candidateIndex,
      provider: candidate.provider,
      model: candidate.model,
      startedAt,
    };
    const base = params.traceRoot
      ? attemptBaseName({
          taskIndex: Number(params.traceMeta?.taskIndex ?? 0),
          docType: String(params.traceMeta?.docType ?? "document"),
          batchIndex: String(params.traceMeta?.batchIndex ?? "full"),
          provider: candidate.provider,
          model: candidate.model,
          attemptKind: String(params.traceMeta?.attemptKind ?? "generate"),
        })
      : "";
    const streamTracePath = params.traceRoot ? join(params.traceRoot, "streams", `${base}.ndjson`) : undefined;
    const streamTraceSummaryPath = params.traceRoot ? join(params.traceRoot, "streams", `${base}.summary.json`) : undefined;
    const attemptsPath = params.traceRoot ? join(params.traceRoot, "attempts.ndjson") : null;
    if (!timeoutMs) {
      const skipped = {
        provider: candidate.provider,
        model: candidate.model,
        status: "blocked",
        reason: "document_worker_deadline_exhausted",
        fallbackSkippedReason: candidateIndex > 0 ? "deadline_budget_insufficient_or_primary_timeout" : null,
        deadline: deadlineSnapshot(params.deadline),
        streamTracePath: streamTracePath ?? null,
        streamTraceSummaryPath: streamTraceSummaryPath ?? null,
      };
      attempts.push(skipped);
      if (attemptsPath) appendNdjson(attemptsPath, { schemaVersion: "document-worker-attempt-v1", event: "attempt_skipped", ...traceMeta, ...skipped, rawSecretsReturned: false });
      return {
        status: "blocked",
        reason: "document_worker_deadline_exhausted",
        attemptFailures: attempts,
        fallbackSkippedReason: skipped.fallbackSkippedReason,
        deadline: deadlineSnapshot(params.deadline),
      };
    }
    if (attemptsPath) appendNdjson(attemptsPath, {
      schemaVersion: "document-worker-attempt-v1",
      event: "attempt_started",
      ...traceMeta,
      timeoutMs,
      deadline: deadlineSnapshot(params.deadline),
    });
    const generation = await generateText({
      provider: candidate.provider,
      model: candidate.model,
      prompt: params.prompt,
      systemPrompt: params.systemPrompt ?? SYSTEM_PROMPT,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      mockResponse: params.mockResponse,
      timeoutMs,
      stream: params.captureModelStream === true,
      streamTracePath,
      streamTraceSummaryPath,
      streamTraceMeta: traceMeta,
    });
    const completedAt = new Date().toISOString();
    const attemptRecord = {
      schemaVersion: "document-worker-attempt-v1",
      event: "attempt_completed",
      ...traceMeta,
      completedAt,
      status: generation.status,
      reason: generation.reason ?? null,
      httpStatus: generation.httpStatus ?? null,
      streamTracePath: generation.streamTracePath ?? streamTracePath ?? null,
      streamTraceSummaryPath: generation.streamTraceSummaryPath ?? streamTraceSummaryPath ?? null,
      contentChars: generation.content ? String(generation.content).length : 0,
      finishReason: generation.finishReason ?? null,
      timeoutMs,
      deadline: deadlineSnapshot(params.deadline),
      rawSecretsReturned: false,
    };
    if (attemptsPath) appendNdjson(attemptsPath, attemptRecord);
    if (generation.status === "completed") {
      const selectedIndex = selectedIndexFor(params.initialRoute, params.candidates, candidate);
      const modelRoute = {
        ...params.initialRoute,
        selected: candidate,
        selectedIndex,
        fallbackOccurred: selectedIndex > 0,
        fallbackReason: selectedIndex > 0 ? "primary_or_prior_candidate_unavailable" : null,
        attemptFailures: attempts,
      };
      return {
        status: "completed",
        content: generation.content,
        usage: generation.usage ?? null,
        modelRoute,
        attemptFailures: attempts,
        streamTracePath: generation.streamTracePath ?? null,
        streamTraceSummaryPath: generation.streamTraceSummaryPath ?? null,
      };
    }
    attempts.push({
      provider: candidate.provider,
      model: candidate.model,
      status: generation.status,
      reason: generation.reason,
      missingEnv: generation.missingEnv ?? [],
      httpStatus: generation.httpStatus ?? null,
      streamTracePath: generation.streamTracePath ?? streamTracePath ?? null,
      streamTraceSummaryPath: generation.streamTraceSummaryPath ?? streamTraceSummaryPath ?? null,
      timeoutMs,
    });
    const remainingCandidates = params.candidates.slice(candidateIndex + 1);
    const fallbackEligible = isFallbackEligible(generation);
    const snapshot = deadlineSnapshot(params.deadline);
    if (remainingCandidates.length > 0 && (!fallbackEligible || snapshot.exhausted || generation.reason === "model_provider_request_timeout")) {
      const fallbackSkippedReason = generation.reason === "model_provider_request_timeout" || snapshot.exhausted
        ? "deadline_budget_insufficient_or_primary_timeout"
        : "primary_failure_not_fallback_eligible";
      for (const skippedCandidate of remainingCandidates) {
        const skippedTraceMeta = {
          ...(params.traceMeta ?? {}),
          candidateIndex: params.candidates.indexOf(skippedCandidate),
          provider: skippedCandidate.provider,
          model: skippedCandidate.model,
          startedAt: new Date().toISOString(),
        };
        const skippedBase = params.traceRoot
          ? attemptBaseName({
              taskIndex: Number(params.traceMeta?.taskIndex ?? 0),
              docType: String(params.traceMeta?.docType ?? "document"),
              batchIndex: String(params.traceMeta?.batchIndex ?? "full"),
              provider: skippedCandidate.provider,
              model: skippedCandidate.model,
              attemptKind: String(params.traceMeta?.attemptKind ?? "generate"),
            })
          : "";
        const skipped = {
          provider: skippedCandidate.provider,
          model: skippedCandidate.model,
          status: "blocked",
          reason: "fallback_skipped",
          fallbackSkippedReason,
          streamTracePath: params.traceRoot ? join(params.traceRoot, "streams", `${skippedBase}.ndjson`) : null,
          streamTraceSummaryPath: params.traceRoot ? join(params.traceRoot, "streams", `${skippedBase}.summary.json`) : null,
        };
        attempts.push(skipped);
        if (attemptsPath) appendNdjson(attemptsPath, { schemaVersion: "document-worker-attempt-v1", event: "attempt_skipped", ...skippedTraceMeta, ...skipped, deadline: snapshot, rawSecretsReturned: false });
      }
      return {
        status: "blocked",
        reason: generation.reason ?? "no_candidate_model_available",
        attemptFailures: attempts,
        fallbackSkippedReason,
        deadline: snapshot,
      };
    }
  }
  return {
    status: "blocked",
    reason: "no_candidate_model_available",
    attemptFailures: attempts,
  };
}

async function generateOne(params: {
  item: DocumentWorkItem;
  taskIndex: number;
  unavailableProviders: string[];
  mockProvider: boolean;
  mockResponse?: string;
  temperature?: number;
  maxTokens?: number;
  reasoningDepth?: "fast" | "deep";
  userRequestedDeepThinking?: boolean;
  estimatedComplexity?: "low" | "medium" | "high";
  sectionBatching: boolean;
  sectionsPerBatch: number;
  maxRepairAttempts: number;
  runId?: string;
  outputRoot?: string;
  modelTimeoutMs?: number;
  captureModelStream?: boolean;
  deadline?: DeadlineContext | null;
  workflow?: WorkflowContext | null;
}) {
  const { item, taskIndex } = params;
  const contextIssue = contextPlaneIssue(item);
  if (contextIssue) {
    return {
      taskIndex,
      docType: item.docType,
      promptFile: item.promptFile ?? null,
      status: "blocked",
      reason: contextIssue === "context_pack_missing" ? "context_pack_missing" : "context_plane_required",
      expectedInput: "document_prompt_render_batch documentWorkItems[].workUnits[].contextPackRef",
      sectionBatching: params.sectionBatching,
      rawSecretsReturned: false,
    };
  }

  const initialRoute = params.mockProvider
    ? {
        status: "selected",
        taskType: routeTaskTypeFor(item, params),
        resolvedTaskType: routeTaskTypeFor(item, params),
        selected: { provider: "mock", model: "mock-document-worker", strength: "test" },
        candidates: [{ provider: "mock", model: "mock-document-worker", strength: "test" }],
        fallbackOccurred: false,
        fallbackReason: null,
      }
    : planRoute({
        taskType: routeTaskTypeFor(item, params),
        docType: item.docType,
        reasoningDepth: params.reasoningDepth,
        userRequestedDeepThinking: params.userRequestedDeepThinking,
        estimatedComplexity: params.estimatedComplexity,
        unavailableProviders: params.unavailableProviders,
      });

  if (initialRoute.status === "blocked") {
    return {
      taskIndex,
      docType: item.docType,
      promptFile: item.promptFile ?? null,
      status: "blocked",
      reason: initialRoute.reason,
      modelRoute: initialRoute,
      sectionBatching: params.sectionBatching,
      rawSecretsReturned: false,
    };
  }

  const requiredSections = uniqueStrings(item.requiredSections ?? []);
  const sectionBatches = params.sectionBatching && requiredSections.length > 0
    ? chunkSections(requiredSections, params.sectionsPerBatch)
    : [{ batchIndex: 0, sections: requiredSections }];
  const candidates = routeCandidates(initialRoute, params.mockProvider, params.unavailableProviders);
  const markdownParts: string[] = [];
  const sectionAttempts: any[] = [];
  const completedSections: string[] = [];
  let docModelRoute: any = null;
  let usage: any[] = [];
  const traceRoot = traceRootFor(params.runId, params.outputRoot);
  const checkpointRecord = docCheckpoint(params.workflow, item, taskIndex);
  const previousCheckpointDocStatus = checkpointRecord?.doc?.status ?? null;
  if (checkpointRecord) {
    checkpointRecord.doc.status = "running";
    checkpointRecord.doc.updatedAt = nowIso();
    if (!checkpointRecord.doc.blueprint) {
      const blueprintPath = workflowArtifactPath(params.workflow, "blueprints", `task-${taskIndex}-${safeSegment(item.docType, "document")}.json`);
      if (blueprintPath) {
        writeJson(blueprintPath, {
          schemaVersion: "document-worker-blueprint-v1",
          runId: params.runId ?? null,
          taskIndex,
          docType: item.docType,
          promptFile: item.promptFile ?? null,
          requiredSections,
          sectionBatches,
          dependsOn: item.dependsOn ?? [],
          audience: item.audience ?? null,
          qualityMode: params.workflow?.qualityMode ?? "stable",
          workflowStrategy: params.workflow?.workflowStrategy ?? "checkpointed",
          rawSecretsReturned: false,
        });
        checkpointRecord.doc.blueprint = {
          status: "completed",
          artifactPath: blueprintPath,
          artifactRelativePath: relativeWorkflowPath(params.workflow, blueprintPath),
          updatedAt: nowIso(),
        };
      }
    }
    writeCheckpoint(params.workflow);
  }
  if (deadlineSnapshot(params.deadline).exhausted) {
    return deadlineBlockedResult({
      item,
      taskIndex,
      requiredSections,
      completedSections,
      sectionAttempts,
      repairAttempts: [],
      markdownParts,
      traceRoot,
      deadline: params.deadline,
      stage: "before_document_generation",
    });
  }

  let resumedNeedsFixAssembly = false;
  if (
    params.workflow?.resumeFromCheckpoint &&
    previousCheckpointDocStatus !== "completed" &&
    checkpointRecord.doc.assembly?.artifactPath &&
    existsSync(checkpointRecord.doc.assembly.artifactPath) &&
    Array.isArray(checkpointRecord.doc.missingSections) &&
    checkpointRecord.doc.missingSections.length > 0
  ) {
    markdownParts.push(readText(checkpointRecord.doc.assembly.artifactPath));
    completedSections.push(...uniqueStrings(checkpointRecord.doc.completedSections ?? []));
    sectionAttempts.push({
      batchIndex: "checkpoint-assembly",
      sections: uniqueStrings(checkpointRecord.doc.completedSections ?? []),
      status: "completed",
      reason: "checkpoint_assembly_reused",
      artifactPath: checkpointRecord.doc.assembly.artifactPath,
    });
    resumedNeedsFixAssembly = true;
  }

  if (params.sectionBatching && requiredSections.length > 0 && !resumedNeedsFixAssembly) {
    for (const batch of sectionBatches) {
      const contextMeta = contextMetadataForSections(item, batch.sections);
      const unitId = sectionUnitKey(taskIndex, item.docType, batch.batchIndex, contextMeta.contextPackHash);
      const sectionCheckpoint = checkpointRecord?.doc?.sections?.[unitId] ?? null;
      if (
        params.workflow?.resumeFromCheckpoint &&
        sectionCheckpoint?.status === "completed" &&
        sectionCheckpoint?.artifactPath &&
        existsSync(sectionCheckpoint.artifactPath)
      ) {
        const checkpointMarkdown = readText(sectionCheckpoint.artifactPath);
        markdownParts.push(checkpointMarkdown);
        completedSections.push(...batch.sections);
        sectionAttempts.push({
          batchIndex: batch.batchIndex,
          sections: batch.sections,
          status: "completed",
          reason: "checkpoint_reused",
          workflowUnitId: unitId,
          artifactPath: sectionCheckpoint.artifactPath,
          retryCount: sectionCheckpoint.retryCount ?? 0,
          contextPackId: contextMeta.contextPackId,
        });
        continue;
      }
      if (deadlineSnapshot(params.deadline).exhausted) {
        return deadlineBlockedResult({
          item,
          taskIndex,
          requiredSections,
          completedSections,
          sectionAttempts,
          repairAttempts: [],
          markdownParts,
          traceRoot,
          deadline: params.deadline,
          stage: `before_batch_${batch.batchIndex}`,
        });
      }
      const prompt = buildSectionPrompt({
        item,
        sections: batch.sections,
        completedSections,
        repair: false,
      });
      const generation = await generateWithRetry({
        unitId,
        stage: "section_draft",
        docType: item.docType,
        sections: batch.sections,
        workflow: params.workflow,
        prompt,
        initialRoute,
        candidates,
        mockResponse: params.mockResponse,
        temperature: params.temperature,
        maxTokens: params.maxTokens,
        modelTimeoutMs: params.modelTimeoutMs,
        captureModelStream: params.captureModelStream,
        traceRoot,
        deadline: params.deadline,
        traceMeta: {
          runId: params.runId,
          tool: "document_workers_run",
          docType: item.docType,
          promptFile: item.promptFile ?? null,
          taskIndex,
          batchIndex: batch.batchIndex,
          sections: batch.sections,
          attemptKind: "section_batch",
          workUnitId: contextMeta.workUnitId,
          contextPackId: contextMeta.contextPackId,
          contextPackHash: contextMeta.contextPackHash,
          sourceSegmentIds: contextMeta.sourceSegmentIds,
          sourceBlockIds: contextMeta.sourceBlockIds,
          tableBlockCount: contextMeta.tableBlockCount,
          outputContractVersion: contextMeta.outputContractVersion,
          documentIdentityConfidence: contextMeta.documentIdentityConfidence,
          promptBudgetChars: contextMeta.promptBudgetChars,
          evidenceBudgetChars: contextMeta.evidenceBudgetChars,
          retrievalReasons: contextMeta.retrievalReasons,
        },
      });
      sectionAttempts.push({
        batchIndex: batch.batchIndex,
        sections: batch.sections,
        status: generation.status,
        provider: generation.modelRoute?.selected?.provider ?? null,
        model: generation.modelRoute?.selected?.model ?? null,
        fallbackOccurred: generation.modelRoute?.fallbackOccurred ?? false,
        reason: generation.reason ?? null,
        fallbackSkippedReason: generation.fallbackSkippedReason ?? null,
        deadline: generation.deadline ?? deadlineSnapshot(params.deadline),
        workUnitId: contextMeta.workUnitId,
        contextPackId: contextMeta.contextPackId,
        contextPackHash: contextMeta.contextPackHash,
        sourceSegmentIds: contextMeta.sourceSegmentIds,
        sourceBlockIds: contextMeta.sourceBlockIds,
        tableBlockCount: contextMeta.tableBlockCount,
        outputContractVersion: contextMeta.outputContractVersion,
        documentIdentityConfidence: contextMeta.documentIdentityConfidence,
        promptBudgetChars: contextMeta.promptBudgetChars,
        evidenceBudgetChars: contextMeta.evidenceBudgetChars,
        retrievalReasons: contextMeta.retrievalReasons,
        attemptFailures: generation.attemptFailures ?? [],
        streamTracePath: generation.streamTracePath ?? null,
        streamTraceSummaryPath: generation.streamTraceSummaryPath ?? null,
      });
      if (generation.status === "completed") {
        markdownParts.push(generation.content);
        completedSections.push(...batch.sections);
        docModelRoute = docModelRoute ?? generation.modelRoute;
        usage.push(generation.usage);
        if (traceRoot) {
          const partialPath = join(traceRoot, "partials", `task-${taskIndex}-${safeSegment(item.docType, "document")}-batch-${batch.batchIndex}.md`);
          writeText(partialPath, generation.content);
          writeJson(partialPath.replace(/\.md$/i, ".summary.json"), {
            schemaVersion: "document-worker-partial-v1",
            runId: params.runId,
            tool: "document_workers_run",
            taskIndex,
            docType: item.docType,
            batchIndex: batch.batchIndex,
            sections: batch.sections,
            status: generation.status,
            contentChars: String(generation.content).length,
            streamTracePath: generation.streamTracePath ?? null,
            streamTraceSummaryPath: generation.streamTraceSummaryPath ?? null,
            rawSecretsReturned: false,
          });
        }
        if (checkpointRecord) {
          const sectionPath = workflowArtifactPath(params.workflow, "sections", `${unitId}.md`);
          if (sectionPath) writeText(sectionPath, generation.content);
          checkpointRecord.doc.sections[unitId] = {
            status: "completed",
            stage: "section_draft",
            batchIndex: batch.batchIndex,
            sections: batch.sections,
            artifactPath: sectionPath,
            artifactRelativePath: relativeWorkflowPath(params.workflow, sectionPath),
            retryCount: generation.workflowRetry?.retryCount ?? 0,
            attempts: generation.workflowRetry?.attempts ?? 1,
            provider: generation.modelRoute?.selected?.provider ?? null,
            model: generation.modelRoute?.selected?.model ?? null,
            workUnitId: contextMeta.workUnitId,
            contextPackId: contextMeta.contextPackId,
            contextPackHash: contextMeta.contextPackHash,
            updatedAt: nowIso(),
          };
          checkpointRecord.doc.completedSections = uniqueStrings([...(checkpointRecord.doc.completedSections ?? []), ...batch.sections]);
          writeCheckpoint(params.workflow);
        }
      } else if (checkpointRecord) {
        checkpointRecord.doc.sections[unitId] = {
          status: "failed",
          stage: "section_draft",
          batchIndex: batch.batchIndex,
          sections: batch.sections,
          reason: generation.reason ?? "section_generation_failed",
          retryCount: generation.workflowRetry?.retryCount ?? 0,
          attempts: generation.workflowRetry?.attempts ?? 1,
          retryExhausted: generation.workflowRetry?.retryExhausted ?? false,
          retryBudgetExhausted: generation.workflowRetry?.retryBudgetExhausted ?? false,
          workUnitId: contextMeta.workUnitId,
          contextPackId: contextMeta.contextPackId,
          contextPackHash: contextMeta.contextPackHash,
          lastProviderAttempt: lastAttemptFailure(generation),
          updatedAt: nowIso(),
        };
        writeCheckpoint(params.workflow);
      }
    }
  } else {
    const contextMeta = contextMetadataForSections(item, requiredSections);
    const unitId = sectionUnitKey(taskIndex, item.docType, "full", contextMeta.contextPackHash);
    const sectionCheckpoint = checkpointRecord?.doc?.sections?.[unitId] ?? null;
    let generation: any = null;
    if (
      params.workflow?.resumeFromCheckpoint &&
      sectionCheckpoint?.status === "completed" &&
      sectionCheckpoint?.artifactPath &&
      existsSync(sectionCheckpoint.artifactPath)
    ) {
      generation = {
        status: "completed",
        content: readText(sectionCheckpoint.artifactPath),
        reason: "checkpoint_reused",
        workflowRetry: { unitId, stage: "full_document", retryCount: sectionCheckpoint.retryCount ?? 0, attempts: sectionCheckpoint.attempts ?? 1 },
      };
    } else {
      generation = await generateWithRetry({
        unitId,
        stage: "full_document",
        docType: item.docType,
        sections: requiredSections,
        workflow: params.workflow,
        prompt: buildFullDocumentPrompt(item),
        initialRoute,
        candidates,
        mockResponse: params.mockResponse,
        temperature: params.temperature,
        maxTokens: params.maxTokens,
        modelTimeoutMs: params.modelTimeoutMs,
        captureModelStream: params.captureModelStream,
        traceRoot,
        deadline: params.deadline,
        traceMeta: {
          runId: params.runId,
          tool: "document_workers_run",
          docType: item.docType,
          promptFile: item.promptFile ?? null,
          taskIndex,
          batchIndex: "full",
          sections: requiredSections,
          attemptKind: "full_document",
          workUnitId: contextMeta.workUnitId,
          contextPackId: contextMeta.contextPackId,
          contextPackHash: contextMeta.contextPackHash,
          sourceSegmentIds: contextMeta.sourceSegmentIds,
          sourceBlockIds: contextMeta.sourceBlockIds,
          tableBlockCount: contextMeta.tableBlockCount,
          outputContractVersion: contextMeta.outputContractVersion,
          documentIdentityConfidence: contextMeta.documentIdentityConfidence,
          promptBudgetChars: contextMeta.promptBudgetChars,
          evidenceBudgetChars: contextMeta.evidenceBudgetChars,
          retrievalReasons: contextMeta.retrievalReasons,
        },
      });
    }
    sectionAttempts.push({
      batchIndex: 0,
      sections: requiredSections,
      status: generation.status,
      provider: generation.modelRoute?.selected?.provider ?? null,
      model: generation.modelRoute?.selected?.model ?? null,
      fallbackOccurred: generation.modelRoute?.fallbackOccurred ?? false,
      reason: generation.reason ?? null,
      fallbackSkippedReason: generation.fallbackSkippedReason ?? null,
      deadline: generation.deadline ?? deadlineSnapshot(params.deadline),
      workUnitId: contextMeta.workUnitId,
      contextPackId: contextMeta.contextPackId,
      contextPackHash: contextMeta.contextPackHash,
      sourceSegmentIds: contextMeta.sourceSegmentIds,
      sourceBlockIds: contextMeta.sourceBlockIds,
      tableBlockCount: contextMeta.tableBlockCount,
      outputContractVersion: contextMeta.outputContractVersion,
      documentIdentityConfidence: contextMeta.documentIdentityConfidence,
      promptBudgetChars: contextMeta.promptBudgetChars,
      evidenceBudgetChars: contextMeta.evidenceBudgetChars,
      retrievalReasons: contextMeta.retrievalReasons,
      attemptFailures: generation.attemptFailures ?? [],
      streamTracePath: generation.streamTracePath ?? null,
      streamTraceSummaryPath: generation.streamTraceSummaryPath ?? null,
    });
    if (generation.status === "completed") {
      markdownParts.push(generation.content);
      completedSections.push(...requiredSections);
      docModelRoute = generation.modelRoute;
      usage.push(generation.usage);
      if (checkpointRecord && generation.reason !== "checkpoint_reused") {
        const sectionPath = workflowArtifactPath(params.workflow, "sections", `${unitId}.md`);
        if (sectionPath) writeText(sectionPath, generation.content);
        checkpointRecord.doc.sections[unitId] = {
          status: "completed",
          stage: "full_document",
          batchIndex: "full",
          sections: requiredSections,
          artifactPath: sectionPath,
          artifactRelativePath: relativeWorkflowPath(params.workflow, sectionPath),
          retryCount: generation.workflowRetry?.retryCount ?? 0,
          attempts: generation.workflowRetry?.attempts ?? 1,
          provider: generation.modelRoute?.selected?.provider ?? null,
          model: generation.modelRoute?.selected?.model ?? null,
          updatedAt: nowIso(),
        };
        checkpointRecord.doc.completedSections = uniqueStrings([...(checkpointRecord.doc.completedSections ?? []), ...requiredSections]);
        writeCheckpoint(params.workflow);
      }
    } else if (checkpointRecord) {
      checkpointRecord.doc.sections[unitId] = {
        status: "failed",
        stage: "full_document",
        batchIndex: "full",
        sections: requiredSections,
        reason: generation.reason ?? "full_document_generation_failed",
        retryCount: generation.workflowRetry?.retryCount ?? 0,
        attempts: generation.workflowRetry?.attempts ?? 1,
        retryExhausted: generation.workflowRetry?.retryExhausted ?? false,
        retryBudgetExhausted: generation.workflowRetry?.retryBudgetExhausted ?? false,
        workUnitId: contextMeta.workUnitId,
        contextPackId: contextMeta.contextPackId,
        contextPackHash: contextMeta.contextPackHash,
        lastProviderAttempt: lastAttemptFailure(generation),
        updatedAt: nowIso(),
      };
      writeCheckpoint(params.workflow);
    }
  }

  let markdown = mergeMarkdown(markdownParts);
  const repairAttempts: any[] = [];
  let currentMissingSections = missingSections(markdown, requiredSections);
  let repairSequence = 0;
  for (let repairRound = 0; repairRound < params.maxRepairAttempts && currentMissingSections.length > 0 && markdown; repairRound += 1) {
    let repairedAnyInRound = false;
    const sectionsForRound = [...currentMissingSections];
    for (const section of sectionsForRound) {
      if (!currentMissingSections.includes(section)) continue;
      if (deadlineSnapshot(params.deadline).exhausted) {
        return deadlineBlockedResult({
          item,
          taskIndex,
          requiredSections,
          completedSections,
          sectionAttempts,
          repairAttempts,
          markdownParts: [markdown],
          traceRoot,
          deadline: params.deadline,
          stage: `before_repair_${repairSequence}`,
        });
      }
      const repairSections = [section];
      const contextMeta = contextMetadataForSections(item, repairSections);
      const prompt = buildSectionPrompt({
        item,
        sections: repairSections,
        completedSections: requiredSections.filter((required) => !currentMissingSections.includes(required)),
        repair: true,
        missingSections: repairSections,
      });
      const unitId = repairUnitKey(taskIndex, item.docType, repairSequence);
      const repair = await generateWithRetry({
        unitId,
        stage: "repair",
        docType: item.docType,
        sections: repairSections,
        workflow: params.workflow,
        prompt,
        initialRoute,
        candidates,
        mockResponse: params.mockResponse,
        temperature: params.temperature,
        maxTokens: params.maxTokens,
        modelTimeoutMs: params.modelTimeoutMs,
        captureModelStream: params.captureModelStream,
        traceRoot,
        deadline: params.deadline,
        traceMeta: {
          runId: params.runId,
          tool: "document_workers_run",
          docType: item.docType,
          promptFile: item.promptFile ?? null,
          taskIndex,
          batchIndex: `repair-${repairSequence}`,
          sections: repairSections,
          attemptKind: "repair",
          workUnitId: contextMeta.workUnitId,
          contextPackId: contextMeta.contextPackId,
          contextPackHash: contextMeta.contextPackHash,
          sourceSegmentIds: contextMeta.sourceSegmentIds,
          sourceBlockIds: contextMeta.sourceBlockIds,
          tableBlockCount: contextMeta.tableBlockCount,
          outputContractVersion: contextMeta.outputContractVersion,
          documentIdentityConfidence: contextMeta.documentIdentityConfidence,
          promptBudgetChars: contextMeta.promptBudgetChars,
          evidenceBudgetChars: contextMeta.evidenceBudgetChars,
          retrievalReasons: contextMeta.retrievalReasons,
        },
      });
      repairAttempts.push({
        repairIndex: repairSequence,
        repairRound,
        sections: repairSections,
        status: repair.status,
        provider: repair.modelRoute?.selected?.provider ?? null,
        model: repair.modelRoute?.selected?.model ?? null,
        fallbackOccurred: repair.modelRoute?.fallbackOccurred ?? false,
        reason: repair.reason ?? null,
        fallbackSkippedReason: repair.fallbackSkippedReason ?? null,
        deadline: repair.deadline ?? deadlineSnapshot(params.deadline),
        workUnitId: contextMeta.workUnitId,
        contextPackId: contextMeta.contextPackId,
        contextPackHash: contextMeta.contextPackHash,
        sourceSegmentIds: contextMeta.sourceSegmentIds,
        sourceBlockIds: contextMeta.sourceBlockIds,
        tableBlockCount: contextMeta.tableBlockCount,
        outputContractVersion: contextMeta.outputContractVersion,
        documentIdentityConfidence: contextMeta.documentIdentityConfidence,
        promptBudgetChars: contextMeta.promptBudgetChars,
        evidenceBudgetChars: contextMeta.evidenceBudgetChars,
        retrievalReasons: contextMeta.retrievalReasons,
        attemptFailures: repair.attemptFailures ?? [],
        streamTracePath: repair.streamTracePath ?? null,
        streamTraceSummaryPath: repair.streamTraceSummaryPath ?? null,
      });
      if (repair.status !== "completed") {
        if (checkpointRecord) {
          checkpointRecord.doc.repairs[unitId] = {
            status: "failed",
            stage: "repair",
            repairIndex: repairSequence,
            repairRound,
            sections: repairSections,
            reason: repair.reason ?? "repair_generation_failed",
            retryCount: repair.workflowRetry?.retryCount ?? 0,
            attempts: repair.workflowRetry?.attempts ?? 1,
            retryExhausted: repair.workflowRetry?.retryExhausted ?? false,
            retryBudgetExhausted: repair.workflowRetry?.retryBudgetExhausted ?? false,
            lastProviderAttempt: lastAttemptFailure(repair),
            updatedAt: nowIso(),
          };
          writeCheckpoint(params.workflow);
        }
        repairSequence += 1;
        continue;
      }
      markdown = mergeMarkdown([markdown, repair.content]);
      if (checkpointRecord) {
        const repairPath = workflowArtifactPath(params.workflow, "sections", `${unitId}.md`);
        if (repairPath) writeText(repairPath, repair.content);
        checkpointRecord.doc.repairs[unitId] = {
          status: "completed",
          stage: "repair",
          repairIndex: repairSequence,
          repairRound,
          sections: repairSections,
          artifactPath: repairPath,
          artifactRelativePath: relativeWorkflowPath(params.workflow, repairPath),
          retryCount: repair.workflowRetry?.retryCount ?? 0,
          attempts: repair.workflowRetry?.attempts ?? 1,
          updatedAt: nowIso(),
        };
        writeCheckpoint(params.workflow);
      }
      repairedAnyInRound = true;
      docModelRoute = docModelRoute ?? repair.modelRoute;
      usage.push(repair.usage);
      repairSequence += 1;
      currentMissingSections = missingSections(markdown, requiredSections);
    }
    if (!repairedAnyInRound) break;
  }

  const hasGeneratedMarkdown = Boolean(markdown);
  const status = !hasGeneratedMarkdown ? "blocked" : currentMissingSections.length > 0 ? "needs_fix" : "completed";
  const reason = !hasGeneratedMarkdown ? "no_section_batch_completed" : currentMissingSections.length > 0 ? "document_sections_missing_after_repair" : null;
  const openQuestions = extractOpenQuestions(markdown);
  let assemblyPath: string | null = null;
  let reviewPath: string | null = null;
  if (checkpointRecord) {
    if (markdown) {
      assemblyPath = workflowArtifactPath(params.workflow, "assembly", `task-${taskIndex}-${safeSegment(item.docType, "document")}.md`);
      if (assemblyPath) writeText(assemblyPath, markdown);
      checkpointRecord.doc.assembly = {
        status: "completed",
        artifactPath: assemblyPath,
        artifactRelativePath: relativeWorkflowPath(params.workflow, assemblyPath),
        contentChars: markdown.length,
        updatedAt: nowIso(),
      };
    }
    reviewPath = workflowArtifactPath(params.workflow, "reviews", `task-${taskIndex}-${safeSegment(item.docType, "document")}.json`);
    if (reviewPath) {
      writeJson(reviewPath, {
        schemaVersion: "document-workflow-review-v1",
        runId: params.runId ?? null,
        taskIndex,
        docType: item.docType,
        status: status === "completed" ? "pass" : status,
        missingSections: currentMissingSections,
        completedSections,
        upstreamDocumentsUsed: item.upstreamDocumentsUsed ?? [],
        missingUpstreamDocuments: item.missingUpstreamDocuments ?? [],
        absentUpstreamDocuments: item.absentUpstreamDocuments ?? [],
        retryUnitsUsed: Number(params.workflow?.checkpoint?.retry?.unitsUsed ?? 0),
        rawSecretsReturned: false,
      });
      checkpointRecord.doc.review = {
        status: status === "completed" ? "pass" : status,
        artifactPath: reviewPath,
        artifactRelativePath: relativeWorkflowPath(params.workflow, reviewPath),
        missingSections: currentMissingSections,
        updatedAt: nowIso(),
      };
    }
    checkpointRecord.doc.status = status;
    checkpointRecord.doc.reason = reason;
    checkpointRecord.doc.completedSections = completedSections;
    checkpointRecord.doc.missingSections = currentMissingSections;
    checkpointRecord.doc.updatedAt = nowIso();
    writeCheckpoint(params.workflow);
  }
  return {
    taskIndex,
    docType: item.docType,
    promptFile: item.promptFile ?? null,
    promptPath: item.promptPath ?? null,
    status,
    reason,
    dependsOn: item.dependsOn ?? [],
    audience: item.audience ?? null,
    upstreamDocumentsUsed: item.upstreamDocumentsUsed ?? [],
    missingUpstreamDocuments: item.missingUpstreamDocuments ?? [],
    absentUpstreamDocuments: item.absentUpstreamDocuments ?? [],
    contextPlane: item.contextPlane ?? null,
    workUnitCount: item.workUnits?.length ?? 0,
    contextPackIds: item.workUnits?.map((unit) => unit.contextPackId).filter(Boolean) ?? [],
    sourceBlockIds: uniqueStrings(item.workUnits?.flatMap((unit) => unit.sourceBlockIds ?? []) ?? []),
    tableBlockCount: item.workUnits?.reduce((sum, unit) => sum + Number(unit.tableBlockCount ?? 0), 0) ?? 0,
    outputContractVersion: item.workUnits?.find((unit) => unit.outputContractVersion)?.outputContractVersion ?? "document-output-contract-v1",
    documentIdentityConfidence: item.workUnits?.find((unit) => unit.documentIdentityConfidence)?.documentIdentityConfidence ?? null,
    modelRoute: docModelRoute ?? initialRoute,
    sectionBatching: params.sectionBatching,
    sectionsPerBatch: params.sectionsPerBatch,
    sectionBatches,
    sectionAttempts,
    repairAttempts,
    missingSections: currentMissingSections,
    traceRoot,
    attemptsPath: attemptsPathFor(traceRoot),
    workflow: params.workflow?.root ? {
      unitId: checkpointRecord?.key ?? null,
      checkpointPath: params.workflow.checkpointPath,
      retryLedgerPath: params.workflow.retryLedgerPath,
      assemblyPath,
      reviewPath,
      publishPartial: params.workflow.publishPartial,
      retryPolicy: params.workflow.retryPolicy,
      retryUnitsUsed: Number(params.workflow.checkpoint.retry?.unitsUsed ?? 0),
    } : null,
    deadline: deadlineSnapshot(params.deadline),
    markdown,
    usage,
    qaInput: {
      docType: item.docType,
      promptFile: item.promptFile ?? null,
      dependsOn: item.dependsOn ?? [],
      audience: item.audience ?? null,
      upstreamDocumentsUsed: item.upstreamDocumentsUsed ?? [],
      missingUpstreamDocuments: item.missingUpstreamDocuments ?? [],
      absentUpstreamDocuments: item.absentUpstreamDocuments ?? [],
      contextPlane: item.contextPlane ?? null,
      contextPackIds: item.workUnits?.map((unit) => unit.contextPackId).filter(Boolean) ?? [],
      sourceBlockIds: uniqueStrings(item.workUnits?.flatMap((unit) => unit.sourceBlockIds ?? []) ?? []),
      tableBlockCount: item.workUnits?.reduce((sum, unit) => sum + Number(unit.tableBlockCount ?? 0), 0) ?? 0,
      outputContractVersion: item.workUnits?.find((unit) => unit.outputContractVersion)?.outputContractVersion ?? "document-output-contract-v1",
      documentIdentityConfidence: item.workUnits?.find((unit) => unit.documentIdentityConfidence)?.documentIdentityConfidence ?? null,
      requiredSections,
      missingSections: currentMissingSections,
      markdown,
      unsupportedClaims: [],
      openQuestions,
    },
    rawSecretsReturned: false,
  };
}

function routeTaskTypeFor(item: DocumentWorkItem, params: {
  reasoningDepth?: "fast" | "deep";
  userRequestedDeepThinking?: boolean;
  estimatedComplexity?: "low" | "medium" | "high";
}) {
  if (item.docType === "meeting-minutes") return "meeting_minutes";
  const deepDocs = new Set(["prd", "tech-architecture", "ops-plan", "customer-requirement-checklist"]);
  if (
    params.reasoningDepth === "deep" ||
    params.userRequestedDeepThinking === true ||
    params.estimatedComplexity === "high" ||
    deepDocs.has(item.docType)
  ) {
    return "document_shard_deep";
  }
  return "document_shard_fast";
}

async function runLimited<T>(items: T[], maxWorkers: number, worker: (item: T, index: number) => Promise<any>) {
  const results = new Array(items.length);
  let next = 0;
  async function loop() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(maxWorkers, items.length) }, () => loop()));
  return results;
}

function aggregateStatus(results: any[]) {
  if (results.some((result) => result.status === "blocked")) return "blocked";
  if (results.some((result) => result.status === "needs_fix")) return "needs_fix";
  return "completed";
}

function summarizeWorkflow(workflow: WorkflowContext | null | undefined, results: any[]) {
  const docs = workflow?.checkpoint?.docs && typeof workflow.checkpoint.docs === "object"
    ? Object.values(workflow.checkpoint.docs)
    : [];
  const completedUnits = docs.flatMap((doc: any) =>
    Object.entries(doc.sections ?? {})
      .filter((_entry: any) => _entry[1]?.status === "completed")
      .map(([unitId, unit]: any) => ({ unitId, docType: doc.docType, stage: unit.stage ?? "section_draft" })),
  );
  const failedUnits = docs.flatMap((doc: any) =>
    [
      ...Object.entries(doc.sections ?? {}),
      ...Object.entries(doc.repairs ?? {}),
    ]
      .filter((_entry: any) => _entry[1]?.status === "failed")
      .map(([unitId, unit]: any) => ({
        unitId,
        docType: doc.docType,
        stage: unit.stage ?? "section_draft",
        reason: unit.reason ?? null,
        retryExhausted: Boolean(unit.retryExhausted),
      })),
  );
  const pendingUnits = results.flatMap((result: any) =>
    (result.missingSections ?? []).map((section: string) => ({
      docType: result.docType,
      stage: result.markdown ? "review" : "section_draft",
      section,
    })),
  );
  return {
    manifestPath: workflow?.root ? join(workflow.root, "manifest.json") : null,
    checkpointPath: workflow?.checkpointPath ?? null,
    retryLedgerPath: workflow?.retryLedgerPath ?? null,
    qualityMode: workflow?.qualityMode ?? "stable",
    workflowStrategy: workflow?.workflowStrategy ?? "checkpointed",
    publishPartial: workflow?.publishPartial === true,
    retryPolicy: workflow?.retryPolicy ?? { maxAttemptsPerUnit: DEFAULT_RETRY_ATTEMPTS_PER_UNIT, maxRetryUnits: DEFAULT_MAX_RETRY_UNITS },
    retryUnitsUsed: Number(workflow?.checkpoint?.retry?.unitsUsed ?? 0),
    completedUnits,
    pendingUnits,
    failedUnits,
    retryExhausted: failedUnits.some((unit: any) => unit.retryExhausted) ||
      Number(workflow?.checkpoint?.retry?.unitsUsed ?? 0) >= Number(workflow?.retryPolicy.maxRetryUnits ?? DEFAULT_MAX_RETRY_UNITS),
  };
}

function lastProviderAttemptFromResults(results: any[]) {
  for (const result of [...results].reverse()) {
    const attempts = [
      ...(Array.isArray(result?.repairAttempts) ? result.repairAttempts : []),
      ...(Array.isArray(result?.sectionAttempts) ? result.sectionAttempts : []),
    ];
    for (const attempt of attempts.reverse()) {
      const failures = Array.isArray(attempt?.attemptFailures) ? attempt.attemptFailures : [];
      const last = failures.at(-1);
      if (last) {
        return {
          docType: result.docType ?? null,
          batchIndex: attempt.batchIndex ?? attempt.repairIndex ?? null,
          provider: last.provider ?? attempt.provider ?? null,
          model: last.model ?? attempt.model ?? null,
          status: last.status ?? attempt.status ?? null,
          reason: last.reason ?? attempt.reason ?? null,
          httpStatus: last.httpStatus ?? null,
          timeoutMs: last.timeoutMs ?? null,
        };
      }
      if (attempt?.status && attempt.status !== "completed") {
        return {
          docType: result.docType ?? null,
          batchIndex: attempt.batchIndex ?? attempt.repairIndex ?? null,
          provider: attempt.provider ?? null,
          model: attempt.model ?? null,
          status: attempt.status,
          reason: attempt.reason ?? null,
          httpStatus: null,
          timeoutMs: null,
        };
      }
    }
  }
  return null;
}

function nextActionForFailure(reason: string | null, lastAttempt: any, retryExhausted: boolean) {
  if (lastAttempt?.reason === "model_provider_unavailable" || reason === "model_provider_unavailable") {
    return "检查本地 provider 配置后按 checkpoint 继续运行。";
  }
  if (lastAttempt?.reason === "model_provider_request_timeout" || reason === "document_worker_deadline_exhausted") {
    return retryExhausted ? "已按 checkpoint 重试但仍超时，建议稍后继续运行或切换 provider。" : "可按 checkpoint 继续运行未完成章节。";
  }
  if (reason === "document_sections_missing_after_repair") {
    return "按缺失章节执行 targeted repair 后再进入 QA/Policy。";
  }
  if (reason === "no_section_batch_completed") {
    return "检查 provider 可用性和输入材料后从最近 checkpoint 继续。";
  }
  return "保留本地 checkpoint，修复阻塞原因后继续运行。";
}

function buildFinalFailureReport(results: any[], workflowSummary: any, status: string) {
  if (status === "completed") return null;
  const failed = results.find((result: any) => result?.status === "blocked") ??
    results.find((result: any) => result?.status === "needs_fix") ??
    null;
  const lastAttempt = lastProviderAttemptFromResults(results);
  const terminalReason = failed?.reason ?? workflowSummary?.failedUnits?.[0]?.reason ?? "document_workflow_not_completed";
  const completedDocs = results
    .filter((result: any) => result?.status === "completed")
    .map((result: any) => result.docType)
    .filter(Boolean);
  const pendingDocs = results
    .filter((result: any) => result?.status !== "completed")
    .map((result: any) => ({
      docType: result.docType,
      status: result.status,
      reason: result.reason ?? null,
      missingSections: result.missingSections ?? [],
    }));
  return {
    schemaVersion: "document-workflow-final-failure-v1",
    terminalReason,
    status,
    completedDocs,
    pendingDocs,
    failedStage: failed?.deadlineStage ?? workflowSummary?.failedUnits?.[0]?.stage ?? (failed?.markdown ? "review" : "section_draft"),
    retryCount: Number(workflowSummary?.retryUnitsUsed ?? 0),
    retryExhausted: Boolean(workflowSummary?.retryExhausted),
    lastProviderAttempt: lastAttempt,
    nextAction: nextActionForFailure(terminalReason, lastAttempt, Boolean(workflowSummary?.retryExhausted)),
    publishPartial: false,
    rawSecretsReturned: false,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "document_workers_plan",
    label: "Document Workers Plan",
    description: "Plan bounded context-pack document work units from prompt registry outputs.",
    parameters: Type.Object({
      documentWorkItems: Type.Array(Type.Any()),
      maxWorkers: Type.Optional(Type.Number()),
      sectionBatching: Type.Optional(Type.Boolean()),
      sectionsPerBatch: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params) {
      const documentWorkItems = normalizeDocumentWorkItems(params.documentWorkItems);
      const sectionsPerBatch = effectiveSectionsPerBatch(params.sectionsPerBatch);
      const sectionBatching = params.sectionBatching !== false;
      const dependencyPlan = dependencyWaves(documentWorkItems);
      const blockingIssues = documentWorkItems.map((item, taskIndex) => ({ taskIndex, reason: contextPlaneIssue(item) })).filter((item) => item.reason);
      const waveByTaskIndex = new Map<number, number>();
      for (const wave of dependencyPlan.waves) {
        for (const taskIndex of wave.taskIndexes) {
          waveByTaskIndex.set(taskIndex, wave.waveIndex);
        }
      }
      const ready = documentWorkItems.length > 0 && blockingIssues.length === 0;
      const details = {
        status: ready ? "ready" : "blocked",
        reason: ready ? "context_work_units_ready" : (blockingIssues[0]?.reason ?? "context_work_units_required"),
        blockingIssues,
        maxWorkers: effectiveMaxWorkers(params.maxWorkers),
        sectionBatching,
        sectionsPerBatch,
        tasks: documentWorkItems.slice(0, MAX_DOCUMENT_WORK_ITEMS).map((item, taskIndex) => ({
          taskIndex,
          executionWave: waveByTaskIndex.get(taskIndex) ?? 0,
          componentId: "document_worker",
          docType: item.docType,
          promptFile: item.promptFile ?? null,
          promptInstructionChars: item.promptInstructionChars ?? String(item.promptInstructions ?? "").length,
          dependsOn: item.dependsOn ?? [],
          audience: item.audience ?? null,
          requiredSections: item.requiredSections ?? [],
          contextPlane: item.contextPlane ?? null,
          workUnitCount: item.workUnits?.length ?? 0,
          contextPackIds: item.workUnits?.map((unit) => unit.contextPackId).filter(Boolean) ?? [],
          sectionBatches: sectionBatching ? chunkSections(item.requiredSections ?? [], sectionsPerBatch) : [],
        })),
        executionWaves: dependencyPlan.waves.map((wave) => ({
          waveIndex: wave.waveIndex,
          taskIndexes: wave.taskIndexes,
          docTypes: wave.taskIndexes.map((taskIndex) => documentWorkItems[taskIndex]?.docType),
        })),
        dependencyCycleDetected: dependencyPlan.dependencyCycleDetected,
        permanentRolesPreloaded: false,
        hardcodedDocumentScaffoldUsed: false,
        rawSecretsReturned: false,
      };
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });

  pi.registerTool({
    name: "document_workers_run",
    label: "Document Workers Run",
    description: "Run bounded document work units through model providers in parallel and return per-document Markdown plus QA input.",
    parameters: Type.Object({
      runId: Type.String(),
      documentWorkItems: Type.Array(Type.Any()),
      maxWorkers: Type.Optional(Type.Number()),
      unavailableProviders: Type.Optional(Type.Array(Type.String())),
      mockProvider: Type.Optional(Type.Boolean()),
      mockResponse: Type.Optional(Type.String()),
      temperature: Type.Optional(Type.Number()),
      maxTokens: Type.Optional(Type.Number()),
      reasoningDepth: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("deep")])),
      userRequestedDeepThinking: Type.Optional(Type.Boolean()),
      estimatedComplexity: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
      outputRoot: Type.Optional(Type.String()),
      sectionBatching: Type.Optional(Type.Boolean()),
      sectionsPerBatch: Type.Optional(Type.Number()),
      maxRepairAttempts: Type.Optional(Type.Number()),
      modelTimeoutMs: Type.Optional(Type.Number()),
      captureModelStream: Type.Optional(Type.Boolean()),
      deadlineAt: Type.Optional(Type.String()),
      runtimeBudgetMs: Type.Optional(Type.Number()),
      deadlineReserveMs: Type.Optional(Type.Number()),
      qualityMode: Type.Optional(Type.Union([Type.Literal("stable"), Type.Literal("balanced"), Type.Literal("fast")])),
      workflowStrategy: Type.Optional(Type.Union([Type.Literal("checkpointed"), Type.Literal("single_pass")])),
      resumeFromCheckpoint: Type.Optional(Type.Boolean()),
      publishPartial: Type.Optional(Type.Boolean()),
      retryPolicy: Type.Optional(Type.Any()),
    }),
    async execute(_toolCallId, params) {
      try {
        const documentWorkItems = normalizeDocumentWorkItems(params.documentWorkItems);
        if (documentWorkItems.length === 0) {
          const blocked = { status: "blocked", reason: "document_work_items_required", rawSecretsReturned: false };
          return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
        }
        if (documentWorkItems.length > MAX_DOCUMENT_WORK_ITEMS) {
          const blocked = { status: "blocked", reason: "too_many_document_work_items", maxDocumentWorkItems: MAX_DOCUMENT_WORK_ITEMS };
          return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
        }
        const blockingIssues = documentWorkItems.map((item, taskIndex) => ({ taskIndex, reason: contextPlaneIssue(item) })).filter((item) => item.reason);
        if (blockingIssues.length > 0) {
          const blocked = { status: "blocked", reason: blockingIssues[0].reason === "context_pack_missing" ? "context_pack_missing" : "context_plane_required", blockingIssues, rawSecretsReturned: false };
          return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
        }
        const maxWorkers = effectiveMaxWorkers(params.maxWorkers);
        const sectionBatching = params.sectionBatching !== false;
        const sectionsPerBatch = effectiveSectionsPerBatch(params.sectionsPerBatch);
        const maxRepairAttempts = effectiveRepairAttempts(params.maxRepairAttempts);
        const deadline = deadlineContext({
          deadlineAt: params.deadlineAt,
          runtimeBudgetMs: params.runtimeBudgetMs,
          deadlineReserveMs: params.deadlineReserveMs,
        });
        const workflow = workflowContext({
          runId: params.runId,
          outputRoot: params.outputRoot,
          qualityMode: params.qualityMode,
          workflowStrategy: params.workflowStrategy,
          resumeFromCheckpoint: params.resumeFromCheckpoint,
          publishPartial: params.publishPartial,
          retryPolicy: params.retryPolicy,
        });
        const dependencyPlan = dependencyWaves(documentWorkItems);
        const completedByDocType = new Map<string, any>();
        const results: any[] = new Array(documentWorkItems.length);
        for (const wave of dependencyPlan.waves) {
          const waveTasks = wave.taskIndexes.map((taskIndex) => ({ taskIndex, item: documentWorkItems[taskIndex] }));
          const waveResults = await runLimited(waveTasks, maxWorkers, (task) =>
            generateOne({
              item: injectUpstreamDocuments(task.item, completedByDocType, dependencyPlan.presentDocTypes),
              taskIndex: task.taskIndex,
              unavailableProviders: params.unavailableProviders ?? [],
              mockProvider: params.mockProvider === true,
              mockResponse: params.mockResponse,
              temperature: params.temperature,
              maxTokens: params.maxTokens,
              reasoningDepth: params.reasoningDepth,
              userRequestedDeepThinking: params.userRequestedDeepThinking,
              estimatedComplexity: params.estimatedComplexity,
              sectionBatching,
              sectionsPerBatch,
              maxRepairAttempts,
              runId: params.runId,
              outputRoot: params.outputRoot,
              modelTimeoutMs: params.modelTimeoutMs,
              captureModelStream: params.captureModelStream !== false,
              deadline,
              workflow,
            }),
          );
          for (const result of waveResults) {
            results[result.taskIndex] = { ...result, executionWave: wave.waveIndex };
            if (result?.markdown && ["completed", "needs_fix"].includes(String(result.status))) {
              completedByDocType.set(result.docType, result);
            }
          }
        }
        const orderedResults = results.sort((a, b) => a.taskIndex - b.taskIndex);
        const workflowSummary = summarizeWorkflow(workflow, orderedResults);
        if (workflowSummary.manifestPath) {
          writeJson(workflowSummary.manifestPath, {
            schemaVersion: "document-workflow-manifest-v1",
            runId: params.runId,
            status: aggregateStatus(orderedResults),
            qualityMode: workflow.qualityMode,
            workflowStrategy: workflow.workflowStrategy,
            publishPartial: false,
            checkpointPath: workflow.checkpointPath,
            retryLedgerPath: workflow.retryLedgerPath,
            completedUnits: workflowSummary.completedUnits,
            pendingUnits: workflowSummary.pendingUnits,
            failedUnits: workflowSummary.failedUnits,
            retryUnitsUsed: workflowSummary.retryUnitsUsed,
            retryPolicy: workflow.retryPolicy,
            rawSecretsReturned: false,
          });
        }
        const modelRoutes = orderedResults.map((result) => ({
          taskIndex: result.taskIndex,
          executionWave: result.executionWave ?? 0,
          docType: result.docType,
          promptFile: result.promptFile ?? null,
          status: result.status,
          dependsOn: result.dependsOn ?? [],
          upstreamDocumentsUsed: result.upstreamDocumentsUsed ?? [],
          missingUpstreamDocuments: result.missingUpstreamDocuments ?? [],
          absentUpstreamDocuments: result.absentUpstreamDocuments ?? [],
          modelRoute: result.modelRoute ?? null,
          sectionBatches: result.sectionBatches ?? [],
          sectionAttempts: result.sectionAttempts ?? [],
          repairAttempts: result.repairAttempts ?? [],
          missingSections: result.missingSections ?? [],
          attemptFailures: result.attemptFailures ?? [],
        }));
        const routeTaskTypes = [
          ...new Set(modelRoutes.map((item) => item.modelRoute?.resolvedTaskType ?? item.modelRoute?.taskType).filter(Boolean)),
        ];
        const modelRoutePath = recordRouteArtifact(params.runId, {
          taskType: routeTaskTypes.length === 1 ? routeTaskTypes[0] : "document_shard",
          workerRouteTaskTypes: routeTaskTypes,
          documentRoutes: modelRoutes,
          documentWorkerRuntime: "document_workers_run",
          executionWaves: dependencyPlan.waves.map((wave) => ({
            waveIndex: wave.waveIndex,
            taskIndexes: wave.taskIndexes,
            docTypes: wave.taskIndexes.map((taskIndex) => documentWorkItems[taskIndex]?.docType),
          })),
          dependencyCycleDetected: dependencyPlan.dependencyCycleDetected,
          sectionBatching,
          sectionsPerBatch,
          maxRepairAttempts,
          qualityMode: workflow.qualityMode,
          workflowStrategy: workflow.workflowStrategy,
          publishPartial: false,
          retryPolicy: workflow.retryPolicy,
          workflow,
          deadlineAt: deadline.deadlineAt,
          runtimeBudgetMs: deadline.runtimeBudgetMs,
          deadlineReserveMs: deadline.deadlineReserveMs,
        }, params.outputRoot);
        const status = aggregateStatus(orderedResults);
        const finalFailureReport = buildFinalFailureReport(orderedResults, workflowSummary, status);
        const details = {
          status,
          runId: params.runId,
          reason: orderedResults.some((result) => result?.reason === "document_worker_deadline_exhausted") ? "document_worker_deadline_exhausted" : null,
          maxWorkers,
          sectionBatching,
          sectionsPerBatch,
          maxRepairAttempts,
          traceRoot: traceRootFor(params.runId, params.outputRoot),
          attemptsPath: attemptsPathFor(traceRootFor(params.runId, params.outputRoot)),
          deadlineAt: deadline.deadlineAt,
          runtimeBudgetMs: deadline.runtimeBudgetMs,
          deadlineReserveMs: deadline.deadlineReserveMs,
          deadline: deadlineSnapshot(deadline),
          executionWaves: dependencyPlan.waves.map((wave) => ({
            waveIndex: wave.waveIndex,
            taskIndexes: wave.taskIndexes,
            docTypes: wave.taskIndexes.map((taskIndex) => documentWorkItems[taskIndex]?.docType),
          })),
          dependencyCycleDetected: dependencyPlan.dependencyCycleDetected,
          modelRoutePath,
          workflow: workflowSummary,
          finalFailureReport,
          results: orderedResults,
          rawSecretsReturned: false,
          hardcodedDocumentScaffoldUsed: false,
        };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      } catch (error) {
        const blocked = {
          status: "blocked",
          reason: error instanceof Error ? error.message : String(error),
          runId: params.runId,
          rawSecretsReturned: false,
        };
        return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
      }
    },
  });
}
