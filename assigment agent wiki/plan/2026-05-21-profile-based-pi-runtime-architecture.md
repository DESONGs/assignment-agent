# Profile-based PI Runtime 长期架构方案

日期：2026-05-21

## Summary

当前项目已经具备较好的 agentic runtime 基础：PI `extensions` 是实际工具入口，`skills` 提供模型使用说明，`prompts` 提供正式文档模板，`document-prompt-registry.json` 是文档结构映射，`model-routing.json` 是模型选择入口，`task_execution_runner.mjs` 是薄执行器，`im_file_context_helpers.mjs` 已具备渐进披露策略。

长期优化的重点不是再加一个完整编排层，也不是把所有任务都强制走 `Planner -> Capability Registry -> Model Router -> Prompt Registry -> Document Worker -> QA -> Policy -> Publisher`。更稳定的方向是引入 **Profile-based Execution**：先用轻量 Task Router 判断任务 profile，再只启用该 profile 必需的 PI extension、prompt、model route、QA/Policy 和 publish 阶段。

## Implementation Status

2026-05-21 本方案已经在代码中落地为第一版 profile-based runtime：

- Shared router：`meeting-agent-pi-package/tools/task_router.mjs` 是 task intent 的唯一共享入口；`feishu_agent_task_handler.mjs` 不再内置完整 classifier，只调用 router，并把 `executionProfile/reasoningDepth/requiredStages/skipStages` 写入 task、metrics 和 manifest。
- Profile contract：`meeting-agent-pi-package/runtime/execution-profiles.json` 和 `execution-profiles.schema.json` 已声明 `fast_answer`、`file_summary`、`audio_minutes`、`document_generation`、`document_revision`、`multi_source_synthesis`、`publish_only` 和 `unsupported`。
- Runner dispatch：`task_execution_runner.mjs` 以 `taskIntent.executionProfile` 为入口；`fast_answer` 与 `file_summary` 走轻路径，只调用 Model Router / Model Provider 并直接回复；`audio_minutes`、`document_generation`、`document_revision` 继续走 evidence pack、prompt registry、document workers、QA/Policy 和 publish。
- Tool loading：`runtime_tool_cli.mjs` 读取 `runtime/tool-load-manifest.json`，并支持 `--profile` 加载对应 extension set；短 profile 只加载 `model-routing.ts` 和 `model-provider.ts`，长文档 profile 才加载 Planner / Prompt / Worker / QA / Policy / Office 相关 extension。
- Capability compatibility：`runtime/capability-registry.json` 保留为兼容查询视图；`src/validate_workspace.py` 新增 capability traceability 检查，要求 capability 可追溯到 extension、skill、prompt 或明确 external/system 类型。
- Validation：`src/validate_workspace.py` 会检查 router/profile config、profile stage 合规、manifest 加载、handler 不回退到完整 classifier、短任务不进入 document worker / QA / Policy / publish / ASR。

目标是同时解决三类问题：

- 速度：短任务不进入长文档 worker、QA Gate、Policy Gate、Wiki publish。
- 稳定性：Feishu / WeChat / CLI / Web 等入口共享同一 task router 和 runner，不在 handler 中复制业务分支。
- 可维护性：Capability 不再作为第二套手写注册系统，而是 PI extension / package manifest 的派生能力索引。

## Current Code Findings

### 已经值得保留的设计

- `meeting-agent-pi-package/package.json` 已经声明 PI 原生入口：

  ```json
  {
    "pi": {
      "extensions": ["./extensions"],
      "skills": ["./skills"],
      "prompts": ["./prompts"]
    }
  }
  ```

- `extensions/*.ts` 是当前真实可调用能力组件，内部通过 `pi.registerTool(...)` 暴露工具。
- `runtime_tool_cli.mjs` 已经作为非 PI bridge 代码调用 PI extension tools 的桥，避免 handler 重写 Planner、Model Router、Prompt Registry、Document Worker、QA、Policy 逻辑。
- `document-generation.ts` 已统一读取 `document-prompt-registry.json`，没有再硬编码 PRD、技术架构、运营方案、Checklist 章节。
- `document-worker-runtime.ts` 已支持 document-level parallel workers、section batching、dependency waves 和 repair pass。
- `model-routing.ts` 已支持 `fast_draft`、`meeting_minutes`、`document_shard_fast`、`document_shard_deep` 等 route。
- `im_file_context_helpers.mjs` 已支持文件类型识别、文本抽取、音频 local ASR only、图片/视频不支持，以及 `progressiveDisclosureRequired`。
- `task_execution_runner.mjs` 已明确是薄执行器，不应成为第二个编排层。
- `feishu_agent_task_handler.mjs` 中的 `classifyTaskIntent` 已经是轻量 Task Router 雏形。

