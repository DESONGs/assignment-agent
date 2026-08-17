import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ContractValidationError,
  QaEvaluationInputSchema,
  QaGateResultSchema,
  isRecord,
  parseQaEvaluationInput,
  parseQaGateResult,
  qaProfileRequirementFailure,
  stableStringify,
  type QaChecks,
  type QaGateResult,
  type QaIssue,
  type QaProfile,
} from "../dist/index.js";

const SEVERITIES = new Set(["info", "warning", "needs_fix", "blocking"]);

type Issue = QaIssue;

const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(extensionDir);
const workspaceDir = dirname(packageDir);

function defaultOutputRoot() {
  return join(workspaceDir, "runtime-runs");
}

function isInside(parent: string, child: string) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeRunId(input: string) {
  const cleaned = input.trim().replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new Error("unsafe_runtime_segment_blocked");
  }
  return cleaned;
}

function runtimeRoot(outputRoot?: string) {
  const root = resolve(outputRoot ?? defaultOutputRoot());
  if (!isInside(workspaceDir, root)) {
    throw new Error("runtime_output_root_outside_workspace_blocked");
  }
  return root;
}

function gatePath(runId: string, outputRoot?: string) {
  const root = runtimeRoot(outputRoot);
  const dir = resolve(root, safeRunId(runId));
  if (!isInside(root, dir)) {
    throw new Error("runtime_run_dir_outside_root_blocked");
  }
  return join(dir, "qa-gate.json");
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeSeverity(value: unknown): Issue["severity"] {
  const severity = String(value ?? "needs_fix");
  return SEVERITIES.has(severity) ? (severity as Issue["severity"]) : "needs_fix";
}

function addListIssue(issues: Issue[], options: {
  list: unknown;
  code: string;
  severity: Issue["severity"];
  message: string;
  suggestedFix: string;
}) {
  const values = asArray(options.list).filter(Boolean);
  if (values.length > 0) {
    issues.push({
      code: options.code,
      severity: options.severity,
      message: options.message,
      suggestedFix: options.suggestedFix,
      evidence: values,
    });
  }
}

function normalizeArtifactPriority(docType: string, value: unknown): NonNullable<Issue["priority"]> {
  if (value === "primary" || value === "follow_up" || value === "optional") {
    return value;
  }
  return docType === "meeting-minutes" ? "primary" : "follow_up";
}

function scopedDocumentIssue(docType: string, priority: NonNullable<Issue["priority"]>, issue: Issue): Issue {
  return {
    ...issue,
    artifactType: docType,
    priority,
    blocksDelivery: priority === "primary",
  };
}

function issueBlocksDelivery(issue: Issue) {
  return issue.blocksDelivery !== false;
}

function issueStatus(issues: Issue[]) {
  if (issues.some((issue) => issue.severity === "blocking")) return "blocked";
  if (issues.some((issue) => issue.severity === "needs_fix")) return "needs_fix";
  return "pass";
}

function markdownH1(markdown: string) {
  return String(markdown ?? "").match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() ?? "";
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
    (/\.(md|markdown|txt|csv|pdf|docx?|xlsx?|xls|wav|mp3|m4a|aac|flac|ogg)$/i.test(text)) ||
    (/^(file|doc|docx|markdown|md|feishu)[-_\s.]?/i.test(text) && hasLongAlphaNumericToken) ||
    hasLongAlphaNumericToken;
}

function containsHtmlTableTags(markdown: string) {
  return /<\/?(table|tbody|thead|tfoot|tr|th|td)\b/i.test(markdown);
}

function hasReadableTableOutput(markdown: string) {
  return /^\s*\|.+\|\s*$/m.test(markdown) && /^\s*\|[\s:|-]+\|\s*$/m.test(markdown)
    || /^[-*]\s+[^:\n：]{1,80}[：:].+/m.test(markdown)
    || /^[-*]\s+.+$/m.test(markdown) && /表格|字段|列|行|范围|需求|验收|暂不做/.test(markdown);
}

function inputHash(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function blockedGate(params: {
  profile: QaProfile;
  publishIntent: boolean;
  checks: QaChecks;
  reason: string;
  fieldPath: string;
  recovery: string;
  hashSource: unknown;
}): QaGateResult {
  const hash = inputHash(params.hashSource);
  return {
    schemaVersion: "qa-gate-v2",
    evaluationId: `qa_${hash.slice(0, 20)}`,
    inputHash: hash,
    profile: params.profile,
    publishIntent: params.publishIntent,
    status: "blocked",
    reason: params.reason,
    fieldPath: params.fieldPath,
    recovery: params.recovery,
    primaryDeliveryStatus: "blocked",
    followUpDeliveryStatus: "blocked",
    overallStatus: "blocked",
    publishAllowed: false,
    evaluatedAt: new Date().toISOString(),
    artifacts: [],
    checks: params.checks,
    issues: [{
      code: params.reason,
      severity: "blocking",
      message: `QA 输入未通过合同校验：${params.fieldPath}`,
      suggestedFix: params.recovery,
      blocksDelivery: true,
    }],
    rawSecretsReturned: false,
  };
}

function evaluateGate(checks: QaChecks, publishIntent: boolean, profile: QaProfile, hash: string): QaGateResult {
  const issues: Issue[] = [];
  for (const issue of asArray(checks?.issues)) {
    if (isRecord(issue)) {
      const suggestedFix = optionalString(issue.suggestedFix);
      issues.push({
        code: String(issue.code ?? "external_issue"),
        severity: normalizeSeverity(issue.severity),
        message: String(issue.message ?? "External QA issue."),
        ...(suggestedFix === undefined ? {} : { suggestedFix }),
        ...(issue.evidence === undefined ? {} : { evidence: issue.evidence }),
      });
    }
  }

  const security = checks?.security ?? checks?.privacy ?? {};
  if (security.secretsLeaked === true || security.rawSecretsReturned === true) {
    issues.push({
      code: "privacy_secret_leak",
      severity: "blocking",
      message: "输出或 artifact 中存在凭证/secret 泄漏风险。",
      suggestedFix: "立即删除泄漏内容，重新生成脱敏 artifact。",
    });
  }
  const evidence = checks?.evidence ?? {};
  addListIssue(issues, {
    list: evidence.missingEvidenceClaims ?? evidence.unsupportedClaims,
    code: "evidence_missing_for_claims",
    severity: "needs_fix",
    message: "存在关键结论缺少证据支撑。",
    suggestedFix: "补充 evidence 或将结论改写为待确认/推断。",
  });
  const topicCoverage = checks?.topicCoverage ?? {};
  addListIssue(issues, {
    list: topicCoverage.actionCoverageGaps,
    code: "topic_action_coverage_gaps",
    severity: "needs_fix",
    message: "会议中存在行动项，但纪要没有覆盖对应议题的后续动作。",
    suggestedFix: "根据 topicMap 和 evidenceMap 补充行动项，owner 或日期不明确时保留待确认。",
  });

  addListIssue(issues, {
    list: topicCoverage.omittedMacroTopics,
    code: "topic_omitted_macro_topics",
    severity: publishIntent ? "blocking" : "needs_fix",
    message: "连续多个 transcript segment 的主议题被遗漏或过度压缩。",
    suggestedFix: "回到 topicMap，按主议题独立展开后再发布。",
  });
  const entitySafety = checks?.entitySafety ?? {};
  addListIssue(issues, {
    list: entitySafety.speakerAttributionViolations,
    code: "speaker_attribution_violation",
    severity: "needs_fix",
    message: "纪要使用了未绑定稳定参会人代号、或未标明候选状态的身份。",
    suggestedFix: "保留 participant-map.json 中的稳定代号；未经确认的姓名写成候选并标注待确认。",
  });

  const asrEvidence = checks?.asrEvidence ?? {};
  addListIssue(issues, {
    list: asrEvidence.uncertainEvidenceClaims,
    code: "asr_uncertain_evidence_promoted",
    severity: publishIntent ? "blocking" : "needs_fix",
    message: "纪要把仅由 ASR 冲突片段支持的判断写成了确定事实。",
    suggestedFix: "将对应决定、行动、owner、日期、金额或承诺改为待确认，或补充稳定证据。",
  });

  addListIssue(issues, {
    list: entitySafety.unsupportedEntities,
    code: "entity_unsupported_entities",
    severity: "blocking",
    message: "出现当前会议证据不支持的实体。",
    suggestedFix: "删除或改为待确认，并检查是否混入其他会议事实。",
  });
  addListIssue(issues, {
    list: entitySafety.crossMeetingTerms,
    code: "entity_cross_meeting_terms",
    severity: "blocking",
    message: "疑似混入其他会议术语或实体。",
    suggestedFix: "根据 siblingForbiddenTerms 和 meetingProfile 清理跨会议污染。",
  });
  addListIssue(issues, {
    list: entitySafety.ambiguousTermExpansions,
    code: "entity_ambiguous_term_expansions",
    severity: "needs_fix",
    message: "存在未经证据支持的术语展开。",
    suggestedFix: "保留原词或标注待确认，不擅自扩写。",
  });

  const titleSync = checks?.titleSync ?? {};
  if (titleSync.h1MatchesMeetingTitle === false || titleSync.feishuFileNameMatches === false) {
    issues.push({
      code: "title_sync_failed",
      severity: "needs_fix",
      message: "meetingTitle、Markdown H1 或 feishuFileName 不一致。",
      suggestedFix: "以 meetingTitle 为唯一标题源，同步 H1 和飞书文件名。",
    });
  }

  const feishu = checks?.feishuReadiness ?? {};
  addListIssue(issues, {
    list: feishu.missingEnv,
    code: "feishu_missing_env",
    severity: "needs_fix",
    message: "飞书运行环境变量缺失。",
    suggestedFix: "设置缺失环境变量后再启动相关网关或发布动作。",
  });
  addListIssue(issues, {
    list: feishu.missingPermissions,
    code: "feishu_missing_permissions",
    severity: "needs_fix",
    message: "飞书应用权限或事件订阅缺失。",
    suggestedFix: "在飞书开放平台补齐权限、事件订阅并发布版本。",
  });

  const webAccess = checks?.webAccess ?? {};
  if (webAccess.used === true && webAccess.allowed === false) {
    issues.push({
      code: "web_access_not_allowed",
      severity: "blocking",
      message: "WebAccess 用于未授权场景。",
      suggestedFix: "移除被明确禁止的外部访问；若用户需要最新资料，重新确认允许的检索范围并记录来源。",
    });
  }
  if (webAccess.used === true && asArray(webAccess.sources).length === 0) {
    issues.push({
      code: "web_access_missing_sources",
      severity: "needs_fix",
      message: "WebAccess 已使用但没有记录来源。",
      suggestedFix: "补齐来源链接，且不得把外部事实混入会议事实。",
    });
  }

  const sourcePack = checks.sourcePack;
  if (sourcePack?.required === true) {
    if (sourcePack.completeTranscriptAvailable !== true) {
      issues.push({
        code: "source_pack_complete_transcript_missing",
        severity: "blocking",
        message: "知识 source pack 缺少完整带时间戳转写。",
        suggestedFix: "取得完整官方文稿或完整云端 ASR 后再生成 source pack。",
      });
    }
    if (Number(sourcePack.failedChapterCount ?? 0) > 0) {
      issues.push({
        code: "source_pack_chapter_analysis_incomplete",
        severity: "blocking",
        message: "知识 source pack 存在未完成的章节分析。",
        suggestedFix: "修复失败章节并重新执行完整性校验，不得发布部分结果。",
        evidence: { failedChapterCount: Number(sourcePack.failedChapterCount) },
      });
    }
    if (sourcePack.allClaimsHaveEvidence !== true) {
      issues.push({
        code: "source_pack_claim_provenance_missing",
        severity: "blocking",
        message: "知识 source pack 存在无法回溯到当前 transcript segment 的判断。",
        suggestedFix: "删除无证据判断，或补齐有效 segment id 与 provenance。",
      });
    }
    if (sourcePack.partialResultsPublished === true) {
      issues.push({
        code: "source_pack_partial_result_published",
        severity: "blocking",
        message: "部分来源结果被错误标记为可交接知识。",
        suggestedFix: "将任务标记为 blocked，完整恢复后再生成 source pack。",
      });
    }
    if (sourcePack.qualityDisclosureRequired === true && sourcePack.qualityDisclosed !== true) {
      issues.push({
        code: "source_pack_transcript_quality_undisclosed",
        severity: "blocking",
        message: "转写存在待复核质量项，但 source pack 没有披露。",
        suggestedFix: "在机器包与可读交接包中保留 review item 数量、严重度和时间戳 quality 回溯说明。",
      });
    }
    if (!sourcePack.provenancePath) {
      issues.push({
        code: "source_pack_provenance_artifact_missing",
        severity: "needs_fix",
        message: "知识 source pack 缺少机器可读 provenance artifact 路径。",
        suggestedFix: "写入 provenance/evidence-index.json 并在 source pack 中记录路径。",
      });
    }
  }

  const documentOutputs = asArray(checks?.documentOutputs ?? checks?.documents);

  const reviewContext = asObject(checks.reviewContext);
  if (reviewContext.required === true) {
    if (!reviewContext.artifact || reviewContext.status === "missing") {
      issues.push({
        code: "document_revision_review_context_missing",
        severity: "needs_fix",
        message: "用户要求按批注/评论修订，但当前没有完整 review-context.json。",
        suggestedFix: "继续处理用户明确给出的修改和可读正文，并披露未覆盖的评论范围；需要逐条评论时再补取。",
      });
    }
    const access = asObject(reviewContext.commentAccess);
    const method = String(access.method ?? reviewContext.method ?? "");
    const independentRead = reviewContext.independentCommentThreadsRead === true || method === "cli" || method === "sdk";
    const sourceDocuments = asArray(reviewContext.sourceDocuments);
    const sourceIds = new Set(sourceDocuments.map((source) => String(asObject(source).sourceId ?? "")).filter(Boolean));
    const scopedComments = sourceDocuments.flatMap((source) => asArray(asObject(source).comments));
    const commentsMissingSource = scopedComments.filter((comment) => {
      const sourceId = String(asObject(comment).sourceId ?? "");
      return !sourceId || !sourceIds.has(sourceId);
    });
    if (commentsMissingSource.length > 0) {
      issues.push({
        code: "document_revision_comment_source_scope_invalid",
        severity: "blocking",
        message: "review-context 中存在未绑定有效 sourceId 的评论。",
        suggestedFix: "按 sourceDocuments[].sourceId 重新生成 review-context，禁止把多文档评论混成全局评论池。",
        evidence: { invalidCommentCount: commentsMissingSource.length },
      });
    }
    if (reviewContext.status === "comment_api_permission_blocked") {
      issues.push({
        code: "document_revision_comment_api_permission_blocked",
        severity: "needs_fix",
        message: "飞书独立评论线程因权限或 scope 不足未读取。",
        suggestedFix: "开通 docs:document.comment:read 或等价 Drive/Docs 只读权限；输出中必须把评论线程未读取列为待确认。",
        evidence: { requiredScopes: access.requiredScopes ?? reviewContext.requiredScopes ?? [] },
      });
    } else if (reviewContext.unavailableMustBeDisclosed === true && !independentRead) {
      issues.push({
        code: "document_revision_comment_api_unavailable_disclosure_required",
        severity: "needs_fix",
        message: "飞书独立评论线程未读取，修订文档不能声称已处理全部批注。",
        suggestedFix: "在文档待确认项中说明：当前仅使用导出正文和用户可见指令，未读取独立评论线程。",
        evidence: { status: reviewContext.status, method, reason: access.reason ?? null },
      });
    }
    const matchSummary = asObject(reviewContext.matchSummary);
    const sourcesWithUnavailableComments = asArray(matchSummary.sourcesWithUnavailableComments).map(String).filter(Boolean);
    if (sourcesWithUnavailableComments.length > 0 && independentRead) {
      issues.push({
        code: "document_revision_comment_api_partial_source_unavailable",
        severity: "needs_fix",
        message: "部分来源的飞书独立评论线程未读取。",
        suggestedFix: "在修订文档中按 sourceId 标注未读取评论的来源，并将其列入待确认。",
        evidence: { sourcesWithUnavailableComments },
      });
    }
    const weakMatched = Number(matchSummary.weakMatched ?? 0);
    const unmatched = Number(matchSummary.unmatched ?? 0);
    const exportedBodyDetected = Number(matchSummary.exportedBodyDetected ?? 0);
    if (weakMatched + unmatched + exportedBodyDetected > 0) {
      const documentMarkdown = documentOutputs.map((doc) => {
        const record = asObject(doc);
        return String(record.markdown ?? record.content ?? "");
      }).join("\n\n");
      if (!/待确认|未匹配|无法匹配|独立评论线程未读取|弱定位|多处出现/.test(documentMarkdown)) {
        issues.push({
          code: "document_revision_comment_match_pending_missing",
          severity: "needs_fix",
          message: "存在弱匹配、无法匹配或导出正文检测到的评论，但输出没有保留待确认项。",
          suggestedFix: "把 exact_multiple、fuzzy、unmatched、exported_body_detected 评论按 sourceId 写入待确认问题。",
          evidence: { weakMatched, unmatched, exportedBodyDetected },
        });
      }
    }
  }

  const artifacts: Array<{
    artifactType: string;
    docType: string;
    priority: Issue["priority"];
    status: "pass" | "needs_fix" | "blocked";
    blocksDelivery: boolean;
    issueCodes: string[];
  }> = [];
  for (const documentOutput of documentOutputs) {
    const doc = asObject(documentOutput);
    const docType = String(doc.docType ?? "document");
    const priority = publishIntent ? "primary" : normalizeArtifactPriority(docType, doc.priority ?? doc.deliveryTier);
    const documentIssues: Issue[] = [];
    const markdown = String(doc.markdown ?? doc.content ?? "");
    const title = String(doc.title ?? doc.targetTitle ?? markdownH1(markdown) ?? "").trim();
    const outputContract = asObject(doc.outputContract ?? checks.outputContract);
    const documentIdentity = asObject(doc.documentIdentity ?? checks.documentIdentity);
    const titleBasis = asObject(doc.titleBasis);
    const titlePolicy = asObject(outputContract.titlePolicy);
    const markdownPolicy = asObject(outputContract.markdownPolicy);
    const identityBasis = asArray(titleBasis.identityBasis ?? documentIdentity.basis).map(String).filter(Boolean);
    const identityConfidence = String(titleBasis.identityConfidence ?? documentIdentity.confidence ?? doc.documentIdentityConfidence ?? "");
    if (titlePolicy.forbidGenericUploadName !== false && looksLikeGenericUploadName(title)) {
      documentIssues.push(scopedDocumentIssue(docType, priority, {
        code: "bad_document_title",
        severity: "blocking",
        message: `${docType} 标题不可发布，疑似附件 token、泛化上传名或文件扩展名。`,
        suggestedFix: "从 source-context-runtime 的 documentIdentity 重新生成标题，并同步 Markdown H1 与文件名。",
        evidence: { docType, title, markdownTitle: doc.markdownTitle ?? markdownH1(markdown) },
      }));
    }
    if (identityBasis.length === 0 || identityConfidence === "low") {
      documentIssues.push(scopedDocumentIssue(docType, priority, {
        code: "document_identity_missing",
        severity: "warning",
        message: `${docType} 的标题/主题 identity 置信度较低。`,
        suggestedFix: "优先自动从用户请求、source H1 或 dominant heading 改善标题；不影响正文事实时不阻断交付。",
        evidence: { docType, identityBasis, identityConfidence, documentIdentity },
      }));
    }
    if (markdownPolicy.forbidHtmlTableTags !== false && containsHtmlTableTags(markdown)) {
      documentIssues.push(scopedDocumentIssue(docType, priority, {
        code: "raw_html_table_in_markdown",
        severity: "blocking",
        message: `${docType} Markdown 中包含原始 HTML table 标签。`,
        suggestedFix: "重新生成对应 work unit，要求 table source block 输出为 Markdown pipe table 或分组 bullet。",
        evidence: { docType, htmlTagsDetected: true },
      }));
    }
    const tableBlockCount = Number(doc.tableBlockCount ?? checks?.sourceStructureSummary?.tableBlockCount ?? 0);
    if (markdownPolicy.tablesMustBeMarkdownOrBullets !== false && tableBlockCount > 0 && !hasReadableTableOutput(markdown)) {
      documentIssues.push(scopedDocumentIssue(docType, priority, {
        code: "table_source_unreadable_in_output",
        severity: "needs_fix",
        message: `${docType} 使用了 table source block，但输出没有可读 Markdown 表格或结构化 bullet。`,
        suggestedFix: "按 sourceBlocks[].columns/rowCount 重写相关章节，保留表格语义但不要输出 HTML。",
        evidence: { docType, tableBlockCount, sourceBlockIds: doc.sourceBlockIds ?? [] },
      }));
    }
    const requiredSections = asArray(doc.requiredSections).map(String).filter(Boolean);
    const missingSections = [
      ...asArray(doc.missingSections).map(String),
      ...requiredSections.filter((section) => markdown && !markdown.includes(section)),
    ].filter(Boolean);
    if (missingSections.length > 0) {
      documentIssues.push(scopedDocumentIssue(docType, priority, {
        code: "document_missing_sections",
        severity: "needs_fix",
        message: `${docType} 缺少 prompt registry 要求的章节。`,
        suggestedFix: "回到对应 prompts/*.md 重新生成，确保 requiredSections 全部出现。",
        evidence: { docType, priority, missingSections: Array.from(new Set(missingSections)) },
      }));
    }
    const unsupportedClaims = asArray(doc.unsupportedClaims).filter(Boolean);
    if (unsupportedClaims.length > 0) {
      documentIssues.push(scopedDocumentIssue(docType, priority, {
        code: "document_unsupported_claims",
        severity: "needs_fix",
        message: `${docType} 存在缺少证据支撑的文档结论。`,
        suggestedFix: "补充 evidence id，或改写为推断/待确认。",
        evidence: { docType, priority, unsupportedClaims },
      }));
    }
    const crossDocumentContamination =
      doc.crossDocumentContamination === true
        ? [true]
        : asArray(doc.crossDocumentContamination).filter(Boolean);
    if (crossDocumentContamination.length > 0) {
      documentIssues.push(scopedDocumentIssue(docType, priority, {
        code: "document_cross_document_contamination",
        severity: "blocking",
        message: `${docType} 疑似混入其他文档或其他会议事实。`,
        suggestedFix: "按当前 document-router conclusion 和当前会议 evidence 重写该文档。",
        evidence: { docType, priority, crossDocumentContamination },
      }));
    }
    if (doc.routerReasonCovered === false) {
      documentIssues.push(scopedDocumentIssue(docType, priority, {
        code: "document_router_reason_not_covered",
        severity: "needs_fix",
        message: `${docType} 没有覆盖 document-router 选择该文档的理由。`,
        suggestedFix: "回到 router conclusion，将选择理由展开到正文和验收/待确认问题中。",
        evidence: { docType, priority, routerReason: doc.routerReason ?? null },
      }));
    }
    const missingUpstreamDocuments = asArray(doc.missingUpstreamDocuments).map(String).filter(Boolean);
    if (missingUpstreamDocuments.length > 0) {
      documentIssues.push(scopedDocumentIssue(docType, priority, {
        code: "document_missing_upstream_documents",
        severity: "needs_fix",
        message: `${docType} 缺少同一任务中应作为上游依据的文档。`,
        suggestedFix: "按 prompt registry dependsOn 先生成上游文档，再把上游文档注入当前文档 worker。",
        evidence: { docType, priority, missingUpstreamDocuments },
      }));
    }
    const upstreamDocumentsUsed = new Set(asArray(doc.upstreamDocumentsUsed).map(String).filter(Boolean));
    if (docType === "tech-architecture" && asArray(doc.dependsOn).includes("prd") && missingUpstreamDocuments.length === 0 && asArray(doc.sameRunDependencies ?? doc.dependsOn).includes("prd") && upstreamDocumentsUsed.size > 0 && !upstreamDocumentsUsed.has("prd")) {
      documentIssues.push(scopedDocumentIssue(docType, priority, {
        code: "tech_architecture_prd_not_used",
        severity: "needs_fix",
        message: "技术架构文档没有使用同一任务中生成的 PRD 作为上游依据。",
        suggestedFix: "将 PRD markdown 或摘要注入 tech-architecture worker 后重新生成。",
        evidence: { docType, priority, upstreamDocumentsUsed: Array.from(upstreamDocumentsUsed) },
      }));
    }
    if (docType === "customer-requirement-checklist") {
      const audience = String(doc.audience ?? "").toLowerCase();
      const fdeMentioned = /FDE|前端部署工程师|现场部署|部署工程师/i.test(markdown);
      if (audience !== "fde" || !fdeMentioned) {
        documentIssues.push(scopedDocumentIssue(docType, priority, {
          code: "checklist_fde_positioning_missing",
          severity: "needs_fix",
          message: "客户需求确认表没有体现 FDE（前端部署工程师）沟通定位。",
          suggestedFix: "按 FDE 现场沟通场景重写 checklist，问题需关联 PRD、技术架构和部署/权限阻塞点。",
          evidence: { docType, priority, audience: doc.audience ?? null, fdeMentioned },
        }));
      }
      for (const upstreamDocType of ["prd", "tech-architecture"]) {
        if (asArray(doc.dependsOn).includes(upstreamDocType) && upstreamDocumentsUsed.size > 0 && !upstreamDocumentsUsed.has(upstreamDocType)) {
          documentIssues.push(scopedDocumentIssue(docType, priority, {
            code: "checklist_upstream_document_not_used",
            severity: "needs_fix",
            message: `FDE checklist 没有使用 ${upstreamDocType} 作为待确认项来源。`,
            suggestedFix: "将 PRD 与技术架构的待确认、风险和验收项合并为 FDE 可沟通问题。",
            evidence: { docType, priority, missingUsedDocType: upstreamDocType, upstreamDocumentsUsed: Array.from(upstreamDocumentsUsed) },
          }));
        }
      }
    }
    if (doc.requiresOpenQuestions === true && asArray(doc.openQuestions).length === 0) {
      documentIssues.push(scopedDocumentIssue(docType, priority, {
        code: "document_open_questions_missing",
        severity: "needs_fix",
        message: `${docType} 缺少开放问题或待确认项。`,
        suggestedFix: "补充会阻塞产品、技术、运营、商务或权限边界的待确认问题。",
        evidence: { docType, priority },
      }));
    }
    issues.push(...documentIssues);
    artifacts.push({
      artifactType: docType,
      docType,
      priority,
      status: issueStatus(documentIssues),
      blocksDelivery: priority === "primary",
      issueCodes: documentIssues.map((issue) => issue.code),
    });
  }

  const primaryIssues = issues.filter(issueBlocksDelivery);
  const hasPrimaryBlocking = primaryIssues.some((issue) => issue.severity === "blocking");
  const hasPrimaryNeedsFix = primaryIssues.some((issue) => issue.severity === "needs_fix");
  const primaryDeliveryStatus = hasPrimaryBlocking ? "blocked" : hasPrimaryNeedsFix ? "needs_fix" : "ready";
  const nonPrimaryIssues = issues.filter((issue) => !issueBlocksDelivery(issue));
  const hasFollowUpIssues = nonPrimaryIssues.some((issue) => issue.severity === "blocking" || issue.severity === "needs_fix");
  const followUpArtifacts = artifacts.filter((artifact) => artifact.priority !== "primary");
  const followUpDeliveryStatus =
    followUpArtifacts.length === 0
      ? "not_applicable"
      : followUpArtifacts.some((artifact) => artifact.status === "blocked")
        ? "blocked"
        : followUpArtifacts.some((artifact) => artifact.status === "needs_fix")
          ? "needs_fix"
          : "pass";
  const overallStatus = primaryDeliveryStatus !== "ready" ? "blocked" : hasFollowUpIssues ? "partial_ready" : "ready";
  const status = primaryDeliveryStatus === "ready" ? "pass" : primaryDeliveryStatus;
  const reason = status === "pass" ? null : primaryIssues.find((issue) => issue.severity === "blocking" || issue.severity === "needs_fix")?.code ?? "qa_gate_not_publishable";
  return {
    schemaVersion: "qa-gate-v2",
    evaluationId: `qa_${hash.slice(0, 20)}`,
    inputHash: hash,
    profile,
    publishIntent,
    status,
    reason,
    primaryDeliveryStatus,
    followUpDeliveryStatus,
    overallStatus,
    publishAllowed: status === "pass",
    evaluatedAt: new Date().toISOString(),
    artifacts,
    checks,
    issues,
    rawSecretsReturned: false,
  };
}

function gateIntegrityProjection(gate: QaGateResult) {
  return {
    schemaVersion: gate.schemaVersion,
    evaluationId: gate.evaluationId,
    inputHash: gate.inputHash,
    profile: gate.profile,
    publishIntent: gate.publishIntent,
    status: gate.status,
    reason: gate.reason,
    fieldPath: gate.fieldPath ?? null,
    recovery: gate.recovery ?? null,
    primaryDeliveryStatus: gate.primaryDeliveryStatus,
    followUpDeliveryStatus: gate.followUpDeliveryStatus,
    overallStatus: gate.overallStatus,
    publishAllowed: gate.publishAllowed,
    artifacts: gate.artifacts,
    checks: gate.checks,
    issues: gate.issues,
    rawSecretsReturned: gate.rawSecretsReturned,
  };
}

function assertGateIntegrity(gate: QaGateResult) {
  const input = {
    profile: gate.profile,
    checks: gate.checks,
    publishIntent: gate.publishIntent,
  };
  const hash = inputHash(input);
  const requirementFailure = qaProfileRequirementFailure(input);
  const expected = requirementFailure
    ? blockedGate({
        profile: input.profile,
        publishIntent: input.publishIntent,
        checks: input.checks,
        ...requirementFailure,
        hashSource: input,
      })
    : evaluateGate(input.checks, input.publishIntent, input.profile, hash);
  if (stableStringify(gateIntegrityProjection(gate)) !== stableStringify(gateIntegrityProjection(expected))) {
    throw new ContractValidationError({
      reason: "qa_gate_result_integrity_mismatch",
      fieldPath: "gate",
      recovery: "重新运行 qa_gate_evaluate，并原样写入其返回结果。",
    });
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "qa_gate_evaluate",
    label: "QA Gate Evaluate",
    description: "Evaluate evidence, source-pack provenance/completeness, topic/action coverage, speaker attribution, entity safety, title sync, Feishu readiness, web access, security, and context budget checks.",
    parameters: QaEvaluationInputSchema,
    async execute(_toolCallId, params) {
      let input;
      try {
        input = parseQaEvaluationInput(params);
      } catch (error) {
        const contractError = error instanceof ContractValidationError ? error : new ContractValidationError({
          reason: "qa_checks_contract_invalid",
          fieldPath: "$",
          recovery: "按当前 QA profile 补齐必检项后重新评估。",
        });
        const raw = asObject(params);
        const profile = ["source_pack", "meeting_minutes", "office_document", "document_revision"].includes(String(raw.profile))
          ? raw.profile as QaProfile
          : "office_document";
        const checks: QaChecks = { security: { rawSecretsReturned: false, secretsLeaked: false } };
        const details = blockedGate({ profile, publishIntent: false, checks, reason: contractError.reason, fieldPath: contractError.fieldPath, recovery: contractError.recovery, hashSource: params });
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      }
      const requirementFailure = qaProfileRequirementFailure(input);
      if (requirementFailure) {
        const details = blockedGate({ profile: input.profile, publishIntent: input.publishIntent === true, checks: input.checks, ...requirementFailure, hashSource: input });
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      }
      const hash = inputHash(input);
      const details = evaluateGate(input.checks, input.publishIntent === true, input.profile, hash);
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });

  pi.registerTool({
    name: "qa_gate_write",
    label: "QA Gate Write",
    description: "Write a machine-readable qa-gate.json artifact for a run.",
    parameters: Type.Object({
      runId: Type.String(),
      gate: QaGateResultSchema,
      outputRoot: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      try {
        const gate = parseQaGateResult(params.gate);
        assertGateIntegrity(gate);
        const path = gatePath(params.runId, params.outputRoot);
        mkdirSync(dirname(path), { recursive: true });
        const tempPath = `${path}.${process.pid}.tmp`;
        writeFileSync(tempPath, JSON.stringify(gate, null, 2) + "\n", "utf8");
        renameSync(tempPath, path);
        const details = { ok: true, runId: params.runId, qaGatePath: path, evaluationId: gate.evaluationId, inputHash: gate.inputHash };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      } catch (error) {
        const blocked = {
          ok: false,
          status: "blocked",
          reason: error instanceof Error ? error.message : String(error),
          runId: params.runId,
          qaGatePath: "",
          evaluationId: "",
          inputHash: "",
        };
        return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
      }
    },
  });
}
