> 历史快照：本文是已归档计划，不代表当前架构。当前路线图见 `../00-plan.md`。

# Profile-based PI Runtime 开发计划

日期：2026-05-21

## Summary

本计划基于 `2026-05-21-profile-based-pi-runtime-architecture.md`，目标是在不推翻现有 PI package 架构的前提下，把当前 Feishu-first runtime 演进为长期可维护、可扩展、速度更优的 Profile-based PI Runtime。

## Implementation Status

2026-05-21 本计划的核心代码迭代已经完成，后续再按本文 Roadmap 处理 queue / Docker worker pool / live WeChat。

已落地文件：

- `meeting-agent-pi-package/tools/task_router.mjs`：共享 task intent router，输出 `schemaVersion=task-intent-v1`、`executionProfile`、`reasoningDepth`、`requiredStages`、`skipStages`，并兼容既有 `taskType/responseMode/requestedDocuments/requiresLocalAsr/sourcePreparation`。
- `meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs`：调用 shared router，task、metrics、run manifest 均记录 profile 字段；不再持有完整 classifier。
- `meeting-agent-pi-package/runtime/feishu-task.schema.json`：`taskIntent.executionProfile` enum 已包含 `fast_answer/file_summary/audio_minutes/document_generation/document_revision/multi_source_synthesis/publish_only/unsupported`。
- `meeting-agent-pi-package/runtime/execution-profiles.json` 与 `.schema.json`：声明 profile contract、轻路径 skip stages、长路径 required stages 和 `rawMediaExternalUpload=false`。
- `meeting-agent-pi-package/tools/task_execution_runner.mjs`：以 `executionProfile` dispatch；`fast_answer/file_summary` 直接走 `model_route_plan` + `model_generate_text`，不进入 document worker、QA、Policy 或 publish；长文档和音频路径复用现有 evidence/prompt/worker/gate/publish 阶段。
- `meeting-agent-pi-package/tools/runtime_tool_cli.mjs` 与 `runtime/tool-load-manifest.json`：按 manifest/profile 加载 PI extension tools，短任务只加载 Model Router / Model Provider。
- `src/validate_workspace.py`：新增 profile config、tool manifest、capability traceability、handler/router 分离和短任务长链路回归检查。

已验证：

- `python3 src/validate_workspace.py`
- `node --check meeting-agent-pi-package/tools/task_router.mjs`
- `node --check meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs`
- `node --check meeting-agent-pi-package/tools/task_execution_runner.mjs`
- `node --check meeting-agent-pi-package/tools/runtime_tool_cli.mjs`
- `node --experimental-strip-types --check meeting-agent-pi-package/extensions/model-routing.ts`
- `node --experimental-strip-types --check meeting-agent-pi-package/extensions/document-generation.ts`
- `node --experimental-strip-types --check meeting-agent-pi-package/extensions/document-worker-runtime.ts`

Fixture smoke 已覆盖：普通问答 `fast_answer`、文件一句话总结 `file_summary`、PRD/架构/checklist `document_generation`、批注修订 `document_revision`、音频会议纪要 router profile `audio_minutes`、删除/图片/视频类 `unsupported`。短任务 smoke 的 `state.json` 不包含 `document_workers_planned`、`qa_gate_completed`、`policy_gate_completed`、`audio_downloaded` 或 `local_asr_started`。

核心策略：

- 不新增第二套编排器。
- 保留 PI `extensions / skills / prompts` 作为原生能力体系。
- 将 `capability-registry.json` 从手写能力注册表逐步降级为派生能力索引。
- 将 Feishu handler 内的 `classifyTaskIntent` 抽成共享 Task Router。
- 用 Execution Profile 控制最小执行路径，避免短任务走长链路。
- 继续坚持渐进式信息披露和按需能力调用。

## Non-Goals

- 不重写 Document Worker。
- 不重写 Model Router。
- 不重写 Prompt Registry。
- 不把所有能力 Docker 化。
- 不把 `task_execution_runner` 升级成业务编排层。
- 不让 capability 成为 PI extension 之外的第二套插件系统。
- 不在本轮接 live WeChat。

## Target State

```text
Ingress Adapter
  -> Shared Task Router
  -> Execution Profile
  -> Thin Runner
  -> PI Extension Tools
  -> Artifacts / Reply / Publish
```

主要代码边界：

