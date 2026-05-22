# Feishu-Agent Bidirectional Integration Plan

更新时间：2026-05-20

## 1. 产品目标

本轮目标不是简单让机器人“能回一句话”，而是把飞书端和本地 Agent 打通成一个双向办公入口：

```text
Feishu user / group
  -> text command / file / audio / document link
  -> local Agent task
  -> ASR / document generation / QA / policy
  -> Feishu folder / document / file / reply message
```

用户在飞书中应该可以完成以下动作：

- 给机器人发送自然语言指令，例如“根据这段会议录音生成会议纪要和 PRD”。
- 发送或转发会议录音、文本型文档、飞书文档链接、飞书文件夹链接。图片和视频素材当前不接入，直接回复 `目前暂不支持该功能`。
- 在单聊或群聊中查看 Agent 的接收确认、执行进度、待确认问题、最终文档链接。
- 要求 Agent 在飞书中创建文件夹、创建或更新文档、上传附件、回复消息；删除、清空、移除、销毁类动作不支持。
- 在需要确认时，通过飞书消息明确确认、取消、重试或补充输入。

Agent 侧应该可以完成以下动作：

- 接收飞书消息事件并转换为本地 PI task。
- 从飞书消息或云盘下载授权文件到本地 artifact。
- 调用本地 ASR、document router、document workers、QA gate 和 Policy Gate。
- 将生成结果发布回飞书，包括消息、Markdown 文档、飞书文档、文件夹和附件。
- 保持运行证据可审计：谁触发、哪个 chat/message、下载了哪些 artifact、生成了哪些文档、发布到了哪里。

## 2. 当前状态判断

当前代码已经具备 B-E 的本地闭环实现，live Feishu smoke 仍取决于 CLI auth/profile 和开放平台权限：

| 能力 | 当前状态 | 说明 |
| --- | --- | --- |
| 主动操作飞书 | 已具备 | `feishu_cli` 直通官方 `lark-cli` 已实现；本机 CLI 已安装，`docs/drive/im/markdown/event/task/calendar` help 可用。 |
| 飞书登录态 | 环境 blocked | `lark-cli auth status --verify` 当前因 keychain/profile 未初始化返回非 0；代码不绕过该边界，live smoke 需修复登录态后执行。 |
| 机器人入站事件 | 已实现本地桥 | `feishu_event_runner.mjs` 可消费 `lark-cli event consume`、fixture 或 stdin，标准化、去重并转发到 handler。 |
| CLI 事件消费 | 可作为优先路径 | `lark-cli event consume <EventKey>` 已可用，可输出 NDJSON 事件流。 |
| 飞书消息转 Agent task | 已实现 | `feishu_agent_task_handler.mjs` 接收 normalized event，写入 `event.json`、`task.json`、`state.json`、`agent-task.md`、`run.metrics.json`、`run-manifest.json`、`sanitized-trajectory.json`。 |
| 文件上下文 | 已实现 | PDF/Word/Excel/Markdown/TXT/CSV 文本文件和显式 Feishu file URL/token 进入 `file-context`；指代解析按当前附件 -> 显式 URL/token -> 父消息/root 消息 -> 同 chat/sender/thread 缓存。显式 URL 禁止被缓存覆盖，缓存按文本/音频模态过滤；不支持能力回复 `目前暂不支持该功能`。 |
| 飞书附件下载到本地 ASR | 已接入 handler | handler 支持 `im +messages-resources-download` planned/live 路径、local fixture 附件 hash；`.wav/.mp3/.m4a/.aac/.flac/.ogg` 按音频进入本地 `audio_normalize`，统一转成 `16k mono s16 WAV` 后再进入 local ASR。图片和视频素材不接入。 |
| 文档 pipeline 执行 | 已拆出薄执行器 | `task_execution_runner.mjs` 不做新编排，只执行阶段、记录观测并通过 `runtime_tool_cli.mjs` 调 Planner/Model Router/Prompt Registry/Document Worker/QA Gate/Policy Gate。音频只是 source preparation；会议纪要走 `meeting_minutes -> deepseek/deepseek-v4-pro`。 |
| 文档评论线程读取 | 已接入 CLI-first review context | `document_revision` 会生成 `review-context.json`；优先用 `lark-cli drive file.comments list`、`file.comments batch_query`、`file.comment.replys list` 读取独立评论线程，SDK 只作同 API fallback；缺 `docs:document.comment:read` 或等价 Drive/Docs scope 时记录 `comment_api_permission_blocked`。 |
| 结果发布回飞书 | 已实现 Wiki 优先 + Drive fallback | handler 根据 `agent-output.json` 的 QA/Policy 结果生成 `publish.json`；默认 `FEISHU_AGENT_PUBLISH_TARGET=auto`，先写 `wiki-publish-plan.json` 并用 `markdown +create`、`wiki +node-create`、`wiki +move` 发布到 Wiki；Wiki 不可用时记录 `wiki_publish_blocked_drive_fallback` 并 fallback 到 Drive。 |
| 运行记录 / Hermes | 已实现候选入库闭环 | 每个 run 写入状态机、metrics、manifest 和 Hermes 可读 `sanitized-trajectory.json`；Hermes 支持 `--run-dir` 读取，并生成 `hermes-wiki-candidate.json`、`hermes-wiki-reflection-gate.json`、`hermes-wiki-publish.json`。 |
| MCP | 暂不需要 | MCP 不是消息事件入口，后续只作为 optional capability。 |

