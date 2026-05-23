# Skill 设计文档

## 1. Skill 设计原则

- Skill 负责稳定流程，prompt 负责表达细节，extension/tool 负责真实外部动作。
- 每个 skill 必须明确输入、输出、禁止行为和 Phase。
- Skill 是 PI Agentic Planner 可选择的 capability/playbook，不代表固定运行顺序；Phase 是开发路线和验收分组，不是运行时 workflow。
- Planner Envelope、Policy Gate 和 Capability Registry 是运行期契约：skill 只能作为 Planner 选择的 scenario playbook，不得把自身顺序提升为全局 fixed workflow。
- Decision-layer invariant：只有 Planner、Model Router、Prompt Registry、Document Worker、QA Gate 和 Policy Gate 可以做运行期决策。Capability Registry、adapter、handler、publisher、File Context、ASR、Observability、Hermes、`task_execution_runner` 和 `runtime_tool_cli` 只提供元数据、转换、执行、记录或复盘。
- Capability Registry 条目必须是 planner-selectable capability descriptions，并声明 `description`、`toolIntents`、`policy`、`observability`、`installState`、`securityReview`。
- 新 package 能力必须经过 package audit/install mechanism，安装动作通过 `install_dependency` Policy Gate，并把审计记录写入 `packageAudits`。
- 飞书动作通过官方 `lark-cli` 直通执行；可选确认只在用户要求时使用。
- Skill 输出必须便于复盘：保留 evidence id、决策理由、缺失信息和质量信号。

## 2. Skill 总览

| Skill | 职责 | Phase |
| --- | --- | --- |
| `source-intake` | 检查输入、建立 meeting_id、识别缺失信息 | 1 |
| `media-transcription` | 媒体导入、本地 ASR 服务转写、证据索引 | 1 |
| `meeting-minutes` | 生成结构化会议纪要 | 1 |
| `document-router` | 判断后续文档类型 | 1 |
| `prd-writer` | 生成 PRD | 1 |
| `technical-architecture-writer` | 生成架构文档 | 1 |
| `ops-writer` | 生成运营文档 | 1 |
| `requirement-checklist` | 生成客户需求确认表 | 1 |
| `feishu-workflow` | 官方 `lark-cli` 直通读写 | 2 |
| `feishu-bot-gateway` | 飞书机器人消息事件接收与回应网关配置 | 2 |
| `feishu-agent-bridge` | 飞书入站事件、附件、本地 PI task、QA/Policy 后发布/回复 | 2-5 |
| `rokid-file-import` | Rokid 导出目录导入 | 3 |
| `qa-safety-review` | 质量、安全、证据、权限检查 | 1-4 |
| `planner-runtime` | 生成和记录 Planner Envelope | 1-5 |
| `policy-gate` | 检查越界 action intent，不规定业务流程 | 1-5 |
| `model-provider` | DeepSeek/Xiaomi/mock provider readiness 与 `model_generate_text` | 2-5 |
| `document-worker-runtime` | `document_workers_run` 并行执行渲染后的文档 prompt | 3-5 |
| `runtime-observability` | 记录 run metrics、模型路由、工具调用、artifact、QA gate | 1-5 |
| `capability-registry` | Lazy capability 选择和 readiness 检查 | 1-5 |
| `context-offload` | 长 transcript/evidence 本地 offload 与 bounded readback | 1-5 |
| `agent-team-runtime` | 动态 worker 组件并行执行 topic/evidence/entity/doc/risk 子任务 | 1-5 |
| `retrospective-self-optimization` | 输出脱敏轨迹和 proposal 流程 | 4 |

## 3. `source-intake`

输入：

- 用户任务描述。
- 本地文件路径。
- 可选飞书链接。
- 可选 Rokid 导出目录。
- 会议目标、参会人、客户/项目名。

输出：

- `meeting_id`。
- `artifact_candidates`。
- `missing_inputs`。
- `privacy_level`。
- `continue_or_block`。

Phase：

