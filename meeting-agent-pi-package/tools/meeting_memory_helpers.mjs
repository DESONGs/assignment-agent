import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const MEETING_MEMORY_SCHEMA_VERSION = "meeting-memory-candidates-v1";
export const MEETING_MEMORY_RESULT_VERSION = "meeting-memory-curation-result-v1";

const ALLOWED_TYPES = new Set([
  "project_fact",
  "decision",
  "participant_identity",
  "terminology",
  "open_question",
]);

export const MEETING_MEMORY_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    schemaVersion: { type: "string", enum: [MEETING_MEMORY_SCHEMA_VERSION] },
    summary: { type: "string" },
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...ALLOWED_TYPES] },
          memoryKey: { type: "string" },
          content: { type: "string" },
          rationale: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium"] },
          sourceClaimIds: { type: "array", items: { type: "string" } },
          evidenceSegmentIds: { type: "array", items: { type: "string" } },
        },
        required: ["type", "memoryKey", "content", "rationale", "confidence", "sourceClaimIds", "evidenceSegmentIds"],
        additionalProperties: false,
      },
    },
    excluded: {
      type: "array",
      items: {
        type: "object",
        properties: {
          reason: { type: "string" },
          content: { type: "string" },
          detail: { type: "string" },
        },
        required: ["reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["schemaVersion", "summary", "candidates", "excluded"],
  additionalProperties: false,
};

/**
 * @typedef {{ claimId: string, text: string, claimType: string, status: string, evidenceQuality: string, evidenceSegmentIds: string[], [key: string]: unknown }} MemorySourceClaim
 * @typedef {{ memoryKey: string | null, content: string }} IdentityCandidate
 * @typedef {{
 *   candidateIndex: number, type: string, memoryKey: string, content: string, rationale: string,
 *   confidence: string, sourceClaimIds: string[], evidenceSegmentIds: string[], invalidSegmentIds: string[],
 *   sourceRunId: string, fingerprint: string
 * }} AcceptedMemoryCandidate
 */

/** @param {unknown} value @returns {Record<string, unknown>} */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @param {unknown} value @returns {unknown[]} */
function list(value) {
  return Array.isArray(value) ? value : [];
}

/** @param {unknown} value @param {number} [maxChars] */
function cleanText(value, maxChars = 600) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

/** @param {unknown} values @param {number} [limit] */
function uniqueStrings(values, limit = 100) {
  return [...new Set(list(values).map((value) => cleanText(value, 180)).filter(Boolean))].slice(0, limit);
}

/** @param {unknown} value */
function jsStringLiteral(value) {
  return JSON.stringify(String(value ?? ""))
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** @param {string} type @param {string} memoryKey @param {string} content */
function fingerprint(type, memoryKey, content) {
  return createHash("sha256").update(`${type}\n${memoryKey}\n${content}`).digest("hex");
}

/** @param {unknown} value */
function safeMemoryKey(value) {
  const key = cleanText(value, 120).toLowerCase();
  return /^[a-z0-9][a-z0-9._:-]{2,119}$/.test(key) ? key : null;
}

/** @param {unknown} value */
function containsCredentialMarker(value) {
  return /(?:api[_ -]?key|authorization|bearer\s+[a-z0-9._-]+|app[_ -]?secret|cookie|session[_ -]?token|access[_ -]?key[_ -]?secret|signed[_ -]?url)/iu.test(String(value ?? ""));
}

/** @param {unknown} value */
function groundingTokens(value) {
  const text = String(value ?? "").toLowerCase();
  const tokens = new Set(text.match(/[a-z0-9][a-z0-9._-]+/gu) ?? []);
  for (const group of text.match(/[\p{Script=Han}]+/gu) ?? []) {
    if (group.length === 1) tokens.add(group);
    for (let index = 0; index < group.length - 1; index += 1) tokens.add(group.slice(index, index + 2));
  }
  return [...tokens];
}

/** @param {string} content @param {MemorySourceClaim[]} sourceClaims */
function contentGroundedInClaims(content, sourceClaims) {
  const candidateTokens = groundingTokens(content);
  if (candidateTokens.length === 0) return false;
  const sourceTokens = new Set(groundingTokens(sourceClaims.map((claim) => claim.text).join(" ")));
  const matched = candidateTokens.filter((token) => sourceTokens.has(token)).length;
  return matched / candidateTokens.length >= 0.5;
}

/** @param {string} workspaceDir @param {string} value */
function workspacePath(workspaceDir, value) {
  const root = resolve(workspaceDir);
  const path = resolve(root, value);
  const rel = relative(root, path);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("meeting_memory_path_outside_workspace");
  return path;
}

/** @param {{ runId: string, meetingAnalysisPath: string, meetingMinutesPath: string, qaGatePath: string, transcriptPath: string, participantMapPath: string }} input */
export function buildMeetingMemoryCuratorPlan({
  runId,
  meetingAnalysisPath,
  meetingMinutesPath,
  qaGatePath,
  transcriptPath,
  participantMapPath,
}) {
  const task = [
    `当前 run：${runId}`,
    `会议分析：${meetingAnalysisPath}`,
    `最终会议纪要：${meetingMinutesPath}`,
    `QA 结果：${qaGatePath}`,
    `完整转录：${transcriptPath}`,
    `参会人映射：${participantMapPath}`,
    "只读取以上文件。提炼少量可跨后续会议复用的长期记忆候选。",
    "project_fact、decision、terminology 和 open_question 必须同时引用 Meeting Intelligence source claim id 与当前转录 segment id。",
    "participant_identity 只能来自 participant map 的 user_confirmed 映射。",
    "排除临时行动、普通讨论、未经确认提议、needs_review 证据、长段原文和凭证。",
    `最终响应只能是一个原始 JSON 对象，不要 Markdown 代码围栏。schemaVersion 必须是 ${MEETING_MEMORY_SCHEMA_VERSION}。`,
    "顶层必须包含 schemaVersion、summary、candidates、excluded；每个 candidate 必须包含 type、memoryKey、content、rationale、confidence、sourceClaimIds、evidenceSegmentIds。",
  ].join("\n");
  const workflowScript = [
    `const curated = await runs.run("meeting-memory-curation", { agent: "meeting-memory-curator", task: ${jsStringLiteral(task)}, acceptance: { level: "none", reason: "父 Agent 对候选执行确定性 schema、claim 与 segment 校验。" } });`,
    "return curated;",
  ].join("\n");
  return {
    schemaVersion: "meeting-memory-curation-plan-v1",
    mode: "single_subagent",
    reason: "会议与纪要已通过 QA，按需唤醒持久记忆角色；不启动常驻模型进程或 workflow。",
    runId,
    sources: { meetingAnalysisPath, meetingMinutesPath, qaGatePath, transcriptPath, participantMapPath },
    executor: {
      package: "pi-subagents",
      version: "0.46.0",
      tool: "subagent",
      request: {
        workflowScript,
        context: "fresh",
        async: false,
        mission: false,
        agentScope: "project",
        includeProgress: false,
      },
      outputContract: MEETING_MEMORY_OUTPUT_SCHEMA,
      structuredOutputMode: "parent_validated_json",
    },
    parentAuthority: "父 Agent 校验证据、去重、处理冲突并持久化；子 Agent 无写权限。",
    rawSecretsReturned: false,
  };
}

/** @param {{ workspaceDir: string, packageDir: string, planPath: string, provider: string, model: string, piCodingAgentDir: string }} input */
export function buildPiMeetingMemoryInvocation({ workspaceDir, packageDir, planPath, provider, model, piCodingAgentDir }) {
  const prompt = [
    "读取可信的会议记忆提炼计划：" + planPath,
    "必须且只能调用一次 subagent，参数严格采用 executor.request。",
    "不要调用 workflow、bash、edit、write、发布或通知工具。",
    "工具完成后只简要返回真实状态；不得把未执行的提炼声称为成功。",
  ].join("\n");
  return {
    command: process.execPath,
    args: [
      join(packageDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
      "--mode", "json",
      "--print",
      "--no-session",
      "--approve",
      "--provider", provider,
      "--model", model,
      "--thinking", "medium",
      "--tools", "read,subagent",
      prompt,
    ],
    cwd: workspaceDir,
    env: { PI_CODING_AGENT_DIR: piCodingAgentDir },
    prompt,
  };
}

/** @param {unknown} value */
export function extractMeetingMemoryPayload(value) {
  /** @type {Set<object>} */
  const seen = new Set();
  /** @param {unknown} item @param {number} [depth] @returns {Record<string, unknown> | null} */
  function visit(item, depth = 0) {
    if (depth > 12 || item === null || item === undefined) return null;
    if (typeof item === "string") {
      const text = item.trim();
      const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1]?.trim();
      const firstBrace = text.indexOf("{");
      const lastBrace = text.lastIndexOf("}");
      const candidate = fenced ?? (firstBrace >= 0 && lastBrace > firstBrace ? text.slice(firstBrace, lastBrace + 1) : text);
      if (!candidate.startsWith("{") && !candidate.startsWith("[")) return null;
      try { return visit(JSON.parse(candidate), depth + 1); } catch { return null; }
    }
    if (typeof item !== "object" || seen.has(item)) return null;
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) {
        const found = visit(child, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (meetingMemoryPayloadShapeValid(item)) return item;
    const record = asRecord(item);
    const preferredKeys = ["structuredOutput", "value", "result", "details", "output", "results"];
    for (const key of preferredKeys) {
      if (key in record) {
        const found = visit(record[key], depth + 1);
        if (found) return found;
      }
    }
    for (const child of Object.values(record)) {
      const found = visit(child, depth + 1);
      if (found) return found;
    }
    return null;
  }
  return visit(value);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** @param {Record<string, unknown>} value @param {Set<string>} allowed */
function onlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

/** @param {unknown} payload @returns {payload is Record<string, unknown>} */
export function meetingMemoryPayloadShapeValid(payload) {
  if (!plainObject(payload)) return false;
  if (!onlyKeys(payload, new Set(["schemaVersion", "summary", "candidates", "excluded"]))) return false;
  if (payload.schemaVersion !== MEETING_MEMORY_SCHEMA_VERSION || typeof payload.summary !== "string") return false;
  if (!Array.isArray(payload.candidates) || payload.candidates.length > 80) return false;
  if (!Array.isArray(payload.excluded) || payload.excluded.length > 80) return false;
  const candidateKeys = new Set(["type", "memoryKey", "content", "rationale", "confidence", "sourceClaimIds", "evidenceSegmentIds"]);
  for (const candidate of payload.candidates) {
    if (!plainObject(candidate) || !onlyKeys(candidate, candidateKeys)) return false;
    if (!ALLOWED_TYPES.has(String(candidate.type ?? ""))) return false;
    if (!["memoryKey", "content", "rationale", "confidence"].every((key) => typeof candidate[key] === "string")) return false;
    if (!new Set(["high", "medium"]).has(String(candidate.confidence ?? ""))) return false;
    if (![candidate.sourceClaimIds, candidate.evidenceSegmentIds].every((values) => Array.isArray(values) && values.every((item) => typeof item === "string"))) return false;
  }
  const excludedKeys = new Set(["reason", "content", "detail"]);
  for (const item of payload.excluded) {
    if (!plainObject(item) || !onlyKeys(item, excludedKeys) || typeof item.reason !== "string") return false;
    if (item.content !== undefined && typeof item.content !== "string") return false;
    if (item.detail !== undefined && typeof item.detail !== "string") return false;
  }
  return true;
}

/** @param {unknown} meetingAnalysis @returns {Map<string, MemorySourceClaim>} */
function evidenceIndexes(meetingAnalysis) {
  /** @type {Map<string, MemorySourceClaim>} */
  const claimsById = new Map();
  for (const value of list(asRecord(meetingAnalysis).evidenceMap)) {
    const claim = asRecord(value);
    if (!claim.claimId) continue;
    claimsById.set(String(claim.claimId), /** @type {MemorySourceClaim} */ ({
      ...claim,
      claimId: String(claim.claimId),
      text: String(claim.text ?? ""),
      claimType: String(claim.claimType ?? ""),
      status: String(claim.status ?? ""),
      evidenceQuality: String(claim.evidenceQuality ?? ""),
      evidenceSegmentIds: uniqueStrings(claim.evidenceSegmentIds, 200),
    }));
  }
  return claimsById;
}

/** @param {IdentityCandidate} candidate @param {unknown} meetingAnalysis */
function participantIdentityValid(candidate, meetingAnalysis) {
  const participants = list(asRecord(asRecord(meetingAnalysis).participantResolution).participants).map(asRecord);
  return participants.some((participant) => participant.nameStatus === "user_confirmed"
    && candidate.memoryKey === `participant:${String(participant.alias ?? "").replace(/^参会人\s*/u, "").toLowerCase()}`
    && candidate.content.includes(String(participant.alias))
    && candidate.content.includes(String(participant.displayName)));
}

/** @param {unknown} payload @param {{ meetingAnalysis: unknown, knownSegmentIds?: unknown[], runId: string }} options */
export function reconcileMeetingMemoryCandidates(payload, { meetingAnalysis, knownSegmentIds = [], runId }) {
  /** @type {AcceptedMemoryCandidate[]} */
  const accepted = [];
  /** @type {Array<Record<string, unknown>>} */
  const rejected = [];
  const normalizedPayload = asRecord(payload);
  if (normalizedPayload.schemaVersion !== MEETING_MEMORY_SCHEMA_VERSION) {
    return { schemaVersion: MEETING_MEMORY_RESULT_VERSION, status: "blocked", reason: "memory_payload_missing_or_invalid", accepted, rejected, runId };
  }
  const known = new Set(uniqueStrings(knownSegmentIds, 20_000));
  const claimsById = evidenceIndexes(meetingAnalysis);
  for (const [index, value] of list(normalizedPayload.candidates).slice(0, 80).entries()) {
    const raw = asRecord(value);
    const type = cleanText(raw.type, 40);
    const memoryKey = safeMemoryKey(raw.memoryKey);
    const content = cleanText(raw.content, 600);
    const rationale = cleanText(raw.rationale, 500);
    const confidence = cleanText(raw.confidence, 20);
    const sourceClaimIds = uniqueStrings(raw.sourceClaimIds, 40);
    const evidenceSegmentIds = uniqueStrings(raw.evidenceSegmentIds, 100);
    /** @type {string[]} */
    const reasons = [];
    if (!ALLOWED_TYPES.has(type)) reasons.push("memory_type_not_allowed");
    if (!memoryKey) reasons.push("memory_key_invalid");
    if (!content) reasons.push("memory_content_empty");
    if (containsCredentialMarker(`${content} ${rationale}`)) reasons.push("credential_like_content_blocked");
    if (confidence !== "high") reasons.push("memory_confidence_not_high");
    const invalidSegmentIds = evidenceSegmentIds.filter((id) => !known.has(id));
    if (invalidSegmentIds.length > 0) reasons.push("segment_outside_current_meeting");
    if (type === "participant_identity") {
      if (sourceClaimIds.length > 0) reasons.push("participant_identity_must_use_explicit_mapping");
      if (evidenceSegmentIds.length > 0) reasons.push("participant_identity_must_use_explicit_mapping");
      if (!participantIdentityValid({ memoryKey, content }, meetingAnalysis)) reasons.push("participant_identity_not_user_confirmed");
    } else {
      if (sourceClaimIds.length === 0) reasons.push("source_claim_ids_required");
      if (evidenceSegmentIds.length === 0) reasons.push("evidence_segment_ids_required");
      const sourceClaims = sourceClaimIds.flatMap((id) => {
        const claim = claimsById.get(id);
        return claim ? [claim] : [];
      });
      if (sourceClaims.length !== sourceClaimIds.length) reasons.push("source_claim_not_found");
      const claimTypesAllowed = type === "decision"
        ? new Set(["decision"])
        : type === "open_question"
          ? new Set(["open_question"])
          : new Set(["core_judgment", "decision"]);
      if (sourceClaims.some((claim) => !claimTypesAllowed.has(claim.claimType))) reasons.push("source_claim_type_not_allowed");
      if (sourceClaims.some((claim) => type === "open_question"
        ? claim.status !== "open" || claim.evidenceQuality !== "ready"
        : claim.status !== "supported" || claim.evidenceQuality !== "ready")) {
        reasons.push("source_claim_not_memory_ready");
      }
      if (sourceClaims.length > 0 && !contentGroundedInClaims(content, sourceClaims)) reasons.push("memory_content_not_grounded_in_source_claim");
      const sourceEvidenceIds = new Set(sourceClaims.flatMap((claim) => claim.evidenceSegmentIds));
      if (evidenceSegmentIds.some((id) => !sourceEvidenceIds.has(id))) reasons.push("evidence_not_owned_by_source_claim");
    }
    const normalized = {
      candidateIndex: index,
      type,
      memoryKey,
      content,
      rationale,
      confidence,
      sourceClaimIds,
      evidenceSegmentIds,
      invalidSegmentIds,
      sourceRunId: runId,
    };
    if (reasons.length > 0) rejected.push({ ...normalized, reasons: [...new Set(reasons)] });
    else if (memoryKey) accepted.push({ ...normalized, memoryKey, fingerprint: fingerprint(type, memoryKey, content) });
  }
  return {
    schemaVersion: MEETING_MEMORY_RESULT_VERSION,
    status: rejected.length > 0 ? "needs_review" : "accepted",
    reason: rejected.length > 0 ? "some_memory_candidates_rejected" : null,
    summary: cleanText(normalizedPayload.summary, 700),
    accepted,
    rejected,
    excluded: list(normalizedPayload.excluded).slice(0, 80),
    runId,
  };
}

/** @param {string} path @returns {Array<Record<string, unknown>>} */
function readLedger(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

/** @param {string} path @param {string} text */
function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

/** @param {unknown} error */
function errorCode(error) {
  const code = asRecord(error).code;
  return typeof code === "string" ? code : null;
}

/** @template T @param {string} memoryDir @param {() => T} operation @returns {T} */
function withMemoryWriteLock(memoryDir, operation) {
  mkdirSync(memoryDir, { recursive: true });
  const lockPath = join(memoryDir, ".write.lock");
  const deadline = Date.now() + 5000;
  let descriptor = null;
  while (descriptor === null) {
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 60_000) {
          unlinkSync(lockPath);
          continue;
        }
      } catch (lockError) {
        if (errorCode(lockError) !== "ENOENT") throw lockError;
        continue;
      }
      if (Date.now() >= deadline) throw new Error("meeting_memory_write_lock_timeout");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return operation();
  } finally {
    closeSync(descriptor);
    try { unlinkSync(lockPath); } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  }
}

/** @param {Array<Record<string, unknown>>} entries */
function renderMemory(entries) {
  const sections = [
    ["participant_identity", "已确认参会人"],
    ["project_fact", "项目事实"],
    ["decision", "长期决定"],
    ["terminology", "稳定术语"],
    ["open_question", "持续开放问题"],
  ];
  const lines = [
    "# Meeting Memory",
    "",
    "> 由父 Agent 根据已通过 QA 的会议证据维护。原始会议事实仍以 run artifacts 为准。",
  ];
  for (const [type, title] of sections) {
    const values = entries.filter((entry) => entry.type === type);
    if (values.length === 0) continue;
    lines.push("", `## ${title}`, "");
    for (const entry of values) {
      const evidenceIds = uniqueStrings(entry.evidenceSegmentIds, 100);
      const claimIds = uniqueStrings(entry.sourceClaimIds, 40);
      const evidence = evidenceIds.length > 0 ? `；证据：${evidenceIds.join(", ")}` : "；来源：用户显式映射";
      const claims = claimIds.length > 0 ? `；claims：${claimIds.join(", ")}` : "";
      lines.push(`- [${entry.memoryKey}] ${entry.content}（run: ${entry.sourceRunId}${claims}${evidence}）`);
    }
  }
  return `${lines.slice(0, 200).join("\n")}\n`;
}

/** @param {unknown} reconciliation @param {{ workspaceDir: string, memoryRelativeDir?: string, now?: string }} options */
export function persistMeetingMemory(reconciliation, { workspaceDir, memoryRelativeDir = ".pi/agent-memory/meeting-memory", now = new Date().toISOString() }) {
  const normalizedReconciliation = asRecord(reconciliation);
  const memoryDir = workspacePath(workspaceDir, memoryRelativeDir);
  return withMemoryWriteLock(memoryDir, () => {
    const ledgerPath = join(memoryDir, "ledger.jsonl");
    const conflictLedgerPath = join(memoryDir, "conflicts.jsonl");
    const memoryPath = join(memoryDir, "MEMORY.md");
    const existing = readLedger(ledgerPath).filter((entry) => entry?.status === "accepted");
    const byFingerprint = new Set(existing.map((entry) => String(entry.fingerprint ?? "")).filter(Boolean));
    const byKey = new Map(existing.map((entry) => [entry.memoryKey, entry]));
    /** @type {Array<Record<string, unknown>>} */
    const persisted = [];
    /** @type {Array<Record<string, unknown>>} */
    const duplicates = [];
    /** @type {Array<Record<string, unknown>>} */
    const conflicts = [];
    for (const value of list(normalizedReconciliation.accepted)) {
      const candidate = asRecord(value);
      if (typeof candidate.fingerprint !== "string" || typeof candidate.memoryKey !== "string") continue;
      if (byFingerprint.has(candidate.fingerprint)) {
        duplicates.push({ ...candidate, reason: "memory_candidate_duplicate" });
        continue;
      }
      const prior = byKey.get(candidate.memoryKey);
      if (prior && prior.fingerprint !== candidate.fingerprint) {
        conflicts.push({ ...candidate, reason: "memory_key_conflict_requires_review", existingFingerprint: prior.fingerprint });
        continue;
      }
      const entry = /** @type {Record<string, unknown>} */ ({ ...candidate, status: "accepted", acceptedAt: now });
      existing.push(entry);
      byFingerprint.add(String(entry.fingerprint));
      byKey.set(entry.memoryKey, entry);
      persisted.push(entry);
    }
    if (persisted.length > 0) {
      const currentLedger = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").replace(/\s*$/, "") : "";
      const addition = persisted.map((entry) => JSON.stringify(entry)).join("\n");
      atomicWrite(ledgerPath, `${currentLedger ? `${currentLedger}\n` : ""}${addition}\n`);
    }
    if (conflicts.length > 0) {
      const currentConflicts = existsSync(conflictLedgerPath) ? readFileSync(conflictLedgerPath, "utf8").replace(/\s*$/, "") : "";
      const addition = conflicts.map((entry) => JSON.stringify({ ...entry, detectedAt: now })).join("\n");
      atomicWrite(conflictLedgerPath, `${currentConflicts ? `${currentConflicts}\n` : ""}${addition}\n`);
    }
    const activeByKey = new Map();
    for (const entry of existing) activeByKey.set(entry.memoryKey, entry);
    if (activeByKey.size > 0) atomicWrite(memoryPath, renderMemory([...activeByKey.values()].slice(-160)));
    return {
      status: conflicts.length > 0 ? "needs_review" : "completed",
      persisted,
      duplicates,
      conflicts,
      memoryPath,
      ledgerPath,
      conflictLedgerPath,
      rawSecretsReturned: false,
    };
  });
}