新增实现文件：

- `meeting-agent-pi-package/tools/feishu_event_runner.mjs`
- `meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs`
- `meeting-agent-pi-package/tools/task_execution_runner.mjs`
- `meeting-agent-pi-package/tools/runtime_tool_cli.mjs`
- `meeting-agent-pi-package/runtime/feishu-event.schema.json`
- `meeting-agent-pi-package/runtime/feishu-task.schema.json`
- `meeting-agent-pi-package/runtime/feishu-run-state.schema.json`
- `meeting-agent-pi-package/runtime/im-event.schema.json`
- `meeting-agent-pi-package/runtime/im-attachment.schema.json`
- `meeting-agent-pi-package/runtime/im-reply.schema.json`
- `meeting-agent-pi-package/runtime/publish-target.schema.json`
- `meeting-agent-pi-package/runtime/office-task-state.schema.json`
- `meeting-agent-pi-package/skills/feishu-agent-bridge/SKILL.md`

## 3. 设计原则

### 3.0 Decision-layer invariant

飞书入站、未来 WeChat skeleton、本地文件入口和 publisher 都不能拥有业务决策权。运行时只有 Planner、Model Router、Prompt Registry、Document Worker、QA Gate 和 Policy Gate 是决策层：

- Planner 决定任务拆分、capability 组合、工具意图和 worker 计划。
- Model Router 决定模型 route、provider 候选、fallback 和 route artifact。
- Prompt Registry 决定 docType、prompt 模板和 required section contract。
- Document Worker 决定章节批次执行、合并、缺章节 repair 和文档级 QA input。
- QA Gate 决定内容是否可交付。
- Policy Gate 决定动作边界是否允许。

Capability Registry 只提供 capability 描述、readiness 和 policy metadata；`feishu_event_runner.mjs`、`feishu_agent_task_handler.mjs`、`task_execution_runner.mjs`、`runtime_tool_cli.mjs` 和 Feishu publisher 都只负责转换、执行、记录或发布，不决定业务流程。

### 3.1 CLI-first，而不是 MCP-first

当前 `lark-cli` 已覆盖 MVP 需要的大部分飞书操作：

- `event consume`：消费实时事件。
- `im +messages-send/+messages-reply/+messages-resources-download`：发送、回复、下载消息资源。
- `drive +create-folder/+upload/+download/+move/+import/+export`：文件夹和文件处理。
- `docs +create/+fetch/+update`：文档处理。
- `markdown +create/+fetch/+overwrite`：Markdown 文件处理。
- `task/calendar`：任务和日历。
- `api`：兜底调用开放平台 API。

因此第一阶段不引入 Feishu MCP。MCP 只作为后续 `candidate/defaultLoad:false` capability，用于统一工具协议或补齐 CLI 不便表达的能力。

### 3.2 轻量常驻入口，Agent 按需加载

可以有一个轻量常驻的飞书入口进程，但不能让完整 Agent 常驻并持有全部上下文。

常驻部分只做：

- 监听飞书事件。
- 去重、解析、记录最小事件 metadata。
- 下载必要附件到本地 artifact。
- 调用本地 task handler。
- 回复进度或错误。

按需加载部分才做：

- Planner Envelope。
- Capability Registry selection。
- 本地 ASR。
- 文档 prompt render。
- document workers。
- model provider。
- QA Gate / Policy Gate。
- 飞书发布。

