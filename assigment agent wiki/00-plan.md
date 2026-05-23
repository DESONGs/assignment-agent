# 会议终结与文档撰写 Agent 开发总计划

## 目标

建立一个用于日常会议终结和文档撰写的本地优先 Agent。它能从录音、视频、Rokid 智能眼镜导出素材和飞书上下文中建立证据链，生成会议纪要，并根据会议内容继续生成 PRD、技术架构文档、运营文档、客户需求确认表或复盘文档。

本计划以 PDF 参考会议纪要中的工作方式为样例：先把会议内容结构化，再提炼核心结论、开放问题、行动项、风险和后续交付物。业务侧采用“超级个体 / FDE + AI 工作流咨询”的交付模型，技术侧采用“PI 主执行 + Hermes 学习侧车”的双框架并行路线。

## 核心决策

- PI Agent 是第一阶段主动执行框架，负责真实会议处理、工具调用和飞书/Rokid 集成。
- PI 的运行时方向是 agentic office assistant：由 PI Agentic Planner 根据用户目标动态选择 capability、工具和 worker；Policy Gate 只拦截越界动作，不把业务执行固化成固定 workflow。
- Planner Envelope 是非平凡任务的运行契约：记录 `goal`、`taskType`、`successCriteria`、`capabilitiesNeeded`、`toolPlan`、`parallelizableWorkers`、`policyRisks`、`requiredArtifacts` 和 `stopConditions`，用于审计当前目标，不作为固定流程模板复用。
- Capability Registry 条目必须是 planner-selectable capability descriptions，字段包含 `description`、`toolIntents`、`policy`、`observability`、`installState` 和 `securityReview`，让 Planner 能说明选择理由，Policy Gate 能判断动作边界。
- 第三方包采用 package audit/install mechanism：先审计来源、README、依赖、环境变量、网络、文件写入和 prompt 行为；安装必须经过 `install_dependency` Policy Gate，并记录到 `packageAudits`。
- Runtime metrics 必须记录 `plannerDecisions`、`policyDecisions`、`workerDecisions`、`capabilitySelections` 和 `packageAudits`，覆盖 planner/policy/worker/package 决策链。
- Hermes Agent 只作为隔离学习侧车，读取脱敏 trajectory 并提出 memory、prompt、skill、eval proposal；不得持有飞书/Rokid 凭证，不得直接修改生产 skill。
- Hermes 运行前必须做供应链审计。`mistralai==2.4.6` 被列为禁止依赖，任何包含该版本的 lockfile、镜像、缓存或运行环境都必须阻断。
- 飞书接入直接使用官方 `lark-cli`。PI 只提供 `feishu_cli(args, stdin?, timeoutMs?, parseJson?)` 直通工具，不维护自定义 Adapter、action enum、approval-store、默认 dry-run 或 Feishu 专用审计层。
- 飞书双向 Agent 入口使用 `feishu-agent-bridge`：`lark-cli event consume` 进入 `feishu_event_runner.mjs`，再由 `feishu_agent_task_handler.mjs` 生成本地 PI task、处理附件、执行 QA/Policy 后发布/回复。bridge 的 fixture/mock publish 默认 dry-run；这不改变 `feishu_cli` 直通工具不加默认 dry-run 的原则。
- 飞书输出进入模型上下文前默认脱敏：auth status 必须使用 `auth-status-summary`，其他可能进入上下文的 CLI 输出默认使用 `secret-scan`。
- Rokid 接入第一阶段只做文件导入：监听或扫描本地导出目录，导入录音、视频、图片和 metadata。实时采集、眼镜端 App 和手机端桥接进入后续 Phase。
- 原始 transcript/full evidence 默认 offload 为本地 artifact，主上下文只保留 pointer、hash、bounded preview、topicMap、evidence map、QA gate 和 open questions。
- ASR 固定为本地 HTTP 服务路径；服务不可用时阻塞，不走脚本、DeepSeek、小米或 hosted ASR 兜底。
- 所有文档输出必须区分“会议证据、合理推断、待确认问题”，不能用模型猜测替代会议事实。

## 文档索引

