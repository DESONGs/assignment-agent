# 测试计划

## 1. 文档完整性测试

- `wiki/00-plan.md` 存在，并包含 Phase 0-5。
- PRD、架构、system prompt、skill、权限、测试和当前架构同步文档存在。
- `wiki/06-agent-team-index.md` 存在。
- `wiki/06-agent-team-index.md` 描述动态 worker 组件、启用条件和禁止固定角色化，不再要求旧固定角色文档存在。
- 根目录 `agent.md` 存在。

## 1.2 Agentic Planner / Policy Gate 回归

目标：

- PI 运行时必须保持 Agentic Planner + Capability Registry + Policy Gate + Tool Execution 的组合，不退化成固定 workflow、固定 DAG 或固定状态机。
- Planner 可以根据不同办公目标选择不同能力组合：会议纪要、文档撰写、飞书读写、日历/任务、搜索、QA、Rokid 导入等不应被强制塞进同一条会议链路。
- Policy Gate 只拦截越界动作，不规定业务流程。

断言：

- 非平凡任务生成 planner envelope，至少包含 `goal`、`taskType`、`successCriteria`、`capabilitiesNeeded`、`toolPlan`、`policyRisks` 和 `stopConditions`。
- Planner Envelope 还必须包含 `parallelizableWorkers` 和 `requiredArtifacts`；它只能描述当前任务 scenario playbook，不得被解释成 fixed workflow。
- Capability Registry 返回 planner-selectable capability descriptions 和 capability selection reason，普通短任务不推荐无关 Feishu bot、Rokid、WebAccess/MCP 或 dynamic worker pool。
- 每个 registry capability 包含 `description`、`toolIntents`、`policy`、`observability`、`installState` 和 `securityReview`。
- 客户可见发布、IM/日历/任务变更、外部联网、安装依赖、长期记忆写入和原始媒体外发必须有 Policy Gate 结果。
- Gate 输出只允许 `pass|needs_confirmation|blocked`，并说明原因；不得把 gate 输出写成业务执行步骤表。
- Decision-layer invariant：只有 Planner、Model Router、Prompt Registry、Document Worker、QA Gate 和 Policy Gate 可以做运行期决策；Capability Registry、adapter、handler、publisher、File Context、ASR、Observability、Hermes、`task_execution_runner` 和 `runtime_tool_cli` 只能提供元数据、转换、执行、记录或复盘。
- Profile-based runtime invariant：`task_router.mjs` 只输出 task intent 和 `executionProfile`，不选择模型、prompt、文档结构、QA、Policy 或发布策略；`task_execution_runner` 必须以 `taskIntent.executionProfile` 为入口执行最小阶段。
- Document revision invariant：显式 doc/docx/wiki URL + “批注/评论/修改内容/重新优化”必须进入 `document_revision`，生成 `review-context.json`，先用 `lark-cli drive file.comments list` / `batch_query` / `file.comment.replys list` 读取独立评论线程，再通过 base docType prompt + `document-revision-overlay.md` 渲染；不得落回 `direct_answer`、ASR、会议纪要固定路径或 handler 硬编码章节。
- `task_execution_runner` 只能作为薄的可观测执行器；测试不得把它当成新编排层、模型选择层、prompt 选择层、文档结构层、QA 判定层、Policy 判定层或发布策略层。
- Runtime Metrics 记录 `plannerDecisions`、`capabilitySelections`、`policyDecisions`、tool intent、`workerDecisions`、model fallback 和 `packageAudits`。
- package audit/install mechanism 必须阻止未审计第三方包自动安装；安装动作必须有 `install_dependency` Policy Gate 记录。

## 1.5 路径 / 上下文 / 飞书 / ASR / 模型路由 / Agent Team 排序回归

路径与 ignore：

- `.gitignore` 忽略 `.env.local`、本地 cache、`models/`、`runtime-runs/` 和 `qa-runs/**/*.json|jsonl|txt|wav` 等生成 artifact。
- `.gitignore` 允许 `qa-runs/**/README.md`、`qa-runs/**/*.marker` 和 `qa-runs/**/.non-production` 这类非生产警告文件。
- `qa-runs/README.md` 和每个 legacy run 目录都有 non-production warning。

上下文：

- raw transcript/full evidence 必须先写入 `runtime-runs/{run_id}/offload/*`。
- 主上下文保持 pointer-only：artifact path、hash、size、bounded preview、topicMap、evidence map、QA gate、open questions。
- `context_offload_read` 只能 bounded readback；不得把 legacy `qa-runs/` raw transcript 或 response JSON 回灌为生产上下文。

飞书：

- `lark-cli auth status` 必须被 `auth-status-summary` 脱敏。
- 其他会进入模型上下文的 CLI stdout/stderr 默认使用 `secret-scan`。
- 未脱敏 identity、tenant/app/user id、token、cookie、session、App Secret 不得进入模型上下文或 run summary。

ASR：

