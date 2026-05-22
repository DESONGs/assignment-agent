# Office Agent 当前产品与技术蓝图

更新时间：2026-05-21

本文是 Office Agent 产品/技术迭代的当前蓝图，用来约束从“会议/文档 Agent + Feishu 双向入口”演进到日常办公 Agent 的下一轮工作。它不替代 `wiki/11-current-project-architecture.md` 的代码同步快照，也不替代 `wiki/12-feishu-agent-bidirectional-integration-plan.md` 的 Feishu 执行计划；这里负责统一产品边界、决策层边界、跨 IM adapter 方向和回归验收标准。

## 0. 本轮硬约束

### 0.1 Decision-layer invariant

运行时只有以下六类组件拥有决策权：

- Planner：决定任务拆分、能力组合、工具意图、worker 计划和停止条件。
- Model Router：决定模型 route、provider 候选、fallback 和 route 记录。
- Prompt Registry：决定 docType 到正式 prompt 的选择、渲染和 required section contract。
- Document Worker：决定章节批次执行、合并、缺章节 repair 和文档级 QA input。
- QA Gate：决定内容是否可交付、是否 needs_fix 或 blocked。
- Policy Gate：决定动作边界是否 pass、needs_confirmation 或 blocked。

其他组件不是决策层：

- Capability Registry 只提供 capability 描述、readiness、policy metadata 和启用状态；是否选择 capability 由 Planner 决定。
- `task_router.mjs` 只判断 task intent 和 `executionProfile`，不得选择模型、prompt、文档结构、QA、Policy 或发布策略。
- Feishu adapter、未来 WeChat adapter、handler、publisher、File Context、ASR、Observability、Hermes sidecar 和 `runtime_tool_cli.mjs` 都只负责转换、执行、记录或复盘。
- `task_execution_runner.mjs` 只是薄的可观测执行器：执行阶段、写 state/metrics/manifest/trajectory、处理 timeout 和进度回复；它不得决定任务拆分、模型、prompt、文档结构、QA 结果、Policy 结果或发布策略。

### 0.2 WeChat scope this round

WeChat 本轮只做 adapter skeleton：

- 定义 WeChat 如何映射到 `im-event-v1`、`im-attachment-v1`、`im-reply-v1`、`publish-target-v1` 和 `office-task-state-v1`。
- 建立 Feishu/WeChat channel capability matrix。
- 写清楚权限、附件、回复、发布和 unsupported 边界。
- 不把 WeChat 做成第二套 Agent 主流程。
- 不承诺 live 收消息、下载附件、发文件、建云文档、群内发布或正式生产回归。

### 0.3 Feishu audio-minutes regression

飞书音频会议纪要是本轮必须保持显式的回归场景。音频附件解析后必须进入 `task_execution_runner.mjs` 的可观测执行路径，而不是在 ASR 完成后回到不可观测的长任务黑盒。

至少要能在 `state.json` / metrics / manifest 中复查以下阶段：

- `task_execution_runner_started`
- `audio_downloaded`
- `audio_normalized`
- `local_asr_started`
- `local_asr_completed`
- `model_route_planned`
- `meeting_minutes_generated`
- `qa_gate_completed`
- `policy_gate_completed`
- publish/reply completed、needs_fix、blocked 或 failed 的最终状态

会议纪要模型选择必须通过 Model Router 的 `meeting_minutes` route，默认 `deepseek/deepseek-v4-pro`；ASR 仍是 local-only。飞书上传的 WAV/MP3/M4A/AAC/FLAC/OGG 先由本地 runtime 归一化为 `16k mono s16 WAV`，原始音频不得发给外部 provider。

## 1. 当前产品判断

当前系统已经具备 Office Agent 雏形：

- Feishu 是第一办公入口，已具备事件入口、handler、附件处理、文档发布和回复链路。
- 本地音频可进入 local ASR、evidence index、会议纪要和 QA/Policy。
- 文本型文件可进入 `file-context`，再进入直接回答或文档生成。
- PRD、技术架构、运营方案、客户需求清单和会议纪要 prompt 已通过 Prompt Registry 管理。
- Document Worker 已支持文档级并行和章节分批生成。
- `run.metrics.json`、`run-manifest.json` 和 `sanitized-trajectory.json` 已开始支撑 Hermes 复盘。

当前不足仍然集中在办公产品化：

- 统一 IM 入口还只有 Feishu 实现，WeChat 本轮只能是 skeleton。
- 任务状态、取消/重试/补充、待确认和失败可恢复还需要产品化。
- 文件、会议、任务、日历、历史 run 和用户偏好的检索层还不完整。
- 文档编辑生命周期偏向“新建”，对已有文档修改、diff、版本和评论支持不足。
- 权限策略需要对用户可见，而不只存在于内部 gate。