- `wiki/01-prd.md`：产品目标、用户、场景、功能范围、验收标准。
- `wiki/02-agent-architecture.md`：PI/Hermes 双框架架构、模块边界、数据流、接口草案。
- `wiki/03-system-prompts.md`：各模块 system prompt。
- `wiki/04-skill-design.md`：skills、输入输出、工具、Phase 和验收。
- `wiki/05-feishu-rokid-permissions.md`：飞书、Rokid、Hermes、供应链和可选确认策略。
- `wiki/06-agent-team-index.md`：动态 worker 组件、能力边界和 scenario playbook 说明。
- `wiki/07-test-plan.md`：文档、工具、权限、安全和端到端测试计划。
- `wiki/11-current-project-architecture.md`：当前代码实现与项目架构同步快照，防止 wiki 落后于代码。
- `wiki/12-feishu-agent-bidirectional-integration-plan.md`：飞书和 Agent 双向打通的产品级迭代方案。
- `wiki/13-office-agent-product-technical-review.md`：办公 Agent 产品/技术缺口、Feishu/WeChat IM 分工和后续补足路线图。
- `wiki/14-local-data-storage-cache-backend.md`：本地 artifact、SQLite metadata、Redis queue、Docker worker 和 retention/cache 后端方案。
- `wiki/issues/README.md`：开发问题记录规范；后续架构、运行时、QA、集成或文档一致性问题必须在 `wiki/issues/` 中沉淀为 Markdown。
- `agent.md`：根目录项目开发规则，所有执行 agent 必须先读。

历史迭代计划、一次性 handoff、旧 QA 报告和固定角色拆分文档不再保留为 active wiki。代码已落地的内容统一以 `wiki/11-current-project-architecture.md`、对应专题 wiki 和 `src/validate_workspace.py` 为准。

## Phase 路线图

### Phase 0：需求核实与凭证基线

交付物：

- 完成 PRD、架构、skill、权限、复盘、agent team 文档。
- 建立运行期工程化基线：Planner Envelope、Policy Gate、metrics、capability registry、model routing、QA gate、context offload 和动态 Agent Team worker。
- 建立 legacy `qa-runs/` 非生产警告：历史 raw transcript、Feishu raw JSON 和模型 response JSON 只作审计证据，不作为生产上下文。
- 定义会议素材数据分级、凭证不入库规则和默认禁止动作。
- 确认 Feishu/Lark 使用中国区还是国际区域，记录 app id/secret 的存放方式，但不写入仓库。
- 明确 Rokid 第一阶段素材来源：本地导出目录、手机端导出目录或人工上传目录。
- 建立依赖禁止清单，包含 `mistralai==2.4.6`。

验收：

- 新开发者或 agent 只读文档即可理解 Phase 顺序、模块边界和安全红线。
- 飞书凭证、Rokid 凭证、模型服务密钥和原始敏感会议内容不会写入仓库。

### Phase 1：本地会议文件 MVP

交付物：

- 本地音频/视频/图片导入工具。
- media artifact metadata：来源、文件 hash、时间、隐私等级、处理状态。
- 转写与证据索引：文本片段、时间戳、说话人可选、证据 id。
- 会议纪要生成：主题、背景、核心结论、关键讨论、行动项、风险、开放问题。
- Document Router：根据会议内容决定是否生成 PRD、技术架构、运营方案、客户需求确认表或复盘。

验收：

- 输入一段会议录音或视频后，能生成可追溯的纪要草稿和至少一种后续文档草稿。
- 输出中每个关键判断都能回溯到内部 evidence 或明确标记为推断；用户可见正文不得暴露 raw evidence id、chunk id 或源音频文件名。

### Phase 2：飞书集成

交付物：

- 官方 `lark-cli` 配置说明。
- 通用 `feishu_cli` 工具：参数直接透传到 `lark-cli`。
- Feishu Agent bridge：`feishu_event_runner.mjs`、`feishu_agent_task_handler.mjs`、`feishu-event/task/run-state` schema 和 `feishu-agent-bridge` skill。
- 飞书文档读取、搜索、创建、更新、移动、Wiki、IM、任务、日历、会议、Sheets、Base 等官方 CLI 支持的能力。
- 入站消息和附件：`lark-cli event consume`、`im +messages-resources-download`、本地 artifact、PI task prompt、QA/Policy 后 `markdown +create`、`drive +create-folder/+upload`、`im +messages-reply`。
- 可选确认 checkpoint：用户明确要求预览、确认或发布前复核时才调用。
- 失败处理：权限不足、token 过期、网络失败、目标文档不存在。

验收：

- `lark-cli` 未安装时返回清晰错误。
- `lark-cli` 安装后能通过 `feishu_cli(["--help"])` 和各子命令 help 发现能力。
- 不再出现自定义 `read_doc/create_doc/send_im/move_doc` 映射、approval-store 或 Feishu action enum。
- Fixture text/file/audio event 能写入 `event.json`、`task.json`、`state.json`、`agent-task.md`、`agent-output.json`、`publish.json` 和 `reply.json`；live smoke 只有在 `lark-cli auth status --verify` 通过后执行。

