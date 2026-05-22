# 飞书 / Rokid / Hermes 权限与凭证策略

## 1. 策略目标

权限策略服务三个目标：

- 飞书个人自用场景下，尽量直接使用官方能力，避免自建复杂 Adapter。
- 保护会议原始内容、客户信息、飞书 token、Rokid 文件和模型服务密钥。
- 在 Hermes 供应链风险未完全解除前，将其限制为只读学习侧车。

## 2. 数据分级

| 等级 | 示例 | 默认处理 |
| --- | --- | --- |
| L0 Public | 已公开资料、公开文档链接 | 可用于输出和引用 |
| L1 Internal | 内部流程、普通项目计划 | 可进入项目知识库 |
| L2 Customer | 客户需求、客户会议纪要 | 可作为 transcript/evidence 进入 DeepSeek/小米和飞书文档生成；输出前复核 |
| L3 Confidential | 未公开商业信息、报价、合同、敏感项目 | transcript/evidence 默认可用于语义生成和复核；raw media 不外发 |
| L4 Restricted | token、密钥、账号、原始音视频、身份信息 | 不进入长期记忆，不外发，最小化读取 |

未知等级默认按 L3 处理。Rokid 原始音视频默认按 L4 处理。

关键边界：

- 原始录音、原始视频、base64 音频和未抽取 raw media 是硬红线，只能进入本地 ASR/媒体 pipeline，不发送给 DeepSeek、小米、飞书或 Hermes。
- ASR 后的 transcript/evidence、会议纪要草稿、复核意见和文档摘要属于文本证据层，默认允许发送给 DeepSeek/小米和写入飞书文档。
- 运行时策略固定为 `MEETING_TEXT_EVIDENCE_EXTERNAL_LLM_DEFAULT=allow` 和 `MEETING_RAW_MEDIA_EXTERNAL_UPLOAD_DEFAULT=deny`。执行 agent 应直接遵守该策略，不为 transcript/evidence 文本外发反复请求授权。

## 3. 飞书权限策略

飞书集成直接采用官方 `lark-cli`：

```text
feishu_cli(args: string[], stdin?: string, timeoutMs?: number, parseJson?: boolean, redactionPolicy?: "none" | "auth-status-summary" | "secret-scan")
```

PI 工具只负责执行：

```text
lark-cli ...args
```

默认规则：

- 官方 `lark-cli` 是唯一飞书能力来源。
- 不维护自定义 `read_doc/create_doc/send_im/move_doc` wrapper。
- 不维护 Feishu action enum。
- 不维护 approval-store。
- 不做默认 dry-run。
- 不做飞书专用审计日志或 message hash。
- 飞书 Docs、Drive、IM、Calendar、Tasks、Meetings、Sheets、Base 等能力都由官方 CLI 子命令提供。
- agent 可以在当前官方 CLI 登录态和 scope 内直接读写。

飞书双向 Agent 入口优先走 CLI-first 事件桥：

```text
lark-cli event consume <EventKey> --as bot
  -> meeting-agent-pi-package/tools/feishu_event_runner.mjs
  -> meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs
```

默认规则：

- 机器人要回应用户消息，必须在飞书开放平台开启机器人能力，订阅 `im.message.receive_v1`，发布应用，并提供可用的 `FEISHU_EVENT_KEY` 或 SDK gateway 配置。
- `feishu_event_runner.mjs` 只消费、标准化、去重和转发事件，不生成文档、不发布飞书。
- `feishu_agent_task_handler.mjs` 只编排 run artifact、附件下载、本地 ASR/PI task、发布和回复，不硬编码文档结构。
- 附件下载优先用 `lark-cli im +messages-resources-download --as bot`，路径限制在当前 run artifact 目录。
- 飞书发布只使用 `lark-cli drive +create-folder`、`markdown +create`、`drive +upload` 和 `im +messages-reply`。
- QA Gate 不可发布或 Policy Gate 未通过时，只回复 blocked/needs_fix 状态，不发布文档或文件夹。
- SDK 长连接 `feishu_bot_event_gateway.mjs` 是可选入口；配置 loopback `FEISHU_BOT_HANDLER_URL=http://127.0.0.1:8788/feishu/events` 后默认转发到同一个 handler，真实 PI pipeline 建议配合 `FEISHU_AGENT_ASYNC=1`。
- MCP 不是机器人收消息、回复消息或发布文档的必需项；MCP 只适合把飞书 API 暴露为 AI 工具。
- `feishu_bot_gateway_plan` 和 `feishu_bot_gateway_check` 只能输出配置计划和脱敏就绪状态，不得返回 App Secret。

