# Meeting Document Agent 开发执行规则

## 读取顺序

任何接手本项目的 agent 或开发者必须先按顺序读取：

1. `wiki/00-plan.md`
2. `wiki/01-prd.md`
3. `wiki/02-agent-architecture.md`
4. `wiki/05-feishu-rokid-permissions.md`
5. `wiki/06-agent-team-index.md`
6. `wiki/11-current-project-architecture.md`

如果任务涉及 prompt 或 skill，再读取：

- `wiki/03-system-prompts.md`
- `wiki/04-skill-design.md`

如果任务涉及复盘、自优化或 Hermes，再读取：

- `wiki/11-current-project-architecture.md`
- `hermes-learning-sidecar/dependency-policy.json`

## 项目目标

本项目要实现一个用于日常会议终结和文档撰写的 Agent。它从录音、视频、Rokid 智能眼镜导出文件和飞书上下文中建立证据链，生成会议纪要，并根据会议内容继续生成 PRD、技术架构文档、运营文档、客户需求确认表或复盘文档。

## 框架路线

- PI Agent 是主动执行框架。
- Hermes Agent 是只读学习侧车。
- PI 是一个 agentic office assistant：它必须具备多种办公协助能力，并允许后续不断增加、替换和迭代能力。
- PI 必须由 Agentic Planner 根据用户目标动态拆任务、选择 capability、组合工具、决定是否启用 dynamic worker pool；不得把全局运行时固化为固定 workflow、固定 DAG、固定状态机或会议专用 pipeline。
- Capability Registry 是能力扩展边界：Feishu、Rokid、ASR、Docs、Calendar、Tasks、Search、Writer、QA、MCP/Subagent 等能力应按任务 lazy load，不得默认常驻导致上下文膨胀。
- Policy Gate 只拦截越界动作，例如客户可见发布、通知他人、日历/任务变更、外部联网、安装依赖、长期记忆写入、原始媒体外发和权限 scope 扩大；它不规定业务流程。
- PI 可以处理真实会议、调用工具、生成文档，并通过官方 `lark-cli` 直接执行当前登录态允许的飞书读写动作。
- Hermes 只能读取脱敏 trajectory 并输出 proposal。
- Hermes proposal 必须经过人工 review 和回归测试后才能合入生产 skill/prompt。

## 本地运行配置

本项目唯一人工运行配置入口是 `.env.local`：

- 从 `.env.example` 复制生成 `.env.local`，只在 `.env.local` 填真实 LLM API key。
- 默认主控/文档生成 LLM 是 DeepSeek V4：`PI_PROVIDER=deepseek`、`PI_MODEL=deepseek-v4-pro`。
- 复核/兜底 LLM 是小米 MiMo Token Plan SGP：`PI_REVIEW_PROVIDER=xiaomi-token-plan-sgp`、`PI_REVIEW_MODEL=mimo-v2.5-pro`。
- 会议语义层默认权限：`MEETING_TEXT_EVIDENCE_EXTERNAL_LLM_DEFAULT=allow`。ASR 阶段允许按 `MEETING_ASR_PROVIDER` 使用本地或云端 provider；原始录音可上传到明确配置的云端 ASR。ASR 之后，document worker、QA、Docker、Hermes、DeepSeek/小米仍只能接收 transcript/evidence 文本，不得接收 raw audio、视频或 base64 音频。
- `.pi/settings.json` 只用于加载 `meeting-agent-pi-package`，不得写 provider、model、endpoint 或 API key。
- 飞书凭证不进入 `.env.local`；飞书登录态、token 和 session 交给官方 `lark-cli` 管理。
- 未脱敏的 `lark-cli auth status --verify` 输出不得进入模型上下文；如需用 PI 验证登录态，只允许使用 `feishu_cli(["auth","status","--verify"], redactionPolicy="auth-status-summary")` 这类脱敏摘要。
- 脱敏登录态摘要可以给模型；原始账号元数据、tenant/app/user/open id、token、cookie、session、stdout/stderr 不可以给模型。
- 如果 PI 不支持小米或 DeepSeek provider，直接更新 PI：`npm install -g @earendil-works/pi-coding-agent@latest`，不要新增 `~/.pi/agent/models.json` 作为默认兜底。

默认启动 DeepSeek 主控：

```bash
set -a
source .env.local
set +a

pi --provider "$PI_PROVIDER" --model "$PI_MODEL"
```

切换小米 MiMo 复核模型：

```bash
set -a
source .env.local
set +a

pi --provider "$PI_REVIEW_PROVIDER" --model "$PI_REVIEW_MODEL"
```

## ASR Provider 默认策略

会议音频转文字采用 provider abstraction：`MEETING_ASR_PROVIDER=auto|local_qwen3|aliyun_dashscope_paraformer`。默认 `auto`：存在百炼/DashScope API key 时优先云端 `aliyun_dashscope_paraformer`，否则回落本地 `local_qwen3`。不得直接启动批处理转写脚本作为兜底。

