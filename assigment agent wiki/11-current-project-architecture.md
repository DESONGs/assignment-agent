# 当前项目架构与代码同步状态

更新时间：2026-05-24

本文是代码现状的总览快照，用于避免 wiki 落后于 `meeting-agent-pi-package/` 的真实实现。若代码中的 runtime、prompt、skill、工具或安全边界发生变化，应同步更新本文和对应专题 wiki。

## 1. 项目分层

```text
User / Local Files / Feishu / Rokid Export / future WeChat skeleton
  -> Channel/File adapters
  -> Shared Task Router
  -> Execution Profile
  -> Profile-driven Thin Runner
  -> PI Agentic Planner
  -> Capability Registry metadata/readiness
  -> Tool / Runtime Extensions
  -> Model Router
  -> Prompt Registry
  -> Document Worker
  -> QA Gate
  -> Policy Gate
  -> Document Output Contract
  -> Publish Taxonomy / Project Workspace
  -> Optional Feishu / Calendar / Task action
  -> Sanitized Trajectory
  -> Hermes Learning Sidecar proposal
```

当前实现不是固定会议 DAG，而是 profile-based agentic office runtime：Shared Task Router 只判断任务意图和 `executionProfile`，短任务可走 `fast_answer/file_summary` 轻路径；长文档、音频会议纪要和文档修订才进入 Planner、Prompt Registry、Document Worker、QA Gate、Policy Gate 和 publish。Planner 根据任务目标选择 capability，Policy Gate 判断动作边界，Runtime extensions 执行工具和记录证据，QA Gate 判断内容是否可发布。

Decision-layer invariant：当前只有 Planner、Model Router、Prompt Registry、Document Worker、QA Gate 和 Policy Gate 拥有运行期业务决策权。Task Router 只拥有 task intent/profile 选择权，不选择模型、prompt、文档结构、QA、Policy 或发布策略。Capability Registry 只提供 capability 描述、readiness、policy metadata 和启用状态；Publish Taxonomy 只拥有发布归档、项目树、可读文件名和历史重整权，不改变文档内容或 QA/Policy 结论；Feishu adapter、未来 WeChat skeleton、handler、publisher、File Context、ASR、Observability、Hermes、`task_execution_runner.mjs` 和 `runtime_tool_cli.mjs` 只负责转换、执行、记录或复盘。

本地 Docker 边界：本地 Docker 不能减少本机总计算消耗，因此当前不是“远端算力 server”，而是 **Host 原生控制面 + Local Docker 受限执行面**。Host 保留 Feishu live、`lark-cli`、macOS keychain、附件下载/发布/回复、本机 MLX ASR，以及 `document_revision` 的 Feishu comment/review-context 预取。Local Docker 常驻 `runtime-queue`、`pi-document-worker` 和 `hermes-worker`，用于隔离长文档生成、限制资源和控制并发；默认资源档位是 `4 CPU / 8GB / 长文档并发 2`。

Profile 到 Docker 的规则是保守的：`fast_answer/file_summary 不进 Docker`；`document_generation/multi_source_synthesis 默认进 Docker worker`，但只有 `FEISHU_AGENT_DOCUMENT_WORKER_MODE=docker|local-docker|queue` 开启时才入队，默认仍是 host runner；`audio_minutes` 的 audio normalize + local ASR 留在 Host，后续 transcript/evidence 可以作为 bounded artifact 进入文档阶段，`raw audio 不进容器`；`document_revision` v1 留在 Host。Docker worker 不调用 `lark-cli`，不 publish，不 reply，只写 `agent-output.json` 和 runtime artifacts，Host handler 拉回结果后继续执行 Feishu publish/reply。

常驻服务启动命令：

```bash
docker compose -f docker-compose.local-runtime.yml up -d runtime-queue pi-document-worker hermes-worker
```

## 2. 代码结构

`meeting-agent-pi-package/` 是当前执行平面：

- `extensions/`：PI runtime callable tools。
- `skills/`：工具使用规则、边界和操作流程。
- `prompts/`：正式文档 prompt，文档结构只在这里和 registry 维护。
- `runtime/`：schema、registry、model routing、provider 配置、QA/policy/planner contract。
- `tools/`：本地服务或外部集成脚本，例如本地 ASR HTTP 服务、飞书 event runner、飞书 Agent task handler 和飞书 bot gateway。

