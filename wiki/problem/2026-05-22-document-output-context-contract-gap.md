> 历史快照：本文记录当时的定位过程，不代表当前实现。当前状态见 `../issues/README.md`。

# 文档输出标题、表格可读性与 Context Contract 缺口

日期：2026-05-22
状态：fixed / implemented
相关模块：source-context-runtime / document-generation / document-worker-runtime / task-execution-runner / qa-gate

## 背景

在 Feishu 文档生成和文档修订 live QA 中，用户侧发现两个直接影响交付质量的问题：

1. 生成文档标题使用了 `feishu file 00 ...` 这类附件 token 或运行时文件名，而不是根据原文件内容、文档 H1、客户项目主题生成可读标题。
2. PRD 的 `暂不做范围` 等章节出现原始 HTML table 标签，例如 `<table><tbody><tr><th>...`，虽然章节范围大体正确，但内容对人类不可读，也不符合 Markdown 文档交付标准。

这两个问题表面上分别像“标题规则不足”和“Markdown 渲染清洗不足”，但深层原因不是单个规则缺失，而是当前 document runtime 的 source context contract 不够完整：系统知道有文件、有 evidence、有 work unit，但没有稳定声明“文档身份是什么、源结构是什么、输出必须满足什么质量契约”。

## 当前可见症状

示例症状：

- `PRD｜feishu file 00 AmDwdnwfnoTvuHxtuA9cP｜产品化方案`
- `客户需求确认表｜feishu file 00 AmDwdnwfnoTvuHxtuA9cP｜需求澄清`
- Markdown 正文中原样出现 `<table> / <tbody> / <tr> / <th> / <td>`。

这会带来三类交付问题：

- 用户无法从标题判断文档主题，只看到附件序列号。
- 飞书/Markdown 渲染结果不稳定，HTML table 在目标文档中不可读。
- QA/Policy 即使通过，也不代表文档达到了产品级可交付质量。

## 已有浅层兜底的边界

可接受的短期兜底包括：

- 在最终 Markdown 写入前把 HTML table 转为 Markdown pipe table。
- 在 worker prompt 中禁止输出 HTML table。
- 在标题生成中识别并规避 `feishu file`、长 token、附件编号类名称。

这些兜底是必要的，但不是深层修复。它们只能处理已暴露的坏输出，不能让系统理解：

- 源文档的业务主题是什么。
- 表格在源结构中扮演什么语义角色。
- 某个 output 是否满足可发布的文档质量 contract。

## 深层根因

### 1. 文档身份仍由 runner 临时推断

`task_execution_runner.mjs` 现在承担了 title plan 生成、标题兜底、最终 H1 同步等职责。runner 本应负责编排，不应成为文档语义身份的 owner。

正确的文档身份应该来自 source context 层：

- 源文件 H1 / 标题。
- 用户请求中的项目名、客户名、产品主题。
- dominant headings。
- review/revision 场景中的原文档标题。
- 证据来源和置信度。

如果这些信息不足，应在 context gate 或 QA gate 中显式降级或阻断，而不是退回附件 token。

### 2. source context 只切 text segment，没有表达结构语义

当前 `source-context-runtime.ts` 已经能生成 source records、segments、retrieval plan、context packs 和 work units，但 segment 主要还是文本片段。

HTML table、Markdown table、列表、标题层级、评论锚点等结构没有形成稳定 contract。结果是：

- 上游抽取出来的 HTML table 会被当成普通文本传递。
- worker 只能看到一坨标签或一段难读文本。
- QA 无法判断“源中有表格，输出是否保留为可读结构”。

### 3. output quality gate 不够具体

`qa-gate.ts` 已经检查 missing sections、unsupported claims、review context、privacy 等，但对 Markdown 交付质量缺少阻断规则：

- 标题不得包含 Feishu token、文件扩展名、generic upload name。
- Markdown 不得包含原始 HTML table 标签。
- table source segment 的输出必须是 Markdown table 或结构化 bullet。
- 文档标题必须能追溯到 document identity。

因此当前 QA pass 不等于用户可读、可发布、产品级。

### 4. 不应通过新增平行层解决

这个问题不能通过新增独立“标题服务”“表格服务”“文档治理服务”解决。那会引入第二套上下文系统，扩大 runner 职责，导致上下文膨胀，也不符合 PI runtime 当前设计。