- `meeting_transcribe_local_asr` 是唯一默认 ASR 路径，调用本地 Qwen3-ASR HTTP 服务。
- 本地服务不可用时 preflight 阻塞 `local_asr_service_not_running`；旧 run 中的 `local_asr_service_unavailable` 仍可作为历史问题状态识别。
- ASR cache hit 不访问 `/health`，只复用 transcript/evidence。
- 本机 lifecycle 入口为 `python3 meeting-agent-pi-package/tools/local_asr_service_ctl.py status|start|stop`，handler 不自动启动 ASR。
- 不得自动改走脚本、DeepSeek、小米或 hosted ASR。

模型路由：

- 任何 fallback 都必须写 `model-route.json`。
- `model_route_record` 发生在主稿/复核输出进入 QA gate 之前，不能事后补记静默切换。

Agent Team 排序：

- Agent Team 运行层使用 dynamic worker pool，不预加载 fixed roles。
- 会议纪要长会议参考链路为：本地 ASR -> evidence index -> context offload pointer-only -> dynamic worker pool -> model route record -> draft/review -> QA gate -> Feishu action。该链路不是全局固定 workflow。
- `agent_team_run` 只返回 JSON；最终整合、artifact 写入、QA gate 和 Feishu 发布由主控串行执行。

## 2. 本地 MVP 测试

场景：

- 输入一段本地音频。
- 输入一段本地视频。
- 输入一组截图和手工背景。

断言：

- 生成 artifact metadata。
- `meeting_transcribe_local_asr` 通过 `LOCAL_ASR_SERVICE_URL` 调用本地 Qwen3-ASR HTTP 服务。
- 生成 transcript segments，字段包含 `sourceFile`、`sourceHashSha256`、`chunkIndex`、`startSec`、`endSec`、`text`、`model`、`endpoint`。
- 生成 evidence chunks。
- 生成会议纪要。
- 会议纪要输出 `meetingTitle`、`titleBasis`、`feishuFileName`；Markdown H1 与 `meetingTitle` 一致。
- 飞书文件名与 `feishuFileName` 一致，不再使用原始 WAV 文件名作为默认文档名。
- PRD、技术架构、运营方案、客户需求确认表也必须有项目/方向命名：runner 写出 `document-title-plan.json`，最终 Markdown H1 和飞书 `.md` 文件名必须使用同一标题，不得只使用 `prd.md`、`tech-architecture.md`、`customer-requirement-checklist.md` 或模板里的“待确认”泛称。
- 关键结论带 evidence id。
- 低置信度片段被标记。
- `summary.json.externalAudioUpload=false`。
- 本地 ASR cache miss 且服务不可用时返回 `local_asr_service_not_running`，带 `status-local-asr` 和本机启动命令；不得自动改走小米、DeepSeek、外部 ASR 或批处理脚本。

QA-RAW 基准：

- 3 个 WAV，共约 56.62 分钟。
- 30 秒固定 chunk，预期 114 个 transcript segments。
- 0 failed chunks。
- 原始音频只进入本机 ASR 服务。

会议纪要风格回归：

- 使用 Terry 视频 Agent 目标 PDF 作为结构、表达密度和议题展开方式参考，不作为事实来源。
- 当前视频 Agent 会议重跑后，商业模式、收费结构、超级个体合作、素材规模与权限等有连续证据的主议题必须独立展开，不得只出现在一个 bullet 中。
- HR/财务两份 QA-RAW 会议重跑后，不应强行套用战略型结构；只有 transcript 中有连续证据的主议题才展开。
- 小米 MiMo 复核必须返回或确认 `omittedMacroTopics`：连续多个 transcript segment 的主议题是否被遗漏，商业模式/超级个体/合作方式是否被压缩成单句，行动项是否覆盖所有主议题。
- 人工对照目标 PDF 评估议题完整度、判断深度、行动项分组和最终判断层次。

## 3. Document Router 测试

样本：

- 产品需求会：应输出纪要 + PRD + 客户需求确认表。
- 技术方案会：应输出纪要 + 技术架构文档。
- 运营复盘会：应输出纪要 + 运营方案 + 复盘。
- 混合会议：应输出多文档拆分理由。

断言：

- 每个选中文档都有 reason。
- 未选中文档有 reason。
- 信息缺口被列出。

## 4. Writer 测试

PRD：

- 包含目标与非目标。
- MVP 不包含二期承诺。
- 验收标准可执行。

架构文档：

- 包含模块、数据流、接口草案、权限、测试、Phase。
- 不引入无证据复杂架构。

运营文档：

- 包含 SOP、指标、节奏、资源、风险和复盘。

## 5. 飞书 CLI 直通测试

未安装 CLI：

- `feishu_cli(["--help"])` 返回清晰 `lark-cli not found` 错误。
- 工具不崩溃，返回 exitCode/stdout/stderr/error。

安装 CLI 后：