## 2. 产品蓝图

### 2.1 统一任务入口与状态

用户可以从 Feishu、未来 WeChat skeleton 映射、本地文件或后续其他入口发起同一类办公任务。入口差异只体现在 adapter 能力和权限上，不产生第二套 Agent。

用户侧状态使用稳定文案：

- `已接受`
- `处理中`
- `需要补充信息`
- `已完成`
- `暂不支持`
- `失败，可重试`

用户侧回复不得暴露本地 `runId`、QA/Policy 内部术语、handler 诊断或 provider 栈信息。`runId` 只保留在本地 artifact、metrics 和 trajectory 中。

### 2.2 办公对象

Office Agent 后续应围绕以下对象组织能力：

- 会议信息：音频、转写、evidence、纪要、行动项、风险和开放问题。
- 文档：会议纪要、PRD、技术架构、运营方案、客户需求清单、日报/周报/项目简报。
- 文件：PDF、Word、Excel、Markdown、TXT、CSV 以及 unsupported 媒体。
- 协作对象：Feishu chat/thread/folder/doc，未来 WeChat conversation/contact/group skeleton。
- 日历和任务：创建、修改、提醒、分派和状态同步。
- 组织上下文：项目、客户、联系人、角色称谓、模板和偏好。

### 2.3 文档生命周期

当前强项是生成新文档。下一阶段需要补齐：

- 修改已有文档。
- 根据反馈重写指定章节。
- 生成变更摘要或 diff。
- 保留版本与 source run 链接。
- 追加评论、待确认问题和缺失输入。
- 从多份材料合并正式稿。

修改已有文档必须有明确目标：用户提供 file token/link，或目标来自当前会话内 Agent 已生成且记录在 publish target registry 的文档。删除、清空、移除、销毁类动作保持 blocked。

`document_revision` 是文档生命周期能力的一部分，不是第二套编排。它的输入是已有正文、用户修订要求和 `review-context.json`。正文结构仍来自原 docType prompt，例如 PRD 仍走 `prd.md`；批注/修改约束只通过 `document-revision-overlay.md` 追加。Feishu adapter 不决定章节怎么改，Document Worker 也不读取飞书；它只接收已渲染 prompt。当前实现优先通过 `lark-cli drive file.comments list`、`file.comments batch_query`、`file.comment.replys list` 读取真实独立评论线程，SDK 只作同 API fallback。若 scope 不足，系统必须记录 `comment_api_permission_blocked`；若只能从导出正文看到批注痕迹，则记录 `body_ready_comments_not_available` / `export_body_detected`，并在输出中把“独立评论线程未读取”作为待确认，而不是凭空编造批注意图。

评论线程不是全局池。`review-context.json` 使用 `sourceDocuments[].comments[]` 作为主结构，Runner 只在对应 source 的正文内匹配 quote，并把结果写成 `exact_unique`、`exact_multiple`、`fuzzy`、`unmatched` 或 `exported_body_detected`。这个约束是后续多 IM、多文档修订的防回归基线：任何 adapter 都只能提供 source 和附件，不能自行解释或跨 source 应用评论。

### 2.4 授权策略产品化

当前默认策略：

- 用户明确要求创建、撰写、保存、发布、放到云端或覆盖修改时，Feishu inbound 的非删除类 `write_private` / `publish_customer_visible` 可在 QA pass 后执行。
- 删除、清空、移除、销毁类动作始终 blocked。
- 群消息主动通知、任务/日历变更、外部联网、安装依赖、长期记忆写入仍按 action intent 判断。

后续产品需要把以下问题明确给用户和团队：

- 哪些动作自动执行。
- 哪些动作需要确认。
- 哪些动作永远禁止。
- 私聊和群聊的默认权限是否不同。
- Feishu 和 WeChat skeleton 的能力差异。
- 客户可见、团队可见、个人可见边界。

### 2.5 偏好与组织记忆

偏好和组织记忆应以可审计 profile/memory 存储，不写死进 prompt：

- 默认发布位置。
- 默认文档命名规则。
- 会议纪要详略偏好。
- PRD、运营方案、技术架构模板偏好。
- 常见项目、客户、团队成员和角色称谓。
- 常用后续动作，例如是否自动生成待办、是否自动回复群消息。

Planner 只读取当前任务必要片段；长期记忆写入必须经过 Policy Gate。

## 3. 技术蓝图

### 3.1 Cross-channel contract

目标结构：

```text
Feishu adapter / WeChat adapter skeleton / local file input
  -> Unified IM + attachment + task-state contracts
  -> Planner
  -> Capability Registry metadata/readiness
  -> File Context / local ASR / runtime tools
  -> Model Router
  -> Prompt Registry
  -> Document Worker
  -> QA Gate
  -> Policy Gate
  -> channel publisher/reply adapter
  -> runtime metrics / manifest / sanitized trajectory
```