文档 pipeline 当前使用 `task_execution_runner` 执行这些阶段。它不是新的编排权来源，只是把 source preparation、可选 ASR、evidence pack、document title plan 和后续 runtime tool 调用拆成可观测阶段；Planner、Model Router、Prompt Registry、Document Worker、QA Gate 和 Policy Gate 仍然是唯一决策层。Feishu audio minutes regression 必须在 `state.json` / metrics / manifest 中保留 `task_execution_runner_started`、`audio_downloaded`、`audio_normalized`、`local_asr_started`、`local_asr_completed`、`model_route_planned`、`meeting_minutes_generated`、`qa_gate_completed`、`policy_gate_completed` 和最终 publish/reply 状态；非音频文档写作必须生成 `evidence-pack.json`、`document-title-plan.json`、`wiki-publish-plan.json` 和 `documents_generated`，不得出现 ASR 阶段。最终 Markdown H1、飞书 `.md` 文件名和 Wiki 节点名必须基于项目/方向同步，不能只使用 docType 或模板泛称。

飞书文档修订任务使用同一条文档 pipeline。用户引用 doc/docx/wiki 并要求“根据批注/评论/修改内容/重新优化”时，handler 只设置 `taskType=document_revision`、`operation=document_revision` 和 `responseMode=document_pipeline`；runner 生成 `review-context.json`，Prompt Registry 在原 docType prompt 上追加 `document-revision-overlay.md`，Document Worker 输出修订后的完整 Markdown。`review-context.json` 优先来自 Feishu 评论 API；若 scope 不足记录 `comment_api_permission_blocked`，若只能看到导出正文中的批注痕迹记录 `body_ready_comments_not_available` / `export_body_detected`，不能把未读取到的独立评论线程当成事实。

评论读取是 on-demand capability，不新增常驻评论 watcher。`review-context.json` 必须以 `sourceDocuments[].comments[]` 为主，每条评论带 `sourceId`、`matchStatus` 和 `matchReason`；顶层 `comments` 仅用于兼容旧消费者。`exact_unique` 表示 quote 在对应 source 正文中唯一命中；`exact_multiple`、`fuzzy`、`unmatched`、`exported_body_detected` 都需要保留待确认或说明处理方式。多文档任务中禁止把一个 source 的评论套用到另一个 source。

### 3.3 飞书是交互入口，不是长期记忆

飞书消息和文件只作为当前 task 输入或 artifact 来源。不得把原始聊天、录音、视频或完整 transcript 自动写入长期记忆。需要持久化的只保留：

- `runId`
- chat/message/thread pointer
- artifact path/hash/size
- bounded preview
- task status
- publish target；当前实现按 chat/thread 维护会话级发布目录 registry，`FEISHU_AGENT_FOLDER_TOKEN` 只作为父目录或兜底目标。
- sanitized error

### 3.4 动作边界由 Policy Gate 判断

以下动作必须按实际动作逐次经过 Policy Gate，不能只在任务开始前做一次总判断：

- 客户可见发布。
- 给人发 IM、群消息或主动通知。
- 创建/更新/移动飞书文档和文件夹。
- 创建任务、日历或分配 owner。
- 下载或处理外部来源文件。
- 安装依赖。
- 外部联网查询。
- 持久化记忆。

Policy Gate 只判断边界，不生成业务流程；业务流程仍由 Planner 和 scenario playbook 决定。`publishBackToFeishu=true` 表示用户希望结果回到飞书。若 Feishu inbound 用户文本已经明确要求创建、撰写、保存、发布、放到云端或覆盖修改，非删除类 `write_private`/`publish_customer_visible` 默认视为已授权；删除、清空、移除、销毁类动作仍 blocked。群消息主动通知、任务/日历变更、外部联网、安装依赖和长期记忆仍按对应 `actionIntent` 判断。

## 4. 推荐运行架构

```text
Feishu
  -> lark-cli event consume
  -> feishu-event-runner
  -> event normalizer
  -> attachment resolver
  -> local artifact store
  -> feishu-agent-task-handler
  -> task_execution_runner (stage execution only, for document_pipeline)
  -> Planner Envelope
  -> Capability Registry
  -> Model Router
  -> Policy Gate (per risky action)
  -> PI runtime tools
       - local ASR
       - context offload
       - document router
       - prompt registry
       - document workers
       - QA gate
       - model routing/provider
  -> Feishu publisher
       - policy_gate_check before publish/notify/delete boundary
       - markdown/doc create
       - drive folder/file upload
       - im reply
  -> runtime metrics / model-route / qa-gate
```

