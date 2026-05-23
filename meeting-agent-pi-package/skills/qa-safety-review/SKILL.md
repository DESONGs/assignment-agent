---
name: qa-safety-review
description: Review meeting outputs before publication for evidence quality, hallucination risk, privacy, Feishu/Rokid permission boundaries, and unsafe dependency or skill-evolution behavior.
---

# QA Safety Review Skill

Use this skill before publishing or proposing long-term memory/skill changes.

For runtime enforcement, call `qa_gate_evaluate` with privacy, evidence,
topicCoverage, entitySafety, titleSync, Feishu readiness, webAccess, and
contextBudget checks. Write publish gates with `qa_gate_write` when a run has a
`runId`.

## Checkpoints

- Evidence: important claims have timestamps or source references.
- Entity support: roles, organizations, table names, project names, and
  action-item owners must be supported by the current `meetingProfile` or
  transcript evidence.
- Cross-meeting contamination: any `siblingForbiddenTerms` in user-facing output
  are blocking issues.
- Ambiguous expansion: vague transcript terms such as "表", "问题", or "材料" must
  not be expanded into unsupported nouns such as an HR table.
- User-facing cleanliness: Feishu meeting minutes do not expose raw evidence ids,
  chunk ids, source audio filenames, `Evidence Notes`, QA conclusions, model
  review notes, or hidden test comments.
- Title sync: `meetingTitle`, Markdown H1, and Feishu filename are identical or
  directly derived from the same title.
- Title basis: the title is based on participants/roles, meeting topic,
  arrangements, and conclusions; missing facts are marked `待确认`.
- Scope: generated docs match the meeting and do not invent business decisions.
- Macro-topic coverage: for meeting minutes, sustained topics across multiple
  transcript segments must not be omitted or collapsed into a single sentence.
  Business model, pricing/fee structure, "超级个体", cooperation model, and
  organization model discussions should be reported as `omittedMacroTopics` when
  the output fails to expand them despite evidence.
- Document outputs: each PRD, operations plan, architecture document, and
  customer requirement checklist must cover the reason selected by
  `document-router`, include the prompt registry `requiredSections`, and keep
  facts scoped to the current document and current meeting evidence.
- Artifact priority: `meeting-minutes` is the default `primary` artifact and is
  the only default artifact that blocks delivery. PRD, operations,
  architecture, and checklist outputs are `follow_up` by default; their
  `needs_fix` or `blocked` states must be reported without blocking primary
  meeting-minutes delivery.
- Document unsupported claims: any document conclusion without evidence must be
  rewritten as `推断` or `待确认`; cross-document contamination is blocking.
- Document open questions: customer-facing requirement checklists and other
  planning documents must preserve open questions that block product,
  technical, operational, commercial, or permission decisions.
- Document revision: if `review-context.json` is present, verify that the
  generated document reflects explicit user revision instructions and unresolved
  review/comment signals. If `commentAccess.method` is `cli` or `sdk`, check
  unresolved comment threads and replies are addressed or carried into open
  questions. Comments are source-scoped: every comment must reference a valid
  `sourceDocuments[].sourceId`, and one source's comment must not be applied to
  another source. `exact_unique` comments may drive local revisions;
  `exact_multiple`, `fuzzy`, `unmatched`, and `exported_body_detected` comments
  must be carried as `待确认` unless the output explicitly explains how they were
  handled. If Feishu comments were not available, the output must not pretend
  they were read; `comment_api_permission_blocked` or exported-body-only access
  must be preserved as `待确认`.
- Privacy: personal, customer, token, and raw transcript data are not leaked.
- Context: raw transcript/full evidence is offloaded to local artifacts, and the
  main context is pointer-only with hashes, bounded previews, topic maps,
  evidence maps, QA gates, and open questions.
- ASR: raw audio stayed in the local Qwen3-ASR HTTP service; no script fallback
  or external audio upload was used.
- Text evidence: transcript/evidence may be sent to DeepSeek and Xiaomi by
  default and should not be treated as a blocking issue. This is governed by
  `MEETING_TEXT_EVIDENCE_EXTERNAL_LLM_DEFAULT=allow`.
- Model split: DeepSeek generated the main text from evidence; Xiaomi MiMo
  reviewed text evidence only and did not introduce unsupported facts.
- Feishu: Markdown/document create, move, and update are allowed by default for
  the user's requested workflow; IM, calendar, task, customer-visible publish,
  or scope expansion requires explicit confirmation.
- Feishu redaction: `lark-cli auth status` uses `auth-status-summary`; other
  CLI output that may enter model context uses `secret-scan`.
- Rokid: raw media handling respects the source privacy label.
- Legacy QA runs: existing `qa-runs/` folders are non-production evidence and
  raw transcript/response JSON must not be rehydrated into main context.
- Reference PDF: style only; facts, owners, dates, and decisions from the PDF
  are not treated as current-meeting evidence.
- Learning: Hermes proposals do not auto-apply production changes.
- Supply chain: dependency policy blocks known bad versions.

## Output

Return:

- `status`: `pass`, `needs_fix`, or `blocked`.
- `issues`: concise list with severity and fix.
- `unsupportedEntities`: unsupported roles, organizations, table names, project
  names, owners, or deadlines.
- `crossMeetingTerms`: terms copied from sibling meetings.
- `ambiguousTermExpansions`: vague transcript terms expanded beyond evidence.
- `omittedMacroTopics`: important sustained meeting topics that were omitted or
  over-compressed, with the evidence time range when available.
- `documentOutputs`: per-document checks containing `docType`,
  `priority`, `requiredSections`, `missingSections`, `unsupportedClaims`,
  `openQuestions`, `routerReasonCovered`, and `crossDocumentContamination`.
- `artifacts`: per-artifact delivery status with `artifactType`, `priority`,
  `status`, `blocksDelivery`, and `issueCodes`.
- `primaryDeliveryStatus`: `ready`, `needs_fix`, or `blocked`.
- `overallStatus`: `ready`, `partial_ready`, or `blocked`.
- `publish_allowed`: boolean.
- `requires_human_review`: boolean.

`publish_allowed` follows primary artifact readiness: it may be true when
`status=pass` even if `overallStatus=partial_ready` because follow-up documents
still need fixes. Follow-up document issues must remain visible in `artifacts`
and `issues`.
For publication, `omittedMacroTopics` is blocking because it means important
continuous discussion was omitted or compressed below the reference standard.
