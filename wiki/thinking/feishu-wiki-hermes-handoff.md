> 历史快照：本文是探索性 handoff，不代表当前实现。当前入口见本目录 `README.md`。

# Feishu Wiki 发布与 Hermes 隐性知识入库开发 Handoff

日期：2026-05-21

## 1. 目标

本轮将飞书知识库作为 Office Agent 的主发布目标，并将系统拆成两条互不耦合的链路：

- 用户交付物 Wiki：会议纪要、PRD、技术架构、客户 checklist、运营方案等正式产物进入项目化知识库。
- Hermes 思考库：基于完整任务链路沉淀行业知识、任务复盘、skill 构建思考、prompt/QA 改进提案、失败模式和隐性知识。

两条链路必须分离。用户交付物服务项目交付、可读性和可追溯；Hermes 思考库服务长期学习、知识萃取、方法论沉淀和后续人工评审。

## 2. 核心原则

- 不新增第二套编排层。`Planner / Model Router / Prompt Registry / Document Worker / QA Gate / Policy Gate` 仍是唯一决策层。
- Feishu Wiki Adapter 只负责知识库节点创建、移动、挂载和结果记录，不决定内容和目录语义。
- Wiki 目录结构不能固定死。可以有默认层级思路，但必须由 `wiki_publish_plan` 根据项目、任务、文档类型、日期、来源和用户意图动态生成。
- Hermes 入库不直接复用 `wiki/thinking/feishu-wiki-thinking.md` 的人格化 prompt。该文件只作为思想密度和批判性参考，需要改造成工程化 gate rubric。
- Hermes 的目标是尽可能提取显性知识和隐性知识，包括客户语境、项目背景、业务约束、行业判断、交付经验、失败模式和 skill 构建经验。
- 不再把“客户隐私”作为 Hermes 入库的硬阻断项。客户/项目语境可以作为知识萃取的重要证据保留和分析。
- 仍必须过滤安全敏感信息：secret、token、Authorization、cookie、App Secret、CLI session、API key、未脱敏凭证、原始音视频和与知识萃取无关的大段原始全文。
- Hermes proposal 不自动修改生产 prompt、skill、runtime。Prompt/QA 改进进入“待评审”。

## 3. 用户交付物 Wiki

用户交付物 Wiki 的目标是形成项目化、可追溯的交付资料库。

目录不是固定模板，而是动态树。默认层级思路如下：

```text
{交付知识库}
  {projectTitle 或 domainTitle}
    {date 或 phase}｜{topic}
      {documentCategory}
        {document}
      Evidence / References / Source Runs
```

示例：

```text
Office Agent 交付知识库
  工作流AI化
    2026-05-21｜工作流AI化｜文档生成
      PRD
      技术架构
      客户需求确认
      Evidence
```

目录生成规则：

- `projectTitle` 优先来自 `document-title-plan.json`。
- 用户明确指定客户、项目、方向或主题时，以用户表达优先。
- 会议纪要可从会议主题、参与方、核心结论推断项目节点。
- 多源输入属于同一项目时，合并到同一项目树。
- 多源输入属于不同项目或归属冲突时，生成 `待确认归属` 或 `多项目合并待确认` 节点，不强行归并。
- 日期节点默认使用任务日期；若用户指定会议日期、项目阶段或周期，优先使用明确时间。
- 文档分类节点按实际产物动态生成，不要求每次都有 PRD、架构、checklist、会议纪要。

## 4. Wiki Publish Plan

新增 artifact：

`wiki-publish-plan.json`

建议结构：

```json
{
  "schemaVersion": "wiki-publish-plan-v1",
  "target": "user-deliverables",
  "spaceId": "...",
  "rootMode": "configured_space|my_library|fallback_drive",
  "treePolicy": "dynamic_content_based",
  "projectTitle": "工作流AI化",
  "runTitle": "2026-05-21｜工作流AI化｜文档生成",
  "nodes": [
    {
      "level": "project",
      "title": "工作流AI化",
      "reuseKey": "project:workflow-ai"
    },
    {
      "level": "run",
      "title": "2026-05-21｜工作流AI化｜文档生成",
      "reuseKey": "run:workflow-ai:2026-05-21:doc-generation"
    },
    {
      "level": "category",
      "title": "PRD",
      "reuseKey": "category:workflow-ai:prd"
    }
  ],
  "documents": [
    {
      "docType": "prd",
      "title": "PRD｜工作流AI化｜产品化方案",
      "localPath": "...",
      "targetParentReuseKey": "category:workflow-ai:prd"
    }
  ],
  "rawSecretsReturned": false
}
```

