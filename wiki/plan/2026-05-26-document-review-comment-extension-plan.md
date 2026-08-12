> 历史快照：本文是已归档计划，不代表当前架构。当前路线图见 `../00-plan.md`。

# Document Review Comment Extension 开发计划

日期：2026-05-26
状态：draft
关联能力：Feishu 文档评论、Runtime Context Plane、Document Output Contract、Profile-based PI Runtime

## Summary

本计划定义一个面向日常生产使用的 `Document Review Comment Extension`：让 Agent 能按需以产品经理、架构师、前端工程师、后端工程师、QA、部署工程师、UIUX 等专家视角审查 Feishu 文档，并在 Feishu 文档评论区留下结构化评审意见。

当前飞书稳定可落地的公开能力是文档全文评论，而不是原生段落级局部批注。因此本功能不承诺“像人手动选中某段文字一样创建局部批注”，而是采用生产上更稳定的方式：

- Agent 基于 `source-context-runtime` 读取文档结构、章节、段落、表格和相关上下文。
- 专家审查 skill 只按需激活，不默认启动多角色团队。
- 审查结果以结构化 finding 形式生成，每条 finding 都带章节路径、原文引用、判断、建议、严重级别和证据 segment。
- 发布到 Feishu 时采用一条或少量全文评论，并在评论内写清楚对应的章节、原文和修改建议。

本功能不是新编排器，不引入 agentteam 常驻机制，不绕开现有 Context Plane，也不把评论发布塞进 document worker。它是现有 PI Runtime 上的一个 output-side extension action。

## Product Context

### 背景

当前文档生成、修订和 Wiki 项目化发布能力已经能把 PRD、技术架构、Checklist、会议纪要等文档组织到项目知识库中。但真实团队协作中，文档流转并不只需要“生成”和“发布”，还需要审查、质疑、补充和推动修改。

飞书文档的评论区天然适合承载这类协作反馈。一个产品经理 review PRD 后，通常不会重新生成整篇文档，而是在评论中指出：

- 哪个章节目标不清晰。
- 哪段原文缺少验收标准。
- 哪个流程缺少异常分支。
- 哪个架构设计和 PRD 要求不一致。
- 哪个前端交互缺少状态或错误处理。

Agent 如果要进入日常生产工作流，也应该能完成这类角色化审查，而不是只产出一份旁路报告。

### 用户问题

用户现在遇到的问题不是“缺少一个总结工具”，而是：

- 文档生成后缺少专家视角的质量反馈。
- 多类文档需要不同审查标准，PRD、架构、前端、后端、QA 不应使用同一套泛化 prompt。
- 审查结果如果只保存在本地 artifact 或聊天回复里，很难进入飞书协作流。
- 原生段落批注能力不稳定或未确认时，需要一个可生产落地的评论方案。

### 产品目标

提供一个按需专家审查能力：

```text
用户请求 review 文档
  -> Agent 判断文档类型和审查角色
  -> 按角色 skill 生成结构化审查意见
  -> 基于 source context 标注章节和原文引用
  -> 通过 QA / Policy gate
  -> 在 Feishu 文档全文评论区发布结构化评审评论
```

用户体验目标：

- 用户可以说“从产品经理角度 review 这个 PRD，并在飞书里留下评论”。
- 用户可以说“从架构师角度看一下这个技术方案的问题”。
- 用户可以说“检查 PRD 和技术架构是否一致”，此时才进入跨文档审查。
- Agent 回复中应说明审查角色、发现数量、是否已写入 Feishu 评论，以及无法写评论时的具体原因。

### 非目标

- 不实现 Feishu 原生局部段落批注，除非 capability probe 明确证明当前 CLI / SDK / MCP 支持。
- 不用浏览器或 GUI 自动化模拟人工选中文字创建批注。
- 不新增第二套 workflow engine。
- 不让 document worker 负责评论发布。
- 不默认启动多角色审查。
- 不默认进行多文档交叉审查。
- 不把本地 docx 直接当作可写 Feishu 评论目标；本地文件只能生成 review report，若要写评论必须先有 Feishu 文档对象。

## Capability Boundary

### Feishu 当前可落地能力

当前本地 `lark-cli 1.0.32` 未暴露 `drive.files.comments.create/list` 这类评论命令。项目已有 `@larksuiteoapi/node-sdk` 依赖，因此评论写入应优先以 SDK/OpenAPI provider 实现。

飞书公开 API 中存在文档全文评论能力：