当前项目已经有合适的位置：

- `source-context-runtime.ts`：Runtime Context Plane 的 owner。
- `document-generation.ts`：Prompt Registry renderer，负责绑定 work units。
- `document-worker-runtime.ts`：按 context pack 执行章节生成。
- `qa-gate.ts`：发布前质量 gate。
- `task_execution_runner.mjs`：只负责阶段编排和 artifact 连接。

深层修复应把“文档身份、源结构、输出契约”作为 Runtime Context Plane 的 contract facet，而不是新增架构层。

## 正确问题定义

更准确的问题定义：

> 当前 document runtime 已经有 context plane 的雏形，但缺少 Document Output Contract。系统能把 source 切成 segment 并生成 bounded context pack，却没有把文档身份、结构化 source blocks 和 output publish rules 作为一等 contract。因此标题和表格等用户可见质量问题只能靠后置清洗，而不能在上下文准备、生成和 QA 阶段被稳定治理。

## 影响范围

受影响 profile：

- `document_generation`
- `document_revision`
- `multi_source_synthesis`
- `audio_minutes` 的后续文档生成阶段

不应影响：

- `fast_answer`
- `file_summary` 的轻路径直接回复
- `unsupported`
- `publish_only`

## 设计约束

- 不新增远端服务。
- 不新增向量库作为 P0。
- 不新增独立 daemon。
- 不把 runner 扩大成业务语义层。
- 不让 worker 接收完整 raw source text。
- 不把 prompt registry、source context 和 QA gate 合并成单个巨型模块。
- 保持 PI 优势：extension 承载动态能力，runner 编排，worker 执行，QA 决定能否发布。

## 期望修复方向

深层修复应收敛为一个 `Document Output Contract`，挂在 Runtime Context Plane 下：

```json
{
  "documentIdentity": {
    "projectName": "string",
    "subject": "string",
    "sourceTitle": "string",
    "confidence": "high|medium|low",
    "basis": ["source_h1", "user_request", "dominant_heading"]
  },
  "sourceStructure": {
    "headings": [],
    "tables": [],
    "commentAnchors": []
  },
  "outputContract": {
    "titlePolicy": {},
    "markdownPolicy": {},
    "publishBlockingRules": []
  }
}
```

这不是新增三层系统，而是在现有 `source_context_prepare -> document_prompt_render_batch -> document_workers_run -> qa_gate_evaluate` 链路上补齐 contract。

## 验收标准

- 新生成的 PRD、客户需求确认表等标题不得包含 `feishu file`、附件 token、文件扩展名或 generic upload name。
- 标题必须来自 `documentIdentity`，并记录 `basis/confidence`。
- 源文件中 HTML table / Markdown table 被识别为结构化 table block，并保留列名、行数、source segment id。
- context pack 给 worker 的是 bounded table-aware evidence，不是 raw HTML table。
- 最终 Markdown 不得包含 `<table>/<tbody>/<tr>/<th>/<td>`。
- QA gate 能阻断坏标题、HTML table、不可读表格输出，而不是只靠 publish 前清洗。
- runner 不再作为文档身份和 source structure 的 owner，只消费 context plane 产物。

## 2026-05-22 修复记录

- `source-context-runtime.ts` 已新增 `documentIdentity`、`source-structure.json`、`outputContract`，并在 `context-manifest.json` 和 context pack 中记录 source block / table block metadata。
- `task_execution_runner.mjs` 已改为从 `documentIdentity.titleByDocType` 生成 `document-title-plan.json`，QA 前传入原始 worker markdown、目标 title、identity basis、source structure summary 和 output contract。
- `document-generation.ts` / `document-worker-runtime.ts` 已只读取 bounded contract metadata，worker trace 和 `qaInput` 写入 `sourceBlockIds`、`tableBlockCount`、`outputContractVersion`、`documentIdentityConfidence`。
- `qa-gate.ts` 已新增 `bad_document_title`、`document_identity_missing`、`raw_html_table_in_markdown`、`table_source_unreadable_in_output` 发布阻断规则。
- publish 前 Markdown title/table 同步仍保留为兜底，但不再是唯一防线。