- Phase 1 必须实现本地文件和手工上下文检查。
- Phase 2 增加飞书链接解析。
- Phase 3 增加 Rokid 导出目录。

验收：

- 不存在的文件必须报错。
- 隐私等级未知时默认按 `confidential` 处理。

## 4. `media-transcription`

输入：

- artifact candidates。
- 会议语言。
- 本地 ASR 服务地址；默认 `LOCAL_ASR_SERVICE_URL=http://127.0.0.1:8765`。

输出：

- artifact metadata。
- transcript segments。
- evidence chunks。
- low confidence segments。

工具：

- 本地媒体探测。
- 音频提取。
- `meeting_transcribe_local_asr`。
- 本地 Qwen3-ASR HTTP 服务。
- hash 计算。

默认实现：

- 使用 `mlx-community/Qwen3-ASR-1.7B-4bit` 本地模型。
- 模型目录：`models/Qwen3-ASR-1.7B-MLX-4bit`。
- 服务入口：`meeting-agent-pi-package/tools/local_asr_http_service.py`。
- 运行时：`mlx-qwen3-asr` / MLX Metal，常驻加载模型。
- 默认 30 秒固定非重叠 chunk，保证断点续跑和 evidence 引用稳定。
- 不启用 forced aligner、diarization、外部 ASR 或脚本兜底，除非未来任务明确变更架构。
- ASR 是 local-only 路径：PI 只调用本地 HTTP 服务，不直接运行批处理脚本，也不把原始音频交给 hosted LLM/ASR。

Phase：

- Phase 1：本地文件 metadata + 转写 + evidence index。
- Phase 3：Rokid 导出文件进入同一 media intake path。
- Phase 5：可选抽帧、多模态证据。

禁止：

- 未经用户确认上传原始音频或视频。
- 本地 ASR 服务不可用时自动改走 DeepSeek、小米或批处理脚本。
- 把原始转写全文写入长期记忆。

## 5. `meeting-minutes`

输入：

- transcript segments。
- evidence chunks。
- 用户目标。

输出：

- 会议主题。
- 核心结论。
- 内部 `topicMap`：主议题、时间范围、证据密度、核心判断、决策、行动项、风险、开放问题。
- 动态结构的关键讨论：简单执行型会议用七段式；多议题/战略型会议按主议题展开章节。
- 决策/分歧。
- 行动项：简单会议可用表格，复杂会议优先按主议题分组 checklist。
- 风险与开放问题。
- 最终判断。

Phase：

- Phase 1：生成内部 `topicMap`、标题 metadata 和纪要草稿。
- Phase 2：生成飞书格式纪要；根据 `topicMap` 选择简单执行型结构或多议题/战略型结构。
- Phase 4：根据反馈优化模板。

验收：

- 行动项必须尽量包含 owner、动作、时间、证据；缺失时列为待确认。
- 纪要必须生成 `meetingTitle`、`titleBasis`、`feishuFileName` 流水线 metadata，且最终用户可见 Markdown H1 等于 `meetingTitle`。
- `meetingTitle` 必须基于与会人员/角色、会议内容、会议安排和会议结论生成；缺证据时使用 `待确认`，不得编造。
- 参考 PDF 或历史纪要只作为议题级总结逻辑、层级密度和表达风格参考，不得继承其中事实、owner、日期或决策。
- 多议题/战略型会议不得把产品需求、商业模式、收费结构、超级个体、渠道合作、组织模式等连续证据压缩成一个 bullet；此类遗漏记录为 `omittedMacroTopics`，必须修订后发布。
- 产品类主议题应覆盖 MVP 边界、数据安全、部署环境、功能范围和待确认条件；业务类主议题应覆盖公司定位、收费方式、交付模式、合作结构和近期策略；组织类主议题应覆盖角色分工、知识库/复用资产和前后台协作。
- 最终飞书会议纪要不得显示 raw evidence id、chunk id、源音频文件名、QA 结论、Evidence Notes 或测试注释；这些只保留在本地 QA artifact。