### Phase 3：Rokid Export Bridge

交付物：

- Rokid 导出文件桥接设计，不假设已有稳定官方 Rokid MCP。
- 工具草案：`rokid.list_exports`、`rokid.import_artifact`、`rokid.get_metadata`、`rokid.mark_processed`。
- 本地导出目录监听或扫描策略。
- 原始媒体不上传、不过度持久化、不进入长期记忆。

验收：

- 能从 Rokid 导出目录导入会议相关文件并进入 Phase 1 pipeline。
- 每个文件都记录设备来源、导入时间、hash 和隐私级别。

### Phase 4：Agent Team 和自优化闭环

交付物：

- PI Planner、Ingestion、Minutes/Router、Writer、Feishu、Rokid、安全 QA/复盘等 capability playbook 和责任边界文档。
- 运行层采用动态 Agent Team 组件池，不预加载固定 subagent role；长会议和多文档任务按需并行 topicMap、evidence coverage、entity gate、document shard 和风险/开放项抽取。
- 脱敏 trajectory schema。
- Hermes sidecar proposal 格式。
- 回归评估集：产品会、技术会、运营会、客户需求确认会、复盘会。

验收：

- Hermes 只能输出 proposal，不能写生产配置。
- Agent Team worker 输出必须可回溯到 evidence 或 artifact，最终发布仍受 QA gate 串行阻断。
- proposal 必须经过人工 review 和回归测试后才能合入。

### Phase 5：生产化增强

交付物：

- 多会议项目知识库。
- 模板版本管理。
- 飞书发布状态同步。
- 可观测性、审计日志和错误恢复。
- 模型 fallback 自动但可记录，长 transcript/evidence 使用本地 context offload。
- 可选：Rokid 实时采集、手机端 companion app、眼镜端轻量采集 app。

验收：

- 支持连续日常会议使用，能从反馈中稳定改进文档质量。
- 不牺牲权限边界和数据安全。

## 会议纪要场景参考链路

以下链路只描述会议纪要/后续文档场景的 reference playbook，不是 PI 全局运行时的固定 workflow。其他办公协助任务应由 PI Agentic Planner 根据用户目标、Capability Registry 和 Policy Gate 动态决定能力组合。

1. 用户放入会议录音、视频或 Rokid 导出文件。
2. Ingestion Agent 建立 artifact metadata 和 evidence index。
3. Transcription Agent 生成带时间戳的转写。
4. Minutes Agent 生成会议纪要。
5. Document Router 判断后续文档类型。
6. Document worker 生成 PRD、架构、运营或复盘文档。
7. QA Agent 检查证据、隐私、事实和风险。
8. Feishu Agent 通过官方 `lark-cli` 读取、写入、移动或发送 IM。
9. 如用户明确要求确认，则先走可选 confirmation checkpoint。
10. 任务结束后生成脱敏 trajectory。
11. Hermes sidecar 复盘并输出 proposal。
12. 人工 review 后合入 skill/prompt/eval 改进。

## 默认约束

- 不在仓库中保存任何飞书、Rokid、模型服务 token。
- 不把原始会议全文、客户敏感内容、原始音视频写入长期记忆。
- 飞书执行依赖当前官方 CLI 登录态和权限，不在仓库保存凭证。
- 不安装或运行未审计 Hermes 依赖。
- 不把“自优化”设计成自动改生产系统；所有变更必须可审查、可回滚、可测试。

## 开发组织与 issue 记录

- 代码、runtime 配置、prompt、skill 或工具行为变化后，必须同步更新对应 wiki；不能只依赖聊天记录作为事实来源。
- 后续遇到开发问题、架构分歧、QA 失败、模型 fallback 异常、Feishu/Rokid/ASR 集成问题、上下文膨胀或安全边界问题时，必须在 `wiki/issues/` 下新增 Markdown issue 文档。
- issue 文档命名使用 `YYYY-MM-DD-short-problem-slug.md`，模板和规则见 `wiki/issues/README.md`。
- 修复完成后，issue 状态应更新为 `fixed`，并补充验证命令、artifact 路径和同步过的 wiki 文件。
- issue 中不得写入 API key、App Secret、Authorization header、cookie、CLI session、raw request body、raw transcript 全文或原始媒体。