- `feishu_cli(["--help"])` 输出官方帮助。
- `feishu_cli(["docs", "--help"])` 能查看文档能力。
- `feishu_cli(["drive", "--help"])` 能查看云空间能力。
- `feishu_cli(["im", "--help"])` 能查看 IM 能力。
- `feishu_cli(["calendar", "--help"])`、`["tasks", "--help"]`、`["meetings", "--help"]`、`["sheets", "--help"]`、`["base", "--help"]` 能用于能力发现。

断言：

- 不存在 `feishu_prepare_operation`、`feishu_execute_approved_operation`、`feishu_record_publish_result`。
- 不存在 approval-store、Feishu action enum、message preview hash。
- 飞书读写、移动、IM、任务、日历等能力通过官方 CLI 子命令直接获得。
- 凭证不写入仓库或 sanitized trajectory。
- `feishu_cli(["auth", "status", "--verify"])` 未带 `redactionPolicy="auth-status-summary"` 时阻断。
- 任何会进入模型上下文的非 auth CLI 输出使用 `redactionPolicy="secret-scan"`。

## 5.5 飞书机器人事件网关测试

场景：

- 飞书自建应用已开启机器人能力。
- 开放平台事件与回调订阅 `im.message.receive_v1`。
- 本地设置 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`。

断言：

- `feishu_bot_gateway_plan` 明确 MCP 不是聊天回应必需项，并列出长连接/HTTP 回调配置。
- `feishu_bot_gateway_check` 只返回 env 是否存在，不返回 secret 原文。
- `node meeting-agent-pi-package/tools/feishu_bot_event_gateway.mjs` 在缺少 SDK 时提示安装 `@larksuiteoapi/node-sdk@^1.24.0`。
- 长连接启动后，飞书后台不再报“应用未建立长连接”；配置 loopback `FEISHU_BOT_HANDLER_URL=http://127.0.0.1:8788/feishu/events` 后，gateway 默认进入 HTTP handler 模式，不需要显式设置 `FEISHU_BOT_REPLY_MODE=http`。
- handler 返回 `status/runId/documents/publishStatus/replyStatus` 时，gateway 能转成飞书可读文本；handler 返回 `suppressGatewayReply=true` 时，gateway 不重复回复。
- `FEISHU_BOT_HANDLER_TIMEOUT_MS` 默认 20000 ms；真实 PI runtime path 建议配合 handler 的 `FEISHU_AGENT_ASYNC=1` 返回 `202 accepted + runId`。
- 缺事件订阅、缺权限、应用未发布、机器人不在群里或用户不可用时，能定位为配置问题而不是 CLI/MCP 问题。

## 5.6 Feishu Agent Bridge 测试

基础静态检查：

- `node --check meeting-agent-pi-package/tools/feishu_event_runner.mjs`
- `node --check meeting-agent-pi-package/tools/task_router.mjs`
- `node --check meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs`
- `node --check meeting-agent-pi-package/tools/task_execution_runner.mjs`
- `node --check meeting-agent-pi-package/tools/runtime_tool_cli.mjs`
- `python3 -m json.tool meeting-agent-pi-package/runtime/execution-profiles.json`
- `python3 -m json.tool meeting-agent-pi-package/runtime/execution-profiles.schema.json`
- `python3 -m json.tool meeting-agent-pi-package/runtime/tool-load-manifest.json`
- `python3 -m json.tool meeting-agent-pi-package/runtime/feishu-event.schema.json`
- `python3 -m json.tool meeting-agent-pi-package/runtime/feishu-task.schema.json`
- `python3 -m json.tool meeting-agent-pi-package/runtime/feishu-run-state.schema.json`
- `python3 -m json.tool meeting-agent-pi-package/runtime/im-event.schema.json`
- `python3 -m json.tool meeting-agent-pi-package/runtime/office-task-state.schema.json`

本地 Docker 常驻运行回归：