`wiki/` 是产品、架构、prompt、skill、权限、测试、当前实现快照和开发组织文档。已落地的一次性计划、handoff、历史 QA 报告和旧固定角色拆分不保留为 active wiki。`wiki/issues/` 用于记录开发过程中发现的问题和复盘。

`src/validate_workspace.py` 是静态一致性检查入口，负责校验关键文件、prompt placeholder、runtime schema、能力 registry、文档 marker 和安全约束。

## 3. Runtime Extensions 现状

当前 `extensions/` 中的主要模块：

| Extension | 当前职责 |
| --- | --- |
| `planner-runtime.ts` | 生成/写入 Planner Envelope，记录目标、能力、工具、worker、policy 风险、artifact 和停止条件。 |
| `policy-gate.ts` | 判断 `read/draft/write_private/publish/notify/calendar/task/external_web/install_dependency/persist_memory` 等动作边界。 |
| `capability-registry.ts` | 基于 `capability-registry.json` 做 lazy capability list/plan/check/enable。 |
| `runtime-observability.ts` | 记录 planner、policy、worker、capability、package、model、tool、artifact 和 QA 指标。 |
| `model-routing.ts` | 根据 `model-routing.json` 做 DeepSeek/Xiaomi/rules/mock 路由，fallback 可自动但必须写 `model-route.json`。 |
| `model-provider.ts` | DeepSeek/Xiaomi/mock provider adapter；DeepSeek 默认 `https://api.deepseek.com`，Xiaomi 必须由 `XIAOMI_BASE_URL` 配置。 |
| `document-generation.ts` | 读取 `document-prompt-registry.json`，执行 prompt select/render/render_batch，不再维护硬编码文档 scaffold。 |
| `document-worker-runtime.ts` | 文档级 worker；先按 registry `dependsOn` 生成 execution waves，wave 内并行，每份文档内部按 `requiredSections` 做 section batches、merge、repair，再输出 QA input。 |
| `qa-gate.ts` | 内容级发布 gate，检查 missingSections、missingUpstreamDocuments、FDE checklist 定位、unsupportedClaims、crossDocumentContamination、openQuestions、router reason 等。 |
| `context-offload.ts` | 长 transcript/full evidence 本地 offload，主上下文只保留 pointer-only 摘要。 |
| `media-tools.ts` | 本地媒体 metadata 和 `meeting_transcribe_local_asr`。ASR 只走本地 HTTP 服务，不走外部兜底；服务输入是 runtime 归一化后的 WAV。 |
| `feishu-tools.ts` | 官方 `lark-cli` 直通；输出进模型前按策略脱敏。 |
| `feishu-bot-gateway.ts` | 飞书机器人事件网关配置/就绪检查；消息接收由长连接服务处理。 |
| `rokid-tools.ts` | Rokid 导出文件扫描/导入的第一阶段工具。 |
| `agent-team-runtime.ts` | 动态 worker component pool；不是固定 subagent role 预设。 |

当前 `tools/` 中与 Feishu 双向 Agent 相关的可执行入口：