- `POST /open-apis/drive/v1/files/:file_token/comments`
- 能创建全文评论。
- 官方文档明确说明该接口“不支持局部评论”。

因此 P0 contract 必须写明：

```text
commentTargetMode = global_comment
anchorMode = structured_reference
nativeInlineComment = unsupported_until_capability_probe_passes
```

### CLI / SDK / MCP 策略

| Provider | P0 角色 | 说明 |
|---|---|---|
| `lark-cli` | capability probe / fallback | 当前版本未暴露评论写入命令，不能作为 P0 依赖 |
| Feishu Node SDK / OpenAPI | primary writer | 用于创建全文评论、读取结果、处理权限和错误码 |
| MCP | optional provider | 如果后续启用官方 Feishu OpenAPI MCP，可作为同一 action provider；MCP 不能突破 OpenAPI 本身能力边界 |

所有 provider 必须输出统一 capability result：

```json
{
  "schemaVersion": "feishu-comment-capability-v1",
  "globalComment": "supported",
  "nativeInlineComment": "unsupported",
  "provider": "sdk",
  "reason": "drive file comment API supports global comments only"
}
```

## Architecture Placement

本功能放在现有架构内：

```text
task_router
  -> executionProfile=document_review_comment
  -> task_execution_runner
  -> source_context_prepare / source_context_build_pack
  -> document_review_comment_build
  -> qa_gate_evaluate
  -> feishu_document_comment_action
  -> reply / artifacts
```

不新增平行 runtime。模块职责如下：

| Concern | Owner | Reason |
|---|---|---|
| 任务意图识别 | `task_router.mjs` | 识别用户是否要求 review / 写评论 / 跨文档审查 |
| 文档结构和证据 | `source-context-runtime.ts` | 已是 Context Plane owner，负责 segments、source structure、context pack |
| 专家 skill 选择 | `document-review-comment.ts` | 作为 extension tool，按 docType/user prompt 选择 review skill |
| 审查 finding 生成 | `document-review-comment.ts` | 只生成结构化 finding，不发布 |
| 评论 plan | `document-review-comment.ts` | 把 findings 压缩成可发布的全文评论计划 |
| 评论发布 | `feishu_document_comment_action_helpers.mjs` | Feishu 边界 helper，负责 SDK/OpenAPI/CLI/MCP provider |
| 发布阻断 | `qa-gate.ts` | 防止无证据、重复、过量、低置信或权限不足时发布 |
| 编排 | `task_execution_runner.mjs` | 只连接各工具，不拼 review prompt，不做审查判断 |

## Runtime Profile

新增 execution profile：

```json
{
  "id": "document_review_comment",
  "runnerEligible": true,
  "pipeline": "review_comment",
  "requiredStages": [
    "source_context",
    "review_comment_build",
    "qa_gate",
    "feishu_comment"
  ],
  "skipStages": [
    "document_worker",
    "document_publish",
    "policy_publish_document"
  ],
  "rawMediaExternalUpload": false
}
```

说明：

- 它不生成新文档。
- 它不进入 document worker。
- 它不走 Wiki/Drive publish。
- 它可以在 dry-run 下只生成 `feishu-comment-plan.json`。
- live 写评论必须由用户请求或配置允许。

## Review Skill Model

专家角色不做成 agentteam，而做成 review skill registry。

新增：

```text
meeting-agent-pi-package/runtime/document-review-skill-registry.json
meeting-agent-pi-package/prompts/document-review-product-manager.md
meeting-agent-pi-package/prompts/document-review-architect.md
meeting-agent-pi-package/prompts/document-review-frontend-engineer.md
meeting-agent-pi-package/prompts/document-review-backend-engineer.md
meeting-agent-pi-package/prompts/document-review-qa-engineer.md
meeting-agent-pi-package/prompts/document-review-devops-engineer.md
meeting-agent-pi-package/prompts/document-review-uiux.md
```

Registry 示例：

```json
{
  "schemaVersion": "document-review-skill-registry-v1",
  "skills": [
    {
      "skillId": "prd-product-manager-review",
      "role": "product_manager",
      "title": "产品经理 PRD 审查",
      "appliesToDocTypes": ["prd"],
      "activationPatterns": ["产品", "PRD", "需求", "验收", "用户流程"],
      "promptOverlay": "document-review-product-manager.md",
      "defaultMaxFindings": 12,
      "defaultMode": "single_document"
    },
    {
      "skillId": "tech-architecture-review",
      "role": "architect",
      "title": "架构师技术方案审查",
      "appliesToDocTypes": ["tech-architecture"],
      "activationPatterns": ["架构", "技术方案", "模块", "链路", "扩展性"],
      "promptOverlay": "document-review-architect.md",
      "defaultMaxFindings": 10,
      "defaultMode": "single_document"
    }
  ]
}
```

