> 历史快照：本文是已归档计划，不代表当前架构。当前路线图见 `../00-plan.md`。

# 多源证据边界与防串文件开发方案

日期：2026-05-21

## Summary

当前系统已经具备多音频、多文件、多 Feishu URL 合并为一套上下文并生成 PRD、技术架构、客户 Checklist、会议纪要等文档的能力。但现有实现仍存在“串文件 / 串会议”风险：不同会议或不同来源的音频、纪要文件和工作流文件被粗粒度拼接进同一个 evidence input，模型可能把 A 会议事实、B 文件需求和 C 音频结论混写成一个确定结论。

本方案的目标不是取消多源能力，而是把多源从“文本拼接”升级为“受控 source-set 合并”：先判断用户是否明确要求合并，再按来源建立独立 source profile、evidence slice 和 conflict map，最后要求文档 worker 引用 source id 并由 QA Gate 检查 source boundary。

## Current Findings

### 已经具备的保护

- 当前消息附件和显式 Feishu file URL/token 优先级高于 parent/root/recent cache。
- 显式文件引用存在时，不会 fallback 到 recent cache。
- `sourcePreparation` 已记录 `sourceSetMode=consolidated`、`sourceReferences[]`、`requiresLocalAsr`、`requestedDocuments` 和 `conflictPolicy=source_attribution`。
- ASR segment 原始结构带有 `sourceFile` 和 `sourceHashSha256`。
- QA Gate 已支持 `crossDocumentContamination` 字段。

### 仍存在的问题

1. **recent cache fallback 过宽**

   当前 recent cache 在同一 chat、sender、30 分钟窗口内选择最新附件。如果当前消息没有明确 parent/root/thread，仍可能从最近缓存中选到非本任务来源。

2. **多音频 evidence 被合并为一个连续区块**

   ASR 输出虽然有 `sourceFile/sourceHashSha256`，但 `task_execution_runner` 生成 `evidence-pack.json` 时将所有音频 segment 合并为一个 `Audio ASR Evidence`，没有按音频源隔离展示。

3. **`conflictPolicy=source_attribution` 还只是 metadata**

   当前没有 source profile、实体/主题差异、冲突字段和待确认项的结构化检测；模型虽然被提示标注来源，但 runtime 没有强制检查。

4. **QA Gate 依赖 worker 自报污染**

   `qaInput.unsupportedClaims` 当前默认空数组，`crossDocumentContamination` 没有由 worker/runtime 计算，导致明显串源也可能通过 QA。

## Design Goals

- 保留用户明确要求的多音频、多文件、多会议纪要 URL 合并撰写能力。
- 防止未确认的 recent cache 或旧附件被静默混入当前任务。
- 多源合并时，每个关键事实、推断和待确认问题都能回到明确 source id。
- 不把不同会议的上下文混成一条连续时间线。
- 不新增第二套编排层；仍由 Planner / Model Router / Prompt Registry / Document Worker / QA Gate / Policy Gate 作为唯一决策层。
- 不外发 raw audio/video，不把 raw transcript 或完整大文件正文写入 metrics / trajectory / long-term memory。

## Non-Goals

- 不取消多源合并。
- 不要求用户每次只能上传一个文件。
- 不引入 MCP 或新 Feishu SDK。
- 不让 handler 或 runner 重新决定业务文档结构。
- 不自动裁决来源冲突；冲突默认标注来源并进入待确认项。

## Target Architecture

```text
Feishu event / future IM event
  -> source reference resolver
  -> source-set router
  -> source preparation
       - explicit URL/token download
       - parent/root attachment download
       - guarded recent cache fallback
       - optional audio normalize + local ASR
       - text file extraction
  -> evidence-pack v2
       - sourceManifest[]
       - sourceProfiles[]
       - sourceEvidence[]
       - conflictMap[]
       - sourceSetDecision
  -> Planner
  -> Model Router
  -> Prompt Registry render batch
  -> Document Workers with source-bound prompts
  -> QA Gate source-boundary checks
  -> Policy Gate
  -> publish / reply
```

## Source-Set Router

新增轻量 source-set router。它只判断来源集合边界，不决定文档类型、不选择模型、不写文档结构。

### 输入

- 用户原始 prompt。
- 当前消息附件。
- 显式 Feishu URL/token。
- parent/root 附件。
- recent cache 候选。
- 附件类型：audio/file/image/video。
- 每个候选的 chatId、senderId、threadKey、messageId、timestamp、fileName、hash、sourceKind。

### 输出