| Tool | 当前职责 |
| --- | --- |
| `feishu_event_runner.mjs` | 通过 `lark-cli event consume` 消费 NDJSON 事件，标准化、去重、写入脱敏事件日志并转发到本地 handler。 |
| `feishu_agent_task_handler.mjs` | 接收 normalized event，解析文本/附件，维护最近附件缓存，生成 `file-context`，写入 run artifact，生成 PI task，执行 mock/execute 模式，读取 QA/Policy 后生成发布和回复结果。 |
| `feishu_bot_event_gateway.mjs` | 可选 SDK 长连接入口；`http` 模式转发到同一个本地 handler。 |
| `im_file_context_helpers.mjs` | 共享 file-context helper：按扩展名/MIME 识别音频、文本文件、图片和视频，执行文本抽取与渐进披露计划。 |
| `asr_media_formats.mjs` / `asr_diarization_helpers.mjs` | 云端文件/实时格式边界，以及文件端 diarization 所需的派生单声道准备。 |
| `audio_normalize_helpers.mjs` | 本地 ASR 或云端降级重试的音频归一化：provider 支持的音视频容器 -> `16k mono s16 WAV`，优先 `ffmpeg`，否则 macOS `afconvert`。 |
| `wechat_event_adapter.mjs` | WeChat fixture adapter skeleton：把本地 WeChat-shaped input 映射为 `im-event-v1`，并在 mock/dry-run 中调用同一个 handler/runner。 |
| `task_router.mjs` | Shared Task Router：从用户文本、附件、file context 和 source metadata 输出 `taskIntent.executionProfile`、`reasoningDepth`、`requiredStages`、`skipStages`，不选择模型、prompt 或文档结构。 |
| `task_execution_runner.mjs` | Profile-driven 薄执行器：按 `executionProfile` 分派；`fast_answer/file_summary` 走轻路径，长文档 profile 才调用 Planner/Model Router/Prompt Registry/Document Worker/QA/Policy。 |
| `runtime_tool_cli.mjs` | 本地调用 PI extension tools 的桥，读取 `runtime/tool-load-manifest.json` 并按 `--profile` 加载 extension，避免 adapter 重新实现 Planner/Router/Registry 决策逻辑。 |
| `local_docker_runtime_queue.mjs` | Host 侧 bounded queue bridge：只允许 `document_generation` 和 `multi_source_synthesis` 入队，剥离 Feishu token、raw media 和 channel/publish 字段。 |
| `local_docker_document_worker.mjs` | Local Docker 文档 worker：消费 bounded job，复用 `task_execution_runner` 生成 `agent-output.json`，不调用 Feishu CLI、不发布、不回复。 |
| `feishu_publish_taxonomy.mjs` | Publish Taxonomy owner：从 `documentIdentity`、title plan、source H1 和任务文本推断 `projectTitle/projectKey/sourceThreadKey`，过滤 Feishu token、runId、generic filename 等弱标题。 |
| `feishu_wiki_publish_helpers.mjs` | Wiki 发布执行 helper：接受 taxonomy plan，创建/复用真实 Feishu Wiki Space、项目节点和分类节点，再执行 `markdown +create` / `wiki +move`。 |
| `feishu_publish_organize_cli.mjs` | 历史发布重整 CLI：`inventory/plan/apply --live --no-delete`，将已发布会议纪要、PRD、技术架构和 Checklist 按项目树挂载到 Wiki，保留旧 token/url。 |

`task_execution_runner` 不是新的编排层或决策层。它以 `taskIntent.executionProfile` 为入口执行最小阶段：`fast_answer` 只做 model route + text generation + reply，`file_summary` 只读取 bounded file context 后直接回复；`audio_minutes`、`document_generation`、`document_revision` 和 `multi_source_synthesis` 才执行 evidence pack -> Planner Envelope -> Model Router -> Prompt Registry -> Document Worker section batches -> QA Gate -> Policy Gate -> publish/reply。决策权仍由 Planner、Model Router、Prompt Registry、Document Worker、QA Gate 和 Policy Gate 保持。

Feishu 文本型文件上下文：

- 支持 PDF、Word、Excel、Markdown、TXT、CSV 等文本型文件；图片理解、未接入写操作等不支持能力直接回复 `目前暂不支持该功能`。
- 用户上传文件后再说“该文件/附件”时，handler 只在同一 chat、同一 sender、优先同 thread/root 的 30 分钟缓存内关联。
- file-context 记录 `disclosurePlan`、`contextPreview`、`extractedTextPath` 和 provider file/text fallback 能力；短任务只返回 direct answer，长任务才进入 prompt registry 与 document workers。

Office runtime 补齐：

- `office-runtime.ts` 提供 `document_lifecycle_plan/write`、`office_object_write`、`retrieval_index_write/search` 和 `memory_proposal_write`。
- document lifecycle 只记录创建、发布、覆盖修改、章节重写、diff、sourceRun 和 version metadata；删除、清空、移除、销毁保持 blocked。
- retrieval index 是 pointer-only：只保存摘要、bounded preview、hash/sourceRun/artifact pointer，不保存完整文件正文或 raw transcript。
- memory 只写 `pending_review` proposal，`autoPersisted=false`，后续是否进入长期偏好由 Policy Gate 和人工确认决定。

## 4. 文档生成链路

当前文档生成的唯一正式路径：

```text
document-router
  -> document-prompt-registry.json
  -> document_prompt_select
  -> document_prompt_render_batch
  -> document_workers_plan
  -> document_workers_run
  -> dependencyWaves
  -> sectionBatches
  -> merge
  -> repair missingSections
  -> qa_gate_evaluate
```