## 6. `document-router`

输入：

- 会议纪要。
- evidence chunks。
- 项目上下文。

输出：

- 需要生成的文档列表。
- 选择原因。
- 信息缺口。
- 优先级和是否阻塞主交付。

规则：

- 产品范围、用户需求、MVP、验收标准明显时生成 PRD。
- 系统设计、接口、部署、安全、数据流明显时生成架构文档。
- 运营目标、SOP、指标、节奏明显时生成运营文档。
- 客户需求模糊、关键边界未确认时生成需求确认表。
- 任务结束、质量问题、流程改进明显时生成复盘。
- `meeting-minutes` 是默认 `primary` artifact；PRD、架构、运营、客户需求确认表和复盘默认是 `follow_up` artifact。
- follow-up 文档只在会议证据支持且用户目标需要时生成；其失败不阻塞会议纪要交付，除非用户明确要求“完整文档包一起交付”。

## 7. Writer Skills

### `prd-writer`

输出 PRD，必须保护 MVP 边界，不把二期能力写成承诺。关键范围、验收标准、权限和安全判断必须引用 evidence id。

### `technical-architecture-writer`

输出架构文档，必须包含模块、接口、数据流、权限、测试和 Phase。关键架构判断必须引用 evidence id，缺证据时标 `待确认`。

### `ops-writer`

输出运营文档，必须包含 SOP、指标、节奏、资源和复盘机制。不得编造 owner、deadline、预算或外部数据。

### `requirement-checklist`

输出客户需求确认表，重点覆盖：

- 数据安全。
- 部署环境。
- 功能边界。
- 标签/术语体系。
- 输出格式。
- 验收口径。
- 后续合作方式。

## 8. `feishu-workflow`

输入：

- 文档草稿。
- 发布目标。
- 用户授权上下文。

输出：

- `feishu_cli` 参数。
- official `lark-cli` stdout/stderr/exitCode。
- execution result。
- failure report。

Phase：

- Phase 2：接入 `feishu_cli(args, stdin?, timeoutMs?, parseJson?, redactionPolicy?)`。
- Phase 2：通过官方 CLI 支持 Docs、Drive、Wiki、IM、Calendar、Tasks、Meetings、Sheets、Base 等能力。
- Phase 2：不维护自定义 Feishu action enum、approval-store 或默认 dry-run。
- Phase 2：会议纪要上传飞书时，文件名使用纪要 metadata 中的 `feishuFileName`，与 H1/`meetingTitle` 同步。
- Phase 2：auth status 必须使用 `auth-status-summary`；其他可能进入模型上下文的 CLI 输出默认使用 `secret-scan`。
- Phase 5：支持发布状态同步。

验收：

- `lark-cli` 未安装时返回清晰错误。
- 安装 CLI 后全量飞书能力由官方子命令提供。
- 不泄漏 token、cookie、CLI session 或 app secret。

## 8.5 `feishu-bot-gateway`

输入：

- 飞书自建应用的 bot 配置状态。
- 事件订阅模式：长连接或 HTTP 回调。
- 本地环境变量就绪状态。
- 可选 PI/agent HTTP handler 地址。

输出：

- `feishu_bot_gateway_plan`：控制台权限、事件、运行方式和 MCP 边界说明。
- `feishu_bot_gateway_check`：脱敏环境变量就绪检查。
- 长连接服务启动命令。
- failure report。

Phase：

- Phase 2：新增独立 bot event gateway 模块，不替代 `feishu_cli`。
- Phase 2：推荐使用飞书 SDK 长连接接收 `im.message.receive_v1`。
- Phase 2：提供 `tools/feishu_bot_event_gateway.mjs` 作为本地长连接进程入口。
- Phase 5：可选接入 PI/agent HTTP handler，将飞书消息转成 agent 任务。

验收：