- 架构边界必须保持 **Host 原生控制面 + Local Docker 受限执行面**；本地 Docker 不能减少本机总计算消耗，只用于隔离、限额、队列和后台常驻。
- `docker compose -f docker-compose.local-runtime.yml up -d runtime-queue pi-document-worker hermes-worker` 能启动 Redis queue、受限 document worker 和 Hermes worker。
- `docker compose -f docker-compose.local-runtime.yml config` 必须保留 `runtime-queue`、`pi-document-worker`、`hermes-worker`、`mem_limit: 8g`、`cpus: "4.0"`、`FEISHU_AGENT_DOCUMENT_WORKER_CONCURRENCY=2` 和 `HERMES_WIKI_AUTO_PUBLISH=0`。
- `4 CPU / 8GB / 长文档并发 2` 是默认均衡档位；Redis queue 内存上限 256MB；Hermes worker 1 CPU / 1GB。
- `fast_answer/file_summary 不进 Docker`：普通问答和文件一句话总结不得写 `local_docker_worker_enqueued`，也不得出现 document worker、QA、Policy 或 publish 长链路 stage。
- `document_generation/multi_source_synthesis 默认进 Docker worker`：启用 `FEISHU_AGENT_DOCUMENT_WORKER_MODE=docker` 后，PRD/架构/checklist 和多源综合任务应写出 `artifacts/docker-worker/job.json`、bounded `task.json`，并由 Docker worker 写回 `agent-output.json`。
- `audio_minutes` 必须在 Host 完成 audio normalize + local ASR；Docker job bundle 中 `raw audio 不进容器`，只能出现 transcript/evidence/bounded file context 类 artifact pointer。
- `document_revision` v1 必须留在 Host，Feishu comment/review-context 预取不得进入 Docker worker。
- Docker worker job bundle 不包含 Feishu token、App Secret、Authorization、cookie、CLI session、raw media 或 `lark-cli` 调用；Docker worker 不 publish、不 reply。
- worker 超时、Redis 不可用或 queue depth 超阈值时返回 blocked/retry-later 类结果，不自动退回 Host 长链路；Host handler 仍要完成可读 reply/publish artifact。
- Hermes Docker worker 只处理 sanitized trajectory，生成 learning proposal，`HERMES_WIKI_AUTO_PUBLISH=0`，不得自动发布 Wiki。

Fixture text event：

- `feishu_event_runner.mjs --fixture ... --handler-url http://127.0.0.1:8788/feishu/events` 能把 normalized event 转发给 handler。
- runner fixture 输入同时支持单个 pretty JSON event、JSON array 和 NDJSON，避免 handler 产物不能直接回放。
- `feishu_agent_task_handler.mjs --fixture ... --mock-agent --publish-mode dry-run --reply-mode dry-run` 写入 `event.json`、`task.json`、`state.json`、`agent-task.md`、`agent-output.json`、`publish.json`、`reply.json`、`run.metrics.json`、`run-manifest.json`、`sanitized-trajectory.json`。
- 文本“总结文件内容”无附件时必须进入文件解析路径并返回缺文件提示；不能标记为 `no_file_reference`。
- 文件消息后续引用“总结文件内容”时，按当前附件、显式 Feishu file URL/token、父消息/root 消息、最近附件缓存解析；用户侧回复不暴露本地 `runId`。
- 显式 Feishu file URL/token 存在时不得 fallback 到最近附件缓存；如果该文件无法读取，回复“当前文件无法读取，请重新上传或确认权限”。
- 最近附件缓存必须按任务模态过滤：文档写作请求不得命中旧音频；音频缓存只在用户明确请求录音、音频或转写类上下文时使用。
- 音频消息后续引用“形成会议纪要/会议纪要/录音/音频/转写/minutes”时，必须按当前附件、父消息/root 消息、最近附件缓存解析；不能标记为 `no_file_reference`。
- `publish.json` 只包含 planned commands，不执行 live Feishu write。
- HTTP handler 开启 `FEISHU_AGENT_ASYNC=1` 时，POST `/feishu/events` 返回 `202 accepted`、`runId`、`text`、空 `documents`、`publishStatus: pending`、`replyStatus: pending`，后台 `state.json` 最终进入 `completed|blocked|needs_fix|failed`。

Fixture file/audio event：