| 模块 | 目标职责 |
|---|---|
| `task-router` | 从用户文本、附件、file context、source references 判断 task intent 和 execution profile |
| `task_execution_runner` | 按 profile 执行阶段、记录观测，不做业务决策 |
| `runtime_tool_cli` | 按 PI package 配置或工具 manifest 加载 extension tools |
| `document-generation` | 继续作为 prompt registry 工具 |
| `document-worker-runtime` | 继续作为文档/章节 worker |
| `model-routing` | 继续作为唯一模型路由 |
| `capability index` | 从 extension / manifest 派生，不作为手写第二注册表 |

## Phase 0 - Baseline Review And Safety Lock

状态：已完成。基线由 validator、node static checks 和 profile fixture smoke 固定。

目标：在改动前固定当前行为基线，避免优化过程中打破已修复问题。

### Tasks

- 记录当前关键路径：
  - Feishu text direct answer。
  - PDF 一句话总结。
  - 音频会议纪要。
  - PRD / 技术架构 / Checklist 多文档生成。
  - 文档评论修订。
- 梳理当前 `classifyTaskIntent` 输出字段：
  - `taskType`
  - `requestedDocuments`
  - `requiresLocalAsr`
  - `sourcePreparation`
  - `responseMode`
- 梳理当前 runner 必经阶段：
  - Planner Envelope
  - Model Router
  - Prompt Render
  - Document Worker
  - QA Gate
  - Policy Gate
  - Publish
- 在测试文档中明确“短任务不得进入长链路”的基线。

### Validation

- `python3 src/validate_workspace.py`
- `node --check meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs`
- `node --check meeting-agent-pi-package/tools/task_execution_runner.mjs`
- `node --experimental-strip-types --check meeting-agent-pi-package/extensions/model-routing.ts`
- `node --experimental-strip-types --check meeting-agent-pi-package/extensions/document-worker-runtime.ts`

### Exit Criteria

- 当前回归场景清楚记录。
- 不改运行行为。
- 确认没有新增固定 workflow。

## Phase 1 - Extract Shared Task Router

状态：已完成。实现文件为 `meeting-agent-pi-package/tools/task_router.mjs`。

目标：把 Feishu handler 中的 `classifyTaskIntent` 抽成共享模块，供 Feishu、WeChat fixture、CLI/Web 未来复用。

### New Module

建议新增：

```text
meeting-agent-pi-package/tools/task_router.mjs
```

职责：

- 输入统一 task input：

  ```json
  {
    "channel": "feishu|wechat|local",
    "messageText": "",
    "attachments": [],
    "fileContexts": [],
    "attachmentResolution": {},
    "sourceReferences": []
  }
  ```

- 输出：

  ```json
  {
    "schemaVersion": "task-intent-v1",
    "taskType": "document_analysis|meeting_minutes|doc_writer|document_revision|unsupported|general_chat",
    "responseMode": "direct_answer|document_pipeline|needs_file|ack_file_cached|unsupported",
    "executionProfile": "fast_answer|file_summary|audio_minutes|document_generation|document_revision|multi_source_synthesis|publish_only|unsupported",
    "requestedDocuments": [],
    "requiresLocalAsr": false,
    "sourcePreparation": {},
    "reasoningDepth": "fast|deep",
    "skipStages": [],
    "requiredStages": []
  }
  ```

### Migration

- Feishu handler 调用 `task_router.mjs`。
- WeChat fixture adapter 后续也调用同一 router。
- 暂时保留 handler 内旧函数作为 wrapper 或删除前加测试保护。

### Hard Rules

- Router 不选择模型 provider/model。
- Router 不选择 prompt file。
- Router 不生成文档结构。
- Router 只输出 profile 和任务意图。

### Test Cases

- 无附件普通问答 -> `fast_answer`
- PDF + “一句话总结” -> `file_summary`
- `.wav/.m4a` + “形成会议纪要” -> `audio_minutes`
- Markdown/PDF + “写 PRD/技术架构/checklist” -> `document_generation`
- 文档 + “根据批注修改” -> `document_revision`
- 图片/视频 -> `unsupported`
- 删除文档 -> `unsupported`

## Phase 2 - Add Execution Profile Contract

状态：已完成。实现文件为 `runtime/execution-profiles.json`、`runtime/execution-profiles.schema.json` 和 `runtime/feishu-task.schema.json`。

目标：将 profile 从 router 输出的字符串升级为可验证 runtime contract。

### New Runtime Config

建议新增：