未来 WeChat 入口也应先映射为 `im-event-v1` / `im-attachment-v1` / `office-task-state-v1`，再调用同一个 handler/runner 和 PI runtime tools；不得复制一套 WeChat 专用 Planner/Router/Document Worker 流程。

本轮 WeChat 只做 adapter skeleton：定义事件、附件、回复、发布目标和 capability matrix 的映射边界；不承诺 live 收消息、下载附件、发文件、群内发布或云文档能力。

### 4.1 `feishu-event-runner`

定位：轻量常驻进程，消费飞书事件流。

优先实现方式：

```text
lark-cli event consume <EventKey> --as bot --format json/ndjson
```

职责：

- 启动并监督 `lark-cli event consume`。
- 自动重连和退避。
- 解析 NDJSON。
- 按 `message_id` / `event_id` 去重。
- 将最小事件游标写入 `runtime-runs/feishu-events/{date}/events.ndjson`，只包含脱敏 metadata、hash、chat/message 类型和 bounded preview hash。
- 任务被接受后，将该任务需要的 normalized event 写入 `runtime-runs/{runId}/source-events.ndjson`。
- 将事件投递给本地 handler。

不负责：

- 调模型。
- 生成文档。
- 长期保存 raw message content。
- 执行飞书发布。

### 4.2 `event normalizer`

将不同飞书事件统一为内部 envelope：

```json
{
  "source": "feishu",
  "eventType": "im.message.receive_v1",
  "eventId": "redacted-or-hash",
  "messageId": "om_xxx",
  "chatId": "oc_xxx",
  "chatType": "p2p|group",
  "sender": {
    "type": "user|bot",
    "idHash": "..."
  },
  "message": {
    "type": "text|file|audio|image|post|mixed",
    "textPreview": "...",
    "hasAttachments": true
  },
  "receivedAt": "2026-05-19T00:00:00.000Z"
}
```

规则：

- 原始 sender id、open id、tenant id 默认不进入模型上下文。
- `textPreview` 必须 bounded。
- 原始消息完整内容只允许保存在当前 run 的本地 artifact 中，且要有 hash。
- 全局 `feishu-events` 日志不得保存 raw message content、附件内容、open id、tenant id 或完整飞书文档内容。

### 4.3 `attachment resolver`

负责将飞书消息中的资源变成本地 artifact。

优先 CLI：

```text
lark-cli im +messages-resources-download
lark-cli drive +download
lark-cli docs +fetch
lark-cli markdown +fetch
```

输入类型：

- 消息附件：录音、视频、图片、PDF、docx、xlsx、压缩包。
- 飞书云盘文件 token 或 URL。
- 飞书文档 URL。
- 飞书文件夹 URL。

输出：

```json
{
  "artifactId": "artifact_...",
  "source": "feishu_message_resource|feishu_drive|feishu_doc",
  "localPath": "runtime-runs/{runId}/inputs/...",
  "sha256": "...",
  "mimeType": "...",
  "sizeBytes": 123,
  "privacyLevel": "restricted",
  "externalUploadAllowed": false
}
```

规则：

- 原始录音、视频、base64 media 不发送外部模型。
- 音视频只进入本地 ASR。
- 下载路径必须限制在当前 run artifact 目录，避免路径穿越。
- 超大文件先返回需要确认或分段处理。

### 4.4 `feishu-agent-task-handler`

定位：飞书事件到 PI runtime 的桥接层。

职责：

- 将用户消息和附件解释成 task request。
- 生成 `runId` 和 `planner input`。
- 写入 `request.json`、`inputs.json`、`source-events.ndjson`。
- 调用 PI runtime 或薄执行器。
- 将进度、待确认、完成或失败状态交给 publisher。

内部 task request：

```json
{
  "runId": "feishu-20260519-001",
  "trigger": {
    "source": "feishu",
    "chatId": "oc_xxx",
    "messageId": "om_xxx",
    "replyMode": "thread|chat"
  },
  "userIntent": "生成会议纪要和相关文档",
  "inputs": [
    {
      "artifactId": "audio_001",
      "kind": "audio",
      "localPath": "runtime-runs/..."
    }
  ],
  "constraints": {
    "publishBackToFeishu": true,
    "rawMediaExternalUpload": false,
    "askBeforeCustomerVisiblePublish": true
  }
}
```