- 明确 MCP 不是机器人收消息/回复的必需项；MCP 只用于 AI 工具调用飞书 API。
- App Secret 只从环境变量读取，不写入仓库、wiki、trajectory 或 QA artifact。
- 机器人无法回应时能区分：事件订阅缺失、长连接未运行、权限未发布、机器人不在群里或用户不可用。
- `im.message.receive_v1`、`im:message:send_as_bot`、单聊/群聊消息权限被列为配置检查项。

## 8.6 `feishu-agent-bridge`

输入：

- `lark-cli event consume` 或 SDK gateway 转发的 normalized Feishu event。
- 用户文本、消息附件、飞书文件资源 key 或本地 fixture。
- 可选 `FEISHU_AGENT_FOLDER_TOKEN`、publish/reply mode、execute/mock mode。

输出：

- `feishu_event_runner.mjs`：事件消费、标准化、去重、脱敏日志、handler 转发。
- `feishu_agent_task_handler.mjs`：`event.json`、`task.json`、`state.json`、`agent-task.md`、`agent-output.json`、`publish.json`、`reply.json`、`run.metrics.json`、`run-manifest.json`、`sanitized-trajectory.json`。
- `im_file_context_helpers.mjs`：Feishu/WeChat 共享 file-context helper，负责附件类型识别、文本抽取、渐进披露计划、音频 local ASR only 和图片/视频 unsupported 边界。
- `wechat_event_adapter.mjs`：WeChat fixture adapter skeleton，只负责映射 `im-event-v1` / `im-attachment-v1` / `office-task-state-v1` 并调用同一个 handler/runner，不做 live wechatcli。
- `task_router.mjs`：共享 task intent router，输出 `executionProfile/reasoningDepth/requiredStages/skipStages`，兼容既有 `taskType/responseMode/requestedDocuments/requiresLocalAsr/sourcePreparation`；不选择模型、prompt、文档结构、QA、Policy 或发布策略。
- `execution-profiles.json`：profile contract；`fast_answer/file_summary` 明确跳过 document worker、QA Gate、Policy Gate、publish 和 local ASR，`audio_minutes/document_generation/document_revision` 声明长链路 required stages。
- `task_execution_runner.mjs`：profile-driven 薄执行器，只执行阶段和观测；`fast_answer/file_summary` 走轻路径，长文档 profile 通过 `runtime_tool_cli.mjs` 调 Planner、Model Router、Prompt Registry、Document Worker、QA Gate 和 Policy Gate，不作为新编排层，也不决定任务拆分、模型、prompt、文档结构、QA、Policy 或发布策略。
- `document_revision`：文档生命周期中的修订操作。它只增加 `review-context.json` 和 `document-revision-overlay.md`，base docType 仍由 `document-prompt-registry.json` 选择；Feishu adapter 不拥有批注解释或章节改写决策。`review-context.json` 优先来自 `lark-cli drive file.comments list` / `file.comments batch_query` / `file.comment.replys list`，SDK 只作为同 OpenAPI fallback；权限不足必须记录 `comment_api_permission_blocked`，不能把导出正文里的可见批注痕迹伪装成独立评论线程。
- `file-context`：把 PDF/Word/Excel/Markdown/TXT/CSV 等文本型附件转为统一上下文对象，记录 `disclosurePlan`、`contextPreview`、`extractedTextPath` 和是否允许外发给 LLM。
- 音频附件：`.wav/.mp3/.m4a/.aac/.flac/.ogg` 按扩展名优先识别为 `audio`，只进入 local ASR + meeting-minutes；回复音频父消息说“形成会议纪要/录音/音频/转写/minutes”时必须回溯父消息/root 消息或最近附件缓存。
- 不支持素材：图片和视频素材直接回复 `目前暂不支持该功能`，不进入 hosted LLM、视频理解或 local ASR。
- 文件引用解析顺序：当前消息附件 -> 父消息/root 消息资源 -> 最近 30 分钟附件缓存。解析失败时直接回复缺音频或文件提示，不启动长链路。
- 用户可见回复不得包含本地 `runId`、QA/Policy 内部术语或 handler 诊断。
- live publish 时通过 `lark-cli drive +create-folder`、`markdown +create`、`markdown +overwrite`、`drive +upload`、`im +messages-reply` 返回飞书结果。默认发布目标是当前 chat/thread 会话目录；`FEISHU_AGENT_FOLDER_TOKEN` 作为父目录。