- 附件 manifest 包含 `downloadStatus`、`sha256`、`sizeBytes` 或 dry-run planned download command。
- PDF/Word/Excel/Markdown/TXT/CSV 文本附件生成 `file-context.json`，包含 `file-context`、`disclosurePlan`、`contextPreview` 或 `extractedTextPath`。
- 先收到文件、后收到“分析该文件”的 fixture 必须通过最近附件缓存关联；无缓存时提示重新上传或同消息附带文件。
- 不支持文件类型或未接入能力直接回复 `目前暂不支持该功能`。
- Profile assertions：普通文本问答 -> `fast_answer`，文件一句话总结 -> `file_summary`，音频会议纪要 -> `audio_minutes`，PRD/架构/checklist -> `document_generation`，批注修订 -> `document_revision`，图片/视频/删除 -> `unsupported`。
- `fast_answer` 和 `file_summary` 的 `state.json` 不得出现 `document_workers_planned`、`qa_gate_completed`、`policy_gate_completed`、`audio_downloaded`、`local_asr_started` 或 Wiki publish 阶段；`file_summary` 只能使用 bounded file context preview/extracted slices。
- `runtime_tool_cli.mjs` 必须读取 `runtime/tool-load-manifest.json`，并在 `--profile fast_answer|file_summary` 时只加载 Model Router / Model Provider 所需 extension；不得回退为仅依赖内置硬编码 extension 列表。
- `.wav/.mp3/.m4a/.aac/.flac/.ogg` 即使飞书 `resourceType=file` 也必须按音频处理，`file-context` 为 `local_asr_only`，`requiresLocalAsr=true`；音频只代表 source preparation，不得强制把输出文档固定成 `meeting-minutes`。
- 音频会议纪要 execute path 必须进入 `task_execution_runner`，而不是 ASR 后再交给单体 PI CLI 黑盒。`state.json` 至少出现 `task_execution_runner_started`、`audio_downloaded`、`audio_normalized`、`local_asr_started`、`local_asr_completed`、`model_route_planned`、`meeting_minutes_generated`、`qa_gate_completed`、`policy_gate_completed`。
- PRD/技术架构/checklist 等文档写作 execute path 必须进入 `task_execution_runner`，生成 `evidence-pack.json` 和 `documents_generated`，且没有音频 source 时不得出现 `audio_downloaded/local_asr_*`。
- PRD/技术架构/checklist 等文档写作必须生成 `document-title-plan.json`；fixture 中“工作流 AI 化”类 prompt 的最终 H1/文件名应包含该项目方向。
- 多音频、多会议纪要文件或多个 Feishu URL 默认合并为一套文档；`evidence-pack.json` 必须保留 source map 和 `conflictPolicy=source_attribution`。
- audio normalize 必须把 WAV/MP3/M4A/AAC/FLAC/OGG 本地转成 `16-bit PCM WAV / mono / 16000 Hz`，写出 `audio-normalize.json`；没有 `ffmpeg`/`afconvert` 或转码失败时，回复 `目前音频格式暂不支持自动转码。`
- ASR service payload 的 `paths` 必须是 normalized WAV 路径，不得直接传用户上传原始音频路径。
- Feishu audio minutes regression 是显式阻断项：上述阶段 marker 缺任意一个，或 ASR 完成后没有可观测进度并长期 pending，均判定回归失败。
- `model-route.json` 中会议纪要必须显示 `meeting_minutes` route，默认模型为 `deepseek-v4-pro`；ASR cache 命中时不得重跑本地 ASR。
- 图片和视频素材直接回复 `目前暂不支持该功能`；视频不得进入 local ASR。
- handler 不把 raw media、App Secret、Authorization、CLI session、完整 raw transcript 写入 metrics、wiki 或 model output。
- 两阶段稳态运行：SDK gateway 只回复“已接受任务，正在处理。”；后台 runner 默认不发送中间进度，只在完成后通过 `lark-cli im +messages-reply` 回复最终结果，避免 gateway/handler 双重回复。
- 文档修订评论读取：`review-context.json` 必须记录 `commentAccess.method=cli|sdk|export_body_detected|unavailable`、`identityTried`、`requiredScopes`、`apiStatus`、`commentThreadCount`、`replyCount`、`unresolvedCount`。缺 `docs:document.comment:read` 或等价 Drive/Docs scope 时必须写 `comment_api_permission_blocked`，不得声称已处理独立评论线程。
- 文档评论正文匹配：多文档输入时必须写 `sourceDocuments[].comments[]`，每条评论必须带有效 `sourceId`、`matchStatus`、`matchReason`。`exact_unique` 可作为局部修订依据；`exact_multiple`、`fuzzy`、`unmatched`、`exported_body_detected` 必须进入待确认或明确说明处理方式。部分 source 读取失败时顶层状态使用 `partial_ready`，不得把失败 source 的评论混入其他文档。
- Feishu inbound 明确要求撰写、保存、发布、放到云端或覆盖修改时，QA pass 后默认允许 `write_private`/`publish_customer_visible`，不再要求二次确认。
- 发布默认 `FEISHU_AGENT_PUBLISH_TARGET=auto`：先生成 `wiki-publish-plan.json`，用 `markdown +create`、`wiki +node-create`、`wiki +move` 发布到 Feishu Wiki；Wiki 权限不足时写 `wiki-publish.json` 并 fallback 到 Drive，原因必须是 `wiki_publish_blocked_drive_fallback`。
- Drive fallback 才复用当前 chat/thread 会话目录，写入本地 publish target registry；有明确 file token/link 的修改任务使用 `markdown +overwrite`。
- `feishu-wiki-target-registry.json` 必须按 `project:{normalizedProjectTitle}`、`category:{projectKey}:{docType}`、`document:{projectKey}:{sourceRun}:{docType}:{titleHash}` 复用 Wiki 节点，不得把 `runId` 或 `feishu-chat-*` 当顶层目录名。
- Publish Taxonomy / Project Workspace 回归：同源会议纪要、PRD、技术架构、客户需求确认表必须进入同一 `项目｜{projectTitle}` Wiki 树；分类节点按 docType 动态创建/复用。用户可见 Wiki 标题不得包含 Feishu token、`feishu file 00 ...`、normalized audio、generic filename 或 runId，必须使用 `{docKind}｜{projectTitle}｜{purpose}｜{run timestamp}.md` 这类业务标题。
- 历史重整回归：`feishu_publish_organize_cli.mjs apply --no-delete` 重复运行时应对已存在文档返回 `wiki_document_skip_existing`，不得重复创建 Wiki 文档；`apply --live --no-delete` 不得删除旧 Drive 文件或覆盖原 URL，Drive 移动权限失败必须记录原因并保持 Wiki 项目树可用。
- 删除、清空、移除、销毁类请求必须 blocked 或回复 `目前暂不支持该功能`，并且 planned/live commands 不得包含 delete/trash/remove/purge。