规则：

- `publishBackToFeishu=true` 允许 handler 准备飞书回传计划。Feishu inbound 明确要求写入/发布时，非删除类 `write_private` / `publish_customer_visible` 可直接 pass；删除类动作不支持。
- 私有草稿或写入个人/内部受限空间时按 `write_private` 判断，Feishu 明确请求的写入默认可执行。
- 群消息主动通知或把链接发给非当前请求人时，仍按 `notify_people` 判断；没有 `userConfirmed=true` 时，必须回复确认请求并停止通知。
- `confirm` 消息只能确认同一 chat/thread 下的 pending run，且要写入 run state，不能跨用户或跨群复用。

### 4.5 `Feishu publisher`

负责把 Agent 结果发布回飞书。

优先 CLI：

- `lark-cli im +messages-reply`
- `lark-cli im +messages-send`
- `lark-cli drive +create-folder`
- `lark-cli markdown +create`
- `lark-cli docs +create`
- `lark-cli drive +upload`
- `lark-cli drive +move`

发布策略：

- 短结果直接回复消息。
- 长结果创建 Markdown 或 Docs 文档。
- 多文档任务创建一个文件夹，文件夹下包含会议纪要、PRD、技术架构、运营方案、客户需求确认表等。
- 回复消息只包含简短摘要、文档链接、失败/待确认项。
- 执行 CLI 发布前必须满足：QA Gate 通过或明确允许草稿发布；Policy Gate 对当前动作返回 `pass`，或 `needs_confirmation` 已由同一 pending run 的用户确认解除。
- `lark-cli auth status` 只能使用 auth status summary 脱敏输出；其他 CLI 输出必须走 secret scan 后才能进入 artifact 或模型上下文。
- 发布动作写入 `publish-result.json`，包含 doc token/url/folder token，但不包含 secret。

## 5. 用户交互设计

### 5.1 文本指令

示例：

```text
@Office assistant agent_T 根据这段会议录音生成会议纪要、PRD 和技术架构文档，放到飞书文件夹里。
```

预期流程：

1. Bot 收到消息。
2. 回复“已收到，正在解析任务和附件”。
3. 下载附件或读取链接。
4. Planner 判断 taskType：meeting_minutes + doc_writer + feishu_publish。
5. 运行本地 ASR 和文档生成。
6. QA pass 后创建文件夹和文档。
7. 回复文档链接和待确认问题。

### 5.2 录音/文件输入

支持输入：

- 飞书消息附件中的录音；视频素材当前不接入。
- 飞书云盘文件链接。
- 本地已上传到飞书的文件。
- 飞书文档链接作为背景材料。

处理规则：

- 录音下载到本地 artifact。
- 本地 ASR 服务不可用时阻塞，回复 `local_asr_service_unavailable`。
- PDF/docx 可作为文本/背景材料，但必须标记来源。
- 多文件时按 message order 和 file type 建立 input manifest。

### 5.3 进度和长任务

长任务必须有进度消息：

- 已收到。
- 已下载附件。
- 正在转写。
- 正在生成纪要。
- 正在生成相关文档。
- 正在 QA。
- 正在发布飞书文档。
- 已完成 / 需要补充信息 / 失败。

进度消息可以先用普通文本回复，后续再升级为互动卡片。

### 5.4 待确认与取消

支持简单命令：

- `确认`
- `取消`
- `重试`
- `只生成纪要`
- `不要发布，只发 Markdown`
- `补充：...`

第一阶段只需基于 thread/chat + pending run 做简单状态机，不需要复杂长期会话记忆。

## 6. 权限与配置

### 6.1 飞书开放平台

必需：

- 机器人能力。
- 事件订阅：`im.message.receive_v1`。
- 消息发送权限。
- 单聊/群聊消息权限。
- 资源下载权限。
- 云盘文件/文档创建与上传权限。
- 应用版本发布。
- 机器人对目标用户或群可用。

具体权限以 `lark-cli schema` 和飞书开放平台提示为准，配置后必须重新发布应用。

### 6.2 本地配置

`.env.local` 不放飞书 token，但可以放本地运行选择项：

```text
LARK_CLI_PROFILE=default
FEISHU_EVENT_MODE=cli
FEISHU_EVENT_KEY=...
FEISHU_BOT_HANDLER_URL=http://127.0.0.1:8788/feishu/events
FEISHU_BOT_ALLOW_REMOTE_HANDLER=0
FEISHU_AGENT_ASYNC=1
FEISHU_AGENT_PROGRESS_REPLY_MODE=silent
```