```json
{
  "schemaVersion": "source-set-decision-v1",
  "status": "selected|needs_clarification|blocked",
  "sourceSetMode": "single_source|explicit_multi_consolidated|multi_source_compare|multi_source_separate|ambiguous_needs_clarification",
  "selectedSourceIds": [],
  "excludedSourceIds": [],
  "selectionReason": "",
  "requiresUserClarification": false,
  "clarificationMessage": "",
  "cacheFallbackAllowed": false,
  "conflictPolicy": "source_attribution"
}
```

### 规则

- 当前消息附件永远优先。
- 显式 URL/token 永远优先；存在显式 URL/token 时禁止 recent cache fallback。
- 回复父消息时只取 parent/root 资源，不取 unrelated cache。
- recent cache 只允许在同一 chat、sender、thread 且候选唯一时使用。
- 如果 recent cache 有多个候选且用户未明确说“结合这些文件/音频”，返回 `needs_clarification`。
- 文档写作默认只匹配文本文件；只有用户明确说“录音/音频/转写/会议音频/多个录音”时才匹配音频 cache。
- 用户说“结合/基于/汇总/整合 A 和 B”时进入 `explicit_multi_consolidated`。
- 用户说“分别/每个文件单独”时进入 `multi_source_separate`。
- 用户说“对比/差异/比较两个会议”时进入 `multi_source_compare`。

## Evidence Pack v2

升级 `evidence-pack.json` 为 source-boundary first 的结构。

### Required Fields

```json
{
  "schemaVersion": "office-evidence-pack-v2",
  "sourceSetDecision": {},
  "sourceManifest": [],
  "sourceProfiles": [],
  "sourceEvidence": [],
  "conflictMap": [],
  "sourceCoveragePolicy": {
    "keyClaimsRequireSourceId": true,
    "multiSourceRequiresAttribution": true,
    "conflictsRequireOpenQuestion": true
  },
  "rawSecretsReturned": false,
  "rawMediaExternalUpload": false,
  "fullRawContentIncluded": false
}
```

### sourceManifest

每个来源必须有稳定 `sourceId`：

- 音频：`audio-01`、`audio-02`
- 文本文件：`file-01`、`file-02`
- Feishu 云文档：`feishu-doc-01`
- URL/token：保留 hash/pointer，不暴露 raw token 到用户输出。

字段：

- `sourceId`
- `sourceKind`
- `modality`
- `fileName`
- `hashSha256`
- `messageIdHash`
- `resolvedFrom`
- `explicitReference`
- `includedInRun`
- `exclusionReason`

### sourceProfiles

为每个来源生成独立 profile：

- `sourceId`
- `inferredProject`
- `meetingTitle`
- `dateHint`
- `participantsHint`
- `mainTopics`
- `entities`
- `confidence`
- `profileBasis`

profile 不作为确定事实发布，只用于判断是否存在跨会议/跨项目混源风险。

### sourceEvidence

音频 evidence 必须按 source 分组：

```markdown
### audio-01: A会议.wav
- [audio-01 00:00-00:30] ...
- [audio-01 00:30-01:00] ...

### audio-02: B会议.wav
- [audio-02 00:00-00:30] ...
- [audio-02 00:30-01:00] ...
```

文本 evidence 必须按文件分组：

```markdown
### file-01: workflow.md
...

### file-02: meeting-minutes.md
...
```

### conflictMap

冲突不自动裁决，写入：

- `conflictId`
- `field`
- `sourceIds`
- `statements`
- `severity`
- `recommendedHandling`

示例：

```json
{
  "conflictId": "conflict-001",
  "field": "delivery_scope",
  "sourceIds": ["file-01", "audio-02"],
  "statements": [
    {"sourceId": "file-01", "text": "MVP 仅做会议纪要"},
    {"sourceId": "audio-02", "text": "MVP 包含 PRD 和架构文档"}
  ],
  "severity": "needs_confirmation",
  "recommendedHandling": "在 PRD 范围中标注待确认，不写成确定范围"
}
```

## Prompt / Worker Rules

### Prompt Registry 输入要求

`document_prompt_render_batch` 的 `input` 应包含：

- Source Set Decision
- Source Manifest
- Source Profiles
- Source Evidence
- Conflict Map
- User Request
- Document Title Plan

### 文档 prompt 新增规则

PRD、技术架构、运营方案、客户需求确认表和会议纪要 prompt 需要补充：

- 多 source 时，关键事实必须写来源：`来源：file-01`、`来源：audio-02`。
- 综合推断必须写来源组合：`综合推断，来源：file-01 + audio-01`。
- 多 source 冲突不得写成确定结论，必须进入“待确认问题”。
- 不同 source profile 显示为不同项目/会议且用户未要求合并时，文档应停止生成并请求澄清。
- 会议纪要在多音频场景下默认生成一份“多录音合并纪要”，但每个议题必须标注来源音频；若用户要求分别生成，则每个音频独立纪要。