- 本地 ASR 模型：`mlx-community/Qwen3-ASR-1.7B-4bit`。
- 本地模型目录：`models/Qwen3-ASR-1.7B-MLX-4bit`。
- 本地服务入口：`meeting-agent-pi-package/tools/local_asr_http_service.py`，默认 `http://127.0.0.1:8765`。
- 云端 ASR provider：`aliyun_dashscope_paraformer`，默认模型 `paraformer-realtime-v2`，默认语言提示 `yue,zh,en`。
- 运行时：Apple Silicon 上的 `mlx-qwen3-asr` / MLX Metal，服务常驻加载模型。
- 默认切片：30 秒固定非重叠 chunk，便于断点续跑和 evidence 引用。
- 输出：`transcriptSegments` 必须包含 `sourceFile`、`sourceHashSha256`、`chunkIndex`、`startSec`、`endSec`、`text`、`model`、`endpoint`。
- 原始音频上传：只允许在 ASR provider 阶段上传到配置的云端 ASR；后续文档、QA、发布、Hermes 和 Docker 阶段不得接收 raw audio。
- 故障策略：云端 ASR 需区分鉴权、网络、模型、格式、超时和 partial；本地 ASR 服务不可用时报告 `local_asr_service_unavailable`。不得自动改走小米、DeepSeek 或脚本兜底。

启动本地 ASR 服务：

```bash
.venv-qwen3-asr/bin/python meeting-agent-pi-package/tools/local_asr_http_service.py \
  --host 127.0.0.1 \
  --port 8765 \
  --model-dir models/Qwen3-ASR-1.7B-MLX-4bit \
  --preload
```

已验证 QA-RAW 运行结果：

- 3 个 WAV，共 56.62 分钟音频。
- 114 个 transcript segments。
- 0 个失败 chunk。
- 总 ASR 耗时约 17.94 分钟，RTF 约 0.317，约 3.15x realtime。

会议 agent 后续阶段的参考链路是：ASR provider -> evidence index -> planner 选择 meeting-minutes/document-router/writer -> 模型路由生成会议纪要、PRD/技术/运营文档 -> 小米 MiMo 或 QA worker 复核遗漏、幻觉、owner/deadline 和证据引用 -> QA safety review -> 可选飞书发布。该链路只适用于会议纪要/后续文档场景，不是 PI 全局固定 workflow。权限核心原则是：原始音频只在 ASR 阶段处理；ASR 后的 transcript/evidence、纪要草稿、复核意见和飞书文档写入默认放行，不要求每次重复授权。执行 agent 不得为了该默认放行动作创建临时脚本绕过工具链，应使用 PI provider、现有 prompt/skill 和 Feishu CLI 直通能力。

## Phase 顺序

### Phase 0：文档与凭证基线

先完成文档、数据分级、凭证不入库规则和依赖策略。没有完成凭证基线前，不允许把飞书/Rokid token、模型服务密钥或原始敏感会议内容写入仓库。

### Phase 1：本地会议文件 MVP

实现本地音频/视频/图片导入、转写、evidence index、会议纪要、文档路由和 PRD/架构/运营文档草稿。

### Phase 2：飞书集成

直接采用官方 `lark-cli`。飞书 Docs、Drive、IM、Calendar、Tasks、Meetings、Sheets、Base 等能力都通过 `feishu_cli(args, stdin?, timeoutMs?, parseJson?)` 透传到 `lark-cli`。不维护自定义 Feishu Adapter、action enum、approval-store 或默认 dry-run。

### Phase 3：Rokid 文件导入

只处理用户指定的 Rokid 导出目录。实时采集、手机端 companion app、眼镜端 app 都不属于 MVP。

### Phase 4：复盘与自优化

PI 输出 sanitized trajectory。Hermes sidecar 输出 proposal。人工 review 后小步合入。

### Phase 5：生产增强

增加多会议知识库、飞书状态同步、模板版本管理、可观测性和可选实时设备链路。

## 权限红线

禁止：

- 在仓库写入任何飞书、Rokid、模型服务 token。
- 在 `.pi/settings.json`、wiki、trajectory、sidecar output 中写入 LLM API key、飞书 token 或 CLI session。
- 将未脱敏的飞书登录态验证输出送入外部模型。
- 把原始会议全文写入长期记忆。
- 把原始录音、原始视频、base64 音频或未抽取的 raw media 上传给 DeepSeek、小米、飞书、Hermes、Docker/document worker 或非 ASR 外部服务。
- 让 Hermes 持有飞书/Rokid token。
- 让 Hermes 直接修改生产 skill/prompt。
- 安装或运行 `mistralai==2.4.6`。

个人自用默认：