```text
meeting-agent-pi-package/runtime/execution-profiles.json
meeting-agent-pi-package/runtime/execution-profiles.schema.json
```

示例：

```json
{
  "version": "execution-profiles-v1",
  "profiles": [
    {
      "profileId": "file_summary",
      "requiredStages": ["file_context", "model_route_fast", "reply"],
      "optionalStages": [],
      "skipStages": ["planner_envelope", "document_workers", "qa_gate", "policy_gate", "publish"],
      "defaultReasoningDepth": "fast",
      "rawMediaExternalUpload": false
    }
  ]
}
```

### Profile Definitions

必须包含：

- `fast_answer`
- `file_summary`
- `audio_minutes`
- `document_generation`
- `document_revision`
- `multi_source_synthesis`
- `publish_only`
- `unsupported`

### Validation Rules

- `unsupported` 不允许包含 model、worker、publish stage。
- `fast_answer` 不允许默认 QA/Policy/Document Worker。
- `audio_minutes` 必须包含 audio normalize、local ASR、meeting_minutes route。
- `document_generation` 必须包含 prompt registry 和 document workers。
- `document_revision` 必须包含 review context。
- 所有 profile 必须声明 `rawMediaExternalUpload=false`。

## Phase 3 - Make Runner Profile-driven

状态：已完成第一版。`fast_answer/file_summary` 已走轻路径；`audio_minutes/document_generation/document_revision/multi_source_synthesis` 走完整文档 runner。

目标：改造 `task_execution_runner.mjs`，让它根据 `executionProfile` 执行最小路径。

### Required Behavior

#### fast_answer

- 可选调用 fast model。
- 直接写 `agent-output.json`。
- 不写 `qa-gate.json`。
- 不写 `policy-gate.json`。
- 不调用 `document_workers_run`。

#### file_summary

- 使用 file context preview / extracted text bounded slice。
- 走 `model_route_plan(taskType=fast_draft)`。
- 直接回复 summary。
- 不进入 document worker。

#### audio_minutes

- 执行 audio normalize。
- 执行 local ASR。
- 生成 evidence pack。
- 走 meeting-minutes prompt。
- 走 `model_route_plan(taskType=meeting_minutes)`。
- 执行 QA / publish policy。

#### document_generation

- 构建 evidence pack。
- 走 `document_prompt_render_batch`。
- 走 `document_workers_run(sectionBatching=true)`。
- 执行 QA。
- 只有需要发布时执行 Policy。

#### document_revision

- 构建正文 context。
- 构建 review-context。
- 使用 revision overlay。
- 执行 QA。
- 明确覆盖目标时执行 Policy + overwrite。

### Refactor Guidance

- 将当前 `runTaskExecutionPipeline` 拆成私有 stage 函数：
  - `runFastAnswerProfile`
  - `runFileSummaryProfile`
  - `runAudioMinutesProfile`
  - `runDocumentGenerationProfile`
  - `runDocumentRevisionProfile`
- 每个函数仍由同一个 runner 文件调用，避免新增第二 runner。
- 共用 artifact helpers。
- 共用 safety sanitization。

### Anti-Regression

- 无音频源不得出现 `audio_downloaded`、`audio_normalized`、`local_asr_started`。
- `file_summary` 不得出现 `document_workers_planned`。
- `fast_answer` 不得出现 `qa_gate_completed`。
- `document_generation` 不得硬编码 PRD/架构/checklist 章节。

## Phase 4 - Capability Index From PI Extension Metadata

状态：已完成短期兼容约束。`capability-registry.json` 仍保留，validator 已检查 capability traceability；manifest 派生 index 仍是后续项。

目标：解决 capability 与 PI extension 双重注册问题。

### Short-term

保留现有：

```text
runtime/capability-registry.json
extensions/capability-registry.ts
```

但新增约束：

- 不再手动新增大段 capability，除非没有对应 extension。
- 新增能力必须先有 extension/tool 或明确 skill/prompt-only 类型。
- `validate_workspace.py` 检查 capabilityId 能映射到 extension tool、skill 或 prompt。

### Mid-term

新增 capability manifest 规范：

```text
extensions/model-routing.capability.json
extensions/document-generation.capability.json
extensions/feishu-document-review-context.capability.json
```

字段：

```json
{
  "capabilityId": "model-routing",
  "source": {
    "type": "pi-extension",
    "extensionFile": "model-routing.ts",
    "tools": ["model_route_plan", "model_route_record"]
  },
  "defaultLoad": true,
  "toolIntents": ["draft"],
  "policy": [],
  "observability": ["modelRoute"],
  "securityReview": {
    "status": "passed"
  }
}
```