### Document Worker QA Input

`qaInput` 必须新增：

```json
{
  "sourceIdsUsed": [],
  "sourceClaims": [],
  "unattributedClaims": [],
  "crossSourceContamination": [],
  "conflictsResolvedAsFacts": [],
  "sourceCoverageSummary": {}
}
```

## QA Gate Enhancements

新增 source-boundary checks：

- `source_missing_attribution`：多 source 文档中关键结论没有 source id。
- `source_unselected_used`：输出引用了未被 source-set router 选中的来源。
- `source_conflict_resolved_as_fact`：冲突事实被写成确定结论。
- `source_profile_mismatch_unconfirmed`：来源 profile 显示为不同项目/会议，但用户没有明确要求合并。
- `recent_cache_ambiguous_used`：recent cache 多候选未确认仍被使用。
- `audio_sources_merged_without_source_labels`：多音频 evidence 或会议纪要没有音频来源标注。

阻断规则：

- `source_unselected_used`：blocking
- `recent_cache_ambiguous_used`：blocking
- `source_profile_mismatch_unconfirmed`：blocking
- `source_conflict_resolved_as_fact`：blocking
- `source_missing_attribution`：needs_fix；若 publishIntent=true 且 sourceCount > 1，可提升为 blocking。

## Code Change Plan

### 1. Feishu source resolution

文件：

- `meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs`

改动：

- 新增 `buildSourceCandidates(...)`，统一 current attachments、explicit refs、parent/root resources、recent cache。
- 新增 `routeSourceSet(...)`。
- recent cache 返回多个候选时不自动选最新，除非用户明确“最近这个文件/刚才上传的文件”且候选唯一。
- `taskIntent.sourcePreparation` 记录 `sourceSetDecision`、`selectedSourceIds`、`excludedSourceIds`。
- `needs_clarification` 时不启动长链路，直接回复用户选择文件/音频。

### 2. File Context / Audio Context source id

文件：

- `meeting-agent-pi-package/tools/im_file_context_helpers.mjs`
- `meeting-agent-pi-package/tools/task_execution_runner.mjs`

改动：

- `buildFileContexts` 保留 `sourceId`、`selectedBySourceSetRouter`、`sourceProfileHint`。
- `sourceAudioPaths(task)` 保留 `sourceId`，传递到 ASR evidence。
- 如果 ASR 服务暂时不能原生接收 `sourceId`，runner 在读取 transcript 时用 `sourceHashSha256 -> sourceId` 映射补齐。

### 3. Evidence Pack v2

文件：

- `meeting-agent-pi-package/tools/task_execution_runner.mjs`
- 新增或更新 schema：`meeting-agent-pi-package/runtime/evidence-pack.schema.json`

改动：

- `buildEvidencePack` 输出 `office-evidence-pack-v2`。
- 音频 evidence 按 source 分组，不再合并为单个 `Audio ASR Evidence`。
- 文本文件 evidence 按 source 分组，保留 bounded text。
- 生成初版 `sourceProfiles[]`：基于文件名、用户 prompt、前若干 evidence 片段提取主题/实体。
- 生成初版 `conflictMap[]`：先做轻量规则，例如同字段明显相反词、不同 project title、不同客户/会议标题。

### 4. Prompt 更新

文件：

- `meeting-agent-pi-package/prompts/meeting-minutes.md`
- `meeting-agent-pi-package/prompts/prd.md`
- `meeting-agent-pi-package/prompts/tech-architecture.md`
- `meeting-agent-pi-package/prompts/ops-plan.md`
- `meeting-agent-pi-package/prompts/customer-requirement-checklist.md`

改动：

- 增加 Source Set / Source Manifest / Conflict Map 使用规则。
- 要求关键事实标注 source id。
- 多 source 冲突必须待确认。
- 多音频会议纪要按来源标注议题。

### 5. Document Worker QA Input

文件：

- `meeting-agent-pi-package/extensions/document-worker-runtime.ts`

改动：

- 从 generated markdown 中解析 source id 引用。
- 计算 `sourceIdsUsed`、`unattributedClaims`、`crossSourceContamination`。
- 将 `sourceBoundary` 信息写入 `qaInput` 和 `model-route.json` 的 document route 摘要。

### 6. QA Gate

文件：

- `meeting-agent-pi-package/extensions/qa-gate.ts`
- `meeting-agent-pi-package/skills/qa-safety-review/SKILL.md`

改动：

- 增加 source-boundary checks。
- 多 source 且无 attribution 时 needs_fix/blocking。
- conflictMap 中的问题如果被正文写成确定事实，blocking。