App secret 仅用于 SDK 长连接时从 shell 环境注入，不写入仓库：

```text
FEISHU_APP_ID=...
FEISHU_APP_SECRET=...
```

若使用 CLI event consume 且 CLI profile 已授权，第一阶段可不需要 SDK app secret 进入本地运行环境。

`FEISHU_BOT_HANDLER_URL` 与现有 bot gateway runtime 保持一致，默认只允许 loopback 地址；配置 loopback handler 后 SDK gateway 默认进入 HTTP handler 模式，不需要额外设置 `FEISHU_BOT_REPLY_MODE=http`。确需远程 handler 时，必须显式设置 `FEISHU_BOT_ALLOW_REMOTE_HANDLER=1` 并记录安全审查结论。真实 PI runtime path 建议开启 `FEISHU_AGENT_ASYNC=1`，让 gateway 只回复“已接受任务，正在处理。”，后台继续执行并由 runner 通过 `im +messages-reply` 发送最终结果；中间进度默认 `FEISHU_AGENT_PROGRESS_REPLY_MODE=silent`，避免重复回复。

## 7. CLI / SDK / MCP 取舍

### 7.1 第一阶段：CLI event + CLI publish

优点：

- 能力覆盖广。
- 与当前 `feishu_cli` extension 一致。
- 不新增长期 Feishu Adapter。
- 方便通过 `lark-cli api/schema` 补齐边角能力。
- 更容易保持 lazy capability。

风险：

- `event consume` 的长期稳定性、重连和 daemon 状态需要实际压测。
- CLI 输出格式需要严格 schema 化和脱敏。
- 需要修复本地 CLI 登录态。

### 7.2 SDK 长连接：作为稳定化候选

适用场景：

- `lark-cli event consume` 稳定性不足。
- 需要更细的重连、ack、错误处理。
- 需要更复杂的互动卡片或消息事件处理。

使用方式：

- 保留 `feishu_bot_event_gateway.mjs`。
- SDK gateway 仍然只做轻量事件入口。
- 不让 SDK gateway 承担完整 Agent runtime。

### 7.3 MCP：暂不进入主路径

MCP 适用场景：

- 需要把飞书 API 暴露为统一 AI toolset。
- 需要跨客户端复用飞书工具。
- CLI 无法表达某些 API，且 SDK/CLI api 兜底也不合适。

约束：

- `defaultLoad:false`。
- 通过 package audit。
- 经过 Policy Gate 的 `install_dependency`。
- 不能作为机器人收消息的替代方案。
- 不得全局污染 Planner 上下文。

## 8. 实施阶段

### Phase A：连接基线

目标：证明 CLI 可以登录、消费事件、回复消息。

任务：

- 修复 `lark-cli auth status --verify`。
- 运行 `lark-cli doctor`。
- 用 `lark-cli event list` 确认可用 EventKey。
- 用 `lark-cli event schema <EventKey>` 保存事件字段摘要。
- 用 `lark-cli event consume <EventKey> --max-events 1` 接收一条机器人消息。
- 用 `lark-cli im +messages-reply` 回复原消息。

验收：

- 飞书单聊机器人发送“ping”，本地收到事件并回复“pong”。
- 事件日志不包含 token、cookie、session、App Secret。

### Phase B：轻量 event runner

目标：把一次性 CLI 消费变成可运行服务。

新增建议文件：

- `meeting-agent-pi-package/tools/feishu_event_runner.mjs`
- `meeting-agent-pi-package/runtime/feishu-event.schema.json`
- `meeting-agent-pi-package/skills/feishu-agent-bridge/SKILL.md`

能力：

- 启动 `lark-cli event consume`。
- NDJSON parse。
- 去重。
- 写入脱敏事件日志。
- 调用 local handler。
- 基础重连。

验收：

- 连续收 10 条消息不重复触发。
- runner 崩溃后重启不重复处理已完成 message。

### Phase C：Bot task handler

目标：文本指令能触发 Agent 私有草稿任务。

新增建议文件：

- `meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs`
- `meeting-agent-pi-package/runtime/feishu-task.schema.json`
- `meeting-agent-pi-package/runtime/feishu-run-state.schema.json`

能力：

- 接收 normalized event。
- 生成 `runId`。
- 调用 Planner Envelope。
- 选择最小 doc-writer capability。
- 生成 Markdown 草稿。
- 回复飞书消息。