关键约束：

- `document-generation.ts` 只读 prompt registry，不内置 PRD、运营、架构或 checklist 章节。
- `document-worker-runtime.ts` 只接收 `document_prompt_render_batch` 产出的 `renderedPrompt`。
- 第一层按 registry `dependsOn` 分 execution waves；同一 wave 内按文档并行；第二层在每个文档 worker 内部按 `requiredSections` 分批生成。
- 当前多文档依赖基线：`prd` 先基于会议/evidence 生成；`tech-architecture` 基于会议/evidence + PRD 生成；`customer-requirement-checklist` 定位为 FDE（前端部署工程师）沟通确认清单，基于会议/evidence + PRD + 技术架构提取待确认项。
- 每批 section prompt 要求用 exact section name 作为 Markdown 标题。
- 合并后 runtime 计算 `missingSections`；仍缺章节时最多做 bounded repair。
- runner 在 evidence pack 同步生成 `document-title-plan.json`，从用户 prompt 和 source map 推断项目/方向，并在最终 Markdown 写入/发布前统一同步 H1 与飞书 `.md` 文件名。PRD、技术架构、运营方案、客户需求确认表和会议纪要都不得回退到裸 `docType` 或“待确认模板”文件名。
- `model-route.json` 记录 `executionWaves`、`sectionBatches`、`sectionAttempts`、`repairAttempts`、`missingSections` 和上游文档使用情况，但不记录 renderedPrompt、secret、raw request body 或 raw media。

当前 registry 支持的文档：

- `meeting-minutes`
- `prd`
- `ops-plan`
- `tech-architecture`
- `customer-requirement-checklist`

## 5. 模型与 Provider

模型路由由 `runtime/model-routing.json` 决定，Model Router 是唯一模型入口：

- `fast_draft` / `main_draft`：默认 `deepseek/deepseek-v4-flash`，Xiaomi fallback，最后 manual blocked。
- `meeting_minutes`：默认 `deepseek/deepseek-v4-pro`，用于会议纪要质量优先链路。
- `document_shard_fast`：默认 `deepseek/deepseek-v4-flash`，用于普通文档章节、报告摘要和轻量方案。
- `document_shard_deep` / `deep_draft`：默认 `deepseek/deepseek-v4-pro`，用于 PRD、技术架构、复杂运营/客户需求清单和用户明确要求深度思考的任务。
- `qa_gate`：rules deterministic primary，Xiaomi review fallback。
- `feishu_readiness`：rules deterministic。

Provider 配置由 `runtime/model-providers.json` 决定：

- DeepSeek：`DEEPSEEK_API_KEY`，默认 base URL `https://api.deepseek.com`。
- Xiaomi：`XIAOMI_TOKEN_PLAN_SGP_API_KEY` + 必填 `XIAOMI_BASE_URL`，代码不硬编码 endpoint。
- Mock：用于本地 smoke，不需要外部网络。

外部模型安全边界：

- 原始录音、视频、base64 media 不发送给外部 provider。
- transcript/evidence 文本可按用户授权发送给 DeepSeek/Xiaomi。
- provider adapter 不返回 API key、Authorization header 或 raw request body。
- fallback 可以自动发生，但 `silentFallbackAllowed=false`，必须写 `model-route.json`。

## 6. 飞书、Rokid、本地 ASR

飞书：