## 5. Feishu Wiki Adapter

新增或扩展工具层，不放业务决策：

- `wiki_space_check`
- `wiki_node_ensure`
- `wiki_document_move`
- `wiki_publish_write`

CLI 路径：

- `lark-cli wiki +space-list`
- `lark-cli wiki +node-create`
- `lark-cli wiki +move`
- `lark-cli markdown +create`

发布顺序：

1. 用 `markdown +create` 创建飞书文档。
2. 根据 `wiki-publish-plan.json` 逐级 ensure wiki node。
3. 用 `wiki +move --obj-token ... --obj-type docx --target-space-id ... --target-parent-token ...` 挂载到目标节点。
4. 写入 `wiki-publish.json`。
5. 如果 Wiki 权限不足，fallback 到 Drive，并在 reply / publish artifact 中说明 `wiki_publish_blocked_drive_fallback`。

## 6. Wiki Target Registry

当前 `chat/thread -> folderToken` 不适合长期知识库。新增：

`feishu-wiki-target-registry.json`

建议结构：

```json
{
  "schemaVersion": "feishu-wiki-target-registry-v1",
  "spaces": {},
  "projectNodes": {},
  "runNodes": {},
  "categoryNodes": {},
  "documentNodes": {}
}
```

reuse key 必须内容化，不使用 runId 作为目录名：

- `project:{normalizedProjectTitle}`
- `run:{projectKey}:{date}:{topicKey}`
- `category:{projectKey}:{docType}`
- `document:{sourceRun}:{docType}`

## 7. Hermes 思考库

Hermes 思考库不发布用户交付物，而是沉淀后台学习材料。

动态结构建议：

```text
{Hermes 思考库}
  {knowledgeType}
    {domain / capability / month / project}
      {candidate document}
```

默认知识类型：

- 行业知识
- 任务复盘
- Skill 构建思考
- Prompt / QA 改进提案
- 反例与失败模式
- 待确认假设
- 项目语境与业务机制
- 隐性约束与交付经验

Hermes 应根据 run 内容决定进入哪个知识类型、是否需要新建 domain、是否只写入待评审。

## 8. Hermes 入库 Gate

`wiki/thinking/feishu-wiki-thinking.md` 只作为参考，不直接复用。它的价值是强调批判性、结构分析和理论密度；但生产系统需要工程化 gate，而不是人格化写作指令。

建议新增：

`hermes-wiki-reflection-gate.md`

Gate 方法论：

- 第一性原理：这个 run 中哪些机制、约束、判断脱离单次任务后仍成立？
- 奥科姆剃刀：是否能用更少假设解释问题？是否过度抽象、过度理论化或过度归因？
- 证据约束：每个判断必须能追溯到 sanitized trajectory、QA、metrics、输出文档摘要、失败记录、evidence pack 或用户任务上下文。
- 隐性知识提取：不仅总结显性结论，还要抽取会议中未被明说但反复影响决策的约束、偏好、组织方式、行业假设、交付惯性和能力缺口。
- 迁移价值：该知识是否能改善未来任务、skill、prompt、QA、架构或产品判断？
- 反例意识：该结论在什么条件下不成立？是否只是某一客户、项目阶段或组织关系下成立？
- 安全边界：不写入 secret、token、Authorization、cookie、App Secret、CLI session、API key、未脱敏凭证、原始音视频和与知识萃取无关的大段原始全文。

Hermes 输出分类：

```text
- 可入库知识
- 隐性知识与机制判断
- 项目/客户语境
- 任务复盘
- Skill 构建思考
- Prompt / QA 改进提案
- 失败模式
- 不应入库内容
- 待人工确认
```

## 9. Hermes Candidate Artifact

新增：

`hermes-wiki-candidate.json`

建议结构：

```json
{
  "schemaVersion": "hermes-wiki-candidate-v1",
  "sourceRun": "...",
  "candidateType": "industry_knowledge|task_retrospective|skill_thinking|prompt_qa_proposal|failure_mode|implicit_knowledge",
  "title": "...",
  "summary": "...",
  "knowledgeClaims": [],
  "implicitKnowledge": [],
  "projectContext": [],
  "evidencePointers": [],
  "transferability": "high|medium|low",
  "scopeOfValidity": "...",
  "riskFlags": [],
  "publishDefault": "candidate",
  "targetWikiPlan": {}
}
```