### Long-term

生成：

```text
runtime/generated-capability-index.json
```

并将手写 `capability-registry.json` 变成兼容层或移除。

### Hard Rule

Capability Index 是查询视图，不是执行入口。执行入口永远是 PI extension tool。

## Phase 5 - Runtime Tool Loading Alignment

状态：已完成 safe intermediate step。`runtime_tool_cli.mjs` 读取 `runtime/tool-load-manifest.json`，runner 通过 `--profile` 传入 profile。

目标：让 `runtime_tool_cli.mjs` 与 PI package 配置一致，减少漏加载。

### Current Risk

`runtime_tool_cli.mjs` 当前手写：

```text
planner-runtime.ts
model-routing.ts
document-generation.ts
document-worker-runtime.ts
qa-gate.ts
policy-gate.ts
office-runtime.ts
```

未来新增 extension 后，CLI bridge 可能无法调用。

### Target

- 优先读取 `package.json pi.extensions`。
- 支持显式 allowlist，避免加载高风险或不需要的 extension。
- 允许 profile 声明需要的 extension set。

### Safe Intermediate Step

新增 `runtime/tool-load-manifest.json`：

```json
{
  "version": "runtime-tool-load-manifest-v1",
  "defaultTools": [
    "planner-runtime.ts",
    "model-routing.ts",
    "document-generation.ts",
    "document-worker-runtime.ts",
    "qa-gate.ts",
    "policy-gate.ts",
    "office-runtime.ts"
  ],
  "profileTools": {
    "file_summary": ["model-routing.ts", "model-provider.ts"],
    "document_generation": ["model-routing.ts", "document-generation.ts", "document-worker-runtime.ts", "qa-gate.ts", "policy-gate.ts"]
  }
}
```

Runner 根据 profile 传入 tool set，CLI bridge 只加载必要 extension。

## Phase 6 - Queue And Deployment Boundary

状态：未在本轮实现，仍为后续项。

目标：解决长期常驻进程和资源占用问题，但不提前打乱核心 runtime。

### Local MVP

- Feishu gateway 常驻。
- Handler / task API 常驻。
- Runner 同进程或 child process 执行，但受 profile 控制。
- ASR host-native。
- Hermes batch。

### Next Step

引入本地 queue：

```text
handler -> enqueue run -> runner worker consumes -> final reply/publish
```

可选实现：

- 本地文件队列。
- SQLite queue。
- Redis queue。

### Docker Boundary

适合 Docker：

- gateway
- handler / task API
- bounded runner worker
- Hermes batch

暂不优先 Docker：

- Apple Silicon / MLX local ASR。
- 依赖 macOS keychain 的 lark-cli auth。

## Phase 7 - Documentation And Validation

状态：本轮已更新。validator 已覆盖本节列出的 profile/router/tool manifest/capability 检查。

目标：让文档和代码保持一致，防止开发中再产生固定 workflow 或双重注册。

### Docs To Update

- `wiki/11-current-project-architecture.md`
- `wiki/13-office-agent-product-technical-review.md`
- `wiki/07-test-plan.md`
- `meeting-agent-pi-package/README.md`
- `wiki/04-skill-design.md`

### Validation Additions

`src/validate_workspace.py` 增加检查：

- `task_router.mjs` 存在。
- `execution-profiles.json` 存在且包含全部 profile。
- `file_summary` profile 不包含 document worker / QA / Policy。
- `audio_minutes` profile 包含 audio normalize / local ASR。
- `document_generation` profile 包含 prompt registry / document workers。
- `capability registry` 与 extension/skill/prompt 有映射，不允许孤立 capability。
- `runtime_tool_cli` 不再只依赖硬编码 extension 列表，或硬编码列表必须来自 manifest。
- handler 不再内置完整 `classifyTaskIntent`。

## QA Plan

### Static

- `python3 src/validate_workspace.py`
- `node --check meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs`
- `node --check meeting-agent-pi-package/tools/task_execution_runner.mjs`
- `node --check meeting-agent-pi-package/tools/task_router.mjs`
- `node --check meeting-agent-pi-package/tools/runtime_tool_cli.mjs`
- `node --experimental-strip-types --check meeting-agent-pi-package/extensions/model-routing.ts`
- `node --experimental-strip-types --check meeting-agent-pi-package/extensions/document-generation.ts`
- `node --experimental-strip-types --check meeting-agent-pi-package/extensions/document-worker-runtime.ts`