Phase：

- Phase 2：文本事件进入本地 handler，fixture/mock QA 可跑通。
- Phase 3：消息附件下载到本地 artifact，音频只进入 local ASR；图片和视频当前不支持。
- Phase 3：文本文件进入 file-context；大文件按任务渐进披露，不把完整内容塞进每个 prompt。
- Phase 4：调用 shared `task_router` 和 profile-driven `task_execution_runner`；短问答/文件摘要走轻路径，音频会议纪要和文档生成/修订走 Planner/Model Router/Prompt Registry/Document Worker/QA Gate/Policy Gate，不硬编码文档结构。
- Phase 5：QA Gate 与 Policy Gate 通过后执行 live publish/reply。

验收：

- Runner 不生成文档、不发布飞书；handler 不硬编码 PRD/Ops/Architecture/Checklist 章节。
- Handler 必须调用 `task_router.mjs`，不得内置完整 classifier；task、metrics 和 manifest 必须记录 `executionProfile`、`reasoningDepth`、`requiredStages`、`skipStages`。
- `fast_answer/file_summary` 不得进入 document worker、QA Gate、Policy Gate、Wiki publish 或 local ASR；长文档 profile 必须走 Planner Envelope、Model Router、document-prompt-registry、section-batched document workers、QA Gate、Policy Gate。
- Model Router 是唯一模型入口：普通短任务默认 `deepseek-v4-flash`，会议纪要和深度文档默认 `deepseek-v4-pro`。
- Feishu audio minutes regression 必须显式保留 `task_execution_runner_started`、`local_asr_completed`、`model_route_planned`、`meeting_minutes_generated`、`qa_gate_completed`、`policy_gate_completed` 和最终 publish/reply 状态。
- WeChat 本轮只作为 adapter skeleton 描述统一 schema 映射和 capability matrix，不承诺 live 收消息、下载附件、发文件或云文档发布。
- 不支持的文件类型或用户要求当前未接入的能力时，直接回复 `目前暂不支持该功能`，不启动长链路。
- QA blocking/needs_fix 或 Policy blocked 时不执行 live publish；Feishu inbound 中用户明确要求创建、撰写、保存、发布、放到云端或覆盖修改时，非删除类 `write_private`/`publish_customer_visible` 默认放行。
- 删除、清空、移除、销毁类动作始终不支持，不调用任何删除/回收站/清理命令。
- 原始音视频、CLI session、App Secret、token、Authorization header 不进入 model context、metrics、wiki 或测试 fixture。
- Live smoke 依赖 `lark-cli auth status --verify`、`FEISHU_EVENT_KEY` 和飞书开放平台权限；auth/keychain 不可用时记录 `wiki/issues/`。

## 8.7 `office-runtime`

输入：

- document lifecycle action、明确 file token/link 或本会话生成文档 artifact。
- document revision action、`review-context.json`、明确 file token/link 或本会话生成文档 artifact。
- retrieval index entry 的 summary、bounded preview、sourceRun 和 artifact pointer。
- memory proposal 的偏好/组织档案候选内容和 rationale。

输出：

- `document_lifecycle_plan/write`：创建、覆盖修改、章节重写、diff、sourceRun、version 和生命周期事件 metadata。
- `office_object_write`：文档、文件、会议、任务、日历、联系人、项目、客户、偏好或 run 的 pointer-only object reference。
- `retrieval_index_write/search`：pointer-only index 和 bounded search results。
- `memory_proposal_write`：`pending_review` proposal，`autoPersisted=false`。

验收：