验收：

- 用户发“帮我写一份项目说明”，Agent 回复草稿或创建 Markdown 文档。
- 普通短任务不加载 ASR、Rokid、worker pool、MCP。

### Phase D：附件下载与会议链路

目标：飞书上传录音后能生成会议纪要。

能力：

- 用 `im +messages-resources-download` 下载消息附件。
- 建立 input manifest。
- 调用 `meeting_transcribe_local_asr`。
- 生成 evidence index。
- 生成 meeting minutes。
- 回复纪要文档链接。

验收：

- 录音不上传外部服务。
- 本地 ASR 不可用时，飞书回复明确阻塞原因。
- 会议纪要标题、飞书文件名和 H1 同步。

### Phase E：多文档和文件夹发布

目标：飞书端一句话生成会议纪要和相关文档，并自动归档。

能力：

- Document Router 选择 `prd`、`ops-plan`、`tech-architecture`、`customer-requirement-checklist`。
- `document_prompt_render_batch` 渲染正式 prompt。
- `document_workers_run` 按文档并行、按章节分批。
- QA gate 检查。
- Policy Gate 对文件夹创建、文档发布、覆盖修改、删除边界和消息通知逐项检查；Feishu 明确请求的非删除写入默认放行。
- `drive +create-folder` 创建文件夹。
- `markdown +create` 创建文档；明确目标 file token/link 的修改任务用 `markdown +overwrite`。
- `im +messages-reply` 回复文件夹和文档链接。

验收：

- 四份文档全部包含 required sections。
- `model-route.json` 记录 fallback。
- `qa-gate.json` pass 或明确 needs_fix。
- 客户可见文件夹、群通知或主动发链接前已有同一 pending run 的确认记录。
- 飞书返回链接可打开。

### Phase F：确认、取消、重试和状态查询

目标：让飞书成为可持续任务入口。

能力：

- `status`：查询当前 run。
- `cancel`：取消未完成任务。
- `retry`：重跑失败阶段。
- `confirm`：确认发布或继续。
- `补充：...`：追加上下文。

验收：

- 同一 chat/thread 下能关联 pending run。
- 不同用户/群之间 run state 隔离。
- 取消后不继续发布飞书文档。

### Phase G：SDK 稳定化或 MCP 候选评估

触发条件：

- CLI event consume 不稳定。
- 需要互动卡片。
- 需要更复杂的消息事件 ack/retry。
- CLI 无法覆盖某些 OpenAPI 能力。

处理：

- SDK 作为 `feishu-sdk-gateway` candidate。
- MCP 作为 `feishu-mcp-tools` candidate。
- 两者都必须 `defaultLoad:false`，并走 package audit 和 smoke test。

## 9. 数据与状态目录

建议结构：

```text
runtime-runs/
  feishu-20260519-001/
    request.json
    source-events.ndjson
    inputs/
      manifest.json
      audio-001.wav
    offload/
      transcript.full.json
      evidence-index.json
    planner-envelope.json
    model-route.json
    qa-gate.json
    publish-result.json
    run.metrics.json
    run-manifest.json
    sanitized-trajectory.json
```

禁止：

- 写入 `FEISHU_APP_SECRET`。
- 写入 token、cookie、session。
- 写入未脱敏 `lark-cli auth status`。
- 将 raw media 放入模型上下文。

## 10. Planner 与 Capability 规则

飞书触发不等于自动启用全部能力。

示例映射：

| 用户输入 | 推荐 capability |
| --- | --- |
| “帮我写一段公告” | core + doc-writer |
| “把这个录音整理成纪要” | local-asr + meeting-minutes + qa-gate |
| “生成纪要和 PRD/架构/运营方案” | local-asr + document-router + document-workers + qa-gate |
| “发到飞书文件夹” | feishu-cli + policy-gate |
| “查官方 SDK 文档” | web-access，可要求 sources |
| “机器人不回复” | feishu-event-runner / bot gateway readiness |

Policy Gate 规则：