### Profile Fixtures

| Fixture | Expected Profile | Must Not Happen |
|---|---|---|
| 普通文本问答 | `fast_answer` | Document Worker / QA / Policy |
| PDF + 一句话总结 | `file_summary` | Document Worker / Wiki publish |
| Excel + 总结重点 | `file_summary` | Full file inline |
| `.m4a` + 形成会议纪要 | `audio_minutes` | raw audio external upload |
| Markdown + 写 PRD/架构/checklist | `document_generation` | ASR steps |
| 文档 + 根据批注修改 | `document_revision` | 声称读取不可用评论线程 |
| 图片/视频 | `unsupported` | 模型调用 |
| 删除文档 | `unsupported` | Policy pass / CLI delete |

### Performance Checks

- `fast_answer` artifact 数量应明显少于 document pipeline。
- `file_summary` 不应调用 `document_workers_run`。
- `document_generation` 才允许 section batching。
- 多文档生成应保持 document-level parallelism。
- 会议纪要继续走 deep route。

### Safety Checks

- artifact 不含 API key、Authorization、App Secret、cookie、CLI session。
- metrics/trajectory 不含 raw audio、raw video、完整 raw transcript、完整大文件正文。
- fallback 模型必须写入 `model-route.json`，不静默切换。

## Rollout Status

### Step 1

已完成：新增 `task_router.mjs`，先保持旧 `taskType/responseMode/requestedDocuments/requiresLocalAsr/sourcePreparation` 输出兼容。

### Step 2

已完成：Feishu handler 使用 shared router，task、metrics、manifest 记录 profile 字段。

### Step 3

已完成：新增 `execution-profiles.json` / `.schema.json` 和 `feishu-task.schema.json` profile enum。

### Step 4

已完成：`fast_answer` / `file_summary` 已启用轻路径，smoke 中不出现 document worker、QA、Policy、publish、ASR 阶段。

### Step 5

已完成：`audio_minutes`、`document_generation`、`document_revision` 复用完整文档 runner；revision smoke 生成 review context 并可被 QA 阻断。

### Step 6

已完成短期项：`runtime_tool_cli.mjs` 读取 `tool-load-manifest.json` 并支持 `--profile`；capability index 派生仍是后续项，但 validator 已检查 traceability。

### Step 7

未实施：queue / Docker worker pool / live WeChat 不在本轮范围内。

## Risk Analysis

### Risk: 新 profile 变成另一套固定 workflow

Mitigation:

- Profile 只声明阶段，不写业务文档结构。
- docType、prompt、model 仍由 registry/router 决定。

### Risk: Capability index 迁移导致能力不可见

Mitigation:

- 保留 `capability-registry.json` 兼容。
- 新旧 index 双读一段时间。
- validate 检查 orphan capability。

### Risk: 短路径绕过必要安全检查

Mitigation:

- 只有无发布、无外部动作、无写入的任务可跳过 Policy。
- 只有非长文档、非客户可见交付物可跳过 QA。
- direct reply 仍执行 secret redaction。

### Risk: Router 误判任务 profile

Mitigation:

- Router 输出 reason 和 confidence。
- 低 confidence 或多源冲突时进入 deeper profile 或要求澄清。
- Fixture 覆盖真实 Feishu 场景。

### Risk: 性能优化破坏会议纪要质量

Mitigation:

- `audio_minutes` 继续 deep route。
- meeting-minutes prompt 和 QA 不降级。
- 只优化短任务和文件摘要路径。

## Acceptance Criteria

- 同一任务从 Feishu 和 WeChat fixture 进入同一 execution profile。
- `fast_answer` 和 `file_summary` 速度明显优于旧 document pipeline。
- PRD / 技术架构 / Checklist 仍使用 prompt registry + section-batched document workers。
- 会议纪要仍使用 `meeting_minutes -> deepseek-v4-pro`。
- Capability 不再新增第二套手写注册；新增能力必须能追溯到 PI extension / skill / prompt。
- validate 能阻止以下回归：
  - handler 硬编码文档章节。
  - runner 写死模型。
  - 短任务进入 document worker。
  - 无音频启动 ASR。
  - 无评论请求读取评论线程。
  - capability 孤立于 PI extension / skill / prompt。
