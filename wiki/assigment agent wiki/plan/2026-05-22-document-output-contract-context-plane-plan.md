# Document Output Contract Context Plane 修复计划

日期：2026-05-22
状态：implemented
关联问题：`wiki/assigment agent wiki/problem/2026-05-22-document-output-context-contract-gap.md`

## Summary

本计划用于修复文档生成/修订中标题不可读、HTML table 泄漏到 Markdown、QA 无法阻断用户可见质量问题的深层原因。

核心策略不是新增三套层，也不是继续堆后置清洗规则，而是在现有 Runtime Context Plane 上补齐 `Document Output Contract`：

- `documentIdentity`：文档主题、项目名、标题来源和置信度。
- `sourceStructure`：源文件中的 heading、table、comment anchor 等结构化 block。
- `outputContract`：标题和 Markdown 输出的可发布规则。

所有新增能力放在现有 extension/tool contract 内：

- `source-context-runtime.ts` 是 contract owner。
- `task_execution_runner.mjs` 只消费 contract，不再做文档语义 owner。
- `document-generation.ts` 继续负责 prompt registry + work unit 绑定。
- `document-worker-runtime.ts` 按 bounded context pack 执行。
- `qa-gate.ts` 负责发布前阻断。

## Architecture Placement

当前项目已有正确链路：

```text
file/asr/review acquisition
  -> source_context_prepare
  -> document_prompt_render_batch
  -> document_workers_run
  -> qa_gate_evaluate
  -> policy_gate_check
  -> publish/reply
```

本计划只在这条链路内补 contract，不新增平行 runtime：

| Concern | Owner | Reason |
|---|---|---|
| 文档身份推断 | `source-context-runtime.ts` | 身份来自 source records、H1、用户请求、review context，属于 context plane |
| 表格和结构 block | `source-context-runtime.ts` | 表格是 source structure，不是 worker prompt 临时清洗 |
| 标题应用 | `task_execution_runner.mjs` | runner 只读取 `documentIdentity` 并同步 H1/fileName |
| work unit prompt | `document-generation.ts` | 继续只渲染 prompt registry + context envelope |
| section 生成 | `document-worker-runtime.ts` | 继续只读取 context pack，不接 raw source |
| 发布阻断 | `qa-gate.ts` | output quality 是 publish gate，不是 publish CLI 的隐式清洗 |
| 回归检查 | `src/validate_workspace.py` | 防止 runner/worker 回退到 monolithic prompt 和后置补丁 |

## Non-Goals

- 不引入向量库作为 P0。
- 不新增远端服务、daemon、Postgres、MinIO 或外部检索系统。
- 不把 `task_execution_runner` 扩成语义推理层。
- 不让 document worker 接收完整 raw source text。
- 不重写 Prompt Registry。
- 不改变短任务 `fast_answer/file_summary` 的轻路径。

## Phase 0 - Baseline And Fixture Lock

目标：锁定当前坏输出场景，防止深层修复后只靠人工判断。

### Tasks

- 固定一个包含以下输入的 fixture：
  - source filename 为 `feishu-file-00-<token>.md.md`。
  - source Markdown H1 为可读标题，例如 `# PRD｜某业务主题｜产品化方案`。
  - source 正文包含 HTML table。
  - requested documents 包含 `prd` 和 `customer-requirement-checklist`。
- 记录当前预期失败：
  - 标题不得使用 Feishu token。
  - context pack 不得包含 raw HTML table。
  - QA gate 应能阻断 HTML table output。

### Validation

- `python3 src/validate_workspace.py`
- `node --experimental-strip-types --check meeting-agent-pi-package/extensions/source-context-runtime.ts`
- `node --experimental-strip-types --check meeting-agent-pi-package/extensions/qa-gate.ts`
- `node --check meeting-agent-pi-package/tools/task_execution_runner.mjs`

## Phase 1 - Add Document Identity Contract

目标：把标题/主题推断从 runner 移到 source context plane。

### Changes

在 `source-context-runtime.ts` 增加：

```ts
type DocumentIdentity = {
  projectName: string | null;
  subject: string | null;
  sourceTitle: string | null;
  normalizedTitleBase: string | null;
  confidence: "high" | "medium" | "low";
  basis: string[];
  warnings: string[];
};
```

`source_context_prepare` 产出：