### Activation Rules

默认只激活一个主审角色：

| Input | Selected Skill |
|---|---|
| “review 这个 PRD” | `prd-product-manager-review` |
| “从架构角度审查” | `tech-architecture-review` |
| “从前端实现角度看” | `frontend-engineer-review` |
| “帮我做多角色评审” | multi-skill review |
| “检查 PRD 和架构是否一致” | cross-document consistency review |

多角色和多文档都是显式启用，不默认打开。

## Contracts

### ReviewRequest

```ts
type ReviewRequest = {
  schemaVersion: "document-review-request-v1";
  runId: string;
  reviewMode: "single_document" | "multi_role" | "cross_document";
  requestedRole?: string;
  userPrompt: string;
  targetDocumentRefs: string[];
  contextEnvelopeRef: string;
  maxFindings?: number;
};
```

### ReviewSkillSelection

```ts
type ReviewSkillSelection = {
  schemaVersion: "document-review-skill-selection-v1";
  selectedSkills: Array<{
    skillId: string;
    role: string;
    reason: string;
    activation: "explicit" | "inferred";
  }>;
  rejectedSkills: Array<{
    skillId: string;
    reason: string;
  }>;
};
```

### ReviewFinding

```ts
type ReviewFinding = {
  findingId: string;
  role: string;
  severity: "blocker" | "major" | "minor" | "suggestion";
  category: "logic" | "scope" | "requirement" | "risk" | "structure" | "implementation" | "wording" | "consistency";
  headingPath: string | null;
  sourceSegmentId: string;
  sourceBlockId?: string;
  quote: string;
  issue: string;
  suggestion: string;
  confidence: number;
  evidenceRefs: string[];
};
```

### FeishuCommentPlan

```ts
type FeishuCommentPlan = {
  schemaVersion: "feishu-review-comment-plan-v1";
  targetMode: "global_comment";
  anchorMode: "structured_reference";
  fileTokenHash: string | null;
  providerPreference: ["sdk", "mcp", "cli"];
  comments: Array<{
    commentIdempotencyKey: string;
    title: string;
    markdown: string;
    findingIds: string[];
    severitySummary: Record<string, number>;
  }>;
};
```

## Comment Format

P0 使用一条主评论，必要时最多三条：

1. `关键问题`
2. `主要修改建议`
3. `次要优化 / 参考建议`

评论示例：

```markdown
【产品经理 PRD 审查】

结论：需要修改后再进入研发评审。

1. [Blocker] 目标不可验收
- 位置：2.1 用户目标
- 原文：“提升用户体验并提高转化”
- 问题：目标不可度量，研发和 QA 无法据此判断是否完成。
- 建议：补充响应时长、转化率、人工接管率或满意度等指标。
- 证据：file-01:seg-0008

2. [Major] 缺少异常流程
- 位置：3.3 私信自动回复流程
- 原文：“系统自动识别用户意图并回复”
- 问题：未描述识别失败、低置信度、多意图和敏感内容场景。
- 建议：增加异常分支、人工兜底和安全策略。
- 证据：file-01:seg-0017

建议处理顺序：
- P0：补齐验收指标、异常流程、人工兜底。
- P1：补充埋点、权限、灰度策略。
```

## Cross-document Review

跨文档审查作为 P1，不默认启用。触发条件：

- 用户明确要求“对齐 PRD 和架构”。
- 用户明确要求“检查多份文档一致性”。
- 评论目标文档和相关项目 Wiki 中已有同源文档可被 taxonomy/source context 关联。

Cross-doc finding 示例：

```json
{
  "findingType": "cross_document_inconsistency",
  "primaryDocument": "PRD",
  "primaryAnchor": "3.2 响应时效要求",
  "relatedDocument": "技术架构",
  "relatedAnchor": "4.1 异步任务链路",
  "issue": "PRD 要求实时回复，但架构设计采用异步批处理，响应目标不一致",
  "suggestion": "明确实时链路和异步链路边界，并给出 SLA"
}
```

## Artifacts

每个 run 输出：

```text
artifacts/review-request.json
artifacts/review-skill-selection.json
artifacts/review-findings.json
artifacts/review-comment-plan.json
artifacts/feishu-comment-capability.json
artifacts/feishu-comment-result.json
artifacts/feishu-comment-ledger.jsonl
```