Live smoke：

- 仅在 `lark-cli auth status --verify` 通过、`FEISHU_EVENT_KEY` 可用且开放平台权限已发布后执行。
- `lark-cli event consume <EventKey> --max-events 1` 能接收机器人消息。
- handler execute mode 能调用 PI runtime path；QA/Policy pass 后优先用 `markdown +create`、`wiki +node-create`、`wiki +move` 发布到 Wiki，再用 `im +messages-reply` 回复；Wiki 不可用时 fallback 到 `drive +create-folder`/`markdown +create`。
- auth/keychain、EventKey、权限、附件下载或发布阻塞时，必须新增或更新 `wiki/issues/*.md`。

Hermes Wiki：

- `python3 hermes-learning-sidecar/sidecar.py --run-dir runtime-runs/feishu-agent/runs/<runId> --out <out>` 必须生成 `hermes-wiki-candidate.json`、`hermes-wiki-reflection-gate.json` 和 `hermes-wiki-publish.json`。
- Gate pass 且 `HERMES_WIKI_SPACE_ID` 或 `HERMES_WIKI_ROOT_NODE_TOKEN` 存在时，Hermes 默认尝试自动入库单独的 Hermes 思考库。
- 缺少 Hermes Wiki target 时，`hermes-wiki-publish.json` 必须记录 `hermes_wiki_publish_blocked_missing_target`，不得写入用户交付物 Wiki。
- Candidate 可保留项目/客户语境，但不得包含 secret、token、Authorization、App Secret、CLI session、raw audio/video 或大段原始全文。

## 5.7 Cross-IM adapter skeleton 测试

本轮只验收 WeChat skeleton，不验收 WeChat live 能力。

断言：

- WeChat 文档只能声明 adapter skeleton、capability matrix、统一 schema 映射和 unsupported 边界。
- WeChat skeleton 不承诺 live 收消息、下载附件、发文件、群内发布、云文档创建或生产 E2E。
- WeChat adapter 未来只能映射到 `im-event-v1`、`im-attachment-v1`、`im-reply-v1`、`publish-target-v1` 和 `office-task-state-v1`，不能复制 Feishu 主流程或新建独立 Planner/Router/Prompt/Worker/QA/Policy 链路。
- Feishu 与 WeChat 的差异必须体现在 channel capability matrix 和 Policy Gate payload 中，而不是让 adapter 自己决定业务流程。
- `wechat_event_adapter.mjs --fixture ... --invoke-handler` 必须在 mock/dry-run 中调用同一个 `feishu_agent_task_handler.mjs`/runner path，输出 `im-event.json`、`file-context-plan.json`、`office-task-state.json` 和 handler dry-run artifacts。

## 5.7.1 Office runtime 测试

- `document_lifecycle_plan(action=delete|clear|remove|destroy)` 返回 blocked；`overwrite/rewrite_section` 没有明确 file token、链接或本会话生成文档时返回 `needs_confirmation`。
- `document_lifecycle_write` 必须写出 `document-lifecycle.json`，包含 `sourceRun`、`version`、`lifecycleEvents`、`destructiveActionsAllowed=false`。
- `retrieval_index_write` 只接受 pointer-only entry；包含 raw transcript、fullText、rawFile、request body、secret/token/cookie/session 字段时 blocked。
- `retrieval_index_search` 只返回 bounded preview、summary、sourceRun 和 artifact pointers。
- `memory_proposal_write` 只能写 `pending_review`、`autoPersisted=false` 的 proposal，不得直接修改生产 prompt 或长期记忆。

## 5.8 Runtime 工程化测试

Capability Registry：

- `capability_registry_plan("普通私有草稿")` 只推荐 always-on 核心能力和 `doc-writer`，不推荐 meeting-only path、Feishu bot、Rokid、WebAccess/MCP 或第三方 subagent 包。
- `capability_registry_plan("飞书机器人不回复")` 推荐 `feishu-bot-gateway`，并列出 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`im.message.receive_v1`。
- `capability_registry_plan("飞书收到录音附件后生成纪要并发布")` 推荐 `feishu-agent-bridge`、`local-asr`、`meeting-minutes`、`document-worker-runtime`，不推荐 MCP。
- `capability_registry_plan("长会议生成纪要和 PRD")` 推荐 `agent-team-runtime` 和 `context-offload`。

Runtime Metrics：

- `runtime_metrics_start` 生成 `runtime-runs/{run_id}/run.metrics.json`。
- `runtime_metrics_record` 能记录 capability、model、tool、external、artifact、contextBudget、qaGate、planner、policy、workerDecision、capabilitySelection、packageAudit。
- metrics schema 必须包含 `plannerDecisions`、`policyDecisions`、`workerDecisions`、`capabilitySelections`、`packageAudits`。