默认只生成 candidate。允许自动入库的前提：

- Gate pass。
- 不含凭证、token、secret、raw media。
- 不是生产 prompt 修改。
- 不是高风险外推。
- Policy Gate 对 `persist_memory` 或 `write_private` pass。

## 10. Hermes System Prompt 调整方向

Hermes sidecar 当前应从“只复盘运行问题”扩展为“任务链路知识萃取器”。

新的 system prompt 应要求：

1. 从完整 run 中提取显性产物知识和隐性机制知识。
2. 保留项目/客户语境，因为隐性知识往往依赖具体语境才可解释。
3. 用第一性原理追问：这个任务暴露了什么基础能力、组织机制、产品约束或行业结构？
4. 用奥科姆剃刀压缩解释：不要因为单次失败生成复杂理论，不要因为单次成功过度归纳。
5. 区分事实、机制判断、可迁移经验、局部假设、待确认判断。
6. 把 prompt/skill/runtime 改进建议放入候选，不直接应用。
7. 不因“客户隐私”过滤掉有价值业务语境；只过滤凭证、安全敏感数据和无关原始全文。

## 11. 权限

用户交付物 Wiki：

- `wiki` 读写/节点创建/移动权限。
- 目标知识空间成员或管理员权限。
- `drive:file:download/read` 用于读取用户提供文件。
- `markdown +create` 创建文档。

Hermes 思考库：

- 单独 wiki space 或单独 root node。
- 默认内部可见。
- 不应和客户交付知识库共用空间，除非显式配置。
- 允许保留项目/客户语境，但必须避免凭证和原始大段内容污染。

## 12. 实施阶段

### Phase 1：Wiki Publish Skeleton

- 新增 schema。
- 新增 Feishu Wiki Adapter。
- dry-run 生成 `wiki-publish-plan.json`。
- 不替换现有 Drive publish。

### Phase 2：用户交付物主路径

- `publishResults` 支持 `publishTarget=wiki|drive|auto`。
- 默认 `auto`：Wiki 可用则 Wiki，否则 Drive fallback。
- 发布结果写 `wiki-publish.json`。
- 不再创建 `feishu-chat-xxxx` 作为主目录。

### Phase 3：Hermes Candidate

- `sidecar.py --run-dir` 生成 `hermes-wiki-candidate.json`。
- 新增 `hermes-wiki-reflection-gate.md`。
- 默认不自动发布。

### Phase 4：Hermes Wiki 入库

- 新增 `--publish-wiki-candidate` 或后台 job。
- Gate pass 后入库 Hermes 思考库。
- Prompt/QA 改进提案进入“待评审”。

## 13. 回归测试

用户交付物：

- 同一项目多次生成文档，应复用项目节点。
- 不同日期/主题应生成不同 run 节点。
- PRD/架构/checklist 应挂到对应分类节点。
- Wiki 权限不足时 Drive fallback。
- 不再创建 `feishu-chat-xxxx` 顶层目录作为主路径。
- 文档 H1、飞书文件名、Wiki 节点名应与 `document-title-plan.json` 保持一致。

Hermes：

- 一个会议纪要 run 能生成任务复盘 candidate。
- 一个 PRD/架构 run 能生成 skill/prompt 改进 candidate。
- 能提取隐性知识，而不仅是显性输出摘要。
- 能保留客户/项目语境用于解释机制。
- secret、token、Authorization、App Secret、CLI session、raw audio/video 不进入 candidate。
- prompt 修改建议只进入待评审，不自动应用。

## 14. 验收标准

- 飞书知识库成为默认交付发布目标。
- Wiki 树根据内容动态生成，不是固定模板。
- 用户交付物和 Hermes 思考库完全分离。
- Hermes gate 引入第一性原理、奥科姆剃刀、证据约束、隐性知识提取和迁移价值判断。
- Hermes 不再以“客户隐私”为理由过滤掉有价值项目/客户语境。
- 所有 publish / candidate / gate 结果都有 artifact 可查。
- 任何 Wiki 权限或节点失败都可定位，不静默 fallback。