Dry-run 只生成 plan 和 result，不写 Feishu。

Live mode 成功后写入：

- comment id hash。
- provider。
- target file token hash。
- idempotency key。
- created status。
- failure reason if any。

## QA And Policy Gates

在 `qa-gate.ts` 增加 `review_comment_publish_gate`。

阻断规则：

- `review_finding_without_source_segment`
- `review_comment_quote_too_long`
- `review_comment_unbounded_source_text`
- `review_comment_count_exceeds_limit`
- `review_comment_low_confidence_as_fact`
- `review_comment_duplicate_idempotency_key`
- `review_comment_api_capability_missing`
- `review_comment_scope_missing`

默认限制：

- 单次最多 12 条 findings。
- 单条 quote 最多 240 字。
- 单条评论最多 6000 字。
- 默认只发布 1 条全局评论。
- 严重级别必须和证据置信度一致，低置信 finding 不得写成确定结论。

## Failure UX

用户可见失败原因必须具体：

| Failure | User Message |
|---|---|
| Feishu comment API scope missing | “已完成审查，但当前应用缺少文档评论权限，未能写入 Feishu 评论。” |
| inline comment unsupported | “飞书当前可用接口只支持全文评论，本次已生成结构化评论计划，未执行局部批注。” |
| source anchor low confidence | “已完成审查，但部分意见无法稳定定位到原文段落，未写入评论区。” |
| local docx only | “该文件是本地文档，未绑定 Feishu 文档对象，因此只能生成审查报告，不能写入 Feishu 评论。” |
| duplicate review | “相同审查意见已发布过，本次跳过重复评论。” |

## Implementation Plan

### Phase 0 - Capability Probe And Contract Lock

目标：明确 Feishu 评论写入能力边界，锁定 artifacts contract。

Tasks:

- 新增 `feishu-comment-capability.schema.json`。
- 新增 provider probe：
  - CLI probe：检测当前 `lark-cli` 是否支持 comment create。
  - SDK probe：检测 app/user token、scope、file token、file type。
  - MCP probe：仅在 MCP provider 可用时记录工具能力，不作为 P0 依赖。
- Validator 增加 marker：
  - `global_comment`
  - `structured_reference`
  - `nativeInlineComment unsupported_until_capability_probe_passes`

### Phase 1 - Review Skill Registry

目标：用 registry 承载专家角色，不引入新 agentteam。

Tasks:

- 新增 `runtime/document-review-skill-registry.json`。
- 新增 prompt overlays：
  - product manager
  - architect
  - frontend engineer
  - backend engineer
  - QA engineer
  - DevOps engineer
  - UIUX reviewer
- 增加 registry validation：
  - skillId 唯一。
  - promptOverlay 必须存在。
  - 每个 skill 必须声明 docType / activationPatterns / maxFindings。

### Phase 2 - Review Comment Extension

目标：新增一个 extension tool，不新增 pipeline runtime。

新增：

```text
meeting-agent-pi-package/extensions/document-review-comment.ts
```

工具：

```text
document_review_comment_build
```

输入：

- `contextEnvelopeRef`
- `docType`
- `userPrompt`
- `reviewMode`
- `requestedRole`
- `maxFindings`

输出：

- `review-skill-selection.json`
- `review-findings.json`
- `review-comment-plan.json`

### Phase 3 - Router/Profile Integration

目标：让用户按需触发，不影响现有文档生成。

Tasks:

- `task_router.mjs` 新增 intent：
  - `document_review`
  - `document_review_comment`
  - `cross_document_review`
- `feishu-task.schema.json` 增加 `executionProfile=document_review_comment`。
- `execution-profiles.json` 增加 profile：
  - required stages: source context / review build / qa gate / feishu comment。
  - skip stages: document worker / document publish。

### Phase 4 - Feishu Comment Action Helper

目标：把 Feishu 写评论作为边界 helper。

新增：

```text
meeting-agent-pi-package/tools/feishu_document_comment_action_helpers.mjs
```

职责：

- 读取 `review-comment-plan.json`。
- 执行 capability probe。
- dry-run 输出 planned command / SDK request summary。
- live 使用 SDK/OpenAPI 写全文评论。
- 处理 permission/scope/rate-limit/file-type errors。
- 写 `feishu-comment-result.json` 和 ledger。

### Phase 5 - QA Gate And Idempotency