其中只有 Planner、Model Router、Prompt Registry、Document Worker、QA Gate、Policy Gate 是决策层。Capability Registry、File Context、ASR、adapter、publisher 和 observability 不拥有业务决策权。

统一事件至少包含：

- `channel`
- `actor`
- `conversation`
- `messageText`
- `attachments`
- `parentMessage`
- `rootMessage`
- `replyTarget`
- `permissions`
- `timestamp`

### 3.2 Feishu adapter

Feishu 是第一阶段主办公系统：

- 事件入口：`lark-cli event consume` -> `feishu_event_runner.mjs` -> `feishu_agent_task_handler.mjs`。
- 发布入口：`drive +create-folder`、`markdown +create`、`markdown +overwrite`、`drive +upload`、`im +messages-reply`。
- 文件上下文：当前消息附件 -> 显式 Feishu file URL/token -> 父消息/root 消息资源 -> 同 chat/sender/thread 最近 30 分钟附件缓存。显式 URL 不被缓存覆盖，缓存按文本/音频模态过滤。
- 文档发布和回复必须在 QA Gate 与 Policy Gate 允许后执行。
- MCP 不是收消息、回复或发布的必要路径，只能作为 optional capability。

### 3.3 WeChat adapter skeleton

WeChat 本轮只定义 skeleton，不实现完整可用入口：

- 映射 WeChat `contact/group/message` 到统一 `actor/conversation/message`。
- 标注当前支持能力为 planned/skeleton，而不是 production-ready。
- 对附件下载、群文件发送、云文档发布、联系人身份映射和长期会话记忆保持未接入。
- 用户请求 WeChat live 动作时，应按 unsupported 或待接入处理，不能复制 Feishu bridge 的完整发布能力。

未来实现时，WeChat adapter 只能负责收发和转换；任务拆分、模型、prompt、文档、QA 和 Policy 继续走同一套决策层。

### 3.4 File Context and retrieval

File Context 层供 Feishu、WeChat skeleton、本地文件和后续入口复用：

- MIME 与扩展名识别。
- 附件缓存与父消息/root 消息回溯，显式 URL/token 优先。
- PDF、Word、Excel、Markdown、TXT、CSV 文本抽取。
- 音频文件进入 local ASR。
- 多个音频、会议纪要文件或文档 URL 默认合并为一个 `evidence-pack.json`，冲突按 source attribution 标注并列入待确认。
- 每个文档 run 同步生成 `document-title-plan.json`：标题从用户 prompt 和 source map 中的具体项目/方向推断，最终 Markdown H1、飞书 `.md` 文件名和 publish manifest 使用同一标题。会议纪要、PRD、技术架构、运营方案、客户需求确认表都不能只用裸 docType 或模板里的“待确认项目”作为最终文档名。
- 用户交付物默认进入 Feishu Wiki：`wiki-publish-plan.json` 根据项目/日期/主题/docType 动态生成目录树，`feishu-wiki-target-registry.json` 用内容化 reuse key 复用节点。Wiki adapter 只执行 `markdown +create`、`wiki +node-create`、`wiki +move`，不决定目录语义；权限不足时 Drive fallback 并记录 `wiki_publish_blocked_drive_fallback`。
- 图片和视频默认返回 `目前暂不支持该功能`。
- 大文件渐进披露。
- `fileContextMap`、`evidenceMap`、hash、bounded preview 和 source path 管理。

长期办公能力还需要本地 retrieval index，覆盖历史 run manifest、已生成文档、文件摘要、会议纪要、transcript 摘要、项目/客户/人员实体、用户偏好、任务和日历记录。

### 3.5 Task state and idempotency

通用 task state machine：

```text
received
accepted
planning
waiting_input
processing
qa_review
publishing
completed
needs_fix
unsupported
failed
cancelled
```

每个状态都写入 artifact，并能被 IM reply 层读取。重复事件、重试、取消、附件迟到和回复父消息失败都需要幂等处理。

### 3.6 Observability and Hermes

每个非平凡 run 应稳定记录：

- 端到端耗时和各阶段耗时。
- Planner decision、model route、prompt registry selection、document worker batches、QA result、Policy result。
- provider 成功率、fallback 和失败原因。
- ASR 耗时和失败原因。
- 文件解析失败率。
- 文档生成缺章节率。
- 发布失败原因。
- 用户重试率。
- unsupported 类型分布。
- Feishu 事件丢失或附件关联失败率。
- 未来 WeChat skeleton/live 差异导致的 unsupported 分布。