凭证规则：

- 不把 app secret、refresh token、cookie、CLI session、个人访问令牌写入仓库。
- 不把凭证写入 trajectory、proposal、wiki、日志示例或测试 fixture。
- 未脱敏的 `lark-cli auth status --verify` 输出按 L4 Restricted 处理，不得返回给外部模型。
- 脱敏登录态摘要可以返回给模型，但只能包含 CLI 是否可用、是否验证通过、登录状态、exit code、检查时间、`rawOutputReturned:false`、`identityRedacted:true` 和错误类别。
- 账号邮箱、手机号、姓名、租户名、tenant/app/user/open id、token、cookie、session、原始 stdout/stderr 都不得进入模型上下文。
- 默认飞书模型上下文要脱敏：auth status 用 `auth-status-summary`；其他 `lark-cli` 输出如需进入模型上下文、run summary 或 QA report，使用 `secret-scan`，命中疑似 secret 时只保留阻断摘要。
- `lark-cli` 未安装或未登录时，返回明确错误并提示安装/登录。
- `FEISHU_EVENT_KEY`、`FEISHU_APP_ID` 和 `FEISHU_APP_SECRET` 只能通过环境变量提供给 event runner 或 bot event gateway，不得进入仓库、wiki、trajectory、日志示例或测试 fixture。

可选确认：

- 用户明确要求发布前确认时，可以调用 `approval_request`。
- 外部 API 处理 transcript/evidence 文本不需要逐次确认。
- transcript/evidence 文本发送 DeepSeek/小米是默认允许的会议语义处理，不属于高风险动作。
- 外部 ASR 处理原始音视频、发送 IM/日历/任务给第三方、客户可见发布、安装依赖、扩大飞书/Rokid scope 时，需要单独确认。
- 可选确认不是飞书文档创建、移动、更新或 Markdown 上传的执行前置条件。

## 4. Rokid 权限策略

第一阶段默认方式：

- 读取用户指定的本地导出目录。
- 索引音频、视频、图片和 metadata。
- 只生成本地 artifact metadata。
- 优先使用 Rokid 灵珠平台已有 MCP/官方能力，不自建复杂 Bridge。

禁止默认行为：

- 未批准上传原始音视频。
- 自动开启实时采集。
- 绕过官方鉴权。
- 伪装为官方 MCP。
- 把原始会议内容写入长期记忆。

如果未来进入实时采集 Phase，必须新增确认：

- 采集开始/结束提示。
- 采集范围。
- 数据保存路径。
- 是否上传。
- 参会人告知与同意。

## 5. Hermes 与供应链策略

Hermes 只允许作为学习侧车：

- 输入：sanitized trajectory。
- 输出：memory、prompt、skill、eval proposal。
- 权限：无飞书 token、无 Rokid token、无生产写权限。

运行前必须检查：

- lockfile。
- package cache。
- Python environment。
- container image。
- `dependency-policy.json`。

必须阻断：

- `mistralai==2.4.6`。
- 任何未解释的 postinstall/import-time 网络执行。
- 未锁版本的高权限运行环境。
- 未经审查的 Hermes 插件。

处置策略：

- 若发现受影响版本，停止运行。
- 检查是否执行过 import。
- 搜索 IoC，如 `/tmp/transformers.pyz`。
- 轮换可能暴露的 token。
- 重新构建干净环境。

## 6. 运行摘要

sanitized trajectory 只保留通用运行摘要：

- run id。
- 输入类型和隐私等级。
- 输出类型和状态。
- 关键决策、理由和证据引用。
- evidence coverage、privacy findings、missing inputs。

不保留：

- 飞书 action log。
- approval log。
- IM 内容 hash。
- 原始会议正文。
- token、cookie、session、secret。

## 7. Phase 执行

### Phase 0

- 建立数据分级和 dependency policy。
- 明确凭证不入库规则。

### Phase 1

- 本地文件处理只写本地 metadata。
- 输出前做 QA。

### Phase 2

- 使用 `feishu_cli` 直通官方 `lark-cli`。
- 覆盖读、写、移动、IM、任务、日历等官方 CLI 已支持能力。

### Phase 3

- Rokid 只读导出目录或官方灵珠能力。
- 实时采集不进入 MVP。

### Phase 4

- Hermes 只读脱敏 trajectory。
- proposal 合入必须人工 review。