- `documentIdentity` 写入 `context-manifest.json`。
- `documentIdentity` 写入返回 details。
- `evidenceSummary.contextPlane.documentIdentity` 只保存 bounded metadata。

推断优先级：

1. source Markdown H1 / exported document title。
2. review context 原文档 title。
3. 用户请求中的项目/客户/产品主题。
4. dominant headings。
5. 低置信度 fallback，不得使用 Feishu token。

### Runner Changes

`task_execution_runner.mjs`：

- `buildDocumentTitlePlan()` 改为优先消费 `sourceContext.documentIdentity`。
- runner 保留 H1/fileName 同步，但不再主导语义标题。
- 当 `documentIdentity.confidence=low` 时，标题使用安全待确认形式，并把低置信度写入 QA 输入。

### Exit Criteria

- 标题 basis 可以追溯到 `source_h1/user_request/review_context/dominant_heading`。
- `feishu file 00 ...` 永远不能成为 `normalizedTitleBase`。
- `document-title-plan.json` 记录 `identityBasis` 和 `identityConfidence`。

## Phase 2 - Add Source Structure And Table Block Contract

目标：把 HTML/Markdown table 从普通 text segment 升级为 source structure block。

### Changes

在 `source-context-runtime.ts` 增加：

```ts
type SourceBlock = {
  blockId: string;
  segmentId: string;
  blockType: "heading" | "paragraph" | "table" | "list" | "comment_anchor";
  sourceFormat?: "markdown_table" | "html_table" | "plain_text";
  headingPath?: string[];
  columns?: string[];
  rowCount?: number;
  markdownPreview?: string;
  quality: "ready" | "needs_fix" | "blocked";
};
```

产物：

- `source-structure.json`
- `source-segments.jsonl` 增加 `segmentKind=text|table|mixed`。
- `context-packs/*.json` 增加 selected `sourceBlocks` metadata。
- `modelContext` 中对 table block 输出为 Markdown pipe table 或 compact bullet，不暴露 HTML tags。

### Retrieval Behavior

- 如果目标 section 名称匹配 `范围/MVP/暂不做/功能需求/验收标准/需求确认`，优先召回对应 heading 下的 table block。
- table block 进入 context pack 时保留 `columns/rowCount/sourceSegmentId/retrievalReason`。
- 如果 table 超预算，先保留 columns + row summaries，不塞完整 raw table。

### Exit Criteria

- 输入 HTML table 不进入 worker prompt。
- context pack 能说明 `kind=table`、columns、rowCount、sourceSegmentId。
- `retrieval-plan.json` 记录 table block 被选中的原因。

## Phase 3 - Define Output Contract And QA Gate

目标：让用户可见输出质量成为可阻断 gate，而不是 publish 前隐式清洗。

### Changes

在 `source-context-runtime.ts` manifest 增加：

```json
{
  "outputContract": {
    "titlePolicy": {
      "forbidGenericUploadName": true,
      "requireIdentityBasis": true
    },
    "markdownPolicy": {
      "forbidHtmlTableTags": true,
      "tablesMustBeMarkdownOrBullets": true
    },
    "publishBlockingRules": [
      "bad_document_title",
      "raw_html_table_in_markdown",
      "table_source_unreadable_in_output"
    ]
  }
}
```

在 `qa-gate.ts` 增加 document output lint：

- `bad_document_title`
  - 标题包含 `feishu file`、长 token、`.md/.docx/.pdf` 等扩展名。
  - 标题为空或为 generic upload name。
- `document_identity_missing`
  - 文档类型为 PRD/checklist/架构/运营方案，但无 identity basis。
- `raw_html_table_in_markdown`
  - Markdown 包含 `<table>/<tbody>/<tr>/<td>/<th>`。
- `table_source_unreadable_in_output`
  - source context 选中了 table block，但目标章节输出没有 Markdown table 或结构化 bullet。

### Runner Changes

`task_execution_runner.mjs` 调 `qa_gate_evaluate` 时传入：

- `contextManifest`
- `documentIdentity`
- `outputContract`
- `sourceStructureSummary`
- `documentOutputs[].title`
- `documentOutputs[].markdown`
- `documentOutputs[].contextPackIds`

### Exit Criteria

- QA fail 时不 publish。
- `agent-output.json.details.finalFailureReport` 能说明是标题、表格、identity 或 Markdown contract 失败。
- Feishu 最终回复能说明失败原因，不泛化成“文档生成失败”。