Model Router：

- 一句话总结、普通问答和短草稿默认选择 `fast_draft` 或 `main_draft -> deepseek/deepseek-v4-flash`。
- 会议纪要默认选择 `meeting_minutes -> deepseek/deepseek-v4-pro`。
- PRD、技术架构、复杂运营方案、客户需求清单和用户明确“深度思考”的任务默认选择 `document_shard_deep` 或 `deep_draft -> deepseek/deepseek-v4-pro`。
- Provider 不可用时可以自动 fallback，但 `silentFallbackAllowed=false` 且必须写 `model-route.json`；全部 provider 不可用时返回 blocked。
- metrics 中不得出现 App Secret、API key、cookie、token、CLI session 或 raw transcript 全文。

Planner / Policy Gate:

- `meeting-agent-pi-package/runtime/planner-envelope.schema.json` 存在，并要求 Planner Envelope 最小字段。
- `meeting-agent-pi-package/runtime/policy-gate.schema.json` 存在，并只允许 `pass|needs_confirmation|blocked`。
- `planner-runtime.ts` 和 `policy-gate.ts` 使用 PI tool extension 形式注册工具。

Document prompt / worker runtime:

- `document-prompt-registry.json` 是唯一 docType -> promptFile 映射；`prd`、`ops-plan`、`tech-architecture` 必须映射到正式 prompt。
- 每个 registry prompt 必须位于 `prompts/` 目录内，并且只包含一个 `{{input}}`。
- `document_prompt_render_batch` 必须把 router conclusion、evidence summary 和 source input 注入正式 prompt。
- `document_workers_run` 使用 mock provider 时能按 registry `dependsOn` 生成 dependency waves，wave 内并行生成多份文档，最终结果按 `taskIndex` 排序。
- PRD/技术架构/FDE checklist 同时生成时，executionWaves 必须为：`prd` -> `tech-architecture` -> `customer-requirement-checklist`。
- `tech-architecture` 的 `qaInput.upstreamDocumentsUsed` 必须包含 `prd`；`customer-requirement-checklist` 的 `qaInput.upstreamDocumentsUsed` 必须包含 `prd` 和 `tech-architecture`，且 checklist 必须体现 FDE（前端部署工程师）沟通定位。
- 每个 document worker 必须按 registry `requiredSections` 生成 `sectionBatches`，合并后写入 `sectionAttempts`、`repairAttempts` 和 `missingSections`。
- mock section-batch 回归必须让 `qaInput.missingSections=[]`，且 QA gate 不再因 `document_missing_sections` 失败。
- 没有 `renderedPrompt` 的 worker 返回 `document_prompt_required`。
- `model_provider_check` 不返回 API key、Authorization、raw request body 或 App Secret；Xiaomi 缺少 `XIAOMI_BASE_URL` 时 unavailable。
- `qa_gate_evaluate` 能识别 documentOutputs 的 `missingSections`、`unsupportedClaims`、`crossDocumentContamination`、`openQuestions`、`missingUpstreamDocuments`、FDE checklist 定位和 router reason 覆盖缺失。
- `meeting-minutes` 默认 `priority=primary`；PRD、运营、架构、客户需求确认表默认 `priority=follow_up`。
- follow-up 文档缺章节时，`overallStatus=partial_ready`，对应 artifact `blocksDelivery=false`，但 `primaryDeliveryStatus=ready` 且 `publishAllowed=true`。
- primary 会议纪要缺证据、遗漏主议题、隐私泄露或标题不同步时，必须让 `primaryDeliveryStatus=needs_fix|blocked`，不得被 follow-up 状态掩盖。

Model Routing：

- `model_route_plan(taskType="main_draft")` 默认选择 DeepSeek。
- 当 `unavailableProviders=["deepseek"]` 时自动 fallback 到配置内候选模型，并返回 `fallbackOccurred=true`。
- 当所有候选 provider 不可用时返回 `blocked/no_candidate_model_available`。
- `model_route_record` 必须写入 `model-route.json`；不得静默换模型。

QA Gate：

- `qa_gate_evaluate` 对 `unsupportedEntities`、`crossMeetingTerms`、raw media external upload、secret leak 返回 `blocked`。
- 发布场景下 `omittedMacroTopics` 返回 `blocked`，非发布场景至少返回 `needs_fix`。
- `publishAllowed` 跟随 primary artifact：只有 `status=pass` 时为 true；此时 follow-up artifact 仍可能让 `overallStatus=partial_ready`。

Context Offload：

- 长会议 transcript/full evidence 通过 `context_offload_write` 写入 `runtime-runs/{run_id}/offload/*`。
- 主上下文只保留 pointer-only 摘要：artifact path、hash、size、bounded preview、topicMap、evidence map、QA gate 和 open questions。
- `context_offload_read` 必须 bounded readback，不默认回读完整长 transcript。