- 正式飞书读写发布走官方 `lark-cli` 当前登录态。
- 双向入口优先使用 `lark-cli event consume <EventKey> --as bot` -> `feishu_event_runner.mjs` -> `feishu_agent_task_handler.mjs`。
- SDK 长连接 gateway 是可选入口，可把 `im.message.receive_v1` 转发到同一个 handler；稳态运行采用两阶段模式：gateway 只做用户层接收确认，后台 runner 完成后再用 `lark-cli im +messages-reply` 回复最终结果。MCP 对飞书仍是可选 AI tool access，不是收消息、回复或发布的必需服务。
- Handler 生成 `event.json`、`task.json`、`state.json`、`agent-task.md`、`agent-output.json`、`publish.json`、`reply.json`、`run.metrics.json`、`run-manifest.json` 和 `sanitized-trajectory.json`。
- Handler 调用 `task_router.mjs` 生成 `taskIntent`。`task.json`、metrics 和 `run-manifest.json` 必须记录 `executionProfile`、`reasoningDepth`、`requiredStages` 和 `skipStages`。
- `fast_answer` 和 `file_summary` execute path 不进入 document worker、QA Gate、Policy Gate、Wiki publish 或 local ASR；文件总结只使用 bounded preview/extracted slices。
- 音频会议纪要第一阶段接入 `task_execution_runner`，附件下载后先写 `audio_downloaded`，再用本地 `ffmpeg`/`afconvert` 写 `audio_normalized` 和 `audio-normalize.json`，然后调用 local ASR。Feishu audio minutes regression 必须能复查 `task_execution_runner_started`、`audio_downloaded`、`audio_normalized`、`local_asr_started`、`local_asr_completed`、`model_route_planned`、`meeting_minutes_generated`、`qa_gate_completed`、`policy_gate_completed` 以及最终 publish/reply 状态。
- `state.json` 是任务状态机；`run.metrics.json` 是运行观测数据；`run-manifest.json` 是 artifact 总索引；`sanitized-trajectory.json` 是 Hermes 只读学习输入。
- 用户交付物发布默认走 Feishu Wiki：`publish-taxonomy.json` / `wiki-publish-plan.json` 根据 `documentIdentity`、`document-title-plan.json`、docType、日期、用户意图和历史 override 生成动态 Project Workspace 树。当前用户交付物 canonical Wiki Space 是 `PI Agent 项目知识库`，项目节点形如 `项目｜{projectTitle}`，分类节点按 `会议纪要 / PRD / 技术架构 / 客户需求确认 / To-do` 动态创建或复用。同源会议纪要、PRD、技术架构和 Checklist 必须进入同一项目树，不再按 `runId` 或 `feishu-chat-*` 建顶层目录。
- Wiki 展示名由 `feishu_publish_organize_cli.mjs` / taxonomy 层从 `projectTitle + docType + purpose + run timestamp` 生成，例如 `PRD｜抖音私信 AI 客服方案｜产品化方案｜2026-05-22 070232.md`；不得使用 Feishu token、`feishu file 00 ...`、normalized audio 文件名、runId 或 generic upload filename 作为用户可见标题。`feishu_wiki_publish_helpers.mjs` 只执行 `markdown +create`、`wiki +node-create`、`wiki +move` 并写 `wiki-publish.json`，不决定目录语义。Wiki 不可用时才 fallback 到 Drive，并记录 `wiki_publish_blocked_drive_fallback`。
- 历史重整采用无删改迁移：`feishu_publish_organize_cli.mjs apply --live --no-delete` 只创建/复用 Wiki Space、项目节点、分类节点和文档挂载，或在 Drive 侧移动/重命名旧文件夹；不得删除旧文件或覆盖原 URL。2026-05-23 live 验证中，`项目｜抖音私信 AI 客服方案` 已有 `会议纪要(2) / PRD(2) / 技术架构(1) / 客户需求确认(2)` 共 7 份文档，Drive 侧部分旧文件夹因 Feishu `source parent no permission` 保留原位。
- Hermes 思考库与用户交付物 Wiki 分离：`sidecar.py --run-dir` 生成 `hermes-wiki-candidate.json`、`hermes-wiki-reflection-gate.json` 和 `hermes-wiki-publish.json`。Local Docker `hermes-worker` 固定 `HERMES_WIKI_AUTO_PUBLISH=0`，只生成 learning proposal；standalone sidecar 若显式配置 Wiki target 和 auto publish，仍不得写入用户交付 Wiki。
- 既有飞书文档修改是 `document_revision`，不是新的 workflow。Handler 只识别“批注/评论/修改内容/重新优化”等意图；`task_execution_runner` 调用 `feishu_document_review_context_helpers.mjs`，优先通过 `lark-cli drive file.comments list`、`file.comments batch_query`、`file.comment.replys list` 读取独立评论线程，SDK 只作同 API fallback。Prompt Registry 在原 docType prompt 上追加 `document-revision-overlay.md`，Document Worker 仍负责章节批次和合并。缺少 `docs:document.comment:read` 或等价 Drive/Docs scope 时，`review-context.json` 必须显式记录 `comment_api_permission_blocked` 或 `body_ready_comments_not_available`，不得假装已读取批注。
- 评论上下文必须按 source 分组：`sourceDocuments[].comments[]` 是主结构，顶层 `comments` 仅保留兼容。Runner 只在同一 source 的正文中匹配 comment `quote`，并写入 `matchStatus=exact_unique|exact_multiple|fuzzy|unmatched|exported_body_detected`。多文档任务中不得把一个 source 的评论应用到另一个 source；部分 source 评论 API 失败时顶层状态为 `partial_ready`。
- 飞书用户侧回复不暴露本地 `runId`、QA/Policy 内部术语或 handler 诊断。`runId` 只保留在本地 artifact。
- 文件引用解析顺序是当前消息附件 -> `rootId/parentId` 父消息资源 -> 同 chat/sender/thread 最近 30 分钟附件缓存。三路都失败时，直接回复缺文件提示，不启动长链路。
- Runner 不生成文档，handler 不硬编码文档结构，PI runtime 必须使用 prompt registry、document workers、QA Gate 和 Policy Gate。
- Feishu App Secret、token、CLI session 不进入仓库、wiki、metrics 或模型上下文。