Hermes 只能读取 sanitized trajectory 并输出 proposal，不自动修改生产 prompt、skill 或 runtime 配置。Hermes 现在还会生成 `hermes-wiki-candidate.json`、`hermes-wiki-reflection-gate.json` 和 `hermes-wiki-publish.json`；Gate pass 后默认尝试写入单独的 Hermes 思考库目标，缺少 `HERMES_WIKI_SPACE_ID` 或 `HERMES_WIKI_ROOT_NODE_TOKEN` 时 blocked，绝不写入用户交付 Wiki。

## 4. 验收标准

本轮文档和后续实现完成后，至少满足：

- 所有核心 docs 都声明 decision-layer invariant。
- `task_execution_runner.mjs` 被描述为薄执行器，不被描述为编排层或业务决策层。
- Feishu 音频会议纪要回归显式要求 `task_execution_runner_started`、`audio_downloaded`、`audio_normalized`、`local_asr_started`、`local_asr_completed`、`model_route_planned`、`meeting_minutes_generated`、`qa_gate_completed`、`policy_gate_completed`。
- Feishu 文档写作回归要求显式 file URL 不 fallback 到旧音频缓存，非音频文档任务生成 `evidence-pack.json` 和 `documents_generated`，且不出现 ASR 阶段。
- Profile-based runtime 回归要求 handler 调用 `task_router.mjs`，并在 `task.json`、metrics、manifest 记录 `executionProfile/reasoningDepth/requiredStages/skipStages`；`fast_answer/file_summary` 不得出现 document worker、QA Gate、Policy Gate、publish 或 ASR 阶段。
- Feishu 文档修订回归要求显式 doc/docx/wiki URL + “根据批注/修改内容优化”进入 `document_revision`，生成 `review-context.json`，使用 base prompt + `document-revision-overlay.md`，并记录 `document_lifecycle.action=revised`；不得落回 `direct_answer` 或 ASR/会议纪要路径。
- 文档命名回归要求 PRD/技术架构/checklist 的 H1 与 Feishu 文件名包含具体项目/方向，且与 `document-title-plan.json` 保持同步。
- Wiki 发布回归要求生成 `wiki-publish-plan.json`、`wiki-publish.json`，Wiki 不可用时明确 Drive fallback；Hermes 回归要求生成 candidate/gate/publish 三个 artifact，且 Hermes 目标与用户交付目标分离。
- WeChat 本轮只标为 adapter skeleton，不承诺 production live 能力。
- 文件、音频和 unsupported media 有一致处理策略。
- 用户明确要求创建、撰写、发布、保存、覆盖修改时，Feishu 非删除动作不会被过度确认阻塞。
- 删除类动作始终 blocked。
- 用户侧回复不暴露本地 run id、内部 gate 术语或 handler 诊断。
- 任何新增开发问题、架构分歧、QA 失败或 channel 集成失败，都进入 `wiki/issues/`。

## 5. Roadmap

### P0：当前轮

- 同步 docs/skills 中的 decision-layer invariant。
- 保持 Feishu audio minutes regression 显式。
- 固化 `task_execution_runner` thin executor contract。
- 只定义 WeChat adapter skeleton 和 capability matrix。
- 确认 Feishu file/audio/unsupported/publish policy 的文档一致性。

### P1：可靠办公入口

- Feishu confirm/cancel/retry/status 状态交互。
- 通用 task state machine 和幂等重试。
- 共享 File Context Service。
- 本地 retrieval index。
- 文档修改、版本和覆盖发布。

### P2：办公核心能力

- 日程、提醒、Todo 和任务跟进。
- 项目级上下文和联系人/客户轻量档案。
- 用户偏好与组织 memory。
- 每日/每周/项目简报。
- 多文档合并与专题报告。

### P3：协作与自动化增强

- 审批队列与人工复核。
- 外部资料检索与 source card。
- 邮件、CRM、表格数据库和知识库扩展。
- 更细粒度的团队权限策略。
- WeChat live adapter 评估，但必须先通过 skeleton 边界和安全审查。

## 6. Issue 记录要求

本文中的能力缺口不是一次性开发清单。后续实现时，如果遇到以下问题，必须在 `wiki/issues/` 下新增 Markdown issue：

- Feishu 事件消费、附件下载、发布或回复不稳定。
- Feishu audio minutes regression 缺阶段 marker 或 ASR 后再次长期 pending。
- WeChat skeleton 被误当成 production adapter。
- Feishu 和 WeChat 的身份映射出现歧义。
- 文件上下文跨会话误关联。
- 发布权限、修改权限或删除阻断策略出现争议。
- Provider fallback 与用户可见结果不一致。
- Hermes trajectory 缺少必要决策信号。
- 检索层引入上下文膨胀或跨项目泄漏。

Issue 文档应包含：问题背景、当前证据、影响范围、根因判断、修复方向、验证方式和当前状态。