Agent Team Runtime：

- `agent_team_components` 返回 dynamic worker pool，不返回 fixed roles 或固定常驻 role。
- `agent_team_plan("长会议，多文档，飞书发布前检查")` 推荐 topicMap/evidence/entity/Feishu readiness/document/risk 相关组件。
- `agent_team_run` 使用 Node `worker_threads` 并行运行多个组件；组件不写文件。
- 最终飞书发布前仍必须串行通过 `qa_gate_evaluate`。

## 6. Rokid 测试

场景：

- 指定一个 Rokid 导出目录。
- 目录包含音频、视频、图片和未知文件。

断言：

- 能列出候选文件。
- 支持文件生成 artifact metadata。
- 未知文件标记为 unsupported。
- 不上传原始媒体，音频转写仍走本地 ASR HTTP 服务。
- metadata 包含 source、device label、hash、privacy level。

## 7. Hermes Sidecar 测试

输入：

- 合规 sanitized trajectory。
- 包含 raw transcript 的不合规 trajectory。
- 包含 token 标记的不合规 trajectory。

断言：

- 合规输入输出四类 proposal。
- 不合规输入报告 sanitization issues。
- sidecar 不修改生产 skill/prompt。
- sidecar 不读取 Feishu/Rokid token。
- `python3 hermes-learning-sidecar/sidecar.py --run-dir runtime-runs/feishu-agent/runs/<runId> --out <out>` 能读取 `sanitized-trajectory.json` 或从 run artifact 生成后再输出 proposal。

## 8. 供应链测试

必须检查：

- `hermes-learning-sidecar/dependency-policy.json`。
- Python lockfile 或 requirements。
- Node lockfile。
- 容器镜像依赖清单。

断言：

- `mistralai==2.4.6` 被阻断。
- 未锁版本的高权限运行依赖需要人工 review。
- 任何 import-time 下载/执行行为必须标记为阻断项。

## 9. 端到端验收

使用 PDF 参考会议纪要的结构作为样例。以下是会议纪要/后续文档场景的端到端验收，不代表 PI 全局运行时固定 workflow：

1. 输入会议素材。
2. 本地 Qwen3-ASR HTTP 服务生成 transcript/evidence。
3. `runtime_metrics_start` 开始 run，`capability_registry_plan` 选择 lazy capabilities。
4. 长会议用 `context_offload_write` 保存 full transcript/evidence，主上下文只保留 pointer-only 摘要。
5. `agent_team_run` 用 dynamic worker pool 并行抽 topicMap/evidence/entity/risk。
6. `model_route_plan` 选择 DeepSeek V4 或配置内 fallback，并记录 `model-route.json`。
7. DeepSeek V4 或 fallback 模型基于 evidence 生成纪要和 document-router。
8. Router 判断需要 PRD/架构/运营/确认表中的哪些文档。
9. 需要时用 Agent Team 的 document shard worker 并行生成文档 scaffold，再由主控整合成草稿。
10. 小米 MiMo 复核遗漏、幻觉、owner/deadline 编造和证据引用缺口。
11. `qa_gate_evaluate` 检查证据、隐私、参考 PDF 事实混入风险、topic coverage、entity safety、Feishu readiness 和模型路由记录。
12. 飞书 Agent 通过 `feishu_cli` 调用官方 `lark-cli` 执行需要的读写动作，并按 redaction policy 处理进入模型上下文的输出。
13. 如用户要求确认，先走可选 confirmation checkpoint。
14. `runtime_metrics_finish` 写入最终 QA gate 和状态。
15. 生成 sanitized trajectory。
16. Hermes sidecar 输出 proposal。

验收通过条件：

- 全流程不泄漏 token。
- 飞书 CLI 凭证不进入仓库、trajectory 或 sidecar。
- 原始音频未发送给 DeepSeek/小米；语义阶段只发送 transcript/evidence 文本。
- transcript/evidence 文本发送 DeepSeek/小米属于默认允许行为，不要求逐次人工确认。
- 飞书 Markdown/文档创建、移动和更新属于默认允许行为；IM/日历/任务、客户可见发布或 scope 扩大才要求单独确认。
- 飞书文件名与会议纪要标题同步。
- PDF 参考文件只影响结构和风格，不作为当前会议事实。
- 多议题/战略型会议先形成内部 `topicMap`，再按主议题展开；不存在重要连续议题被压缩或遗漏的 `omittedMacroTopics`。
- 模型 fallback 可以自动发生，但必须记录，且不得因为静默换模型导致 debug 断点缺失。
- Agent Team 使用动态组件池并行处理可并行任务，不预加载固定 role。
- 长 transcript/full evidence 不常驻主上下文，必须 offload 为本地 artifact。
- legacy `qa-runs/` 目录只作为非生产证据，raw transcript/response JSON 不进入生产上下文。
- 关键结论可追溯。
- 自优化不自动合入。