### 当前主要结构性风险

1. **Feishu handler 内含 task intent 判断 - 已收敛**

   `classifyTaskIntent` 已迁移到 `task_router.mjs`。Feishu handler 只调用共享 router；未来 WeChat / CLI / Web 应复用同一 router，不能复制业务 classifier。

2. **document_pipeline 过重 - 已分 profile 缓解**

   `fast_answer` 和 `file_summary` 已启用轻路径，不进入 Planner Envelope、Document Worker、QA Gate、Policy Gate 或 Wiki publish。长文档、音频纪要和批注修订仍走完整文档链路。

3. **Capability Registry 与 PI extension 存在双重注册风险 - 已加校验**

   当前仍保留 `capability-registry.json` 兼容，但 validator 已要求 capability 可追溯到 extension tool、skill、prompt 或明确 external/system 类别。后续新增能力仍应先落到 PI extension / skill / prompt，再派生 index。

4. **runtime_tool_cli 手写 extension load list - 已改为 manifest/profile**

   `runtime_tool_cli.mjs` 已读取 `runtime/tool-load-manifest.json`，并按 profile 加载必要 extension；如果请求的 tool 未在 profile set 中注册，会在 manifest 全量 extension 内补查，避免新增第二套执行注册系统。

5. **决策层文档表述偏“全链路”**

   当前文档强调 Planner / Router / Registry / Worker / QA / Policy 决策边界是正确的，但容易被实现理解成所有任务都必须完整经过这些 gate，影响速度和稳定性。

## Architectural Principle

长期架构应收敛为：

```text
Ingress Adapter
  -> Shared Task Router
  -> Execution Profile
  -> Thin Runner
  -> PI Extensions / Prompts / Skills
  -> Artifacts / Reply / Publish
```

其中：

- Ingress Adapter 只做消息标准化、附件解析、ack，不做业务文档结构和模型选择。
- Task Router 只判断任务意图、输入模态、所需 execution profile，不生成内容。
- Execution Profile 只声明最小必要阶段，不是新编排器。
- Thin Runner 只执行 profile 阶段、写 state/metrics/manifest/trajectory，不拥有业务决策。
- PI extensions 是真实工具能力入口。
- prompts 和 document-prompt-registry 是文档结构唯一来源。
- model-routing 是模型选择唯一入口。
- QA / Policy 只在 profile 需要时启用。

## PI Extension / Skill / Prompt / Capability Relationship

### 推荐定义

| 概念 | 真实职责 | 长期约束 |
|---|---|---|
| PI Extension | 可执行工具组件，注册 `registerTool` | 能力执行入口 |
| Skill | 给模型看的使用说明 | 描述如何使用能力，不作为执行注册 |
| Prompt | 正式文档或任务模板 | 输出结构唯一来源 |
| Capability Manifest | extension/package 对外声明能力元数据 | 可选，作为索引来源 |
| Capability Index | 从 manifest / extension metadata 派生的只读索引 | 不手写第二套能力注册 |

### 不推荐

```text
extension 注册一次
capability-registry.json 手写一次
skill 文档再描述一次
handler 再判断一次
wiki 再同步一次
```

这种模式会导致双重甚至多重注册，后续能力增删容易漂移。

### 推荐

```text
PI extension/package = 能力源头
capability manifest = 能力元数据
generated capability index = runtime 查询视图
```

未来能力目录可以逐步演进为：

```text
meeting-agent-pi-package/
  extensions/
    model-routing.ts
    model-routing.capability.json
    feishu-document-review-context.ts
    feishu-document-review-context.capability.json
  skills/
  prompts/
  runtime/
    generated-capability-index.json
```

或进一步产品化为：

```text
capabilities/
  feishu-document-review-context/
    capability.json
    extension.ts
    SKILL.md
    schemas/
    tests/
```