- 删除、清空、移除、销毁类动作 blocked。
- 覆盖修改/章节重写已有文档必须有明确 token/link 或当前会话生成文档。
- retrieval/memory 不保存 raw transcript、full file text、request body、secret、token、cookie 或 CLI session。

## 9. `rokid-file-import`

输入：

- Rokid 导出目录。
- 可选 meeting_id。

输出：

- 导出文件列表。
- artifact metadata。
- 导入状态。
- 不支持文件列表。

Phase：

- Phase 3：本地目录扫描。
- Phase 3：MCP Bridge 工具。
- Phase 5：可选手机端/眼镜端实时链路。

禁止：

- 未经用户确认上传原始音视频。
- 绕过官方或用户授权。
- 长期保存原始会议隐私。

## 9.5 `runtime-observability` 与 `capability-registry`

`runtime-observability` 输入：

- task type。
- Planner Envelope 和 planner decisions。
- capability selection reasons。
- Policy Gate decisions。
- worker decisions。
- package audit/install results。
- document-prompt-registry.json 的 docType -> promptFile 映射。
- document_workers_run 的 taskIndex、executionWaves、upstreamDocumentsUsed、provider route、docType、sectionBatches、sectionAttempts、repairAttempts、missingSections、QA input。
- 启用 capability。
- 模型调用和 fallback 结果。
- 工具调用、外部调用、生成 artifact。
- QA gate 结果和 context budget。

输出：

- `runtime-runs/{run_id}/run.metrics.json`。
- 可选 `model-route.json`、`qa-gate.json`、`artifacts.json` 指针。

验收：

- 不记录 App Secret、API key、cookie、token、CLI session。
- 不记录 raw transcript 全文。
- 能回答本次 run 用了哪些 capability、哪些模型、哪些工具、哪些 worker、哪些 artifact，哪些 Policy Gate/package audit 发生过，以及是否可发布。
- `run.metrics.json` 包含 `plannerDecisions`、`policyDecisions`、`workerDecisions`、`capabilitySelections` 和 `packageAudits`。
- `document_workers_run` 只接收 `document_prompt_render_batch` 产出的 `renderedPrompt`，不内置 PRD/运营/架构章节。
- `document_workers_run` 按 prompt registry `dependsOn` 生成 dependency waves；PRD -> 技术架构 -> FDE checklist 的依赖在 registry 中声明，不在 runner 或 handler 中硬编码。
- 每个 document worker 内部按 registry `requiredSections` 生成 section batches，合并后计算 `missingSections`，必要时只对缺失章节做 bounded repair。
- `model_provider_*` 不返回 API key、Authorization、raw request body 或 App Secret；Xiaomi 必须通过 `XIAOMI_BASE_URL` 配置。

`capability-registry` 输入：

- 用户任务描述。
- 可选 taskType。
- 可选 capability id。

输出：

- always-on 最小内核。
- 推荐启用的 lazy capability。
- planner-selectable capability descriptions。
- env/command/permission readiness。
- `description`、`toolIntents`、`policy`、`observability`、`installState`、`securityReview`。
- 不启用的 capability 和原因。

验收：

- 普通会议纪要不加载 Feishu bot、Rokid、WebAccess/MCP 或第三方 subagent 包。
- 机器人不回复时推荐 `feishu-bot-gateway`。
- 长会议或多文档任务推荐 `agent-team-runtime` 和 `context-offload`。
- 第三方包只输出 candidate/needs setup，不自动安装。
- 第三方包从 candidate 到 enabled 必须有 `securityReview` 和 `install_dependency` Policy Gate 记录。

## 9.6 `context-offload`

输入：

- runId。
- transcript/evidence/draft payload。
- artifact name。
- token/segment/byte 预算信号。

输出：

- `runtime-runs/{run_id}/offload/*`。
- `artifacts.json` pointer。
- hash、size、preview 和 bounded readback。

规则：

