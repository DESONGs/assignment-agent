---
name: document-worker-runtime
description: Run bounded context-pack document work units through provider-backed parallel document workers.
---

# Document Worker Runtime Skill

Use this skill after `document-router`, `source-context-runtime`, and `document_prompt_render_batch` have produced bounded work units.

## Tools

- `document_workers_plan(documentWorkItems, maxWorkers?, sectionBatching?, sectionsPerBatch?)`
- `document_workers_run(runId, documentWorkItems, maxWorkers?, unavailableProviders?, mockProvider?, mockResponse?, temperature?, maxTokens?, outputRoot?, sectionBatching?, sectionsPerBatch?, maxRepairAttempts?)`

## Rules

- Each document worker handles one `docType` and section-scoped work units backed by `contextPackRef`.
- `document_workers_plan` must respect prompt registry `dependsOn` metadata and return execution waves. Same-wave documents can run in parallel; dependent documents run after their upstream documents are generated.
- Current document dependency baseline: `prd` first, `tech-architecture` after `prd`, and `customer-requirement-checklist` after both `prd` and `tech-architecture`.
- Dependent workers receive bounded upstream dependency summaries, section maps, or relevant excerpts; they must not receive full upstream Markdown.
- Inside each document worker, long documents are generated as section batches
  from the registry `requiredSections`; each batch consumes a bounded context
  pack so input and output are both sharded.
- Workers do not choose document structure; structure comes from `prompts/*.md` through `document-prompt-registry.json`.
- Workers must use exact `requiredSections` names as Markdown section headings.
- After merge, workers compute `missingSections`; if needed they run a bounded
  repair pass for only the missing sections.
- Workers may call the provider adapter in parallel, but model route decisions must be recorded in `model-route.json`.
- Workers do not choose model names directly. They pass task type, `docType`,
  `reasoningDepth`, and complexity signals to Model Router. `meeting-minutes`
  routes through `meeting_minutes` and defaults to `deepseek/deepseek-v4-pro`;
  ordinary sections use `document_shard_fast` / `deepseek-v4-flash`, while PRD,
  tech architecture, complex ops/checklist, and explicit deep-thinking sections
  use `document_shard_deep` / `deepseek-v4-pro`.
- Results must preserve `taskIndex` order after dependency-wave execution.
- `model-route.json` records `sectionBatches`, `sectionAttempts`,
  `repairAttempts`, `missingSections`, `executionWaves`, and upstream dependency
  usage without storing credentials or authentication state.
- Model traces must carry `contextPackId`, `sourceSegmentIds`,
  `promptBudgetChars`, and `retrievalReasons` for each provider attempt.
- Publishing, Feishu writes, calendar/task mutation, and customer-visible output remain outside the worker and require QA/Policy gates.