但无论哪种目录形态，**Capability Index 都应是派生结果，不应成为第二套手写注册系统**。

## Execution Profiles

Profile 是最小执行路径声明，不是新 workflow 引擎。Task Router 选择 profile，Runner 按 profile 执行阶段。

### fast_answer

适用：

- 普通问答。
- 无附件轻量回复。
- 不需要发布文档、不需要 QA/Policy 的短任务。

路径：

```text
Task Router
  -> optional fast model route
  -> reply
```

默认不启用：

- Document Worker
- QA Gate
- Policy Gate
- Wiki publish
- ASR
- Review Context

### file_summary

适用：

- PDF / Word / Excel / Markdown / TXT / CSV 一句话总结或简短摘要。

路径：

```text
Task Router
  -> File Context preview / summary first
  -> Model Router fast_draft
  -> direct reply
```

上下文原则：

- Excel 先披露 sheet 名、表头、少量值预览。
- PDF / Word 先披露标题、摘要、相关段落预览。
- 不把完整大文件直接塞入 prompt。

### audio_minutes

适用：

- 音频/录音/转写生成会议纪要。

路径：

```text
Task Router
  -> audio normalize
  -> local ASR
  -> evidence pack
  -> meeting-minutes prompt
  -> Model Router meeting_minutes / deepseek-v4-pro
  -> QA Gate
  -> publish / reply
```

约束：

- 原始音频只本地处理，不外发。
- ASR 输入使用 normalized WAV。
- 会议纪要质量优先，默认 deep route。

### document_generation

适用：

- PRD、技术架构、运营方案、客户 Checklist、长文档撰写。

路径：

```text
Task Router
  -> source references
  -> file context / optional ASR
  -> evidence pack
  -> document_prompt_render_batch
  -> document_workers_run section batching
  -> QA Gate
  -> Policy Gate when publishing
  -> publish / reply
```

约束：

- 文档结构只来自 `prompts/*.md` 和 `document-prompt-registry.json`。
- Worker 只消费 renderedPrompt，不硬编码章节。
- PRD、技术架构、复杂 checklist 默认 deep route。

### document_revision

适用：

- 基于飞书文档正文、批注、评论线程进行修订。

路径：

```text
Task Router
  -> document body export
  -> Feishu comment API / reply API
  -> source-scoped review-context matching
  -> prompt registry + document-revision-overlay
  -> document worker
  -> QA Gate
  -> overwrite / publish
```

约束：

- 评论线程必须 source-scoped。
- API 评论不可读时，不得声称已处理独立评论线程。
- 弱匹配或未匹配评论必须进入待确认。

### multi_source_synthesis

适用：

- 多音频、多会议纪要、多文件、多 URL 合并生成一套文档。

路径：

```text
Task Router
  -> source-set router
  -> source preparation
  -> source-boundary evidence pack
  -> document generation profile
```

约束：

- 显式 URL/token 优先，不 fallback 到 recent cache。
- 多源冲突按 source 标注并进入待确认。
- 不把 A 文档评论用于 B 文档。

### publish_only

适用：

- 已生成文档再次发布、覆盖明确目标文档。

路径：

```text
Task Router
  -> Policy Gate
  -> Publisher
```

约束：

- 明确 Feishu 创建/发布/覆盖修改可以默认允许。
- 删除、清空、移除、销毁永远 blocked。

### unsupported

适用：

- 图片理解、视频素材理解、删除动作、无法读取文件、当前不支持能力。

路径：

```text
Task Router
  -> reply: 目前暂不支持该功能
```

不启动长链路。

## Progressive Disclosure Contract

所有 profile 都必须遵守渐进式信息披露：

```text
raw input
  -> sourceReferences[]
  -> sourceMap
  -> fileContextMap
  -> evidencePack
  -> taskContext
  -> sectionContext
  -> qaContext
  -> sanitizedTrajectory
```

阶段输入原则：

| 阶段 | 可见上下文 |
|---|---|
| Task Router | 用户文本、附件类型、文件名、source metadata、短 preview |
| Model Router | taskType、docType、reasoningDepth、complexity、privacy boundary |
| Prompt Render | evidence pack、router conclusion、必要片段 |
| Document Worker | 当前 docType / section 需要的 evidence slice |
| QA Gate | 输出、requiredSections、source map、claim issues |
| Policy Gate | 动作意图、目标对象、风险元数据 |
| Hermes | sanitized trajectory、短摘要、hash、artifact pointer |