## Phase 4 - Keep Prompt/Worker Thin

目标：避免把深层修复变成 prompt 膨胀。

### document-generation.ts

- 保持 `contextEnvelopeRef` 必填。
- `normalizeContextBrief()` 只引用 identity/structure/contract metadata，不内联 source raw text。
- `document_prompt_render_batch` 不做标题推断，不做表格解析。

### document-worker-runtime.ts

- `buildSectionPrompt()` 继续只读取当前 work unit 的 context pack。
- prompt 中加入 compact output contract summary。
- section attempt trace 记录：
  - `documentIdentity.confidence`
  - `sourceBlockIds`
  - `tableBlockCount`
  - `outputContractVersion`

### Exit Criteria

- worker prompt 不包含完整 source file。
- checklist 依赖 PRD 时只注入上游摘要/section map，不注入整篇 PRD。
- retry checkpoint key 继续绑定 `contextPackHash`，防止旧上下文污染。

## Phase 5 - Validator And Regression Tests

目标：把架构边界固定住，避免再次退化成 runner 补丁。

### Validator Checks

`src/validate_workspace.py` 增加：

- `source-context-runtime.ts` 必须定义 `DocumentIdentity` / `SourceBlock` / `outputContract`。
- `task_execution_runner.mjs` 不得是唯一 title identity owner。
- `qa-gate.ts` 必须检查 `raw_html_table_in_markdown` 和 `bad_document_title`。
- `document-worker-runtime.ts` 不得要求完整 raw source text。
- `document-generation.ts` 必须要求 `contextEnvelopeRef` 和 `workUnits`。

### Behavior Fixtures

- Feishu token filename + source H1：
  - 输出标题使用 source H1 中的业务主题。
  - `document-title-plan.json` 包含 `identityBasis=source_h1`。
- HTML table source：
  - `source-structure.json` 有 table block。
  - context pack 无 raw HTML tags。
  - output Markdown 使用 pipe table 或 bullet。
- 模型仍输出 HTML table：
  - QA gate blocked，publish 不发生。
- identity low confidence：
  - QA needs_fix 或标题带待确认标识，不使用 token。

## Test Plan

静态检查：

- `python3 src/validate_workspace.py`
- `node --check meeting-agent-pi-package/tools/task_execution_runner.mjs`
- `node --check meeting-agent-pi-package/tools/runtime_tool_cli.mjs`
- `node --experimental-strip-types --check meeting-agent-pi-package/extensions/source-context-runtime.ts`
- `node --experimental-strip-types --check meeting-agent-pi-package/extensions/document-generation.ts`
- `node --experimental-strip-types --check meeting-agent-pi-package/extensions/document-worker-runtime.ts`
- `node --experimental-strip-types --check meeting-agent-pi-package/extensions/qa-gate.ts`

Runtime smoke：

- `source_context_prepare` fixture with HTML table and Feishu token filename.
- `document_prompt_render_batch` verifies context envelope and work units are present.
- `document_workers_run --mockProvider=true` verifies output contract metadata is traced.
- `qa_gate_evaluate` rejects raw HTML table and bad title.

Live QA：

- 重跑一个文档修订或生成任务，但不要先真实 publish；先检查 artifacts。
- artifacts 通过后再允许 Feishu publish/reply。
- 报告必须包含 title basis、table block count、QA gate result、publish result。

## Acceptance Criteria

- 新文档标题不再出现 `feishu file 00 ...`。
- `documentIdentity` 成为标题和文件名的主入口。
- `source-structure.json` 能追踪 table block。
- worker context pack 不包含 raw HTML table。
- QA gate 能阻断坏标题和 HTML table output。
- publish 前清洗只作为兜底，不再是唯一防线。
- runner 保持 thin orchestration，不再继续堆标题/表格语义规则。

## Implementation Notes

- 已在 Runtime Context Plane 内补齐 Document Output Contract，没有新增平行服务或向量库。
- `source-context-runtime.ts` 现在产出 `documentIdentity`、`sourceStructurePath`、`sourceStructureSummary`、`outputContract`，并将 table-aware source block metadata 写入 context pack。
- runner 现在从 source context 的 document identity 派生 title plan，并把 contract metadata 传给 QA；最终 publish 只在 QA/Policy 均通过时发生。
- QA gate 已能在发布前阻断坏标题、缺失 identity、raw HTML table 和不可读 table 输出。