- 飞书动作按当前官方 CLI 登录态和权限直接读写。
- ASR 后的 transcript/evidence 文本可默认发送给 DeepSeek 和小米用于会议纪要、文档生成和复核。
- 这个默认策略不需要逐次人工确认，也不应被 QA safety review 标记为 blocking issue。
- 飞书文件夹创建、Markdown/文档创建、移动和更新默认按用户任务目标直接执行，不因普通会议内容再次请求授权。
- 需要预览或确认时，可以显式调用可选 `approval_request`，但它不是飞书执行前置条件。
- dry-run 只作为用户明确要求的预览策略，不是默认规则。
- 只有发送 IM/日历/任务给第三方、客户可见发布、安装依赖、扩大飞书/Rokid 权限 scope，或把 raw media 交给非 ASR 外部服务时，才需要单独确认。

## 文档输出规则

所有会议产物必须区分：

- 已有证据支持的事实。
- 合理推断。
- 待确认问题。

关键结论、决策和行动项必须尽量引用 evidence id。证据不足时，不要编造；列入待确认问题。

会议纪要必须生成并传播统一标题：

- `meetingTitle` 由会议内容生成，主要参考与会人员/角色、会议内容、会议安排和会议结论。
- Markdown H1 必须等于 `meetingTitle`。
- 飞书 Markdown/文档文件名必须由 `meetingTitle` 派生，格式为 `{meetingTitle}.md`。
- 如果与会人员、安排或结论证据不足，用角色称谓或 `待确认`，不得编造姓名、日期或承诺。

文档生成、文档修订和多源 synthesis 必须遵守 Runtime Context Plane 的 Document Output Contract：

- 文档标题必须来自 `source-context-runtime` 产出的 `documentIdentity`，并记录 `basis/confidence`；不得从 Feishu 附件 token、generic upload filename 或运行时文件名推断用户可见标题。
- 源文件中的 heading、table、comment anchor 必须进入 `source-structure.json`；HTML table 只能以 Markdown preview、columns、rowCount 和 source block id 进入 context pack。
- 发布前 QA 必须检查 `bad_document_title`、`document_identity_missing`、`raw_html_table_in_markdown`、`table_source_unreadable_in_output`；失败时不得发布，只能返回可解释失败原因。
- runner 只消费 `documentIdentity/sourceStructure/outputContract` 并连接 artifact，不得重新成为标题或表格语义 owner。

## Agent Team 分工

- PI Planner：目标识别、能力选择、工具组合、dynamic worker pool 选择、Policy Gate 插入。
- Ingestion & Transcription：文件导入、转写、证据索引。
- Minutes & Router：会议纪要和文档类型判断。
- Document Writers：PRD、架构、运营、需求确认表、复盘文档。
- Feishu Integration：官方 `lark-cli` 全能力透传，覆盖读取、写入、移动、IM、任务、日历等当前 CLI 支持的能力。
- Rokid MCP Bridge：Rokid 导出目录扫描和 artifact 导入。
- Security QA Retro：事实、隐私、权限、供应链、复盘和 proposal review。

## Handoff 要求

agent 之间交接必须包含：

```json
{
  "from_agent": "agent name",
  "to_agent": "agent name",
  "meeting_id": "meeting id",
  "phase": "Phase N",
  "outputs": [],
  "evidence_ids": [],
  "open_questions": [],
  "risks": [],
  "approval_required": false
}
```

## 开发核实清单

提交任何实现前必须核实：

- 是否符合当前 Phase。
- 是否读过对应 wiki 文档。
- 是否新增或扩大了权限。
- 是否引入了 file/audio/video/image/document 输入；如果有，必须先定义 extraction、normalization、segmentation、context budget、privacy boundary、cache/store、failure UX，并确认是否需要进入 `source-context-runtime`。
- 是否引入客户可见文档输出；如果有，必须定义 Document Output Contract，包括 title policy、Markdown table policy、source structure provenance 和 publish-blocking QA rules。
- 是否把文件、ASR、批注或多源证据直接拼进 prompt；长内容必须先进入 Source Context，模型只消费 bounded context pack 和 source segment 引用。
- 是否会触发 Rokid/外部 API 高风险动作，或把飞书凭证写入仓库。
- 是否可能保存原始会议内容。
- 是否引入未审计依赖。
- 是否影响 Hermes 与 PI 的执行边界。
- 是否有测试或验收说明。

## 供应链策略

Hermes 或任何 Python/Node 依赖进入执行环境前必须检查：

- lockfile。
- package cache。
- container image。
- dependency policy。
- 已知恶意版本。

`mistralai==2.4.6` 必须被阻断。若发现该版本曾在环境中安装或 import，必须停止运行、检查 IoC、轮换可能暴露的凭证，并重建干净环境。

## 默认交付标准

一个模块完成的标准：

- 文档和实现一致。
- 输入输出明确。
- 错误状态明确。
- 飞书能力通过官方 `lark-cli` 直通，缺少 CLI 时有清晰错误。
- 隐私数据不外泄。
- 有最小测试或手动验收路径。
- 复盘数据经过脱敏。