- 私有草稿：`draft` 或 `write_private`，默认可 `pass`。
- 创建/更新飞书文档：`write_private` 或 `publish_customer_visible`，Feishu inbound 明确请求时默认 `pass`；修改现有文档必须有明确 file token/link 或当前会话内 Agent 已生成文档记录。
- 删除、清空、移除、销毁：始终 blocked，不执行 delete/trash/remove/purge。
- 群消息回复或主动通知：`notify_people`，无同一 pending run 的确认时返回 `needs_confirmation`。
- 下载消息附件：`read`，但必须通过 artifact allowlist、大小和 MIME 检查；raw media external upload 仍 blocked。
- 外部链接或官方文档查询：`external_web`，必须记录 sources；会议事实生成不得用外部 web 补事实。
- 安装 SDK/MCP：`install_dependency`，needs confirmation。

## 11. 测试计划

### 11.1 本地静态

- `python3 src/validate_workspace.py`
- `node --check meeting-agent-pi-package/tools/feishu_event_runner.mjs`
- `node --check meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs`
- runtime schema JSON parse。

### 11.2 飞书连接

- `lark-cli auth status --verify`
- `lark-cli doctor`
- `lark-cli event list`
- `lark-cli event schema <EventKey>`
- `lark-cli event consume <EventKey> --max-events 1`
- `lark-cli im +messages-reply` 回复测试消息。

### 11.3 文本任务

- 私聊机器人：“写一份项目说明”。
- 预期：不启用 ASR、Rokid、MCP、worker pool；返回草稿或文档链接。

### 11.4 录音任务

- 私聊或群聊上传录音：“生成会议纪要和后续文档”。
- 预期：下载附件、本地 ASR、生成纪要、按 router 生成文档、QA gate；需要客户可见发布或群通知时先请求确认，再发布飞书文件夹。

### 11.5 失败路径

- CLI 未登录：回复登录态失败。
- 缺事件权限：回复事件订阅/权限缺失。
- 本地 ASR 未启动：回复 `local_asr_service_unavailable`。
- 文档 QA needs_fix：不发布或只发布草稿，并说明缺失。
- 客户可见发布或群通知未确认：不创建客户可见文档、不发送链接，只回复确认请求。
- 事件日志检查：全局 `feishu-events` 只含脱敏游标；raw/normalized event 只在 `runtime-runs/{runId}/source-events.ndjson`。
- 远程 handler 未设置 `FEISHU_BOT_ALLOW_REMOTE_HANDLER=1`：readiness blocked。
- 飞书发布失败：保留本地 artifact，回复失败原因和重试建议。

## 12. 开发验收标准

MVP 完成标准：

- 飞书机器人收到文本消息，本地 Agent 能执行简单文档任务并回复。
- 飞书机器人收到录音附件，本地 Agent 能生成会议纪要。
- Agent 能在飞书创建文件夹和文档，并回复链接。
- 所有飞书输入、下载 artifact、模型路由、QA、发布结果都有本地 run artifact。
- 默认不加载 MCP。
- 默认不把完整 Agent 上下文常驻在事件监听进程中。

生产化完成标准：

- 支持长任务进度、取消、重试、确认。
- 支持群聊和私聊隔离。
- 支持多文件输入。
- 支持飞书文档链接作为背景材料。
- 支持权限不足时给出明确配置建议。
- 有端到端回归脚本和脱敏日志。

## 13. 主要风险

- `lark-cli auth` profile/keychain 未修复时，live publish smoke 不可用；fixture/mock QA 仍应通过。
- 飞书开放平台权限配置不完整，事件能收到但不能下载附件或回复消息。
- `event consume` 长时间运行稳定性不足，需要切 SDK。
- 如果把 `publishBackToFeishu` 误当成发布确认，可能绕过 Policy Gate；必须通过 pending run confirmation 和 action-level gate 防止误发布。
- 如果全局事件日志保存 raw content，可能造成跨群/跨用户信息泄漏；全局日志只能保存脱敏游标。
- 消息附件格式复杂，下载和 MIME 识别需要逐类适配。
- 长任务可能超过飞书用户等待预期，需要进度消息和状态查询。
- 群聊中多人同时触发任务，需要 run state 隔离和去重。

## 14. 下一步建议

优先顺序：

1. 修复 `lark-cli auth status --verify` 的本机 keychain/profile。
2. 用 `lark-cli event list/schema/consume` 做 live 单条文本消息接收。
3. 用 live 文本消息验证 runner -> handler -> PI runtime execution -> QA/Policy -> Markdown 文档 -> 飞书回复。
4. 用 live 文件/录音消息验证 resource download -> local ASR -> 会议纪要 -> 飞书文档。
5. 扩展 confirm/cancel/retry/status 的多轮状态交互。
6. 再评估是否需要 SDK 稳定化；MCP 暂不进入主路径。