统一 IM schema 已落地为 `im-event-v1`、`im-attachment-v1`、`im-reply-v1`、`publish-target-v1` 和 `office-task-state-v1`。Feishu 是第一个 adapter；本轮 WeChat 只做 adapter skeleton 和 capability matrix，不承诺 live 收消息、下载附件、发文件或云文档发布。后续 WeChat 实现只能映射事件、附件、回复和发布能力到这些 contract，然后复用同一个 `task_execution_runner` 与 PI runtime，而不是复制 Feishu 主流程。

Rokid：

- 当前第一阶段按导出文件处理。
- 不假设稳定官方 Rokid MCP。
- 工具负责扫描、导入、metadata、hash 和处理状态。

本地 ASR：

- 服务入口：`meeting-agent-pi-package/tools/local_asr_http_service.py`。
- PI 工具：`meeting_transcribe_local_asr`。
- 默认服务：`http://127.0.0.1:8765`。
- 产品入口采用云端 provider 的完整文件格式矩阵；文件录音走 `paraformer-v2` HTTP + OSS，实时编码走独立 WebSocket。只有本地 ASR/fallback 或文件端 diarization 媒体条件需要时才派生单声道输入，原文件保持不变。
- 服务不可用时返回 `local_asr_service_unavailable`，不自动改走 DeepSeek、小米、脚本或 hosted ASR。

## 7. QA 与最新回归状态

当前关键回归：

- `python3 src/validate_workspace.py` 作为基础静态一致性检查。
- document worker mock section-batch 回归：四份文档按 requiredSections 分批，`missingSections=[]`，QA gate pass。
- real provider section-batch 回归：四份文档 completed，QA gate pass。
- 最近真实回归中 Ops Plan 的某个 DeepSeek batch 返回 empty response，已自动 fallback 到 Xiaomi，并记录在 `model-route.json`。

QA Gate 当前覆盖：

- 隐私和 raw media 外发。
- evidence 和 unsupported claims。
- topic/entity/title sync。
- documentOutputs：`requiredSections`、`missingSections`、`unsupportedClaims`、`crossDocumentContamination`、`openQuestions`、router reason coverage。
- Feishu readiness、web access sources、context budget。

## 8. 文档同步规则

后续代码改动必须同步检查：

- 新增或修改 extension：同步 `wiki/02-agent-architecture.md`、`wiki/04-skill-design.md`，必要时更新本文。
- 修改 prompt 或 prompt registry：同步 `wiki/03-system-prompts.md`、`wiki/07-test-plan.md` 和本文的文档链路。
- 修改模型/provider/fallback：同步 `wiki/02-agent-architecture.md`、`wiki/05-feishu-rokid-permissions.md`、`wiki/07-test-plan.md`。
- 修改飞书/Rokid/ASR 安全边界：同步 `wiki/05-feishu-rokid-permissions.md`。
- 新增开发问题或回归缺陷：在 `wiki/issues/` 下新增 issue markdown，而不是只写在聊天记录中。

## 9. 开发问题记录入口

所有后续开发中发现的问题，凡是影响架构、运行时、数据安全、QA、模型行为、飞书/Rokid/ASR 集成、文档质量或测试稳定性，都要沉淀到 `wiki/issues/`。

issue 文档应包含：问题摘要、触发场景、影响范围、当前证据、根因判断、修复方案、验证计划、当前状态和后续 owner。详细规范见 `wiki/issues/README.md`。
