> 历史快照：本文是阶段复盘，不代表当前架构。当前入口见 `README.md`。

# 架构复盘

更新时间：2026-05-22

## 复盘结论

本项目的核心架构判断是：PI 是主动执行面，Hermes 是只读学习侧车；运行时必须是 profile-based agentic office runtime，而不是固定会议流水线。这个判断来自多轮问题修复：音频任务、文件总结、文档修订、长文档生成和多源证据任务看似是不同场景，但共同要求是让 Planner、模型路由、Prompt Registry、Document Worker、QA Gate 和 Policy Gate 保持清晰决策边界。

当前架构可以概括为：

```text
User / Local Files / Feishu / Rokid Export / future IM skeleton
  -> Channel/File adapters
  -> Shared Task Router
  -> Execution Profile
  -> Thin Execution Runner
  -> Planner / Model Router / Prompt Registry
  -> Document Worker / QA Gate / Policy Gate
  -> Publish / Reply
  -> Sanitized Trajectory
  -> Hermes proposal
```

这条链路不是所有任务的固定路径。短问答和文件摘要走轻路径；音频会议纪要、文档生成、多源合成和文档修订才进入长链路。

## 架构演进

早期设计倾向把会议纪要、PRD、架构、运营和复盘看成一条会议后处理流程。真实飞书测试后，这种设计暴露出三个问题：

- 用户输入并不总是会议录音，也可能是文件链接、已生成文档、评论修订、短问答或后续补充。
- 同一入口下的任务成本差异很大，短问答不应加载完整文档 worker 和发布链路。
- 长文档、音频和修订任务需要不同的数据准备方式，不能把所有 source 直接拼入 prompt。

因此架构收敛为 profile-based runtime：

- `fast_answer`：轻量回答，不进入文档 worker、QA Gate、Policy Gate 或发布。
- `file_summary`：只读 bounded preview 和抽取片段，默认直接回复。
- `audio_minutes`：Host 完成音频下载、normalize、本地 ASR，再进入会议纪要和 QA/Policy。
- `document_generation`：走 evidence pack、Prompt Registry、Document Worker、QA/Policy。
- `document_revision`：读取正文和评论上下文，使用 overlay 修订，不复制另一套编排。
- `multi_source_synthesis`：先做 source attribution 和 context pack，再生成文档。

## 决策层边界

项目反复强调 `Decision-layer invariant`，这是防止 runtime 失控的关键。

拥有运行期业务决策权的组件只有：

- Planner：决定任务拆分、能力组合、工具意图、worker 计划和停止条件。
- Model Router：决定模型 route、provider 候选、fallback 和 route 记录。
- Prompt Registry：决定 docType 到正式 prompt 的选择、渲染和 required section contract。
- Document Worker：决定章节批次、合并、缺章节 repair 和文档级 QA input。
- QA Gate：决定内容是否可交付、是否 needs_fix 或 blocked。
- Policy Gate：决定动作边界是否 pass、needs_confirmation 或 blocked。

其他组件只做转换、执行、记录或复盘：

- Capability Registry 只提供 capability 描述和 readiness。
- Task Router 只判断 task intent 和 execution profile。
- Feishu adapter、handler、publisher、File Context、ASR、Observability、Hermes、runtime CLI 都不决定业务结构。
- `task_execution_runner.mjs` 是薄执行器，负责阶段执行、状态、metrics、manifest、timeout 和回复，不成为新的决策层。

这个边界来自实际故障：如果 handler 或 runner 顺手决定文档结构、缓存来源、发布策略或评论语义，问题会跨层扩散，后续很难排查。

## PI 与 Hermes 分离

PI 的职责是执行真实任务：处理飞书事件、本地文件、ASR、文档生成、QA、发布和回复。Hermes 的职责是事后读取脱敏 trajectory，输出 memory、prompt、skill、eval proposal。

这个分离解决了两个风险：

- 高权限执行链不能交给学习侧车，Hermes 不持有飞书或 Rokid 权限，也不直接修改生产 skill/prompt。
- 自优化必须是 proposal -> 人工 review -> 回归测试 -> 合入，而不是任务结束后自动改生产系统。

Hermes 后续可以写入单独思考库，但必须与用户交付 Wiki 分离；缺少 Hermes 目标时只记录 blocked，不得写入用户交付空间。

## Host 控制面与 Local Docker 执行面

项目采用 Host 原生控制面 + Local Docker 受限执行面，而不是把所有计算迁移到 Docker。

Host 保留：

- Feishu live 入口和 `lark-cli`。
- macOS keychain 相关登录态。
- 附件下载、发布、回复。
- 本机 MLX/Metal ASR。
- 文档修订中的飞书评论读取。

Local Docker 只适合：

- Redis 临时队列。
- bounded document worker。
- Hermes proposal worker。

Docker worker 不调用飞书 CLI，不发布，不回复，不接收原始音视频和凭据；它只消费 bounded job bundle 并写 runtime artifacts。这个边界来自 ASR 和飞书权限实践：本地 ASR 依赖 Host 的 MLX/Metal，飞书登录态也属于 Host 运行环境，强行容器化会增加权限和排错成本。

## Runtime Context Plane

多轮修复后，项目新增 Runtime Context Plane 的架构判断。根因不是简单“prompt 太长”，而是运行时缺少一等公民的上下文管理层。

职责边界调整为：

- `file-context`：只做 ingestion metadata、文件识别、抽取和 bounded preview。
- `context-offload`：只做 artifact storage/readback。
- `source-context-runtime`：负责 source records、source segments、deterministic retrieval、context packs、work units、provenance 和 pre-generation context gate。
- `document-generation`：只做 prompt registry 渲染，不拥有 source 选择权。
- Document Worker：消费 section-scoped context pack，而不是每个 batch 反复吃完整大 prompt。

这个修复把“输出分片”和“输入分片”分开处理。section batching 只切输出是不够的；每个章节 worker 还需要目标章节相关的 bounded context pack、sourceSegmentIds 和 retrievalReasons。

## 已修复事项

- 从固定会议链路收敛为 execution profile 驱动。
- 明确 `task_execution_runner.mjs` 是薄执行器，不是新编排层。
- 文档生成统一走 Prompt Registry 和 Document Worker，不在 handler 内硬编码文档结构。
- 本地 Docker 边界收敛为受限执行面。
- Runtime Context Plane 首版实现落地，避免长文档继续传完整大上下文。
- Hermes 与用户交付 Wiki 分离，缺少目标时记录 blocked。

## 遗留风险

- Runtime Context Plane 仍需要更多 live QA 证明文档生成、修订、ASR transcript、多源合成都稳定消费 bounded context pack。
- 文档修订目前仍有从全量生成向 patch-first workflow 继续收敛的空间。
- WeChat 仍只是 skeleton，不能被误用成第二套生产入口。
- Provider fallback、checkpoint retry 和用户侧状态仍需要持续回归，防止长任务再次表现为长期 pending。

## 后续建议

- 任何新增文件、音频、图片或文档输入能力，先设计 extraction、normalization、segmentation、context budget、privacy、cache/store 和 failure UX。
- 所有新 adapter 只映射统一 IM/attachment/task-state contract，不复制 Feishu 主流程。
- 所有新增文档类型必须先进入 Prompt Registry，并同步 QA Gate required section contract。
- 架构文档、测试计划和 issue 记录必须与代码同步更新，避免 wiki 再次落后。