### 7. Validation / Wiki

文件：

- `src/validate_workspace.py`
- `wiki/07-test-plan.md`
- `wiki/11-current-project-architecture.md`
- `wiki/13-office-agent-product-technical-review.md`

改动：

- 校验 `source-set-decision-v1`、`office-evidence-pack-v2`、`sourceManifest`、`sourceProfiles`、`conflictMap`。
- 校验文档 worker `qaInput` 包含 source-boundary 字段。
- 增加防回归：禁止多音频 evidence 合并成单一未标注 `Audio ASR Evidence`。

## Test Plan

### Fixture Tests

1. **单文件文档撰写**

   输入：一个 Markdown + “生成 PRD”。

   预期：

   - `sourceSetMode=single_source`
   - evidence pack 只有 `file-01`
   - 文档可不反复标注来源，但关键结论仍应有来源字段或 evidence basis。

2. **两个明确文件合并写 PRD/架构/checklist**

   输入：两个文件 URL + “结合这两个文件生成 PRD、技术架构、客户 Checklist”。

   预期：

   - `sourceSetMode=explicit_multi_consolidated`
   - `sourceManifest` 有 `file-01/file-02`
   - 正文关键结论出现 `来源：file-01` 或 `来源：file-01 + file-02`
   - 冲突进入待确认。

3. **两个不同会议音频生成会议纪要**

   输入：两个音频 + “形成会议纪要”。

   预期：

   - 两个音频都 normalize/ASR。
   - evidence 按 `audio-01/audio-02` 分组。
   - 纪要议题标注来源音频。
   - 不出现未标注的连续混合时间线。

4. **音频 + 已有会议纪要文件生成技术方案**

   输入：音频 + 会议纪要文件 + “生成技术架构文档”。

   预期：

   - `requestedDocuments=["tech-architecture"]`
   - 音频只作为 evidence，不强制走 `meeting-minutes` 输出。
   - 架构判断标注 `audio-01` / `file-01`。

5. **recent cache 多候选**

   输入：同一 chat/sender 30 分钟内先后上传 A、B 两个文件，然后发送“结合这个写 PRD”，不回复具体文件。

   预期：

   - `sourceSetMode=ambiguous_needs_clarification`
   - 不启动 document worker。
   - 用户回复要求选择文件。

6. **显式 URL 不 fallback cache**

   输入：显式 Feishu URL 无权限，recent cache 里有旧音频。

   预期：

   - 返回“当前文件无法读取，请重新上传或确认权限”。
   - 不使用旧音频。

7. **跨项目 source profile mismatch**

   输入：文件 A 是 HR 系统会议，文件 B 是视频剪辑 Agent 会议，用户只说“生成方案”，未说合并。

   预期：

   - `needs_clarification`
   - 不生成合并文档。

### Static / Regression

- `python3 src/validate_workspace.py`
- `node --check meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs`
- `node --check meeting-agent-pi-package/tools/task_execution_runner.mjs`
- `node --experimental-strip-types --check meeting-agent-pi-package/extensions/document-worker-runtime.ts`
- `node --experimental-strip-types --check meeting-agent-pi-package/extensions/qa-gate.ts`

### Safety

- artifacts 不含 API key、App Secret、Authorization、cookie、CLI session、raw audio/video。
- `run.metrics.json`、`sanitized-trajectory.json` 不含完整 raw transcript 或完整大文件正文。
- explicit URL token 不进入用户可见回复。

## Rollout Plan

### Phase 1：Source Set Router + recent cache guard

- 先阻断最危险的 silent wrong-source。
- 完成后，多候选 recent cache 会要求用户澄清。

### Phase 2：Evidence Pack v2

- sourceManifest/sourceEvidence/sourceProfiles/conflictMap 落地。
- 多音频按来源分组。

### Phase 3：Prompt + Worker + QA

- prompt 要求 source attribution。
- worker 输出 source-boundary qaInput。
- QA Gate 真正检查 source coverage 和 conflict handling。

### Phase 4：Live Feishu 回归

- 用真实 Feishu 上传多文件、多音频、音频+文件组合验证。
- 检查发布到 Wiki/Drive 的文档标题、H1、source attribution 和待确认项。

## Acceptance Criteria

- 用户明确要求合并时，多音频/多文件可以生成一套合并文档。
- 用户未明确合并且存在多个候选来源时，系统不会静默选错来源。
- 多 source 输出中，关键事实均能回到 source id。
- 不同来源冲突不会被写成确定结论。
- 两个不同会议内容不会被合并成一条无来源边界的连续 evidence。
- QA Gate 能阻断未标注来源、未确认冲突和 recent cache 多候选误用。