目标：保证生产可控，不刷屏，不写错文档，不重复写。

Tasks:

- `qa-gate.ts` 增加 `review_comment_publish_gate`。
- `feishu-comment-ledger.jsonl` 记录：
  - finding hash。
  - quote hash。
  - comment markdown hash。
  - file token hash。
  - run id。
  - provider。
- 相同 file + quote + suggestion 不重复发布。

### Phase 6 - Runtime Integration

目标：runner 只编排，不接管审查语义。

Tasks:

- `task_execution_runner.mjs` 对 `document_review_comment` profile：
  - 调用 `source_context_prepare`。
  - 调用 `source_context_build_pack`，purpose=`document_review`。
  - 调用 `document_review_comment_build`。
  - 调用 `qa_gate_evaluate`。
  - 调用 Feishu comment helper。
- 不调用 document worker。
- 不调用 Wiki/Drive document publish。

### Phase 7 - Documentation And Live QA

目标：形成可复现产品级验收。

Tasks:

- 新增问题/能力文档，说明全文评论边界。
- 更新 `agent.md` 开发约束：
  - 涉及 Feishu 评论的能力必须先做 provider capability probe。
  - 不得把全文评论伪装成局部批注。
  - 所有评论必须有 source segment / quote / heading path。
- Live QA：
  - dry-run 审查本地 docx。
  - dry-run 审查 Feishu PRD。
  - live 写入一条结构化全文评论。
  - 重跑同一任务，确认 idempotency skip。

## Test Plan

静态检查：

```bash
python3 src/validate_workspace.py
node --check meeting-agent-pi-package/tools/task_router.mjs
node --check meeting-agent-pi-package/tools/task_execution_runner.mjs
node --check meeting-agent-pi-package/tools/feishu_document_comment_action_helpers.mjs
node --experimental-strip-types --check meeting-agent-pi-package/extensions/document-review-comment.ts
node --experimental-strip-types --check meeting-agent-pi-package/extensions/source-context-runtime.ts
node --experimental-strip-types --check meeting-agent-pi-package/extensions/qa-gate.ts
```

Behavior tests:

- PRD review 默认选择 product manager skill。
- 技术架构 review 默认选择 architect skill。
- 用户明确“前端角度”时选择 frontend engineer skill。
- 未明确要求多角色时只激活一个 skill。
- 本地 docx 只生成 review report，不写 Feishu 评论。
- Feishu 文档 dry-run 生成 `review-comment-plan.json`。
- capability probe 显示 inline comment unsupported 时不阻断全文评论。
- scope 缺失时生成 blocked result 和用户可读原因。
- live 写评论后 ledger 记录 hash，不保存 raw token。
- 同一文档同一 finding 重跑时跳过重复评论。

Live QA:

- 在测试 Feishu 文档上执行单文档 PRD review。
- 验证评论区出现一条结构化全文评论。
- 评论内容包含角色、结论、章节、原文、问题、建议和证据。
- 再次执行同一任务，不重复写评论。
- 用户回复中明确评论写入状态。

## Acceptance Criteria

- `document_review_comment` 不进入 document worker。
- 所有 findings 都有 `sourceSegmentId`。
- Feishu 评论默认是 `global_comment_with_structured_reference`。
- 系统不会承诺或模拟原生局部批注。
- 专家角色通过 registry/prompt overlay 选择，不启动 agentteam。
- 多文档审查必须由用户显式触发。
- Feishu 写评论前必须通过 QA gate。
- 评论发布结果有 ledger，可重复运行、可审计、可跳过重复。
- SDK/CLI/MCP provider 能力差异被记录到 `feishu-comment-capability.json`。

## Open Questions

- Feishu 后续 CLI / MCP 是否会暴露 Drive file comment create/list。
- Feishu 是否存在可公开使用的 docx block-level comment API。
- Channel SDK 的“文档评论中收发消息”是否能覆盖创建 anchored comment thread，还是只处理评论事件交互。
- 是否需要为项目 Wiki 中同源文档提供 cross-document review 的默认引用范围。

## Recommended First Implementation Scope

P0 只做以下内容：

- 单文档、单专家 role。
- Feishu 全文评论。
- SDK/OpenAPI provider。
- Dry-run + live。
- Idempotency。
- QA gate。

暂不做：

- 多角色并发。
- 多文档自动审查。
- 原生局部批注。
- MCP provider。
- GUI 自动化。

这样可以先把日常生产最需要的能力跑通，同时保持 PI Runtime 的简洁边界。