禁止：

- 将完整 raw transcript 写入 metrics / trajectory。
- 将完整大文件全文长期注入 memory。
- 将 raw audio/video/base64 media 发给外部 LLM。
- 将 secret、token、cookie、Authorization、CLI session 写入日志或 artifact。

## Model Routing Contract

模型选择继续由 `model-routing.json` 和 `model_route_plan` 统一负责。

默认：

| 场景 | Route |
|---|---|
| 普通问答 / 一句话总结 | `fast_draft` / `deepseek-v4-flash` |
| 文件简短摘要 | `fast_draft` / `deepseek-v4-flash` |
| 会议纪要 | `meeting_minutes` / `deepseek-v4-pro` |
| PRD / 技术架构 / 复杂 checklist | `document_shard_deep` / `deepseek-v4-pro` |
| 普通文档章节 | `document_shard_fast` / `deepseek-v4-flash` |
| QA Gate | deterministic rules first |

禁止：

- handler 写死模型名。
- runner 写死模型名。
- worker 跳过 `model_route_plan`。
- fallback 静默发生而不写 `model-route.json`。

## Runner Contract

`task_execution_runner.mjs` 应保持薄执行器：

- 执行 profile stages。
- 写 state / metrics / manifest / trajectory。
- 管理 timeout、progress reply、artifact path。
- 调用 PI extension tools。

它不得：

- 决定 docType 章节。
- 选择模型。
- 选择 prompt 文件。
- 判断 QA 结果。
- 判断 Policy 结果。
- 在没有 profile 要求时启动 ASR、Review Context、Document Worker 或 Wiki publish。

## Ingress Adapter Contract

Feishu、未来 WeChat、CLI、Web 都只做 adapter。

职责：

- 标准化事件为统一 IM / task input。
- 下载或登记 source references。
- 回用户 ack。
- 调用共享 Task Router / Runner。
- 根据最终 artifact reply / publish。

不得：

- 硬编码会议纪要、PRD、架构、Checklist 的流程。
- 自己拼正式 prompt。
- 自己选择模型。
- 自己绕过 evidence pack。

## Deployment Implications

长期部署建议：

```text
Light always-on:
  - Feishu gateway
  - Task handler / task API

On-demand or bounded worker:
  - task execution runner
  - document workers
  - publish worker

Host-native heavy service:
  - local ASR on Apple Silicon / MLX

Batch:
  - Hermes sidecar
```

Docker 适合：

- gateway
- handler / task API
- bounded runner worker
- Hermes batch
- ffmpeg-based file/audio helper

不优先 Docker 化：

- 依赖 Apple Silicon / MLX 的本地 ASR。
- 依赖 macOS keychain/session 的 lark-cli auth，除非先完成 credential volume / env 模型。

## Hard Rules

1. Handler 不判断文档结构。
2. Runner 不选择模型。
3. Runner 不选择 prompt。
4. Runner 不硬编码 docType 章节。
5. Model 名只能在 `model-routing.json`。
6. 文档结构只能在 `prompts/*.md` 和 `document-prompt-registry.json`。
7. Capability Index 只能派生，不手写双份。
8. 短任务不得进入 document worker。
9. 无发布动作不得进入 Policy Gate。
10. 无长文档不得进入 section batching。
11. 无评论请求不得读取评论线程。
12. 无音频源不得启动 ASR。
13. 图片/视频素材当前不支持，直接返回“目前暂不支持该功能”。
14. 删除、清空、移除、销毁永远 blocked。

## Success Criteria

- Feishu、WeChat fixture、CLI 三种入口对同一输入得到相同 profile。
- 一句话总结不生成 document worker、QA、Policy artifact。
- PDF 简短摘要只使用 file preview / relevant snippets。
- `.wav/.m4a/.mp3` 会议纪要进入 audio normalize + local ASR + meeting minutes profile。
- PRD/技术架构/Checklist 进入 document_generation profile，且 prompt 来自 registry。
- 评论修订进入 document_revision profile，且 review-context source-scoped。
- capability index 可由 extension / manifest 派生，避免重复手写注册。
- `validate_workspace.py` 能检查 hard rules，防止回归为固定 workflow。