- raw transcript 和 full evidence index 默认写本地 artifact。
- 主上下文对 raw transcript/full evidence 保持 pointer-only：只保留
  `topicMap`、`internalEvidenceMap`、`qaGate`、`openQuestions`、artifact path、
  hash、size 和 bounded preview。
- 回读时必须 bounded，不把完整长 transcript 一次性塞回主上下文。

## 9.7 `agent-team-runtime`

输入：

- 任务描述。
- transcript/evidence/draft 片段。
- requested outputs。

输出：

- 动态组件计划。
- 并行 worker JSON 结果。
- topicMap、evidence coverage、entity hits、Feishu readiness、document shard、风险/开放项。

规则：

- Agent Team 是动态组件池，不是固定预设 role。
- `wiki/06-agent-team-index.md` 是动态组件索引，不是运行期常驻 role prompt。
- 本地实现使用 Node `worker_threads`，组件不写文件，主控负责整合。
- 可并行：topicMap、evidence coverage、entity gate、风险/开放项、document shard。
- 必须串行：最终 QA gate、飞书发布、客户可见发送。

验收：

- 长会议生成纪要 + PRD 时能并行跑多个 worker。
- 每个 worker 输出能回溯到 evidence 或 artifact。
- 不因为“采用 agent team”而默认加载大量 subagent 上下文。

## 10. `qa-safety-review`

输入：

- 所有草稿文档。
- evidence index。
- Feishu CLI result。
- optional confirmation result。
- dependency report。

输出：

- `status`: `pass|needs_fix|blocked`，只反映 primary artifact 是否可交付。
- `primaryDeliveryStatus`: `ready|needs_fix|blocked`。
- `overallStatus`: `ready|partial_ready|blocked`。
- `artifacts`: 每个 artifact 的 `priority`、`status`、`blocksDelivery` 和 issue codes。
- blocking issues。
- suggestions。
- required user confirmations。

必须阻断：

- 关键结论无证据且未标注推断。
- 客户可见发布未按用户要求确认。
- token 泄漏。
- 原始会议内容进入长期记忆。
- 发现 `mistralai==2.4.6`。

交付优先级：

- 只有 `priority=primary` 的 artifact 会阻塞主交付。
- follow-up artifact 的 `needs_fix` 或 `blocked` 进入 `overallStatus=partial_ready`，但不把会议纪要交付改成 blocked。
- 若会议纪要本身未通过，则 `primaryDeliveryStatus=needs_fix|blocked`，整体交付 blocked。

## 11. `retrospective-self-optimization`

输入：

- sanitized trajectory。Hermes 可通过 `--run-dir` 从 Feishu run artifact 读取或生成 `sanitized-trajectory.json`。
- QA 结果。
- 用户反馈。

输出：

- memory proposal。
- prompt patch proposal。
- skill patch proposal。
- eval proposal。

Phase：

- Phase 4：只输出 proposal。
- Phase 5：加入回归测试仪表盘。

## 12. Skill 目录建议

```text
meeting-agent-pi-package/
  skills/
    source-intake/
      SKILL.md
    media-transcription/
      SKILL.md
    meeting-minutes/
      SKILL.md
    document-router/
      SKILL.md
    prd-writer/
      SKILL.md
    technical-architecture-writer/
      SKILL.md
    ops-writer/
      SKILL.md
    requirement-checklist/
      SKILL.md
    feishu-workflow/
      SKILL.md
    feishu-bot-gateway/
      SKILL.md
    rokid-file-import/
      SKILL.md
    qa-safety-review/
      SKILL.md
    runtime-observability/
      SKILL.md
    capability-registry/
      SKILL.md
    context-offload/
      SKILL.md
    agent-team-runtime/
      SKILL.md
    retrospective-self-optimization/
      SKILL.md
```

## 13. Skill 变更流程

1. Hermes sidecar 提出 proposal。
2. Security QA 检查是否扩大权限或保存敏感内容。
3. 人工 review。
4. 小步修改对应 skill。
5. 跑产品会、技术会、运营会三类样本回归。
6. 记录变更原因。
